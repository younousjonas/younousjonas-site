// Gestionnaires des fonctions bd-*. Chaque fabrique reçoit ses dépendances
// (magasin, configuration, horloge, fetch, envoyeur) : les tests les remplacent.
//
// Écritures : toute modification d'un objet existant passe par maj() (lecture, modification,
// écriture conditionnelle sur l'ETag, rejouée en cas de conflit) ; toute création par
// creerSiNouveau(). Les index secondaires (jp/, ja/, cs/) sont écrits avant l'objet qui les
// valide : un index orphelin, laissé par une panne, ne donne aucun droit (l'empreinte est
// toujours revérifiée sur la commande).
import { OFFRES, offre as offreDe, montantTexte, DUREES, UTILISATIONS_MAX_LIEN } from './config.mjs';
import {
  json, nouveauJeton, jetonDerive, hacher, egalConstant, jetonValideFormat, reference, cookieSession, cookieEfface,
  lireCookie, origineAutorisee, lireJSON, ipClient, limiter, nettoyer, emailValide, normaliserWhatsapp,
} from './util.mjs';
import { maj, creerSiNouveau } from './store.mjs';
import { verifierSignature, creerSessionCheckout } from './stripe.mjs';
import { mettreEnFile, traiterFile, ErreurDefinitive } from './outbox.mjs';
import { QUESTIONNAIRES } from './questionnaires.mjs';
import { filtrerValeurs, verifier, mettreEnTexte } from './rendu.mjs';

const ISO = (ms) => new Date(ms).toISOString();
const GENERIQUE_LIEN = { erreur: 'lien_invalide', message: 'Ce lien n’est pas valable ou a expiré. Vous pouvez demander un nouveau lien.' };
const INDISPONIBLE = { erreur: 'indisponible', message: 'Le service est momentanément indisponible. Réessayez dans un moment.' };

// Toute erreur imprévue (panne du magasin, conflits persistants) → 500 générique, journal court.
function protege(d, nom, fn){
  return async (req, context) => {
    try{ return await fn(req, context); }
    catch(e){ d.journal(nom + '_erreur', String(e && e.message || e).slice(0, 80)); return json(500, INDISPONIBLE); }
  };
}

// ---------- commandes et jetons ----------
const CLE = (id) => 'commandes/' + id;
async function lireCommande(store, id){ return id ? store.getJSON(CLE(id)) : null; }
// fn(c) modifie et renvoie la commande, ou undefined pour ne rien écrire. Jamais de création ici.
async function majCommande(store, id, fn){ return maj(store, CLE(id), (c) => (c ? fn(c) : undefined)); }
function trace(c, maintenant, evenement, extra = {}){ (c.historique ||= []).push({ le: ISO(maintenant), evenement, ...extra }); }
const payee = (c) => !!c && (c.statut === 'payee' || c.statut === 'questionnaire_recu');
const supprimer = async (store, k) => { try{ await store.delete(k); }catch{ /* index orphelin sans effet */ } };

// Lien personnel de paiement : l'index jp/ est écrit d'abord, puis l'empreinte sur la commande.
async function emettreJetonPaiement(store, id, maintenant, etatsPermis){
  const jeton = nouveauJeton(); const h = hacher(jeton);
  await creerSiNouveau(store, 'jp/' + h, { commande: id });
  let ancien = null;
  const r = await majCommande(store, id, (c) => {
    if(!etatsPermis.includes(c.statut)) return undefined;
    ancien = c.paiementJeton && c.paiementJeton.hash;
    c.paiementJeton = { hash: h, expire: maintenant + DUREES.lienPaiement };
    trace(c, maintenant, 'lien_paiement_emis');
    return c;
  });
  if(!r.ecrit){ await supprimer(store, 'jp/' + h); return null; }
  if(ancien) await supprimer(store, 'jp/' + ancien);
  return jeton;
}
async function commandeParJetonPaiement(store, jeton, maintenant){
  if(!jetonValideFormat(jeton)) return null;
  const h = hacher(jeton);
  const ref = await store.getJSON('jp/' + h);
  const c = ref && await lireCommande(store, ref.commande);
  if(!c || !c.paiementJeton || !egalConstant(c.paiementJeton.hash, h) || c.paiementJeton.expire < maintenant) return null;
  return c;
}

// Lien personnel d'accès au questionnaire : un seul lien valable à la fois (le précédent est révoqué).
//
// Génération : chaque nouvelle émission voulue (confirmation = 1, puis chaque récupération et
// chaque lien de l'administration) prend le rang suivant, c.generationLien. Un message porte
// le rang de son lien. Un message dont le rang est dépassé est obsolète : envoyé ou repris
// plus tard, il ne réactive jamais son ancien lien et il est annulé.
//
// source : { admin: true } (lien affiché une fois, rang suivant pris ici) ou { message, generation }.
// Un même jeton déjà actif n'est pas réémis : ses utilisations ne repartent pas de zéro.
// Renvoie true si le lien est actif à l'issue de l'appel, sinon le motif du refus.
async function activerJetonAcces(store, id, jeton, maintenant, source){
  const h = hacher(jeton);
  await creerSiNouveau(store, 'ja/' + h, { commande: id });
  let ancien = null; let refus = null;
  const r = await majCommande(store, id, (c) => {
    ancien = null; refus = null;
    if(!payee(c)){ refus = 'commande_non_payee'; return undefined; }
    const courante = c.generationLien || 0;
    if(!source.admin){
      if(c.acces && c.acces.revoque){ refus = 'acces_revoque'; return undefined; }
      if((source.generation || 0) < courante){ refus = 'message_obsolete'; return undefined; }
      if(c.acces && c.acces.hash === h) return undefined;     // déjà actif
    }
    const generation = source.admin ? courante + 1 : Math.max(courante, source.generation);
    ancien = c.acces && c.acces.hash;
    c.generationLien = generation;
    c.acces = { hash: h, expire: maintenant + DUREES.lienAcces, utilisations: 0, max: UTILISATIONS_MAX_LIEN, revoque: false, emisLe: ISO(maintenant), source: source.admin ? 'admin' : source.message, generation };
    trace(c, maintenant, 'lien_acces_emis', { source: c.acces.source, generation });
    return c;
  });
  if(refus) return refus;
  if(r.ecrit && ancien && ancien !== h) await supprimer(store, 'ja/' + ancien);
  return true;
}

async function ouvrirSession(store, c, maintenant){
  const sid = nouveauJeton();
  if(!(await creerSiNouveau(store, 'sess/' + hacher(sid), { commande: c.id, expire: maintenant + DUREES.session }))) throw new Error('session_collision');
  return cookieSession(sid, DUREES.session / 1000);
}
async function sessionCommande(store, req, maintenant){
  const sid = lireCookie(req);
  if(!jetonValideFormat(sid)) return null;
  const s = await store.getJSON('sess/' + hacher(sid));
  if(!s || s.expire < maintenant) return null;
  const c = await lireCommande(store, s.commande);
  if(!payee(c) || (c.acces && c.acces.revoque)) return null;
  return c;
}

function resumeCommande(c){
  const o = offreDe(c.offre);
  return { reference: c.id, prenom: c.prenoms, offre: o.nom, libelle: o.libelle, montant: montantTexte(o.montant, o.devise), etape: o.etape };
}

// ---------- messages ----------
export function composerMessage(item, c, lien, cfg){
  const o = offreDe(c && c.offre);
  if(item.type === 'confirmation' || item.type === 'nouveau-lien'){
    const lignes = [
      `Bonjour ${c.prenoms},`, '',
      item.type === 'confirmation' ? 'Votre paiement est confirmé. Merci.' : 'Voici un nouveau lien personnel vers votre album. Le lien précédent ne fonctionne plus.', '',
      `Album : ${o.libelle}`,
      `Montant réglé : ${montantTexte(o.montant, o.devise)}`,
      `Référence : ${c.id}`, '',
      `Prochaine étape : ${o.etape}`, '',
      'Votre lien personnel (valable 30 jours ; il ouvre votre questionnaire et ne doit pas être transféré) :',
      lien, '',
      ...(cfg.recuStripe ? ['Votre reçu de paiement vous est adressé séparément par Stripe.'] : []),
      `Une question : ${cfg.adminEmail || 'hello@younousjonas.com'}`, '',
      'Younous Jonas',
    ];
    const sujet = item.type === 'confirmation'
      ? `Votre album « ${o.nom} » : paiement confirmé (réf. ${c.id})`
      : `Votre album « ${o.nom} » : nouveau lien personnel (réf. ${c.id})`;
    return { to: c.email, sujet, texte: lignes.join('\n') };
  }
  return { to: cfg.adminEmail, sujet: `[BD personnelle] ${item.donnees.sujet || item.type}`, texte: item.donnees.texte || '' };
}

// Le lien du message est dérivé de son identifiant (HMAC, BD_LINK_SECRET) : une reprise après
// un envoi ambigu reproduit exactement le même lien, déjà actif, au lieu d'en émettre un autre.
export function fabriqueComposer(store, cfg, maintenant){
  return async (item) => {
    if(item.type === 'alerte') return composerMessage(item, null, null, cfg);
    const jeton = jetonDerive(cfg.secretLien, 'acces:' + item.id);
    const etat = await activerJetonAcces(store, item.commandeId, jeton, maintenant, { message: item.id, generation: item.generation || 0 });
    if(etat === 'acces_revoque' || etat === 'message_obsolete') throw new ErreurDefinitive(etat);
    if(etat !== true) throw new Error(etat);
    const c = await lireCommande(store, item.commandeId);
    return composerMessage(item, c, `${cfg.site}/mon-album#cle=${jeton}`, cfg);
  };
}

async function alerter(store, maintenant, sujet, texte, cle){
  await mettreEnFile(store, { type: 'alerte', dedup: 'alerte:' + cle, destinataire: 'admin', donnees: { sujet, texte } }, maintenant);
}

// ---------- 1. Demande d'intérêt (publique) ----------
export function handlerInteret(d){
  return protege(d, 'interet', async (req, context) => {
    if(req.method !== 'POST') return json(405, { erreur: 'methode' });
    if(!origineAutorisee(req, d.cfg)) return json(403, { erreur: 'origine' });
    const { corps, erreur } = await lireJSON(req, 20_000);
    if(erreur) return json(400, { erreur: 'requete' });
    const maintenant = d.now();
    if(!(await limiter(d.store, 'interet-ip', ipClient(req, context), 10, 3600e3, maintenant))) return json(429, { erreur: 'trop_de_demandes' });
    if(corps.siteweb) return json(201, { reference: 'INT-OK' });      // pot de miel : réponse neutre, rien n'est stocké
    const erreurs = [];
    const prenoms = nettoyer(corps.prenoms, 120); if(!prenoms) erreurs.push('prenoms');
    const nom = nettoyer(corps.nom, 120); if(!nom) erreurs.push('nom');
    const email = nettoyer(corps.email, 254).toLowerCase(); if(!emailValide(email)) erreurs.push('email');
    const whatsapp = normaliserWhatsapp(corps.whatsapp); if(!whatsapp) erreurs.push('whatsapp');
    if(corps.declarationWhatsapp !== true) erreurs.push('declarationWhatsapp');
    const code = String(corps.offre || ''); if(!offreDe(code)) erreurs.push('offre');
    if(corps.consentement !== true) erreurs.push('consentement');
    const projet = nettoyer(corps.projet, 600);
    if(erreurs.length) return json(422, { erreur: 'champs', champs: erreurs });
    const ref = reference('INT', code, maintenant);
    if(!(await creerSiNouveau(d.store, 'interets/' + ref, { reference: ref, offre: code, prenoms, nom, email, whatsapp, declarationWhatsapp: true, projet, consentement: true, statut: 'nouvelle', creeLe: ISO(maintenant) }))) throw new Error('reference_collision');
    return json(201, { reference: ref });
  });
}

// ---------- 2. Administration (jeton porteur, comparé à son empreinte) ----------
// Identifiant de commande tiré de la demande d'intérêt : INT-297-20261023-ABCDEF → CMD-297-20261023-ABCDEF.
// Deux confirmations concurrentes visent donc la même clé ; une seule crée la commande.
export const idCommandeDeInteret = (ref) => 'CMD' + ref.slice(3);

export function handlerAdmin(d){
  return protege(d, 'admin', async (req) => {
    if(!d.cfg.adminTokenHash) return json(503, { erreur: 'admin_non_configure' });
    const auth = req.headers.get('authorization') || '';
    const jeton = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if(!jeton || !egalConstant(hacher(jeton), d.cfg.adminTokenHash)) return json(401, { erreur: 'non_autorise' });
    if(req.method !== 'POST') return json(405, { erreur: 'methode' });
    const { corps, erreur } = await lireJSON(req, 20_000);
    if(erreur) return json(400, { erreur: 'requete' });
    const maintenant = d.now(); const s = d.store;
    switch(corps.action){
      case 'lister': {
        const lire = async (p) => (await Promise.all((await s.list(p)).map((k) => s.getJSON(k)))).filter(Boolean);
        const commandes = (await lire('commandes/')).map((c) => ({ reference: c.id, offre: c.offre, statut: c.statut, prenoms: c.prenoms, nom: c.nom, email: c.email, creeLe: c.creeLe, payeLe: c.paiement && c.paiement.payeLe, anomalies: c.anomalies || [] }));
        const file = (await lire('ob/')).map((m) => ({ id: m.id, type: m.type, commande: m.commandeId, statut: m.statut, tentatives: m.tentatives, derniereErreur: m.derniereErreur }));
        return json(200, { interets: await lire('interets/'), commandes, file, paiements: { actifs: d.cfg.paiementsActifs, mode: d.cfg.mode, raisons: d.cfg.raisonsInactif } });
      }
      case 'confirmer': {
        const refInteret = nettoyer(corps.interet, 80);
        const i = /^INT-/.test(refInteret) ? await s.getJSON('interets/' + refInteret) : null;
        if(!i) return json(404, { erreur: 'interet_inconnu' });
        const id = idCommandeDeInteret(i.reference);
        if(i.commande) return json(409, { erreur: 'deja_confirmee', commande: i.commande });
        const o = offreDe(i.offre);
        const jetonPaiement = nouveauJeton(); const h = hacher(jetonPaiement);
        await creerSiNouveau(s, 'jp/' + h, { commande: id });
        const c = { id, offre: o.code, montant: o.montant, devise: o.devise, prenoms: i.prenoms, nom: i.nom, email: i.email, whatsapp: i.whatsapp, interet: i.reference, statut: 'confirmee', creeLe: ISO(maintenant), sessionsCheckout: [], historique: [], paiementJeton: { hash: h, expire: maintenant + DUREES.lienPaiement } };
        trace(c, maintenant, 'projet_confirme');
        const cree = await creerSiNouveau(s, CLE(id), c);
        if(!cree) await supprimer(s, 'jp/' + h);
        // Suite idempotente, rejouée par une confirmation répétée après une panne.
        await maj(s, 'idx/email/' + hacher(i.email), (idx) => {
          const v = idx || { commandes: [] };
          if(v.commandes.includes(id)) return undefined;
          v.commandes.push(id); return v;
        });
        await maj(s, 'interets/' + i.reference, (x) => (x && x.commande !== id ? { ...x, statut: 'confirmee', commande: id } : undefined));
        if(!cree) return json(409, { erreur: 'deja_confirmee', commande: id, conseil: 'Demander un lien avec l’action nouveau-lien-paiement.' });
        return json(201, { commande: id, lienPaiement: `${d.cfg.site}/paiement-bd#t=${jetonPaiement}`, avertissement: 'Lien affiché une seule fois. À transmettre par Younous à la personne.' });
      }
      case 'nouveau-lien-paiement': {
        const c = await lireCommande(s, nettoyer(corps.commande, 80));
        if(!c) return json(409, { erreur: 'etat' });
        const jetonP = await emettreJetonPaiement(s, c.id, maintenant, ['confirmee', 'checkout_ouvert']);
        if(!jetonP) return json(409, { erreur: 'etat' });
        return json(200, { lienPaiement: `${d.cfg.site}/paiement-bd#t=${jetonP}` });
      }
      case 'lien-acces': {
        const c = await lireCommande(s, nettoyer(corps.commande, 80));
        if(!payee(c)) return json(409, { erreur: 'commande_non_payee' });
        const jetonA = nouveauJeton();
        const etat = await activerJetonAcces(s, c.id, jetonA, maintenant, { admin: true });
        if(etat !== true) return json(409, { erreur: etat });
        return json(200, { lienAcces: `${d.cfg.site}/mon-album#cle=${jetonA}` });
      }
      case 'revoquer-acces': {
        const id = nettoyer(corps.commande, 80);
        const r = await majCommande(s, id, (c) => {
          if(!c.acces || c.acces.revoque) return undefined;
          c.acces.revoque = true; trace(c, maintenant, 'acces_revoque'); return c;
        });
        if(!r.valeur || !r.valeur.acces) return json(404, { erreur: 'commande_inconnue' });
        return json(200, { ok: true });
      }
      case 'reponses': {
        const r = await s.getJSON('reponses/' + nettoyer(corps.commande, 80));
        return r ? json(200, r) : json(404, { erreur: 'aucune_reponse' });
      }
      case 'relancer-envoi': {
        const id = nettoyer(corps.id, 80);
        const r = await maj(s, 'ob/' + id, (it) => (it && it.statut !== 'en_cours' ? { ...it, statut: 'a_envoyer', tentatives: 0, prochainEssai: maintenant, verrou: null } : undefined));
        if(!r.valeur) return json(404, { erreur: 'message_inconnu' });
        if(!r.ecrit) return json(409, { erreur: 'envoi_en_cours' });
        return json(200, { ok: true });
      }
      default: return json(400, { erreur: 'action_inconnue' });
    }
  });
}

// ---------- 3. Paiement intégré (page /paiement-bd, jeton dans le fragment d'URL) ----------
export function handlerPaiement(d){
  return protege(d, 'paiement', async (req, context) => {
    if(req.method !== 'POST') return json(405, { erreur: 'methode' });
    if(!origineAutorisee(req, d.cfg)) return json(403, { erreur: 'origine' });
    const { corps, erreur } = await lireJSON(req, 5_000);
    if(erreur) return json(400, { erreur: 'requete' });
    const maintenant = d.now(); const s = d.store;
    if(!(await limiter(s, 'paiement-ip', ipClient(req, context), 60, 3600e3, maintenant))) return json(429, { erreur: 'trop_de_demandes' });

    if(corps.action === 'statut'){
      const sid = String(corps.sessionId || '');
      if(!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sid)) return json(200, { statut: 'inconnu' });
      const ref = await s.getJSON('cs/' + sid);
      const c0 = ref && await lireCommande(s, ref.commande);
      if(!c0) return json(200, { statut: 'inconnu' });
      if(!payee(c0) || !c0.paiement || c0.paiement.session !== sid) return json(200, { statut: 'en_attente' });
      // Accès direct une seule fois, depuis la page de retour, peu après le paiement constaté par le webhook.
      // La réclamation est une écriture conditionnelle : de deux retours simultanés, un seul l'obtient.
      let reclame = false;
      const r = await majCommande(s, c0.id, (c) => {
        reclame = false;
        if(c.retourUtilise || !c.paiement || c.paiement.session !== sid || maintenant - Date.parse(c.paiement.payeLe) >= DUREES.retourPaiement) return undefined;
        c.retourUtilise = true; trace(c, maintenant, 'acces_retour_paiement'); reclame = true; return c;
      });
      if(reclame && r.ecrit){
        const cookie = await ouvrirSession(s, r.valeur, maintenant);
        return json(200, { statut: 'paye', acces: true, ...resumeCommande(r.valeur) }, { 'set-cookie': cookie });
      }
      return json(200, { statut: 'paye', acces: false, ...resumeCommande(c0) });
    }

    const c = await commandeParJetonPaiement(s, corps.jeton, maintenant);
    if(!c) return json(404, GENERIQUE_LIEN);
    if(corps.action === 'resume'){
      return json(200, { ...resumeCommande(c), statut: c.statut, dejaPaye: payee(c), paiementDisponible: d.cfg.paiementsActifs });
    }
    if(corps.action === 'session'){
      if(payee(c)) return json(409, { erreur: 'deja_paye' });
      if(!['confirmee', 'checkout_ouvert'].includes(c.statut)) return json(409, { erreur: 'etat' });
      if(!d.cfg.paiementsActifs){
        d.journal('paiement_inactif', d.cfg.raisonsInactif.length + ' condition(s) manquante(s)');
        return json(503, { erreur: 'paiement_indisponible', message: 'Le paiement en ligne n’est pas encore ouvert. Younous vous recontacte.' });
      }
      if(!(await limiter(s, 'paiement-cmd', c.id, 20, 3600e3, maintenant))) return json(429, { erreur: 'trop_de_demandes' });
      const o = offreDe(c.offre);
      let sess;
      try{
        sess = await creerSessionCheckout({ cfg: d.cfg, commande: c, offre: o, fetchFn: d.fetchFn, tentative: c.sessionsCheckout.length + 1 });
      }catch(e){
        d.journal('checkout_erreur', String(e.message).slice(0, 80));
        return json(502, { erreur: 'stripe_indisponible', message: 'Le paiement n’a pas pu s’ouvrir. Réessayez dans un moment.' });
      }
      // La session est enregistrée sur la commande AVANT que le client reçoive de quoi payer :
      // le webhook n'accepte que les sessions ainsi enregistrées.
      await creerSiNouveau(s, 'cs/' + sess.id, { commande: c.id });
      let refus = null;
      await majCommande(s, c.id, (x) => {
        refus = null;
        if(payee(x) || !['confirmee', 'checkout_ouvert'].includes(x.statut)){ refus = payee(x) ? 'deja_paye' : 'etat'; return undefined; }
        if(x.sessionsCheckout.some((y) => y.id === sess.id)) return undefined;
        x.sessionsCheckout.push({ id: sess.id, creeLe: ISO(maintenant) }); x.statut = 'checkout_ouvert'; trace(x, maintenant, 'checkout_ouvert');
        return x;
      });
      if(refus) return json(409, { erreur: refus });
      return json(200, { clientSecret: sess.clientSecret, publishableKey: d.cfg.stripePublishable, mode: d.cfg.mode });
    }
    return json(400, { erreur: 'action_inconnue' });
  });
}

// ---------- 4. Webhook Stripe (signature, idempotence, contrôle serveur du montant) ----------
// Chaque étape est idempotente : un événement rejoué (par Stripe, ou après une panne en cours
// de traitement) aboutit au même état, sans seconde confirmation. Le marqueur evt/ n'est posé
// qu'à la fin ; toute erreur renvoie 500 pour que Stripe réessaie.
export function handlerWebhook(d){
  const TYPES = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired']);
  return protege(d, 'webhook', async (req) => {
    if(req.method !== 'POST') return json(405, { erreur: 'methode' });
    if(!d.cfg.webhookSecret.startsWith('whsec_')) return json(503, { erreur: 'webhook_non_configure' });
    const brut = await req.text();
    const maintenant = d.now(); const s = d.store;
    if(!verifierSignature(brut, req.headers.get('stripe-signature'), d.cfg.webhookSecret, maintenant)) return json(400, { erreur: 'signature' });
    let ev; try{ ev = JSON.parse(brut); }catch{ return json(400, { erreur: 'json' }); }
    if(!ev || typeof ev.id !== 'string') return json(400, { erreur: 'evenement' });
    if(await s.getJSON('evt/' + ev.id)) return json(200, { recu: true, doublon: true });
    const marquer = async (resultat) => { await creerSiNouveau(s, 'evt/' + ev.id, { type: ev.type, traiteLe: ISO(maintenant), resultat }); return json(200, { recu: true, resultat }); };
    // Modification de commande appliquée une seule fois par événement.
    const unefois = (fn) => (c) => (c.historique || []).some((h) => h.evt === ev.id) ? undefined : fn(c);

    if(!TYPES.has(ev.type)) return marquer('ignore_type');
    const cs = ev.data && ev.data.object || {};
    const md = cs.metadata || {};
    if(!md.bd_commande) return marquer('ignore_hors_bd');           // autres produits du même compte
    if(!!ev.livemode !== (d.cfg.mode === 'live')){ await alerter(s, maintenant, 'Mode Stripe inattendu', `Événement ${ev.id} en mode ${ev.livemode ? 'live' : 'test'} alors que la configuration est en ${d.cfg.mode}.`, 'mode:' + ev.id); return marquer('ignore_mode'); }
    const c = await lireCommande(s, cs.client_reference_id);
    if(!c || md.bd_commande !== c.id){ await alerter(s, maintenant, 'Paiement sans commande', `Session ${cs.id} : référence inconnue.`, 'orphelin:' + cs.id); return marquer('commande_inconnue'); }
    const o = offreDe(c.offre);
    const anomalie = async (ecarts, sujet, texte, cle, resultat) => {
      await majCommande(s, c.id, (x) => {
        if((x.anomalies || []).some((a) => a.session === cs.id && a.evenement === ev.id)) return undefined;
        (x.anomalies ||= []).push({ le: ISO(maintenant), session: cs.id, evenement: ev.id, ecarts }); return x;
      });
      await alerter(s, maintenant, sujet, texte, cle);
      return marquer(resultat);
    };

    if(ev.type === 'checkout.session.expired'){
      await majCommande(s, c.id, unefois((x) => { trace(x, maintenant, 'checkout_expire', { evt: ev.id, session: cs.id }); return x; }));
      return marquer('expire');
    }
    if(ev.type === 'checkout.session.async_payment_failed'){
      await majCommande(s, c.id, unefois((x) => { if(payee(x)) return undefined; x.statut = 'confirmee'; trace(x, maintenant, 'paiement_differe_echoue', { evt: ev.id }); return x; }));
      return marquer('paiement_echoue');
    }
    if(cs.payment_status !== 'paid'){
      if(ev.type === 'checkout.session.async_payment_succeeded') return anomalie(['async_payment_succeeded sans payment_status=paid'], 'Paiement incohérent', `Commande ${c.id}, session ${cs.id} : succès annoncé sans statut payé. Aucun accès ouvert.`, 'incoherent:' + ev.id, 'anomalie');
      await majCommande(s, c.id, unefois((x) => { if(payee(x)) return undefined; x.statut = 'paiement_en_cours'; trace(x, maintenant, 'paiement_en_cours', { evt: ev.id }); return x; }));
      return marquer('en_cours');
    }
    const ecarts = [];
    if(!(c.sessionsCheckout || []).some((x) => x.id === cs.id)) ecarts.push(`session ${cs.id} non enregistrée pour cette commande`);
    if(cs.mode !== 'payment') ecarts.push(`mode ${cs.mode} au lieu de payment`);
    if(cs.amount_total !== o.montant) ecarts.push(`montant ${cs.amount_total} au lieu de ${o.montant}`);
    if(String(cs.currency) !== o.devise) ecarts.push(`devise ${cs.currency} au lieu de ${o.devise}`);
    if(md.bd_offre !== c.offre) ecarts.push(`offre ${md.bd_offre} au lieu de ${c.offre}`);
    if(ecarts.length) return anomalie(ecarts, 'Paiement non conforme', `Commande ${c.id}, session ${cs.id} : ${ecarts.join(' ; ')}. Aucun accès ouvert.`, 'ecart:' + cs.id, 'anomalie');

    // Passage à « payée » par écriture conditionnelle.
    let issue = null;
    const r = await majCommande(s, c.id, (x) => {
      if(payee(x)){ issue = x.paiement && x.paiement.session === cs.id ? 'deja_paye' : 'double_paiement'; return undefined; }
      issue = 'paye';
      x.statut = 'payee';
      x.paiement = { session: cs.id, paymentIntent: cs.payment_intent || null, montant: cs.amount_total, devise: cs.currency, payeLe: ISO(maintenant), evenement: ev.id };
      x.generationLien = Math.max(x.generationLien || 0, 1);    // le lien de la confirmation est le rang 1
      trace(x, maintenant, 'paiement_constate', { evt: ev.id });
      return x;
    });
    if(issue === 'double_paiement') return anomalie(['double paiement'], 'Double paiement', `Commande ${c.id} déjà réglée ; nouvelle session ${cs.id}. Remboursement à examiner.`, 'double:' + cs.id, 'double_paiement');
    // Payée (maintenant ou lors d'un passage interrompu) : la confirmation est (re)mise en file ;
    // le dédoublonnage garantit un seul message.
    await mettreEnFile(s, { type: 'confirmation', dedup: 'confirmation:' + c.id, commandeId: c.id, destinataire: 'acheteur', generation: 1 }, maintenant);
    const pj = r.valeur && r.valeur.paiementJeton;
    if(pj && pj.hash){
      await majCommande(s, c.id, (x) => (x.paiementJeton ? { ...x, paiementJeton: null } : undefined));
      await supprimer(s, 'jp/' + pj.hash);
    }
    return marquer(issue);
  });
}

// ---------- 5. Accès personnel (ouverture, récupération, fermeture) ----------
export function handlerAcces(d){
  return protege(d, 'acces', async (req, context) => {
    if(req.method !== 'POST') return json(405, { erreur: 'methode' });
    if(!origineAutorisee(req, d.cfg)) return json(403, { erreur: 'origine' });
    const { corps, erreur } = await lireJSON(req, 5_000);
    if(erreur) return json(400, { erreur: 'requete' });
    const maintenant = d.now(); const s = d.store;
    const ip = ipClient(req, context);

    if(corps.action === 'ouvrir'){
      if(!(await limiter(s, 'acces-ip', ip, 30, 3600e3, maintenant))) return json(429, { erreur: 'trop_de_demandes' });
      const jeton = String(corps.jeton || '');
      if(!jetonValideFormat(jeton)) return json(404, GENERIQUE_LIEN);
      const h = hacher(jeton);
      const ref = await s.getJSON('ja/' + h);
      if(!ref || !ref.commande) return json(404, GENERIQUE_LIEN);
      // Utilisation comptée par écriture conditionnelle : jamais plus de `max` ouvertures.
      let accepte = false;
      const r = await majCommande(s, ref.commande, (c) => {
        accepte = false;
        const a = c.acces;
        if(!payee(c) || !a || !egalConstant(a.hash, h) || a.revoque || a.expire < maintenant || a.utilisations >= a.max) return undefined;
        a.utilisations += 1; trace(c, maintenant, 'lien_utilise'); accepte = true; return c;
      });
      if(!accepte || !r.ecrit) return json(404, GENERIQUE_LIEN);
      const cookie = await ouvrirSession(s, r.valeur, maintenant);
      return json(200, { ok: true, prenom: r.valeur.prenoms, offre: offreDe(r.valeur.offre).nom }, { 'set-cookie': cookie });
    }
    if(corps.action === 'recuperer'){
      const reponse = json(202, { message: 'Si une commande réglée correspond à cette adresse, un nouveau lien y est envoyé.' });
      const email = nettoyer(corps.email, 254).toLowerCase();
      if(!(await limiter(s, 'recup-ip', ip, 10, 3600e3, maintenant))) return reponse;
      if(!emailValide(email) || !(await limiter(s, 'recup-email', email, 3, 3600e3, maintenant))) return reponse;
      const idx = await s.getJSON('idx/email/' + hacher(email));
      for(const id of (idx && idx.commandes) || []){
        // Rang suivant réservé d'abord ; le message de ce rang rend obsolètes tous les précédents.
        // Une panne entre les deux laisse seulement un rang sans message : une nouvelle demande le corrige.
        const r = await majCommande(s, id, (c) => {
          if(!payee(c) || (c.acces && c.acces.revoque)) return undefined;
          c.generationLien = (c.generationLien || 0) + 1; trace(c, maintenant, 'lien_demande', { generation: c.generationLien }); return c;
        });
        if(!r.ecrit) continue;
        const g = r.valeur.generationLien;
        await mettreEnFile(s, { type: 'nouveau-lien', dedup: `lien:${id}:${g}`, commandeId: id, destinataire: 'acheteur', generation: g }, maintenant);
      }
      return reponse;
    }
    if(corps.action === 'fermer'){
      const sid = lireCookie(req);
      if(jetonValideFormat(sid)) await supprimer(s, 'sess/' + hacher(sid));
      return json(200, { ok: true }, { 'set-cookie': cookieEfface() });
    }
    return json(400, { erreur: 'action_inconnue' });
  });
}

// ---------- 6. Questionnaire privé (session obligatoire) ----------
// L'envoi est réservé par la création « si nouveau » de reponses/<commande> : un seul envoi
// aboutit. Les suites (brouillon effacé, statut, alerte) sont idempotentes et rejouées si
// une panne les a interrompues.
async function suitesEnvoi(s, c, maintenant){
  await supprimer(s, 'brouillons/' + c.id);
  await majCommande(s, c.id, (x) => { if(x.statut === 'questionnaire_recu') return undefined; x.statut = 'questionnaire_recu'; trace(x, maintenant, 'questionnaire_recu'); return x; });
  await alerter(s, maintenant, 'Questionnaire reçu', `Commande ${c.id} (${offreDe(c.offre).nom}) : questionnaire reçu.`, 'questionnaire:' + c.id);
}

export function handlerQuestionnaire(d){
  return protege(d, 'questionnaire', async (req) => {
    const maintenant = d.now(); const s = d.store;
    const c = await sessionCommande(s, req, maintenant);
    if(!c) return json(401, { erreur: 'session', message: 'Votre session a expiré ou ce lien n’est plus valable. Ouvrez de nouveau votre lien personnel.' });
    const schema = QUESTIONNAIRES[c.offre];
    if(req.method === 'GET'){
      const rep = await s.getJSON('reponses/' + c.id);
      if(rep && c.statut !== 'questionnaire_recu') await suitesEnvoi(s, c, maintenant);
      const brouillon = rep ? null : await s.getJSON('brouillons/' + c.id);
      return json(200, { reference: c.id, prenom: c.prenoms, offre: offreDe(c.offre).nom, code: c.offre, schema, brouillon, envoye: !!rep, envoyeLe: rep && rep.envoyeLe });
    }
    if(!origineAutorisee(req, d.cfg)) return json(403, { erreur: 'origine' });
    if(await s.getJSON('reponses/' + c.id)){ await suitesEnvoi(s, c, maintenant); return json(409, { erreur: 'deja_envoye' }); }
    if(req.method === 'DELETE'){ await supprimer(s, 'brouillons/' + c.id); return json(200, { ok: true }); }
    const { corps, erreur } = await lireJSON(req, 1_000_000);
    if(erreur) return json(erreur === 'taille' ? 413 : 400, { erreur: 'requete' });
    const { valeurs, comptes } = filtrerValeurs(schema, corps.valeurs, corps.comptes);
    if(req.method === 'PUT'){
      await s.setJSON('brouillons/' + c.id, { valeurs, comptes, majLe: ISO(maintenant) });   // dernier brouillon gagnant, par commande
      return json(200, { ok: true, majLe: ISO(maintenant) });
    }
    if(req.method === 'POST' && corps.action === 'envoyer'){
      const manques = verifier(schema, valeurs);
      if(manques.length) return json(422, { erreur: 'manques', manques });
      const texte = mettreEnTexte(schema, valeurs, comptes);
      const cree = await creerSiNouveau(s, 'reponses/' + c.id, { commande: c.id, offre: c.offre, version: schema.version, envoyeLe: ISO(maintenant), texte, valeurs, comptes });
      if(!cree) return json(409, { erreur: 'deja_envoye' });
      await suitesEnvoi(s, c, maintenant);
      return json(200, { ok: true, reference: c.id, texte });
    }
    return json(405, { erreur: 'methode' });
  });
}

// ---------- 7. File d'envoi (fonction planifiée) ----------
export async function executerFile(d){
  const maintenant = d.now();
  return traiterFile(d.store, { envoyeur: d.envoyeur, composer: fabriqueComposer(d.store, d.cfg, maintenant), maintenant, journal: d.journal, travailleur: d.travailleur });
}

export { OFFRES };

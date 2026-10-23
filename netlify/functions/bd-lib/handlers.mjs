// Gestionnaires des fonctions bd-*. Chaque fabrique reçoit ses dépendances
// (magasin, configuration, horloge, fetch, envoyeur) : les tests les remplacent.
import { OFFRES, offre as offreDe, montantTexte, DUREES, UTILISATIONS_MAX_LIEN } from './config.mjs';
import {
  json, nouveauJeton, hacher, egalConstant, jetonValideFormat, reference, cookieSession, cookieEfface,
  lireCookie, origineAutorisee, lireJSON, ipClient, limiter, nettoyer, emailValide, normaliserWhatsapp,
} from './util.mjs';
import { verifierSignature, creerSessionCheckout } from './stripe.mjs';
import { mettreEnFile, traiterFile } from './outbox.mjs';
import { QUESTIONNAIRES } from './questionnaires.mjs';
import { filtrerValeurs, verifier, mettreEnTexte } from './rendu.mjs';

const ISO = (ms) => new Date(ms).toISOString();
const GENERIQUE_LIEN = { erreur: 'lien_invalide', message: 'Ce lien n’est pas valable ou a expiré. Vous pouvez demander un nouveau lien.' };

// ---------- commandes et jetons ----------
async function lireCommande(store, id){ return id ? store.getJSON('commandes/' + id) : null; }
async function ecrireCommande(store, c){ await store.setJSON('commandes/' + c.id, c); }
function trace(c, maintenant, evenement){ (c.historique ||= []).push({ le: ISO(maintenant), evenement }); }

async function emettreJetonPaiement(store, c, maintenant){
  if(c.paiementJeton && c.paiementJeton.hash) await store.delete('jp/' + c.paiementJeton.hash);
  const jeton = nouveauJeton(); const h = hacher(jeton);
  c.paiementJeton = { hash: h, expire: maintenant + DUREES.lienPaiement };
  await store.setJSON('jp/' + h, { commande: c.id });
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
export async function emettreJetonAcces(store, c, maintenant){
  if(c.acces && c.acces.hash) await store.delete('ja/' + c.acces.hash);
  const jeton = nouveauJeton(); const h = hacher(jeton);
  c.acces = { hash: h, expire: maintenant + DUREES.lienAcces, utilisations: 0, max: UTILISATIONS_MAX_LIEN, revoque: false, emisLe: ISO(maintenant) };
  await store.setJSON('ja/' + h, { commande: c.id });
  trace(c, maintenant, 'lien_acces_emis');
  return jeton;
}
const payee = (c) => c && (c.statut === 'payee' || c.statut === 'questionnaire_recu');

async function ouvrirSession(store, c, maintenant){
  const sid = nouveauJeton();
  await store.setJSON('sess/' + hacher(sid), { commande: c.id, expire: maintenant + DUREES.session });
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
  const o = offreDe(c.offre);
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
      'Votre reçu de paiement vous est adressé séparément par Stripe.',
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

export function fabriqueComposer(store, cfg, maintenant){
  return async (item) => {
    if(item.type === 'alerte') return composerMessage(item, null, null, cfg);
    const c = await lireCommande(store, item.commandeId);
    if(!payee(c)) throw new Error('commande_non_payee');
    const jeton = await emettreJetonAcces(store, c, maintenant);   // émis au moment de l'envoi
    await ecrireCommande(store, c);
    return composerMessage(item, c, `${cfg.site}/mon-album#cle=${jeton}`, cfg);
  };
}

async function alerter(store, maintenant, sujet, texte, cle){
  await mettreEnFile(store, { type: 'alerte', dedup: 'alerte:' + cle, destinataire: 'admin', donnees: { sujet, texte } }, maintenant);
}

// ---------- 1. Demande d'intérêt (publique) ----------
export function handlerInteret(d){
  return async (req, context) => {
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
    await d.store.setJSON('interets/' + ref, { reference: ref, offre: code, prenoms, nom, email, whatsapp, declarationWhatsapp: true, projet, consentement: true, statut: 'nouvelle', creeLe: ISO(maintenant) });
    return json(201, { reference: ref });
  };
}

// ---------- 2. Administration (jeton porteur, comparé à son empreinte) ----------
export function handlerAdmin(d){
  return async (req) => {
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
        const lire = async (p) => Promise.all((await s.list(p)).map((k) => s.getJSON(k)));
        const commandes = (await lire('commandes/')).map((c) => ({ reference: c.id, offre: c.offre, statut: c.statut, prenoms: c.prenoms, nom: c.nom, email: c.email, creeLe: c.creeLe, payeLe: c.paiement && c.paiement.payeLe, anomalies: c.anomalies || [] }));
        const file = (await lire('ob/')).map((m) => ({ id: m.id, type: m.type, commande: m.commandeId, statut: m.statut, tentatives: m.tentatives, derniereErreur: m.derniereErreur }));
        return json(200, { interets: await lire('interets/'), commandes, file, paiements: { actifs: d.cfg.paiementsActifs, mode: d.cfg.mode, raisons: d.cfg.raisonsInactif } });
      }
      case 'confirmer': {
        const i = await s.getJSON('interets/' + nettoyer(corps.interet, 80));
        if(!i) return json(404, { erreur: 'interet_inconnu' });
        if(i.commande) return json(409, { erreur: 'deja_confirmee', commande: i.commande });
        const o = offreDe(i.offre);
        const c = { id: reference('CMD', o.code, maintenant), offre: o.code, montant: o.montant, devise: o.devise, prenoms: i.prenoms, nom: i.nom, email: i.email, whatsapp: i.whatsapp, interet: i.reference, statut: 'confirmee', creeLe: ISO(maintenant), sessionsCheckout: [], historique: [] };
        trace(c, maintenant, 'projet_confirme');
        const jeton = await emettreJetonPaiement(s, c, maintenant);
        await ecrireCommande(s, c);
        const ie = 'idx/email/' + hacher(c.email);
        const idx = (await s.getJSON(ie)) || { commandes: [] }; idx.commandes.push(c.id); await s.setJSON(ie, idx);
        i.statut = 'confirmee'; i.commande = c.id; await s.setJSON('interets/' + i.reference, i);
        return json(201, { commande: c.id, lienPaiement: `${d.cfg.site}/paiement-bd#t=${jeton}`, avertissement: 'Lien affiché une seule fois. À transmettre par Younous à la personne.' });
      }
      case 'nouveau-lien-paiement': {
        const c = await lireCommande(s, corps.commande);
        if(!c || !['confirmee', 'checkout_ouvert'].includes(c.statut)) return json(409, { erreur: 'etat' });
        const jeton = await emettreJetonPaiement(s, c, maintenant); trace(c, maintenant, 'lien_paiement_renouvele'); await ecrireCommande(s, c);
        return json(200, { lienPaiement: `${d.cfg.site}/paiement-bd#t=${jeton}` });
      }
      case 'lien-acces': {
        const c = await lireCommande(s, corps.commande);
        if(!payee(c)) return json(409, { erreur: 'commande_non_payee' });
        const jeton = await emettreJetonAcces(s, c, maintenant); await ecrireCommande(s, c);
        return json(200, { lienAcces: `${d.cfg.site}/mon-album#cle=${jeton}` });
      }
      case 'revoquer-acces': {
        const c = await lireCommande(s, corps.commande);
        if(!c || !c.acces) return json(404, { erreur: 'commande_inconnue' });
        c.acces.revoque = true; trace(c, maintenant, 'acces_revoque'); await ecrireCommande(s, c);
        return json(200, { ok: true });
      }
      case 'reponses': {
        const r = await s.getJSON('reponses/' + nettoyer(corps.commande, 80));
        return r ? json(200, r) : json(404, { erreur: 'aucune_reponse' });
      }
      case 'relancer-envoi': {
        const it = await s.getJSON('ob/' + nettoyer(corps.id, 80));
        if(!it) return json(404, { erreur: 'message_inconnu' });
        it.statut = 'a_envoyer'; it.tentatives = 0; it.prochainEssai = maintenant; await s.setJSON('ob/' + it.id, it);
        return json(200, { ok: true });
      }
      default: return json(400, { erreur: 'action_inconnue' });
    }
  };
}

// ---------- 3. Paiement intégré (page /paiement-bd, jeton dans le fragment d'URL) ----------
export function handlerPaiement(d){
  return async (req, context) => {
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
      const c = ref && await lireCommande(s, ref.commande);
      if(!c) return json(200, { statut: 'inconnu' });
      if(!payee(c) || !c.paiement || c.paiement.session !== sid) return json(200, { statut: 'en_attente' });
      // Accès direct une seule fois, depuis la page de retour, peu après le paiement constaté par le webhook.
      if(!c.retourUtilise && maintenant - Date.parse(c.paiement.payeLe) < DUREES.retourPaiement){
        c.retourUtilise = true; trace(c, maintenant, 'acces_retour_paiement'); await ecrireCommande(s, c);
        const cookie = await ouvrirSession(s, c, maintenant);
        return json(200, { statut: 'paye', acces: true, ...resumeCommande(c) }, { 'set-cookie': cookie });
      }
      return json(200, { statut: 'paye', acces: false, ...resumeCommande(c) });
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
      try{
        const sess = await creerSessionCheckout({ cfg: d.cfg, commande: c, offre: o, fetchFn: d.fetchFn, tentative: c.sessionsCheckout.length + 1 });
        await s.setJSON('cs/' + sess.id, { commande: c.id });
        c.sessionsCheckout.push({ id: sess.id, creeLe: ISO(maintenant) }); c.statut = 'checkout_ouvert'; trace(c, maintenant, 'checkout_ouvert');
        await ecrireCommande(s, c);
        return json(200, { clientSecret: sess.clientSecret, publishableKey: d.cfg.stripePublishable, mode: d.cfg.mode });
      }catch(e){
        d.journal('checkout_erreur', String(e.message).slice(0, 80));
        return json(502, { erreur: 'stripe_indisponible', message: 'Le paiement n’a pas pu s’ouvrir. Réessayez dans un moment.' });
      }
    }
    return json(400, { erreur: 'action_inconnue' });
  };
}

// ---------- 4. Webhook Stripe (signature, idempotence, contrôle serveur du montant) ----------
export function handlerWebhook(d){
  const TYPES = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired']);
  return async (req) => {
    if(req.method !== 'POST') return json(405, { erreur: 'methode' });
    if(!d.cfg.webhookSecret.startsWith('whsec_')) return json(503, { erreur: 'webhook_non_configure' });
    const brut = await req.text();
    const maintenant = d.now(); const s = d.store;
    if(!verifierSignature(brut, req.headers.get('stripe-signature'), d.cfg.webhookSecret, maintenant)) return json(400, { erreur: 'signature' });
    let ev; try{ ev = JSON.parse(brut); }catch{ return json(400, { erreur: 'json' }); }
    if(!ev || typeof ev.id !== 'string') return json(400, { erreur: 'evenement' });
    if(await s.getJSON('evt/' + ev.id)) return json(200, { recu: true, doublon: true });
    const marquer = async (resultat) => { await s.setJSON('evt/' + ev.id, { type: ev.type, traiteLe: ISO(maintenant), resultat }); return json(200, { recu: true, resultat }); };

    if(!TYPES.has(ev.type)) return marquer('ignore_type');
    const cs = ev.data && ev.data.object || {};
    const md = cs.metadata || {};
    if(!md.bd_commande) return marquer('ignore_hors_bd');           // autres produits du même compte
    if(!!ev.livemode !== (d.cfg.mode === 'live')){ await alerter(s, maintenant, 'Mode Stripe inattendu', `Événement ${ev.id} en mode ${ev.livemode ? 'live' : 'test'} alors que la configuration est en ${d.cfg.mode}.`, 'mode:' + ev.id); return marquer('ignore_mode'); }
    const c = await lireCommande(s, cs.client_reference_id);
    if(!c || md.bd_commande !== c.id){ await alerter(s, maintenant, 'Paiement sans commande', `Session ${cs.id} : référence inconnue.`, 'orphelin:' + cs.id); return marquer('commande_inconnue'); }
    const o = offreDe(c.offre);

    if(ev.type === 'checkout.session.expired') { trace(c, maintenant, 'checkout_expire'); await ecrireCommande(s, c); return marquer('expire'); }
    if(ev.type === 'checkout.session.async_payment_failed'){
      if(!payee(c)){ c.statut = 'confirmee'; trace(c, maintenant, 'paiement_differe_echoue'); await ecrireCommande(s, c); }
      return marquer('paiement_echoue');
    }
    const paye = ev.type === 'checkout.session.async_payment_succeeded' || cs.payment_status === 'paid';
    if(!paye){
      if(!payee(c)){ c.statut = 'paiement_en_cours'; trace(c, maintenant, 'paiement_en_cours'); await ecrireCommande(s, c); }
      return marquer('en_cours');
    }
    const ecarts = [];
    if(cs.amount_total !== o.montant) ecarts.push(`montant ${cs.amount_total} au lieu de ${o.montant}`);
    if(String(cs.currency) !== o.devise) ecarts.push(`devise ${cs.currency} au lieu de ${o.devise}`);
    if(md.bd_offre !== c.offre) ecarts.push(`offre ${md.bd_offre} au lieu de ${c.offre}`);
    if(ecarts.length){
      (c.anomalies ||= []).push({ le: ISO(maintenant), session: cs.id, ecarts }); await ecrireCommande(s, c);
      await alerter(s, maintenant, 'Paiement non conforme', `Commande ${c.id}, session ${cs.id} : ${ecarts.join(' ; ')}. Aucun accès ouvert.`, 'ecart:' + cs.id);
      return marquer('anomalie');
    }
    if(payee(c)){
      if(c.paiement && c.paiement.session === cs.id) return marquer('deja_paye');
      (c.anomalies ||= []).push({ le: ISO(maintenant), session: cs.id, ecarts: ['double paiement'] }); await ecrireCommande(s, c);
      await alerter(s, maintenant, 'Double paiement', `Commande ${c.id} déjà réglée ; nouvelle session ${cs.id}. Remboursement à examiner.`, 'double:' + cs.id);
      return marquer('double_paiement');
    }
    c.statut = 'payee';
    c.paiement = { session: cs.id, paymentIntent: cs.payment_intent || null, montant: cs.amount_total, devise: cs.currency, payeLe: ISO(maintenant), evenement: ev.id };
    if(c.paiementJeton){ await s.delete('jp/' + c.paiementJeton.hash); c.paiementJeton = null; }
    trace(c, maintenant, 'paiement_constate');
    await ecrireCommande(s, c);
    await mettreEnFile(s, { type: 'confirmation', dedup: 'confirmation:' + c.id, commandeId: c.id, destinataire: 'acheteur' }, maintenant);
    return marquer('paye');
  };
}

// ---------- 5. Accès personnel (ouverture, récupération, fermeture) ----------
export function handlerAcces(d){
  return async (req, context) => {
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
      const c = ref && await lireCommande(s, ref.commande);
      const a = c && c.acces;
      if(!payee(c) || !a || !egalConstant(a.hash, h) || a.revoque || a.expire < maintenant || a.utilisations >= a.max) return json(404, GENERIQUE_LIEN);
      a.utilisations += 1; trace(c, maintenant, 'lien_utilise'); await ecrireCommande(s, c);
      const cookie = await ouvrirSession(s, c, maintenant);
      return json(200, { ok: true, prenom: c.prenoms, offre: offreDe(c.offre).nom }, { 'set-cookie': cookie });
    }
    if(corps.action === 'recuperer'){
      const reponse = json(202, { message: 'Si une commande réglée correspond à cette adresse, un nouveau lien y est envoyé.' });
      const email = nettoyer(corps.email, 254).toLowerCase();
      if(!(await limiter(s, 'recup-ip', ip, 10, 3600e3, maintenant))) return reponse;
      if(!emailValide(email) || !(await limiter(s, 'recup-email', email, 3, 3600e3, maintenant))) return reponse;
      const idx = await s.getJSON('idx/email/' + hacher(email));
      for(const id of (idx && idx.commandes) || []){
        const c = await lireCommande(s, id);
        if(payee(c) && !(c.acces && c.acces.revoque)) await mettreEnFile(s, { type: 'nouveau-lien', dedup: `lien:${c.id}:${Math.floor(maintenant / 3600e3)}`, commandeId: c.id, destinataire: 'acheteur' }, maintenant);
      }
      return reponse;
    }
    if(corps.action === 'fermer'){
      const sid = lireCookie(req);
      if(jetonValideFormat(sid)) await s.delete('sess/' + hacher(sid));
      return json(200, { ok: true }, { 'set-cookie': cookieEfface() });
    }
    return json(400, { erreur: 'action_inconnue' });
  };
}

// ---------- 6. Questionnaire privé (session obligatoire) ----------
export function handlerQuestionnaire(d){
  return async (req) => {
    const maintenant = d.now(); const s = d.store;
    const c = await sessionCommande(s, req, maintenant);
    if(!c) return json(401, { erreur: 'session', message: 'Votre session a expiré ou ce lien n’est plus valable. Ouvrez de nouveau votre lien personnel.' });
    const schema = QUESTIONNAIRES[c.offre];
    if(req.method === 'GET'){
      const brouillon = await s.getJSON('brouillons/' + c.id);
      const rep = await s.getJSON('reponses/' + c.id);
      return json(200, { reference: c.id, prenom: c.prenoms, offre: offreDe(c.offre).nom, code: c.offre, schema, brouillon, envoye: !!rep, envoyeLe: rep && rep.envoyeLe });
    }
    if(!origineAutorisee(req, d.cfg)) return json(403, { erreur: 'origine' });
    if(await s.getJSON('reponses/' + c.id)) return json(409, { erreur: 'deja_envoye' });
    if(req.method === 'DELETE'){ await s.delete('brouillons/' + c.id); return json(200, { ok: true }); }
    const { corps, erreur } = await lireJSON(req, 1_000_000);
    if(erreur) return json(erreur === 'taille' ? 413 : 400, { erreur: 'requete' });
    const { valeurs, comptes } = filtrerValeurs(schema, corps.valeurs, corps.comptes);
    if(req.method === 'PUT'){
      await s.setJSON('brouillons/' + c.id, { valeurs, comptes, majLe: ISO(maintenant) });
      return json(200, { ok: true, majLe: ISO(maintenant) });
    }
    if(req.method === 'POST' && corps.action === 'envoyer'){
      const manques = verifier(schema, valeurs);
      if(manques.length) return json(422, { erreur: 'manques', manques });
      const texte = mettreEnTexte(schema, valeurs, comptes);
      await s.setJSON('reponses/' + c.id, { commande: c.id, offre: c.offre, version: schema.version, envoyeLe: ISO(maintenant), texte, valeurs, comptes });
      await s.delete('brouillons/' + c.id);
      c.statut = 'questionnaire_recu'; trace(c, maintenant, 'questionnaire_recu'); await ecrireCommande(s, c);
      await alerter(s, maintenant, 'Questionnaire reçu', `Commande ${c.id} (${offreDe(c.offre).nom}) : questionnaire reçu.`, 'questionnaire:' + c.id);
      return json(200, { ok: true, reference: c.id, texte });
    }
    return json(405, { erreur: 'methode' });
  };
}

// ---------- 7. File d'envoi (fonction planifiée) ----------
export async function executerFile(d){
  const maintenant = d.now();
  return traiterFile(d.store, { envoyeur: d.envoyeur, composer: fabriqueComposer(d.store, d.cfg, maintenant), maintenant, journal: d.journal });
}

export { OFFRES };

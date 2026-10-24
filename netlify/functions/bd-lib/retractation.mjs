// Réception d'une déclaration de rétractation, accessible sans connexion.
// Aucun rapprochement public avec les commandes, aucune décision sur le droit ni remboursement.
// Sources : Code de la consommation L221-21 et D221-5 (versions depuis le 19 juin 2026).
import { json, hacher, egalConstant, origineAutorisee, lireJSON, ipClient, limiter, emailValide, jetonValideFormat } from './util.mjs';
import { creerSiNouveau, maj } from './store.mjs';
import { mettreEnFile, traiterFile } from './outbox.mjs';

export const DECLARATION_RETRACTATION = 'Je notifie ma décision de me rétracter du contrat identifié ci-dessous.';
const TYPES = new Set(['retractation-recu', 'retractation-alerte']);
const PREFIXE = 'retractations/';
const CONTACT = 'younousjonas@gmail.com';
const CLE = (empreinte) => PREFIXE + empreinte;

export function estMessageRetractation(item){ return TYPES.has(item.type); }

function champ(valeur, max, multiligne = false){
  if(valeur === undefined || valeur === null) return '';
  if(typeof valeur !== 'string' || valeur.length > max) return null;
  if((multiligne ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(valeur)) return null;
  return valeur.trim();
}

function valider(corps){
  if(!corps || typeof corps !== 'object' || Array.isArray(corps)) return { erreurs: ['declaration'] };
  const valeurs = {
    prenoms: champ(corps.prenoms, 120), nom: champ(corps.nom, 120),
    email: champ(corps.email, 254), referenceCommande: champ(corps.referenceCommande, 120),
    elementsCommande: champ(corps.elementsCommande, 1000, true),
  };
  if(valeurs.email !== null) valeurs.email = valeurs.email.toLowerCase();
  const erreurs = [];
  if(!valeurs.prenoms) erreurs.push('prenoms');
  if(!valeurs.nom) erreurs.push('nom');
  if(!emailValide(valeurs.email)) erreurs.push('email');
  if(valeurs.referenceCommande === null) erreurs.push('referenceCommande');
  if(valeurs.elementsCommande === null) erreurs.push('elementsCommande');
  if(!valeurs.referenceCommande && !valeurs.elementsCommande) erreurs.push('identification');
  if(corps.action !== 'declarer' || corps.confirmation !== true) erreurs.push('confirmation');
  if(!jetonValideFormat(corps.cle)) erreurs.push('cle');
  return { valeurs, erreurs };
}

export function texteDeclaration(r){
  return [
    r.declaration,
    '', `Prénom(s) : ${r.prenoms}`, `Nom : ${r.nom}`,
    `Adresse électronique choisie pour l'accusé : ${r.email}`,
    `Référence de commande indiquée : ${r.referenceCommande || '(non renseignée)'}`,
    `Autres indications permettant d'identifier le contrat : ${r.elementsCommande || '(non renseignées)'}`,
  ].join('\n');
}

export function texteAccuseRetractation(r){
  const local = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Indian/Reunion', dateStyle: 'long', timeStyle: 'long' }).format(new Date(r.recueLe));
  return [
    'Run Coaching — Accusé de réception d’une déclaration de rétractation', '',
    `Référence de la déclaration : ${r.id}`,
    `Date et heure de transmission enregistrées : ${local} (La Réunion).`,
    `Horodatage UTC : ${r.recueLe}`, '',
    'La déclaration suivante a été reçue et enregistrée :', '',
    texteDeclaration(r), '',
    'Cet accusé atteste la réception de cette déclaration. Il ne constitue pas l’annonce d’un remboursement déjà effectué.',
    `Contact : ${CONTACT}`,
  ].join('\n');
}

export async function composerRetractation(store, item, cfg){
  const empreinte = item.donnees && item.donnees.retractation;
  if(typeof empreinte !== 'string' || !/^[a-f0-9]{64}$/.test(empreinte)) throw new Error('retractation_reference_invalide');
  const r = await store.getJSON(CLE(empreinte));
  if(!r) throw new Error('retractation_absente');
  const accuse = texteAccuseRetractation(r);
  if(item.type === 'retractation-recu') return { to: r.email, sujet: `Réception de votre déclaration de rétractation — ${r.id}`, texte: accuse, liens: false };
  if(item.type === 'retractation-alerte') return {
    to: cfg.adminEmail,
    sujet: `[BD personnelle] Déclaration de rétractation reçue — ${r.id}`,
    texte: 'Déclaration reçue par le formulaire public. Identité et contrat à vérifier à partir du dossier privé. Aucun remboursement ni changement de statut de commande n’a été exécuté.\n\n' + accuse,
    liens: false,
  };
  throw new Error('retractation_type_invalide');
}

async function preparerNotifications(store, r, maintenant){
  const ids = [];
  for(const type of TYPES){
    const msg = await mettreEnFile(store, {
      type, dedup: type + ':' + r.id, destinataire: type === 'retractation-recu' ? 'declarant' : 'admin',
      donnees: { retractation: r.cleEmpreinte },
    }, maintenant);
    ids.push(msg.id);
  }
  await maj(store, CLE(r.cleEmpreinte), (courante) => {
    if(!courante) throw new Error('retractation_absente');
    if(courante.notificationsPreparees) return undefined;
    return { ...courante, notificationsPreparees: true };
  });
  return ids;
}

// Une interruption entre le dépôt durable et la préparation des deux messages se répare
// au prochain passage de la file, même si le navigateur n'effectue plus de nouvel essai.
export async function reprendreNotificationsRetractations(store, maintenant, journal = () => {}){
  for(const k of await store.list(PREFIXE)){
    const r = await store.getJSON(k);
    if(!r || r.notificationsPreparees) continue;
    try{ await preparerNotifications(store, r, maintenant); }
    catch{ journal('retractation_notifications_a_reprendre', r.id); }
  }
}

export function handlerRetractation(d){
  return async (req, context) => {
    try{
      if(req.method !== 'POST') return json(405, { erreur: 'methode' }, { allow: 'POST' });
      if(!origineAutorisee(req, d.cfg)) return json(403, { erreur: 'origine' });
      const { corps, erreur } = await lireJSON(req, 8000);
      if(erreur) return json(400, { erreur: 'requete' });
      if(corps && corps.siteweb !== undefined && corps.siteweb !== '') return json(400, { erreur: 'requete' });
      const { valeurs, erreurs } = valider(corps);
      if(erreurs.length) return json(422, { erreur: 'champs', champs: erreurs });

      const s = d.store;
      const maintenant = d.now();
      const cleEmpreinte = hacher(corps.cle);
      const empreinteContenu = hacher(JSON.stringify({ ...valeurs, declaration: DECLARATION_RETRACTATION }));
      let r = await s.getJSON(CLE(cleEmpreinte));
      if(!r){
        if(!(await limiter(s, 'retractation-ip', ipClient(req, context), 10, 3600e3, maintenant)) ||
           !(await limiter(s, 'retractation-email', valeurs.email, 5, 3600e3, maintenant))){
          return json(429, { erreur: 'trop_de_demandes', message: `Plusieurs déclarations ont été reçues récemment. Vous pouvez aussi notifier votre décision à ${CONTACT}.` });
        }
        const declaration = {
          version: 1, id: 'RET-' + cleEmpreinte.slice(0, 24).toUpperCase(), cleEmpreinte, empreinteContenu,
          recueLe: new Date(maintenant).toISOString(), ...valeurs,
          declaration: DECLARATION_RETRACTATION, statut: 'declaration_recue', notificationsPreparees: false,
        };
        await creerSiNouveau(s, CLE(cleEmpreinte), declaration);
        r = await s.getJSON(CLE(cleEmpreinte));
        if(!r) throw new Error('retractation_ecriture_non_confirmee');
      }
      // La même clé ne permet ni d'écraser une déclaration ni de lire celle d'un autre dépôt.
      if(!egalConstant(r.empreinteContenu, empreinteContenu)) return json(409, { erreur: 'cle_reutilisee', message: 'Les informations de cet envoi ont changé. Revenez au formulaire pour préparer une nouvelle déclaration.' });

      // Le dépôt est déjà durable. Les erreurs de notification ne l'annulent jamais.
      // Le passage immédiat est limité aux deux messages de cette déclaration.
      try{
        const ids = await preparerNotifications(s, r, maintenant);
        const bilans = await Promise.allSettled(ids.map((id) => traiterFile(s, { ids: [id], envoyeur: d.envoyeur, composer: (item) => composerRetractation(s, item, d.cfg), maintenant, journal: d.journal })));
        if(bilans.some((b) => b.status === 'rejected')) throw new Error('retractation_notification_interrompue');
      }catch{ d.journal('retractation_notifications_a_reprendre', r.id); }
      return json(200, { ok: true, reference: r.id, recueLe: r.recueLe, accuse: texteAccuseRetractation(r) });
    }catch{
      d.journal('retractation_erreur');
      return json(500, { erreur: 'indisponible', message: `L'enregistrement n'a pas pu être confirmé. Réessayez avec le même formulaire ou notifiez votre décision à ${CONTACT}.` });
    }
  };
}

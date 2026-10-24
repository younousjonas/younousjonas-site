// File d'envoi durable (« outbox ») : chaque message à envoyer est d'abord écrit,
// puis envoyé par la fonction planifiée bd-outbox, avec reprises, dédoublonnage
// et état d'échec visible. Aucun fournisseur de courriel n'est branché par défaut :
// les messages restent alors « en_attente_fournisseur », visibles par l'administration.
//
// Atomicité :
// - mise en file : l'identifiant du message est tiré de sa clé de dédoublonnage et écrit
//   en une seule écriture « si nouveau » ; deux mises en file concurrentes du même message
//   n'en créent qu'un ;
// - envoi : un message est d'abord réservé (statut « en_cours », verrou daté, écriture
//   conditionnelle sur l'ETag) ; un seul traitement le détient. Un verrou expiré (traitement
//   interrompu) se reprend ;
// - fournisseur : la clé d'idempotence est l'identifiant du message, stable d'une reprise à
//   l'autre, pour qu'un envoi ambigu (délai dépassé) ne parte pas deux fois.
import crypto from 'node:crypto';
import { hacher } from './util.mjs';
import { maj, creerSiNouveau } from './store.mjs';

const DELAIS = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 4 * 3600e3, 12 * 3600e3];
export const ESSAIS_MAX = DELAIS.length;
export const VERROU_MS = 5 * 60e3;
const ENVOYABLES = ['a_envoyer', 'en_attente_fournisseur'];

export function idMessage(type, dedup){ return `MSG-${type}-${hacher(dedup).slice(0, 20)}`; }

// generation : rang d'émission du lien personnel que porte le message (voir handlers.mjs).
export async function mettreEnFile(store, { type, dedup, commandeId = null, destinataire, donnees = {}, generation = null }, maintenant){
  const id = idMessage(type, dedup);
  const cree = await creerSiNouveau(store, 'ob/' + id, {
    id, type, dedup, commandeId, destinataire, donnees, generation,
    statut: 'a_envoyer', tentatives: 0, prochainEssai: maintenant, derniereErreur: null, verrou: null,
    creeLe: new Date(maintenant).toISOString(), envoyeLe: null,
  });
  return { id, doublon: !cree };
}

// Envoyeurs. « aucun » : pas de fournisseur ; « capture » : tests (rien ne sort).
// envoyer({ to, sujet, texte, idempotencyKey }) : idempotencyKey est à transmettre au fournisseur.
export function envoyeurAucun(){ return { nom: 'aucun', disponible: false, async envoyer(){ throw new Error('aucun_fournisseur'); } }; }
export function envoyeurCapture(){
  const envoyes = [];
  return { nom: 'capture', disponible: true, envoyes, async envoyer(m){ envoyes.push(m); return { id: 'cap-' + envoyes.length }; } };
}

// Erreur sans reprise possible (ex. accès révoqué entre-temps) : le message passe « annule ».
export class ErreurDefinitive extends Error {}

// Fournisseur « make » : chaque message est posté au webhook d'un scénario Make qui l'envoie par
// la connexion Gmail existante (younousjonas@gmail.com). Le scénario dédoublonne sur
// l'identifiant du message (magasin Make « BD — confirmations envoyées ») et répond en JSON :
// 200 {ok:true, id} si le message part ou est déjà parti ; 403 clé refusée ; 422 destinataire
// refusé (en recette, seule l'adresse autorisée reçoit). Toute autre réponse, dont le texte
// « Accepted » d'un scénario désactivé, est un échec à reprendre : rien ne se déduit sans {ok:true}.
export function envoyeurMake({ url, cle, mode, fetchFn = fetch, delaiMs = 25e3 }){
  return {
    nom: 'make', disponible: true,
    async envoyer({ to, sujet, texte, idempotencyKey, liens = true }){
      if(!to) throw new ErreurDefinitive('destinataire_absent');
      const corps = JSON.stringify({ cle, id: idempotencyKey, mode, to, sujet, html: texteEnHtml(texte, liens) });
      const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: corps, signal: AbortSignal.timeout(delaiMs) });
      let j = null;
      try{ j = await r.json(); }catch{ j = null; }
      if(r.status === 200 && j && j.ok === true && j.id === idempotencyKey) return { id: 'make:' + idempotencyKey };
      if(r.status === 422) throw new ErreurDefinitive('make_destinataire_refuse');
      throw new Error('make_reponse_' + r.status);
    },
  };
}

// Texte brut → HTML sûr : échappement, liens https cliquables, retours à la ligne conservés.
export function texteEnHtml(texte, liensActifs = true){
  const echappe = String(texte || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const liens = liensActifs ? echappe.replace(/https:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`) : echappe;
  return '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">' + liens.replace(/\n/g, '<br>\n') + '</div>';
}

// Traite les messages dus. composer(item) fabrique {to, sujet, texte} au moment de l'envoi ;
// pour un même message, il doit produire le même contenu à chaque reprise.
export async function traiterFile(store, { envoyeur, composer, maintenant, journal = () => {}, travailleur = crypto.randomUUID(), ids = null }){
  const cles = ids === null ? await store.list('ob/') : [...new Set(ids)].map((id) => 'ob/' + id);
  const bilan = { envoyes: 0, attente: 0, echecs: 0, annules: 0, bailsPerdus: 0 };
  for(const k of cles){
    if(!envoyeur.disponible){
      const r = await maj(store, k, (it) => {
        if(!it || it.prochainEssai > maintenant) return undefined;
        const reprenable = it.statut === 'a_envoyer' || (it.statut === 'en_cours' && it.verrou && it.verrou.expire <= maintenant);
        if(!reprenable) return undefined;
        it.verrou = null;
        it.statut = 'en_attente_fournisseur'; return it;
      });
      if(r.valeur && r.valeur.statut === 'en_attente_fournisseur') bilan.attente += 1;
      continue;
    }
    // Réservation : seul le traitement dont l'écriture conditionnelle passe envoie le message.
    let reserve = false;
    const { valeur: it } = await maj(store, k, (x) => {
      reserve = false;
      if(!x || x.prochainEssai > maintenant) return undefined;
      const libre = ENVOYABLES.includes(x.statut) || (x.statut === 'en_cours' && x.verrou && x.verrou.expire <= maintenant);
      if(!libre) return undefined;
      x.statut = 'en_cours'; x.verrou = { par: travailleur, expire: maintenant + VERROU_MS };
      reserve = true; return x;
    });
    if(!reserve) continue;
    let resultat;
    try{
      const message = await composer(it);
      const r = await envoyeur.envoyer({ ...message, idempotencyKey: it.id });
      resultat = { ok: true, idFournisseur: r && r.id || null };
    }catch(e){
      resultat = { ok: false, definitif: e instanceof ErreurDefinitive, erreur: String(e && e.message || e).slice(0, 200) };
    }
    // Fin conditionnée au bail : si ce traitement a dépassé son verrou et qu'un autre a repris
    // le message, il n'écrase ni le résultat ni le verrou de ce dernier.
    const { valeur: fin, ecrit } = await maj(store, k, (x) => {
      if(!x || x.statut !== 'en_cours' || !x.verrou || x.verrou.par !== travailleur) return undefined;
      x.verrou = null;
      if(resultat.ok){
        x.statut = 'envoye'; x.envoyeLe = new Date(maintenant).toISOString(); x.idFournisseur = resultat.idFournisseur; x.derniereErreur = null;
        return x;
      }
      x.derniereErreur = resultat.erreur;
      if(resultat.definitif){ x.statut = 'annule'; return x; }
      x.tentatives += 1;
      if(x.tentatives >= ESSAIS_MAX) x.statut = 'echec';
      else { x.statut = 'a_envoyer'; x.prochainEssai = maintenant + DELAIS[x.tentatives - 1]; }
      return x;
    });
    if(!ecrit){ bilan.bailsPerdus += 1; journal('outbox_bail_perdu', it.id); continue; }
    if(fin.statut === 'envoye') bilan.envoyes += 1;
    else if(fin.statut === 'echec'){ bilan.echecs += 1; journal('outbox_echec', it.id); }
    else if(fin.statut === 'annule'){ bilan.annules += 1; journal('outbox_annule', it.id); }
  }
  return bilan;
}

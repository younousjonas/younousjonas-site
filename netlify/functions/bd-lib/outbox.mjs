// File d'envoi durable (« outbox ») : chaque message à envoyer est d'abord écrit,
// puis envoyé par la fonction planifiée bd-outbox, avec reprises, dédoublonnage
// et état d'échec visible. Aucun fournisseur de courriel n'est branché par défaut :
// les messages restent alors « en_attente_fournisseur », visibles par l'administration.
import { hacher, reference } from './util.mjs';

const DELAIS = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 4 * 3600e3, 12 * 3600e3];
export const ESSAIS_MAX = DELAIS.length;

export async function mettreEnFile(store, { type, dedup, commandeId = null, destinataire, donnees = {} }, maintenant){
  const kd = 'obd/' + hacher(dedup);
  const existant = await store.getJSON(kd);
  if(existant) return { id: existant.id, doublon: true };
  const id = reference('MSG', type, maintenant);
  await store.setJSON(kd, { id });
  await store.setJSON('ob/' + id, {
    id, type, dedup, commandeId, destinataire, donnees,
    statut: 'a_envoyer', tentatives: 0, prochainEssai: maintenant, derniereErreur: null,
    creeLe: new Date(maintenant).toISOString(), envoyeLe: null,
  });
  return { id, doublon: false };
}

// Envoyeurs. « aucun » : pas de fournisseur ; « capture » : tests (rien ne sort).
export function envoyeurAucun(){ return { nom: 'aucun', disponible: false, async envoyer(){ throw new Error('aucun_fournisseur'); } }; }
export function envoyeurCapture(){
  const envoyes = [];
  return { nom: 'capture', disponible: true, envoyes, async envoyer(m){ envoyes.push(m); return { id: 'cap-' + envoyes.length }; } };
}

// Traite les messages dus. composer(item) fabrique {to, sujet, texte} au moment de l'envoi
// (le lien personnel y est émis à ce moment : aucun lien en clair n'est stocké dans la file).
export async function traiterFile(store, { envoyeur, composer, maintenant, journal = () => {} }){
  const cles = await store.list('ob/');
  const bilan = { envoyes: 0, attente: 0, echecs: 0 };
  for(const k of cles){
    const it = await store.getJSON(k);
    if(!it || !['a_envoyer', 'en_attente_fournisseur'].includes(it.statut)) continue;
    if(it.prochainEssai > maintenant) continue;
    if(!envoyeur.disponible){
      if(it.statut !== 'en_attente_fournisseur'){ it.statut = 'en_attente_fournisseur'; await store.setJSON(k, it); }
      bilan.attente += 1;
      continue;
    }
    try{
      const message = await composer(it);
      const r = await envoyeur.envoyer(message);
      it.statut = 'envoye'; it.envoyeLe = new Date(maintenant).toISOString(); it.idFournisseur = r && r.id || null; it.derniereErreur = null;
      bilan.envoyes += 1;
    }catch(e){
      it.tentatives += 1;
      it.derniereErreur = String(e && e.message || e).slice(0, 200);
      if(it.tentatives >= ESSAIS_MAX){ it.statut = 'echec'; bilan.echecs += 1; journal('outbox_echec', it.id); }
      else { it.statut = 'a_envoyer'; it.prochainEssai = maintenant + DELAIS[it.tentatives - 1]; }
    }
    await store.setJSON(k, it);
  }
  return bilan;
}

// Dépendances de production des fonctions bd-*.
import { lireConfig } from './config.mjs';
import { magasinNetlify } from './store.mjs';
import { envoyeurAucun, envoyeurMake } from './outbox.mjs';

// Journal sans donnée personnelle ni secret : un code d'événement et un détail court.
const journal = (code, detail = '') => console.log('[bd]', code, String(detail).slice(0, 120));

// context : second argument de la fonction Netlify (contexte de déploiement).
export async function depsProd(context){
  const cfg = lireConfig();
  return { store: await magasinNetlify(context, cfg.mode), cfg, now: Date.now, fetchFn: fetch, envoyeur: choisirEnvoyeur(cfg), journal };
}

// Sans configuration complète du courriel, les messages restent « en_attente_fournisseur »
// sans consommer de tentative. L'ouverture des nouvelles ventes n'est pas un prérequis.
export function choisirEnvoyeur(cfg, fetchFn = fetch){
  if(cfg.mailProvider === 'make' && cfg.courrielsConfigures){
    return envoyeurMake({ url: cfg.makeUrl, cle: cfg.makeCle, mode: cfg.mode, fetchFn });
  }
  if(cfg.mailProvider !== 'none') journal('fournisseur_non_configure', cfg.mailProvider);
  return envoyeurAucun();
}

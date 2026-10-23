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

// Sans fournisseur valide, les messages restent « en_attente_fournisseur », visibles dans la file.
export function choisirEnvoyeur(cfg, fetchFn = fetch){
  if(cfg.mailProvider === 'make' && cfg.makeUrl && cfg.makeCle.length >= 32){
    return envoyeurMake({ url: cfg.makeUrl, cle: cfg.makeCle, mode: cfg.mode, fetchFn });
  }
  if(cfg.mailProvider !== 'none') journal('fournisseur_inconnu', cfg.mailProvider);
  return envoyeurAucun();
}

// Dépendances de production des fonctions bd-*.
import { lireConfig } from './config.mjs';
import { magasinNetlify } from './store.mjs';
import { envoyeurAucun } from './outbox.mjs';

// Journal sans donnée personnelle ni secret : un code d'événement et un détail court.
const journal = (code, detail = '') => console.log('[bd]', code, String(detail).slice(0, 120));

export async function depsProd(){
  const cfg = lireConfig();
  // Aucun fournisseur de courriel n'est branché : les messages restent visibles dans la file.
  if(cfg.mailProvider !== 'none') journal('fournisseur_inconnu', cfg.mailProvider);
  return { store: await magasinNetlify(), cfg, now: Date.now, fetchFn: fetch, envoyeur: envoyeurAucun(), journal };
}

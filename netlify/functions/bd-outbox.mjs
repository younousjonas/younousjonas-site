// Fonction planifiée bd-outbox : traite la file d'envoi toutes les 15 minutes.
// Sans fournisseur de courriel, les messages restent « en_attente_fournisseur », visibles par l'administration.
import { executerFile } from './bd-lib/handlers.mjs';
import { depsProd } from './bd-lib/deps.mjs';

export default async () => {
  const d = await depsProd();
  const bilan = await executerFile(d);
  d.journal('outbox', `${bilan.envoyes} envoyé(s), ${bilan.attente} en attente, ${bilan.echecs} échec(s)`);
  return new Response(null, { status: 204 });
};

export const config = { schedule: '*/15 * * * *' };

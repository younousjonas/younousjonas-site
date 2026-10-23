// Fonction Netlify bd-paiement : enveloppe de handlerPaiement (bd-lib/handlers.mjs).
import { handlerPaiement } from './bd-lib/handlers.mjs';
import { depsProd } from './bd-lib/deps.mjs';

export default async (req, context) => handlerPaiement(await depsProd())(req, context);

// Fonction Netlify bd-stripe-webhook : enveloppe de handlerWebhook (bd-lib/handlers.mjs).
import { handlerWebhook } from './bd-lib/handlers.mjs';
import { depsProd } from './bd-lib/deps.mjs';

export default async (req, context) => handlerWebhook(await depsProd(context))(req, context);

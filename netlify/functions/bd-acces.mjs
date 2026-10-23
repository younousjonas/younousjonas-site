// Fonction Netlify bd-acces : enveloppe de handlerAcces (bd-lib/handlers.mjs).
import { handlerAcces } from './bd-lib/handlers.mjs';
import { depsProd } from './bd-lib/deps.mjs';

export default async (req, context) => handlerAcces(await depsProd(context))(req, context);

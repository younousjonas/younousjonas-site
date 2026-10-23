// Fonction Netlify bd-interet : enveloppe de handlerInteret (bd-lib/handlers.mjs).
import { handlerInteret } from './bd-lib/handlers.mjs';
import { depsProd } from './bd-lib/deps.mjs';

export default async (req, context) => handlerInteret(await depsProd())(req, context);

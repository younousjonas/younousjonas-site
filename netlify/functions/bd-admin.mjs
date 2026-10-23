// Fonction Netlify bd-admin : enveloppe de handlerAdmin (bd-lib/handlers.mjs).
import { handlerAdmin } from './bd-lib/handlers.mjs';
import { depsProd } from './bd-lib/deps.mjs';

export default async (req, context) => handlerAdmin(await depsProd())(req, context);

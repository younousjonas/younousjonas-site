// Fonction Netlify bd-achat : enveloppe de handlerAchat (bd-lib/handlers.mjs).
import { handlerAchat } from './bd-lib/handlers.mjs';
import { depsProd } from './bd-lib/deps.mjs';

export default async (req, context) => handlerAchat(await depsProd(context))(req, context);

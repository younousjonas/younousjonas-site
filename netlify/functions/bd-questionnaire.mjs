// Fonction Netlify bd-questionnaire : enveloppe de handlerQuestionnaire (bd-lib/handlers.mjs).
import { handlerQuestionnaire } from './bd-lib/handlers.mjs';
import { depsProd } from './bd-lib/deps.mjs';

export default async (req, context) => handlerQuestionnaire(await depsProd(context))(req, context);

// Réception publique d'une déclaration ; aucune lecture publique de commande.
import { handlerRetractation } from './bd-lib/retractation.mjs';
import { depsProd } from './bd-lib/deps.mjs';

export default async (req, context) => handlerRetractation(await depsProd(context))(req, context);

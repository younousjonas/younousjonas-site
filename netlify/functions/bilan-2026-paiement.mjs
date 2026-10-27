import { paymentHandler, config } from './bilan-lib/paiement.mjs';
export default async (req, context) => paymentHandler({ cfg: config({ ...process.env,
  CONTEXT: context?.deploy?.context || process.env.CONTEXT || '',
}) })(req);

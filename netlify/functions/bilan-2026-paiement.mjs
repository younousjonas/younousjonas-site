import { paymentHandler } from './bilan-lib/paiement.mjs';
export default async req => paymentHandler()(req);

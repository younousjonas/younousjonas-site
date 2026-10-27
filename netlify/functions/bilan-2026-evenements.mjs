// Même endpoint Stripe (donc même secret de signature), avec relais du coaching existant.
import legacy from './stripe-webhook.js';
import { verifierSignature } from './bd-lib/stripe.mjs';
import { adapter } from './bd-lib/store.mjs';
import { config } from './bilan-lib/paiement.mjs';
import { isBilan, processBilan } from './bilan-lib/evenements.mjs';
export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Méthode non autorisée.', { status: 405 });
  const raw = await req.text();
  if (!verifierSignature(raw, req.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET, Date.now()))
    return new Response('Signature invalide.', { status: 400 });
  let e; try { e = JSON.parse(raw); } catch { return new Response('Événement invalide.', { status: 400 }); }
  if (isBilan(e)) {
    try {
      const { getStore, getDeployStore } = await import('@netlify/blobs');
      const production = context?.deploy?.context === 'production' || process.env.CONTEXT === 'production';
      const cfg = config();
      const name = 'bilan-inscriptions-' + (cfg.live ? 'live' : 'test');
      const store = adapter(production ? getStore({ name, consistency: 'strong' }) : getDeployStore({ name, consistency: 'strong' }));
      const r = await processBilan(e, { store, cfg, makeUrl: process.env.MAKE_WEBHOOK_URL_TRANSACTION, makeSecret: process.env.MAKE_WEBHOOK_SECRET });
      return new Response(r.body, { status: r.status });
    } catch { return new Response('Traitement à réessayer.', { status: 503 }); }
  }
  // Les coordonnées Bilan viennent du Checkout complet : pas de deuxième relai sur PI.
  if (e.data?.object?.metadata?.formule === 'bilan_2026' && e.type.startsWith('payment_intent.'))
    return new Response('Traité par Checkout.');
  const r = await legacy.handler({ httpMethod: req.method, headers: Object.fromEntries(req.headers), body: raw, isBase64Encoded: false });
  return new Response(r.body, { status: r.statusCode, headers: r.headers });
};

import { belongs } from './paiement.mjs';
import { maj } from '../bd-lib/store.mjs';
const EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed']);
export const isBilan = e => EVENTS.has(e?.type) && e?.data?.object?.metadata?.formule === 'bilan_2026';

// Appelé uniquement APRÈS vérification de signature. La commande payée est conservée
// indépendamment du navigateur. Un bail atomique évite les relais concurrents à Make.
export async function processBilan(e, { store, cfg, fetchFn = fetch, now = Date.now, makeUrl, makeSecret }) {
  const s = e.data.object;
  if (!belongs(s, cfg)) return { status: 400, body: 'Paiement non conforme.' };
  const key = 'inscriptions/' + s.id;
  const paid = s.payment_status === 'paid';
  if (!paid) {
    await maj(store, key, old => old?.paid ? undefined : { session: s.id, paid: false,
      status: e.type.endsWith('failed') ? 'failed' : 'pending', updatedAt: new Date(now()).toISOString() });
    return { status: 200, body: 'État reçu.' };
  }
  const fields = Object.fromEntries((s.custom_fields || []).map(f => [f.key, f.text?.value || '']));
  const contact = { prenom: fields.prenom, nom: fields.nom, telephone: fields.whatsapp,
    email: s.customer_details?.email || '', nom_facturation: s.customer_details?.name || '' };
  await maj(store, key, old => old?.paid ? undefined : { ...old, session: s.id, paid: true,
    amount: s.amount_total, currency: s.currency, paymentIntent: s.payment_intent, customer: s.customer,
    contact, metadata: s.metadata, paidAt: new Date(now()).toISOString(), relay: 'pending' });
  if (!makeUrl) return { status: 503, body: 'Inscription enregistrée ; relai en attente.' };
  const lease = e.id + ':' + now();
  const claim = await maj(store, key, old => {
    if (old.relay === 'sent' || (old.leaseUntil || 0) > now()) return undefined;
    return { ...old, relay: 'sending', lease, leaseUntil: now() + 60000 };
  });
  if (!claim.ecrit) return claim.valeur.relay === 'sent'
    ? { status: 200, body: 'Déjà traité.' } : { status: 503, body: 'Relai en cours.' };
  try {
    const record = claim.valeur;
    // Le format historique est conservé pour le scénario Make de Run Coaching.
    // Identifiant déterministe identique sur les deux événements de réussite.
    const payload = { event_id: 'bilan_paid_' + s.id, event_type: 'payment_intent.succeeded',
      stripe_event_id: e.id, stripe_event_type: e.type, checkout_session_id: s.id,
      payment_intent_id: s.payment_intent, charge_id: null, amount: s.amount_total, currency: s.currency,
      receipt_email: record.contact.email, receipt_url: null, metadata: { ...record.metadata, ...record.contact } };
    const r = await fetchFn(makeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Make-Secret': makeSecret || '', 'Idempotency-Key': payload.event_id }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('relay_failed');
    await maj(store, key, old => old.lease === lease ? { ...old, relay: 'sent', leaseUntil: 0 } : undefined);
    return { status: 200, body: 'Inscription enregistrée.' };
  } catch {
    await maj(store, key, old => old.lease === lease ? { ...old, relay: 'pending', leaseUntil: 0 } : undefined);
    return { status: 503, body: 'Inscription enregistrée ; relai à réessayer.' };
  }
}

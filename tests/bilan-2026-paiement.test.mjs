import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentHandler, sessionParams, config, END } from '../netlify/functions/bilan-lib/paiement.mjs';
import { processBilan, isBilan } from '../netlify/functions/bilan-lib/evenements.mjs';
import { magasinMemoire } from '../netlify/functions/bd-lib/store.mjs';
import endpointWebhook from '../netlify/functions/bilan-2026-evenements.mjs';
const NOW = Date.parse('2026-10-27T12:00:00Z');
const cfg = { active: true, live: true, price: 'price_bilan', secret: 'server_fake', publishable: 'pk_live_fake' };
const id = 'cs_live_abcdefghijklmno';
const session = extra => ({ id, status: 'open', payment_status: 'unpaid', livemode: true, amount_total: 39700,
  currency: 'eur', client_secret: 'client_fake', expires_at: NOW / 1000 + 3600,
  payment_intent: 'pi_fake', metadata: { formule: 'bilan_2026', source_site: 'younousjonas.com' },
  customer_details: { email: 'test@example.invalid', name: 'Test Synthétique' },
  custom_fields: [{ key: 'prenom', text: { value: 'Test' } }, { key: 'nom', text: { value: 'Synthétique' } },
    { key: 'whatsapp', text: { value: '+262692000000' } }], ...extra });
const input = { request_id: '12345678-1234-4234-8234-123456789abc', started_at: NOW, utm_source: 'instagram' };
const post = (body = input, origin = 'https://younousjonas.com') => new Request('https://younousjonas.com/.netlify/functions/bilan-2026-paiement', {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fetchStripe = async () => Response.json(session());

test('montant et catalogue serveur ; reprise idempotente, pas de donnée de carte côté serveur', async () => {
  const calls = [];
  const h = paymentHandler({ cfg, now: () => NOW, fetchFn: async (url, options) => { calls.push({ url, ...options }); return fetchStripe(); } });
  const malicious = { ...input, amount: 1, price: 'price_evil', return_url: 'https://evil.example', email: 'ignored@example.invalid' };
  assert.equal((await h(post(malicious))).status, 200);
  assert.equal((await h(post(malicious))).status, 200);
  const params = new URLSearchParams(calls[0].body);
  assert.equal(params.get('line_items[0][price]'), cfg.price);
  assert.equal(params.get('ui_mode'), 'embedded_page');
  assert.equal(params.get('redirect_on_completion'), 'if_required');
  assert.equal(params.get('invoice_creation[enabled]'), 'true');
  assert.match(params.get('return_url'), /^https:\/\/younousjonas.com\/bilan-2026/);
  assert.equal(params.get('metadata[utm_source]'), 'instagram');
  assert.equal(params.get('metadata[email]'), null);
  assert.equal(params.get('payment_method_types'), null);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  assert.equal(calls[0].body, calls[1].body);
});

test('origine étrangère, requêtes invalides et clôture ne créent aucun paiement', async () => {
  let calls = 0;
  for (const [req, status, now] of [[post(input, 'https://evil.example'), 403, NOW], [post({}), 400, NOW],
    [post({ ...input, started_at: NOW + 120000 }), 400, NOW], [post(), 410, END]]) {
    const h = paymentHandler({ cfg, now: () => now, fetchFn: async () => { calls++; return fetchStripe(); } });
    assert.equal((await h(req)).status, status);
  }
  assert.equal(calls, 0);
});

test('expiration limitée et trois coordonnées requises, sans abonnement', () => {
  const p = sessionParams(input, cfg, NOW);
  assert.equal(+p.get('expires_at'), NOW / 1000 + 3600);
  assert.equal(p.get('mode'), 'payment');
  for (let i = 0; i < 3; i++) assert.equal(p.get(`custom_fields[${i}][optional]`), 'false');
  const nearEnd = sessionParams(input, cfg, END - 60000);
  assert.equal(+nearEnd.get('expires_at'), (END - 60000) / 1000 + 1800);
});

test('vérification côté serveur : payé, en attente, autre produit, montant et mode faux ; aucune coordonnée exposée', async () => {
  for (const [s, code] of [[session({ status: 'complete', payment_status: 'paid' }), 200],
    [session(), 200], [session({ amount_total: 1 }), 404], [session({ livemode: false }), 404],
    [session({ metadata: { formule: 'autre' } }), 404]]) {
    const h = paymentHandler({ cfg, now: () => END + 86400000, fetchFn: async () => Response.json(s) });
    const r = await h(new Request('https://younousjonas.com/?session_id=' + id));
    assert.equal(r.status, code);
    const data = await r.json();
    assert.ok(!('clientSecret' in data)); assert.ok(!('customer_details' in data)); assert.ok(!('email' in data));
  }
});

test('API Stripe indisponible : erreur neutre, aucun secret ni corps Stripe renvoyé', async () => {
  const h = paymentHandler({ cfg, now: () => NOW, fetchFn: async () => Response.json({ error: { message: 'sensitive' } }, { status: 403 }) });
  const r = await h(post()); assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes('sensitive'));
});

test('configuration : production refuse clés de test et aperçu refuse clés live', () => {
  const env = { STRIPE_SECRET_KEY: 'rk_live_fake', STRIPE_PUBLISHABLE_KEY: 'pk_live_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' };
  assert.equal(config({ ...env, CONTEXT: 'production' }).active, true);
  assert.equal(config({ ...env, CONTEXT: 'deploy-preview' }).active, false);
  assert.equal(config({ ...env, STRIPE_SECRET_KEY: 'rk_test_fake', CONTEXT: 'production' }).active, false);
});

const event = (type, extra) => ({ id: 'evt_test', type: 'checkout.session.' + type, data: { object: session(extra) } });
const deps = store => ({ store, cfg, now: () => NOW, makeUrl: 'https://make.example.invalid', makeSecret: 'fake' });

test('webhook : paiement différé confirmé seulement après succès, indépendant de la page de retour', async () => {
  const store = magasinMemoire(); let relay = 0, sent;
  const d = { ...deps(store), fetchFn: async (_, o) => { relay++; sent = JSON.parse(o.body); return new Response('OK'); } };
  assert.equal((await processBilan(event('completed'), d)).status, 200);
  assert.equal(relay, 0); assert.equal((await store.getJSON('inscriptions/' + id)).paid, false);
  assert.equal((await processBilan(event('async_payment_succeeded', { payment_status: 'paid' }), d)).status, 200);
  assert.equal((await store.getJSON('inscriptions/' + id)).paid, true);
  assert.equal(sent.metadata.prenom, 'Test'); assert.equal(sent.metadata.telephone, '+262692000000');
  assert.equal(sent.receipt_email, 'test@example.invalid'); assert.equal(relay, 1);
  await processBilan(event('async_payment_failed'), d);
  assert.equal((await store.getJSON('inscriptions/' + id)).paid, true);
});

test('webhook : répétitions et concurrence ne relaient pas deux fois une inscription', async () => {
  const store = magasinMemoire({ latence: 2 }); let relay = 0;
  const d = { ...deps(store), fetchFn: async () => { relay++; return new Response('OK'); } };
  await Promise.all([processBilan(event('completed', { payment_status: 'paid' }), d),
    processBilan(event('async_payment_succeeded', { payment_status: 'paid' }), d)]);
  await processBilan(event('completed', { payment_status: 'paid' }), d);
  assert.equal(relay, 1);
});

test('webhook : panne Make conserve la commande et demande une nouvelle tentative à Stripe', async () => {
  const store = magasinMemoire();
  const e = event('completed', { payment_status: 'paid' });
  const failed = await processBilan(e, { ...deps(store), fetchFn: async () => new Response('No', { status: 500 }) });
  assert.equal(failed.status, 503);
  assert.equal((await store.getJSON('inscriptions/' + id)).paid, true);
  const r = await processBilan(e, { ...deps(store), fetchFn: async () => new Response('OK') });
  assert.equal(r.status, 200); assert.equal((await store.getJSON('inscriptions/' + id)).relay, 'sent');
});

test('webhook : montant ou mode incorrect refusés ; événement étranger ignoré', async () => {
  const store = magasinMemoire();
  for (const extra of [{ amount_total: 1 }, { livemode: false }]) {
    assert.equal((await processBilan(event('completed', { payment_status: 'paid', ...extra }), deps(store))).status, 400);
  }
  assert.equal(store._map.size, 0);
  assert.equal(isBilan({ type: 'checkout.session.completed', data: { object: { metadata: { formule: 'autre' } } } }), false);
});

test('webhook public refuse une fausse confirmation sans signature', async () => {
  const r = await endpointWebhook(new Request('https://younousjonas.com/', { method: 'POST', body: JSON.stringify(event('completed', { payment_status: 'paid' })) }), {});
  assert.equal(r.status, 400);
});

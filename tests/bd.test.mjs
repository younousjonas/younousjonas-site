// Tests des fonctions bd-* : magasin en mémoire, Stripe intercepté, envoyeur de capture,
// horloge fixe. Aucun appel réseau, aucun courriel, aucune donnée réelle.
// Lancer : node --test tests/bd.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { lireConfig } from '../netlify/functions/bd-lib/config.mjs';
import { magasinMemoire, magasinAiguille, plan, contexteDeploiement, adapter, maj, creerSiNouveau } from '../netlify/functions/bd-lib/store.mjs';
import { envoyeurCapture, envoyeurAucun, ESSAIS_MAX, VERROU_MS, mettreEnFile } from '../netlify/functions/bd-lib/outbox.mjs';
import { signerPourTest } from '../netlify/functions/bd-lib/stripe.mjs';
import { QUESTIONNAIRES } from '../netlify/functions/bd-lib/questionnaires.mjs';
import { handlerInteret, handlerAchat, handlerAdmin, handlerPaiement, handlerWebhook, handlerAcces, handlerQuestionnaire, executerFile } from '../netlify/functions/bd-lib/handlers.mjs';

const SITE = 'https://younousjonas.com';
const ADMIN = 'jeton-admin-de-test';
const WHSEC = 'whsec_secret_de_test';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function env(extra = {}){
  return { BD_PAYMENTS_ENABLED: 'true', BD_STRIPE_SECRET_KEY: 'sk_test_cle_factice', BD_STRIPE_PUBLISHABLE_KEY: 'pk_test_cle_factice', BD_STRIPE_WEBHOOK_SECRET: WHSEC, BD_ADMIN_TOKEN_SHA256: sha(ADMIN), URL: SITE, BD_ADMIN_EMAIL: 'admin@example.invalid', BD_LINK_SECRET: 'secret-de-lien-de-test-0123456789abcdef', ...extra };
}

function monde(opts = {}){
  let t = Date.UTC(2026, 9, 23, 15, 0, 0);
  const appelsStripe = [];
  const sessions = [];             // sessions Stripe distinctes (Stripe simulé idempotent : même clé → même session)
  const parCle = new Map();
  const journal = [];
  const d = {
    store: opts.store || magasinMemoire(),
    cfg: lireConfig(opts.env || env()),
    now: () => t,
    envoyeur: opts.envoyeur || envoyeurCapture(),
    journal: (...a) => journal.push(a.join(' ')),
    fetchFn: async (url, init) => {
      appelsStripe.push({ url, init });
      if(opts.stripeEchec) return new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 });
      const k = init.headers['idempotency-key'];
      if(!parCle.has(k)){
        const n = sessions.length + 1;
        parCle.set(k, { id: 'cs_test_SESSION' + String(n).padStart(4, '0') + 'ABCDEFGH', client_secret: 'cs_test_secret_client_' + n, livemode: false });
        sessions.push(parCle.get(k).id);
      }
      return new Response(JSON.stringify(parCle.get(k)), { status: 200 });
    },
  };
  return { d, avancer: (ms) => { t += ms; }, appelsStripe, sessions, journal, temps: () => t };
}

function req(method, corps, { cookie, origin = SITE, headers = {} } = {}){
  const h = { 'content-type': 'application/json', ...headers };
  if(origin) h.origin = origin;
  if(cookie) h.cookie = cookie;
  return new Request(SITE + '/.netlify/functions/x', { method, headers: h, body: corps === undefined ? undefined : (typeof corps === 'string' ? corps : JSON.stringify(corps)) });
}
const corpsDe = async (r) => r.json();
const cookieDe = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

const INTERET_OK = { offre: '297', prenoms: 'Test', nom: 'Synthétique', email: 'test.synthetique@example.invalid', whatsapp: '+262 692 00 00 00', declarationWhatsapp: true, consentement: true };
let nCle = 0;
const cleAchat = () => 'cle-achat-de-test-' + String(++nCle).padStart(8, '0');
const achatReq = (corps = {}, opts) => req('POST', { action: 'commander', ...INTERET_OK, cle: cleAchat(), ...corps }, opts);

// Achat direct : coordonnées + session Stripe en une étape. Renvoie la commande et sa session.
async function commandeConfirmee(m, offre = '297', email = INTERET_OK.email){
  const r = await handlerAchat(m.d)(achatReq({ offre, email }));
  assert.equal(r.status, 200);
  const b = await corpsDe(r);
  return { commande: b.reference, session: m.sessions.at(-1), clientSecret: b.clientSecret };
}
// La session est déjà ouverte par l'achat : renvoie la dernière créée.
async function ouvrirCheckout(m){ return m.sessions.at(-1); }
function evenement(id, type, session){ return { id, type, livemode: false, data: { object: session } }; }
function sessionPayee(commande, offre = '297', extra = {}){
  const montant = offre === '297' ? 29700 : 89100;
  return { id: 'cs_test_SESSION0001ABCDEFGH', mode: 'payment', client_reference_id: commande, payment_status: 'paid', amount_total: montant, currency: 'eur', payment_intent: 'pi_test_1', metadata: { bd_commande: commande, bd_offre: offre }, ...extra };
}
async function webhook(m, ev, { secret = WHSEC, decalage = 0 } = {}){
  const brut = JSON.stringify(ev);
  const sig = signerPourTest(brut, secret, Math.floor(m.temps() / 1000) + decalage);
  return handlerWebhook(m.d)(new Request(SITE + '/.netlify/functions/bd-stripe-webhook', { method: 'POST', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, body: brut }));
}
async function lienDuMessage(m){
  await executerFile(m.d);
  const msg = m.d.envoyeur.envoyes.at(-1);
  return { msg, jeton: msg.texte.match(/#cle=([A-Za-z0-9_-]{43})/)[1] };
}
async function commandePayee(m, offre = '297'){
  const { commande, session: sid } = await commandeConfirmee(m, offre);
  const r = await webhook(m, evenement('evt_paye_' + commande, 'checkout.session.completed', sessionPayee(commande, offre, { id: sid })));
  assert.equal((await corpsDe(r)).resultat, 'paye');
  return commande;
}
async function session(m, jeton){
  const r = await handlerAcces(m.d)(req('POST', { action: 'ouvrir', jeton }));
  return { r, cookie: cookieDe(r) };
}

// ---------------- 1. Demande d'intérêt retirée ----------------
test('demande d’intérêt retirée : 410 sans rien enregistrer, renvoi vers l’achat ; demandes déjà reçues conservées et listées', async () => {
  const m = monde();
  await m.d.store.setJSON('interets/INT-297-20261023-ANCIEN', { reference: 'INT-297-20261023-ANCIEN', offre: '297', statut: 'nouvelle' });
  const avant = [...m.d.store._map.keys()];
  const r = await handlerInteret(m.d)(new Request(SITE + '/.netlify/functions/bd-interet?offre=891', { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: JSON.stringify(INTERET_OK) }));
  assert.equal(r.status, 410);
  assert.equal((await corpsDe(r)).achat, '/achat-bd?offre=891');
  assert.deepEqual([...m.d.store._map.keys()], avant, 'rien n’est enregistré, pas même un compteur');
  const liste = await corpsDe(await handlerAdmin(m.d)(req('POST', { action: 'lister' }, { headers: { authorization: 'Bearer ' + ADMIN } })));
  assert.deepEqual(liste.interets.map((x) => x.reference), ['INT-297-20261023-ANCIEN'], 'demandes existantes préservées');
  for(const action of ['confirmer', 'nouveau-lien-paiement']){
    assert.equal((await handlerAdmin(m.d)(req('POST', { action, interet: 'INT-297-20261023-ANCIEN' }, { headers: { authorization: 'Bearer ' + ADMIN } }))).status, 410, action);
  }
});

// ---------------- 2. Achat direct ----------------
test('achat : coordonnées vérifiées (WhatsApp avec indicatif et déclaration, accord, clé d’achat), rien d’intime demandé', async () => {
  const m = monde();
  const r = await handlerAchat(m.d)(req('POST', { action: 'commander', offre: '297' }));
  assert.equal(r.status, 422);
  assert.deepEqual((await corpsDe(r)).champs.sort(), ['cle', 'consentement', 'declarationWhatsapp', 'email', 'nom', 'prenoms', 'whatsapp']);
  assert.deepEqual((await corpsDe(await handlerAchat(m.d)(achatReq({ whatsapp: '0692000000' })))).champs, ['whatsapp']);
  assert.deepEqual((await corpsDe(await handlerAchat(m.d)(achatReq({ declarationWhatsapp: false })))).champs, ['declarationWhatsapp']);
  assert.deepEqual((await corpsDe(await handlerAchat(m.d)(achatReq({ offre: '100' })))).champs, ['offre']);
  assert.equal(m.appelsStripe.length, 0);
  assert.equal((await m.d.store.list('commandes/')).length, 0, 'aucune commande sans coordonnées valides');
  const ok = await handlerAchat(m.d)(achatReq({ offre: '891', montant: 1, prix: 1 }));
  assert.equal(ok.status, 200);
  const b = await corpsDe(ok);
  assert.match(b.reference, /^CMD-891-20261023-[A-Z2-9]{6}$/);
  assert.equal(b.montant, '891,00 €');
  const c = await m.d.store.getJSON('commandes/' + b.reference);
  assert.equal(c.montant, 89100, 'prix du catalogue, jamais celui du navigateur'); assert.equal(c.offre, '891'); assert.equal(c.statut, 'checkout_ouvert');
  assert.equal(c.whatsapp, '+262692000000');
  assert.deepEqual(c.sessionsCheckout.map((x) => x.id), [m.sessions[0]], 'session enregistrée sur la commande');
});

test('achat : origine étrangère refusée, pot de miel, limites par connexion et par adresse', async () => {
  const m = monde();
  assert.equal((await handlerAchat(m.d)(achatReq({}, { origin: 'https://exemple-hostile.invalid' }))).status, 403);
  assert.equal((await handlerAchat(m.d)(achatReq({}, { origin: null }))).status, 403);
  assert.equal((await handlerAchat(m.d)(achatReq({ siteweb: 'http://spam' }))).status, 400);
  assert.equal((await m.d.store.list('commandes/')).length, 0);
  for(let i = 0; i < 5; i++) assert.equal((await handlerAchat(m.d)(achatReq())).status, 200);
  assert.equal((await handlerAchat(m.d)(achatReq())).status, 429, 'au-delà de 5 commandes par heure pour une adresse');
  for(let i = 0; i < 4; i++) assert.equal((await handlerAchat(m.d)(achatReq({ email: `autre${i}@example.invalid` }))).status, 200);
  assert.equal((await handlerAchat(m.d)(achatReq({ email: 'encore@example.invalid' }))).status, 429, 'au-delà de 10 essais par heure pour une connexion');
});

test('achat fermé (par défaut) : page honnête, rien d’enregistré, aucun appel Stripe, aucun secret', async () => {
  const m = monde({ env: env({ BD_PAYMENTS_ENABLED: '' }) });
  const g = await handlerAchat(m.d)(new Request(SITE + '/.netlify/functions/bd-achat?offre=297'));
  const b = await corpsDe(g);
  assert.equal(b.paiementDisponible, false); assert.equal(b.montant, '297,00 €'); assert.equal(b.nom, 'Mon parcours en BD');
  assert.equal((await handlerAchat(m.d)(new Request(SITE + '/.netlify/functions/bd-achat?offre=999'))).status, 404);
  const r = await handlerAchat(m.d)(achatReq());
  assert.equal(r.status, 503); assert.equal((await corpsDe(r)).erreur, 'paiement_indisponible');
  assert.equal(m.d.store._map.size, 0, 'aucune donnée captée, pas même un compteur');
  assert.equal(m.appelsStripe.length, 0);
  assert.ok(!m.journal.join(' ').includes('sk_test'), 'aucune clé dans les journaux');
});

test('paiement : mode live refusé par défaut, clé hors mode refusée', () => {
  assert.equal(lireConfig(env({ BD_PAYMENTS_MODE: 'live', BD_STRIPE_SECRET_KEY: 'sk_live_x', BD_STRIPE_PUBLISHABLE_KEY: 'pk_live_x' })).paiementsActifs, false);
  assert.equal(lireConfig(env({ BD_STRIPE_SECRET_KEY: 'sk_live_x' })).paiementsActifs, false);
  assert.equal(lireConfig(env({ BD_STRIPE_SECRET_KEY: '', STRIPE_SECRET_KEY: 'sk_test_coaching' })).paiementsActifs, false, 'les clés génériques du coaching ne sont jamais lues');
  assert.equal(lireConfig(env()).paiementsActifs, true);
});

test('achat : session Embedded Checkout au montant serveur, ui_mode=embedded_page, clé d’idempotence fixe par commande', async () => {
  const m = monde();
  const { commande } = await commandeConfirmee(m, '891');
  const b = await corpsDe(await handlerAchat(m.d)(achatReq({ offre: '297' })));
  assert.equal(b.publishableKey, 'pk_test_cle_factice'); assert.ok(b.clientSecret);
  assert.ok(!JSON.stringify(b).includes('sk_test'), 'jamais la clé secrète côté client');
  const { url, init } = m.appelsStripe[0];
  assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(init.headers['stripe-version'], '2026-03-25.dahlia');
  assert.equal(init.headers['idempotency-key'], `bd-cs-${commande}-achat`);
  const p = new URLSearchParams(init.body);
  assert.equal(p.get('ui_mode'), 'embedded_page');
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '89100');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(p.get('client_reference_id'), commande);
  assert.equal(p.get('metadata[bd_offre]'), '891');
  assert.equal(p.get('customer_email'), INTERET_OK.email);
  assert.equal(p.get('return_url'), SITE + '/paiement-bd-retour?session_id={CHECKOUT_SESSION_ID}');
});

test('achat : double clic et nouvel essai (même clé) → même commande et même session ; erreur Stripe sans détail ; commande payée refusée', async () => {
  const m = monde();
  const corps = { action: 'commander', ...INTERET_OK, cle: cleAchat() };
  const r1 = await corpsDe(await handlerAchat(m.d)(req('POST', corps)));
  const r2 = await corpsDe(await handlerAchat(m.d)(req('POST', corps)));
  assert.equal(r1.reference, r2.reference); assert.equal(r1.clientSecret, r2.clientSecret);
  assert.equal((await m.d.store.list('commandes/')).length, 1); assert.equal(m.sessions.length, 1);
  assert.equal((await m.d.store.getJSON('commandes/' + r1.reference)).sessionsCheckout.length, 1);
  const autre = await handlerAchat(m.d)(req('POST', { ...corps, email: 'autre@example.invalid' }));
  assert.equal(autre.status, 409, 'une clé d’achat ne sert qu’à une adresse');
  assert.equal((await handlerAchat(m.d)(req('POST', { ...corps, offre: '891' }))).status, 409, 'ni à une autre offre');
  await webhook(m, evenement('evt_dc', 'checkout.session.completed', sessionPayee(r1.reference, '297', { id: m.sessions[0] })));
  const apres = await handlerAchat(m.d)(req('POST', corps));
  assert.deepEqual([apres.status, (await corpsDe(apres)).erreur], [409, 'deja_paye']);
  const m2 = monde({ stripeEchec: true });
  const r = await handlerAchat(m2.d)(achatReq());
  assert.equal(r.status, 502);
  assert.ok(!m2.journal.join(' ').includes('sk_test'));
});

// ---------------- 4. Webhook ----------------
test('webhook : signature fausse ou périmée refusée ; non configuré → 503', async () => {
  const m = monde();
  const { commande } = await commandeConfirmee(m);
  const ev = evenement('evt_1', 'checkout.session.completed', sessionPayee(commande));
  assert.equal((await webhook(m, ev, { secret: 'whsec_autre' })).status, 400);
  assert.equal((await webhook(m, ev, { decalage: -600 })).status, 400);
  const sans = monde({ env: env({ BD_STRIPE_WEBHOOK_SECRET: '' }) });
  assert.equal((await webhook(sans, ev)).status, 503);
  assert.equal((await m.d.store.getJSON('commandes/' + commande)).statut, 'checkout_ouvert');
});

test('webhook : paiement réel → commande payée, une seule confirmation (idempotence)', async () => {
  const m = monde();
  const { commande, jetonPaiement } = await commandeConfirmee(m);
  await ouvrirCheckout(m, jetonPaiement);
  const ev = evenement('evt_2', 'checkout.session.completed', sessionPayee(commande));
  assert.equal((await corpsDe(await webhook(m, ev))).resultat, 'paye');
  assert.equal((await corpsDe(await webhook(m, ev))).doublon, true);
  // même paiement, autre identifiant d'événement (ex. async_payment_succeeded tardif)
  await webhook(m, evenement('evt_2b', 'checkout.session.async_payment_succeeded', sessionPayee(commande)));
  const c = await m.d.store.getJSON('commandes/' + commande);
  assert.equal(c.statut, 'payee'); assert.equal(c.paiement.montant, 29700);
  const file = await m.d.store.list('ob/');
  const confirmations = (await Promise.all(file.map((k) => m.d.store.getJSON(k)))).filter((x) => x.type === 'confirmation');
  assert.equal(confirmations.length, 1);
});

test('webhook : paiement différé — completed non payé n’ouvre rien, async_payment_succeeded ouvre', async () => {
  const m = monde();
  const { commande, jetonPaiement } = await commandeConfirmee(m);
  await ouvrirCheckout(m, jetonPaiement);
  await webhook(m, evenement('evt_3', 'checkout.session.completed', sessionPayee(commande, '297', { payment_status: 'unpaid' })));
  let c = await m.d.store.getJSON('commandes/' + commande);
  assert.equal(c.statut, 'paiement_en_cours'); assert.equal((await m.d.store.list('ob/')).length, 0);
  await webhook(m, evenement('evt_4', 'checkout.session.async_payment_succeeded', sessionPayee(commande, '297', { payment_status: 'paid' })));
  c = await m.d.store.getJSON('commandes/' + commande);
  assert.equal(c.statut, 'payee');
});

test('webhook : montant, devise, offre ou mode non conformes → aucun accès, alerte visible', async () => {
  for(const [nom, extra, evExtra] of [
    ['montant', { amount_total: 100 }, {}],
    ['devise', { currency: 'usd' }, {}],
    ['offre', { metadata: { bd_commande: null, bd_offre: '891' } }, {}],
    ['mode', {}, { livemode: true }],
    ['abonnement', { mode: 'subscription' }, {}],
    ['session non enregistrée', { id: 'cs_test_NONENREGISTREE0001' }, {}],
  ]){
    const m = monde();
    const { commande, jetonPaiement } = await commandeConfirmee(m);
    await ouvrirCheckout(m, jetonPaiement);
    const s = sessionPayee(commande, '297', extra);
    if(s.metadata.bd_commande === null) s.metadata.bd_commande = commande;
    await webhook(m, { ...evenement('evt_' + nom, 'checkout.session.completed', s), ...evExtra });
    const c = await m.d.store.getJSON('commandes/' + commande);
    assert.notEqual(c.statut, 'payee', nom);
    const items = await Promise.all((await m.d.store.list('ob/')).map((k) => m.d.store.getJSON(k)));
    assert.ok(items.every((x) => x.type === 'alerte'), nom + ' : aucune confirmation');
    assert.ok(items.length >= 1, nom + ' : alerte en file');
  }
});

test('webhook : événement d’un autre produit du compte ignoré ; double paiement signalé', async () => {
  const m = monde();
  const r = await webhook(m, evenement('evt_autre', 'checkout.session.completed', { id: 'cs_test_x', payment_status: 'paid', metadata: {} }));
  assert.equal((await corpsDe(r)).resultat, 'ignore_hors_bd');
  // deux sessions enregistrées sur la commande (cas exceptionnel), puis deux paiements
  const { commande, session: s1 } = await commandeConfirmee(m);
  const s2 = 'cs_test_SECONDESESSION0002';
  await maj(m.d.store, 'commandes/' + commande, (c) => { c.sessionsCheckout.push({ id: s2 }); return c; });
  assert.equal((await corpsDe(await webhook(m, evenement('evt_p1', 'checkout.session.completed', sessionPayee(commande, '297', { id: s1 }))))).resultat, 'paye');
  const second = await webhook(m, evenement('evt_double', 'checkout.session.completed', sessionPayee(commande, '297', { id: s2 })));
  assert.equal((await corpsDe(second)).resultat, 'double_paiement');
  const c = await m.d.store.getJSON('commandes/' + commande);
  assert.equal(c.anomalies[0].ecarts[0], 'double paiement');
});

// ---------------- 5. Confirmation et file d’envoi ----------------
test('confirmation : prénom, offre, montant, référence, étape, lien personnel, reçu ; aucun lien en clair stocké', async () => {
  const m = monde();
  const commande = await commandePayee(m);
  const avant = JSON.stringify([...m.d.store._map.values()]);
  const { msg, jeton } = await lienDuMessage(m);
  assert.equal(msg.to, INTERET_OK.email);
  for(const attendu of ['Bonjour Test', 'Mon parcours en BD', '297,00 €', commande, 'Prochaine étape', SITE + '/mon-album#cle=']) assert.ok(msg.texte.includes(attendu), attendu);
  assert.ok(!msg.texte.includes('reçu'), 'aucune promesse de reçu Stripe tant que BD_STRIPE_RECEIPTS_CONFIRMED n’est pas posé');
  const mr = monde({ env: env({ BD_STRIPE_RECEIPTS_CONFIRMED: 'oui' }) });
  await commandePayee(mr);
  assert.ok((await lienDuMessage(mr)).msg.texte.includes('Votre reçu de paiement vous est adressé séparément par Stripe.'));
  assert.ok(msg.sujet.includes(commande));
  assert.ok(!avant.includes(jeton));
  assert.ok(![...m.d.store._map.values()].join('').includes(jeton), 'seul le hachage du lien est stocké');
});

test('file : sans fournisseur, message visible « en_attente_fournisseur » ; reprises puis échec visible', async () => {
  const m = monde({ envoyeur: envoyeurAucun() });
  await commandePayee(m);
  await executerFile(m.d);
  const [k] = await m.d.store.list('ob/');
  assert.equal((await m.d.store.getJSON(k)).statut, 'en_attente_fournisseur');
  const casse = { nom: 'casse', disponible: true, async envoyer(){ throw new Error('refus_fournisseur'); } };
  const m2 = monde({ envoyeur: casse });
  await commandePayee(m2);
  for(let i = 0; i < ESSAIS_MAX; i++){ await executerFile(m2.d); m2.avancer(13 * 3600e3); }
  const it = await m2.d.store.getJSON((await m2.d.store.list('ob/'))[0]);
  assert.equal(it.statut, 'echec'); assert.equal(it.tentatives, ESSAIS_MAX); assert.equal(it.derniereErreur, 'refus_fournisseur');
  const liste = await corpsDe(await handlerAdmin(m2.d)(req('POST', { action: 'lister' }, { headers: { authorization: 'Bearer ' + ADMIN } })));
  assert.equal(liste.file[0].statut, 'echec');
});

// ---------------- 6. Page de retour : jamais de succès sur simple redirection ----------------
test('retour : « en attente » tant que le webhook n’est pas passé ; accès direct une seule fois', async () => {
  const m = monde();
  const { commande } = await commandeConfirmee(m);
  const sid = 'cs_test_SESSION0001ABCDEFGH';
  const avant = await handlerPaiement(m.d)(req('POST', { action: 'statut', sessionId: sid }));
  assert.equal((await corpsDe(avant)).statut, 'en_attente'); assert.equal(avant.headers.get('set-cookie'), null);
  await webhook(m, evenement('evt_r', 'checkout.session.completed', sessionPayee(commande)));
  const apres = await handlerPaiement(m.d)(req('POST', { action: 'statut', sessionId: sid }));
  const b = await corpsDe(apres);
  assert.equal(b.statut, 'paye'); assert.equal(b.acces, true); assert.equal(b.montant, '297,00 €');
  assert.match(apres.headers.get('set-cookie'), /^__Host-bd_sess=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
  const encore = await handlerPaiement(m.d)(req('POST', { action: 'statut', sessionId: sid }));
  assert.equal((await corpsDe(encore)).acces, false); assert.equal(encore.headers.get('set-cookie'), null);
  assert.equal((await corpsDe(await handlerPaiement(m.d)(req('POST', { action: 'statut', sessionId: 'cs_test_INCONNUE00000' })))).statut, 'inconnu');
});

// ---------------- 7. Accès personnel ----------------
test('accès : lien → cookie de session ; lien faux, expiré, révoqué ou épuisé refusés de façon générique', async () => {
  const m = monde();
  const commande = await commandePayee(m);
  const { jeton } = await lienDuMessage(m);
  const { r, cookie } = await session(m, jeton);
  assert.equal(r.status, 200); assert.match(cookie, /^__Host-bd_sess=/);
  const faux = await handlerAcces(m.d)(req('POST', { action: 'ouvrir', jeton: 'A'.repeat(43) }));
  assert.deepEqual([faux.status, (await corpsDe(faux)).erreur], [404, 'lien_invalide']);
  for(let i = 1; i < 10; i++) await session(m, jeton);
  assert.equal((await session(m, jeton)).r.status, 404, 'au-delà de 10 utilisations');
  // nouveau lien : l'ancien cesse de fonctionner
  const r2 = await corpsDe(await handlerAdmin(m.d)(req('POST', { action: 'lien-acces', commande }, { headers: { authorization: 'Bearer ' + ADMIN } })));
  const jeton2 = r2.lienAcces.split('#cle=')[1];
  assert.equal((await session(m, jeton)).r.status, 404);
  assert.equal((await session(m, jeton2)).r.status, 200);
  m.avancer(31 * 24 * 3600e3);
  assert.equal((await session(m, jeton2)).r.status, 404, 'expiré après 30 jours');
});

test('accès : révocation coupe aussi les sessions ouvertes ; session expirée refusée', async () => {
  const m = monde();
  const commande = await commandePayee(m);
  const { jeton } = await lienDuMessage(m);
  const { cookie } = await session(m, jeton);
  assert.equal((await handlerQuestionnaire(m.d)(req('GET', undefined, { cookie }))).status, 200);
  m.avancer(13 * 3600e3);
  assert.equal((await handlerQuestionnaire(m.d)(req('GET', undefined, { cookie }))).status, 401, 'session de 12 h');
  const { cookie: c2 } = await session(m, jeton);
  await handlerAdmin(m.d)(req('POST', { action: 'revoquer-acces', commande }, { headers: { authorization: 'Bearer ' + ADMIN } }));
  assert.equal((await handlerQuestionnaire(m.d)(req('GET', undefined, { cookie: c2 }))).status, 401);
});

test('récupération : réponse identique que l’adresse existe ou non ; nouveau lien seulement pour une commande payée', async () => {
  const m = monde();
  await commandePayee(m);
  const r1 = await handlerAcces(m.d)(req('POST', { action: 'recuperer', email: INTERET_OK.email }));
  const r2 = await handlerAcces(m.d)(req('POST', { action: 'recuperer', email: 'inconnue@example.invalid' }));
  assert.equal(r1.status, 202); assert.equal(r2.status, 202);
  assert.deepEqual(await corpsDe(r1), await corpsDe(r2));
  const types = (await Promise.all((await m.d.store.list('ob/')).map((k) => m.d.store.getJSON(k)))).map((x) => x.type).sort();
  assert.deepEqual(types, ['confirmation', 'nouveau-lien']);
  // commande confirmée mais non payée : rien
  const m2 = monde();
  await commandeConfirmee(m2);
  await handlerAcces(m2.d)(req('POST', { action: 'recuperer', email: INTERET_OK.email }));
  assert.equal((await m2.d.store.list('ob/')).length, 0);
  // limite par adresse : 3 par heure, réponse toujours identique
  for(let i = 0; i < 5; i++) assert.equal((await handlerAcces(m.d)(req('POST', { action: 'recuperer', email: INTERET_OK.email }))).status, 202);
});

// ---------------- 8. Questionnaire privé ----------------
test('questionnaire : sans session 401 ; la bonne offre sert le bon questionnaire (17 ou 45 questions)', async () => {
  const m = monde();
  assert.equal((await handlerQuestionnaire(m.d)(req('GET'))).status, 401);
  const nb = (s) => s.sections.reduce((a, x) => a + x.items.filter((q) => q.num).length, 0);
  for(const [offre, attendu] of [['297', 17], ['891', 45]]){
    const mm = monde();
    await commandePayee(mm, offre);
    const { jeton } = await lienDuMessage(mm);
    const { cookie } = await session(mm, jeton);
    const b = await corpsDe(await handlerQuestionnaire(mm.d)(req('GET', undefined, { cookie })));
    assert.equal(b.code, offre); assert.equal(nb(b.schema), attendu);
    assert.ok(!JSON.stringify(b.schema).includes('contact_email'), 'contact déjà connu, retiré du questionnaire');
  }
});

test('questionnaire : brouillons isolés par commande ; effacement ; envoi vérifié côté serveur ; second envoi refusé', async () => {
  const m = monde();
  const a = await commandePayee(m, '891');
  const { jeton: ja } = await lienDuMessage(m);
  const { cookie: ca } = await session(m, ja);
  // deuxième commande, autre personne
  const { commande: b } = await commandeConfirmee(m, '297', 'autre@example.invalid');
  await webhook(m, evenement('evt_b', 'checkout.session.completed', sessionPayee(b, '297', { id: 'cs_test_SESSION0002ABCDEFGH' })));
  const { jeton: jb } = await lienDuMessage(m);
  const { cookie: cb } = await session(m, jb);

  await handlerQuestionnaire(m.d)(req('PUT', { valeurs: { q1: 'Prénom A', 'q16': ['A. Famille et transmission'], 'q16.0.0': 'gardé', 'q16.1.0': 'thème non choisi', inconnu: 'x' }, comptes: { q9: 4 } }, { cookie: ca }));
  const vueA = await corpsDe(await handlerQuestionnaire(m.d)(req('GET', undefined, { cookie: ca })));
  assert.equal(vueA.brouillon.valeurs.q1, 'Prénom A');
  assert.equal(vueA.brouillon.valeurs['q16.1.0'], undefined, 'réponse d’un thème non choisi retirée');
  assert.equal(vueA.brouillon.valeurs.inconnu, undefined, 'clé inconnue retirée');
  assert.equal(vueA.brouillon.comptes.q9, 4);
  const vueB = await corpsDe(await handlerQuestionnaire(m.d)(req('GET', undefined, { cookie: cb })));
  assert.equal(vueB.brouillon, null, 'la commande B ne voit pas le brouillon de A');
  assert.equal(vueB.reference, b);

  assert.equal((await handlerQuestionnaire(m.d)(req('PUT', { valeurs: {} }, { cookie: ca, origin: 'https://exemple-hostile.invalid' }))).status, 403);
  await handlerQuestionnaire(m.d)(req('DELETE', undefined, { cookie: ca }));
  assert.equal((await corpsDe(await handlerQuestionnaire(m.d)(req('GET', undefined, { cookie: ca })))).brouillon, null);

  const incomplet = await handlerQuestionnaire(m.d)(req('POST', { action: 'envoyer', valeurs: { q1: 'A' } }, { cookie: ca }));
  assert.equal(incomplet.status, 422);
  assert.ok((await corpsDe(incomplet)).manques.length >= 2);
  const complet = await handlerQuestionnaire(m.d)(req('POST', { action: 'envoyer', valeurs: { q1: 'A', 'q2.__later': 'oui', 'q5.alt': ['Je préfère que nous les choisissions ensemble.'], accord_reponses: 'oui', q16: ['C. Études, apprentissages et travail'], 'q16.2.0': 'Étapes', 'q16.0.0': 'caché' } }, { cookie: ca }));
  assert.equal(complet.status, 200);
  const rep = await m.d.store.getJSON('reponses/' + a);
  assert.ok(rep.texte.includes('[Je préfère en parler pendant l’entretien.]'));
  assert.ok(rep.texte.includes('Étapes')); assert.ok(!rep.texte.includes('caché'));
  assert.equal((await m.d.store.getJSON('commandes/' + a)).statut, 'questionnaire_recu');
  assert.equal((await handlerQuestionnaire(m.d)(req('POST', { action: 'envoyer', valeurs: { q1: 'A', accord_reponses: 'oui' } }, { cookie: ca }))).status, 409);
  assert.equal((await corpsDe(await handlerQuestionnaire(m.d)(req('GET', undefined, { cookie: ca })))).envoye, true);
});

// ---------------- 9. Garde Edge des anciens formulaires ----------------
test('garde Edge : anciens formulaires refusés (urlencoded et multipart, toute route) ; autres formulaires inchangés', async () => {
  const src = fs.readFileSync(new URL('../netlify/edge-functions/bd-formulaires-fermes.js', import.meta.url), 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const suivant = { next: () => new Response('passe', { status: 200 }) };
  const post = (path, body, ct) => new Request('https://younousjonas.com' + path, { method: 'POST', headers: { 'content-type': ct }, body });
  for(const nom of ['biographies-parcours-297', 'biographies-histoire-891']){
    const u = await mod.default(post('/', `form-name=${nom}&reponses=x`, 'application/x-www-form-urlencoded'), suivant);
    assert.equal(u.status, 410); assert.equal(u.headers.get('x-bd-garde'), 'formulaire-ferme');
    const enc = await mod.default(post('/une/autre/route', `form-name=${encodeURIComponent(nom)}`, 'application/x-www-form-urlencoded; charset=UTF-8'), suivant);
    assert.equal(enc.status, 410);
    const fd = new FormData(); fd.append('bot-field', ''); fd.append('form-name', nom); fd.append('reponses', 'x');
    const mp = await mod.default(new Request('https://younousjonas.com/', { method: 'POST', body: fd }), suivant);
    assert.equal(mp.status, 410, 'multipart ' + nom);
  }
  for(const autre of ['leads-younousjonas', 'feuille-de-jugement', 'biographies-interet']){
    const r = await mod.default(post('/', `form-name=${autre}&x=1`, 'application/x-www-form-urlencoded'), suivant);
    assert.equal(await r.text(), 'passe', autre);
  }
  assert.equal(await (await mod.default(new Request('https://younousjonas.com/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"form-name":"biographies-parcours-297"}' }), suivant)).text(), 'passe', 'JSON hors périmètre des formulaires Netlify');
  assert.deepEqual(mod.config.excludedPath, ['/.netlify/*']);
  // Contournements : doublons, casse, espaces, multipart, corps illisible
  const ue = 'application/x-www-form-urlencoded';
  for(const corps of ['form-name=leads-younousjonas&form-name=biographies-parcours-297', 'form-name=Biographies-Parcours-297', 'form-name=%20biographies-histoire-891%20', 'x=1&form-name=biographies-histoire-891&form-name=autre']){
    assert.equal((await mod.default(post('/', corps, ue), suivant)).status, 410, corps);
  }
  const dbl = new FormData(); dbl.append('form-name', 'feuille-de-jugement'); dbl.append('form-name', 'biographies-histoire-891');
  assert.equal((await mod.default(new Request('https://younousjonas.com/x', { method: 'POST', body: dbl }), suivant)).status, 410, 'multipart avec doublon');
  const casse = post('/', '--b\r\nContent-Disposition: form-data; name="form-name"\r\n\r\nbiographies-parcours-297\r\n(corps tronqué', 'multipart/form-data; boundary=b');
  assert.equal((await mod.default(casse, suivant)).status, 410, 'multipart illisible contenant un ancien nom');
  const casseAutre = post('/', '--b\r\nContent-Disposition: form-data; name="form-name"\r\n\r\nfeuille-de-jugement\r\n(corps tronqué', 'multipart/form-data; boundary=b');
  assert.equal(await (await mod.default(casseAutre, suivant)).text(), 'passe', 'multipart illisible d’un autre formulaire');
});

test('magasins : production séparée des aperçus ; intérêts indépendants du mode Stripe ; aiguillage par clé', async () => {
  assert.deepEqual(plan('production', 'test'), { type: 'site', interets: 'bd-interets-production', commandes: 'bd-commandes-production-test' });
  assert.deepEqual(plan('production', 'live'), { type: 'site', interets: 'bd-interets-production', commandes: 'bd-commandes-production-live' });
  for(const c of ['deploy-preview', 'branch-deploy', 'dev', 'inconnu']) assert.equal(plan(c, 'test').type, 'deploiement', c);
  assert.equal(contexteDeploiement({ deploy: { context: 'deploy-preview' } }, { CONTEXT: 'production' }), 'deploy-preview', 'le contexte de la fonction prime');
  assert.equal(contexteDeploiement(undefined, {}), 'inconnu');
  const i = magasinMemoire(); const c = magasinMemoire(); const s = magasinAiguille(i, c);
  await s.setJSON('interets/INT-1', { a: 1 }); await s.setJSON('rl/interet-ip/x/1', { n: 1 });
  await s.setJSON('commandes/CMD-1', { b: 1 }); await s.setJSON('rl/acces-ip/x/1', { n: 1 });
  assert.deepEqual([...i._map.keys()].sort(), ['interets/INT-1', 'rl/interet-ip/x/1']);
  assert.deepEqual([...c._map.keys()].sort(), ['commandes/CMD-1', 'rl/acces-ip/x/1']);
  assert.deepEqual(await s.list('interets/'), ['interets/INT-1']);
  // parcours complet sur deux magasins séparés : la confirmation lit l'intérêt et écrit la commande ailleurs
  const m = monde(); m.d.store = magasinAiguille(magasinMemoire(), magasinMemoire());
  const { commande } = await commandeConfirmee(m);
  assert.ok(commande);
});

// ---------------- 10. Site statique ----------------
test('site : ni questionnaire public, ni demande d’intérêt, ni ancien lien de paiement ; tout mène à l’achat de la bonne offre', () => {
  const racine = new URL('../', import.meta.url);
  const pages = fs.readdirSync(racine).filter((f) => f.endsWith('.html'));
  for(const retiree of ['demande-mon-parcours-en-bd.html', 'demande-mon-histoire-en-bd.html', 'demande-bd.html', 'paiement-bd.html']) assert.ok(!pages.includes(retiree), retiree);
  assert.ok(pages.includes('achat-bd.html'));
  for(const p of pages){
    const t = fs.readFileSync(new URL(p, racine), 'utf8');
    assert.ok(!t.includes('biographies-parcours-297') && !t.includes('biographies-histoire-891'), p + ' : ancien formulaire');
    assert.ok(!t.includes('Quels moments ont infléchi votre histoire'), p + ' : texte de questionnaire');
    assert.ok(!t.includes('demande-bd') && !t.includes('bd-interet') && !/demande d.intérêt/i.test(t.replace('Les demandes d\'intérêt reçues avant le 23 octobre 2026', '')), p + ' : demande d’intérêt');
  }
  assert.ok(!fs.existsSync(new URL('assets/bd-questionnaire.js', racine)) && !fs.existsSync(new URL('assets/bd-interet.js', racine)));
  const red = fs.readFileSync(new URL('_redirects', racine), 'utf8');
  for(const r of ['/demande-mon-parcours-en-bd /achat-bd?offre=297 301!', '/demande-mon-parcours-en-bd.html /achat-bd?offre=297 301!', '/demande-mon-histoire-en-bd /achat-bd?offre=891 301!', '/demande-mon-histoire-en-bd.html /achat-bd?offre=891 301!',
    '/demande-bd /achat-bd 301!', '/demande-bd.html /achat-bd 301!', '/paiement-bd /achat-bd 301!', '/paiement-bd.html /achat-bd 301!', '/achat-bd /achat-bd.html 200',
    '/netlify/* /404 404!', '/node_modules/* /404 404!', '/tests/* /404 404!']) assert.ok(red.includes(r), r);
  assert.ok(!/\/paiement-bd \/paiement-bd\.html/.test(red), 'ancienne page de paiement plus servie');
  assert.ok(red.includes('/paiement-bd-retour /paiement-bd-retour.html 200'));
  const offres = fs.readFileSync(new URL('bd-personnelle.html', racine), 'utf8');
  assert.ok(!/huit semaines|8 semaines/.test(offres));
  assert.ok(offres.includes('href="achat-bd?offre=297"') && offres.includes('href="achat-bd?offre=891"'));
  assert.ok(offres.includes('Que se passe-t-il après le paiement ?'));
  assert.ok(!/confirm(é|e) par Younous|projet confirmé|confirmation du projet/.test(offres), 'plus de validation manuelle préalable');
  assert.ok(offres.includes('six semaines après le second entretien et la réception des éléments nécessaires'), 'délai 891 validé');
  assert.ok(offres.includes('délai de l’album final est convenu par écrit pour chaque projet'));
  assert.equal(Object.keys(QUESTIONNAIRES).sort().join(), '297,891');
});

// ---------------- 11. Webhook du coaching : les paiements BD n'en sortent jamais ----------------
test('webhook coaching : paiements BD ignorés (métadonnées ou description), autres paiements toujours relayés', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wh = require('../netlify/functions/stripe-webhook.js');
  const sauve = { ...process.env }; const fetchOrig = globalThis.fetch;
  const relais = [];
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_coaching_test';
  process.env.MAKE_WEBHOOK_URL_TRANSACTION = 'https://make.example.invalid/hook';
  globalThis.fetch = async (url, init) => { relais.push({ url, corps: init.body }); return new Response('ok', { status: 200 }); };
  const envoyer = async (ev) => {
    const brut = JSON.stringify(ev);
    const sig = signerPourTest(brut, 'whsec_coaching_test', Math.floor(Date.now() / 1000));
    return wh.handler({ httpMethod: 'POST', headers: { 'stripe-signature': sig }, body: brut, isBase64Encoded: false });
  };
  try{
    const r1 = await envoyer({ id: 'evt_c1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount: 29700, metadata: { bd_commande: 'CMD-297-20261023-AAAAAA', bd_offre: '297' } } } });
    const r2 = await envoyer({ id: 'evt_c2', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_1', description: 'BD personnelle — CMD-297-20261023-AAAAAA', metadata: {} } } });
    assert.equal(r1.body, 'Ignoré (BD personnelle).'); assert.equal(r2.body, 'Ignoré (BD personnelle).');
    assert.equal(relais.length, 0, 'aucun relais Make pour un paiement BD');
    const r3 = await envoyer({ id: 'evt_c3', type: 'payment_intent.succeeded', data: { object: { id: 'pi_2', amount: 30000, description: 'Coaching — Séance à l’unité', metadata: { formule: 'unite' } } } });
    assert.equal(r3.statusCode, 200); assert.equal(r3.body, 'OK');
    assert.equal(relais.length, 1, 'un paiement coaching est toujours relayé');
    assert.equal(JSON.parse(relais[0].corps).payment_intent_id, 'pi_2');
  } finally {
    process.env = sauve; globalThis.fetch = fetchOrig;
  }
});

test('Checkout : moyens de paiement dynamiques du compte (aucun type imposé), comptant intégral, description BD', async () => {
  const m = monde();
  const { commande } = await commandeConfirmee(m);
  const p = new URLSearchParams(m.appelsStripe[0].init.body);
  assert.ok(![...p.keys()].some((k) => k.startsWith('payment_method_types')), 'aucun payment_method_types : Stripe propose carte, Klarna, PayPal… selon l’éligibilité');
  assert.equal(p.get('mode'), 'payment', 'paiement unique, pas d’abonnement');
  assert.ok(![...p.keys()].some((k) => k.includes('subscription') || k.includes('installments')), 'aucun échéancier maison');
  assert.equal(p.get('payment_intent_data[description]'), `BD personnelle — ${commande}`);
});

// ---------------- 12. Robustesse : écritures conditionnelles, concurrence, pannes injectées ----------------
const lent = (panne) => magasinMemoire({ latence: 2, panne });
const fileDe = async (m) => (await Promise.all((await m.d.store.list('ob/')).map((k) => m.d.store.getJSON(k)))).filter(Boolean);
const adminReq = (corps) => req('POST', corps, { headers: { authorization: 'Bearer ' + ADMIN } });
// Panne unique : lève une erreur la première fois qu'une écriture vise une clé de ce préfixe.
function panneUnique(prefixe){
  let faite = false;
  return (op, k) => { if(!faite && op === 'set' && k.startsWith(prefixe)){ faite = true; throw new Error('panne_injectee'); } };
}

test('primitives : maj concurrentes sans perte ; creerSiNouveau n’admet qu’un gagnant', async () => {
  const s = lent();
  await Promise.all(Array.from({ length: 25 }, () => maj(s, 'compteur', (v) => ({ n: (v ? v.n : 0) + 1 }))));
  assert.equal((await s.getJSON('compteur')).n, 25);
  const gagnants = await Promise.all(Array.from({ length: 10 }, (_, i) => creerSiNouveau(s, 'unique', { i })));
  assert.equal(gagnants.filter(Boolean).length, 1);
});

test('adaptateur Netlify : onlyIfNew / onlyIfMatch transmis ; bibliothèque sans écriture conditionnelle → refus explicite', async () => {
  const appels = [];
  const faux = {
    async set(k, v, o){ appels.push(o); return { modified: !(o && o.onlyIfMatch === 'perime'), etag: '"e2"' }; },
    async getWithMetadata(){ return { data: { a: 1 }, etag: '"e1"' }; },
  };
  const a = adapter(faux);
  assert.deepEqual(await a.setJSONsi('k', {}, { nouveau: true }), { ok: true, etag: '"e2"' });
  assert.deepEqual(await a.setJSONsi('k', {}, { etag: 'perime' }), { ok: false, etag: '"e2"' });
  assert.deepEqual(appels, [{ onlyIfNew: true }, { onlyIfMatch: 'perime' }]);
  assert.deepEqual(await a.getJSONv('k'), { valeur: { a: 1 }, etag: '"e1"' });
  const ancien = adapter({ async set(){ return undefined; } });
  await assert.rejects(() => ancien.setJSONsi('k', {}, { nouveau: true }), /ecriture_conditionnelle_non_supportee/);
});

test('configuration : BD_LINK_SECRET exigé ; live fermé sans fournisseur de courriel', () => {
  assert.equal(lireConfig(env({ BD_LINK_SECRET: '' })).paiementsActifs, false);
  assert.equal(lireConfig(env({ BD_LINK_SECRET: 'court' })).paiementsActifs, false);
  const live = lireConfig(env({ BD_PAYMENTS_MODE: 'live', BD_PAYMENTS_LIVE_CONFIRMED: 'oui', BD_STRIPE_SECRET_KEY: 'sk_live_x', BD_STRIPE_PUBLISHABLE_KEY: 'pk_live_x', BD_MAIL_PROVIDER: 'brevo' }));
  assert.equal(live.paiementsActifs, false);
  assert.ok(live.raisonsInactif.some((r) => r.includes('fournisseur de courriel')));
  assert.equal(lireConfig(env()).recuStripe, false);
});

test('achat concurrent (même clé) : une commande, une session ; panne après l’index → reprise sur la même commande', async () => {
  const m = monde({ store: lent() });
  const corps = { action: 'commander', ...INTERET_OK, cle: cleAchat() };
  const rs = await Promise.all([1, 2, 3].map(() => handlerAchat(m.d)(req('POST', corps))));
  const refs = new Set();
  for(const r of rs){ if(r.status === 200) refs.add((await corpsDe(r)).reference); else assert.equal(r.status, 409); }
  assert.equal(refs.size, 1);
  assert.equal((await m.d.store.list('commandes/')).length, 1);
  assert.equal(m.sessions.length, 1, 'une seule session Stripe');
  const [ref] = refs;
  assert.equal((await m.d.store.getJSON('commandes/' + ref)).sessionsCheckout.length, 1);
  assert.equal((await m.d.store.getJSON('idx/email/' + sha(INTERET_OK.email))).commandes.length, 1);
  // panne à la création de la commande, après l'index de la clé d'achat : le nouvel essai la crée
  const m2 = monde({ store: magasinMemoire({ panne: panneUnique('commandes/') }) });
  const corps2 = { action: 'commander', ...INTERET_OK, cle: cleAchat() };
  assert.equal((await handlerAchat(m2.d)(req('POST', corps2))).status, 500, 'panne visible');
  assert.equal((await m2.d.store.list('commandes/')).length, 0);
  const r2 = await handlerAchat(m2.d)(req('POST', corps2));
  assert.equal(r2.status, 200);
  const index = (await m2.d.store.list('achat/')).length;
  assert.equal(index, 1);
  assert.equal((await m2.d.store.list('commandes/'))[0], 'commandes/' + (await corpsDe(r2)).reference);
});

test('webhook concurrent : même événement et événements frères simultanés → payée une fois, une confirmation', async () => {
  const m = monde({ store: lent() });
  const { commande, jetonPaiement } = await commandeConfirmee(m);
  await ouvrirCheckout(m, jetonPaiement);
  const s = sessionPayee(commande);
  const rs = await Promise.all([
    webhook(m, evenement('evt_x', 'checkout.session.completed', s)),
    webhook(m, evenement('evt_x', 'checkout.session.completed', s)),
    webhook(m, evenement('evt_y', 'checkout.session.async_payment_succeeded', s)),
  ]);
  assert.ok(rs.every((r) => r.status === 200));
  const c = await m.d.store.getJSON('commandes/' + commande);
  assert.equal(c.statut, 'payee');
  assert.equal(c.historique.filter((h) => h.evenement === 'paiement_constate').length, 1);
  assert.equal((await fileDe(m)).filter((x) => x.type === 'confirmation').length, 1);
});

test('webhook : panne entre « payée » et la mise en file, ou sur le marqueur → 500, la reprise Stripe complète sans doublon', async () => {
  for(const prefixe of ['ob/MSG-confirmation', 'evt/']){
    const m = monde({ store: magasinMemoire({ panne: panneUnique(prefixe) }) });
    const { commande, jetonPaiement } = await commandeConfirmee(m);
    await ouvrirCheckout(m, jetonPaiement);
    const ev = evenement('evt_panne', 'checkout.session.completed', sessionPayee(commande));
    const r1 = await webhook(m, ev);
    assert.equal(r1.status, 500, prefixe + ' : Stripe réessaiera');
    assert.equal(await m.d.store.getJSON('evt/evt_panne'), null, prefixe + ' : pas de marqueur');
    assert.equal((await m.d.store.getJSON('commandes/' + commande)).statut, 'payee');
    const r2 = await webhook(m, ev);
    assert.equal(r2.status, 200);
    assert.equal((await corpsDe(r2)).resultat, 'deja_paye', prefixe);
    assert.equal((await fileDe(m)).filter((x) => x.type === 'confirmation').length, 1, prefixe + ' : une confirmation');
    assert.equal((await corpsDe(await webhook(m, ev))).doublon, true);
  }
});

test('file : deux traitements simultanés → un seul envoi ; verrou d’un traitement interrompu repris après expiration', async () => {
  const m = monde({ store: lent() });
  await commandePayee(m);
  await Promise.all([executerFile({ ...m.d, travailleur: 'A' }), executerFile({ ...m.d, travailleur: 'B' })]);
  assert.equal(m.d.envoyeur.envoyes.length, 1);
  // traitement interrompu : message resté « en_cours » avec un verrou
  const m2 = monde();
  await commandePayee(m2);
  const [k] = await m2.d.store.list('ob/');
  await maj(m2.d.store, k, (it) => ({ ...it, statut: 'en_cours', verrou: { par: 'disparu', expire: m2.temps() + VERROU_MS } }));
  await executerFile(m2.d);
  assert.equal(m2.d.envoyeur.envoyes.length, 0, 'verrou valide respecté');
  m2.avancer(VERROU_MS + 1);
  await executerFile(m2.d);
  assert.equal(m2.d.envoyeur.envoyes.length, 1, 'repris après expiration');
});

test('file : envoi ambigu (délai dépassé) → reprise avec la même clé d’idempotence et le même lien, toujours valable', async () => {
  const essais = [];
  const ambigu = { nom: 'ambigu', disponible: true, async envoyer(msg){ essais.push(msg); if(essais.length === 1) throw new Error('delai_depasse'); return { id: 'f-1' }; } };
  const m = monde({ envoyeur: ambigu });
  await commandePayee(m);
  await executerFile(m.d);
  m.avancer(2 * 60e3);
  await executerFile(m.d);
  assert.equal(essais.length, 2);
  assert.equal(essais[0].idempotencyKey, essais[1].idempotencyKey);
  assert.match(essais[0].idempotencyKey, /^MSG-confirmation-/);
  assert.equal(essais[0].texte, essais[1].texte, 'même lien à la reprise');
  const jeton = essais[0].texte.match(/#cle=([A-Za-z0-9_-]{43})/)[1];
  assert.equal((await session(m, jeton)).r.status, 200, 'le lien du premier envoi reste valable');
  const c = await m.d.store.getJSON('commandes/' + (await fileDe(m))[0].commandeId);
  assert.equal(c.acces.utilisations, 1, 'la reprise n’a pas réinitialisé le lien');
});

test('file : accès révoqué avant l’envoi → message annulé, révocation conservée', async () => {
  const m = monde();
  const commande = await commandePayee(m);
  await handlerAdmin(m.d)(adminReq({ action: 'lien-acces', commande }));
  await handlerAdmin(m.d)(adminReq({ action: 'revoquer-acces', commande }));
  const bilan = await executerFile(m.d);
  assert.equal(bilan.annules, 1); assert.equal(m.d.envoyeur.envoyes.length, 0);
  assert.equal((await fileDe(m))[0].statut, 'annule');
  assert.equal((await m.d.store.getJSON('commandes/' + commande)).acces.revoque, true);
});

test('accès concurrent : jamais plus de 10 ouvertures d’un lien, même simultanées', async () => {
  const m = monde({ store: lent() });
  await commandePayee(m);
  const { jeton } = await lienDuMessage(m);
  const ouvrir = (i) => handlerAcces(m.d)(req('POST', { action: 'ouvrir', jeton }), { ip: '10.0.0.' + i });
  const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => ouvrir(i)));
  const ok = rs.filter((r) => r.status === 200).length;
  assert.ok(ok >= 1 && ok <= 10, 'ouvertures acceptées : ' + ok);
  const cmd = (await m.d.store.list('commandes/'))[0];
  assert.equal((await m.d.store.getJSON(cmd)).acces.utilisations, ok, 'chaque ouverture acceptée comptée une fois');
  let total = ok;
  for(let i = 0; i < 12; i++) if((await ouvrir(100 + i)).status === 200) total += 1;
  assert.equal(total, 10);
  assert.equal((await session(m, jeton)).r.status, 404);
});

test('retour de paiement concurrent : un seul accès direct ; envoi du questionnaire concurrent : un seul envoi', async () => {
  const m = monde({ store: lent() });
  const commande = await commandePayee(m, '891');
  const rs = await Promise.all(Array.from({ length: 5 }, () => handlerPaiement(m.d)(req('POST', { action: 'statut', sessionId: 'cs_test_SESSION0001ABCDEFGH' }))));
  assert.equal(rs.filter((r) => r.headers.get('set-cookie')).length, 1);
  const { jeton } = await lienDuMessage(m);
  const { cookie } = await session(m, jeton);
  const corps = { action: 'envoyer', valeurs: { q1: 'A', 'q2.__later': 'oui', 'q5.alt': ['Je préfère que nous les choisissions ensemble.'], accord_reponses: 'oui' } };
  const envois = await Promise.all([1, 2, 3].map(() => handlerQuestionnaire(m.d)(req('POST', corps, { cookie }))));
  const statuts = envois.map((r) => r.status).sort();
  assert.equal(statuts.filter((x) => x === 200).length, 1, 'statuts : ' + statuts);
  assert.ok(statuts.filter((x) => x !== 200).every((x) => x === 409));
  assert.equal((await fileDe(m)).filter((x) => x.dedup === 'alerte:questionnaire:' + commande).length, 1);
  assert.equal((await m.d.store.getJSON('commandes/' + commande)).statut, 'questionnaire_recu');
});

test('file (trois défauts relevés par Codex sur a5262a9) : panne à l’insertion, insertions simultanées, deux ouvriers', async () => {
  // 1. panne à la première écriture : la reprise crée bien le message (plus d'index séparé qui le masquerait)
  const s1 = magasinMemoire({ panne: panneUnique('ob/') });
  const msg = { type: 'confirmation', dedup: 'confirmation:CMD-X', commandeId: 'CMD-X', destinataire: 'acheteur' };
  await assert.rejects(() => mettreEnFile(s1, msg, 0), /panne_injectee/);
  assert.equal((await s1.list('ob/')).length, 0);
  assert.equal((await mettreEnFile(s1, msg, 0)).doublon, false);
  assert.equal((await s1.list('ob/')).length, 1, 'un message après la reprise');
  assert.equal((await mettreEnFile(s1, msg, 0)).doublon, true);
  // 2. deux insertions simultanées du même message : un seul message
  const s2 = lent();
  const rs = await Promise.all([mettreEnFile(s2, msg, 0), mettreEnFile(s2, msg, 0)]);
  assert.deepEqual(rs.map((r) => r.doublon).sort(), [false, true]);
  assert.equal((await s2.list('ob/')).length, 1);
  // 3. deux ouvriers simultanés : une seule capture
  const m = monde({ store: lent() });
  await commandePayee(m);
  const bilans = await Promise.all([executerFile({ ...m.d, travailleur: 'ouvrier-1' }), executerFile({ ...m.d, travailleur: 'ouvrier-2' })]);
  assert.equal(m.d.envoyeur.envoyes.length, 1);
  assert.equal(bilans[0].envoyes + bilans[1].envoyes, 1);
});

test('file : ouvrier A lent qui dépasse son bail, B reprend et envoie ; l’échec (ou le succès) tardif de A n’écrase rien', async () => {
  for(const issueA of ['echec', 'succes']){
    const m = monde();
    await commandePayee(m);
    const captureB = envoyeurCapture();
    const lentA = { nom: 'lent', disponible: true, async envoyer(){
      m.avancer(VERROU_MS + 1);                                   // A dépasse son bail
      await executerFile({ ...m.d, envoyeur: captureB, travailleur: 'B' });
      if(issueA === 'echec') throw new Error('delai_depasse');
      return { id: 'fournisseur-A' };
    } };
    const bilanA = await executerFile({ ...m.d, envoyeur: lentA, travailleur: 'A' });
    assert.equal(captureB.envoyes.length, 1, issueA);
    const [it] = await fileDe(m);
    assert.equal(it.statut, 'envoye', issueA + ' : le résultat de B reste');
    assert.equal(it.tentatives, 0, issueA);
    assert.equal(it.idFournisseur, 'cap-1', issueA + ' : identifiant fournisseur de B conservé');
    assert.equal(it.verrou, null, issueA);
    assert.equal(bilanA.bailsPerdus, 1, issueA);
    assert.equal(captureB.envoyes[0].idempotencyKey, it.id);
  }
});

test('liens : une ancienne confirmation reprise après une récupération ou un lien admin est annulée et n’invalide pas le nouveau lien', async () => {
  // a) confirmation en échec (à reprendre), puis récupération : la confirmation reprise est annulée
  const essais = [];
  let panne = true;
  const fournisseur = { nom: 'f', disponible: true, async envoyer(msg){ essais.push(msg); if(panne) throw new Error('refus_temporaire'); return { id: 'f-' + essais.length }; } };
  const m = monde({ envoyeur: fournisseur });
  const commande = await commandePayee(m);
  await executerFile(m.d);                                        // confirmation : échec, à reprendre
  const jetonConfirmation = essais[0].texte.match(/#cle=([A-Za-z0-9_-]{43})/)[1];
  await handlerAcces(m.d)(req('POST', { action: 'recuperer', email: INTERET_OK.email }));
  panne = false; m.avancer(2 * 60e3);
  await executerFile(m.d);
  const file = await fileDe(m);
  assert.equal(file.find((x) => x.type === 'confirmation').statut, 'annule', 'confirmation obsolète annulée');
  const lien = file.find((x) => x.type === 'nouveau-lien');
  assert.equal(lien.statut, 'envoye'); assert.equal(lien.generation, 2);
  const jetonRecup = essais.at(-1).texte.match(/#cle=([A-Za-z0-9_-]{43})/)[1];
  assert.notEqual(jetonRecup, jetonConfirmation);
  assert.equal((await session(m, jetonRecup)).r.status, 200, 'lien de récupération valable');
  assert.equal((await session(m, jetonConfirmation)).r.status, 404, 'ancien lien inactif');
  // b) lien admin, puis relance manuelle de l'ancien message de récupération : annulé, lien admin intact
  const admin = await corpsDe(await handlerAdmin(m.d)(adminReq({ action: 'lien-acces', commande })));
  const jetonAdmin = admin.lienAcces.split('#cle=')[1];
  await handlerAdmin(m.d)(adminReq({ action: 'relancer-envoi', id: lien.id }));
  const nbEssais = essais.length;
  await executerFile(m.d);
  assert.equal(essais.length, nbEssais, 'aucun envoi de l’ancien message');
  assert.equal((await fileDe(m)).find((x) => x.id === lien.id).statut, 'annule');
  assert.equal((await session(m, jetonAdmin)).r.status, 200, 'lien admin toujours valable');
  assert.equal((await session(m, jetonRecup)).r.status, 404);
  const c = await m.d.store.getJSON('commandes/' + commande);
  assert.equal(c.generationLien, 3); assert.equal(c.acces.source, 'admin');
});

test('webhook coaching : litige d’un paiement BD résolu par lecture Stripe (charge puis paiement) et non relayé ; coaching relayé ; doute → 500', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wh = require('../netlify/functions/stripe-webhook.js');
  const sauve = { ...process.env }; const fetchOrig = globalThis.fetch;
  const relais = []; const lectures = [];
  let stripeEnPanne = false;
  const objets = {
    'charges/ch_bdLITIGE01': { id: 'ch_bdLITIGE01', payment_intent: 'pi_bdLITIGE01', metadata: {}, description: null },
    'payment_intents/pi_bdLITIGE01': { id: 'pi_bdLITIGE01', metadata: { bd_commande: 'CMD-297-20261023-AAAAAA' } },
    'charges/ch_coachLIT01': { id: 'ch_coachLIT01', payment_intent: 'pi_coachLIT01', metadata: {}, description: 'Coaching — Séance à l’unité' },
    'payment_intents/pi_coachLIT01': { id: 'pi_coachLIT01', metadata: { formule: 'unite' } },
  };
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_coaching_test';
  process.env.MAKE_WEBHOOK_URL_TRANSACTION = 'https://make.example.invalid/hook';
  process.env.STRIPE_SECRET_KEY = 'sk_test_coaching_factice';
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if(u.startsWith('https://api.stripe.com/v1/')){
      lectures.push({ chemin: u.slice(26), methode: init.method, auth: init.headers.Authorization });
      if(stripeEnPanne) return new Response('{}', { status: 503 });
      const o = objets[u.slice(26)];
      return o ? new Response(JSON.stringify(o), { status: 200 }) : new Response('{}', { status: 404 });
    }
    relais.push({ url: u, corps: init.body }); return new Response('ok', { status: 200 });
  };
  const envoyer = async (ev) => {
    const brut = JSON.stringify(ev);
    return wh.handler({ httpMethod: 'POST', headers: { 'stripe-signature': signerPourTest(brut, 'whsec_coaching_test', Math.floor(Date.now() / 1000)) }, body: brut, isBase64Encoded: false });
  };
  const litige = (id, charge, pi = null) => ({ id, type: 'charge.dispute.created', data: { object: { id: 'dp_' + id, object: 'dispute', charge, payment_intent: pi, amount: 29700, metadata: {} } } });
  try{
    const r1 = await envoyer(litige('evt_l1', 'ch_bdLITIGE01'));
    assert.equal(r1.statusCode, 200); assert.equal(r1.body, 'Ignoré (BD personnelle).');
    assert.deepEqual(lectures.map((l) => l.chemin), ['charges/ch_bdLITIGE01', 'payment_intents/pi_bdLITIGE01']);
    assert.ok(lectures.every((l) => l.methode === 'GET' && l.auth === 'Bearer sk_test_coaching_factice'), 'lecture seule, clé du compte');
    assert.equal(relais.length, 0, 'litige BD jamais relayé vers Make');
    const r2 = await envoyer(litige('evt_l2', 'ch_coachLIT01'));
    assert.equal(r2.body, 'OK'); assert.equal(relais.length, 1, 'litige coaching relayé');
    stripeEnPanne = true;
    const r3 = await envoyer(litige('evt_l3', 'ch_bdLITIGE01'));
    assert.equal(r3.statusCode, 500, 'Stripe indisponible : non relayé, Stripe réessaiera');
    stripeEnPanne = false;
    delete process.env.STRIPE_SECRET_KEY;
    const r4 = await envoyer(litige('evt_l4', 'ch_coachLIT01'));
    assert.equal(r4.statusCode, 500, 'sans clé de lecture : on ne conclut pas');
    const r5 = await envoyer(litige('evt_l5', 'ch_x', null));
    assert.equal(r5.statusCode, 500);
    const r6 = await envoyer({ ...litige('evt_l6', null), data: { object: { id: 'dp_6', charge: { id: 'ch_exp', description: 'BD personnelle — CMD-297-20261023-AAAAAA' } } } });
    assert.equal(r6.body, 'Ignoré (BD personnelle).', 'charge déjà incluse dans l’événement');
    assert.equal(relais.length, 1);
  } finally {
    process.env = sauve; globalThis.fetch = fetchOrig;
  }
});

test('file : A termine pendant que B, qui a repris le message, envoie encore → le verrou de B reste intact', async () => {
  const m = monde();
  await commandePayee(m);
  let ouvrir; const porte = new Promise((r) => { ouvrir = r; });
  const captureB = envoyeurCapture();
  const lentB = { nom: 'lentB', disponible: true, async envoyer(msg){ await porte; return captureB.envoyer(msg); } };
  let travailB;
  const lentA = { nom: 'lentA', disponible: true, async envoyer(){
    m.avancer(VERROU_MS + 1);
    travailB = executerFile({ ...m.d, envoyeur: lentB, travailleur: 'B' });
    for(let i = 0; i < 200; i++){ const [x] = await fileDe(m); if(x.verrou && x.verrou.par === 'B') break; await new Promise((r) => setTimeout(r, 1)); }
    throw new Error('delai_depasse');
  } };
  await executerFile({ ...m.d, envoyeur: lentA, travailleur: 'A' });
  let [it] = await fileDe(m);
  assert.equal(it.statut, 'en_cours'); assert.equal(it.verrou.par, 'B', 'A n’a pas libéré le verrou de B');
  assert.equal(it.tentatives, 0, 'A n’a pas compté d’échec');
  ouvrir(); await travailB;
  [it] = await fileDe(m);
  assert.equal(it.statut, 'envoye'); assert.equal(captureB.envoyes.length, 1);
});

// ---------------- 16. Régressions relevées lors de la revue indépendante ----------------
test('achat : après erreur Stripe, prénom/nom/WhatsApp corrigés sont conservés sans changer commande ni session', async () => {
  const options = { stripeEchec: true };
  const m = monde(options);
  const corps = { action: 'commander', ...INTERET_OK, cle: cleAchat() };
  assert.equal((await handlerAchat(m.d)(req('POST', corps))).status, 502);
  const [cleCommande] = await m.d.store.list('commandes/');
  const avant = await m.d.store.getJSON(cleCommande);
  options.stripeEchec = false;
  const corrige = { ...corps, prenoms: 'Éloïse Marie', nom: 'D’Arc-Besson', whatsapp: '+262 692 00 00 01' };
  const reprise = await handlerAchat(m.d)(req('POST', corrige));
  assert.equal(reprise.status, 200);
  const reponse = await corpsDe(reprise);
  assert.equal(reponse.reference, avant.id);
  assert.equal(reponse.prenom, corrige.prenoms);
  const apres = await m.d.store.getJSON(cleCommande);
  assert.equal(apres.prenoms, corrige.prenoms);
  assert.equal(apres.nom, corrige.nom);
  assert.equal(apres.whatsapp, '+262692000001');
  assert.equal(apres.email, avant.email);
  assert.equal(apres.offre, avant.offre);
  assert.equal((await m.d.store.list('commandes/')).length, 1);
  assert.equal(m.sessions.length, 1);
  await webhook(m, evenement('evt_coord_paye', 'checkout.session.completed', sessionPayee(avant.id)));
  const interdit = await handlerAchat(m.d)(req('POST', { ...corrige, prenoms: 'Ne doit pas remplacer' }));
  assert.deepEqual([interdit.status, (await corpsDe(interdit)).erreur], [409, 'deja_paye']);
  assert.equal((await m.d.store.getJSON(cleCommande)).prenoms, corrige.prenoms);
});

test('retour : échec différé et expiration terminent l’attente ; événements tardifs sans régression après succès', async () => {
  for(const [type, etat, statutCommande] of [
    ['checkout.session.async_payment_failed', 'echoue', 'paiement_echoue'],
    ['checkout.session.expired', 'expire', 'checkout_expire'],
  ]){
    const m = monde();
    const corps = { action: 'commander', ...INTERET_OK, cle: cleAchat() };
    const achat = await corpsDe(await handlerAchat(m.d)(req('POST', corps)));
    const id = achat.reference; const sid = m.sessions[0];
    const nonPayee = sessionPayee(id, '297', { id: sid, payment_status: 'unpaid' });
    await webhook(m, evenement('evt_avant_' + etat, 'checkout.session.completed', nonPayee));
    await webhook(m, evenement('evt_fin_' + etat, type, nonPayee));
    const retour = await handlerPaiement(m.d)(req('POST', { action: 'statut', sessionId: sid }));
    assert.deepEqual(await corpsDe(retour), { statut: etat, achat: '/achat-bd?offre=297' });
    assert.equal(retour.headers.get('set-cookie'), null);
    assert.equal((await m.d.store.list('ob/')).length, 0, 'aucune confirmation de succès');
    assert.equal((await handlerAchat(m.d)(req('POST', corps))).status, 409, 'une session terminée ne se réutilise pas');
    await webhook(m, evenement('evt_attente_tardive_' + etat, 'checkout.session.completed', nonPayee));
    assert.equal((await m.d.store.getJSON('commandes/' + id)).statut, statutCommande);
    // Un paiement vérifié prime toujours sur un échec, même reçu dans le désordre.
    await webhook(m, evenement('evt_succes_' + etat, 'checkout.session.async_payment_succeeded', sessionPayee(id)));
    await webhook(m, evenement('evt_echec_tardif_' + etat, type, nonPayee));
    assert.equal((await m.d.store.getJSON('commandes/' + id)).statut, 'payee');
    const succes = await handlerPaiement(m.d)(req('POST', { action: 'statut', sessionId: sid }));
    assert.equal((await corpsDe(succes)).statut, 'paye');
    assert.ok(succes.headers.get('set-cookie'));
    const file = await Promise.all((await m.d.store.list('ob/')).map((k) => m.d.store.getJSON(k)));
    assert.equal(file.filter((x) => x.type === 'confirmation').length, 1);
  }
});

test('webhook : attente/échec/expiration d’une session non enregistrée ne changent pas la commande', async () => {
  for(const type of ['checkout.session.completed', 'checkout.session.async_payment_failed', 'checkout.session.expired']){
    const m = monde();
    const { commande } = await commandeConfirmee(m);
    const inconnue = sessionPayee(commande, '297', { id: 'cs_test_INCONNUE00000001', payment_status: 'unpaid' });
    const r = await webhook(m, evenement('evt_non_enregistree', type, inconnue));
    assert.equal((await corpsDe(r)).resultat, 'anomalie');
    assert.equal((await m.d.store.getJSON('commandes/' + commande)).statut, 'checkout_ouvert');
  }
});

test('page de retour : échec/expiration affichés avec reprise de la bonne offre, sans sondage supplémentaire', async () => {
  const code = fs.readFileSync(new URL('../assets/bd-paiement.js', import.meta.url), 'utf8');
  for(const statut of ['echoue', 'expire']){
    const titre = { textContent: '' };
    const aide = { textContent: '', liens: [], appendChild(n){ this.liens.push(n); } };
    const elements = {
      'bdq-nojs': { remove(){} },
      'bdp-attente': { hidden: false },
      'bdp-inconnu': { hidden: true, querySelector(s){ return s === '.bdq-title' ? titre : aide; } },
      'bdp-confirme': { hidden: true },
    };
    let requetes = 0; let sondages = 0;
    vm.runInNewContext(code, {
      document: { readyState: 'complete', getElementById(id){ return elements[id]; }, createElement(tag){ return { tag }; } },
      location: { pathname: '/paiement-bd-retour', search: '?session_id=cs_test_FICTIVE000001' },
      history: { replaceState(){} },
      URLSearchParams,
      fetch: async () => { requetes += 1; return { json: async () => ({ statut, achat: '/achat-bd?offre=891' }) }; },
      setTimeout(){ sondages += 1; },
    });
    await new Promise(setImmediate);
    assert.equal(requetes, 1);
    assert.equal(sondages, 0);
    assert.equal(elements['bdp-attente'].hidden, true);
    assert.equal(elements['bdp-confirme'].hidden, true);
    assert.equal(elements['bdp-inconnu'].hidden, false);
    assert.match(titre.textContent, statut === 'expire' ? /expiré/ : /pas abouti/);
    assert.match(aide.textContent, /Aucun achat n’est confirmé/);
    assert.equal(aide.liens[0].href, '/achat-bd?offre=891');
  }
});

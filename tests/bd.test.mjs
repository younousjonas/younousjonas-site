// Tests des fonctions bd-* : magasin en mémoire, Stripe intercepté, envoyeur de capture,
// horloge fixe. Aucun appel réseau, aucun courriel, aucune donnée réelle.
// Lancer : node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { lireConfig } from '../netlify/functions/bd-lib/config.mjs';
import { magasinMemoire, magasinAiguille, plan, contexteDeploiement } from '../netlify/functions/bd-lib/store.mjs';
import { envoyeurCapture, envoyeurAucun, ESSAIS_MAX } from '../netlify/functions/bd-lib/outbox.mjs';
import { signerPourTest } from '../netlify/functions/bd-lib/stripe.mjs';
import { QUESTIONNAIRES } from '../netlify/functions/bd-lib/questionnaires.mjs';
import { handlerInteret, handlerAdmin, handlerPaiement, handlerWebhook, handlerAcces, handlerQuestionnaire, executerFile } from '../netlify/functions/bd-lib/handlers.mjs';

const SITE = 'https://younousjonas.com';
const ADMIN = 'jeton-admin-de-test';
const WHSEC = 'whsec_secret_de_test';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function env(extra = {}){
  return { BD_PAYMENTS_ENABLED: 'true', BD_STRIPE_SECRET_KEY: 'sk_test_cle_factice', BD_STRIPE_PUBLISHABLE_KEY: 'pk_test_cle_factice', BD_STRIPE_WEBHOOK_SECRET: WHSEC, BD_ADMIN_TOKEN_SHA256: sha(ADMIN), URL: SITE, BD_ADMIN_EMAIL: 'admin@example.invalid', ...extra };
}

function monde(opts = {}){
  let t = Date.UTC(2026, 9, 23, 15, 0, 0);
  const appelsStripe = [];
  const journal = [];
  const d = {
    store: magasinMemoire(),
    cfg: lireConfig(opts.env || env()),
    now: () => t,
    envoyeur: opts.envoyeur || envoyeurCapture(),
    journal: (...a) => journal.push(a.join(' ')),
    fetchFn: async (url, init) => {
      appelsStripe.push({ url, init });
      if(opts.stripeEchec) return new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 });
      const n = appelsStripe.length;
      return new Response(JSON.stringify({ id: 'cs_test_SESSION' + String(n).padStart(4, '0') + 'ABCDEFGH', client_secret: 'cs_test_secret_client_' + n, livemode: false }), { status: 200 });
    },
  };
  return { d, avancer: (ms) => { t += ms; }, appelsStripe, journal, temps: () => t };
}

function req(method, corps, { cookie, origin = SITE, headers = {} } = {}){
  const h = { 'content-type': 'application/json', ...headers };
  if(origin) h.origin = origin;
  if(cookie) h.cookie = cookie;
  return new Request(SITE + '/.netlify/functions/x', { method, headers: h, body: corps === undefined ? undefined : (typeof corps === 'string' ? corps : JSON.stringify(corps)) });
}
const corpsDe = async (r) => r.json();
const cookieDe = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

const INTERET_OK = { offre: '297', prenoms: 'Test', nom: 'Synthétique', email: 'test.synthetique@example.invalid', whatsapp: '+262 692 00 00 00', declarationWhatsapp: true, consentement: true, projet: '' };

async function commandeConfirmee(m, offre = '297', email = INTERET_OK.email){
  const r1 = await handlerInteret(m.d)(req('POST', { ...INTERET_OK, offre, email }));
  const { reference } = await corpsDe(r1);
  const r2 = await handlerAdmin(m.d)(req('POST', { action: 'confirmer', interet: reference }, { headers: { authorization: 'Bearer ' + ADMIN } }));
  const b = await corpsDe(r2);
  return { commande: b.commande, jetonPaiement: b.lienPaiement.split('#t=')[1] };
}
function evenement(id, type, session){ return { id, type, livemode: false, data: { object: session } }; }
function sessionPayee(commande, offre = '297', extra = {}){
  const montant = offre === '297' ? 29700 : 89100;
  return { id: 'cs_test_SESSION0001ABCDEFGH', client_reference_id: commande, payment_status: 'paid', amount_total: montant, currency: 'eur', payment_intent: 'pi_test_1', metadata: { bd_commande: commande, bd_offre: offre }, ...extra };
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
  const { commande, jetonPaiement } = await commandeConfirmee(m, offre);
  await handlerPaiement(m.d)(req('POST', { action: 'session', jeton: jetonPaiement }));
  const r = await webhook(m, evenement('evt_paye_' + commande, 'checkout.session.completed', sessionPayee(commande, offre)));
  assert.equal((await corpsDe(r)).resultat, 'paye');
  return commande;
}
async function session(m, jeton){
  const r = await handlerAcces(m.d)(req('POST', { action: 'ouvrir', jeton }));
  return { r, cookie: cookieDe(r) };
}

// ---------------- 1. Demande d'intérêt ----------------
test('intérêt : contacts obligatoires, WhatsApp avec indicatif et déclaration, rien d’intime imposé', async () => {
  const m = monde();
  const r = await handlerInteret(m.d)(req('POST', { offre: '297' }));
  assert.equal(r.status, 422);
  assert.deepEqual((await corpsDe(r)).champs.sort(), ['consentement', 'declarationWhatsapp', 'email', 'nom', 'prenoms', 'whatsapp']);
  const sansIndicatif = await handlerInteret(m.d)(req('POST', { ...INTERET_OK, whatsapp: '0692000000' }));
  assert.deepEqual((await corpsDe(sansIndicatif)).champs, ['whatsapp']);
  const sansDeclaration = await handlerInteret(m.d)(req('POST', { ...INTERET_OK, declarationWhatsapp: false }));
  assert.deepEqual((await corpsDe(sansDeclaration)).champs, ['declarationWhatsapp']);
  const ok = await handlerInteret(m.d)(req('POST', INTERET_OK));      // projet vide accepté
  assert.equal(ok.status, 201);
  const ref = (await corpsDe(ok)).reference;
  assert.match(ref, /^INT-297-20261023-[A-Z2-9]{6}$/);
  const stocke = await m.d.store.getJSON('interets/' + ref);
  assert.equal(stocke.whatsapp, '+262692000000');
  assert.equal(stocke.nom, 'Synthétique');
});

test('intérêt : origine étrangère refusée, pot de miel neutre, limite de débit', async () => {
  const m = monde();
  assert.equal((await handlerInteret(m.d)(req('POST', INTERET_OK, { origin: 'https://exemple-hostile.invalid' }))).status, 403);
  assert.equal((await handlerInteret(m.d)(req('POST', INTERET_OK, { origin: null }))).status, 403);
  const pot = await handlerInteret(m.d)(req('POST', { ...INTERET_OK, siteweb: 'http://spam' }));
  assert.equal(pot.status, 201);
  assert.equal((await m.d.store.list('interets/')).length, 0);
  for(let i = 0; i < 9; i++) await handlerInteret(m.d)(req('POST', INTERET_OK));
  assert.equal((await handlerInteret(m.d)(req('POST', INTERET_OK))).status, 429);
});

// ---------------- 2. Administration ----------------
test('admin : jeton absent ou faux refusé ; confirmation crée la commande au prix serveur', async () => {
  const m = monde();
  assert.equal((await handlerAdmin(m.d)(req('POST', { action: 'lister' }))).status, 401);
  assert.equal((await handlerAdmin(m.d)(req('POST', { action: 'lister' }, { headers: { authorization: 'Bearer faux' } }))).status, 401);
  const sansConfig = monde({ env: env({ BD_ADMIN_TOKEN_SHA256: '' }) });
  assert.equal((await handlerAdmin(sansConfig.d)(req('POST', { action: 'lister' }, { headers: { authorization: 'Bearer ' + ADMIN } }))).status, 503);
  const { commande, jetonPaiement } = await commandeConfirmee(m, '891');
  const c = await m.d.store.getJSON('commandes/' + commande);
  assert.equal(c.montant, 89100); assert.equal(c.devise, 'eur'); assert.equal(c.statut, 'confirmee');
  assert.match(jetonPaiement, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(c).includes(jetonPaiement), 'le jeton de paiement n’est stocké que haché');
});

// ---------------- 3. Paiement intégré ----------------
test('paiement : désactivé par défaut, sans appel Stripe, sans secret dans la réponse', async () => {
  const m = monde({ env: env({ BD_PAYMENTS_ENABLED: '' }) });
  const { jetonPaiement } = await commandeConfirmee(m);
  const resume = await corpsDe(await handlerPaiement(m.d)(req('POST', { action: 'resume', jeton: jetonPaiement })));
  assert.equal(resume.paiementDisponible, false); assert.equal(resume.montant, '297,00 €');
  const r = await handlerPaiement(m.d)(req('POST', { action: 'session', jeton: jetonPaiement }));
  assert.equal(r.status, 503); assert.equal((await corpsDe(r)).erreur, 'paiement_indisponible');
  assert.equal(m.appelsStripe.length, 0);
  assert.ok(!m.journal.join(' ').includes('sk_test'), 'aucune clé dans les journaux');
});

test('paiement : mode live refusé par défaut, clé hors mode refusée', () => {
  assert.equal(lireConfig(env({ BD_PAYMENTS_MODE: 'live', BD_STRIPE_SECRET_KEY: 'sk_live_x', BD_STRIPE_PUBLISHABLE_KEY: 'pk_live_x' })).paiementsActifs, false);
  assert.equal(lireConfig(env({ BD_STRIPE_SECRET_KEY: 'sk_live_x' })).paiementsActifs, false);
  assert.equal(lireConfig(env({ BD_STRIPE_SECRET_KEY: '', STRIPE_SECRET_KEY: 'sk_test_coaching' })).paiementsActifs, false, 'les clés génériques du coaching ne sont jamais lues');
  assert.equal(lireConfig(env()).paiementsActifs, true);
});

test('paiement : session Embedded Checkout créée avec le montant serveur et ui_mode=embedded_page', async () => {
  const m = monde();
  const { commande, jetonPaiement } = await commandeConfirmee(m, '891');
  const r = await handlerPaiement(m.d)(req('POST', { action: 'session', jeton: jetonPaiement, montant: 1 }));
  assert.equal(r.status, 200);
  const b = await corpsDe(r);
  assert.equal(b.publishableKey, 'pk_test_cle_factice'); assert.ok(b.clientSecret);
  assert.ok(!JSON.stringify(b).includes('sk_test'), 'jamais la clé secrète côté client');
  const { url, init } = m.appelsStripe[0];
  assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(init.headers['stripe-version'], '2026-03-25.dahlia');
  assert.equal(init.headers['idempotency-key'], `bd-cs-${commande}-1`);
  const p = new URLSearchParams(init.body);
  assert.equal(p.get('ui_mode'), 'embedded_page');
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '89100');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(p.get('client_reference_id'), commande);
  assert.equal(p.get('metadata[bd_offre]'), '891');
  assert.equal(p.get('return_url'), SITE + '/paiement-bd-retour?session_id={CHECKOUT_SESSION_ID}');
});

test('paiement : jeton invalide ou expiré → réponse générique ; erreur Stripe sans détail', async () => {
  const m = monde();
  const { jetonPaiement } = await commandeConfirmee(m);
  const invalide = await handlerPaiement(m.d)(req('POST', { action: 'resume', jeton: 'x'.repeat(43) }));
  assert.equal(invalide.status, 404); assert.equal((await corpsDe(invalide)).erreur, 'lien_invalide');
  m.avancer(15 * 24 * 3600e3);
  assert.equal((await handlerPaiement(m.d)(req('POST', { action: 'resume', jeton: jetonPaiement }))).status, 404);
  const m2 = monde({ stripeEchec: true });
  const c2 = await commandeConfirmee(m2);
  const r = await handlerPaiement(m2.d)(req('POST', { action: 'session', jeton: c2.jetonPaiement }));
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
  assert.equal((await m.d.store.getJSON('commandes/' + commande)).statut, 'confirmee');
});

test('webhook : paiement réel → commande payée, une seule confirmation (idempotence)', async () => {
  const m = monde();
  const { commande } = await commandeConfirmee(m);
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
  const { commande } = await commandeConfirmee(m);
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
  ]){
    const m = monde();
    const { commande } = await commandeConfirmee(m);
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
  const commande = await commandePayee(m);
  const second = await webhook(m, evenement('evt_double', 'checkout.session.completed', sessionPayee(commande, '297', { id: 'cs_test_AUTRESESSION0002' })));
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
  for(const attendu of ['Bonjour Test', 'Mon parcours en BD', '297,00 €', commande, 'Prochaine étape', SITE + '/mon-album#cle=', 'reçu']) assert.ok(msg.texte.includes(attendu), attendu);
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
  const { commande, jetonPaiement } = await commandeConfirmee(m);
  await handlerPaiement(m.d)(req('POST', { action: 'session', jeton: jetonPaiement }));
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
  const { commande: b, jetonPaiement } = await commandeConfirmee(m, '297', 'autre@example.invalid');
  await handlerPaiement(m.d)(req('POST', { action: 'session', jeton: jetonPaiement }));
  await webhook(m, evenement('evt_b', 'checkout.session.completed', sessionPayee(b, '297', { id: 'cs_test_SESSIONBBBB0002' })));
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
test('site : plus aucun questionnaire ni ancien formulaire en page publique ; redirections et blocages en place', () => {
  const racine = new URL('../', import.meta.url);
  const pages = fs.readdirSync(racine).filter((f) => f.endsWith('.html'));
  assert.ok(!pages.includes('demande-mon-parcours-en-bd.html') && !pages.includes('demande-mon-histoire-en-bd.html'));
  for(const p of pages){
    const t = fs.readFileSync(new URL(p, racine), 'utf8');
    assert.ok(!t.includes('biographies-parcours-297') && !t.includes('biographies-histoire-891'), p + ' : ancien formulaire');
    assert.ok(!t.includes('Quels moments ont infléchi votre histoire'), p + ' : texte de questionnaire');
  }
  assert.ok(!fs.existsSync(new URL('assets/bd-questionnaire.js', racine)));
  const red = fs.readFileSync(new URL('_redirects', racine), 'utf8');
  for(const r of ['/demande-mon-parcours-en-bd /demande-bd.html?offre=297 301!', '/demande-mon-histoire-en-bd.html /demande-bd.html?offre=891 301!', '/netlify/* /404 404!', '/node_modules/* /404 404!', '/tests/* /404 404!']) assert.ok(red.includes(r), r);
  const offres = fs.readFileSync(new URL('bd-personnelle.html', racine), 'utf8');
  assert.ok(!/huit semaines|8 semaines/.test(offres));
  assert.ok(offres.includes('demande-bd.html?offre=297') && offres.includes('demande-bd.html?offre=891'));
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
  const { commande, jetonPaiement } = await commandeConfirmee(m);
  await handlerPaiement(m.d)(req('POST', { action: 'session', jeton: jetonPaiement }));
  const p = new URLSearchParams(m.appelsStripe[0].init.body);
  assert.ok(![...p.keys()].some((k) => k.startsWith('payment_method_types')), 'aucun payment_method_types : Stripe propose carte, Klarna, PayPal… selon l’éligibilité');
  assert.equal(p.get('mode'), 'payment', 'paiement unique, pas d’abonnement');
  assert.ok(![...p.keys()].some((k) => k.includes('subscription') || k.includes('installments')), 'aucun échéancier maison');
  assert.equal(p.get('payment_intent_data[description]'), `BD personnelle — ${commande}`);
});

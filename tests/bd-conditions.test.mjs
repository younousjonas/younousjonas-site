// Recette locale du raccordement contractuel : magasin en mémoire, Stripe simulé.
// Aucun envoi de courriel, aucune clé réelle et aucun accès réseau.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { CONDITIONS } from '../netlify/functions/bd-lib/conditions.mjs';
import { lireConfig } from '../netlify/functions/bd-lib/config.mjs';
import { magasinMemoire } from '../netlify/functions/bd-lib/store.mjs';
import { handlerAchat, composerMessage } from '../netlify/functions/bd-lib/handlers.mjs';

const SITE = 'https://younousjonas.com';
const sha = (texte) => crypto.createHash('sha256').update(texte).digest('hex');
const CORPS = {
  action: 'commander', offre: '297', cle: 'achat-conditions-synthetiques-00001',
  prenoms: 'Test', nom: 'Synthétique', email: 'conditions@example.invalid',
  whatsapp: '+262692000000', declarationWhatsapp: true, consentement: true,
  conditionsAcceptees: true, versionConditions: CONDITIONS.version,
};
function monde(){
  let temps = Date.UTC(2026, 9, 24, 12, 34, 56);
  const appels = [];
  const d = {
    store: magasinMemoire(), now: () => temps, journal: () => {},
    cfg: lireConfig({ BD_PAYMENTS_ENABLED: 'true', BD_STRIPE_SECRET_KEY: 'sk_test_factice', BD_STRIPE_PUBLISHABLE_KEY: 'pk_test_factice', BD_STRIPE_WEBHOOK_SECRET: 'whsec_factice', BD_STRIPE_PAYMENT_METHOD_CONFIGURATION: 'pmc_test', BD_LINK_SECRET: 'lien-factice-0123456789abcdefghijklmnop', URL: SITE }),
    fetchFn: async (url, init) => {
      appels.push({ url, init });
      return new Response(JSON.stringify({ id: 'cs_test_CONDITIONS0001', client_secret: 'secret_client_factice', livemode: false }), { status: 200 });
    },
  };
  return { d, appels, avancer: (ms) => { temps += ms; } };
}
const post = (extra = {}) => new Request(SITE + '/.netlify/functions/bd-achat', { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ ...CORPS, ...extra }) });
async function aucuneCommande(m){
  assert.equal(m.appels.length, 0, 'Stripe ne doit pas être appelé');
  assert.deepEqual(await m.d.store.list('commandes/'), []);
  assert.deepEqual(await m.d.store.list('achat/'), []);
}

test('CGV : acceptation absente, fausse ou chaîne de caractères refusée avant commande et Stripe', async () => {
  const m = monde();
  for(const valeur of [undefined, false, 'true']){
    const r = await handlerAchat(m.d)(post({ conditionsAcceptees: valeur }));
    assert.equal(r.status, 422);
    assert.deepEqual((await r.json()).champs, ['conditionsAcceptees']);
  }
  await aucuneCommande(m);
});

test('CGV : version absente ou fournie faussement par le client refusée sans commande', async () => {
  const m = monde();
  for(const version of [undefined, 'version-fausse', { version: CONDITIONS.version }]){
    const r = await handlerAchat(m.d)(post({ versionConditions: version }));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).erreur, 'conditions_actualisees');
  }
  await aucuneCommande(m);
});

test('CGV : copie et horodatage serveur conservés pendant une reprise ; métadonnées Stripe identiques', async () => {
  const m = monde();
  const dateServeur = new Date(m.d.now()).toISOString();
  const r = await handlerAchat(m.d)(post({ offre: '891', conditionsAccepteesLe: '2000-01-01', conditions: { texte: 'texte injecté' }, commencementAnticipe: true }));
  assert.equal(r.status, 200);
  const reference = (await r.json()).reference;
  const avant = await m.d.store.getJSON('commandes/' + reference);
  assert.equal(avant.conditions.accepteesLe, dateServeur);
  assert.equal(avant.conditions.dateVersion, CONDITIONS.dateVersion);
  assert.equal(avant.conditions.texte, CONDITIONS.texte);
  assert.equal(sha(avant.conditions.texte), avant.conditions.empreinteSha256);
  assert.equal(avant.commencementAnticipe, undefined, 'aucun commencement anticipé déduit de l’achat');
  m.avancer(60_000);
  const reprise = await handlerAchat(m.d)(post({ offre: '891', prenoms: 'Prénom corrigé' }));
  assert.equal(reprise.status, 200);
  assert.equal((await reprise.json()).reference, reference);
  const apres = await m.d.store.getJSON('commandes/' + reference);
  assert.deepEqual(apres.conditions, avant.conditions, 'ni nouvelle version ni nouvel horodatage lors de la reprise');
  assert.equal(apres.historique.filter((h) => h.evenement === 'conditions_acceptees').length, 1);
  for(const appel of m.appels){
    const p = new URLSearchParams(appel.init.body);
    for(const prefixe of ['metadata', 'payment_intent_data[metadata]']){
      assert.equal(p.get(prefixe + '[bd_conditions_version]'), CONDITIONS.version);
      assert.equal(p.get(prefixe + '[bd_conditions_date]'), CONDITIONS.dateVersion);
      assert.equal(p.get(prefixe + '[bd_conditions_acceptees_le]'), dateServeur);
      assert.equal(p.get(prefixe + '[bd_conditions_sha256]'), CONDITIONS.empreinteSha256);
    }
  }
});

test('CGV : ancienne clé sans preuve de version ne reçoit pas une acceptation rétroactive', async () => {
  const m = monde();
  await m.d.store.setJSON('achat/' + sha(CORPS.cle), { commande: 'CMD-ANCIENNE', offre: '297', email: sha(CORPS.email), creeLe: '2026-10-23T12:00:00.000Z' });
  const r = await handlerAchat(m.d)(post());
  assert.equal(r.status, 409);
  assert.equal((await r.json()).erreur, 'conditions_actualisees');
  assert.deepEqual(await m.d.store.list('commandes/'), []);
  assert.equal(m.appels.length, 0);
});

test('CGV : confirmation contient le texte intégral enregistré, même après un changement de version', () => {
  const cfg = monde().d.cfg;
  const ancienne = { ...CONDITIONS, version: 'bd-version-anterieure', texte: 'COPIE ANCIENNE CONSERVÉE\nToutes les conditions convenues.\n', accepteesLe: '2026-10-23T12:00:00.000Z' };
  ancienne.empreinteSha256 = sha(ancienne.texte);
  const c = { id: 'CMD-TEST', offre: '297', prenoms: 'Test', email: CORPS.email, conditions: ancienne };
  const message = composerMessage({ type: 'confirmation' }, c, SITE + '/mon-album#cle=test', cfg);
  assert.ok(message.texte.endsWith(ancienne.texte));
  assert.ok(message.texte.includes('Version acceptée : bd-version-anterieure'));
  assert.ok(message.texte.includes(ancienne.accepteesLe));
  assert.ok(message.texte.includes(ancienne.empreinteSha256));
  assert.ok(!message.texte.includes(CONDITIONS.version), 'le texte courant ne remplace jamais le texte accepté');
  delete c.conditions;
  assert.ok(!composerMessage({ type: 'confirmation' }, c, 'lien', cfg).texte.includes('Version acceptée'), 'aucune preuve inventée pour un ancien dossier');
});

test('CGV : version préparatoire bloque le live malgré une configuration paiement active', async () => {
  assert.equal(CONDITIONS.statut, 'preparatoire');
  const m = monde();
  m.d.cfg.mode = 'live'; m.d.cfg.paiementsActifs = true;
  const g = await handlerAchat(m.d)(new Request(SITE + '/.netlify/functions/bd-achat?offre=297'));
  const b = await g.json();
  assert.equal(b.paiementDisponible, false);
  assert.equal(b.conditions.version, CONDITIONS.version);
  assert.equal(b.conditions.statut, 'preparatoire');
  assert.equal(b.conditions.texte, undefined, 'le descriptif ne transmet que les métadonnées publiques');
  assert.equal((await handlerAchat(m.d)(post())).status, 503);
  assert.equal(m.d.store._map.size, 0, 'aucune collecte lorsque le live est fermé');
  assert.equal(m.appels.length, 0);
});

test('CGV : copie téléchargeable identique au texte serveur et sans sources privées du chantier', () => {
  const texte = fs.readFileSync(new URL('..' + CONDITIONS.url, import.meta.url), 'utf8');
  assert.equal(texte, CONDITIONS.texte);
  assert.equal(sha(texte), CONDITIONS.empreinteSha256);
  assert.equal((texte.match(/^\d+\. /gm) || []).length, 15);
  assert.ok(texte.includes('+262 692 25 50 60'));
  assert.ok(texte.includes('https://younousjonas.com/retractation-bd'));
  assert.ok(!/drive\.google\.com|mail\.google\.com|19a1a45c47b0dfbd/.test(texte));
});

function navigateur(fetchFn){
  const elements = new Map();
  function element(id){
    if(!elements.has(id)) elements.set(id, { hidden: false, value: '', checked: false, disabled: false, textContent: '', innerHTML: '', className: '', classList: { add(){}, remove(){} }, appendChild(){}, focus(){}, remove(){}, addEventListener(type, fn){ this[type] = fn; } });
    return elements.get(id);
  }
  const form = element('bda-form');
  for(const champ of ['prenoms','nom','email','whatsapp','siteweb','declarationWhatsapp','consentement','conditionsAcceptees']) form[champ] = element('champ-' + champ);
  for(const champ of ['prenoms','nom','email','whatsapp']) form[champ].value = CORPS[champ];
  form.declarationWhatsapp.checked = form.consentement.checked = true;
  form.querySelector = () => element('bouton');
  const context = vm.createContext({
    document: { readyState: 'complete', getElementById: element, querySelector: () => null, querySelectorAll: () => [], createElement: () => element('nouvel-element'), createTextNode: (s) => s },
    window: { crypto: crypto.webcrypto }, location: { href: SITE + '/achat-bd?offre=297', search: '?offre=297', hash: '' },
    history: { replaceState(){} }, fetch: fetchFn, URL, URLSearchParams, Uint8Array, btoa,
  });
  vm.runInContext(fs.readFileSync(new URL('../assets/bd-achat.js', import.meta.url), 'utf8'), context);
  return { form, element };
}
const repos = () => new Promise((resolve) => setImmediate(resolve));

test('interface : acceptation distincte exigée ; changement de version décoche la case sans nouvelle commande automatique', async () => {
  const posts = [];
  let version = CONDITIONS.version;
  const n = navigateur(async (url, init = {}) => {
    if(init.method === 'POST'){
      posts.push(JSON.parse(init.body)); version = 'bd-nouvelle-version';
      return new Response(JSON.stringify({ erreur: 'conditions_actualisees' }), { status: 409 });
    }
    return new Response(JSON.stringify({ libelle: 'Album', montant: '297,00 €', paiementDisponible: true, conditions: { ...CONDITIONS, texte: undefined, version } }), { status: 200 });
  });
  await repos();
  n.form.submit({ preventDefault(){} });
  assert.equal(posts.length, 0, 'une acceptation confidentialité seule ne suffit pas');
  n.form.conditionsAcceptees.checked = true;
  n.form.submit({ preventDefault(){} });
  await repos(); await repos();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].versionConditions, CONDITIONS.version);
  assert.equal(posts[0].conditionsAcceptees, true);
  assert.equal(n.form.conditionsAcceptees.checked, false);
  assert.ok(n.element('bda-conditions-version').textContent.includes('bd-nouvelle-version'));
  n.form.submit({ preventDefault(){} });
  assert.equal(posts.length, 1, 'la nouvelle version doit être acceptée explicitement');
});

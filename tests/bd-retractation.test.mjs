// Rétractation : magasin privé en mémoire, fournisseur intercepté, aucun réseau ni client réel.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { lireConfig } from '../netlify/functions/bd-lib/config.mjs';
import { magasinMemoire } from '../netlify/functions/bd-lib/store.mjs';
import { nouveauJeton, hacher } from '../netlify/functions/bd-lib/util.mjs';
import { envoyeurAucun, envoyeurCapture, envoyeurMake, mettreEnFile } from '../netlify/functions/bd-lib/outbox.mjs';
import { executerFile } from '../netlify/functions/bd-lib/handlers.mjs';
import { DECLARATION_RETRACTATION, handlerRetractation } from '../netlify/functions/bd-lib/retractation.mjs';

const SITE = 'https://younousjonas.com';
const DONNEES = {
  action: 'declarer', confirmation: true, prenoms: 'Essai', nom: 'Synthétique',
  email: 'declarant@example.invalid', referenceCommande: 'CMD-297-20261024-ESSAI', elementsCommande: '', siteweb: '',
};
const corps = (extra = {}) => ({ ...DONNEES, cle: nouveauJeton(), ...extra });
function monde({ store = magasinMemoire(), envoyeur = envoyeurCapture() } = {}){
  let maintenant = Date.UTC(2026, 9, 24, 8, 30, 0);
  const journaux = [];
  return {
    d: { store, envoyeur, cfg: lireConfig({ BD_SITE_URL: SITE, BD_ADMIN_EMAIL: 'admin@example.invalid', BD_PAYMENTS_ENABLED: 'false' }),
      now: () => maintenant, journal: (...args) => journaux.push(args),
      fetchFn: async () => { throw new Error('Stripe ne doit jamais être appelé'); } },
    avancer: (ms) => { maintenant += ms; }, journaux,
  };
}
function requete(c, { method = 'POST', origin = SITE, type = 'application/json' } = {}){
  const headers = { 'content-type': type };
  if(origin) headers.origin = origin;
  return new Request(SITE + '/.netlify/functions/bd-retractation', {
    method, headers, ...(method === 'GET' ? {} : { body: typeof c === 'string' ? c : JSON.stringify(c) }),
  });
}
const deposer = (m, c, opts = {}) => handlerRetractation(m.d)(requete(c, opts), { ip: opts.ip || '192.0.2.1' });
async function lignes(store, prefixe){ return Promise.all((await store.list(prefixe)).map((k) => store.getJSON(k))); }

test('dépôt sans connexion ni paiement ouvert : reçu complet et horodaté, deux notifications, aucune mutation de commande', async () => {
  const m = monde();
  const commande = { id: DONNEES.referenceCommande, statut: 'paye', secret: 'contenu privé synthétique' };
  await m.d.store.setJSON('commandes/' + commande.id, commande);
  const c = corps();
  const r = await deposer(m, c);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('set-cookie'), null);
  const b = await r.json();
  const [declaration] = await lignes(m.d.store, 'retractations/');
  assert.equal(declaration.recueLe, '2026-10-24T08:30:00.000Z');
  assert.equal(declaration.id, b.reference);
  assert.equal(declaration.notificationsPreparees, true);
  for(const valeur of [DECLARATION_RETRACTATION, c.prenoms, c.nom, c.email, c.referenceCommande, declaration.recueLe]) assert.ok(b.accuse.includes(valeur));
  assert.ok(b.accuse.includes('La Réunion'));
  assert.ok(b.accuse.includes('12:30:00'), 'heure locale de transmission');
  assert.equal(declaration.cleEmpreinte, hacher(c.cle));
  assert.ok(!JSON.stringify(declaration).includes(c.cle), 'clé brute jamais stockée');
  const messages = m.d.envoyeur.envoyes;
  assert.equal(messages.length, 2);
  assert.equal(messages.find((x) => x.to === c.email).texte, b.accuse);
  assert.match(messages.find((x) => x.to === 'admin@example.invalid').texte, /Identité et contrat à vérifier/);
  assert.ok(messages.every((x) => x.liens === false));
  assert.deepEqual(await m.d.store.getJSON('commandes/' + commande.id), commande);
  assert.ok(!b.accuse.includes(commande.secret));
});

test('des indications suffisent sans référence ni motif ; email choisi distinct de la commande autorisé', async () => {
  const m = monde();
  const c = corps({ referenceCommande: '', elementsCommande: 'Album Mon parcours en BD, commandé vers le 20 octobre.\nAdresse de commande : autre@example.invalid.' });
  const r = await deposer(m, c);
  assert.equal(r.status, 200);
  assert.ok((await r.json()).accuse.includes(c.elementsCommande));
  assert.equal((await lignes(m.d.store, 'retractations/'))[0].email, c.email);
});

test('reprises simultanées : une déclaration, date conservée et exactement deux envois', async () => {
  const m = monde({ store: magasinMemoire({ latence: 1 }) });
  const c = corps();
  const rs = await Promise.all(Array.from({ length: 4 }, () => deposer(m, c)));
  assert.ok(rs.every((r) => r.status === 200));
  const bs = await Promise.all(rs.map((r) => r.json()));
  assert.equal(new Set(bs.map((b) => b.reference)).size, 1);
  assert.equal((await lignes(m.d.store, 'retractations/')).length, 1);
  assert.equal((await lignes(m.d.store, 'ob/')).length, 2);
  assert.equal(m.d.envoyeur.envoyes.length, 2);
  m.avancer(3600e3);
  const reprise = await (await deposer(m, c)).json();
  assert.equal(reprise.accuse, bs[0].accuse, 'horodatage et contenu initiaux conservés');
  await executerFile(m.d);
  assert.equal(m.d.envoyeur.envoyes.length, 2);
});

test('même clé avec contenu différent : aucun écrasement ni révélation de la déclaration initiale', async () => {
  const m = monde();
  const c = corps({ elementsCommande: 'Détail privé du premier dépôt' });
  await deposer(m, c);
  const avant = await lignes(m.d.store, 'retractations/');
  for(const changement of [{ email: 'autre@example.invalid' }, { nom: 'Autre' }, { elementsCommande: 'Nouveau texte' }]){
    const r = await deposer(m, { ...c, ...changement });
    assert.equal(r.status, 409);
    const texte = await r.text();
    assert.ok(!texte.includes(c.email));
    assert.ok(!texte.includes(c.elementsCommande));
    assert.ok(!texte.includes(avant[0].id));
  }
  assert.deepEqual(await lignes(m.d.store, 'retractations/'), avant);
  assert.equal(m.d.envoyeur.envoyes.length, 2);
});

test('aucune lecture des commandes par email/référence ; pas d’action de consultation publique', async () => {
  const store = magasinMemoire();
  const get = store.getJSON.bind(store);
  store.getJSON = async (k) => { assert.ok(!k.startsWith('commandes/'), 'aucune recherche de commande'); return get(k); };
  const m = monde({ store });
  const c = corps();
  const r = await deposer(m, c);
  assert.equal(r.status, 200);
  assert.equal((await deposer(m, c, { method: 'GET' })).status, 405);
  assert.equal((await deposer(m, { ...c, action: 'consulter' })).status, 422);
  const seconde = await (await deposer(m, { ...c, cle: nouveauJeton() })).json();
  assert.notEqual(seconde.reference, (await r.json()).reference, 'pas de rapprochement public par coordonnées');
});

test('validation : origine, JSON, taille, pot de miel, confirmation et champs bornés', async () => {
  const m = monde();
  const c = corps();
  assert.equal((await deposer(m, c, { origin: 'https://etranger.invalid' })).status, 403);
  assert.equal((await deposer(m, c, { origin: null })).status, 403);
  assert.equal((await deposer(m, c, { type: 'text/plain' })).status, 400);
  assert.equal((await deposer(m, '{')).status, 400);
  assert.equal((await deposer(m, { ...c, inutilise: 'x'.repeat(8000) })).status, 400);
  assert.equal((await deposer(m, { ...c, siteweb: 'https://spam.invalid' })).status, 400);
  for(const changement of [
    { prenoms: '' }, { nom: ['nom'] }, { nom: 'a'.repeat(121) }, { email: 'invalide' },
    { email: 'essai@example.invalid\r\nBcc: adresse@example.invalid' }, { prenoms: 'Essai\nAutre' },
    { referenceCommande: '', elementsCommande: '' }, { elementsCommande: 'x'.repeat(1001) },
    { elementsCommande: 'texte\u0000' }, { confirmation: false }, { confirmation: 'true' }, { cle: 'facile' },
  ]) assert.equal((await deposer(m, { ...c, ...changement })).status, 422, JSON.stringify(changement));
  assert.equal((await deposer(m, [])).status, 422);
  assert.equal((await lignes(m.d.store, 'retractations/')).length, 0);
  assert.equal(m.d.envoyeur.envoyes.length, 0);
});

test('limites par adresse et connexion ; les reprises d’un dépôt acquis ne consomment pas de quota', async () => {
  const m = monde();
  const premiere = corps();
  assert.equal((await deposer(m, premiere)).status, 200);
  for(let i = 0; i < 4; i++) assert.equal((await deposer(m, corps())).status, 200);
  const limite = await deposer(m, corps());
  assert.equal(limite.status, 429);
  assert.match((await limite.json()).message, /younousjonas@gmail\.com/);
  for(let i = 0; i < 12; i++) assert.equal((await deposer(m, premiere)).status, 200);
  for(let i = 0; i < 4; i++) assert.equal((await deposer(m, corps({ email: `autre${i}@example.invalid` }))).status, 200);
  assert.equal((await deposer(m, corps({ email: 'encore@example.invalid' }))).status, 429);
  assert.equal((await lignes(m.d.store, 'retractations/')).length, 9);
});

test('panne avant écriture durable : pas de succès, pas de notification ni fausse référence', async () => {
  const store = magasinMemoire({ panne: (op, k) => { if(k.startsWith('retractations/')) throw new Error('panne disque synthétique'); } });
  const m = monde({ store });
  const r = await deposer(m, corps());
  assert.equal(r.status, 500);
  assert.equal((await r.json()).ok, undefined);
  assert.equal((await lignes(store, 'retractations/')).length, 0);
  assert.equal((await lignes(store, 'ob/')).length, 0);
  assert.equal(m.d.envoyeur.envoyes.length, 0);
});

test('absence de confirmation de lecture après écriture : erreur puis reprise de la même déclaration', async () => {
  const store = magasinMemoire();
  const get = store.getJSON.bind(store);
  let lectureCachee = true;
  store.getJSON = async (k) => lectureCachee && k.startsWith('retractations/') ? null : get(k);
  const m = monde({ store });
  const c = corps();
  assert.equal((await deposer(m, c)).status, 500);
  assert.equal(m.d.envoyeur.envoyes.length, 0);
  lectureCachee = false;
  m.avancer(120e3);
  const reprise = await (await deposer(m, c)).json();
  assert.equal(reprise.recueLe, '2026-10-24T08:30:00.000Z');
  assert.equal((await lignes(store, 'retractations/')).length, 1);
});

test('interruption après dépôt et pendant mise en file : succès durable et réparation automatique sans reprise navigateur', async () => {
  let interrompre = true;
  const store = magasinMemoire({ panne: (op, k) => { if(interrompre && k.startsWith('ob/MSG-retractation-alerte-')) throw new Error('mise en file interrompue'); } });
  const m = monde({ store });
  const r = await deposer(m, corps());
  assert.equal(r.status, 200);
  assert.equal((await lignes(store, 'retractations/'))[0].notificationsPreparees, false);
  assert.equal((await lignes(store, 'ob/')).length, 1);
  interrompre = false;
  m.avancer(900e3);
  await executerFile(m.d);
  assert.equal((await lignes(store, 'retractations/'))[0].notificationsPreparees, true);
  assert.equal((await lignes(store, 'ob/')).length, 2);
  assert.equal(m.d.envoyeur.envoyes.length, 2);
  await executerFile(m.d);
  assert.equal(m.d.envoyeur.envoyes.length, 2);
});

test('Make sans accusé confirmé : dépôt acquis et envois repris avec les mêmes clés', async () => {
  let panne = true;
  const appels = [];
  const envoyeur = envoyeurMake({ url: 'https://hook.eu1.make.com/test', cle: 'cle-factice', mode: 'test', fetchFn: async (url, init) => {
    const message = JSON.parse(init.body); appels.push(message);
    return new Response(panne ? 'Accepted' : JSON.stringify({ ok: true, id: message.id }), { status: 200 });
  } });
  const m = monde({ envoyeur });
  const r = await deposer(m, corps());
  assert.equal(r.status, 200);
  assert.ok((await lignes(m.d.store, 'ob/')).every((x) => x.statut === 'a_envoyer' && x.tentatives === 1));
  const ids = appels.map((x) => x.id).sort();
  panne = false;
  m.avancer(61e3);
  await executerFile(m.d);
  assert.deepEqual(appels.slice(2).map((x) => x.id).sort(), ids);
  assert.ok((await lignes(m.d.store, 'ob/')).every((x) => x.statut === 'envoye'));
  await executerFile(m.d);
  assert.equal(appels.length, 4);
});

test('courriel non configuré : déclaration acquise, file sans tentative et reprise avec les ventes toujours fermées', async () => {
  const m = monde({ envoyeur: envoyeurAucun() });
  assert.equal((await deposer(m, corps())).status, 200);
  assert.ok((await lignes(m.d.store, 'ob/')).every((x) => x.statut === 'en_attente_fournisseur' && x.tentatives === 0));
  m.d.envoyeur = envoyeurCapture();
  await executerFile(m.d);
  assert.equal(m.d.envoyeur.envoyes.length, 2);
  assert.equal(m.d.cfg.paiementsActifs, false);
});

test('passage immédiat limité aux deux notifications, tentées en parallèle sans vider la file générale', async () => {
  let debut = 0, liberer;
  const ensemble = new Promise((resolve) => { liberer = resolve; });
  const capture = envoyeurCapture();
  const envoyer = capture.envoyer.bind(capture);
  capture.envoyer = async (message) => {
    debut += 1;
    if(debut === 2) liberer();
    await ensemble;
    return envoyer(message);
  };
  const m = monde({ envoyeur: capture });
  const autre = await mettreEnFile(m.d.store, { type: 'confirmation', dedup: 'autre-commande', commandeId: 'CMD-AUTRE', destinataire: 'client' }, m.d.now());
  const r = await deposer(m, corps());
  assert.equal(r.status, 200);
  assert.equal(debut, 2);
  assert.equal((await m.d.store.getJSON('ob/' + autre.id)).statut, 'a_envoyer');
});

test('courriels : contenu fidèle et échappé, sans création de liens HTML à partir du texte public', async () => {
  const appels = [];
  const envoyeur = envoyeurMake({ url: 'https://hook.eu1.make.com/test', cle: 'cle-factice', mode: 'test', fetchFn: async (url, init) => {
    const message = JSON.parse(init.body); appels.push(message);
    return new Response(JSON.stringify({ ok: true, id: message.id }), { status: 200 });
  } });
  const m = monde({ envoyeur });
  const c = corps({ elementsCommande: '<img src=x onerror=alert(1)> https://exemple.invalid/?x=1&y=2' });
  const b = await (await deposer(m, c)).json();
  assert.ok(b.accuse.includes(c.elementsCommande));
  for(const message of appels){
    assert.ok(message.html.includes('&lt;img'));
    assert.ok(message.html.includes('&amp;y=2'));
    assert.ok(!message.html.includes('<img'));
    assert.ok(!message.html.includes('<a '));
  }
});

function navigateur(fetchFn){
  const nodes = new Map();
  function element(id){
    if(!nodes.has(id)) nodes.set(id, { id, hidden: false, disabled: false, textContent: '', value: '', ecoute: {}, attrs: {},
      addEventListener(nom, fn){ this.ecoute[nom] = fn; },
      setAttribute(nom, valeur){ this.attrs[nom] = valeur; }, focus(){},
    });
    return nodes.get(id);
  }
  const form = element('bdr-form');
  form.elements = Object.fromEntries(Object.entries(DONNEES).filter(([nom]) => ['prenoms', 'nom', 'email', 'referenceCommande', 'elementsCommande', 'siteweb'].includes(nom)).map(([nom, valeur]) => [nom, { value: valeur }]));
  form.reportValidity = () => true;
  const context = vm.createContext({
    document: { getElementById: element }, window: { crypto: crypto.webcrypto, fetch: fetchFn },
    Uint8Array, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), TypeError,
  });
  vm.runInContext(fs.readFileSync(new URL('../assets/bd-retractation.js', import.meta.url), 'utf8'), context);
  return { element, form, soumettre: () => form.ecoute.submit({ preventDefault(){} }), confirmer: () => element('bdr-confirmer').ecoute.click() };
}

test('interface : récapitulatif sans envoi, confirmation distincte, double clic bloqué et clé stable après coupure', async () => {
  const appels = [];
  let resoudre, interrompre;
  const n = navigateur((url, init) => {
    appels.push({ url, ...init, donnees: JSON.parse(init.body) });
    return new Promise((resolve, reject) => { resoudre = resolve; interrompre = reject; });
  });
  n.soumettre();
  assert.equal(appels.length, 0);
  assert.equal(n.element('bdr-recap-email').textContent, DONNEES.email);
  const essai = n.confirmer();
  await n.confirmer();
  assert.equal(appels.length, 1);
  assert.equal(appels[0].credentials, 'omit');
  assert.ok(!appels[0].url.includes('?'));
  assert.match(appels[0].donnees.cle, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(appels[0].donnees.confirmation, true);
  interrompre(new TypeError('coupure simulée'));
  await essai;
  assert.equal(n.element('bdr-envoi-erreur').hidden, false);
  const reprise = n.confirmer();
  assert.equal(appels.length, 2);
  assert.equal(appels[1].donnees.cle, appels[0].donnees.cle);
  resoudre({ ok: true, json: async () => ({ ok: true, reference: 'RET-' + 'A'.repeat(24), accuse: 'Reçu synthétique' }) });
  await reprise;
  assert.equal(n.element('bdr-succes').hidden, false);
  assert.equal(n.element('bdr-accuse').textContent, 'Reçu synthétique');
  await n.confirmer();
  assert.equal(appels.length, 2, 'aucun renvoi après succès');
});

test('interface : le reçu est téléchargé en texte et le lien de rétractation demeure hors des zones de connexion', () => {
  const html = fs.readFileSync(new URL('../retractation-bd.html', import.meta.url), 'utf8');
  assert.match(html, /Confirmer la rétractation/);
  assert.match(html, /Votre déclaration est enregistrée/);
  assert.match(html, /<fieldset id="bdr-champs" disabled>/);
  assert.ok(!/data-netlify|netlify-honeypot/i.test(html), 'pas de capture parallèle par Netlify Forms');
  for(const name of ['mon-album.html', 'achat-bd.html', 'bd-personnelle.html']){
    const page = fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
    assert.match(page.slice(page.indexOf('<footer')), /href="\/retractation-bd">Se rétracter du contrat/);
  }
  const js = fs.readFileSync(new URL('../assets/bd-retractation.js', import.meta.url), 'utf8');
  assert.ok(js.includes("type: 'text/plain;charset=utf-8'"));
  assert.ok(!/localStorage|sessionStorage|innerHTML/.test(js));
});

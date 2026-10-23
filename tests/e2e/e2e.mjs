// Parcours complet dans Chromium, données fictives, Stripe simulé. Aucun appel réseau externe.
// Playwright : installation globale (PLAYWRIGHT_GLOBAL=chemin de npm root -g) ou locale.
import { createRequire } from 'node:module';
const { chromium } = createRequire((process.env.PLAYWRIGHT_GLOBAL || process.cwd()) + '/')('playwright');
import crypto from 'node:crypto';
const OUT = process.argv[2] || '.';  // dossier des captures
// Lancer : CHROMIUM_PATH=… PLAYWRIGHT_GLOBAL=$(npm root -g) node tests/e2e/e2e.mjs /tmp/captures
const res = []; const ok = (n, c, d = '') => { res.push({ n, ok: !!c, d }); console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const sign = (brut) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=` + crypto.createHmac('sha256', 'whsec_e2e').update(`${t}.${brut}`).digest('hex'); };
const admin = (base, corps) => fetch(base + '/.netlify/functions/bd-admin', { method: 'POST', headers: { authorization: 'Bearer admin-e2e', 'content-type': 'application/json' }, body: JSON.stringify(corps) }).then((r) => r.json());
// Stripe.js simulé : enregistre les appels, ne contacte personne.
const FAUX_STRIPE = `window.__stripe = { appels: [] }; window.Stripe = function(pk){ window.__stripe.pk = pk; return {
  createEmbeddedCheckoutPage: function(o){ window.__stripe.appels.push('createEmbeddedCheckoutPage'); return o.fetchClientSecret().then(function(s){ window.__stripe.secret = s; return { mount: function(sel){ window.__stripe.monte = sel; document.querySelector(sel).textContent = 'Formulaire de paiement Stripe (simulé)'; } }; }); } }; };`;

import { spawn } from 'node:child_process';
const ICI = new URL('.', import.meta.url).pathname;
const serveurs = [[8791, 'non'], [8792, 'oui'], [8793, 'non'], [8794, 'oui']].map(([port, p]) => spawn(process.execPath, [ICI + 'serveur.mjs', new URL('../../', import.meta.url).pathname, String(port), p], { stdio: 'ignore' }));
process.on('exit', () => serveurs.forEach((s) => s.kill()));
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
for(const vp of [{ nom: 'mobile', w: 390, h: 844, mobile: true }, { nom: 'bureau', w: 1280, h: 900 }]){
  for(const [port, paiements] of [[vp.mobile ? 8791 : 8793, false], [vp.mobile ? 8792 : 8794, true]]){
    const base = `http://localhost:${port}`;
    const tag = `[${vp.nom}, paiement ${paiements ? 'ouvert (test simulé)' : 'fermé'}]`;
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: !!vp.mobile, hasTouch: !!vp.mobile, acceptDownloads: true });
    await ctx.route('https://js.stripe.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAUX_STRIPE }));
    await ctx.route((u) => !u.href.startsWith(base) && !u.href.startsWith('https://js.stripe.com'), (r) => r.abort());
    const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const deborde = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    let postsAchat = 0;
    page.on('request', (r) => { if(r.method() === 'POST' && r.url().includes('/bd-achat')) postsAchat += 1; });

    await page.goto(base + '/bd-personnelle.html');
    ok(`${tag} offres : boutons vers l’achat de la bonne offre`, (await page.$$('a[href="achat-bd?offre=297"]')).length >= 2 && (await page.$$('a[href="achat-bd?offre=891"]')).length >= 2 && (await page.$$('a[href*="demande-bd"]')).length === 0);
    ok(`${tag} offres : pas de débordement`, (await deborde()) <= 0);

    await page.goto(base + '/achat-bd?offre=891');
    await page.waitForSelector('#bda-resume', { state: 'visible' });
    ok(`${tag} achat : offre préselectionnée, montant du serveur 891,00 €`, await page.isChecked('input[name=offre][value="891"]') && (await page.textContent('#bda-montant')).includes('891,00'));
    if(!paiements){
      await page.waitForSelector('#bda-ferme', { state: 'visible' });
      ok(`${tag} achat fermé : « pas encore ouvert », aucun formulaire, Stripe.js non chargé`, !(await page.isVisible('#bda-form')) && !(await page.evaluate(() => !!window.Stripe)));
      ok(`${tag} achat fermé : pas de débordement`, (await deborde()) <= 0);
      await page.screenshot({ path: `${OUT}/achat-ferme-${vp.nom}.png`, fullPage: true });
      await page.check('input[name=offre][value="297"]');
      await page.waitForFunction(() => document.getElementById('bda-montant').textContent.includes('297,00'));
      ok(`${tag} achat fermé : changement d’offre, adresse mise à jour`, page.url().endsWith('/achat-bd?offre=297'));
      ok(`${tag} achat fermé : aucune donnée envoyée`, postsAchat === 0 && (await admin(base, { action: 'lister' })).commandes.length === 0);
    } else {
      await page.waitForSelector('#bda-form', { state: 'visible' });
      await page.click('#bda-form button[type=submit]');
      ok(`${tag} achat : envoi vide refusé dans la page`, (await page.$$('#bda-errors li')).length === 6 && postsAchat === 0);
      await page.fill('#bda-prenoms', 'Test'); await page.fill('#bda-nom', 'Synthétique'); await page.fill('#bda-email', 'test.synthetique@example.invalid');
      await page.fill('#bda-whatsapp', '0692000000'); await page.check('#bda-declaration'); await page.check('#bda-consentement');
      await page.click('#bda-form button[type=submit]');
      ok(`${tag} achat : WhatsApp sans indicatif refusé`, (await page.textContent('#bda-errors')).includes('indicatif'));
      await page.fill('#bda-whatsapp', '+262 692 00 00 00');
      await page.dblclick('#bda-form button[type=submit]');
      await page.waitForFunction(() => window.__stripe && window.__stripe.monte);
      const st = await page.evaluate(() => window.__stripe);
      ok(`${tag} paiement : Checkout intégré monté sur la même page (secret client du serveur)`, st.appels[0] === 'createEmbeddedCheckoutPage' && st.pk === 'pk_test_e2e_factice' && /^cs_test_e2e_secret_/.test(st.secret) && st.monte === '#bda-checkout');
      ok(`${tag} paiement : double clic → un seul envoi, une seule session`, postsAchat === 1 && (await fetch(base + '/__test/stripe').then((r) => r.json())).sessions === 1);
      ok(`${tag} paiement : formulaire masqué, référence de commande affichée`, !(await page.isVisible('#bda-form')) && /^CMD-891-\d{8}-[A-Z2-9]{6}$/.test(await page.textContent('#bda-ref')));
      ok(`${tag} paiement : pas de débordement`, (await deborde()) <= 0);
      await page.screenshot({ path: `${OUT}/achat-ouvert-${vp.nom}.png`, fullPage: true });
      await page.goto(base + '/mon-album'); await page.waitForSelector('#bde-perdu', { state: 'visible' });
      ok(`${tag} avant paiement vérifié : aucun questionnaire`, !(await page.isVisible('#bde-espace')));
      // Retour avant webhook : jamais de succès sur simple redirection
      const liste = await admin(base, { action: 'lister' });
      const cmd = liste.commandes.find((c) => c.statut === 'checkout_ouvert');
      const sid = 'cs_test_E2ESESSION000001';
      await page.goto(base + '/paiement-bd-retour?session_id=' + sid);
      await page.waitForTimeout(2500);
      ok(`${tag} retour : en attente tant que le webhook n’est pas passé`, await page.isVisible('#bdp-attente') && !(await page.isVisible('#bdp-confirme')));
      const sess = { id: sid, mode: 'payment', client_reference_id: cmd.reference, payment_status: 'paid', amount_total: 89100, currency: 'eur', metadata: { bd_commande: cmd.reference, bd_offre: '891' } };
      const brut = JSON.stringify({ id: 'evt_e2e_' + vp.nom, type: 'checkout.session.completed', livemode: false, data: { object: sess } });
      const w = await fetch(base + '/.netlify/functions/bd-stripe-webhook', { method: 'POST', headers: { 'stripe-signature': sign(brut), 'content-type': 'application/json' }, body: brut }).then((r) => r.json());
      ok(`${tag} webhook signé : paiement constaté`, w.resultat === 'paye');
      await page.waitForSelector('#bdp-confirme', { state: 'visible', timeout: 10000 });
      const t = await page.textContent('#bdp-confirme');
      ok(`${tag} retour : confirmation avec prénom, offre, montant, référence, étape`, t.includes('Test') && t.includes('Mon histoire en BD') && t.includes('891,00') && t.includes(cmd.reference) && t.includes('Prochaine étape'));
      ok(`${tag} retour : identifiant de session retiré de l’adresse`, !page.url().includes('session_id'));
      await page.screenshot({ path: `${OUT}/retour-confirme-${vp.nom}.png`, fullPage: true });
      await page.click('#bdp-c-acces a');
      await page.waitForSelector('#bde-espace', { state: 'visible' });
      ok(`${tag} espace : questionnaire 891 ouvert par la session (45 questions)`, (await page.$$('.bdq-title .num')).length === 45);
      const cookies = await ctx.cookies();
      const ck = cookies.find((c) => c.name === '__Host-bd_sess');
      ok(`${tag} espace : cookie HttpOnly, Secure, SameSite=Strict`, ck && ck.httpOnly && ck.secure && ck.sameSite === 'Strict');
      ok(`${tag} espace : rien dans localStorage`, (await page.evaluate(() => localStorage.length)) === 0);
      await page.fill('[data-k="q1"]', 'Test');
      await page.check('[data-k="q16"][value="A. Famille et transmission"]');
      await page.fill('[data-k="q16.0.0"]', 'Réponse du thème A');
      await page.click('[data-add="q9"]'); await page.fill('[data-k="q9.3.nom"]', 'Période 4 fictive');
      await page.waitForTimeout(2200);
      ok(`${tag} espace : brouillon enregistré côté serveur`, (await page.textContent('#bdq-draft')).includes('Brouillon enregistré'));
      await page.reload(); await page.waitForSelector('#bde-espace', { state: 'visible' });
      ok(`${tag} espace : brouillon repris après rechargement (4 périodes, thème A)`, (await page.inputValue('[data-k="q9.3.nom"]')) === 'Période 4 fictive' && (await page.inputValue('[data-k="q16.0.0"]')) === 'Réponse du thème A');
      ok(`${tag} espace : pas de débordement`, (await deborde()) <= 0);
      await page.screenshot({ path: `${OUT}/espace-${vp.nom}.png` });
      await page.uncheck('[data-k="q16"][value="A. Famille et transmission"]');
      await page.check('[data-k="q2.__later"]'); await page.check('[data-k="q5.alt"]'); await page.check('[data-k="accord_reponses"]');
      await page.click('#bdq-form button[type=submit]');
      await page.waitForSelector('#bde-espace .bdq-done', { state: 'visible' });
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-download]')]);
      const copie = await (await dl.createReadStream()).toArray().then((b) => Buffer.concat(b).toString('utf8'));
      ok(`${tag} espace : envoyé ; copie téléchargée sans le thème décoché`, copie.includes('Période 4 fictive') && !copie.includes('Réponse du thème A'));
      const envoyes = await fetch(base + '/__test/outbox').then((r) => r.json());
      const confirmation = envoyes.find((m) => m.sujet.includes('paiement confirmé'));
      ok(`${tag} confirmation acheteur en file (envoyeur de test)`, !!confirmation && confirmation.texte.includes('/mon-album#cle=') && confirmation.texte.includes('891,00 €'));
      // Autre navigateur, sans cookie : espace fermé, récupération générique
      const ctx2 = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const p2 = await ctx2.newPage(); await p2.goto(base + '/mon-album');
      await p2.waitForSelector('#bde-perdu', { state: 'visible' });
      await p2.fill('#bde-recup input[name=email]', 'inconnue@example.invalid'); await p2.click('#bde-recup button');
      await p2.waitForFunction(() => document.getElementById('bde-recup-msg').textContent.length > 0);
      ok(`${tag} récupération : réponse générique sans révéler l’adresse`, (await p2.textContent('#bde-recup-msg')).startsWith('Si une commande réglée correspond'));
      // Le lien du courriel ouvre aussi l'espace, et ne reste pas dans l'adresse
      const lienCourriel = confirmation.texte.match(/https?:\/\/[^\s]+#cle=[A-Za-z0-9_-]{43}/)[0].replace('https://younousjonas.com', base);
      await p2.goto(lienCourriel); await p2.waitForSelector('#bde-deja', { state: 'visible' });
      ok(`${tag} lien personnel : ouvre l’espace (déjà envoyé), fragment retiré`, !p2.url().includes('#cle='));
      await ctx2.close();
    }
    ok(`${tag} aucune erreur JavaScript`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
}
await browser.close();
const echecs = res.filter((r) => !r.ok).length;
console.log(`\n${res.length - echecs}/${res.length} vérifications réussies`);
process.exit(echecs ? 1 : 0);

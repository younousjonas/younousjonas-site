// Serveur local de test : fichiers du site + vraies fonctions bd-* sur magasin en mémoire.
// Stripe (API) intercepté ; envoyeur de capture ; aucun accès réseau.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const SITE_DIR = process.argv[2]; const PORT = Number(process.argv[3]); const PAIEMENTS = process.argv[4] === 'oui';
const lib = (f) => import(path.join(SITE_DIR, 'netlify/functions/bd-lib', f));
const { lireConfig } = await lib('config.mjs');
const { magasinMemoire } = await lib('store.mjs');
const { envoyeurCapture } = await lib('outbox.mjs');
const H = await lib('handlers.mjs');
const crypto = await import('node:crypto');
const origine = `http://localhost:${PORT}`;
const env = { BD_SITE_URL: origine, BD_ADMIN_TOKEN_SHA256: crypto.createHash('sha256').update('admin-e2e').digest('hex'), BD_STRIPE_WEBHOOK_SECRET: 'whsec_e2e', BD_ADMIN_EMAIL: 'admin@example.invalid', BD_LINK_SECRET: 'secret-de-lien-e2e-0123456789abcdef0123' };
if(PAIEMENTS) Object.assign(env, { BD_PAYMENTS_ENABLED: 'true', BD_STRIPE_SECRET_KEY: 'sk_test_e2e_factice', BD_STRIPE_PUBLISHABLE_KEY: 'pk_test_e2e_factice' });
const envoyeur = envoyeurCapture();
let n = 0;
const d = { store: magasinMemoire(), cfg: lireConfig(env), now: Date.now, envoyeur, journal: () => {},
  fetchFn: async () => { n += 1; return new Response(JSON.stringify({ id: 'cs_test_E2ESESSION' + String(n).padStart(6, '0'), client_secret: 'cs_test_e2e_secret_' + n, livemode: false }), { status: 200 }); } };
const routes = { 'bd-interet': H.handlerInteret(d), 'bd-admin': H.handlerAdmin(d), 'bd-paiement': H.handlerPaiement(d), 'bd-stripe-webhook': H.handlerWebhook(d), 'bd-acces': H.handlerAcces(d), 'bd-questionnaire': H.handlerQuestionnaire(d) };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, origine);
  const chunks = []; for await (const c of req) chunks.push(c);
  const corps = Buffer.concat(chunks);
  if(url.pathname === '/__test/outbox'){ await H.executerFile(d); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(envoyeur.envoyes)); }
  const m = url.pathname.match(/^\/\.netlify\/functions\/([a-z-]+)$/);
  if(m && routes[m[1]]){
    const r = await routes[m[1]](new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : corps }), { ip: '127.0.0.1' });
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  let f = path.join(SITE_DIR, p);
  if(!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if(!f.startsWith(SITE_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
}).listen(PORT, () => console.log('pret ' + PORT));

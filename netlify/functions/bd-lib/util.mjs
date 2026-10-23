// Outils communs : réponses, jetons, cookies, origine, limites de débit.
import crypto from 'node:crypto';
import { maj } from './store.mjs';

export function json(status, body, headers = {}){
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers },
  });
}

// Jeton aléatoire non devinable (256 bits), envoyé une seule fois ; seul son hachage est stocké.
export function nouveauJeton(){ return crypto.randomBytes(32).toString('base64url'); }
export function hacher(valeur){ return crypto.createHash('sha256').update(String(valeur), 'utf8').digest('hex'); }
export function egalConstant(a, b){
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Jeton déterministe (même format que nouveauJeton) : HMAC-SHA256(secret, contexte).
// Sert au lien personnel d'un message de la file : chaque reprise du même message
// reproduit le même lien, sans qu'aucun lien en clair soit stocké.
export function jetonDerive(secret, contexte){
  if(!secret) throw new Error('secret_lien_absent');
  return crypto.createHmac('sha256', secret).update(String(contexte), 'utf8').digest('base64url');
}
export function jetonValideFormat(t){ return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t); }

// Références lisibles : PRE-OFFRE-AAAAMMJJ-XXXXXX (alphabet sans ambiguïté).
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function reference(prefixe, offre, maintenant){
  const d = new Date(maintenant);
  const p = (x) => String(x).padStart(2, '0');
  const bytes = crypto.randomBytes(6);
  let s = ''; for(const b of bytes) s += ALPHA[b % ALPHA.length];
  return `${prefixe}-${offre}-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${s}`;
}

// Cookie de session : préfixe __Host-, HttpOnly, Secure, SameSite=Strict, chemin /.
export const NOM_COOKIE = '__Host-bd_sess';
export function cookieSession(valeur, maxAgeSec){
  return `${NOM_COOKIE}=${valeur}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}
export function cookieEfface(){ return `${NOM_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
export function lireCookie(req, nom = NOM_COOKIE){
  const h = req.headers.get('cookie') || '';
  for(const part of h.split(';')){
    const i = part.indexOf('=');
    if(i > -1 && part.slice(0, i).trim() === nom) return part.slice(i + 1).trim();
  }
  return '';
}

// Requêtes qui modifient l'état : JSON, même origine.
export function origineAutorisee(req, cfg){
  const o = req.headers.get('origin');
  return !!o && cfg.origines.has(o.replace(/\/+$/, ''));
}
export async function lireJSON(req, max = 1_000_000){
  const ct = req.headers.get('content-type') || '';
  if(!ct.startsWith('application/json')) return { erreur: 'type' };
  const brut = await req.text();
  if(brut.length > max) return { erreur: 'taille' };
  try{ return { corps: JSON.parse(brut) }; }catch{ return { erreur: 'json' }; }
}

export function ipClient(req, context){
  return (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'inconnue';
}

// Limite de débit par fenêtre fixe, stockée dans le magasin. Le compteur avance par écriture
// conditionnelle ; si les conflits persistent, la demande est refusée (jamais comptée sans garde).
export async function limiter(store, portee, cle, max, fenetreMs, maintenant){
  const fenetre = Math.floor(maintenant / fenetreMs);
  const k = `rl/${portee}/${hacher(cle)}/${fenetre}`;
  let accepte = false;
  try{
    await maj(store, k, (v) => {
      const n = (v ? v.n : 0) + 1;
      accepte = n <= max;
      return accepte ? { n, expire: (fenetre + 1) * fenetreMs } : undefined;
    });
  }catch{ return false; }
  return accepte;
}

export function nettoyer(s, max){ return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max); }
export function emailValide(e){ return typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
// WhatsApp : indicatif international obligatoire (+262…, +33…), 8 à 15 chiffres.
export function normaliserWhatsapp(t){
  const s = String(t || '').replace(/[\s.\-()]/g, '');
  const n = s.startsWith('00') ? '+' + s.slice(2) : s;
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : '';
}

/** Entrée de paiement Bilan 2026 : contrôle serveur de l’échéance, sans secret.
 * Le lien Stripe partagé séparément doit aussi être fermé dans Stripe à l’échéance.
 */
const END = Date.parse('2026-11-02T00:00:00+04:00');
const PAYMENT_URL = 'https://book.stripe.com/8x2fZgbFRbM11DVerQ8ww2t';
const CAMPAIGN_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
export function responseFor(method, query = {}, now = Date.now()) {
  const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
  if (method !== 'GET' && method !== 'HEAD') return { statusCode: 405, headers: { ...headers, Allow: 'GET, HEAD' }, body: '' };
  if (!Number.isFinite(now) || now >= END) return { statusCode: 303, headers: { ...headers, Location: '/bilan-2026?offre=terminee#reservation' }, body: '' };
  const target = new URL(PAYMENT_URL);
  for (const key of CAMPAIGN_KEYS) { const value = query[key]; if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)) target.searchParams.set(key, value); }
  return { statusCode: 303, headers: { ...headers, Location: target.toString() }, body: '' };
}
export const handler = async (event) => responseFor(event.httpMethod, event.queryStringParameters || {});

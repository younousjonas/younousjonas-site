// Stripe, sans dépendance : appels REST et vérification de signature (HMAC-SHA256).
// Version d'API épinglée par BD_STRIPE_API_VERSION (par défaut « 2026-03-25.dahlia ») :
// à partir de cette version, le Checkout intégré s'appelle ui_mode=embedded_page.
import crypto from 'node:crypto';

export function verifierSignature(brut, entete, secret, maintenantMs, tolerance = 300){
  if(!entete || !secret) return false;
  let t = null; const v1 = [];
  for(const kv of String(entete).split(',')){
    const i = kv.indexOf('='); if(i < 0) continue;
    const k = kv.slice(0, i).trim(); const val = kv.slice(i + 1).trim();
    if(k === 't') t = val; else if(k === 'v1') v1.push(val);
  }
  if(!t || !/^\d+$/.test(t) || !v1.length) return false;
  if(Math.abs(Math.floor(maintenantMs / 1000) - Number(t)) > tolerance) return false;
  const attendu = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${brut}`, 'utf8').digest('hex'));
  return v1.some((s) => { const b = Buffer.from(s); return b.length === attendu.length && crypto.timingSafeEqual(b, attendu); });
}

// Signature d'un corps, pour les tests uniquement.
export function signerPourTest(brut, secret, tSec){
  return `t=${tSec},v1=` + crypto.createHmac('sha256', secret).update(`${tSec}.${brut}`, 'utf8').digest('hex');
}

export async function creerSessionCheckout({ cfg, commande, offre, fetchFn, tentative }){
  const p = new URLSearchParams();
  p.set('ui_mode', 'embedded_page');
  p.set('mode', 'payment');
  // Identifiant stable du parcours ; le suffixe est tiré une seule fois, pas à chaque achat.
  p.set('integration_identifier', 'komsa_bd_dnuojqhw');
  p.set('locale', 'fr');
  p.set('line_items[0][quantity]', '1');
  p.set('line_items[0][price_data][currency]', offre.devise);
  p.set('line_items[0][price_data][unit_amount]', String(offre.montant));
  p.set('line_items[0][price_data][product_data][name]', offre.libelle);
  p.set('customer_email', commande.email);
  p.set('client_reference_id', commande.id);
  p.set('return_url', `${cfg.site}/paiement-bd-retour?session_id={CHECKOUT_SESSION_ID}`);
  for(const [k, v] of Object.entries({ bd_commande: commande.id, bd_offre: offre.code, source: 'younousjonas.com/bd-personnelle' })){
    p.set(`metadata[${k}]`, v);
    p.set(`payment_intent_data[metadata][${k}]`, v);
  }
  p.set('payment_intent_data[receipt_email]', commande.email);
  // Description reprise par le paiement et la charge : permet au webhook du coaching
  // (stripe-webhook.js) d'ignorer les paiements BD, y compris sur les événements de charge.
  p.set('payment_intent_data[description]', `BD personnelle — ${commande.id}`);
  // Moyens de paiement : aucun payment_method_types n'est fixé. Stripe affiche ceux de la
  // configuration du compte (Run Coaching) selon l'éligibilité de chaque acheteur
  // (carte, Klarna, PayPal…). Paiement comptant intégral : aucun échéancier n'est créé ici.
  const r = await fetchFn('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.stripeSecret}`,
      'content-type': 'application/x-www-form-urlencoded',
      'stripe-version': cfg.stripeApiVersion,
      'idempotency-key': `bd-cs-${commande.id}-${tentative}`,
    },
    body: p.toString(),
  });
  const corps = await r.json().catch(() => ({}));
  if(!r.ok || !corps.id || !corps.client_secret){
    // Jamais la clé ni le corps complet dans les journaux : seulement le type d'erreur Stripe.
    const type = corps && corps.error ? corps.error.type : 'reponse_invalide';
    throw new Error('stripe_' + type);
  }
  return { id: corps.id, clientSecret: corps.client_secret, livemode: !!corps.livemode };
}

// Paiement Bilan 2026. Montant, échéance et destination sont fixés côté serveur.
export const END = Date.parse('2026-11-02T00:00:00+04:00');
export const AMOUNT = 39700;
export const SITE = 'https://younousjonas.com';
export const PRICE = 'price_1UV79fCUcXJfZOaAUPPbqMm1';
export const CAMPAIGNS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
export const SESSION_ID = /^cs_(?:live|test)_[A-Za-z0-9]{10,255}$/;
export const json = (status, data) => new Response(JSON.stringify(data), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer',
} });

export function config(env = process.env) {
  // Même paire que le coaching existant ; aucune clé des albums n'est utilisée.
  const secret = env.STRIPE_SECRET_KEY || '';
  const publishable = env.STRIPE_PUBLISHABLE_KEY || '';
  const live = /^(?:sk|rk)_live_/.test(secret) && publishable.startsWith('pk_live_');
  const test = /^(?:sk|rk)_test_/.test(secret) && publishable.startsWith('pk_test_');
  const production = env.CONTEXT === 'production';
  return { secret, publishable, live, active: !!env.STRIPE_WEBHOOK_SECRET && (production ? live : test),
    // Prix test distinct à configurer en aperçu ; jamais de catalogue live en test.
    price: live ? PRICE : env.BILAN_STRIPE_TEST_PRICE_ID || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  };
}

export async function stripe(path, cfg, { method = 'GET', body, key, fetchFn = fetch } = {}) {
  const r = await fetchFn('https://api.stripe.com/v1/' + path, {
    method, headers: { Authorization: 'Bearer ' + cfg.secret, 'Stripe-Version': '2026-08-26.dahlia',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}), },
    ...(body ? { body: body.toString() } : {}), signal: AbortSignal.timeout(12000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('stripe_' + r.status);
  return data;
}

export function sessionParams(input, cfg, now) {
  const p = new URLSearchParams({ mode: 'payment', ui_mode: 'embedded_page', locale: 'fr',
    integration_identifier: 'komsa_bilan_2026_qjthmzwp',
    'line_items[0][price]': cfg.price, 'line_items[0][quantity]': '1',
    customer_creation: 'always', 'invoice_creation[enabled]': 'true',
    'invoice_creation[invoice_data][description]': 'Bilan 2026 — Préparer 2027 · Questionnaire, entretien de 1 h 30, synthèse écrite et suivi écrit WhatsApp de 14 jours',
    'payment_intent_data[description]': 'Bilan 2026 — Préparer 2027',
    redirect_on_completion: 'if_required',
    return_url: SITE + '/bilan-2026?session_id={CHECKOUT_SESSION_ID}#reservation',
    submit_type: 'pay',
    'branding_settings[display_name]': 'Younous Jonas · Run Coaching',
    'branding_settings[background_color]': '#111111',
    'branding_settings[button_color]': '#f4f4f2',
    'branding_settings[font_family]': 'inter',
    'branding_settings[border_style]': 'rectangular',
    'name_collection[individual][enabled]': 'true',
    'name_collection[individual][optional]': 'false',
    'custom_text[submit][message]': 'Questionnaire, un entretien de 1 h 30, synthèse écrite et 14 jours de suivi écrit WhatsApp après l’entretien. Démarrage en novembre, sur rendez-vous.',
  });
  // Stripe impose au moins 30 min. Une session commencée dans la dernière demi-heure
  // peut être terminée pendant ses 30 min de validité ; aucune nouvelle après END.
  p.set('expires_at', String(Math.floor(Math.max(now + 1800e3, Math.min(END, now + 3600e3)) / 1000)));
  [['prenom', 'Prénom', 1, 100], ['nom', 'Nom', 1, 100],
    ['whatsapp', 'Numéro WhatsApp (avec indicatif, ex. +262 ou +33)', 8, 30]].forEach(([key, label, min, max], i) => {
    for (const [k, v] of Object.entries({ key, type: 'text', 'label[type]': 'custom', 'label[custom]': label,
      optional: 'false', 'text[minimum_length]': min, 'text[maximum_length]': max })) p.set(`custom_fields[${i}][${k}]`, String(v));
  });
  const meta = { formule: 'bilan_2026', source_site: 'younousjonas.com', entite: 'Run Coaching',
    tag_palier_source: 'N4_coaching', type_piece: 'Facture', motif: 'Bilan 2026 — Préparer 2027', palier_prix: 'lancement', bilan_format: 'entretien90_whatsapp14j', };
  for (const k of CAMPAIGNS) if (typeof input[k] === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(input[k])) meta[k] = input[k];
  for (const [k, v] of Object.entries(meta)) {
    p.set(`metadata[${k}]`, v); p.set(`payment_intent_data[metadata][${k}]`, v);
  }
  return p;
}

export function belongs(s, cfg) {
  return s?.metadata?.formule === 'bilan_2026' && s.metadata.source_site === 'younousjonas.com'
    && s.amount_total === AMOUNT && s.currency === 'eur' && s.livemode === cfg.live;
}

export function paymentHandler({ cfg = config(), now = Date.now, fetchFn = fetch } = {}) {
  return async req => {
    if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Méthode non autorisée.' });
    if (!cfg.active || !cfg.price) return json(503, { error: 'Le paiement est momentanément indisponible. Réessaie dans quelques instants.' });
    try {
      if (req.method === 'GET') {
        const id = new URL(req.url).searchParams.get('session_id') || '';
        if (!SESSION_ID.test(id)) return json(400, { error: 'Référence de paiement invalide.' });
        const s = await stripe('checkout/sessions/' + id, cfg, { fetchFn });
        if (!belongs(s, cfg)) return json(404, { error: 'Référence de paiement introuvable.' });
        // Aucune coordonnée, aucun secret de session dans le point de vérification.
        return json(200, { status: s.status, payment_status: s.payment_status });
      }
      const origin = req.headers.get('origin');
      if (![SITE, 'https://www.younousjonas.com'].includes(origin)) return json(403, { error: 'Origine non autorisée.' });
      if (now() >= END) return json(410, { error: 'Les inscriptions au tarif de lancement sont terminées.' });
      if (!(req.headers.get('content-type') || '').startsWith('application/json')) return json(415, { error: 'Format invalide.' });
      const raw = await req.text();
      if (raw.length > 3000) return json(413, { error: 'Requête trop longue.' });
      let input; try { input = JSON.parse(raw); } catch { return json(400, { error: 'Requête invalide.' }); }
      if (!input || !/^[a-f0-9-]{36}$/.test(input.request_id || '')) return json(400, { error: 'Référence de demande invalide.' });
      if (!Number.isSafeInteger(input.started_at) || input.started_at > now() + 60000 || input.started_at < now() - 3600e3) return json(400, { error: 'Cette demande a expiré. Recharge la page pour recommencer.' });
      const s = await stripe('checkout/sessions', cfg, { method: 'POST', body: sessionParams(input, cfg, input.started_at),
        key: 'bilan-2026-' + input.request_id, fetchFn });
      if (!belongs(s, cfg) || !SESSION_ID.test(s.id) || !s.client_secret || s.status !== 'open') throw new Error('session_invalide');
      return json(200, { id: s.id, clientSecret: s.client_secret, publishableKey: cfg.publishable, expiresAt: s.expires_at });
    } catch {
      return json(502, { error: 'Le paiement n’a pas pu être chargé. Réessaie dans quelques instants.' });
    }
  };
}

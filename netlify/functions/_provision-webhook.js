/**
 * _provision-webhook — fonction JETABLE, à supprimer juste après usage.
 *
 * Crée l'endpoint webhook Stripe (compte RUN COACHING) en se servant de la clé
 * secrète déjà présente dans les variables d'environnement Netlify
 * (STRIPE_SECRET_KEY) — la clé ne quitte jamais le serveur. Renvoie l'id de
 * l'endpoint et son mode (live/test), MAIS PAS le secret de signature
 * (à récupérer dans le dashboard Stripe pour le poser dans Netlify).
 *
 * Protégée par un jeton en query (?token=) pour qu'un tiers ne puisse pas
 * déclencher la création. Idempotente : si l'endpoint existe déjà (même URL),
 * elle le renvoie sans le recréer.
 */
const GUARD = "prov_8x4k2m9qz7w";
const ENDPOINT_URL = "https://younousjonas.com/.netlify/functions/stripe-webhook";

const json = (s, b) => ({ statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

exports.handler = async (event) => {
  if ((event.queryStringParameters || {}).token !== GUARD) {
    return { statusCode: 403, body: "forbidden" };
  }
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk) return json(503, { error: "STRIPE_SECRET_KEY absente." });

  const auth = { Authorization: `Bearer ${sk}` };

  // Idempotence : chercher un endpoint existant sur la même URL.
  const list = await fetch("https://api.stripe.com/v1/webhook_endpoints?limit=100", { headers: auth });
  const listed = await list.json();
  if (list.ok && Array.isArray(listed.data)) {
    const existing = listed.data.find((e) => e.url === ENDPOINT_URL);
    if (existing) {
      return json(200, { ok: true, already_existed: true, id: existing.id, livemode: existing.livemode, status: existing.status, url: existing.url, enabled_events: existing.enabled_events });
    }
  }

  // Création.
  const params = new URLSearchParams();
  params.set("url", ENDPOINT_URL);
  params.append("enabled_events[]", "payment_intent.succeeded");
  params.set("description", "Younous Coaching -> Netlify -> Make (capture CRM)");

  const resp = await fetch("https://api.stripe.com/v1/webhook_endpoints", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) return json(502, { error: data.error?.message || data });

  // On NE renvoie PAS data.secret (le whsec_) : il reste à récupérer côté
  // dashboard Stripe pour être collé dans Netlify.
  return json(200, { ok: true, created: true, id: data.id, livemode: data.livemode, status: data.status, url: data.url, enabled_events: data.enabled_events });
};

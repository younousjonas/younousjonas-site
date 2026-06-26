/**
 * _selftest-webhook — fonction JETABLE, à supprimer juste après usage.
 *
 * Teste toute la chaîne de capture SANS le dashboard Stripe : lit le
 * STRIPE_WEBHOOK_SECRET déjà présent dans Netlify, forge un événement
 * `payment_intent.succeeded` réaliste, le SIGNE avec une vraie signature
 * Stripe (HMAC-SHA256, même schéma que Stripe), et l'envoie à la fonction
 * `stripe-webhook`. Celle-ci vérifie la signature → relaie à Make → Airtable.
 *
 * Le secret ne quitte jamais le serveur. Protégée par un jeton (?token=).
 * Données clairement marquées « AutoTest » pour repérage + suppression.
 */
const crypto = require("crypto");
const GUARD = "selftest_7h2p9q";
const TARGET = "https://younousjonas.com/.netlify/functions/stripe-webhook";

exports.handler = async (event) => {
  if ((event.queryStringParameters || {}).token !== GUARD) {
    return { statusCode: 403, body: "forbidden" };
  }
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whsec) return { statusCode: 503, body: JSON.stringify({ error: "STRIPE_WEBHOOK_SECRET absent." }) };

  const t = Math.floor(Date.now() / 1000);
  const evt = {
    id: "evt_selftest_" + t,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_SELFTEST_" + t,
        object: "payment_intent",
        amount: 30000,
        currency: "eur",
        latest_charge: "ch_SELFTEST_" + t,
        receipt_email: "selftest-crm@example.test",
        metadata: {
          source_site: "younousjonas.com",
          entite: "Run Coaching",
          tag_palier_source: "N4_coaching",
          type_piece: "Reçu",
          motif: "Coaching — Séance à l’unité (self-test)",
          formule: "unite",
          prenom: "AutoTest",
          nom: "Webhook",
          email: "selftest-crm@example.test",
          telephone: "+262692000001",
        },
      },
    },
  };

  const payload = JSON.stringify(evt);
  const sig = crypto.createHmac("sha256", whsec).update(`${t}.${payload}`, "utf8").digest("hex");

  let targetStatus = null, targetBody = null;
  try {
    const resp = await fetch(TARGET, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${sig}` },
      body: payload,
    });
    targetStatus = resp.status;
    targetBody = await resp.text();
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err) }) };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, target_status: targetStatus, target_body: targetBody, pi: evt.data.object.id, email: evt.data.object.metadata.email }),
  };
};

/**
 * stripe-webhook — Netlify Function (compte Stripe RUN COACHING).
 *
 * Reçoit les événements Stripe, vérifie la signature, et relaie un payload
 * propre vers le scénario Make « KOMSA — Stripe natif » qui crée la ligne CRM
 * (Contact + Transaction) et envoie le reçu Brevo. Tronc commun
 * `STRIPE_specs_5sites.md` §4.
 *
 * C'est ce relai — et non un POST côté client — qui fait foi pour la capture :
 * il ne se déclenche qu'à un paiement réellement confirmé par Stripe, et il
 * survit à la fermeture de l'onglet par le client.
 *
 * Dépendances : aucune. Signature vérifiée à la main (HMAC-SHA256, `crypto`).
 *
 * Variables d'environnement requises :
 *   STRIPE_WEBHOOK_SECRET          whsec_… (généré à la création de l'endpoint Stripe)
 *   MAKE_WEBHOOK_URL_TRANSACTION   URL du webhook Make (scénario Stripe natif Run Coaching)
 *   MAKE_WEBHOOK_SECRET            secret partagé, passé en header X-Make-Secret
 *   STRIPE_SECRET_KEY              clé du même compte, lue seulement pour les litiges
 *                                  (lecture de la charge et du paiement, voir litigeBD) ;
 *                                  STRIPE_LITIGES_READ_KEY (clé restreinte en lecture) prime si posée.
 */

const crypto = require("crypto");

// Événements transmis à Make ; le reste est ignoré (réponse 200 quand même).
const EVENEMENTS_TRAITES = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
]);

// Paiements des albums « BD personnelle » (même compte Stripe) : ils ont leur propre
// webhook (bd-stripe-webhook) et ne doivent jamais partir vers Make ni Brevo.
// Repérés par les métadonnées `bd_commande` (Checkout, PaymentIntent) ou par la
// description « BD personnelle — … », reprise par la charge (remboursements).
function estPaiementBD(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.metadata && obj.metadata.bd_commande) return true;
  return typeof obj.description === "string" && obj.description.startsWith("BD personnelle — ");
}

// Un litige (`charge.dispute.*`) ne porte ni métadonnées ni description : on lit, en
// lecture seule, la charge puis le paiement auxquels il se rapporte pour savoir s'il
// concerne un album. Toute impossibilité de conclure lève une erreur : l'événement n'est
// alors pas relayé et Stripe le renverra (aucun litige perdu, aucun litige BD relayé).
const ID_CHARGE = /^(ch|py)_[A-Za-z0-9]{6,255}$/;
const ID_PAIEMENT = /^pi_[A-Za-z0-9]{6,255}$/;
const idDe = (x) => (typeof x === "string" ? x : x && typeof x.id === "string" ? x.id : null);

async function lireStripe(chemin, cle) {
  const resp = await fetch("https://api.stripe.com/v1/" + chemin, {
    method: "GET",
    headers: { Authorization: `Bearer ${cle}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error("stripe_" + resp.status);   // jamais la clé ni le corps
  return resp.json();
}

async function litigeBD(litige, cle) {
  if (estPaiementBD(litige) || estPaiementBD(litige.charge) || estPaiementBD(litige.payment_intent)) return true;
  if (!cle) throw new Error("cle_lecture_absente");
  let paiement = idDe(litige.payment_intent);
  const charge = idDe(litige.charge);
  if (charge) {
    if (!ID_CHARGE.test(charge)) throw new Error("charge_illisible");
    const ch = await lireStripe("charges/" + charge, cle);
    if (estPaiementBD(ch)) return true;
    paiement = paiement || idDe(ch.payment_intent);
  }
  if (paiement) {
    if (!ID_PAIEMENT.test(paiement)) throw new Error("paiement_illisible");
    if (estPaiementBD(await lireStripe("payment_intents/" + paiement, cle))) return true;
  }
  if (!charge && !paiement) throw new Error("litige_sans_reference");
  return false;
}

// Vérifie l'en-tête `Stripe-Signature` (format `t=…,v1=…`) contre le corps brut.
// Tolérance de 5 min sur l'horodatage pour bloquer le rejeu.
function signatureValide(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=").map((s) => s.trim())),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > 300) return false;

  const attendu = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${rawBody}`, "utf8")
    .digest("hex");

  const a = Buffer.from(attendu, "utf8");
  const b = Buffer.from(v1, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Méthode non autorisée." };
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const makeUrl = process.env.MAKE_WEBHOOK_URL_TRANSACTION;
  const makeSecret = process.env.MAKE_WEBHOOK_SECRET || "";

  // Corps BRUT obligatoire pour la signature (ne pas reparser/réencoder avant).
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

  const sigHeader =
    event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

  if (!signatureValide(rawBody, sigHeader, secret)) {
    return { statusCode: 400, body: "Signature invalide." };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "Payload illisible." };
  }

  console.log("Stripe event:", stripeEvent.type, stripeEvent.id);

  if (estPaiementBD(stripeEvent.data?.object)) {
    return { statusCode: 200, body: "Ignoré (BD personnelle)." };
  }

  if (!EVENEMENTS_TRAITES.has(stripeEvent.type)) {
    return { statusCode: 200, body: "Ignoré." };
  }

  if (!makeUrl) {
    // Endpoint pas encore branché à Make — on accuse réception pour éviter les
    // relances Stripe, en laissant une trace dans les logs.
    console.warn("MAKE_WEBHOOK_URL_TRANSACTION absent — relai CRM non effectué.");
    return { statusCode: 200, body: "Reçu (relai CRM non configuré)." };
  }

  const obj = stripeEvent.data?.object || {};

  if (stripeEvent.type.startsWith("charge.dispute.")) {
    try {
      if (await litigeBD(obj, process.env.STRIPE_LITIGES_READ_KEY || process.env.STRIPE_SECRET_KEY)) {
        return { statusCode: 200, body: "Ignoré (BD personnelle)." };
      }
    } catch (err) {
      console.error("Litige non résolu, Stripe réessaiera:", String(err && err.message).slice(0, 60));
      return { statusCode: 500, body: "Litige non résolu." };
    }
  }

  const payload = {
    event_id: stripeEvent.id,
    event_type: stripeEvent.type,
    payment_intent_id: obj.id || obj.payment_intent || null,
    charge_id: obj.latest_charge || obj.id || null,
    amount: obj.amount ?? obj.amount_captured ?? null,
    currency: obj.currency || "eur",
    receipt_email: obj.receipt_email || null,
    receipt_url: obj.receipt_url || null,
    metadata: obj.metadata || {},
  };

  try {
    const resp = await fetch(makeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Make-Secret": makeSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.error("Relai Make non-2xx:", resp.status);
    }
  } catch (err) {
    // On répond tout de même 200 : Stripe retentera l'événement, et on évite
    // une boucle de relances pendant un incident Make passager.
    console.error("Échec relai Make:", err);
  }

  return { statusCode: 200, body: "OK" };
};

exports.estPaiementBD = estPaiementBD;
exports.litigeBD = litigeBD;

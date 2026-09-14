/**
 * create-payment-intent — Netlify Function (compte Stripe RUN COACHING).
 *
 * Crée un PaymentIntent côté serveur pour le coaching individuel de
 * younousjonas.com (Option B — Stripe Payment Element natif, tronc commun
 * `STRIPE_specs_5sites.md` §5). Le front appelle cet endpoint AVANT de monter
 * le Payment Element, récupère `client_secret` + `publishable_key`, puis
 * confirme le paiement sans quitter le site.
 *
 * Sécurité :
 *   - Aucune clé dans le repo : tout vient des variables d'environnement Netlify.
 *   - Le MONTANT est autoritatif côté serveur (table PRIX ci-dessous). Le client
 *     n'envoie que l'identifiant de formule — il ne peut pas fixer le prix.
 *   - Profil B2C (particulier) : pas de SIRET, pas de TVA. La pièce est un REÇU,
 *     envoyé automatiquement par Stripe via `receipt_email`.
 *
 * Dépendances : aucune (appel REST Stripe via `fetch` natif, Node 18+).
 *
 * Variables d'environnement requises (Netlify > Site settings > Environment) :
 *   STRIPE_SECRET_KEY        clés RUN COACHING (sk_live_… en prod, sk_test_… en preview)
 *   STRIPE_PUBLISHABLE_KEY   clés RUN COACHING (pk_live_… / pk_test_…)
 */

// Catalogue autoritatif — montants en centimes, identifiants Stripe Run Coaching
// repris du handoff (objets déjà créés en live). Le motif nourrit la pièce et la
// notification CRM (convention objets : « [Source] — Prénom Nom (type) · … »).
const FORMULES = {
  unite: {
    montant_cents: 30000,
    motif: "Coaching — Séance à l’unité",
    price_id: "price_1TmOkWCUcXJfZOaAicgJqLyA",
    product_id: "prod_UlwdiU7pA3PFdR",
  },
  sprint: {
    montant_cents: 220000,
    motif: "Coaching — Sprint 2 mois (8 séances)",
    price_id: "price_1TmOCLCUcXJfZOaAAC5HBkgj",
    product_id: "prod_Ulw4FMA9qk0wt8",
  },
  approfondi: {
    montant_cents: 300000,
    motif: "Coaching — Approfondi 3 mois (12 séances)",
    price_id: "price_1TmOkXCUcXJfZOaAIeckLZ4u",
    product_id: "prod_UlwdyCgPm3FNBF",
  },
  mako: {
    montant_cents: 9900,
    motif: "Mako — session de lancement",
    price_id: "price_1Tnf79CUcXJfZOaAVLWOaU07",
    product_id: "prod_UnFcAAWfDg0d0t",
    tag_palier_source: "N4_inscription",
  },
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Méthode non autorisée." });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) {
    // Clés non encore posées dans Netlify — l'intégration n'est pas activée.
    return json(503, {
      error:
        "Paiement non configuré. Les clés Run Coaching ne sont pas encore en place.",
    });
  }

  // --- Lecture et validation du corps -------------------------------------
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Corps de requête invalide." });
  }

  const formuleCle = String(payload.formule || "").trim();
  const formule = FORMULES[formuleCle];
  if (!formule) {
    return json(400, { error: "Formule inconnue." });
  }

  const c = payload.customer || {};
  const prenom = String(c.prenom || "").trim();
  const nom = String(c.nom || "").trim();
  const email = String(c.email || "").trim();
  const telephone = String(c.telephone || "").trim();
  const consentement = payload.consentement === true;
  const renonciation = payload.renonciation === true;

  // Règle Central Files : prénom + nom séparés, téléphone OBLIGATOIRE.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!prenom || !nom || !emailOk || !telephone || !consentement) {
    return json(400, {
      error:
        "Champs requis manquants (prénom, nom, email valide, téléphone, consentement).",
    });
  }

  // Contenu numérique (mako) : la renonciation au droit de rétractation doit
  // être recueillie à l'achat (art. L221-28 C. conso — pack légal §4.2).
  // Le front l'exige déjà ; on revalide ici, le client ne peut pas contourner.
  if (formuleCle === "mako" && !renonciation) {
    return json(400, {
      error:
        "Pour un accès immédiat au contenu, la renonciation au droit de rétractation doit être cochée.",
    });
  }

  // --- Création du PaymentIntent via l'API REST Stripe --------------------
  const params = new URLSearchParams();
  params.set("amount", String(formule.montant_cents));
  params.set("currency", "eur");
  params.set("automatic_payment_methods[enabled]", "true");
  params.set("receipt_email", email); // reçu Stripe automatique (B2C)
  params.set("description", formule.motif);

  // Metadata : voyagent jusqu'au webhook → Make → Brevo/Airtable.
  const metadata = {
    source_site: "younousjonas.com",
    entite: "Run Coaching",
    tag_palier_source: formule.tag_palier_source || "N4_coaching",
    type_piece: "Reçu",
    motif: formule.motif,
    formule: formuleCle,
    price_id: formule.price_id,
    product_id: formule.product_id,
    prenom,
    nom,
    email,
    telephone,
  };
  // Preuve de recueil (horodatée par le PaymentIntent lui-même) : ne voyage
  // dans les métadonnées que pour le contenu numérique.
  if (formuleCle === "mako") {
    metadata.renonciation_retractation = "oui — accès immédiat demandé (L221-28)";
  }
  for (const [k, v] of Object.entries(metadata)) {
    params.set(`metadata[${k}]`, v);
  }

  try {
    const resp = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error("Stripe error:", data.error?.message || data);
      return json(502, {
        error: "Le paiement n’a pas pu être initié. Réessayez dans un instant.",
      });
    }

    return json(200, {
      client_secret: data.client_secret,
      payment_intent_id: data.id,
      publishable_key: publishableKey,
      montant_cents: formule.montant_cents,
    });
  } catch (err) {
    console.error("create-payment-intent failure:", err);
    return json(500, { error: "Erreur serveur lors de l’initialisation du paiement." });
  }
};

// Configuration des albums « BD personnelle ».
// Le catalogue est autoritatif côté serveur : le navigateur n'envoie jamais un prix.
// Ce dossier n'est pas une fonction (pas de bd-lib.mjs ni d'index.mjs) : Netlify l'embarque
// seulement comme dépendance des fonctions bd-*.

export const OFFRES = {
  '297': {
    code: '297',
    nom: 'Mon parcours en BD',
    libelle: 'Mon parcours en BD — album de 40 pages et couverture personnalisée (PDF)',
    montant: 29700,
    devise: 'eur',
    etape: 'Remplir votre questionnaire personnel. Younous vous adresse ensuite la proposition narrative de votre album.',
  },
  '891': {
    code: '891',
    nom: 'Mon histoire en BD',
    libelle: 'Mon histoire en BD — album de 80 pages, couverture personnalisée et deux entretiens d’une heure (PDF)',
    montant: 89100,
    devise: 'eur',
    etape: 'Remplir votre questionnaire personnel. Younous vous propose ensuite les deux entretiens d’une heure.',
  },
};

export function offre(code){ return Object.prototype.hasOwnProperty.call(OFFRES, String(code)) ? OFFRES[String(code)] : null; }

export function montantTexte(cents, devise){
  const v = (cents / 100).toFixed(2).replace('.', ',');
  return devise === 'eur' ? v + ' €' : v + ' ' + String(devise).toUpperCase();
}

// Durées (millisecondes).
export const DUREES = {
  lienPaiement: 14 * 24 * 3600e3,   // lien personnel de paiement
  lienAcces: 30 * 24 * 3600e3,      // lien personnel du questionnaire
  session: 12 * 3600e3,             // cookie de session
  retourPaiement: 2 * 3600e3,       // accès direct depuis la page de retour, une seule fois
};
export const UTILISATIONS_MAX_LIEN = 10;

// Lecture des variables d'environnement. Aucune valeur secrète n'est jamais renvoyée ni journalisée.
export function lireConfig(env = process.env){
  const mode = env.BD_PAYMENTS_MODE === 'live' ? 'live' : 'test';
  const sk = env.BD_STRIPE_SECRET_KEY || '';
  const pk = env.BD_STRIPE_PUBLISHABLE_KEY || '';
  const wh = env.BD_STRIPE_WEBHOOK_SECRET || '';
  const prefixeSk = mode === 'live' ? 'sk_live_' : 'sk_test_';
  const prefixePk = mode === 'live' ? 'pk_live_' : 'pk_test_';
  const raisons = [];
  if(env.BD_PAYMENTS_ENABLED !== 'true') raisons.push('BD_PAYMENTS_ENABLED différent de "true"');
  if(!sk.startsWith(prefixeSk)) raisons.push('BD_STRIPE_SECRET_KEY absente ou hors mode ' + mode);
  if(!pk.startsWith(prefixePk)) raisons.push('BD_STRIPE_PUBLISHABLE_KEY absente ou hors mode ' + mode);
  if(!wh.startsWith('whsec_')) raisons.push('BD_STRIPE_WEBHOOK_SECRET absente');
  if(mode === 'live' && env.BD_PAYMENTS_LIVE_CONFIRMED !== 'oui') raisons.push('mode live sans BD_PAYMENTS_LIVE_CONFIRMED=oui');
  const site = (env.BD_SITE_URL || env.URL || 'https://younousjonas.com').replace(/\/+$/, '');
  const origines = new Set(['https://younousjonas.com', 'https://www.younousjonas.com', site]);
  for(const k of ['URL', 'DEPLOY_PRIME_URL', 'DEPLOY_URL']) if(env[k]) origines.add(String(env[k]).replace(/\/+$/, ''));
  return {
    mode,
    paiementsActifs: raisons.length === 0,
    raisonsInactif: raisons,
    stripeSecret: sk,
    stripePublishable: pk,
    webhookSecret: wh,
    stripeApiVersion: env.BD_STRIPE_API_VERSION || '2026-03-25.dahlia',
    adminTokenHash: env.BD_ADMIN_TOKEN_SHA256 || '',
    site,
    origines,
    mailProvider: env.BD_MAIL_PROVIDER || 'none',
    adminEmail: env.BD_ADMIN_EMAIL || '',
  };
}

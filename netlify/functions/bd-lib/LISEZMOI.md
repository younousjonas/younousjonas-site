# Albums « BD personnelle » — fonctions, configuration, exploitation

Fichier interne au dépôt. Il n'est pas servi par le site : `_redirects` renvoie `/netlify/*` en 404.

## Parcours

Décision de Younous du 23-10-2026 : plus de demande d'intérêt ni de validation manuelle préalable. Offre → achat (coordonnées et paiement sur la même page) → confirmation et questionnaire privé après paiement vérifié.

1. **Offres** (`/bd-personnelle.html`). Les boutons mènent à `/achat-bd?offre=297` ou `?offre=891`. Les anciennes adresses (`/demande-bd`, `/demande-mon-parcours-en-bd`, `/demande-mon-histoire-en-bd`, `/paiement-bd`) redirigent en 301 vers l'achat de la bonne offre.
2. **Achat** (`/achat-bd`, fonction `bd-achat`).
   - `GET ?offre=` rend l'offre du catalogue serveur (libellé, montant) et dit si le paiement est ouvert.
   - **Paiement fermé** (cas par défaut) : la page le dit et n'affiche aucun formulaire. Un `POST` répond 503 sans rien enregistrer, pas même un compteur. Aucune demande n'est captée.
   - **Paiement ouvert** : prénoms, nom, adresse électronique, WhatsApp avec indicatif et déclaration, accord. Rien d'intime. Le serveur crée la commande au prix du catalogue, pour l'offre demandée (le montant envoyé par le navigateur est ignoré), ouvre la session Stripe, l'enregistre sur la commande, puis renvoie le secret client. Le Checkout se monte sur la même page.
   - **Double clic, nouvel essai** : la page tire une clé d'achat aléatoire à son chargement. L'index `achat/<empreinte>` (écriture « si nouveau ») lie cette clé à une seule commande, une offre et une adresse ; la clé d'idempotence Stripe `bd-cs-<commande>-achat` rend la même session. Une clé reprise avec une autre adresse ou une autre offre → 409.
   - **Abus** : pot de miel, origine contrôlée, 10 essais par heure par connexion, 5 par heure par adresse. Une commande déjà réglée → 409 `deja_paye`.
   - Stripe Embedded Checkout, `ui_mode=embedded_page`, version d'API épinglée `2026-03-25.dahlia`, comptant intégral (`mode=payment`), sans `payment_method_types` (moyens du compte Run Coaching selon l'éligibilité : carte, Klarna, PayPal…), sans échéancier.
3. **Demandes d'intérêt déjà reçues** : conservées telles quelles dans `bd-interets-production`, lisibles par `bd-admin` (`lister`). `bd-interet` répond désormais 410 et n'enregistre plus rien ; les actions `confirmer` et `nouveau-lien-paiement` répondent 410.
4. **Webhook** (`bd-stripe-webhook`). Il traite `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` et `checkout.session.expired`.
   - La signature est vérifiée, avec une tolérance de 5 minutes.
   - Chaque étape est idempotente. Un événement rejoué, par Stripe ou après une panne, aboutit au même état, sans seconde confirmation. Le marqueur de l'événement n'est posé qu'à la fin. Toute erreur renvoie 500, et Stripe réessaie.
   - La session doit être enregistrée sur la commande, en `mode=payment` et `payment_status=paid` (pour `completed` comme pour `async_payment_succeeded`).
   - Le serveur contrôle le montant, la devise, l'offre et le mode (test ou live).
   - Le statut « payé » vient du seul webhook, jamais de la page de retour.
   - Une confirmation à l'acheteur est mise en file. Une anomalie déclenche une alerte en file.
5. **Questionnaire personnel** (`/mon-album#cle=…`, fonctions `bd-acces` et `bd-questionnaire`).
   - Le lien est un jeton de 256 bits, dont seule l'empreinte SHA-256 est stockée. Il vaut 30 jours, pour 10 ouvertures au plus, et un seul lien est actif à la fois. Les ouvertures sont comptées par écriture conditionnelle : même simultanées, jamais plus de 10.
   - Le lien d'un message de la file est dérivé de l'identifiant du message (HMAC-SHA256 avec `BD_LINK_SECRET`). Une reprise reproduit donc le même lien, sans le remettre à zéro. Chaque émission voulue prend un rang (`generationLien`) : la confirmation est le rang 1, puis chaque récupération et chaque lien `lien-acces` de l'administration prend le rang suivant. Un message porte le rang de son lien. Un message dont le rang est dépassé est obsolète : repris ou relancé plus tard, il ne réactive jamais son ancien lien et passe à l'état `annule`. Le nouveau lien reste donc valable.
   - Un accès révoqué n'est jamais rouvert par la file : le message passe à l'état `annule`.
   - L'ouverture donne un cookie `__Host-bd_sess` (HttpOnly, Secure, SameSite=Strict, 12 h).
   - Le brouillon est enregistré côté serveur, par commande ; les réponses sont vérifiées côté serveur ; un seul envoi aboutit (création « si nouveau » des réponses).
   - La page de retour du paiement ouvre l'espace **une seule fois**, dans les 2 h qui suivent le paiement constaté (réclamation par écriture conditionnelle).
6. **File d'envoi** (`bd-outbox`, planifiée toutes les 15 min).
   - L'identifiant d'un message est tiré de sa clé de dédoublonnage et créé en une seule écriture « si nouveau ».
   - Avant l'envoi, le message est réservé (`en_cours`, verrou de 5 min) : deux traitements simultanés n'envoient qu'une fois ; un verrou expiré se reprend.
   - La fin d'un traitement n'écrit que s'il détient encore le verrou (`en_cours` et `verrou.par` = lui). Un traitement lent qui a dépassé son bail n'écrase ni le résultat ni le verrou de celui qui a repris le message (`bailsPerdus` au bilan).
   - La clé d'idempotence transmise au fournisseur est l'identifiant du message, stable d'une reprise à l'autre.
   - 6 essais (1 min, 5 min, 15 min, 1 h, 4 h, 12 h), puis l'état `echec`, visible.
   - Aucun lien en clair n'est stocké.
   - **Aucun fournisseur de courriel n'est branché** : les messages restent `en_attente_fournisseur`.

## Stockage (Netlify Blobs), séparé par contexte

- **Production** :
  - `bd-interets-production` conserve les demandes d'intérêt reçues avant le 23-10-2026. Plus rien n'y est écrit.
  - `bd-commandes-production-test` et `bd-commandes-production-live` portent les commandes, jetons, sessions et la file d'envoi. Un paiement de test ne touche jamais les commandes réelles.
- **Aperçus** (deploy-preview, branch-deploy, dev, contexte inconnu) : un magasin de déploiement (`getDeployStore`), visible de ce seul déploiement. Un aperçu n'ouvre jamais un magasin de production.
- **Contexte retenu** : celui que Netlify passe à la fonction (`context.deploy.context`), sinon `CONTEXT`. Tout ce qui n'est pas `production` est traité comme un aperçu.

## Écritures et atomicité

- Toute modification d'un objet passe par une écriture conditionnelle sur l'ETag (`onlyIfMatch`), relue et rejouée en cas de conflit (`maj`). Toute création passe par `onlyIfNew` (`creerSiNouveau`). La cohérence forte seule n'est pas présentée comme une garantie.
- Si la bibliothèque ne confirme pas l'écriture conditionnelle (champ `modified` absent), l'opération échoue (`ecriture_conditionnelle_non_supportee`) au lieu d'écrire sans garde. Dépendance : `@netlify/blobs` 10.x ; `set()` est appelé avec du JSON sérialisé.
- Il n'y a pas de transaction entre plusieurs clés. Chaque suite d'écritures est ordonnée pour qu'une panne laisse un état sûr et récupérable : les index (`jp/`, `ja/`, `cs/`) sont écrits avant la commande qui les valide, et un index orphelin ne donne aucun droit.
- Les compteurs de débit avancent aussi par écriture conditionnelle ; des conflits persistants font refuser la demande.

## Variables d'environnement (noms seulement ; jamais les valeurs dans le dépôt ni dans les journaux)

| Nom | Rôle | Défaut |
|---|---|---|
| `BD_PAYMENTS_ENABLED` | `true` pour ouvrir le paiement | fermé |
| `BD_PAYMENTS_MODE` | `test` ou `live` | `test` |
| `BD_PAYMENTS_LIVE_CONFIRMED` | `oui`, exigé en plus pour le mode live | refus du live |
| `BD_STRIPE_SECRET_KEY` | clé secrète Run Coaching **dédiée aux BD**, `sk_test_…` en test | absente |
| `BD_STRIPE_PUBLISHABLE_KEY` | `pk_test_…` / `pk_live_…`, selon le mode | absente |
| `BD_STRIPE_WEBHOOK_SECRET` | `whsec_…` de l'endpoint `/.netlify/functions/bd-stripe-webhook` | absente |
| `BD_STRIPE_API_VERSION` | version d'API épinglée | `2026-03-25.dahlia` |
| `BD_LINK_SECRET` | secret (32 caractères au moins) qui dérive les liens personnels des messages | absente : paiement fermé |
| `BD_STRIPE_RECEIPTS_CONFIRMED` | `oui` seulement après vérification que Stripe envoie bien les reçus sur ce compte ; ajoute la ligne « reçu » à la confirmation | ligne absente |
| `BD_ADMIN_TOKEN_SHA256` | **empreinte** SHA-256 du jeton d'administration (le jeton lui-même n'est stocké nulle part) | absente : admin fermé |
| `BD_SITE_URL` | URL publique pour les liens | `URL` de Netlify |
| `BD_ADMIN_EMAIL` | destinataire des alertes internes | `hello@younousjonas.com` dans les messages |
| `BD_MAIL_PROVIDER` | fournisseur de courriel ; aucun n'est pris en charge pour l'instant, donc le mode live reste fermé | `none` |

Les clés génériques du coaching (`STRIPE_SECRET_KEY`, etc.) ne sont jamais lues par ces fonctions. Toute clé hors du mode choisi ferme le paiement.

## Administration (exemples ; jeton jamais dans une conversation ni un fichier)

```
curl -s https://younousjonas.com/.netlify/functions/bd-admin -H "Authorization: Bearer $JETON" -H 'content-type: application/json' -d '{"action":"lister"}'
curl -s … -d '{"action":"lien-acces","commande":"CMD-…"}'                       # nouveau lien personnel (l'ancien est révoqué)
curl -s … -d '{"action":"revoquer-acces","commande":"CMD-…"}'
curl -s … -d '{"action":"reponses","commande":"CMD-…"}'
curl -s … -d '{"action":"relancer-envoi","id":"MSG-…"}'
```

## Webhook du coaching

`stripe-webhook.js` (même compte Stripe) ignore désormais tout événement dont l'objet porte `metadata.bd_commande` ou la description `BD personnelle — …`. Les paiements des albums ne partent donc ni vers Make ni vers Brevo. Ses autres paiements sont relayés comme avant (test 11).

**Litiges.** Un événement `charge.dispute.*` ne porte ni métadonnées ni description. Le webhook lit donc, en lecture seule (GET), la charge puis le paiement liés au litige, et ignore le litige s'ils portent `bd_commande` ou la description BD. Clé utilisée : `STRIPE_LITIGES_READ_KEY` (clé restreinte en lecture, recommandée) si elle est posée, sinon `STRIPE_SECRET_KEY` du même compte. Si la lecture échoue ou si aucune clé n'est disponible, le webhook répond 500 sans relayer : Stripe renvoie l'événement plus tard. Aucun litige n'est perdu, aucun litige d’album n’est relayé (test « litige d’un paiement BD »).

## Anciens formulaires Netlify (`biographies-parcours-297`, `biographies-histoire-891`)

- Leurs pages et leur moteur sont retirés ; leurs adresses redirigent vers l'achat direct de l'offre correspondante.
- La garde Edge `netlify/edge-functions/bd-formulaires-fermes.js` répond **410** à tout POST qui les vise, sur toutes les routes, en urlencoded comme en multipart. Elle lit toutes les valeurs `form-name` (`formData().getAll`), doublons compris, sans tenir compte de la casse ni des espaces ; un corps illisible qui contient un ancien nom est refusé. Les autres formulaires passent par `context.next()`.
- Les soumissions déjà reçues restent dans Netlify : rien n'est supprimé. Ne pas utiliser « Delete form ».

**Ordre de traitement.** La documentation officielle ne dit pas, à ma connaissance, si une fonction Edge passe avant la capture Netlify Forms. Seul un cas rapporté sur le forum Netlify montre qu'une réponse Edge empêche la capture. **Vérification à faire sur l'aperçu de déploiement :**

1. `POST /` avec `form-name=biographies-parcours-297` (urlencoded), puis `POST /une-page` en multipart. Attendu : 410, en-tête `x-bd-garde: formulaire-ferme`, **aucune nouvelle soumission** dans Forms.
2. `POST /` avec un `form-name` inconnu. Attendu : pas d'en-tête `x-bd-garde` ; la réponse est celle de Netlify.
3. Ne pas tester `leads-younousjonas` ni `feuille-de-jugement` : ils déclenchent Make ou des courriels internes.

## Tests

- `npm test` : 45 tests du parcours et 7 tests de garde du stockage. Achat direct (prix serveur, fermé sans capture, double clic, clé réutilisée, limites), concurrence et pannes injectées, reprises de la file, coordonnées corrigées avant paiement, retour après échec ou expiration. L'adaptateur refuse les ETag absents, les conditions d'écriture invalides et les succès de stockage non confirmés.
- `CHROMIUM_PATH=… PLAYWRIGHT_GLOBAL=$(npm root -g) node tests/e2e/e2e.mjs <dossier des captures, hors du dépôt>` : 66 vérifications navigateur (offres, achat fermé et ouvert, double clic, aucun questionnaire avant paiement, retour, espace, récupération), sur un serveur local avec les vraies fonctions, Stripe simulé, sans réseau.
- Un vrai test Stripe est **bloqué** tant que les clés de test `BD_*` n'existent pas.

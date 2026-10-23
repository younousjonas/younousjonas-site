# Albums « BD personnelle » — fonctions, configuration, exploitation

Fichier interne au dépôt. Il n'est pas servi par le site : `_redirects` renvoie `/netlify/*` en 404.

## Parcours

1. **Demande d'intérêt** (`/demande-bd`, fonction `bd-interet`). On y donne ses prénoms, son nom, son adresse électronique, un WhatsApp avec indicatif et la déclaration WhatsApp, puis l'offre (297 ou 891). Le projet est facultatif. La demande est enregistrée dans Netlify Blobs (magasin `bd-biographies`). Aucun courriel ne part.
2. **Projet confirmé** par Younous, via `bd-admin`, action `confirmer`. La commande est créée au prix serveur, et un lien personnel de paiement s'affiche une seule fois (`/paiement-bd#t=…`). Younous le transmet lui-même.
3. **Paiement intégré** (`/paiement-bd`, fonction `bd-paiement`) : Stripe Embedded Checkout, `ui_mode=embedded_page`, version d'API épinglée `2026-03-25.dahlia`.
   - Le paiement est comptant et intégral (`mode=payment`).
   - Aucun `payment_method_types` n'est imposé : Stripe affiche les moyens de la configuration du compte Run Coaching (carte, Klarna, PayPal…) selon l'éligibilité de chaque acheteur.
   - Aucun échéancier n'est géré ici.
4. **Webhook** (`bd-stripe-webhook`). Il traite `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` et `checkout.session.expired`.
   - La signature est vérifiée, avec une tolérance de 5 minutes.
   - Chaque événement n'est traité qu'une fois.
   - Le serveur contrôle le montant, la devise, l'offre et le mode (test ou live).
   - Le statut « payé » vient du seul webhook, jamais de la page de retour.
   - Une confirmation à l'acheteur est mise en file. Une anomalie déclenche une alerte en file.
5. **Questionnaire personnel** (`/mon-album#cle=…`, fonctions `bd-acces` et `bd-questionnaire`).
   - Le lien est un jeton aléatoire de 256 bits, dont seule l'empreinte SHA-256 est stockée. Il vaut 30 jours, pour 10 ouvertures au plus, et un seul lien est actif à la fois.
   - L'ouverture donne un cookie `__Host-bd_sess` (HttpOnly, Secure, SameSite=Strict, 12 h).
   - Le brouillon est enregistré côté serveur, par commande ; les réponses sont vérifiées côté serveur ; un seul envoi est possible.
   - La page de retour du paiement ouvre l'espace **une seule fois**, dans les 2 h qui suivent le paiement constaté.
6. **File d'envoi** (`bd-outbox`, planifiée toutes les 15 min). Elle fait 6 essais (1 min, 5 min, 15 min, 1 h, 4 h, 12 h), puis passe à l'état `echec`, visible. Le lien personnel est émis au moment de l'envoi : aucun lien en clair n'est stocké. **Aucun fournisseur de courriel n'est branché** : les messages restent `en_attente_fournisseur`.

## Stockage (Netlify Blobs), séparé par contexte

- **Production** :
  - `bd-interets-production` porte les demandes d'intérêt. Il ne dépend pas du mode Stripe : les demandes reçues en phase de test restent telles quelles à la bascule en live, sans migration.
  - `bd-commandes-production-test` et `bd-commandes-production-live` portent les commandes, jetons, sessions et la file d'envoi. Un paiement de test ne touche jamais les commandes réelles.
- **Aperçus** (deploy-preview, branch-deploy, dev, contexte inconnu) : un magasin de déploiement (`getDeployStore`), visible de ce seul déploiement. Un aperçu n'ouvre jamais un magasin de production.
- **Contexte retenu** : celui que Netlify passe à la fonction (`context.deploy.context`), sinon `CONTEXT`. Tout ce qui n'est pas `production` est traité comme un aperçu.

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
| `BD_ADMIN_TOKEN_SHA256` | **empreinte** SHA-256 du jeton d'administration (le jeton lui-même n'est stocké nulle part) | absente : admin fermé |
| `BD_SITE_URL` | URL publique pour les liens | `URL` de Netlify |
| `BD_ADMIN_EMAIL` | destinataire des alertes internes | `hello@younousjonas.com` dans les messages |
| `BD_MAIL_PROVIDER` | fournisseur de courriel | `none` |

Les clés génériques du coaching (`STRIPE_SECRET_KEY`, etc.) ne sont jamais lues par ces fonctions. Toute clé hors du mode choisi ferme le paiement.

## Administration (exemples ; jeton jamais dans une conversation ni un fichier)

```
curl -s https://younousjonas.com/.netlify/functions/bd-admin -H "Authorization: Bearer $JETON" -H 'content-type: application/json' -d '{"action":"lister"}'
curl -s … -d '{"action":"confirmer","interet":"INT-297-AAAAMMJJ-XXXXXX"}'      # crée la commande, renvoie le lien de paiement
curl -s … -d '{"action":"lien-acces","commande":"CMD-…"}'                       # nouveau lien personnel (l'ancien est révoqué)
curl -s … -d '{"action":"revoquer-acces","commande":"CMD-…"}'
curl -s … -d '{"action":"reponses","commande":"CMD-…"}'
curl -s … -d '{"action":"relancer-envoi","id":"MSG-…"}'
```

## Webhook du coaching

`stripe-webhook.js` (même compte Stripe) ignore désormais tout événement dont l'objet porte `metadata.bd_commande` ou la description `BD personnelle — …`. Les paiements des albums ne partent donc ni vers Make ni vers Brevo. Ses autres paiements sont relayés comme avant (test 11).

**Limite connue.** Un événement `charge.dispute.created` porte ni métadonnées ni description. Un litige sur un paiement d'album serait donc encore relayé, sauf à interroger l'API Stripe dans ce webhook.

## Anciens formulaires Netlify (`biographies-parcours-297`, `biographies-histoire-891`)

- Leurs pages et leur moteur sont retirés ; leurs adresses redirigent vers la demande courte.
- La garde Edge `netlify/edge-functions/bd-formulaires-fermes.js` répond **410** à tout POST qui les vise, sur toutes les routes, en urlencoded comme en multipart. Elle lit toutes les valeurs `form-name` (`formData().getAll`), doublons compris, sans tenir compte de la casse ni des espaces ; un corps illisible qui contient un ancien nom est refusé. Les autres formulaires passent par `context.next()`.
- Les soumissions déjà reçues restent dans Netlify : rien n'est supprimé. Ne pas utiliser « Delete form ».

**Ordre de traitement.** La documentation officielle ne dit pas, à ma connaissance, si une fonction Edge passe avant la capture Netlify Forms. Seul un cas rapporté sur le forum Netlify montre qu'une réponse Edge empêche la capture. **Vérification à faire sur l'aperçu de déploiement :**

1. `POST /` avec `form-name=biographies-parcours-297` (urlencoded), puis `POST /une-page` en multipart. Attendu : 410, en-tête `x-bd-garde: formulaire-ferme`, **aucune nouvelle soumission** dans Forms.
2. `POST /` avec un `form-name` inconnu. Attendu : pas d'en-tête `x-bd-garde` ; la réponse est celle de Netlify.
3. Ne pas tester `leads-younousjonas` ni `feuille-de-jugement` : ils déclenchent Make ou des courriels internes.

## Tests

- `node --test tests/bd.test.mjs` : 25 tests serveur.
- `CHROMIUM_PATH=… PLAYWRIGHT_GLOBAL=$(npm root -g) node tests/e2e/e2e.mjs <dossier>` : 78 vérifications navigateur, sur un serveur local avec les vraies fonctions, Stripe simulé, sans réseau.
- Un vrai test Stripe est **bloqué** tant que les clés de test `BD_*` n'existent pas.

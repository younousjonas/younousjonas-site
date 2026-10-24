# Conditions de commande BD — intégration et version de publication

## État de cette branche

La branche `codex/bd-conditions-preparation-20261024` contient les conditions des deux albums, leur acceptation avant paiement et leur remise dans la confirmation. Elle conserve l’affichage Klarna/PayPal du commit `274c320383aee27de5d7d763dcb9a6fd6ada7043`.

La version de publication est **`bd-2026-10-24-v1`, datée du 24 octobre 2026**. Elle remplace la version préparatoire active sans écraser sa copie conservable. Le propriétaire a demandé la publication des conditions avec un état transparent de la médiation, sans attendre son rattachement à un dispositif.

**La médiation reste en cours de mise en place.** Son nom et ses coordonnées sont encore à compléter en section 15. `hello@younousjonas.com` est l’adresse de réclamation du vendeur ; elle n’est pas présentée comme celle d’un médiateur indépendant. Aucun organisme ni rattachement n’a été inventé. La mise en ligne du document ne signifie pas que cette obligation est déjà entièrement satisfaite.

Le verrou technique attaché au statut préparatoire est retiré. Les achats restent gouvernés par les protections de paiement existantes : activation explicite, mode live confirmé, clés adaptées au mode, secret webhook, configuration des moyens, secret des liens et fournisseur de courriel complet. Des conditions publiables ne suffisent donc pas à ouvrir un paiement live incomplet. Ce lot est livré pour revue avant intégration sur `main`.

## Contacts et contenu

- Commandes, contact commercial et confirmations : `younousjonas@gmail.com`.
- Réclamations et demandes de correction d’un défaut : `hello@younousjonas.com`.
- Rétractation : le formulaire en ligne et les coordonnées opérationnelles déjà indiquées sont conservés.

Les offres à 297 € et 891 €, les délais, les quotas de retours, la validation du récit, la livraison numérique, les accords d’utilisation des documents et photos, la confidentialité et les droits légaux sont conservés. Le calendrier final de l’album à 891 € et ses retours restent convenus par écrit pour chaque projet. L’acceptation des CGV, le paiement et l’ouverture du questionnaire ne valent pas demande de commencement anticipé ou consentement éditorial.

## Acceptation et preuve conservée

La page présente une case CGV distincte, non cochée à l’avance. Le serveur fournit la version, sa date et le lien du texte téléchargeable. Un changement de version décoche la case et exige une nouvelle acceptation.

| Situation | Contrôle serveur |
| --- | --- |
| `conditionsAcceptees` absent, faux ou différent du booléen `true` | 422, sans commande ni session Stripe. |
| `versionConditions` absent ou différent de la version serveur | 409 `conditions_actualisees`, sans commande ni session Stripe. |
| Configuration de paiement incomplète ou ventes fermées | GET indisponible et POST 503 avant collecte. |
| Ancienne clé sans preuve de version correspondante | Nouvelle acceptation demandée ; aucune preuve rétroactive créée. |

La commande conserve dans `conditions` la version, la date de version, le statut, le texte intégral, son empreinte SHA-256 et `accepteesLe`, horodatage UTC de la première requête valide. L’index d’achat fixe version, empreinte et date avant la création de commande. Une reprise après panne conserve cette date ; une correction des coordonnées ne modifie pas la preuve.

Les métadonnées Checkout et PaymentIntent reprennent `bd_conditions_version`, `bd_conditions_date`, `bd_conditions_acceptees_le` et `bd_conditions_sha256`. La confirmation de paiement contient le texte intégral enregistré avec la commande, avec sa version et la date d’acceptation. Les reprises de la file relisent cette même copie, sans charger la page publique courante.

## Fichiers

| Fichier | Fonction |
| --- | --- |
| [`conditions-bd.html`](../conditions-bd.html) | Page source des quinze sections contractuelles. |
| [`conditions/bd-2026-10-24-v1.txt`](../conditions/bd-2026-10-24-v1.txt) | Copie active téléchargeable. |
| [`scripts/generer-conditions.py`](../scripts/generer-conditions.py) | Génération et contrôle de cohérence. |
| [`netlify/functions/bd-lib/conditions.mjs`](../netlify/functions/bd-lib/conditions.mjs) | Texte et métadonnées embarqués. |
| [`achat-bd.html`](../achat-bd.html), [`assets/bd-achat.js`](../assets/bd-achat.js) | Acceptation explicite avant paiement. |
| [`netlify/functions/bd-lib/handlers.mjs`](../netlify/functions/bd-lib/handlers.mjs) | Validation, preuve et copie dans le courriel. |
| [`netlify/functions/bd-lib/stripe.mjs`](../netlify/functions/bd-lib/stripe.mjs) | Métadonnées Stripe. |
| [`tests/bd-conditions.test.mjs`](../tests/bd-conditions.test.mjs), [`tests/bd.test.mjs`](../tests/bd.test.mjs) | Recette ciblée et fixtures du parcours. |

Le TXT préparatoire `bd-2026-10-24-preparatoire-2.txt` est conservé intact comme ancienne version. Le fichier `package.json` inclut la recette CGV et la vérification de génération. Aucun patch local, journal de test ou fichier temporaire n’est ajouté au dépôt.

Les blocs et la notice Klarna/PayPal de la page d’achat sont conservés. `bd-personnelle.html`, la CSS de financement et les SVG ne sont pas modifiés par ce lot.

## Vérifications

Le raccordement initial a passé 83 tests locaux et une seconde revue technique. Pour cette finalisation, la recette ciblée couvre l’acceptation obligatoire, la version imposée par le serveur, la conservation des preuves, les métadonnées, la copie du courriel, les contacts et l’état transparent de la médiation. Elle vérifie aussi un achat live entièrement simulé et le maintien de la fermeture pour chacun des prérequis de paiement manquant. Le générateur contrôle l’identité page/texte/module.

Depuis la racine du dépôt :

```bash
python scripts/generer-conditions.py --check
node tests/bd-conditions.test.mjs
npm test
```

La recette utilise des données synthétiques, un magasin en mémoire et des appels Stripe simulés. Elle ne crée aucun paiement réel et n’envoie pas de confirmation réelle. Les secrets et variables de production sont gérés séparément.

## Mises à jour ultérieures

Quand le dispositif de médiation sera effectivement établi, compléter la section 15 avec ses coordonnées et retirer la mention de mise en place en cours. Cette modification devra recevoir une nouvelle version et une date : ne pas réécrire une copie déjà figée.

Mettre à jour la page et le lien de téléchargement, exécuter `python scripts/generer-conditions.py`, puis la vérification `--check` et la recette ciblée. Intégrer ensemble la page, le nouveau TXT et le module. Conserver les anciennes copies et les preuves déjà enregistrées sur les commandes. Les protections de paiement restent indépendantes de ces mises à jour contractuelles.

## Références officielles utilisées

- [Conditions générales de vente — Service Public Entreprendre](https://entreprendre.service-public.gouv.fr/vosdroits/F33527).
- [L221-18 — rétractation](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032226842/).
- [L221-21 — rétractation en ligne](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000053310520) et [D221-5 — confirmation et accusé](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000053303365).
- [L221-25 — commencement anticipé](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044563179).
- [Médiation de la consommation — obligations du professionnel](https://www.economie.gouv.fr/mediation-conso/vous-etes-un-professionnel/vos-principales-obligations-0).

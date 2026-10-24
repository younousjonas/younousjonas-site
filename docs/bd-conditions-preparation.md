# Conditions de commande BD — préparation de l’intégration

## État de cette branche

La branche `codex/bd-conditions-preparation-20261024` prépare les conditions des deux albums, leur acceptation avant paiement et leur remise dans la confirmation. Elle part du commit d’affichage Klarna/PayPal `274c320383aee27de5d7d763dcb9a6fd6ada7043`.

**La version contractuelle reste préparatoire : `bd-2026-10-24-preparatoire-2`, datée du 24 octobre 2026.** La page le dit explicitement et le serveur bloque les nouveaux achats live pour cette version. La recette avec un paiement test reste possible. Cette branche n’est pas une autorisation de publication sur `main` ni d’ouverture du paiement réel.

La section 15 de la page doit encore recevoir **l’identité et les coordonnées du médiateur de la consommation effectivement compétent pour Run Coaching, avec confirmation de son rattachement à ce dispositif**. Aucun médiateur n’a été choisi ou souscrit dans ce lot. Les autres informations du vendeur, notamment le téléphone professionnel, sont renseignées.

## Contenu conservé

La page reprend les décisions commerciales existantes : offres à 297 € et 891 €, délais de proposition narrative connus, validation du récit, retours convenus, livraison numérique, utilisation autorisée des documents et photos, confidentialité, rétractation et garanties légales.

Le calendrier de remise de l’album final à 891 € et les retours sont convenus par écrit pour chaque projet. La commande reste distincte des accords éditoriaux. L’acceptation des CGV ne vaut pas demande de commencement anticipé, consentement photo ou autorisation de publication.

La version préparatoire 2 retire des sections 4 et 6 les phrases de pilotage interne relatives à une approbation manuelle, à un délai général de huit semaines et à des nombres appliqués par défaut. Elle ne modifie aucun délai, quota ou droit. La première copie locale déjà figée n’a pas été réécrite ; cette branche contient la nouvelle copie active.

## Parcours et preuve d’acceptation

La page d’achat présente une case CGV distincte, non cochée à l’avance. Le descriptif renvoyé par `bd-achat` fournit la version, sa date, le statut, le lien de la page et le lien du texte téléchargeable. Un changement de version décoche la case et nécessite une nouvelle acceptation explicite.

| Entrée ou situation | Contrôle côté serveur |
| --- | --- |
| `conditionsAcceptees` absent, faux ou différent du booléen `true` | Réponse 422 ; aucune commande ni session Stripe créée. |
| `versionConditions` absent ou différent de la version serveur | Réponse 409 `conditions_actualisees` ; aucune commande ni session Stripe créée. |
| Version préparatoire et mode live | Paiement indisponible sur GET ; réponse 503 sur POST avant toute collecte. |
| Ancienne clé d’achat sans preuve de version correspondante | Nouvelle acceptation demandée ; aucune preuve rétroactive inventée. |

Le serveur enregistre la copie suivante dans `commande.conditions` :

| Champ | Provenance |
| --- | --- |
| `version`, `dateVersion`, `statut` | Version générée depuis la page contractuelle. |
| `texte` | Texte intégral accepté, figé dans la commande. |
| `empreinteSha256` | Empreinte du texte intégral UTF-8. |
| `accepteesLe` | Date et heure UTC de la première requête valide, enregistrées par le serveur. |
| `page`, `url` | Liens de consultation et de téléchargement de la version. |

L’index d’achat conserve la version, l’empreinte et la date avant la création de commande. Une reprise après panne conserve cette date. Une correction des coordonnées ne remplace ni le texte ni l’horodatage. Les métadonnées de la session Checkout et du PaymentIntent reprennent `bd_conditions_version`, `bd_conditions_date`, `bd_conditions_acceptees_le` et `bd_conditions_sha256`.

La confirmation de paiement ajoute le texte intégral enregistré avec la commande dans le corps du courriel, avec la version et la date d’acceptation. Elle ne recharge pas la page publique courante. Les reprises de la file d’envoi utilisent cette même copie. Les anciens dossiers sans preuve d’acceptation ne reçoivent pas de preuve fictive.

## Fichiers

| Fichier | Fonction |
| --- | --- |
| [`conditions-bd.html`](../conditions-bd.html) | Page source des quinze sections contractuelles et avis préparatoire. |
| [`conditions/bd-2026-10-24-preparatoire-2.txt`](../conditions/bd-2026-10-24-preparatoire-2.txt) | Copie téléchargeable et conservable. |
| [`scripts/generer-conditions.py`](../scripts/generer-conditions.py) | Génération et contrôle de cohérence des copies. |
| [`netlify/functions/bd-lib/conditions.mjs`](../netlify/functions/bd-lib/conditions.mjs) | Texte et métadonnées embarqués dans les fonctions. |
| [`achat-bd.html`](../achat-bd.html), [`assets/bd-achat.js`](../assets/bd-achat.js) | Présentation et acceptation explicite avant paiement. |
| [`netlify/functions/bd-lib/handlers.mjs`](../netlify/functions/bd-lib/handlers.mjs) | Contrôles, preuve conservée et copie dans le courriel. |
| [`netlify/functions/bd-lib/stripe.mjs`](../netlify/functions/bd-lib/stripe.mjs) | Métadonnées Stripe. |
| [`tests/bd-conditions.test.mjs`](../tests/bd-conditions.test.mjs), [`tests/bd.test.mjs`](../tests/bd.test.mjs) | Recette ciblée et fixtures du parcours. |
| [`package.json`](../package.json) | Commandes de test et de vérification. |

Le bloc de financement, la notice de paiement et le lien CSS du commit de départ sont conservés dans `achat-bd.html`. Les seules insertions CGV sur cette page sont le bloc `#bda-q-conditions` après `#bda-q-consentement` et le lien de pied de page. `bd-personnelle.html`, la CSS de financement et les deux SVG sont identiques au commit de départ.

## Vérification

Le raccordement initial a passé 83 tests locaux : 8 pour les CGV, 52 pour le parcours, 16 pour la rétractation et 7 pour la garde du stockage, avec environnement vide et réseau bloqué. Une seconde relecture technique a vérifié l’immutabilité, la reprise après panne, la confirmation et les métadonnées.

Après la réconciliation avec l’affichage Klarna/PayPal et la correction rédactionnelle, les huit tests CGV ont été réexécutés. Le générateur a vérifié l’identité page/texte/module. La page d’achat a été comparée au commit de départ : retirer les deux insertions CGV redonne exactement son contenu, y compris les blocs marketing.

Depuis la racine du dépôt :

```bash
python scripts/generer-conditions.py --check
node tests/bd-conditions.test.mjs
npm test
```

Les tests utilisent des coordonnées synthétiques, un magasin en mémoire et des appels Stripe simulés. Cette recette vérifie la production du texte du courriel ; elle n’envoie pas de confirmation réelle de ces nouvelles conditions.

## Passage à la version définitive

1. Compléter la section 15 avec le médiateur effectivement compétent et ses coordonnées. Conserver les autres décisions commerciales.
2. Fixer une nouvelle version et sa date dans la page, mettre à jour le nom du téléchargement, puis retirer les avis préparatoires devenus sans objet. Le statut HTML `published` génère le statut serveur `publiee`.
3. Exécuter `python scripts/generer-conditions.py`, puis la vérification `--check`. La page, le nouveau TXT et le module doivent être intégrés ensemble. Ajuster le test spécifique au statut préparatoire au statut explicitement retenu.
4. Conserver les copies des versions déjà acceptées. Le générateur refuse de modifier un TXT différent sous le même identifiant. L’ouverture effective reste soumise aux réglages de paiement existants et à la décision de publication.

## Références officielles utilisées pour les clauses

- [Conditions générales de vente — Service Public Entreprendre](https://entreprendre.service-public.gouv.fr/vosdroits/F33527).
- [Code de la consommation, L221-18 — rétractation](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032226842/).
- [L221-21 — rétractation en ligne](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000053310520) et [D221-5 — récapitulatif, confirmation et accusé](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000053303365).
- [L221-25 — commencement anticipé](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044563179).
- [Médiation de la consommation — obligations du professionnel](https://www.economie.gouv.fr/mediation-conso/vous-etes-un-professionnel/vos-principales-obligations-0).

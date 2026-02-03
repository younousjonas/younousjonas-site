# younousjonas.com — site statique (Git + Netlify)

Ce dépôt contient un site statique prêt à déployer sur Netlify.

## Structure

- `index.html` : page d’accueil (inclut un **Diagnostic de condition**)
- `subrun/` : 9 mini-diagnostics SUBRUN
- `css/style.css` : styles
- `js/main.js` : calcul des scores + interprétation + champs cachés
- `merci.html` : page de confirmation après envoi de formulaire
- `netlify.toml` : configuration Netlify

## Remplacer le logo et la photo

- Logo : remplace `images/logo.png` par ton vrai logo (même nom)
- Photo : si tu veux l’utiliser plus tard, remplace `images/photo.jpg`

## Déploiement (résumé)

1. Mets ce projet dans un dépôt Git (GitHub / GitLab).
2. Dans Netlify : **New site from Git** → sélectionne ton dépôt.
3. Publish directory : `.` (racine).
4. Déploie.

## Formulaires

Le site utilise **Netlify Forms** (gratuit) :
- `diagnostic-condition` (page d’accueil)
- `diagnostic-subrun` (commun aux 9 diagnostics)

Dans Netlify → Forms : tu verras les soumissions.
Tu peux aussi activer une notification email dans Netlify (Forms → Settings → Notifications).

---
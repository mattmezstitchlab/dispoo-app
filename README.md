# dispoo-app
## État du dépôt

Ce dépôt ne contient **pas** encore le code source de Dispoo : seul le HTML pré-rendu, le CSS
compilé et l'API de la préversion Vercel sont accessibles publiquement. La source n'existe
dans aucune branche, aucun objet Git orphelin, ni aucun dépôt du compte.

`v1-kit/` réunit donc les correctifs V1 prêts à être appliqués dès que la source est versionnée
(routage `/e/{code}`, garde-fous d'API, durcissement SQL, copie française, script de recette) :

```bash
node v1-kit/scripts/mock-selftest.mjs      # valide le script de recette (2 mocks : prod actuelle / V1 visée)
bash v1-kit/scripts/verify-v1.sh https://<url-de-production>
```

Preuves et blocages constatés : `v1-kit/docs/STATE-AUDIT.md`.
Protocole de recette complet : `v1-kit/docs/ACCEPTANCE.md`.

## Déploiement Vercel

Le projet Vercel branché sur ce dépôt doit passer son étape `npm ci` : la racine
contient donc un `package.json` + `package-lock.json` minimaux (zéro dépendance)
et un script de build neutre :

```bash
npm ci          # OK grâce au package-lock.json
npm run build   # copie index.html (page de statut) vers dist/
```

- `index.html` (racine) : page de statut servie si Vercel sert la racine du dépôt
  (framework « Other » sans `outputDirectory`).
- `scripts/vercel-build.mjs` : génère `dist/index.html`, au cas où le projet Vercel
  aurait `outputDirectory: dist` (convention de `v1-kit/vercel.json`).
- `.gitignore` (racine) : copie de `v1-kit/.gitignore` — ignore `node_modules/`,
  `dist/`, secrets et artefacts de génération.

Dès que la vraie source de Dispoo sera versionnée ici, ce `package.json` sera à
remplacer par celui de l'application et `v1-kit/vercel.json` sera à copier à la racine.

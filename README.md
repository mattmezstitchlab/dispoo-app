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

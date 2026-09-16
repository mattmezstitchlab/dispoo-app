# Dispoo — V1 finishing kit

Ce dossier contient **uniquement des correctifs à appliquer** au projet Dispoo existant.
Il ne contient **pas** la source de l'application : elle n'existe nulle part de versionnée
(voir `docs/STATE-AUDIT.md`).

Règle de ce kit : **aucune réécriture, aucune nouvelle fonctionnalité.** Chaque fichier
correspond à un problème mesuré sur la production du 15/09/2026.

## Contenu

| Fichier | Résout |
|---|---|
| `vercel.json` | `/e/{code}` renvoyait un 404 Vercel → rewrite SPA qui **préserve `/api/*`** |
| `api/_lib/guard.js` | énumération par `?id=`, entrées non validées, erreurs Postgres exposées, `{"error":" introuvable"}` |
| `sql/001_v1_hardening.sql` | `created_at`/`updated_at` à `NULL` (tri instable + onglet « Passés » mort), unicité des participants/votes, `is_demo` |
| `docs/FRONT-ROUTING.md` | lire le code depuis l'URL, générer le lien de **production**, `lang="fr"`, OG, `min-w-[560px]`, `opacity-0 group-hover`, skeletons vs vide vs erreur |
| `docs/COPY-FR.md` | copier/coller des chaînes à corriger (accents + vocabulaire unique) |
| `scripts/verify-v1.sh` | **le test de production obligatoire** (§27/§28 du cahier des charges) |
| `.gitignore` | ce qui ne doit jamais être poussé |

## Ordre d'application

```bash
cp v1-kit/.gitignore .
cp v1-kit/vercel.json .
cp -r v1-kit/api/_lib api/          # puis câbler chaque endpoint (voir le fichier lui-même)
psql "$POSTGRES_URL" -f v1-kit/sql/001_v1_hardening.sql
# appliquer les patchs front décrits dans docs/FRONT-ROUTING.md
npm run build
grep -riE 'rrweb|arena|agon|__arena_rec' dist/ && echo "STOP: tooling de generation encore present"
bash v1-kit/scripts/verify-v1.sh https://<url-de-production>
```

## Ce que le kit ne peut pas faire à votre place

Le kit est **aveugle sur trois points**, parce que la source est introuvable :

1. le style réel de vos fonctions serverless (`(req,res)` Node ou `Request` Edge) ;
2. les noms exacts de tables/colonnes en base ;
3. l'implémentation des composants React (je n'ai pu lire que le HTML pré-rendu et le CSS compilé).

Les fichiers ci-dessus sont donc écrits aux conventions standard Vercel/Postgres et marqués
`TODO(verify)` partout où une adaptation au code réel est nécessaire.

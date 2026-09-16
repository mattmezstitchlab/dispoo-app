# Dispoo — Trouvez la date parfaite.

Proposez des créneaux, partagez un lien, laissez vos invités voter — sans compte.
Dispoo révèle le moment où tout le monde est disponible, puis l'organisateur
confirme le créneau définitif.

Ceci est l'application V1 complète. Elle remplace la page de statut qui occupait
temporairement ce dépôt (lequel ne contenait alors que le kit de correctifs).

## Démarrage local (2 minutes, sans base)

```bash
npm ci
npm run dev      # http://localhost:3000, stockage mémoire (données perdues au redémarrage)
npm test         # backend Postgres testé contre base émulée (pg-mem)
```

## Déploiement Vercel

1. Branchez ce dépôt à un projet Vercel (framework « Other », tout est déjà
   configuré : `vercel.json`, `npm ci`, `npm run build`).
2. **Branchez Postgres** — Vercel → projet → *Storage* → *Create database* → Postgres
   (ou Neon/Supabase) : la variable `POSTGRES_URL` est ajoutée automatiquement.
   Sans elle, l'API répond `503 Service temporairement indisponible` avec la
   marche à suivre, et l'app affiche un bandeau de configuration explicite.
3. Redéployez. **Le schéma se crée tout seul** au premier appel API
   (`CREATE/ALTER ... IF NOT EXISTS`, sûr sur base neuve comme pré-V1).
4. Recette :
   ```bash
   bash v1-kit/scripts/verify-v1.sh https://<url-de-production>
   CODE=<code> bash v1-kit/scripts/verify-v1.sh https://<url-de-production>
   ```
   Attendu : `PASS … FAIL 0`. Puis les checks manuels de `v1-kit/docs/ACCEPTANCE.md`
   (création, vote, mobile 390 px, aperçu WhatsApp/iMessage).

Variables : voir `.env.example`. `APP_URL` (optionnel) fige l'URL publique stable
dans les balises `og:*`/`canonical` ; sinon l'origine courante est utilisée.
Ne jamais utiliser `VERCEL_URL` (hôte de preview éphémère).

## Fonctionnement

| URL | Rôle |
|---|---|
| `/` | Accueil : créer, voter avec un code, mes événements (Tous / En cours / Confirmés / Passés) |
| `/e/{code}` | Page invitée : voter, résultats, partage — plus panneau organisateur si l'appareil a créé l'événement |
| `/api/events` | Détail par code · création (`POST`, 2 créneaux min) · confirmer/rouvrir (`PATCH` + token) · supprimer (`DELETE` + token) |
| `/api/options` · `/api/participants` · `/api/votes` | Créneaux · invités (organisateur seul) · votes (comptes publics, détail nominatif réservé à l'organisateur) |
| `/api/health` | Sonde : `{ ok, db: postgres \| memory \| none }` |

**Règles V1** (toutes issues du kit, toutes testées) :

- `GET /api/events` sans code → `400` ; `?id=N` → `403` : plus aucun listing
  public, plus d'énumération par entier.
- Invité : vote par code, ne voit que les comptes (jamais les prénoms des autres),
  ne peut ni modifier ni confirmer. Organisateur : token aléatoire créé avec
  l'événement, stocké haché (sha256), conservé dans son navigateur.
- `« Chloé » === « chloe »` : un seul invité (normalisation + unicité) ;
  revoter modifie, sans doublon (upserts idempotents).
- Faux code → `404 Événement introuvable` ; lien supprimé → `410` ;
  entrées invalides → `400` humain, **jamais** d'erreur Postgres au client.
- Événement confirmé : les votes sont refusés avec un `409` clair et écrit
  (« Votes clos ») — c'est la décision documentée du point 4.3 de la recette.
- Front : `lang="fr"`, vocabulaire unique (Événement / Créneau / Invité /
  Disponible / Peut-être / Indisponible / Confirmé), mobile 390 px sans scroll
  horizontal, `aria-pressed` sur les votes, anneaux `focus-visible`,
  `prefers-reduced-motion`, retry unique sur 5xx, `.ics` après confirmation.

## Structure

```
index.html            coquille SPA (meta fr + og:* + canonical, lang="fr")
assets/app.js         application (vanilla, zéro dépendance front)
assets/app.css        styles (mobile d'abord, ~6 tailles)
api/                  fonctions serverless Vercel (style (req, res))
api/_lib/guard.js     validation + erreurs FR (copie conforme du kit)
api/_lib/store.js     stockage : Postgres (auto-schéma) ou mémoire (dev)
public/               robots.txt, favicon.svg, og-cover.png (1200×630)
sql/schema.sql        schéma de référence (appliqué auto, cf. § Déploiement)
scripts/dev.mjs       serveur local (statique + /api, rewrite SPA)
scripts/test-pg.mjs   `npm test` : backend réel contre Postgres émulé
scripts/vercel-build.mjs  assemble dist/ + fige l'URL publique
v1-kit/               kit de correctifs d'origine (référence historique, inchangé)
```

## Notes

- L'écran post-création s'intitule « Votre événement est prêt » (le vocabulaire
  unique du kit a tranché : « Événement », pas « sondage »).
- `v1-kit/` est conservé tel quel comme preuve/audit ; `api/_lib/guard.js` en est
  la copie conforme (`diff` vide), câblée aux endpoints.
- Pistes V2 (hors périmètre) : rate limiting, `og:*` dynamiques par événement
  (middleware bots), reprise de propriété, rappels SMS.

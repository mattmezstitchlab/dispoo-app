# État constaté (preuves, 15/09/2026) — et ce qui bloque l'exécution

Toutes les lignes ci-dessous sont **mesurées**, pas déduites. Reproductibles avec `curl`
depuis n'importe quelle machine (le sandbox de cette session bloque le trafic sortant
vers `*.vercel.app`, donc les mesures ont été prises via un rendu distant, en GET uniquement).

## Blocages structurels (à lire avant tout le reste)

| # | Constat | Conséquence sur le cahier des charges |
|---|---|---|
| 1 | `mattmezstitchlab/dispoo-app` = **3 objets git au total** (1 commit, 1 arbre, `README.md` 12 o). Aucun objet dangling, aucun stash, pas de `refs/pull/*`, aucune autre branche, `size: 0`. | Les points §1-§23 (corriger) sont **inapplicables** : il n'y a rien à corriger. Le point §24 (« pousser le vrai code ») est **impossible sans la source**. |
| 2 | Source absente aussi du disque (`find /` sur `vite.config.*`/`package.json` : seul `/opt/yarn`), et des repos voisins (`DISPOORED` vide, `DISPOOWHITE` = README seul). | Aucune reconstruction fidèle possible. |
| 3 | `gh api user` → **403 « Resource not accessible by integration »** : le token de la session est un token d'installation GitHub App sans droits utilisateur. `git push --dry-run` sur la branche arena est accepté, mais les permissions de repo remontent `push:false`. | Commit local : oui. Push : **à tester en réel** (ci-dessous). PR : incertaine. |
| 4 | Aucune CLI Vercel installée, aucun token Vercel dans l'environnement, et je ne dois pas en demander. | §4, §5, §26, §27 **exécutables uniquement par vous** (ou via une intégration Vercel branchée dans Arena). |
| 5 | `GET /api/events?code=BAD` → `200 {"error":" introuvable"}` ; `GET /api/events?id=2` → `200` ; `GET /api/options?event_id=abc` → `invalid input syntax for type integer` ; `GET /api/options?event_id=2` → **500 au 1ᵉʳ appel, 200 au 2ᵈ** ; `<html lang="en">` ; aucune balise `og:*` ; HTML parse : 3 scripts inline dont `__arena_rec` + `rrweb@2.0.0-alpha.4` (jsdelivr) + « Agon Element Picker » écoutant `postMessage` (`arena:init`, `arena:text-edit`, réécriture `element.textContent`). | Ce sont exactement les 6 correctifs du kit — d'où `verify-v1.sh`, qui check chacun d'eux. |
| 6 | CSS compilée (`/assets/index-CE8-OTEt.css`, 5 blocs lus) : `@import` Google Fonts **en tête de fichier**, 17 `text-[NNpx]`, 7 rayons, 3 `disabled:opacity-*`, `min-w-[560px]` + `overflow-x-auto` **sans** `sticky left-0`, `opacity-0` + `group-hover:opacity-100` **sans** `focus-within`, **zéro** occurrence de `focus-visible`, zéro `prefers-reduced-motion`, breakpoints `@media(min-width:40rem)` et `64rem` uniquement. | Correctifs §10, §11, §12, §13, §20, §21, §22 du cahier des charges, détaillés dans `FRONT-ROUTING.md`. |
| 7 | `created_at` = `NULL` sur **100 %** des lignes de `events`, `options`, `participants`, `votes`, `tasks` ; `/api/events` renvoie les lignes dans l'ordre **2, 3, 4, 1, 5** ; ids 1-3 = seeds, 4-5 = créations réelles dont « QA Test Event » (1 créneau, description vide). | `sql/001_v1_hardening.sql` + la règle « 2 créneaux minimum » dans `guard.js`. |
| 8 | Production **inchangée** depuis l'audit : `etag: W/"1c9c726d0bd3e19eac437dae85b7edd5"`, `last-modified: Tue, 15 Sep 2026 12:12:06 GMT` (3 vérifications à ~5 h d'intervalle), `x-robots-tag: noindex` (preview). | Rien n'a été déployé ni corrigé entre-temps. |

## Le seul point où l'audit est bon

L'API **n'est pas vulnérable à l'injection SQL** : `?event_id=2 OR 1=1` échoue sur le
*typage du paramètre*, ce qui prouve des requêtes préparées. Le modèle de données est sain,
et le calcul du taux de participation est exact et déjà côté serveur
(12/13 ≈ 95 %, 4/4 = 100 %, recalculé à la main). C'est pour ça que le kit est
**additif** : garde-fous, dates, contrainte d'unicité, routage — pas de réécriture.

# Recette V1 — protocole de validation en prod

## 0. Automatique d'abord (30 s)

```bash
bash v1-kit/scripts/verify-v1.sh https://<url-de-production>          # lecture seule
CODE=<code_cree_au_pas_0> bash v1-kit/scripts/verify-v1.sh https://…  # + lookup par code
```

Doit sortir `PASS … FAIL 0`. Si ce n'est pas le cas, ne pas passer à la suite.
Pour valider le vérificateur lui-même : `node v1-kit/scripts/mock-selftest.mjs`.

## 1. Créer (compte neuf, navigation privée)

| # | Action | Attendu |
|---|---|---|
| 1.1 | Ouvrir `/` sur une base vierge | Un écran vide avec **un seul** CTA `Créer mon premier sondage` — pas de `0 evenements`, pas de `Mariage de Lea & Hugo` |
| 1.2 | Tenter de créer avec 1 créneau | **Bouton désactivé** + `Ajoutez au moins 2 créneaux` ; en forçant l'API (`POST /api/events` avec 1 option) → `400` |
| 1.3 | Titre vide / lieu vide | `400` + message nommé, pas un champ rouge sur écran vierge |
| 1.4 | Créer avec 2 créneaux valides | Arrive **directement** sur « Votre sondage est prêt » : code, lien complet, `Copier le lien`, `Partager`, aperçu. **Zéro** étape intermédiaire |
| 1.5 | Copier le lien | Le lien commence par le **domaine de production**, jamais `*.vercel.app` avec un hash de preview |

## 2. Partager / rejoindre

| # | Action | Attendu |
|---|---|---|
| 2.1 | Ouvrir `/e/CODE` (nouvel onglet, **refresh**) | L'écran invité s'affiche **sans** repasser par la home, et survit à F5 |
| 2.2 | Ouvrir `/e/ABC123` (code bien formé, inexistant) | `Événement introuvable` en français, **pas** un 404 Vercel, pas une page figée |
| 2.3 | Ouvrir `/e/AA` (code mal formé) | Le champ de saisie du code, propre, sans stack trace en console |
| 2.4 | Coller le lien dans WhatsApp **et** iMessage | Aperçu avec **image** + titre + description. C'est le test qui prouve §15 |
| 2.5 | Bouton retour du navigateur depuis `/e/CODE` | Revient à `/` (donc `pushState` câblé) |

## 3. Voter / modifier

| # | Action | Attendu |
|---|---|---|
| 3.1 | Sur iPhone réel ou 390 px | Voter **sans aucun scroll horizontal** |
| 3.2 | Voter yes / maybe / no sur les 2 créneaux → `Enregistrer mes disponibilités` | Écran `Merci !` + bouton `Modifier mes disponibilités` |
| 3.3 | Recharger `/e/CODE` sur le **même** appareil | Retrouve son vote (identifiant local du participant) ; ne recrée pas un 2ᵉ invité |
| 3.4 | Modifier un vote | Un seul enregistrement en base, `turnout` recalculé immédiat |
| 3.5 | Second invité, même appareil, autre nom | Vote indépendant ; le compteur passe à 2 |
| 3.6 | Saisir `Chloé` puis `chloe` depuis 2 navigateurs | **Un seul** invité (normalisation + contrainte d'unicité) |
| 3.7 | Voter sur 1 créneau sur 2 seulement | Le partially-voted est visible comme tel, et ne **compte pas** comme « dispo partout » |

## 4. Révéler / confirmer

| # | Action | Attendu |
|---|---|---|
| 4.1 | Tableau de résultats avant confirmation | Le meilleur créneau est mis en avant, avec le décompte exact `x/y` |
| 4.2 | `Choisir ce créneau` | Statut → `Confirmé`, date affichée ; l'onglet `Confirmés` contient la carte |
| 4.3 | Après confirmation, vote d'un nouvel invité | Comportement **délibéré et écrit** (soit refus clair, soit acceptation silencieuse) — pas d'ambiguïté |
| 4.4 | Passer la date finale dans le passé (`UPDATE events SET …`) | La carte bascule dans `Passés` → prouve que §8 (dates) fonctionne, ce que l'onglet n'a **jamais** pu faire pendant l'audit |
| 4.5 | `Ajouter au calendrier` (si §12 fait) | Le `.ics` s'ouvre avec la bonne date/heure **et le bon fuseau** (piège classique : `DTSTART` sans `TZID`) |

## 5. Sécurité (le cœur)

| # | Action | Attendu |
|---|---|---|
| 5.1 | `curl $P/api/events` | `400`/`401` — **jamais** la liste de tout le monde |
| 5.2 | `curl $P/api/events?id=1` puis `=2`, `=3` | `403`/`404` — l'énumération par entier est morte |
| 5.3 | `curl "$P/api/votes?event_id=1"` sans token | `401`/`403` |
| 5.4 | `PATCH /api/events` (ou DELETE) **sans** `x-owner-token` | `403`, et vérifié : **rien ne change en base** |
| 5.5 | Même requête avec le token d'un **autre** événement | `403` |
| 5.6 | `curl $P/api/options?event_id=abc` | `400` + message humain ; `grep -i 'invalid input syntax'` vide |
| 5.7 | Un invité qui devine le code d'un autre événement | Peut voter, **ne peut ni** voir les prénoms complets, **ni** modifier, **ni** confirmer |
| 5.8 | `grep -riE 'rrweb\|arena\|agon\|__arena_rec\|postMessage' dist/` | Vide |
| 5.9 | Dans la console du navigateur en prod | `window.postMessage({type:'arena:edit-mode',enabled:true},'*')` **sans aucun effet** |
| 5.10 | `curl -I $P/` | Pas de `x-robots-tag: noindex` (= URL de production) |

## 6. Finition

`lang="fr"` · `theme-color` · favicon qui ne saute pas au chargement · skeletons distincts du
vide · Tab traversant tous les contrôles avec un anneau visible · clic-milieu sur une carte
qui ouvre un onglet (donc c'est un vrai `<a href>`) · `F5` sur `/e/CODE` ne casse rien ·
17 tailles de texte revenues à ~6 · `prefers-reduced-motion` respecte le réglage système ·
FCP/LCP sous 2 s sur le profil Moto G Power (référence audit : 2,7 s) · Lighthouse accessibilité
sans régression.

## 7. Garde-fou de déploiement

En cas d'échec après mise en prod, l'alias Vercel précédent reste intact : **promote** puis
`git revert`. C'est pour ça que la bascule vers l'URL stable se fait **après** que
`verify-v1.sh` est vert sur la préversion, pas avant.

## Ce que personne n'a testé à votre place

La création, le vote, la modification, la confirmation, le mobile 390 px, `PATCH/DELETE`,
l'aperçu WhatsApp : **aucun de ces six points n'a pu être exécuté** dans l'environnement de
cette session (pas de source, navigateur interactif indisponible, trafic sortant bloqué vers
`*.vercel.app`, GET seuls possibles). Ce document est la liste exacte à faire — ou à me
donner la source + Vercel branché, et je les exécute.

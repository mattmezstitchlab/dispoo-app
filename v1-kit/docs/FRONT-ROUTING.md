# Patchs front — recette exacte, dans l'ordre

Tout est **local et incrémental** : pas de nouveau composant de plateforme, pas de routeur
ajouté si l'app n'en a pas, pas de store. Chaque bloc indique *où* aller et *quoi* changer.

---

## 1. Retirer le tooling de génération du build de production

Le HTML servi aujourd'hui contient trois scripts qui ne sont pas l'application :

| Signature à faire disparaître | Ce que c'est |
|---|---|
| `__arena_rec`, `rrweb`, `cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4` | enregistreur de session (clis, souris, frappes clavier, `sessionStorage`) |
| `Agon Element Picker`, `arena:init`, `arena:flush`, `arena:text-edit`, `__picker-overlay` | éditeur DOM piloté par `postMessage` depuis un parent |
| `data-source-loc` / `data-agon-source` | attributs d'instrumentation du plugin Vite de l'environnement |

**Comment** : ces injections viennent de l'environnement qui a « cuit » le `dist/`, pas de
votre source (le `vite.config.*` ne doit contenir aucun de ces noms — vérifiez avec
`grep -riE 'arena|agon|rrweb' . --exclude-dir=node_modules`). Le correctif réel est donc :
**rebâtir `dist/` depuis la source avec un `vite build` normal, et redéployer ce `dist/`**.

Garde-fou automatique à ajouter dans `package.json` :

```json
{ "scripts": {
    "build": "vite build",
    "verify:clean": "bash v1-kit/scripts/verify-v1.sh --html-only \"${PROD_URL:-https://localhost}\""
} }
```

et, en CI ou avant tout déploiement :

```bash
grep -riE 'rrweb|arena|agon|__arena_rec|postMessage' dist/ && { echo "build pollué"; exit 1; }
```

Le `grep` sur `dist/` est le **seul** test qui prouve que le nettoyage a eu lieu : le HTML
généré est la seule chose que l'invité reçoit.

---

## 2. La route `/e/{code}` — lire l'URL **avant** le premier fetch

Aujourd'hui : `GET /invite/LEAHU8` → 404 Vercel natif, et `GET /?code=LEAHU8` rend **exactement**
le même DOM que `/` (vérifié : `#root` identique, hero + onglets). La home ne consulte donc
aucun paramètre d'URL. Le serveur, lui, sait déjà faire (`GET /api/events?code=` renvoie
l'évènement + `final_option`).

Dans le composant racine, calculer la vue **de façon synchrone**, avant tout `useEffect` de
chargement de la liste — sinon l'invité voit la home pendant le fetch, ce qui est le bug
observé :

```js
const CODE_RE = /^[A-Z0-9]{6}$/

function readRoute () {
  const path = location.pathname.match(/^\/e\/([A-Za-z0-9]{4,10})\/?$/)
  const raw = path?.[1] ?? new URLSearchParams(location.search).get('code') ?? ''
  const code = raw.trim().toUpperCase()
  return CODE_RE.test(code) ? { name: 'invite', code } : { name: 'home' }
}

export default function App () {
  const [route, setRoute] = useState(readRoute)          // lazy initializer : lu une fois, au montage

  const go = (next) => {
    const url = next.name === 'invite' ? `/e/${next.code}` : '/'
    history.pushState(next, '', url)                      // <- sans ça, « retour » et refresh sont morts
    setRoute(next)
  }

  useEffect(() => {
    const onPop = () => setRoute(readRoute())             // bouton retour du navigateur
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  ...
}
```

Le support de `?code=` est conservé en repli : c'est ce paramètre que beaucoup d'invités
recevront par copier-coller, et il ne coûte rien.

## 3. Générer un lien de **production**, jamais de preview

Le lien affiché dans l'UI ne doit jamais être construit depuis `location.host` (sur la
pré-déploiement actuelle, il produirait `rrbh3f-bhey9h6g5-arcadawebapps6.vercel.app`, qui est
mort au déploiement suivant — et qui porte `x-robots-tag: noindex`).

```js
// src/config.js
export const APP_URL =
  import.meta.env.VITE_APP_URL?.replace(/\/$/, '') ||      // défini en prod : https://dispoo.app
  (import.meta.env.PROD && import.meta.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${import.meta.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : location.origin)                                       // dev local

export const inviteUrl = (code) => `${APP_URL}/e/${code}`
```

⚠️ **Ne pas utiliser `VERCEL_URL`** : c'est l'hôte de la *préversion* en cours de build,
c'est-à-dire précisément le bug à corriger.

Le bouton, sur la carte de partage et sur l'écran « votre sondage est prêt » :

```js
async function copy (url) {
  try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  catch { /* iOS Safari sans HTTPS/permission : on sélectionne le champ à la place */ input.select() }
}
```

et, si `navigator.share` existe (mobile → SMS/WhatsApp natifs), un bouton **Partager** à côté :

```js
{typeof navigator !== 'undefined' && navigator.share && (
  <button onClick={() => navigator.share({ title: event.title, url: inviteUrl(event.code) })}>
    Partager le sondage
  </button>
)}
```

## 4. Écran invité : le faux code doit être **humain**

`GET /api/events?code=BADCODE99` renvoie `200` avec `{"error":" introuvable"}` — chaîne
cassée, et statut qui dit « tout va bien ». Côté UI, distinguer les trois cas, sinon
l'invité reste sur un écran figé :

```js
if (!code || !CODE_RE.test(code)) return <Prompt code={code} onValid={load} />
if (state === 'loading')  return <InviteSkeleton code={code} />
if (state === 'notfound') return (
  <Empty title="Événement introuvable"
         text="Ce code ne correspond à aucun événement. Vérifiez les 6 caractères ou redemandez le lien."
         action={<Link href="/">Revenir à l’accueil</Link>} />
)
if (state === 'error')    return <Empty title="Une erreur est survenue" text="Réessayez dans un instant."
                                       action={<button onClick={load}>Réessayer</button>} />
```

## 5. Mobile : virer le `min-w-[560px]` du geste de vote

Le build actuel contient `min-w-[560px]` dans un conteneur `overflow-x-auto`, sans colonne
figée (`sticky left-0` absent du CSS compilé) : sur 390 px, **voter impose du scroll
horizontal**. C'est le geste central du produit.

```jsx
const wide = useMediaQuery('(min-width: 640px)')

if (!wide) {
  return (
    <ol className="space-y-4">
      {options.map((o) => (
        <li key={o.id} className="rounded-2xl border border-line p-5">
          <p className="text-[17px] font-semibold">{formatDay(o.day)}</p>      {/* Samedi 12 septembre */}
          <p className="mt-1 text-[13px] text-neutral-600 tabular-nums">
            {o.time_start} → {o.time_end}
          </p>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {['yes','maybe','no'].map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={vote === v}
                onClick={() => setVote(o.id, v)}
                className="rounded-xl border border-line py-3 text-[13px] font-semibold
                           focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:outline-none
                           data-[on=yes]:border-brand data-[on=yes]:bg-brand data-[on=yes]:text-white"
                data-on={vote === v ? v : undefined}
              >
                {LABEL[v]}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ol>
  )
}
/* desktop : la grille existante reste pertinente */
```

Cibles concrètes : **une zone tactile ≥ 44 px** (le `py-3` ci-dessus), `aria-pressed` sur
l'option choisie (aujourd'hui rien n'indique l'état sélectionné aux lecteurs d'écran), et
aucun scroll horizontal pour compléter un vote.

## 6. États : loading ≠ vide ≠ erreur

`animate-pulse` existe déjà dans le CSS (donc les skeletons sont prévus) mais la home affiche
`0 evenements / 0 invites / 0 votes dispo` **pendant** le fetch : sur mobile lent, l'app a l'air
vide. Et le bloc de stats duplique ce que chaque carte affiche déjà.

```jsx
if (loading) return <><HeroCompact /><CardSkeleton count={3} /></>
if (error)   return <Empty title="Impossible de charger vos événements" action={<button onClick={load}>Réessayer</button>} />
if (!items.length) return (
  <Empty title="Aucun sondage pour le moment"
         text="Créez un événement, ajoutez deux créneaux, partagez le lien."
         action={<button onClick={openCreate}>Créer mon premier sondage</button>} />
)
```

Décision recommandée : **supprimer le bloc `0 evenements / 0 invites / 0 votes` de la home**
(3 chiffres que l'utilisateur ne traite jamais) et garder un seul CTA par écran.

## 7. Retry léger sur les erreurs transitoires

Un `GET /api/options?event_id=2` a renvoyé **500** au premier appel, puis 200 au second
(cold start). Un invité qui clique au mauvais moment reste sur une erreur.

```js
async function api (path, { retry = 1, ...init } = {}) {
  for (let i = 0; i <= retry; i++) {
    try {
      const r = await fetch(path, init)
      if (r.status >= 500 && i < retry) { await sleep(350 * (i + 1)); continue }  // 1 seul retry, jamais de boucle
      return r
    } catch (e) {
      if (i === retry) throw e
      await sleep(350 * (i + 1))
    }
  }
}
```

## 8. Accessibilité : les actions cachées au survol

Le CSS compilé contient `opacity-0` **et** `.group-hover\:opacity-100`, **sans** aucun
`group-focus-within` et **sans** un seul `focus-visible` dans tout le build. Une action ainsi
portée est **inatteignable au tactile comme au clavier**.

```jsx
// avant
<button className="opacity-0 group-hover:opacity-100">Copier le lien</button>
// après
<button className="opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30">
  Copier le lien
</button>
```

Trois points à ajouter sans toucher au design :
- `focus-visible:ring-2 ring-ink/30` sur **tous** les boutons (le `focus:` actuel ne couvre que les champs) ;
- les cartes d'évènement deviennent de vrais liens : `<Link to={…}><h3>…</h3></Link>` — aujourd'hui
  **un seul `<a>` existe dans la page** (la home), donc pas de clic-milieu, pas d'ouverture
  en nouvel onglet, pas de retour arrière ;
- un `aria-label` explicite sur chaque bouton icône (`Copier le lien de partage`, `Supprimer l’événement`).

## 9. Le HTML de partage

`<html lang="en">` sur du contenu 100 % français (lu dans l'attribut réel du document), et
**aucune** balise `og:*`/`twitter:*`/`theme-color` : dans WhatsApp ou iMessage, un lien Dispoo
est un rectangle gris — pour un produit dont le seul canal d'acquisition est le lien partagé,
c'est une fonction manquante, pas du polish.

`index.html` :

```html
<html lang="fr">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dispoo — Trouvez le créneau où tout le monde est disponible</title>
    <meta name="description" content="Proposez des créneaux, partagez un lien, laissez vos invités voter. Dispoo révèle le moment où tout le monde est disponible." />
    <link rel="canonical" href="https://DOMAINE-PRODUCTION/" />
    <meta name="theme-color" content="#c8102e" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Dispoo" />
    <meta property="og:title" content="Dispoo — Trouvez le créneau parfait" />
    <meta property="og:description" content="Trois créneaux, un lien, tout le monde est d'accord." />
    <meta property="og:url" content="https://DOMAINE-PRODUCTION/" />
    <meta property="og:image" content="https://DOMAINE-PRODUCTION/og-cover.png" />
    <meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
  </head>
```

`public/og-cover.png` — 1200×630, **à produire** (je ne peux pas l'injecter sans la source) :
fond `#f5f4f3`, titre en Inter 800, mot « parfaite » en `#c8102e`, rien d'autre. Pas de
dégradé, pas d'illustration : le produit est déjà reconnaissable à sa typo. Les crawlers
(Facebook, LinkedIn) exigent un **PNG/JPG**, pas le SVG.

## 10. Police : sortir l'`@import` du chemin critique

Le CSS compilé **commence** par
`@import"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800"` : un
 aller-retour DNS+TLS bloquant avant toute peinture — cohérent avec le FCP/LCP mesurés à
2,7 s par Lighthouse mobile sur cette app de 2 écrans.

```bash
npm i @fontsource-variable/inter
```

```css
/* src/index.css */
@import '@fontsource-variable/inter';   /* auto-hébergée, préloadée par Vite, font-display: swap par défaut */
@theme { --font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif; }
```

Puis supprimer tout `@import url(fonts.googleapis…)` et **ne pas** mettre de `<link>` Google
Fonts dans `index.html` (une seule source, sinon deux chargements).

## 11. Réduire le périmètre (la V1 = créer → partager → voter → révéler → confirmer)

À retirer de la V1 **visible**, sans toucher aux tables (le SQL fourni ne supprime rien) :

- les **tâches** (`/api/tasks`, 8 entrées seedées en 3 phases, icônes lucide-react) : un
  second produit collé au sondage ;
- le champ **`program`** multilignes à la création : `whitespace-pre-wrap` prouve qu'il est
  affiché brut ; il allonge le formulaire sans servir la décision de date ;
- le champ **`description`** facultatif, et la colonne **`email`** jamais écrite.

Garder `location` (il répond à « où ? » dans le SMS partagé) et le calcul de taux de
participation affiché par créneau (c'est la promesse, et il est déjà fait côté serveur —
vérifié exact : 12/13 ≈ 95 %, 4/4 = 100 %).

## 12. Export calendrier : le seul ajout éventuel, et il est léger

À ne faire **que** si les 11 points ci-dessus sont validés en production. Aucune dépendance
n'est nécessaire — une chaîne de 12 lignes, générée côté client sur l'écran « confirmé » :

```js
const ics = (e, o) => ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Dispoo//FR','BEGIN:VEVENT',
  `UID:${e.code}-${o.id}@dispoo`, `DTSTAMP:${stamp()}`,
  `DTSTART:${compact(o.day, o.time_start)}`, `DTEND:${compact(o.day, o.time_end)}`,
  `SUMMARY:${e.title}`, `LOCATION:${e.location ?? ''}`,
  `DESCRIPTION:Vote clos sur Dispoo (${e.code})`, 'END:VEVENT','END:VCALENDAR'].join('\r\n')
```

`<a download="dispoo.ics" href="data:text/calendar;charset=utf-8,...">Ajouter au calendrier</a>`.
Un seul événement confirmé, pas de synchro récurrente : au-delà, c'est de la V2.

## 13. Validation à la création (miroir de l'API)

Le serveur acceptait 1 créneau et une description vide. Corriger **des deux côtés** ;
côté front, désactiver le bouton et nommer le manque, sans message rouge sur un champ vierge :

```jsx
const tooFew = options.length < 2
<button disabled={tooFew || !title.trim() || !location.trim()}>
  {tooFew ? 'Ajoutez au moins 2 créneaux' : 'Créer et partager'}
</button>
```

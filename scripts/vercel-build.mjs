/**
 * Build Vercel de Dispoo V1.
 *
 * L'application est volontairement sans étape de compilation (HTML + CSS + JS
 * vanilla, zéro dépendance côté front) : le build assemble `dist/` et fige
 * l'URL publique stable dans les balises de partage (og:*, canonical).
 *
 * Source de l'URL, par priorité :
 *   1. APP_URL (variable d'environnement posée à la main, ex. https://dispoo.app)
 *   2. VERCEL_PROJECT_PRODUCTION_URL (domaine de production du projet Vercel)
 *   3. rien → liens relatifs (dev local, previews)
 *
 * Ne JAMAIS utiliser VERCEL_URL ici : c'est l'hôte de la préversion en cours
 * de build, qui meurt au déploiement suivant (avec tous les liens partagés).
 */
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const dist = path.join(root, 'dist')

await mkdir(dist, { recursive: true })
await cp(path.join(root, 'index.html'), path.join(dist, 'index.html'))
await cp(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true })

const pub = path.join(root, 'public')
for (const f of await readdir(pub)) {
  await cp(path.join(pub, f), path.join(dist, f), { recursive: true })
}

const base = (
  process.env.APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
).replace(/\/$/, '')

const htmlPath = path.join(dist, 'index.html')
const html = await readFile(htmlPath, 'utf8')
await writeFile(htmlPath, html.split('__APP_URL__').join(base))

console.log(`[dispoo-build] OK — dist/ assemblé (url publique : ${base || '(relative)'})`)

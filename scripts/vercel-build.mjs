/**
 * Build Vercel minimal pour le dépôt « kit ».
 *
 * Ce dépôt ne contient pas la source de l'application Dispoo (voir README.md) :
 * il n'y a donc rien à compiler. Le build copie la page de statut racine
 * (index.html) vers dist/ afin que le déploiement soit valide quelle que soit
 * la configuration du projet Vercel :
 *  - framework « Other » sans outputDirectory → Vercel sert la racine (index.html) ;
 *  - outputDirectory « dist » (cf. v1-kit/vercel.json) → Vercel sert dist/index.html.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const dist = path.join(root, 'dist')

await mkdir(dist, { recursive: true })
await copyFile(path.join(root, 'index.html'), path.join(dist, 'index.html'))

console.log('[dispoo-build] OK — dist/index.html généré (page de statut, aucune source à compiler)')

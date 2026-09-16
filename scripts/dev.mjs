/**
 * Serveur de dev local (sans dépendance) : fichiers statiques + fonctions /api/*.
 *
 *   npm run dev   → http://localhost:3000
 *
 * - `/api/*` est exécuté avec les vrais handlers de `api/` (style (req, res),
 *   donc compatibles tels quels avec Vercel et avec node:http) ;
 * - toute autre route sans extension retombe sur `index.html` (rewrite SPA,
 *   même comportement que `vercel.json`) ;
 * - sans POSTGRES_URL, le stockage mémoire est utilisé (données perdues au
 *   redémarrage — voir `api/_lib/store.js`).
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV ??= 'development'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 3000)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon'
}

const handlers = new Map()

async function apiHandler (name) {
  if (!/^[a-z]+$/.test(name)) return null
  if (!handlers.has(name)) {
    try {
      handlers.set(name, (await import(`../api/${name}.js`)).default)
    } catch {
      handlers.set(name, null)
    }
  }
  return handlers.get(name)
}

async function readStatic (pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname
  // `public/` prime (robots.txt, favicon, og-cover), puis la racine.
  for (const base of [path.join(root, 'public'), root]) {
    const file = path.normalize(path.join(base, `.${rel}`))
    if (!file.startsWith(base)) continue
    try {
      const body = await readFile(file)
      return { body, type: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'EISDIR') throw err
    }
  }
  return null
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://dev')
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice('/api/'.length).split('/')[0] || 'health'
      const handler = await apiHandler(name)
      if (!handler) {
        res.statusCode = 404
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'Ressource introuvable' }))
        return
      }
      await handler(req, res)
      return
    }
    const found = await readStatic(url.pathname)
    if (found) {
      res.statusCode = 200
      res.setHeader('content-type', found.type)
      res.end(found.body)
      return
    }
    if (!path.extname(url.pathname)) {
      // Rewrite SPA : /e/CODE (et le reste) → index.html, en 200.
      const fallback = await readStatic('/index.html')
      res.statusCode = 200
      res.setHeader('content-type', MIME['.html'])
      res.end(fallback.body)
      return
    }
    res.statusCode = 404
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Introuvable')
  } catch (err) {
    console.error('[dev]', err)
    if (!res.writableEnded) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'Une erreur est survenue. Réessayez.' }))
    }
  }
})

server.listen(PORT, '0.0.0.0', async () => {
  const { dbKind } = await import('../api/_lib/store.js')
  const label = { postgres: 'postgres', memory: 'mémoire (dev)', none: 'AUCUNE — 503, voir README' }[dbKind()]
  console.log(`[dispoo-dev] http://localhost:${PORT} (stockage : ${label})`)
})

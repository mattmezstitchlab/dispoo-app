/**
 * Auto-test du vérificateur.
 *
 * Un script de validation qu'on ne peut pas tester ne vaut rien. Ce fichier lève deux
 * serveurs localhost qui imitent des réponses Vercel, puis lance verify-v1.sh contre
 * chacun d'eux :
 *
 *   mock = "broken" → reproduit les comportements EXACTEMENT MESURÉS en production le
 *                      15/09/2026 (lang="en", rrweb/Agon présents, /api/events public,
 *                      ids énumérables, erreur Postgres au client, " introuvable", 404
 *                      sur /e/CODE, noindex de preview). verify-v1.sh doit sortir en FAIL.
 *   mock = "fixed"  → le comportement V1 visé par le kit. verify-v1.sh doit sortir en PASS.
 *
 *   node v1-kit/scripts/mock-selftest.mjs
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'verify-v1.sh')

const BROKEN_HTML = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><title>Dispoo — Trouvez la date parfaite</title>
<meta name="description" content="Proposez des creneaux, partagez un lien.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" crossorigin href="/assets/index-CE8-OTEt.css">
<script>window.addEventListener("message",function(e){if(e.data.type==="arena:init"){}});
var SK="__arena_rec";var RRWEB_CDN="https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4/dist/rrweb.min.js";</script>
</head><body><div id="root">
<div class="min-h-screen bg-white text-ink"><header>Nouvel evenement</header>
<h1>Trouvez la date<br>parfaite.</h1><p>Voter</p><span>0</span> evenements</div>
</div>
<script>/* Agon Element Picker — data-source-loc — __picker-overlay */</script>
</body></html>`

const FIXED_HTML = `<!doctype html><html lang="fr"><head>
<meta charset="UTF-8"><title>Dispoo — Trouvez le créneau où tout le monde est disponible</title>
<meta name="description" content="Proposez des créneaux, partagez un lien, laissez vos invités voter.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#c8102e">
<link rel="canonical" href="https://dispoo.app/">
<meta property="og:type" content="website"><meta property="og:title" content="Dispoo">
<meta property="og:description" content="Trouvez le créneau parfait.">
<meta property="og:image" content="https://dispoo.app/og-cover.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/index.css">
</head><body><div id="root"><header><a href="/">Dispoo</a><button>Nouvel événement</button></header>
<main><h1>Trouvez le créneau parfait.</h1><button>Voter avec un code</button></main></div>
<script type="module" src="/assets/index.js"></script></body></html>`

function serve (mode) {
  const broken = mode === 'broken'
  const json = (res, code, obj, extra = {}) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...(broken ? {} : { 'cache-control': 'no-store' }), ...extra })
    res.end(JSON.stringify(obj))
  }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(broken ? { 'x-robots-tag': 'noindex' } : {}) })
      return res.end(broken ? BROKEN_HTML : FIXED_HTML)
    }
    if (p === '/favicon.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>') }
    if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow:\n') }

    // routage /e/{code}
    if (/^\/e\//.test(p)) {
      if (broken) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<html><body><h1>This page doesn’t exist</h1>404: NOT_FOUND</body></html>') }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(FIXED_HTML)
    }

    if (p === '/api/events') {
      if (broken) {
        if (u.searchParams.get('code')) {
          const c = u.searchParams.get('code').toUpperCase()
          if (c === 'LEAHU8') return json(res, 200, { id: 2, code: 'LEAHU8', status: 'sondage', created_at: null, final_option: null })
          return json(res, 200, { error: ' introuvable' })
        }
        return json(res, 200, [{ id: 2, code: 'LEAHU8', status: 'sondage' }, { id: 5, code: 'XJCV7K', title: 'QA Test Event' }])
      }
      if (u.searchParams.has('id')) return json(res, 403, { error: 'Accès non autorisé' })
      if (u.searchParams.get('code')) {
        const c = u.searchParams.get('code').toUpperCase()
        if (c === 'LEAHU8') return json(res, 200, { id: 2, code: 'LEAHU8', status: 'sondage', created_at: '2026-09-15T12:00:00Z', updated_at: '2026-09-15T12:00:00Z', final_option: null })
        return json(res, 404, { error: 'Événement introuvable', hint: "Vérifiez le code à 6 caractères." })
      }
      return json(res, 401, { error: 'Code requis', hint: "Ajoutez le code de l'événement." })
    }

    if (p === '/api/health') return json(res, broken ? 404 : 200, { ok: true })

    if (['/api/options', '/api/votes', '/api/participants', '/api/tasks'].includes(p)) {
      const id = u.searchParams.get('event_id')
      if (broken) {
        if (id === null) return json(res, 200, { error: 'event_id requis' })
        if (!/^\d+$/.test(id)) return json(res, 200, { error: 'invalid input syntax for type integer: "' + id + '"' })
        return json(res, 200, [])
      }
      if (!u.searchParams.get('code') && !req.headers['x-owner-token']) return json(res, 403, { error: 'Accès non autorisé' })
      if (id !== null && !/^\d{1,9}$/.test(id)) return json(res, 400, { error: 'Requête invalide' })
      if (id === '99999') return json(res, 404, { error: 'Événement introuvable' })
      return json(res, 200, [])
    }

    res.writeHead(broken ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(broken ? '<html><body>404: NOT_FOUND</body></html>' : FIXED_HTML)
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })))
}

async function run (label, port, expect) {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, `http://127.0.0.1:${port}`], { env: { ...process.env, CODE: 'LEAHU8' }, stdio: 'inherit' })
    child.on('exit', (code) => {
      const ok = (expect === 'fail' && code !== 0) || (expect === 'pass' && code === 0)
      console.log(`\n[${ok ? 'OK' : 'INCOHERENT'}] mock « ${label} » → exit ${code} (attendu : ${expect === 'fail' ? '≠0' : '0'})\n`)
      resolve(ok)
    })
  })
}

const a = await serve('broken')
const passA = await run('broken (prod mesurée du 15/09)', a.port, 'fail')
a.srv.close()

const b = await serve('fixed (V1 visée)')
const passB = await run('fixed (V1 visée)', b.port, 'pass')
b.srv.close()

if (passA && passB) {
  console.log('✔ verify-v1.sh discrimine correctement : FAIL sur la prod actuelle, PASS sur la V1 visée.')
  process.exit(0)
}
console.log('✘ le vérificateur ne se comporte pas comme attendu — à corriger avant de s\'y fier.')
process.exit(1)

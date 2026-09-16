/**
 * Dispoo V1 — /api/health
 *
 * Sonde diagnostique (toujours 200) : indique quel stockage répond.
 * `db: "postgres"` → base branchée · `db: "memory"` → dev local ·
 * `db: "none"` → production sans POSTGRES_URL (les autres endpoints répondent 503).
 */
import { ok, wrap } from './_lib/guard.js'
import { dbKind } from './_lib/store.js'

export default wrap(async function healthHandler (req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (req.method !== 'GET') return ok(res, { ok: true })
  return ok(res, { ok: true, app: 'dispoo', version: 1, db: dbKind(), time: new Date().toISOString() })
})

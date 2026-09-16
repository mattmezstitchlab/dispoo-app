/**
 * Dispoo V1 — /api/options
 *
 * GET ?event_id=N&code=XXXXXX → créneaux de l'événement.
 * - `event_id` mal formé (abc, -1, 1e9, absent…) → 400, message humain,
 *   jamais d'erreur Postgres au client ;
 * - code absent/mal formé → 400 ; événement inconnu → 404 ;
 * - code d'un autre événement → 403 ; lien archivé → 410.
 */
import { E, ok, parseCode, parseEventId, query, send, wrap } from './_lib/guard.js'
import { DB_DOWN, getStore, isDbNotConfigured } from './_lib/store.js'

export default wrap(async function optionsHandler (req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (req.method !== 'GET') return send(res, { status: 405, error: 'Méthode non autorisée' })
  let store
  try {
    store = await getStore()
  } catch (err) {
    if (isDbNotConfigured(err)) return send(res, DB_DOWN)
    throw err
  }

  const q = query(req)
  const eventId = parseEventId(q.get('event_id'))
  if (eventId == null) return send(res, E.BAD_REQUEST)

  const rawCode = q.get('code')
  if (rawCode == null) return send(res, E.NEED_CODE)
  const code = parseCode(rawCode)
  if (!code) return send(res, E.NEED_CODE)

  const event = await store.getEventById(eventId)
  if (!event) return send(res, E.EVENT_NOT_FOUND)
  if (event.archived_at) return send(res, E.LINK_EXPIRED)
  if (String(event.code).trim() !== code) return send(res, E.FORBIDDEN)

  return ok(res, { options: await store.listOptions(eventId) })
})

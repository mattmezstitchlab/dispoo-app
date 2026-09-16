/**
 * Dispoo V1 — /api/participants
 *
 * GET  ?event_id=N&code=XXXXXX + x-owner-token → liste des invités (organisateur seul).
 * POST {code, name} → inscrit (ou retrouve) l'invité ; « Chloé » === « chloe ».
 *      Un événement confirmé refuse les nouveaux votes (409, refus clair et écrit).
 */
import {
  E, isOwner, normalizeName, ok, parseCode, parseEventId, query, readJson, send, wrap
} from './_lib/guard.js'
import { DB_DOWN, getStore, isDbNotConfigured } from './_lib/store.js'

const VOTING_CLOSED = {
  status: 409,
  error: 'Votes clos',
  hint: 'Cet événement est confirmé : l’organisateur a déjà choisi le créneau.'
}

async function loadByIdAndCode (req, res, store, rawId, rawCode) {
  const eventId = parseEventId(rawId)
  if (eventId == null) {
    send(res, E.BAD_REQUEST)
    return null
  }
  if (rawCode == null) {
    send(res, E.NEED_CODE)
    return null
  }
  const code = parseCode(rawCode)
  if (!code) {
    send(res, E.NEED_CODE)
    return null
  }
  const event = await store.getEventById(eventId)
  if (!event) {
    send(res, E.EVENT_NOT_FOUND)
    return null
  }
  if (event.archived_at) {
    send(res, E.LINK_EXPIRED)
    return null
  }
  if (String(event.code).trim() !== code) {
    send(res, E.FORBIDDEN)
    return null
  }
  return event
}

async function handleGet (req, res, store) {
  const q = query(req)
  const event = await loadByIdAndCode(req, res, store, q.get('event_id'), q.get('code'))
  if (!event) return
  if (!isOwner(req, event)) return send(res, E.FORBIDDEN)
  return ok(res, { participants: await store.listParticipants(event.id) })
}

async function handlePost (req, res, store) {
  const body = await readJson(req)
  if (!body || typeof body !== 'object') return send(res, E.BAD_REQUEST)
  const code = parseCode(body.code)
  if (!code) return send(res, E.NEED_CODE)
  const event = await store.getEventByCode(code)
  if (!event) return send(res, E.EVENT_NOT_FOUND)
  if (event.archived_at) return send(res, E.LINK_EXPIRED)
  if (event.status === 'confirme') return send(res, VOTING_CLOSED)
  const normalized = normalizeName(body.name)
  if (!normalized) return send(res, E.NAME_REQUIRED)

  const name = String(body.name).trim().replace(/\s+/g, ' ')
  const { participant, created } = await store.upsertParticipant(event.id, name, normalized)
  return ok(res, { participant, created }, created ? 201 : 200)
}

export default wrap(async function participantsHandler (req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  let store
  try {
    store = await getStore()
  } catch (err) {
    if (isDbNotConfigured(err)) return send(res, DB_DOWN)
    throw err
  }
  if (req.method === 'GET') return handleGet(req, res, store)
  if (req.method === 'POST') return handlePost(req, res, store)
  return send(res, { status: 405, error: 'Méthode non autorisée' })
})

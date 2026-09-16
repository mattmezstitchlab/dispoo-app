/**
 * Dispoo V1 — /api/votes
 *
 * GET  ?event_id=N&code=XXXXXX → comptes par créneau (public) ;
 *      + x-owner-token → détail nominatif (organisateur seul).
 * POST {code, name?, participant_id?, votes:[{option_id, value}]} → upsert idempotent ;
 *      revoter avec le même prénom modifie le vote, sans doublon.
 *      Un événement confirmé refuse les votes (409, refus clair et écrit).
 */
import {
  E, isOwner, normalizeName, ok, parseCode, parseEventId, parseVotes,
  query, readJson, send, wrap
} from './_lib/guard.js'
import { DB_DOWN, getStore, isDbNotConfigured } from './_lib/store.js'

const VOTING_CLOSED = {
  status: 409,
  error: 'Votes clos',
  hint: 'Cet événement est confirmé : l’organisateur a déjà choisi le créneau.'
}

async function handleGet (req, res, store) {
  const q = query(req)
  const eventId = parseEventId(q.get('event_id'))
  if (eventId == null) return send(res, E.BAD_REQUEST)

  const rawCode = q.get('code')
  if (rawCode == null) return send(res, E.FORBIDDEN)
  const code = parseCode(rawCode)
  if (!code) return send(res, E.FORBIDDEN)

  const event = await store.getEventById(eventId)
  if (!event) return send(res, E.EVENT_NOT_FOUND)
  if (event.archived_at) return send(res, E.LINK_EXPIRED)
  if (String(event.code).trim() !== code) return send(res, E.FORBIDDEN)

  const counts = await store.countsByOption(eventId)
  if (!isOwner(req, event)) return ok(res, { counts })
  return ok(res, { counts, detail: await store.listVotesDetailed(eventId) })
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

  const votes = parseVotes(body.votes)
  if (!votes) return send(res, E.BAD_REQUEST)

  // Tous les créneaux votés doivent appartenir à CET événement.
  const options = await store.listOptions(event.id)
  const mine = new Set(options.map((o) => o.id))
  for (const v of votes) {
    if (!mine.has(v.option_id)) return send(res, E.BAD_REQUEST)
  }

  let participant
  if (body.participant_id != null) {
    const pid = parseEventId(body.participant_id)
    if (pid == null) return send(res, E.BAD_REQUEST)
    participant = await store.getParticipantById(pid)
    if (!participant || participant.event_id !== event.id) return send(res, E.FORBIDDEN)
  } else {
    const normalized = normalizeName(body.name)
    if (!normalized) return send(res, E.NAME_REQUIRED)
    const name = String(body.name).trim().replace(/\s+/g, ' ');
    ({ participant } = await store.upsertParticipant(event.id, name, normalized))
  }

  const saved = []
  for (const v of votes) {
    saved.push(await store.upsertVote(v.option_id, participant.id, v.value))
  }
  return ok(res, {
    participant,
    votes: saved.map((v) => ({ option_id: v.option_id, value: v.value })),
    counts: await store.countsByOption(event.id)
  })
}

export default wrap(async function votesHandler (req, res) {
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

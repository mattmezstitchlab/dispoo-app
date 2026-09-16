/**
 * Dispoo V1 — /api/events
 *
 * GET    ?code=XXXXXX        → détail (événement + créneaux + créneau final + comptes)
 * GET    (sans code)         → 400 · GET ?id=N → 403 (énumération fermée)
 * POST   {title, location, options[]} → 201 + owner_token (rendu une seule fois)
 * PATCH  {code, final_option_id | null} + x-owner-token → confirmer / rouvrir
 * DELETE ?code=XXXXXX + x-owner-token → archiver (les lectures suivantes → 410)
 */
import {
  E, isOwner, newOwnerToken, ok, parseCode, parseEventId, parseLocation,
  parseOptions, parseTitle, query, readJson, send, wrap
} from './_lib/guard.js'
import { DB_DOWN, generateCode, getStore, isDbNotConfigured, serializeEvent } from './_lib/store.js'

const METHOD_NOT_ALLOWED = { status: 405, error: 'Méthode non autorisée' }

async function detail (store, req, event) {
  const [options, counts, participantsCount] = await Promise.all([
    store.listOptions(event.id),
    store.countsByOption(event.id),
    store.participantsCount(event.id)
  ])
  const current = serializeEvent(event)
  const finalOption = current.final_option_id
    ? await store.getOptionById(current.final_option_id)
    : null
  return {
    event: current,
    options,
    final_option: finalOption,
    counts,
    participants_count: participantsCount,
    is_owner: isOwner(req, event)
  }
}

async function handleGet (req, res, store) {
  const q = query(req)
  const rawCode = q.get('code')
  if (rawCode == null) {
    // L'énumération par entier est morte : même avec un id valide, 403.
    if (q.has('id')) return send(res, E.FORBIDDEN)
    return send(res, E.NEED_CODE)
  }
  const code = parseCode(rawCode)
  if (!code) return send(res, E.NEED_CODE)
  const event = await store.getEventByCode(code)
  if (!event) return send(res, E.EVENT_NOT_FOUND)
  if (event.archived_at) return send(res, E.LINK_EXPIRED)
  return ok(res, await detail(store, req, event))
}

async function handlePost (req, res, store) {
  const body = await readJson(req)
  if (!body || typeof body !== 'object') return send(res, E.BAD_REQUEST)
  const title = parseTitle(body.title)
  if (!title) return send(res, E.TITLE_REQUIRED)
  const location = parseLocation(body.location)
  if (!location) return send(res, E.LOCATION_REQUIRED)
  if (!Array.isArray(body.options) || body.options.length < 2) return send(res, E.TWO_OPTIONS_MIN)
  const options = parseOptions(body.options)
  if (!options) return send(res, E.BAD_REQUEST)

  const { token, hash } = newOwnerToken()
  // Collision de code (quasi impossible) : on régénère, jamais d'erreur brute.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const created = await store.createEvent({ code: generateCode(), title, location, ownerHash: hash, options })
      return ok(res, { ...created, owner_token: token, invite_path: `/e/${created.event.code}` }, 201)
    } catch (err) {
      if (err?.code !== '23505') throw err
    }
  }
  return send(res, E.SERVER)
}

async function loadOwned (req, res, store, rawCode) {
  const code = parseCode(rawCode)
  if (!code) {
    send(res, E.NEED_CODE)
    return null
  }
  const event = await store.getEventByCode(code)
  if (!event) {
    send(res, E.EVENT_NOT_FOUND)
    return null
  }
  if (event.archived_at) {
    send(res, E.LINK_EXPIRED)
    return null
  }
  if (!isOwner(req, event)) {
    send(res, E.FORBIDDEN)
    return null
  }
  return event
}

async function handlePatch (req, res, store) {
  const body = await readJson(req)
  if (!body || typeof body !== 'object') return send(res, E.BAD_REQUEST)
  const event = await loadOwned(req, res, store, body.code)
  if (!event) return

  const raw = body.final_option_id
  if (raw == null) {
    // Rouvrir le vote (erreur de l'organisateur, créneau annulé…).
    const updated = await store.confirmEvent(event.id, null)
    return ok(res, { event: updated, final_option: null })
  }
  const optionId = parseEventId(raw)
  if (optionId == null) return send(res, E.BAD_REQUEST)
  const option = await store.getOptionById(optionId)
  if (!option || option.event_id !== event.id) return send(res, E.NOT_FOUND_GENERIC)

  const updated = await store.confirmEvent(event.id, optionId)
  const finalOption = await store.getOptionById(optionId)
  return ok(res, { event: updated, final_option: finalOption })
}

async function handleDelete (req, res, store) {
  const q = query(req)
  const event = await loadOwned(req, res, store, q.get('code'))
  if (!event) return
  await store.archiveEvent(event.id)
  return ok(res, { archived: true, code: serializeEvent(event).code })
}

export default wrap(async function eventsHandler (req, res) {
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
  if (req.method === 'PATCH') return handlePatch(req, res, store)
  if (req.method === 'DELETE') return handleDelete(req, res, store)
  return send(res, METHOD_NOT_ALLOWED)
})

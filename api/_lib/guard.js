/**
 * Dispoo V1 — garde-fous partagés pour les fonctions serverless.
 *
 *Problèmes mesurés en production le 15/09/2026 que ce fichier corrige :
 *  1. `GET /api/events` (sans paramètre) renvoyait TOUTE la table, avec les codes,
 *     les invités et tous les votes  -> énumération triviale via `?id=1..N`.
 *  2. `GET /api/options?event_id=abc` renvoyait
 *     {"error":"invalid input syntax for type integer: \"abc\""}  -> fuite du driver Postgres.
 *  3. `GET /api/events?code=BAD` renvoyait {"error":" introuvable"}  -> espace en tête,
 *     sujet absent (`${x} introuvable` avec x vide) et statut 200.
 *  4. Aucun concept de propriétaire : l'invité et l'organisateur avaient les mêmes droits.
 *
 * Style : Vercel Node.js functions `(req, res)`.
 * TODO(verify): si vos endpoints sont écrits en style Edge (`export default (Request) => Response`),
 * garder ces fonctions telles quelles et adapter uniquement `send()` (voir bas de fichier).
 */

import crypto from 'node:crypto'

/* ------------------------------------------------------------------ validation */

/** `code` d'invité : exactement 6 caractères [A-Z0-9], insensible à la casse (comportement actuel conservé). */
export const CODE_RE = /^[A-Z0-9]{6}$/

export function parseCode (raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const code = raw.trim().toUpperCase()
  return CODE_RE.test(code) ? code : null
}

/** `event_id` : entier strict > 0, jamais transmis tel quel au SQL. */
export function parseEventId (raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null
  if (typeof raw !== 'string' || raw === '') return null
  if (!/^\d{1,9}$/.test(raw.trim())) return null
  const id = Number(raw.trim())
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** Clé de normalisation des noms d'invités ("Chloé" === "chloe"). Doit rester alignée avec le SQL. */
export function normalizeName (raw) {
  if (typeof raw !== 'string') return null
  const n = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return n.length >= 2 && n.length <= 40 ? n : null
}

export function parseTitle (raw) {
  if (typeof raw !== 'string') return null
  const t = raw.trim().replace(/\s+/g, ' ')
  return t.length >= 3 && t.length <= 80 ? t : null
}

export function parseLocation (raw) {
  if (typeof raw !== 'string') return null
  const l = raw.trim().replace(/\s+/g, ' ')
  return l.length >= 2 && l.length <= 60 ? l : null
}

/**
 * Un sondage avec un seul créneau n'a aucun sens (créer « QA Test Event » avec 1 option
 * et une description vide était possible en production).
 */
export function parseOptions (raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  for (const o of raw) {
    if (!o || typeof o !== 'object') return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.day ?? ''))) return null
    if (!/^\d{2}:\d{2}$/.test(String(o.time_start ?? ''))) return null
    if (!/^\d{2}:\d{2}$/.test(String(o.time_end ?? ''))) return null
    const a = `${o.day}T${o.time_start}`
    const b = `${o.day}T${o.time_end}`
    if (!(new Date(a) < new Date(b))) return null
    const key = `${o.day}|${o.time_start}|${o.time_end}`
    if (out.some((x) => x.__key === key)) return null // doublons refusés
    out.push({ day: o.day, time_start: o.time_start, time_end: o.time_end, __key: key })
  }
  if (out.length < 2) return null
  return out.map(({ __key, ...o }) => o)
}

export const VOTE_VALUES = new Set(['yes', 'maybe', 'no'])

export function parseVotes (raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') return null
    const id = parseEventId(v.option_id)
    if (id == null || !VOTE_VALUES.has(v.value)) return null
    out.push({ option_id: id, value: v.value })
  }
  return out
}

/* ------------------------------------------------------------------ proprietaire */

/**
 * Propriété minimale, sans système de comptes : un token aléatoire créé avec l'évènement,
 * stocké **haché** en base, renvoyé une seule fois au créateur, conservé en localStorage.
 * Le code d'invité ne donne JAMAIS ces droits.
 */
export function newOwnerToken () {
  const token = crypto.randomBytes(24).toString('base64url')
  return { token, hash: sha256(token) }
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

export function ownerTokenFromReq (req) {
  const h = req.headers?.['x-owner-token'] ?? req.headers?.['authorization']
  if (typeof h !== 'string') return null
  const t = h.replace(/^Bearer\s+/i, '').trim()
  return /^[A-Za-z0-9_-]{32,}$/.test(t) ? t : null
}

export function isOwner (req, event) {
  const t = ownerTokenFromReq(req)
  if (!t || !event?.owner_token_hash) return false
  return timingSafeEqualHex(t, event.owner_token_hash)
}

function timingSafeEqualHex (token, hashHex) {
  const a = Buffer.from(sha256(token), 'hex')
  const b = Buffer.from(String(hashHex), 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/* ------------------------------------------------------------------ reponses */

/** Messages strictement humains, en français, sans jargon ni détail de schéma. */
export const E = {
  EVENT_NOT_FOUND: { status: 404, error: 'Événement introuvable', hint: "Vérifiez le code à 6 caractères, ou demandez un nouveau lien à l'organisateur." },
  LINK_EXPIRED: { status: 410, error: 'Ce lien n’est plus valide', hint: 'L’événement a été supprimé ou archivé.' },
  BAD_REQUEST: { status: 400, error: 'Requête invalide', hint: 'Certains paramètres sont manquants ou mal formulés.' },
  NEED_CODE: { status: 400, error: 'Code requis', hint: 'Ajoutez le code de l’événement.' },
  NEED_EVENT_ID: { status: 400, error: 'Requête invalide', hint: "L'identifiant de l'événement est manquant." },
  NAME_REQUIRED: { status: 400, error: 'Prénom requis', hint: 'Entre 2 et 40 caractères.' },
  TWO_OPTIONS_MIN: { status: 400, error: 'Deux créneaux minimum', hint: 'Un sondage avec une seule date ne peut rien comparer.' },
  TITLE_REQUIRED: { status: 400, error: 'Titre requis', hint: 'Entre 3 et 80 caractères.' },
  LOCATION_REQUIRED: { status: 400, error: 'Lieu requis', hint: 'Indiquez la ville ou le lieu.' },
  FORBIDDEN: { status: 403, error: 'Accès non autorisé', hint: 'Ce lien appartient à son organisateur.' },
  NOT_FOUND_GENERIC: { status: 404, error: 'Ressource introuvable' },
  SERVER: { status: 500, error: 'Une erreur est survenue. Réessayez.', retryable: true },
}

/**
 * SEULE sortie autorisée d'un endpoint : `err` technique n'est jamais renvoyé au client,
 * il part dans le log serveur.
 */
export function send (res, spec, extra) {
  const body = { error: spec.error, ...(spec.hint ? { hint: spec.hint } : {}), ...(spec.retryable ? { retryable: true } : {}), ...extra }
  if (res.statusCode !== spec.status) res.statusCode = spec.status
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

export function ok (res, data, status = 200) {
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(data === undefined ? '{}' : JSON.stringify(data))
}

/** Filet de sécurité à mettre autour de chaque handler : plus jamais d'erreur Postgres au client. */
export function wrap (handler) {
  return async function apiHandler (req, res) {
    try {
      await handler(req, res)
    } catch (err) {
      console.error('[dispoo:api]', req.method, req.url, err?.message ?? err)
      send(res, E.SERVER)
    }
  }
}

/** Corps JSON défensif (pas d'`JSON.parse` nu, pas de 500 sur un body malformé). */
export function readJson (req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 64_000) { raw = '<<too-big>>'; req.destroy() } })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
}

export function query (req) {
  try {
    const host = req.headers?.host ?? 'x'
    return new URL(req.url, `http://${host}`).searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * Dispoo V1 — couche de stockage.
 *
 * - Production : Postgres via POSTGRES_URL (ou DATABASE_URL). Le schéma est
 *   appliqué automatiquement au premier appel (cf. `sql/schema.sql`, repris
 *   ici en `CREATE/ALTER ... IF NOT EXISTS`, donc sûr sur base neuve comme
 *   sur base pré-V1).
 * - Dev local sans base : stockage en mémoire (pratique pour `npm run dev`
 *   et les tests, données perdues au redémarrage).
 * - Production SANS base : erreur DB_NOT_CONFIGURED, convertie en 503
 *   explicite par les endpoints (sauf `DISPOO_ALLOW_MEMORY=1`, previews démo).
 */
import crypto from 'node:crypto'
import pg from 'pg'

const { Pool } = pg

export const DB_DOWN = {
  status: 503,
  error: 'Service temporairement indisponible',
  hint: 'La base de données n’est pas configurée. Ajoutez POSTGRES_URL dans les variables d’environnement Vercel, puis redéployez (voir README.md).'
}

export function dbKind () {
  if (process.env.POSTGRES_URL || process.env.DATABASE_URL) return 'postgres'
  if (process.env.DISPOO_ALLOW_MEMORY === '1') return 'memory'
  const prod = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
  return prod ? 'none' : 'memory'
}

/* ------------------------------------------------------------------ codes */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // [A-Z0-9] sans 0/O/1/I/L

export function generateCode () {
  const bytes = crypto.randomBytes(6)
  let out = ''
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return out
}

/* ------------------------------------------------------------------ serialisation */

const iso = (v) => {
  if (v == null) return null
  return v instanceof Date ? v.toISOString() : String(v)
}

const dayOf = (v) => {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

const timeOf = (v) => {
  if (v == null) return null
  return String(v).slice(0, 5)
}

export function serializeEvent (row) {
  return {
    id: row.id,
    code: String(row.code).trim(),
    title: row.title,
    location: row.location,
    status: row.status,
    final_option_id: row.final_option_id ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    archived_at: iso(row.archived_at)
  }
}

export function serializeOption (row) {
  return {
    id: row.id,
    event_id: row.event_id,
    day: dayOf(row.day),
    time_start: timeOf(row.time_start),
    time_end: timeOf(row.time_end)
  }
}

export function serializeParticipant (row) {
  return { id: row.id, event_id: row.event_id, name: row.name, created_at: iso(row.created_at) }
}

/**
 * « Chloé » puis « chloe » désignent la même invitée : on garde l'orthographe
 * la plus riche (accents, capitales, traits d'union) au lieu du dernier écrit.
 * Égalité → on conserve l'existant (premier arrivé).
 */
export function scoreName (name) {
  let score = 0
  for (const c of String(name ?? '')) {
    if (!/[a-z0-9 ]/.test(c)) score++
  }
  return score
}

/* ------------------------------------------------------------------ postgres */

let pool = null

function getPool () {
  // Couture de test : `scripts/test-pg.mjs` injecte ici un pool pg-mem.
  // Inutilisé en production (toujours undefined).
  if (globalThis.__dispooTestPool) return globalThis.__dispooTestPool
  if (!pool) {
    const cs = process.env.POSTGRES_URL || process.env.DATABASE_URL
    const needsSsl = !/(localhost|127\.0\.0\.1)/.test(cs)
    pool = new Pool({
      connectionString: cs,
      max: 2, // serverless : peu de connexions, courtes
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {})
    })
    pool.on('error', (err) => console.error('[dispoo:db] pool', err?.message ?? err))
  }
  return pool
}

async function q (text, params) {
  return getPool().query(text, params)
}

// Miroir de `sql/schema.sql`, idempotent (répétable sans danger, y compris
// en concurrence entre instances serverless : les erreurs « existe déjà »
// sont ignorées).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    code CHAR(6) NOT NULL,
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sondage' CHECK (status IN ('sondage', 'confirme')),
    final_option_id INTEGER NULL,
    owner_token_hash TEXT NULL,
    archived_at TIMESTAMPTZ NULL,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS events_code_key ON events (code)',
  'CREATE INDEX IF NOT EXISTS events_created_at_desc ON events (created_at DESC NULLS LAST)',
  'CREATE INDEX IF NOT EXISTS events_owner_token_hash_idx ON events (owner_token_hash)',
  `CREATE TABLE IF NOT EXISTS options (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    day DATE NOT NULL,
    time_start TIME NOT NULL,
    time_end TIME NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  'CREATE INDEX IF NOT EXISTS options_event_id_idx ON options (event_id)',
  `CREATE TABLE IF NOT EXISTS participants (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS participants_event_name_key
     ON participants (event_id, normalized_name) WHERE normalized_name IS NOT NULL`,
  'CREATE INDEX IF NOT EXISTS participants_event_id_idx ON participants (event_id)',
  `CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    option_id INTEGER NOT NULL REFERENCES options (id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
    value TEXT NOT NULL CHECK (value IN ('yes', 'maybe', 'no')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS votes_option_participant_key ON votes (option_id, participant_id)',
  'CREATE INDEX IF NOT EXISTS votes_participant_id_idx ON votes (participant_id)',
  // --- migration douce (base pré-V1) ---
  'ALTER TABLE events ADD COLUMN IF NOT EXISTS owner_token_hash TEXT',
  'ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ',
  'ALTER TABLE events ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false',
  'ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  'ALTER TABLE events ADD COLUMN IF NOT EXISTS final_option_id INTEGER',
  'ALTER TABLE events ALTER COLUMN created_at SET DEFAULT now()',
  'ALTER TABLE options ALTER COLUMN created_at SET DEFAULT now()',
  'ALTER TABLE participants ALTER COLUMN created_at SET DEFAULT now()',
  'ALTER TABLE votes ALTER COLUMN created_at SET DEFAULT now()',
  'ALTER TABLE participants ADD COLUMN IF NOT EXISTS normalized_name TEXT',
  `UPDATE participants
      SET normalized_name = regexp_replace(
            lower(translate(name, 'àáâãäåçèéêëìíîïðñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinoooooouuuuyy')),
            '[^a-z0-9]', '', 'g')
    WHERE normalized_name IS NULL`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_final_option_id_fkey') THEN
       ALTER TABLE events ADD CONSTRAINT events_final_option_id_fkey
         FOREIGN KEY (final_option_id) REFERENCES options (id) ON DELETE SET NULL;
     END IF;
   END $$`,
  `CREATE OR REPLACE FUNCTION dispoo_touch_updated_at() RETURNS trigger AS $$
   BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'events_touch_updated_at') THEN
       CREATE TRIGGER events_touch_updated_at BEFORE UPDATE ON events
         FOR EACH ROW EXECUTE FUNCTION dispoo_touch_updated_at();
     END IF;
   END $$`
]

const BENIGN_SCHEMA_CODES = new Set(['42P07', '42701', '42710', '42830'])

let schemaPromise = null

async function ensureSchema () {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const stmt of SCHEMA) {
        try {
          await q(stmt)
        } catch (err) {
          // Concurrence entre instances / objets déjà là : silencieux.
          if (!BENIGN_SCHEMA_CODES.has(err?.code)) {
            console.error('[dispoo:db] schéma:', err?.code ?? '', err?.message ?? err)
          }
        }
      }
    })()
  }
  return schemaPromise
}

const pgStore = {
  kind: 'postgres',

  async createEvent ({ code, title, location, ownerHash, options }) {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const ev = await client.query(
        `INSERT INTO events (code, title, location, status, owner_token_hash)
         VALUES ($1, $2, $3, 'sondage', $4) RETURNING *`,
        [code, title, location, ownerHash]
      )
      const event = ev.rows[0]
      const rows = []
      for (const o of options) {
        const r = await client.query(
          'INSERT INTO options (event_id, day, time_start, time_end) VALUES ($1, $2, $3, $4) RETURNING *',
          [event.id, o.day, o.time_start, o.time_end]
        )
        rows.push(r.rows[0])
      }
      await client.query('COMMIT')
      return { event: serializeEvent(event), options: rows.map(serializeOption) }
    } catch (err) {
      try { await client.query('ROLLBACK') } catch {}
      throw err
    } finally {
      client.release()
    }
  },

  async getEventByCode (code) {
    const r = await q('SELECT * FROM events WHERE code = $1 LIMIT 1', [code])
    return r.rows[0] ?? null
  },

  async getEventById (id) {
    const r = await q('SELECT * FROM events WHERE id = $1 LIMIT 1', [id])
    return r.rows[0] ?? null
  },

  async listOptions (eventId) {
    const r = await q(
      'SELECT * FROM options WHERE event_id = $1 ORDER BY day, time_start, id',
      [eventId]
    )
    return r.rows.map(serializeOption)
  },

  async getOptionById (id) {
    const r = await q('SELECT * FROM options WHERE id = $1 LIMIT 1', [id])
    return r.rows[0] ? serializeOption(r.rows[0]) : null
  },

  async upsertParticipant (eventId, name, normalized) {
    const existing = await q(
      'SELECT * FROM participants WHERE event_id = $1 AND normalized_name = $2 LIMIT 1',
      [eventId, normalized]
    )
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (scoreName(name) > scoreName(row.name)) {
        const updated = await q('UPDATE participants SET name = $2 WHERE id = $1 RETURNING *', [row.id, name])
        return { participant: serializeParticipant(updated.rows[0]), created: false }
      }
      return { participant: serializeParticipant(row), created: false }
    }
    // Volontairement sans ON CONFLICT : fonctionne même si la contrainte
    // d'unicité n'a pas pu être créée (doublons pré-V1 non résorbés).
    try {
      const inserted = await q(
        'INSERT INTO participants (event_id, name, normalized_name) VALUES ($1, $2, $3) RETURNING *',
        [eventId, name, normalized]
      )
      return { participant: serializeParticipant(inserted.rows[0]), created: true }
    } catch (err) {
      if (err?.code !== '23505') throw err // course d'insertion : relire le gagnant
      const raced = await q(
        'SELECT * FROM participants WHERE event_id = $1 AND normalized_name = $2 LIMIT 1',
        [eventId, normalized]
      )
      return { participant: serializeParticipant(raced.rows[0]), created: false }
    }
  },

  async getParticipantById (id) {
    const r = await q('SELECT * FROM participants WHERE id = $1 LIMIT 1', [id])
    return r.rows[0] ? serializeParticipant(r.rows[0]) : null
  },

  async listParticipants (eventId) {
    const r = await q(
      'SELECT * FROM participants WHERE event_id = $1 ORDER BY name, id',
      [eventId]
    )
    return r.rows.map(serializeParticipant)
  },

  async participantsCount (eventId) {
    const r = await q('SELECT COUNT(*)::int AS n FROM participants WHERE event_id = $1', [eventId])
    return r.rows[0]?.n ?? 0
  },

  async upsertVote (optionId, participantId, value) {
    // Idempotent sans ON CONFLICT (même raison que upsertParticipant).
    const existing = await q(
      'SELECT id FROM votes WHERE option_id = $1 AND participant_id = $2 LIMIT 1',
      [optionId, participantId]
    )
    if (existing.rows[0]) {
      const r = await q(
        'UPDATE votes SET value = $3 WHERE option_id = $1 AND participant_id = $2 RETURNING option_id, participant_id, value',
        [optionId, participantId, value]
      )
      return r.rows[0]
    }
    try {
      const r = await q(
        'INSERT INTO votes (option_id, participant_id, value) VALUES ($1, $2, $3) RETURNING option_id, participant_id, value',
        [optionId, participantId, value]
      )
      return r.rows[0]
    } catch (err) {
      if (err?.code !== '23505') throw err
      const r = await q(
        'UPDATE votes SET value = $3 WHERE option_id = $1 AND participant_id = $2 RETURNING option_id, participant_id, value',
        [optionId, participantId, value]
      )
      return r.rows[0]
    }
  },

  async listVotesDetailed (eventId) {
    const r = await q(
      `SELECT v.option_id, v.participant_id, p.name, v.value
         FROM votes v
         JOIN participants p ON p.id = v.participant_id
         JOIN options o ON o.id = v.option_id
        WHERE o.event_id = $1
        ORDER BY p.id, v.option_id`,
      [eventId]
    )
    return r.rows
  },

  async countsByOption (eventId) {
    const r = await q(
      // CASE plutôt que FILTER : même résultat, SQL plus portable (et testable).
      `SELECT o.id AS option_id,
              COUNT(CASE WHEN v.value = 'yes' THEN 1 END)::int AS yes,
              COUNT(CASE WHEN v.value = 'maybe' THEN 1 END)::int AS maybe,
              COUNT(CASE WHEN v.value = 'no' THEN 1 END)::int AS no
         FROM options o LEFT JOIN votes v ON v.option_id = o.id
        WHERE o.event_id = $1
        GROUP BY o.id`,
      [eventId]
    )
    return r.rows.map((c) => ({ ...c, total: c.yes + c.maybe + c.no }))
  },

  async confirmEvent (eventId, optionId) {
    const status = optionId == null ? 'sondage' : 'confirme'
    const r = await q(
      'UPDATE events SET status = $2, final_option_id = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [eventId, status, optionId]
    )
    return serializeEvent(r.rows[0])
  },

  async archiveEvent (eventId) {
    const r = await q(
      'UPDATE events SET archived_at = now(), updated_at = now() WHERE id = $1 RETURNING *',
      [eventId]
    )
    return serializeEvent(r.rows[0])
  }
}

/* ------------------------------------------------------------------ mémoire (dev) */

function createMemoryStore () {
  let nextId = 1
  const events = new Map() // code -> row
  const eventsById = new Map()
  const options = new Map() // id -> row
  const optionsByEvent = new Map() // eventId -> [ids]
  const participants = new Map() // id -> row
  const votes = new Map() // `${optionId}:${participantId}` -> row
  const now = () => new Date().toISOString()

  return {
    kind: 'memory',

    async createEvent ({ code, title, location, ownerHash, options: opts }) {
      if (events.has(code)) {
        throw Object.assign(new Error('duplicate code'), { code: '23505' })
      }
      const id = nextId++
      const row = {
        id, code, title, location, status: 'sondage', final_option_id: null,
        owner_token_hash: ownerHash, archived_at: null, is_demo: false,
        created_at: now(), updated_at: now()
      }
      events.set(code, row)
      eventsById.set(id, row)
      const rows = opts.map((o) => {
        const orow = { id: nextId++, event_id: id, day: o.day, time_start: o.time_start, time_end: o.time_end, created_at: now() }
        options.set(orow.id, orow)
        if (!optionsByEvent.has(id)) optionsByEvent.set(id, [])
        optionsByEvent.get(id).push(orow.id)
        return orow
      })
      return { event: serializeEvent(row), options: rows.map(serializeOption) }
    },

    async getEventByCode (code) {
      return events.get(code) ?? null
    },

    async getEventById (id) {
      return eventsById.get(id) ?? null
    },

    async listOptions (eventId) {
      return (optionsByEvent.get(eventId) ?? []).map((id) => serializeOption(options.get(id)))
    },

    async getOptionById (id) {
      const row = options.get(id)
      return row ? serializeOption(row) : null
    },

    async upsertParticipant (eventId, name, normalized) {
      for (const p of participants.values()) {
        if (p.event_id === eventId && p.normalized_name === normalized) {
          p.name = name // « Chloé » puis « chloe » : un seul invité
          return { participant: serializeParticipant(p), created: false }
        }
      }
      const row = { id: nextId++, event_id: eventId, name, normalized_name: normalized, created_at: now() }
      participants.set(row.id, row)
      return { participant: serializeParticipant(row), created: true }
    },

    async getParticipantById (id) {
      const row = participants.get(id)
      return row ? serializeParticipant(row) : null
    },

    async listParticipants (eventId) {
      return [...participants.values()]
        .filter((p) => p.event_id === eventId)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'))
        .map(serializeParticipant)
    },

    async participantsCount (eventId) {
      let n = 0
      for (const p of participants.values()) if (p.event_id === eventId) n++
      return n
    },

    async upsertVote (optionId, participantId, value) {
      const row = { id: nextId++, option_id: optionId, participant_id: participantId, value, created_at: now() }
      votes.set(`${optionId}:${participantId}`, row)
      return { option_id: optionId, participant_id: participantId, value }
    },

    async listVotesDetailed (eventId) {
      const ids = new Set(optionsByEvent.get(eventId) ?? [])
      const out = []
      for (const v of votes.values()) {
        if (!ids.has(v.option_id)) continue
        const p = participants.get(v.participant_id)
        if (!p) continue
        out.push({ option_id: v.option_id, participant_id: v.participant_id, name: p.name, value: v.value })
      }
      return out.sort((a, b) => a.participant_id - b.participant_id || a.option_id - b.option_id)
    },

    async countsByOption (eventId) {
      const ids = optionsByEvent.get(eventId) ?? []
      return ids.map((optionId) => {
        const c = { option_id: optionId, yes: 0, maybe: 0, no: 0 }
        for (const v of votes.values()) {
          if (v.option_id === optionId && c[v.value] !== undefined) c[v.value]++
        }
        return { ...c, total: c.yes + c.maybe + c.no }
      })
    },

    async confirmEvent (eventId, optionId) {
      const row = eventsById.get(eventId)
      row.status = optionId == null ? 'sondage' : 'confirme'
      row.final_option_id = optionId ?? null
      row.updated_at = now()
      return serializeEvent(row)
    },

    async archiveEvent (eventId) {
      const row = eventsById.get(eventId)
      row.archived_at = now()
      row.updated_at = now()
      return serializeEvent(row)
    }
  }
}

let memStore = null

export async function getStore () {
  const kind = dbKind()
  if (kind === 'none') {
    throw Object.assign(new Error('DB_NOT_CONFIGURED'), { code: 'DB_NOT_CONFIGURED' })
  }
  if (kind === 'postgres') {
    await ensureSchema()
    return pgStore
  }
  if (!memStore) memStore = createMemoryStore()
  return memStore
}

export function isDbNotConfigured (err) {
  return err?.code === 'DB_NOT_CONFIGURED'
}

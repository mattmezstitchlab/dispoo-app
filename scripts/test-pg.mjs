/**
 * Test d'intégration du backend Postgres, sans base (pg-mem).
 *
 *   npm test
 *
 * Exécute le VRAI `pgStore` (`api/_lib/store.js`) contre Postgres émulé :
 * création, lectures, dédupe des invités, votes, comptes, confirmation,
 * archivage, collision de code. Le bruit pg-mem/« schéma » pendant le run
 * est normal : certains blocs (DO, trigger plpgsql) n'existent pas en émulé
 * et sont ignorés comme prévu (`ensureSchema` best-effort).
 */
import { newDb } from 'pg-mem'
import assert from 'node:assert/strict'

process.env.POSTGRES_URL = 'postgres://test/test'
const db = newDb()
const { Pool } = db.adapters.createPg()
globalThis.__dispooTestPool = new Pool()

const store = await import('../api/_lib/store.js')
const s = await store.getStore()
assert.equal(s.kind, 'postgres')

// create + lectures
const { event, options } = await s.createEvent({
  code: 'ABC123', title: 'Test', location: 'Paris', ownerHash: 'h',
  options: [
    { day: '2026-10-01', time_start: '19:00', time_end: '22:00' },
    { day: '2026-10-02', time_start: '19:00', time_end: '22:00' }
  ]
})
assert.equal(event.code, 'ABC123')
assert.equal(options.length, 2)
assert.match(event.created_at, /2026-/)
assert.equal(options[0].day, '2026-10-01')
assert.equal(options[0].time_start, '19:00')

const byCode = await s.getEventByCode('ABC123')
assert.equal(byCode.id, event.id)
assert.equal(await s.getEventByCode('ZZZZZZ'), null)
assert.equal((await s.getEventById(event.id)).code.trim(), 'ABC123')
assert.equal((await s.getOptionById(options[0].id)).event_id, event.id)

// participants : dédupe + orthographe
const p1 = await s.upsertParticipant(event.id, 'Chloé', 'chloe')
assert.equal(p1.created, true)
const p2 = await s.upsertParticipant(event.id, 'chloe', 'chloe')
assert.equal(p2.created, false)
assert.equal(p2.participant.id, p1.participant.id)
assert.equal(p2.participant.name, 'Chloé') // plus belle orthographe gardée
assert.equal(await s.participantsCount(event.id), 1)
assert.equal((await s.listParticipants(event.id)).length, 1)

// votes : upsert + comptes
await s.upsertVote(options[0].id, p1.participant.id, 'yes')
await s.upsertVote(options[1].id, p1.participant.id, 'maybe')
await s.upsertVote(options[0].id, p1.participant.id, 'no') // modification
const counts = await s.countsByOption(event.id)
const c0 = counts.find((c) => c.option_id === options[0].id)
assert.deepEqual([c0.yes, c0.maybe, c0.no, c0.total], [0, 0, 1, 1])
const detail = await s.listVotesDetailed(event.id)
assert.equal(detail.length, 2)
assert.equal(detail[0].name, 'Chloé')

// confirm / rouvre / archive
const confirmed = await s.confirmEvent(event.id, options[0].id)
assert.equal(confirmed.status, 'confirme')
assert.equal(confirmed.final_option_id, options[0].id)
const reopened = await s.confirmEvent(event.id, null)
assert.equal(reopened.status, 'sondage')
const archived = await s.archiveEvent(event.id)
assert.ok(archived.archived_at)

// collision de code → 23505 (l'endpoint régénère)
await assert.rejects(
  s.createEvent({ code: 'ABC123', title: 'x', location: 'y', ownerHash: 'h', options: [] }),
  /duplicate/i
)

console.log('PG-STORE OK — toutes les assertions passent')
process.exit(0)

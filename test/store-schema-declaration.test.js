/**
 * ENH-29: one declaration, and a test that fails when something is written but
 * undeclared.
 *
 * ADR-002 names this as the single most repeated structural bug in the
 * codebase, and it has cost three incidents: a collection whose records were
 * dropped with no error, a health source that reported failure on a fully
 * successful run, and a first access to `store.record_versions` that threw on a
 * fresh file. Three copies of "the list of collections" — SCHEMA, `emptyStore()`
 * and the `runIngestion` accumulator — is the shape that produced all three.
 *
 * So the tests here are about the declaration rather than about any one
 * collection:
 *
 * - `COLLECTIONS` is not a second spelling of `SCHEMA`, it is derived from it;
 * - the one copy this file cannot replace (`emptyStore()` in schema.js, whose
 *   module would have to import this one and create a cycle) is checked against
 *   it from both sides;
 * - and the guard that turns a silent drop into a throw is proved to fire, by
 *   removing a real collection from the declaration and watching both adapters
 *   refuse the write.
 *
 * That last group is the anti-vacuous one. A guard that never throws looks
 * exactly like a guard doing its job until you take a collection away and watch.
 *
 * The Postgres half provisions its own cluster (see test/pg-harness.mjs) rather
 * than skipping, because `PostgresStore` running at 0% function coverage in CI
 * is what let the replaceAnalytics bug live. If no server is available the tests
 * skip loudly, and fail outright under CI.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { emptyStore } from '../src/schema.js'
import { PostgresStore } from '../src/postgres-store.js'
import { postgresCluster } from './pg-harness.mjs'

import {
  COLLECTIONS,
  DERIVED_COLLECTIONS,
  JsonStore,
  QUARANTINE_SOURCES,
  SCHEMA,
  assertDeclaredCollection,
  assertDeclaredCollections,
  isDeclared,
  sortRecords,
} from '../src/store.js'

/** Key names that live in a store payload but are not collections. */
const METADATA = ['version', 'updated_at']

/** A JsonStore over a throwaway file, with its own teardown. */
async function scratchStore(prefix = 'lindela-decl') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
  return { store: new JsonStore(path.join(dir, 'store.json')), cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

describe('SCHEMA is the one list of collections', () => {
  it('COLLECTIONS is derived from it, not written out beside it', () => {
    // If this fails, somebody pasted the list back. Two literals side by side
    // drift; that is the whole of the history of this file.
    assert.deepEqual(COLLECTIONS, SCHEMA.map((entry) => entry.key))
  })

  it('has no duplicate keys', () => {
    // A duplicate is not a no-op: mergeById would then see two entries whose
    // records share a namespace, and "which one did write() insert" has two
    // answers.
    assert.equal(new Set(COLLECTIONS).size, COLLECTIONS.length)
  })

  it('is frozen and deeply frozen, so nothing widens it at runtime', () => {
    assert.throws(() => SCHEMA.push({ key: 'sneaky' }), TypeError)
    assert.throws(() => { SCHEMA[0].key = 'sneaky' }, TypeError)
    assert.throws(() => COLLECTIONS.push('sneaky'), TypeError)
  })

  it('agrees with emptyStore() in both directions', () => {
    // The copy schema.js has to keep. An emptyStore key with no SCHEMA entry is
    // a key read() spreads a default under and merge() then never writes; a
    // SCHEMA entry with no emptyStore key means `store.record_versions` throws
    // on a fresh file. Both directions, because both have happened.
    const defaults = Object.keys(emptyStore()).filter((key) => !METADATA.includes(key))
    assert.deepEqual(
      [...defaults].sort(),
      [...COLLECTIONS].sort(),
      'emptyStore() and SCHEMA name different collections',
    )
  })

  it('is not a truncated copy of the vocabulary it stores', () => {
    // 40 records plus 6 quarantine homes. A floor rather than an exact count:
    // it catches a declaration emptied or chopped in half, which the equality
    // assertions above report more usefully, and does not need editing every
    // time a collection is legitimately added.
    assert.ok(COLLECTIONS.length >= 46, `expected the full set, found ${COLLECTIONS.length}`)
    for (const collection of ['hazard_events', 'record_versions', 'food_security_records', 'action_logs']) {
      assert.ok(isDeclared(collection), `${collection} is missing from the declaration`)
    }
  })
})

describe('the parts of the declaration that are computed, not typed', () => {
  it('names every quarantine collection after the collection it shadows', () => {
    // Six hand-written names, one per source. Spelling one differently from its
    // source is how a condemned batch lands somewhere nobody reads.
    for (const source of QUARANTINE_SOURCES) {
      assert.ok(isDeclared(`quarantine_${source}`), `no quarantine home for ${source}`)
    }
    const quarantines = SCHEMA.filter((entry) => entry.kind === 'quarantine')
    assert.equal(quarantines.length, QUARANTINE_SOURCES.length)
    for (const entry of quarantines) assert.ok(isDeclared(entry.quarantines), `${entry.key} shadows nothing`)
  })

  it('marks exactly the collections replaceAnalytics owns as derived', () => {
    const marked = SCHEMA.filter((entry) => entry.derived).map((entry) => entry.key)
    assert.deepEqual([...marked].sort(), [...DERIVED_COLLECTIONS].sort())
    for (const collection of DERIVED_COLLECTIONS) assert.ok(isDeclared(collection))
  })

  it('does not mark an ingested collection derived', () => {
    // replaceAnalytics replaces wholesale. A collection in that set that is
    // also fed by ingestion loses its records on every refresh.
    for (const entry of SCHEMA) {
      if (!entry.derived) continue
      assert.ok(
        !['hazard_events', 'climate_observations', 'food_security_records', 'incidents'].includes(entry.key),
        `${entry.key} is both ingested and replaced wholesale`,
      )
    }
  })
})

describe('an undeclared collection is refused, not dropped', () => {
  it('names the offending key in the error', () => {
    assert.throws(
      () => assertDeclaredCollections({ hazard_events: [], hazard_evesnts: [] }),
      /Undeclared collection: hazard_evesnts/,
      'a misspelled collection must say which spelling, or the fix is a guess',
    )
  })

  it('lists every offender at once', () => {
    // The real failure is usually a payload built from several undeclared keys.
    // Reporting one at a time turns a five-minute fix into five round trips.
    assert.throws(() => assertDeclaredCollections({ a_records: [], b_records: [] }), /a_records, b_records/)
  })

  it('accepts every declared collection and the store metadata keys', () => {
    // read() returns version and updated_at alongside the collections, and
    // server.js hands that object straight back to write(). A guard that
    // rejected them would take down the console.
    assert.doesNotThrow(() => assertDeclaredCollections({ ...emptyStore() }))
    assert.doesNotThrow(() => assertDeclaredCollections({ version: 1, updated_at: new Date().toISOString() }))
  })

  it('fires when a collection is removed from the declaration', () => {
    // The anti-vacuous case. Every other test here passes whether or not the
    // guard works; this one fails if the guard has stopped guarding.
    const trimmed = COLLECTIONS.filter((collection) => collection !== 'hazard_events')
    assert.doesNotThrow(() => assertDeclaredCollections({ hazard_events: [{}] }, COLLECTIONS))
    assert.throws(
      () => assertDeclaredCollections({ hazard_events: [{}] }, trimmed),
      /Undeclared collection: hazard_events/,
      'a collection missing from the declaration must stop being storable, loudly',
    )
  })

  it('remove() refuses an undeclared collection the same way', () => {
    assert.throws(() => assertDeclaredCollection('not_a_collection'), /Unknown collection: not_a_collection/)
    assert.doesNotThrow(() => assertDeclaredCollection('hazard_events'))
  })
})

describe('both adapters enforce it, and neither is wedged by the refusal', () => {
  /** PostgresStore with a pool it must never reach: the guard runs first. */
  const unreachablePostgres = () => new PostgresStore({
    pool: { query: () => { throw new Error('touched the database') } },
  })

  it('JsonStore.write() throws on an undeclared collection', async () => {
    const { store, cleanup } = await scratchStore()
    try {
      await assert.rejects(() => store.write({ hazard_evesnts: [{ id: 'x' }] }), /Undeclared collection/)
      // The refusal must cost the caller nothing: a rejected write cannot be
      // allowed to leave the serialisation chain poisoned or a half-written file.
      await store.write({ hazard_events: [{ id: 'hz-after' }] })
      assert.equal((await store.read()).hazard_events.length, 1)
    } finally {
      await cleanup()
    }
  })

  it('JsonStore.merge() throws on an undeclared collection', async () => {
    const { store, cleanup } = await scratchStore()
    try {
      await store.write({})
      await assert.rejects(() => store.merge({ hazard_evesnts: [{ id: 'x' }] }), /Undeclared collection/)
      await store.merge({ hazard_events: [{ id: 'hz-after' }] })
      assert.equal((await store.read()).hazard_events.length, 1)
    } finally {
      await cleanup()
    }
  })

  it('PostgresStore.write() and merge() throw before they reach the database', async () => {
    // Proved without a server on purpose: this asserts the guard is *wired in*,
    // which is a source-level fact. If it ever moves below ensureSchema(), the
    // pool here throws a different error and the assertion fails.
    const store = unreachablePostgres()
    await assert.rejects(() => store.write({ hazard_evesnts: [{ id: 'x' }] }), /Undeclared collection/)
    await assert.rejects(() => store.merge({ hazard_evesnts: [{ id: 'x' }] }), /Undeclared collection/)
  })

  it('replaceAnalytics refuses an undeclared collection on both adapters', async () => {
    const { store, cleanup } = await scratchStore()
    try {
      await assert.rejects(
        () => store.replaceAnalytics({ risk_scores: [], population_at_risk: [], typo_scores: [] }),
        /Undeclared collection: typo_scores/,
      )
      await assert.rejects(
        () => unreachablePostgres().replaceAnalytics({ typo_scores: [] }),
        /Undeclared collection: typo_scores/,
      )
    } finally {
      await cleanup()
    }
  })

  it('JsonStore.replaceAnalytics replaces the derived collections and nothing else', async () => {
    const { store, cleanup } = await scratchStore()
    try {
      await store.write({})
      await store.merge({ hazard_events: [{ id: 'hz-keep' }] })
      // Built from the declaration rather than spelled out. Spelling it is how
      // this fixture and the assertion above it drifted the moment a derived
      // collection was added: the assertion walked eight, the fixture supplied
      // six, and the missing two failed a test about something else entirely.
      await store.replaceAnalytics({
        ...Object.fromEntries(DERIVED_COLLECTIONS.map((c, i) => [c, [{ id: `${c}-${i}` }]])),
        hazard_events: [{ id: 'hz-should-not-be-here' }],
      })
      const data = await store.read()
      for (const collection of DERIVED_COLLECTIONS) {
        assert.equal(data[collection].length, 1, `${collection} must reach the store on every backend`)
      }
      assert.deepEqual(data.hazard_events.map((r) => r.id), ['hz-keep'], 'ingested data is not analytics')
    } finally {
      await cleanup()
    }
  })
})

describe('the order both adapters return a collection in', () => {
  it('is newest first', () => {
    const records = [
      { id: 'c', observed_at: '2026-03-01T00:00:00.000Z' },
      { id: 'a', observed_at: '2026-05-01T00:00:00.000Z' },
      { id: 'b', observed_at: '2026-04-01T00:00:00.000Z' },
    ]
    assert.deepEqual(sortRecords(records).map((r) => r.id), ['a', 'b', 'c'])
  })

  it('falls through the timestamp cascade in the declared order', () => {
    // A record with no observed_at but an updated_at is still ordered, not
    // dumped at the bottom — the cascade is what keeps a mixed collection from
    // arriving in two blocks.
    const mixed = [
      { id: 'no-time' },
      { id: 'updated', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'occurred', observed_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    ]
    assert.deepEqual(sortRecords(mixed).map((r) => r.id), ['occurred', 'updated', 'no-time'])
  })

  it('breaks ties on id, so the order is total', () => {
    // Without this the order depends on the backend's fetch order: insertion
    // order on Postgres, file order on JSON. Same records, two different lists.
    const tied = [
      { id: 'z', observed_at: '2026-01-01T00:00:00.000Z' },
      { id: 'a', observed_at: '2026-01-01T00:00:00.000Z' },
    ]
    assert.deepEqual(sortRecords(tied).map((r) => r.id), ['a', 'z'])
    assert.deepEqual(sortRecords([...tied].reverse()).map((r) => r.id), ['a', 'z'])
  })

  it('does not mistake a zero timestamp for a missing one', () => {
    // Truthiness on a nullable field loses records at 0. This one is a
    // falsy-zero on a sort key: a record stamped 0 sorts below a record with
    // no timestamp at all, which is backwards.
    assert.deepEqual(
      sortRecords([{ id: 'zero', updated_at: 0 }, { id: 'none' }]).map((r) => r.id),
      ['zero', 'none'],
    )
  })

  it('JsonStore.merge() returns exactly that order', async () => {
    const { store, cleanup } = await scratchStore('lindela-order')
    try {
      await store.write({})
      // Deliberately out of order on the way in, so a backend that preserved
      // arrival order would fail this.
      await store.merge({
        hazard_events: [
          { id: 'hz-a', observed_at: '2026-01-01T00:00:00.000Z' },
          { id: 'hz-c', observed_at: '2026-03-01T00:00:00.000Z' },
          { id: 'hz-b', observed_at: '2026-02-01T00:00:00.000Z' },
        ],
      })
      assert.deepEqual((await store.read()).hazard_events.map((r) => r.id), ['hz-c', 'hz-b', 'hz-a'])
    } finally {
      await cleanup()
    }
  })
})

describe('against a real PostgreSQL', () => {
  let cluster
  let store

  /** Skips loudly; fails outright under CI, where a green run must have meant something. */
  const needsPostgres = (t) => {
    const reason = cluster?.skipped
    if (!reason) return false
    if (process.env.CI) {
      throw new Error(
        `CI ran this file without PostgresStore exercised: ${reason}. A green run that never `
        + 'touched the adapter is not the run the job claims to have made.',
      )
    }
    t.skip(`no PostgreSQL: ${reason}`)
    return true
  }

  before(async () => {
    cluster = await postgresCluster({ name: 'lindela-decl' })
    if (!cluster.skipped) {
      store = new PostgresStore({ databaseUrl: cluster.url })
      await store.ensureSchema()
    }
    if (cluster.skipped) process.stderr.write(`store-schema-declaration: ${cluster.skipped}\n`)
  })

  after(async () => {
    await store?.close()
    await cluster?.stop()
  })

  it('enforces the declaration at runtime, not just in source', async (t) => {
    if (needsPostgres(t)) return
    await assert.rejects(() => store.merge({ hazard_evesnts: [{ id: 'x' }] }), /Undeclared collection/)
    await store.merge({ hazard_events: [{ id: 'hz-1', observed_at: '2026-01-01T00:00:00.000Z' }] })
    assert.equal((await store.read()).hazard_events.length, 1, 'a refused merge must not wedge the store')
  })

  it('stores every declared collection', async (t) => {
    if (needsPostgres(t)) return
    await store.write({})
    await store.write(Object.fromEntries(COLLECTIONS.map((c) => [c, [{ id: `${c}-1` }]])))
    // `includeHistory` because `record_versions` is 60% of a real store by bytes
    // and nothing reads it, so the default read leaves it out (ENH-08). This
    // test is the one place that is specifically about it surviving a round
    // trip, which is a different question from whether a normal read pays for
    // it.
    const data = await store.read({ includeHistory: true })
    for (const collection of COLLECTIONS) {
      assert.deepEqual(data[collection].map((r) => r.id), [`${collection}-1`], `${collection} did not round-trip`)
    }
  })

  // The divergence this file closes. PostgresStore ordered by an updated_at
  // column stamped now() at write time, so re-ingesting older data sorted it
  // above newer data — the opposite of the JSON backend, on the same records.
  it('returns the same order as the JSON backend', async (t) => {
    if (needsPostgres(t)) return
    await store.write({})
    await store.merge({
      hazard_events: [
        { id: 'hz-a', observed_at: '2026-01-01T00:00:00.000Z' },
        { id: 'hz-c', observed_at: '2026-03-01T00:00:00.000Z' },
        { id: 'hz-b', observed_at: '2026-02-01T00:00:00.000Z' },
      ],
    })
    assert.deepEqual((await store.read()).hazard_events.map((r) => r.id), ['hz-c', 'hz-b', 'hz-a'])
  })

  it('replaceAnalytics replaces all six derived collections and nothing else', async (t) => {
    if (needsPostgres(t)) return
    await store.write({})
    await store.merge({ hazard_events: [{ id: 'hz-keep', observed_at: '2026-01-01T00:00:00.000Z' }] })
    await store.replaceAnalytics({
      ...Object.fromEntries(DERIVED_COLLECTIONS.map((c, i) => [c, [{ id: `${c}-${i}`, observed_at: '2026-01-01T00:00:00.000Z' }]])),
      hazard_events: [{ id: 'hz-should-not-be-here' }],
    })
    const data = await store.read()
    for (const collection of DERIVED_COLLECTIONS) {
      assert.equal(data[collection].length, 1, `${collection} must reach the store on every backend`)
    }
    assert.deepEqual(data.hazard_events.map((r) => r.id), ['hz-keep'], 'ingested data is not analytics')
  })

  it('clears a derived collection the caller sends empty', async (t) => {
    // replaceAnalytics replaces wholesale, so an omitted collection means
    // "this refresh produced none" — not "leave the last run's rows".
    if (needsPostgres(t)) return
    await store.write({})
    await store.replaceAnalytics({ risk_scores: [{ id: 'rs-old' }] })
    await store.replaceAnalytics({ risk_scores: [] })
    assert.deepEqual((await store.read()).risk_scores, [])
  })
})

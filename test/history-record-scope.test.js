import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { PostgresStore, readPredicate } from '../src/postgres-store.js'
import { recordScopeForRequest } from '../src/route-manifests.js'
import { createServer } from '../src/server.js'
import { JsonStore, normaliseRecordScope } from '../src/store.js'
import { postgresCluster } from './pg-harness.mjs'

/**
 * ENH-12, the read half — a record-scoped read of the version history.
 *
 * `/api/v1/history/:collection/record` answers about *one* record, and it did so
 * by reading the whole store. Both history routes resolve to a `null` manifest —
 * they are in `WIDE_ROUTES` — so the read was every declared collection with
 * history on: 50,111 rows on the demo store, 34,058 of them version rows, and
 * `versionsFor`'s `v.record_id === recordId` filter ran in JavaScript over all
 * of them. A record with one revision cost 34,058 rows to answer.
 *
 * The scope is the fix, and it needs no schema change: migration 4's
 * `lite_records_version_record_idx` already carries `(body->>'record_id')`, so
 * the version branch is answerable from an index. That is what refutes the
 * remaining half of ENH-12 rather than deferring it — the proposed real
 * `record_id` column buys a further 1.4× on a plan that is already 66× faster
 * than the sequential scan, which is not a four-week migration.
 *
 * Two properties, and the second is the one a single-adapter test cannot see:
 *
 *   1. the scope reaches the read at all — the route's request carries it;
 *   2. both adapters select the *same rows* for it. `normaliseReadOptions` and
 *      this scope exist because the two stores drifting is ARC-10, and a scope
 *      one honours and the other ignores is a result that depends on an
 *      environment variable.
 */

/** A store with two records revised, and a third collection's history alongside. */
async function seed(store) {
  const stamp = (n) => ({ first_seen_at: `2026-01-0${n}T00:00:00Z` })
  // h1 is revised twice: three believed-for intervals, two version rows.
  await store.merge({ hazard_events: [{ id: 'h1', district: 'Turkana', ...stamp(1) }] })
  await store.merge({ hazard_events: [{ id: 'h1', district: 'Turkana', fatalities: 4, ...stamp(2) }] })
  await store.merge({ hazard_events: [{ id: 'h1', district: 'Turkana', fatalities: 7, ...stamp(3) }] })
  // h2 is revised once. A scope for h1 must not bring h2's revision with it.
  await store.merge({ hazard_events: [{ id: 'h2', district: 'Marsabit', ...stamp(1) }] })
  await store.merge({ hazard_events: [{ id: 'h2', district: 'Marsabit', fatalities: 2, ...stamp(2) }] })
  // A different bitemporal collection, so a scope for hazard_events cannot be
  // satisfied by "everything in record_versions".
  await store.merge({ climate_observations: [{ id: 'c1', district: 'Turkana', ...stamp(1) }] })
  await store.merge({ climate_observations: [{ id: 'c1', district: 'Turkana', rainfall: 40, ...stamp(2) }] })
}

describe('ENH-12 — the record scope, resolved from the request', () => {
  const search = (q) => new URLSearchParams(q)

  it('names the collection from the path and the record from ?id=', () => {
    assert.deepEqual(
      recordScopeForRequest('GET', '/api/v1/history/hazard_events/record', search('id=h1')),
      { collection: 'hazard_events', recordId: 'h1' },
    )
  })

  it('leaves the record unscoped when ?id= is absent, rather than guessing', () => {
    // The handler answers its own 400 for a missing id. A resolver that invented
    // one would answer the wrong record; one that scoped to `undefined` would
    // read nothing and report "no history" for a record that has some.
    assert.deepEqual(
      recordScopeForRequest('GET', '/api/v1/history/hazard_events/record', search('')),
      { collection: 'hazard_events', recordId: null },
    )
  })

  it('does not scope the series route, which asks about a whole collection', () => {
    assert.equal(recordScopeForRequest('GET', '/api/v1/history/hazard_events', search('id=h1')), null)
  })

  it('does not scope a collection that has no history', () => {
    // `field_reports` is an event, not a state. A scope for it would reach the
    // store, be refused by `assertDeclaredCollection`, and turn the handler's
    // honest "not projectable" answer into a 500.
    assert.equal(recordScopeForRequest('GET', '/api/v1/history/field_reports/record', search('id=f1')), null)
    assert.equal(recordScopeForRequest('GET', '/api/v1/history/nonsense/record', search('id=x')), null)
  })

  it('does not scope a write, or an unrelated route', () => {
    assert.equal(recordScopeForRequest('POST', '/api/v1/history/hazard_events/record', search('id=h1')), null)
    assert.equal(recordScopeForRequest('GET', '/api/v1/incidents/1', search('id=h1')), null)
  })

  it('refuses a scope with no collection instead of silently reading the store', () => {
    // The expensive direction, arrived at by a typo. `{}` and `{ recordId }` are
    // both a caller that meant to narrow the read.
    assert.throws(() => normaliseRecordScope({ recordId: 'h1' }), /requires a collection/)
    assert.throws(() => normaliseRecordScope({ collection: '' }), /requires a collection/)
    assert.throws(() => normaliseRecordScope({ collection: 'no_such_collection' }), /Unknown collection/)
  })
})

describe('ENH-12 — the scope reaches the read', () => {
  let store
  let dir

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-enh12-scope-'))
    store = new JsonStore(path.join(dir, 'store.json'))
    await seed(store)
  })
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns the record and its revisions, and nothing else', async () => {
    const data = await store.read({
      collections: null, includeHistory: true,
      recordScope: { collection: 'hazard_events', recordId: 'h1' },
    })
    assert.deepEqual(data.hazard_events.map((r) => r.id), ['h1'],
      'a scope for one record returned another')
    assert.equal(data.record_versions.length, 2, 'h1 was revised twice and its two revisions are the answer')
    assert.ok(
      data.record_versions.every((v) => v.collection === 'hazard_events' && v.record_id === 'h1'),
      'a revision for another record or collection came through the scope',
    )
    // The collections the scope does not name are present and empty, not absent
    // — the `manifestShape` contract, which a scope must not break.
    assert.deepEqual(data.climate_observations, [])
    assert.deepEqual(data.incidents, [])
  })

  it('keeps a whole collection of revisions when only the collection is named', async () => {
    // The series route's question. `recordId: null` is "this collection's
    // history", which is not the same as "no scope".
    const data = await store.read({
      collections: null, includeHistory: true,
      recordScope: { collection: 'hazard_events' },
    })
    assert.deepEqual(data.hazard_events.map((r) => r.id).sort(), ['h1', 'h2'])
    assert.equal(data.record_versions.length, 3, 'h1 has two revisions and h2 one')
    assert.ok(data.record_versions.every((v) => v.collection === 'hazard_events'))
  })

  it('counts the scoped rows against the budget, not the collection', async () => {
    // SCL-01. The budget must count what the read returns. Counting the whole
    // collection would refuse a read the store is about to serve, which is a 503
    // on a request that is cheap.
    const tight = new JsonStore(path.join(dir, 'store.json'), { readRowBudget: 5 })
    const data = await tight.read({
      collections: null, includeHistory: true,
      recordScope: { collection: 'hazard_events', recordId: 'h1' },
    })
    assert.equal(data.hazard_events.length + data.record_versions.length, 3)
  })

  it('the record route serves the same answer over HTTP as the scope does', async () => {
    const listener = createServer({ store }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      const res = await fetch(`${base}/api/v1/history/hazard_events/record?id=h1`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.data.record_id, 'h1')
      assert.equal(body.data.revisions, 2, 'the route read fewer rows than the record has revisions')
      assert.equal(body.data.current.fatalities, 7, 'the live row did not come through the scope')
    } finally {
      listener.close()
    }
  })
})

describe('ENH-12 — the SQL predicate, and both adapters agreeing', () => {
  it('pushes the scope into the WHERE clause rather than filtering after the fact', () => {
    const { clauses, params } = readPredicate({
      collections: null, includeHistory: true,
      recordScope: { collection: 'hazard_events', recordId: 'h1' },
    })
    const sql = clauses.join(' AND ')
    assert.match(sql, /body->>'record_id'/, 'the version branch is absent, so every revision is read')
    assert.match(sql, /body->>'collection'/, 'the version branch does not constrain the source collection')
    assert.ok(sql.includes(' OR '), 'one branch cannot serve both the live row and the version rows')
    assert.ok(params.includes('hazard_events') && params.includes('h1'))
  })

  it('names the record only when there is one', () => {
    const { clauses } = readPredicate({
      collections: null, includeHistory: true, recordScope: { collection: 'hazard_events' },
    })
    const sql = clauses.join(' AND ')
    assert.ok(!sql.includes("record_id' ="), 'a collection-only scope must keep every record\'s revisions')
    assert.match(sql, /body->>'collection'/)
  })

  it('leaves the predicate unchanged when there is no scope', () => {
    const bare = readPredicate({ collections: ['hazard_events'], includeHistory: true }).clauses.join(' AND ')
    assert.ok(!bare.includes('record_id'), 'an unscoped read grew a record predicate')
    assert.equal(readPredicate({}).clauses.length, 2, 'no scope, no history: __schema and record_versions')
  })

  describe('the same rows on both backends', () => {
    let cluster
    before(async () => { cluster = await postgresCluster() })
    after(async () => { await cluster?.stop() })

    it('JsonStore and PostgresStore select identical rows for one scope', async (t) => {
      if (cluster.skipped) { t.skip(cluster.skipped); return }
      const jsonDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-enh12-both-'))
      const pg = new PostgresStore({ databaseUrl: cluster.url })
      try {
        const json = new JsonStore(path.join(jsonDir, 'store.json'))
        await seed(json)
        await seed(pg)
        const options = {
          collections: null, includeHistory: true,
          recordScope: { collection: 'hazard_events', recordId: 'h1' },
        }
        const fromJson = await json.read(options)
        const fromPg = await pg.read(options)
        // Compared on `(collection, record_id)`, not on the version row's own
        // `id`: that id is `stableId('version', [collection, recordId, validFrom,
        // supersededAt])` and `supersededAt` defaults to `nowIso()`, so the two
        // seedings run at different instants and their ids differ *by design*.
        // Comparing ids would compare two clocks and fail on a correct scope.
        const keys = (rows) => rows.map((r) => `${r.collection}:${r.record_id}`).sort()
        for (const collection of ['hazard_events', 'record_versions', 'climate_observations']) {
          assert.deepEqual(
            collection === 'record_versions' ? keys(fromPg[collection]) : fromPg[collection].map((r) => r.id).sort(),
            collection === 'record_versions' ? keys(fromJson[collection]) : fromJson[collection].map((r) => r.id).sort(),
            `${collection} differs between the adapters under a record scope`,
          )
        }
        assert.equal(fromPg.record_versions.length, 2)
      } finally {
        // `cluster.stop()` drops the private database this store was pointed at,
        // so the rows need no deletion — only the pool does, or the process
        // holds a connection past the test and node:test reports asynchronous
        // activity after the run.
        await pg.close()
        await fs.rm(jsonDir, { recursive: true, force: true })
      }
    })
  })
})

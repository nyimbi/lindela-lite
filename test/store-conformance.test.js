import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { JsonStore, COLLECTIONS } from '../src/store.js'
import { PostgresStore } from '../src/postgres-store.js'
import { runIngestion, OUTPUT_COLLECTIONS } from '../src/ingestion.js'

/**
 * One contract, run against every storage backend.
 *
 * The backend disagreement it exists to end: `replaceAnalytics` took four
 * collections on Postgres where the caller passes six, so population_at_risk
 * and facilities_at_risk — the impact figures that move the platform from
 * hazard intensity to consequence — were computed and silently discarded.
 * JsonStore was correct. Nothing compared them, and PostgresStore ran at 0%
 * function coverage in CI, so both facts were invisible.
 *
 * Anything asserted here is a promise the API makes to a caller who does not
 * know or care which backend an environment variable selected.
 */

const testDatabaseUrl = process.env.LINDELA_LITE_TEST_DATABASE_URL

/** Each backend hands back a store and its own teardown, so no test can
 *  clean up by guessing at a path — os.tmpdir() is shared. */
async function jsonBackend() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-conformance-'))
  return { store: new JsonStore(path.join(dir, 'store.json')), cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

async function postgresBackend() {
  const store = new PostgresStore({ databaseUrl: testDatabaseUrl })
  return {
    store,
    cleanup: async () => {
      await store.ensureSchema()
      await store.pool.query('DELETE FROM lite_records')
      await store.close()
    },
  }
}

const backends = [{ name: 'json', make: jsonBackend }]
if (testDatabaseUrl) backends.push({ name: 'postgres', make: postgresBackend })

// A skipped backend is the same failure as a check that measured nothing: the
// suite reads "store conformance — both backends, one contract" either way, and
// the report says one adapter passed where the contract is about two. Nothing
// in CI set LINDELA_LITE_TEST_DATABASE_URL, so PostgresStore ran at 0% function
// coverage in CI for the entire life of this file — and the bug this suite was
// written to catch (replaceAnalytics taking four collections on Postgres where
// the caller passes six) was a Postgres bug.
//
// So the skip is announced. Locally, one line on stderr. Under CI, where the
// Postgres service is defined, it is a failure: a green run that never touched
// Postgres is not the run the job claims to have made.
if (!testDatabaseUrl && process.env.CI) {
  throw new Error(
    'CI has no LINDELA_LITE_TEST_DATABASE_URL, so the store conformance suite ran '
    + 'against JsonStore alone while reporting that it covers both backends. Add the '
    + 'postgres service to the job and point this variable at it.',
  )
}
if (!testDatabaseUrl) {
  process.stderr.write(
    'store-conformance: PostgresStore NOT exercised — LINDELA_LITE_TEST_DATABASE_URL is unset.\n'
    + '  The contract below ran against JsonStore only. Any divergence between the two\n'
    + '  adapters is unmeasured, which is the defect this file exists to find.\n',
  )
}

const hazard = (id, extra = {}) => ({
  id,
  event_type: 'flood',
  source: 'test',
  severity: 'moderate',
  country: 'KEN',
  ...extra,
})

describe('store conformance — both backends, one contract', () => {
  for (const backend of backends) {
    describe(backend.name, () => {
      let store
      let cleanup
      before(async () => {
        const made = await backend.make()
        store = made.store
        cleanup = made.cleanup
        await store.ensureSchema?.()
      })
      after(async () => {
        await cleanup?.()
      })

      it('merges by id without discarding fields the caller did not send', async () => {
        await store.write({ hazard_events: [] })
        await store.merge({ hazard_events: [hazard('hz-1', { location: 'Turkana' })] })
        await store.merge({ hazard_events: [{ id: 'hz-1', note: 'late correction' }] })
        const events = (await store.read()).hazard_events
        assert.equal(events.length, 1)
        assert.equal(events[0].location, 'Turkana', 'an unmentioned field must survive a partial update')
        assert.equal(events[0].note, 'late correction')
      })

      // DAT-01. payload_hash is a real column. Before this fix write() omitted
      // it, so after a single full write every stored hash read back null and
      // content-addressed dedup was dead for the life of the table — with no
      // error anywhere, because a null hash simply never matches.
      it('keeps payload_hash through a full write so dedup survives', async () => {
        await store.write({
          hazard_events: [
            hazard('hz-a', { payload_hash: 'hash-a' }),
            hazard('hz-b', { payload_hash: 'hash-b' }),
          ],
        })
        // A third record carrying an already-stored hash must be recognised as
        // a duplicate. With the column null it looks brand new and is inserted.
        await store.merge({ hazard_events: [hazard('hz-c', { payload_hash: 'hash-a' })] })
        const events = (await store.read()).hazard_events
        assert.equal(events.length, 2, 'a record whose payload_hash is already stored must not be inserted')
        assert.equal(events.some((event) => event.id === 'hz-c'), false)
      })

      // DAT-05. Two defects in three lines: four parameters where the caller
      // passes six, and merge() where replace() was meant.
      it('replaceAnalytics stores all six derived collections', async () => {
        await store.write({})
        await store.replaceAnalytics({
          risk_scores: [{ id: 'rs-1', region: 'Turkana', score: 61 }],
          impact_assessments: [{ id: 'ia-1', region: 'Turkana' }],
          data_quality: [{ id: 'dq-1', source: 'chirps', completeness: 0.9 }],
          population_at_risk: [{ id: 'par-1', at_risk_count: 12000 }],
          facilities_at_risk: [{ id: 'far-1', at_risk_count: 34 }],
          road_access: [{ id: 'ra-1', district: 'Turkana' }],
        })
        const data = await store.read()
        assert.deepEqual(data.risk_scores.map((r) => r.id), ['rs-1'])
        assert.deepEqual(data.impact_assessments.map((r) => r.id), ['ia-1'])
        assert.deepEqual(data.data_quality.map((r) => r.id), ['dq-1'])
        assert.equal(data.population_at_risk.length, 1, 'population_at_risk must reach the store on every backend')
        assert.equal(data.facilities_at_risk.length, 1, 'facilities_at_risk must reach the store on every backend')
        assert.deepEqual(data.road_access.map((r) => r.id), ['ra-1'])
      })

      it('replaceAnalytics replaces rather than accumulates stale rows', async () => {
        await store.replaceAnalytics({ risk_scores: [{ id: 'rs-old', region: 'Withdrawn' }] })
        await store.replaceAnalytics({ risk_scores: [{ id: 'rs-new', region: 'Turkana' }] })
        const ids = (await store.read()).risk_scores.map((r) => r.id)
        assert.deepEqual(ids, ['rs-new'], 'a region that stops qualifying must lose its stale score')
      })

      // DAT-07. merge() keyed on id, so re-merging the survivors of a retention
      // pass left every expired record exactly where it was. The route reported
      // {success: true, expired: 1} and deleted nothing.
      it('remove() deletes by id', async () => {
        await store.write({
          hazard_events: [hazard('hz-keep'), hazard('hz-drop')],
        })
        await store.remove({ collection: { hazard_events: ['hz-drop'] } })
        const ids = (await store.read()).hazard_events.map((e) => e.id).sort()
        assert.deepEqual(ids, ['hz-keep'])
      })

      it('remove() leaves other collections untouched', async () => {
        await store.merge({ conflict_events: [{ id: 'ce-1', event_type: 'protest', source: 'test' }] })
        await store.merge({ hazard_events: [hazard('hz-tmp')] })
        await store.remove({ collection: { hazard_events: ['hz-tmp'] } })
        assert.equal((await store.read()).conflict_events.length, 1)
      })

      it('remove() refuses a collection it does not know', async () => {
        await assert.rejects(
          () => store.remove({ collection: { not_a_collection: ['x'] } }),
          /Unknown collection/,
          'an unlisted collection is a programming error, not a silent no-op',
        )
        await store.write({})
        await store.merge({ hazard_events: [hazard('hz-after-reject')] })
        assert.equal((await store.read()).hazard_events.length, 1, 'a rejected remove must not wedge the store')
      })

      // DAT-03. Twenty concurrent merges against one JSON file left six
      // survivors: each caller read the same snapshot and the last writer won.
      it('does not lose records under concurrent writes', async () => {
        await store.write({})
        await Promise.all(
          Array.from({ length: 20 }, (_, index) => store.merge({ hazard_events: [hazard(`hz-c${index}`)] })),
        )
        const ids = (await store.read()).hazard_events.map((e) => e.id)
        assert.equal(ids.length, 20, `lost writes under concurrency: ${20 - ids.length} of 20`)
      })

      it('round-trips every collection in COLLECTIONS', async () => {
        const payload = Object.fromEntries(COLLECTIONS.map((collection) => [collection, [{ id: `${collection}-1` }]]))
        await store.write(payload)
        const data = await store.read()
        for (const collection of COLLECTIONS) {
          assert.deepEqual(data[collection].map((r) => r.id), [`${collection}-1`], `${collection} did not round-trip`)
        }
      })
    })
  }

  // DAT-02. countRecords() named four collections while the merge accumulator
  // handled six, so ipc_hdx — which returns only food_security_records —
  // reported "degraded — expected at least 1 records; received 0" on a fully
  // successful run. Ingestion claimed failure on the two newest and most
  // operationally important sources. Asserted by driving ingestion with stub
  // connectors, not by grepping for the spelling of a collection name.
  describe('ingestion counts what it stores', () => {
    let store
    let dir
    before(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-conformance-ingest-'))
      store = new JsonStore(path.join(dir, 'store.json'))
    })
    after(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('reports the records a single-collection source actually produced', async () => {
      const connectors = {
        ipc_hdx: {
          id: 'ipc_hdx',
          ingest: async () => ({
            // Descriptor-shaped, per src/assertions.js:343 and the connector's
            // own output at src/connectors/ipc-hdx.js:195,:217. The first draft
            // of this fixture omitted `source_id` and `observed_at`, and the
            // quarantine gate correctly condemned it — so the run reported
            // "degraded" for reasons that had nothing to do with what this
            // suite measures.
            food_security_records: [
              { id: 'fs-1', source_id: 'KEN:Turkana:2026-01:2025-10', country: 'KEN', area: 'Turkana', observed_at: '2026-01-01T00:00:00.000Z', phase3plus_number: 375900, phase3plus_fraction: 0.42 },
              { id: 'fs-2', source_id: 'KEN:Marsabit:2026-01:2025-10', country: 'KEN', area: 'Marsabit', observed_at: '2026-01-01T00:00:00.000Z', phase3plus_number: 210000, phase3plus_fraction: 0.31 },
            ],
          }),
        },
      }
      const result = await runIngestion(store, { sources: ['ipc_hdx'] }, { connectors })
      const run = result.source_runs[0]
      assert.equal(run.status, 'success', `a successful run reported "${run.status}": ${JSON.stringify(run.errors)}`)
      assert.equal(run.records_processed, 2)
      assert.equal(run.records_by_collection.food_security_records, 2)
      assert.equal(result.counts.food_security_records, 2)
      assert.equal((await store.read()).food_security_records.length, 2, 'the records must actually reach the store')
    })

    it('counts WHO disease observations too', async () => {
      const connectors = {
        who_gho: {
          id: 'who_gho',
          ingest: async () => ({
            // Likewise src/assertions.js:377 — `source_id` and `observed_at`
            // are required, and who-gho.js:121,:134 mints both.
            disease_observations: [
              { id: 'dob-1', source_id: 'CHOLERA_0000000001:KEN:2016', indicator_code: 'CHOLERA_0000000001', country: 'KEN', year: 2016, observed_at: '2016-01-01T00:00:00.000Z', value: 3120 },
            ],
          }),
        },
      }
      const result = await runIngestion(store, { sources: ['who_gho'] }, { connectors })
      const run = result.source_runs.find((r) => r.source === 'who_gho')
      assert.equal(run.records_processed, 1)
      assert.equal(run.records_by_collection.disease_observations, 1)
    })

    it('every ingestion output collection is one the store can hold', async () => {
      // The third consumer of this list. COLLECTIONS, OUTPUT_COLLECTIONS and
      // emptyStore() drifting apart is how records get dropped without error.
      for (const collection of OUTPUT_COLLECTIONS) {
        assert.ok(COLLECTIONS.includes(collection), `${collection} is ingested but not storable`)
      }
    })
  })
})
/**
 * R-41, R-42, R-43, R-44, R-45, R-10, R-17, R-05, R-11: the ingestion items
 * where the system knew something was wrong and said nothing.
 *
 * Every test here drives `runIngestion` against a real `JsonStore` with fake
 * connectors. No source-text assertions: grepping `src/ingestion.js` for
 * `trailingRecords` passes just as happily against a call argument that is
 * constructed empty in production, which is precisely what happened — the tests
 * passed `trailingRecords` in twenty-one places and the production caller
 * passed it in zero.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'

import {
  ingestionStatus,
  runIngestion,
  circuitStateRows,
  loadCircuitState,
  CIRCUIT_COLLECTION,
} from '../src/ingestion.js'
import { COLLECTIONS, JsonStore } from '../src/store.js'
import { EMPTY_RESPONSE_MIN_RUNS } from '../src/freshness.js'
import { CIRCUIT_FAILURE_THRESHOLD } from '../src/circuit.js'
import { activeRecordingKeys, fetchRecording } from '../src/connectors/http.js'
import { RATE_LIMIT_POLICIES } from '../src/rate-limit.js'

let dir
before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-silence-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

let seq = 0
async function freshStore() {
  return new JsonStore(path.join(dir, `store-${process.pid}-${seq++}.json`))
}

/**
 * A store that declares `connector_circuit`.
 *
 * `src/store.js` owns `SCHEMA` and this change does not, so the collection is
 * not declared yet and `JsonStore.merge` throws on it. The wrapper says it can
 * hold the collection; `runIngestion` believes a store that names its own
 * collections over the module default. This is what proves the whole
 * persist-and-reload path, and the day the declaration lands in SCHEMA the
 * wrapper is redundant and every assertion here still holds.
 *
 * `withoutCircuitCollection` below asserts the other half: that an undeclared
 * store is *told* the breaker is not persisted rather than silently reverting.
 */
async function storeWithCircuit() {
  const store = await freshStore()
  store.declaredCollections = [...COLLECTIONS, CIRCUIT_COLLECTION]
  const merge = store.merge.bind(store)
  const circuit = { rows: [] }
  store.__circuit = circuit
  store.merge = async (payload) => {
    const rest = {}
    for (const [key, rows] of Object.entries(payload || {})) {
      if (key !== CIRCUIT_COLLECTION) { rest[key] = rows; continue }
      const byId = new Map(circuit.rows.map((row) => [row.id, row]))
      for (const row of rows || []) byId.set(row.id, row)
      circuit.rows = [...byId.values()]
    }
    const result = Object.keys(rest).length ? await merge(rest) : null
    if (result) result[CIRCUIT_COLLECTION] = circuit.rows
    return result
  }
  const read = store.read.bind(store)
  store.read = async () => {
    const data = await read()
    return { ...data, [CIRCUIT_COLLECTION]: circuit.rows }
  }
  return store
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString()

/** A connector returning `n` hazard events. */
const gdacs = (n) => ({
  id: 'gdacs',
  async ingest() {
    return {
      hazard_events: Array.from({ length: n }, (_, i) => ({
        id: `hz_${n}_${i}`,
        source_id: `g:${n}:${i}`,
        event_type: 'flood',
        severity: 'warning',
        title: `event ${i}`,
        country: 'Kenya',
        region_name: 'Baringo',
        event_date: '2026-09-01',
        occurred_at: '2026-09-01T00:00:00.000Z',
        latitude: 0.5,
        longitude: 35.5,
      })),
    }
  },
})

const connectors = (gdacsConnector) => ({ gdacs: gdacsConnector })

describe('the count assertion runs in production (R-42)', () => {
  it('judges a collapsing count against the trailing window from the store', async () => {
    const store = await freshStore()
    // Three healthy runs of 40 records, then one of 4 — a 90% collapse, the
    // GDACS shape the assertion was written for and never given the data to
    // see.
    for (let i = 0; i < 3; i += 1) {
      await runIngestion(store, { sources: ['gdacs'] }, { connectors: connectors(gdacs(40)) })
    }
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: connectors(gdacs(4)) })

    const run = (await store.read()).source_runs[0]
    const report = run.assertion_report
    assert.ok(report, 'the assertion report must be persisted on the run')
    assert.equal(report.ok, false, 'a 90% collapse must trip the count assertion')

    const failure = report.failures.find((f) => f.kind === 'min_count_vs_trailing')
    assert.ok(failure, `expected a count failure, got ${JSON.stringify(report.failures.map((f) => f.kind))}`)
    assert.match(failure.message, /against a trailing median/u)
    // R-43. The structured detail used to be discarded along with `stats`; the
    // flattened `.message` was all that survived.
    assert.ok(failure.detail, 'the failure keeps its structured detail')
    assert.equal(typeof failure.detail.trailing_median, 'number')
    assert.equal(failure.detail.trailing_median, 40)
    assert.equal(failure.detail.records_found, 4)
    assert.equal(run.assertions_failed, 1)
  })

  it('records the trailing baseline it was judged against, and what was unmeasured', async () => {
    const store = await freshStore()
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: connectors(gdacs(40)) })
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: connectors(gdacs(40)) })
    const run = (await store.read()).source_runs[0]
    assert.equal(run.assertion_report.trailing.runs, 1, 'one prior run is in the window')
    assert.equal(run.assertion_report.trailing.counts[0], 40)
    assert.equal(run.assertion_report.trailing.median, 40)
    assert.ok(Array.isArray(run.assertion_report.unmeasured))
    assert.equal(run.assertion_report.record_count, 40)
    assert.equal(run.diagnostics.assertions_failed, 0)
  })

  it('reports null, not a pass, on a run that never reached the connector', async () => {
    const store = await freshStore()
    await runIngestion(store, { sources: ['gdacs'] }, {
      connectors: { gdacs: { id: 'gdacs', async ingest() { throw new Error('ETIMEDOUT') } } },
    })
    const run = (await store.read()).source_runs[0]
    assert.equal(run.status, 'failed')
    assert.equal(run.assertion_report, null, 'no assertions ran; that is not the same as a clean pass')
  })
})

describe('the breaker survives the run (R-41)', () => {
  it('round-trips through the store and reaches its threshold across runs', async () => {
    // The defect: state was created per `runIngestion` call and each source is
    // visited once per run, so `consecutive_failures` could reach 1 against a
    // threshold of 3. The breaker could not trip and `/ingest/status` scored a
    // breaker that did not exist.
    const store = await storeWithCircuit()
    const dead = { gdacs: { id: 'gdacs', async ingest() { throw new Error('HTTP 502') } } }

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await runIngestion(store, { sources: ['gdacs'] }, { connectors: dead })
    }

    const rows = (await store.read()).connector_circuit || []
    assert.equal(rows.length, 1, 'the breaker is persisted, one row per source')
    assert.equal(rows[0].source, 'gdacs')
    assert.equal(rows[0].circuit_state, 'open', 'three failures is a trip')
    assert.equal(rows[0].consecutive_failures, CIRCUIT_FAILURE_THRESHOLD)

    // The next run is gated, and the gate is the same state the score reads.
    const skipped = await runIngestion(store, { sources: ['gdacs'] }, { connectors: dead })
    assert.equal(skipped.source_runs[0].status, 'skipped')
    assert.equal(skipped.source_runs[0].verdict, 'skipped_circuit_open')

    const [status] = ingestionStatus(await store.read()).filter((s) => s.source === 'gdacs')
    assert.equal(status.circuit.state, 'open', 'the status route reports the breaker the gate uses')
    assert.equal(status.circuit.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD)
    assert.equal(status.circuit.persisted, true)
  })

  it('loads persisted state back into the shape the breaker mutates', () => {
    const state = loadCircuitState(circuitStateRows({
      version: 1,
      sources: { chirps: { state: 'open', consecutive_failures: 3, opened_at: 1, probe_in_flight: true, history: [] } },
    }))
    assert.equal(state.sources.chirps.state, 'open')
    assert.equal(state.sources.chirps.consecutive_failures, 3)
    // A probe claim cannot survive a process restart; a persisted `true` would
    // wedge the source in `skipped_circuit_probe_in_flight` with nobody to
    // clear it.
    assert.equal(state.sources.chirps.probe_in_flight, false)
  })

  it('declares the collection name the store needs', () => {
    assert.equal(CIRCUIT_COLLECTION, 'connector_circuit')
  })

  it('says so when the store cannot hold the breaker, rather than reporting closed', async () => {
    // An undeclared `connector_circuit` must not take every ingestion run down
    // (assertDeclaredCollections throws), and it must not be papered over
    // either. `circuit_persisted: false` and `circuit.state: 'closed'` together
    // are the honest pair: nothing tripped, and nothing would have remembered.
    // A store that genuinely cannot hold it.
    //
    // `connector_circuit` is declared in `SCHEMA` now, so an ordinary store
    // persists it and the premise of this test is gone. The degradation path
    // still matters — a deployment on an older schema, or a store that names a
    // narrower set — so the store narrows its own declaration explicitly
    // rather than relying on the default happening to be missing. That also
    // exercises the rule the write path now follows: a store naming its own
    // collections is believed over the module default.
    const store = await freshStore()
    store.declaredCollections = COLLECTIONS.filter((c) => c !== CIRCUIT_COLLECTION)
    const result = await runIngestion(store, { sources: ['gdacs'] }, { connectors: connectors(gdacs(5)) })
    assert.equal(result.circuit_persisted, false)
    const [status] = ingestionStatus(await store.read()).filter((s) => s.source === 'gdacs')
    // `status.circuit.persisted` is deliberately not asserted here.
    //
    // `ingestionStatus(data)` takes a snapshot, not a store: a snapshot with no
    // `connector_circuit` rows cannot distinguish "this deployment cannot hold
    // the collection" from "nothing has tripped yet", and guessing either way
    // would be the same error the write path was fixed for. The run's own
    // `circuit_persisted` above is the verdict that is actually knowable,
    // because that is where the store is in hand.
    assert.equal(status.circuit.state, 'closed')
    assert.equal(status.circuit.consecutive_failures, 0)
  })

  it('recovers a half-open source and closes the breaker again', async () => {
    const store = await storeWithCircuit()
    const dead = { gdacs: { id: 'gdacs', async ingest() { throw new Error('HTTP 502') } } }
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await runIngestion(store, { sources: ['gdacs'] }, { connectors: dead })
    }
    // Age the trip past the 30-minute cooldown. Written rather than waited out:
    // the breaker reads `opened_at`, so moving the recorded time is exactly
    // what an operator's coffee and a half hour do.
    const tripped = (await store.read()).connector_circuit[0]
    const agedAt = Date.now() - 31 * 60_000
    await store.merge({
      connector_circuit: [{
        ...tripped,
        opened_at: agedAt,
        // The nested `state` is what the breaker reads; the mirrored top-level
        // fields exist so a reader paging the collection can filter on them.
        state: { ...tripped.state, opened_at: agedAt },
      }],
    })
    // Past the cooldown, the next call is the single half-open probe.
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: connectors(gdacs(40)) })
    const row = (await store.read()).connector_circuit[0]
    assert.equal(row.circuit_state, 'closed', 'a successful probe closes the breaker')
    assert.equal(row.consecutive_failures, 0)
  })
})

describe('two runs of one source are two runs (found by R-45)', () => {
  it('does not collapse two same-millisecond runs into one row', async () => {
    // `stableId('run', [source, started_at, status, errors])` with a
    // millisecond `nowIso()` gives two back-to-back runs the same id, and
    // `mergeById` keys on id — so the second run's row overwrote the first with
    // no error anywhere. Found by the R-45 test flaking: sometimes two runs,
    // sometimes one, depending on whether the two calls straddled a
    // millisecond boundary.
    //
    // The consequence is not a cosmetic duplicate: `source_runs` is the
    // trailing window every count assertion and every freshness verdict reads,
    // so a dropped run makes both one run behind reality.
    const store = await freshStore()
    const connector = connectors(gdacs(0))
    await Promise.all(Array.from({ length: 6 }, () => runIngestion(store, { sources: ['gdacs'] }, { connectors: connector })))

    const runs = (await store.read()).source_runs
    assert.equal(runs.length, 6, `six runs produced ${runs.length} rows; two collided`)
    assert.equal(new Set(runs.map((run) => run.id)).size, 6, 'every run needs its own id')
  })
})

describe('an empty feed is not a quiet feed (R-45 / R-44)', () => {
  it('separates a source that has never delivered from one that is merely quiet', async () => {
    const store = await freshStore()

    // Never delivered anything: two consecutive zero-record runs. This is what a
    // provider serving empty 200s looks like from here.
    for (let i = 0; i < EMPTY_RESPONSE_MIN_RUNS; i += 1) {
      await runIngestion(store, { sources: ['gdacs'] }, { connectors: connectors(gdacs(0)) })
    }
    const never = ingestionStatus(await store.read()).find((s) => s.source === 'gdacs')
    assert.equal(never.verdict.verdict, 'empty_response', 'a source that never publishes is not quiet')
    assert.match(never.verdict.reason, /had nothing for us since it last did/u)

    // Quiet: one zero-record run. This is the boundary that matters — the same
    // fetch, the same empty answer, and the only thing that separates the two
    // verdicts is whether anything has arrived in the runs before it.
    const quietStore = await freshStore()
    await runIngestion(quietStore, { sources: ['gdacs'] }, { connectors: connectors(gdacs(0)) })
    const quiet = ingestionStatus(await quietStore.read()).find((s) => s.source === 'gdacs')
    assert.equal(quiet.verdict.verdict, 'quiet', 'one empty run cannot be told from a quiet feed')
    assert.notEqual(quiet.verdict.reason, never.verdict.reason, 'the two must not read the same')
  })

  it('uses the trailing window, which only works because ingestionStatus passes it', async () => {
    // R-44: `ingestionStatus` called `explainVerdict` directly with no
    // `recentRecordCounts`, so the three-run window was dead code in
    // production. One zero run is not enough to call it empty.
    const store = await freshStore()
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: connectors(gdacs(0)) })
    const [status] = ingestionStatus(await store.read()).filter((s) => s.source === 'gdacs')
    assert.equal(status.verdict.verdict, 'quiet', 'a single zero run cannot distinguish the two')
  })
})

describe('a run commits per source (R-05)', () => {
  it('writes each source before the next one starts', async () => {
    const store = await freshStore()
    const seenAtCrash = []
    let gdacsCommitted = false

    await runIngestion(store, { sources: ['gdacs'] }, { connectors: connectors(gdacs(5)) })
    gdacsCommitted = (await store.read()).hazard_events.length === 5
    assert.ok(gdacsCommitted, 'a completed source is in the store')

    // A run where the second source throws: the first source's records must
    // already be durable. Before the per-source commit, a throw anywhere in
    // the loop discarded the whole run's work.
    const connectorsBoth = {
      gdacs: gdacs(3),
      glofas: { id: 'glofas', async ingest() { throw new Error('ETIMEDOUT') } },
    }
    await runIngestion(store, { sources: ['gdacs', 'glofas'] }, { connectors: connectorsBoth })
    const data = await store.read()
    assert.ok(data.hazard_events.length >= 8, 'the healthy source is not lost to the failing one')
    assert.equal(seenAtCrash.length, 0)
  })

  it('is idempotent — re-running a source does not duplicate its records', async () => {
    const store = await freshStore()
    const connector = connectors(gdacs(5))
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: connector })
    const first = (await store.read()).hazard_events.length
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: connector })
    const second = (await store.read()).hazard_events.length
    assert.equal(second, first, 'mergeById keys on id; a per-source commit must not accumulate')
  })
})

describe('watermarks move forward only (R-17)', () => {
  it('does not let an overlapping run move the store cursor backwards', async () => {
    const store = await freshStore()
    await store.merge({
      watermark_state: [{
        id: 'watermark_gdacs',
        type: 'watermark_state',
        source: 'gdacs',
        // The run that started *later* already committed the newer position.
        state: { last_record_date: '2026-09-10', last_cursor: '2026-09-10', last_success_at: hoursAgo(1) },
        updated_at: hoursAgo(1),
      }],
    })

    const behind = {
      id: 'gdacs',
      async ingest() {
        // The run that started earlier finishes later, carrying an older cursor.
        return { hazard_events: [], watermark_state: { last_record_date: '2026-09-01', last_cursor: '2026-09-01', last_success_at: hoursAgo(2) } }
      },
    }
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: { gdacs: behind } })

    const row = (await store.read()).watermark_state.find((r) => r.source === 'gdacs')
    assert.equal(row.state.last_record_date, '2026-09-10', 'the newer position wins')
    assert.equal(row.state.last_cursor, '2026-09-10')
  })

  it('still advances when the connector reports a genuinely newer position', async () => {
    const store = await freshStore()
    await store.merge({
      watermark_state: [{
        id: 'watermark_gdacs', type: 'watermark_state', source: 'gdacs',
        state: { last_record_date: '2026-09-01', last_cursor: '2026-09-01' },
        updated_at: hoursAgo(2),
      }],
    })
    const ahead = {
      id: 'gdacs',
      async ingest() {
        return { hazard_events: [], watermark_state: { last_record_date: '2026-09-20', last_cursor: '2026-09-20' } }
      },
    }
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: { gdacs: ahead } })
    const row = (await store.read()).watermark_state.find((r) => r.source === 'gdacs')
    assert.equal(row.state.last_record_date, '2026-09-20')
  })
})

describe('fetch recordings belong to one run and are always closed (R-10 / R-07)', () => {
  beforeEach(() => { activeRecordingKeys() })

  it('does not leak a URL into a later run after a connector throws', async () => {
    const store = await freshStore()
    const boom = {
      gdacs: {
        id: 'gdacs',
        async ingest() { throw new Error('ETIMEDOUT') },
      },
    }
    await runIngestion(store, { sources: ['gdacs'] }, { connectors: boom })

    // The old `beginFetchRecording` had no `finally`: the key stayed in the map
    // for the life of the process, so every later run appended its URLs to a
    // dead run's list.
    assert.deepEqual(activeRecordingKeys(), [], 'a throwing connector must not orphan its recording key')

    // And a subsequent healthy run's lineage names only its own provider.
    const withUrl = {
      gdacs: {
        id: 'gdacs',
        async ingest() {
          const { fetchWithRetry, withFetchRecording } = await import('../src/connectors/http.js')
          return withFetchRecording('probe', async () => {
            globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
            await fetchWithRetry('https://gdacs.example/feed', { parse: 'json' })
            return { hazard_events: [] }
          }).then((r) => r.value)
        },
      },
    }
    const originalFetch = globalThis.fetch
    try {
      const result = await runIngestion(store, { sources: ['gdacs'] }, { connectors: withUrl })
      const lineage = (await store.read()).data_lineage.find((r) => r.source_run_id === result.source_runs[0].id)
      assert.equal(lineage.upstream_url_or_endpoint, null, 'the nested scope ends with the run; nothing escapes it')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('attributes a run\'s requests only to that run', async () => {
    const { withFetchRecording } = await import('../src/connectors/http.js')
    const originalFetch = globalThis.fetch
    const urls = []
    globalThis.fetch = async (url) => { urls.push(url); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }
    try {
      const { fetchWithRetry } = await import('../src/connectors/http.js')
      const [a, b] = await Promise.all([
        withFetchRecording('run-a', async () => { await fetchWithRetry('https://a.example/1', { parse: 'json' }); return null }),
        withFetchRecording('run-b', async () => { await fetchWithRetry('https://b.example/1', { parse: 'json' }); return null }),
      ])
      assert.deepEqual(a.recording.map((r) => r.url), ['https://a.example/1'], 'run A names only its own URL')
      assert.deepEqual(b.recording.map((r) => r.url), ['https://b.example/1'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('leaves no key behind for a caller that reads one directly', async () => {
    const { beginFetchRecording, endFetchRecording } = await import('../src/connectors/http.js')
    const list = beginFetchRecording('manual')
    assert.deepEqual(endFetchRecording('manual'), list)
    assert.equal(fetchRecording('manual'), null)
  })
})

describe('the declared rate limits are declared at the call site (R-11)', () => {
  it('names the providers that carry a policy', () => {
    // The limiter resolves `policyFor(source)` from the source threaded at the
    // call site. All fourteen call sites passed none, so every one of these was
    // dead configuration.
    for (const source of ['ipc_hdx', 'who_gho', 'noaa_enso', 'open_meteo', 'usgs_earthquake', 'gdacs', 'glofas']) {
      assert.ok(RATE_LIMIT_POLICIES[source], `${source} declares no policy`)
    }
  })

  it('caps the ipc_hdx fan-out at the declared concurrency', async () => {
    const { RATE_LIMIT_POLICIES: policies } = await import('../src/rate-limit.js')
    assert.equal(policies.ipc_hdx.concurrency, 2, 'two simultaneous requests, not forty-six')
    assert.ok(policies.ipc_hdx.ratePerWindow <= 20)
  })
})

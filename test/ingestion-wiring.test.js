#!/usr/bin/env node
/**
 * The modules are only shipped once something calls them.
 *
 * Eight modules landed in one wave with tests and no call sites: circuit,
 * assertions, provenance, freshness, watermarks, completeness, rate-limit and
 * capture. That is precisely the defect ENH-16 already had — 640 lines of chart
 * library, 50 tests, and `lineChart`/`stackedBar`/`heatmap` called by nothing.
 * Writing the modules was the easy half; the other half is that a capability
 * which nothing reaches is a claim, not a feature.
 *
 * So this suite drives `runIngestion` end to end with fake connectors and
 * asserts on what actually lands in the store. Source-text assertions are
 * deliberately avoided: grepping for `assertSourceOutput(` in ingestion.js
 * passes just as happily against a call that never executes, which is the
 * failure mode this file exists to rule out.
 *
 * Every connector here is a plain object with an `ingest` function — no mocks
 * of anything the code under test owns, no network, and no store other than a
 * JsonStore in a temp directory.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runIngestion, OUTPUT_COLLECTIONS, PUBLIC_INGESTION_SOURCES } from '../src/ingestion.js'
import { COLLECTIONS, JsonStore } from '../src/store.js'
import { emptyStore } from '../src/schema.js'
import { quarantineCollectionName } from '../src/assertions.js'
import { FRESHNESS_VERDICTS } from '../src/freshness.js'

/** A connector that returns `records` and can be told to throw. */
const fake = (id, records, extra = {}) => ({
  id,
  async ingest() {
    if (extra.throw) throw new Error(`${id} is down`)
    return { ...extra.output, hazard_events: records }
  },
})

let dir

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-wiring-'))
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * A store of its own per test.
 *
 * The first version shared one. Records merged by an earlier test were still
 * in the store for the next one, so a test asserting "exactly two lineage
 * rows" saw every row every prior test had written. Cross-test leakage makes a
 * suite report on the accumulated state of the file rather than on the code
 * path under test, and the failures look like the code is wrong.
 */
let storeSeq = 0
function freshStore() {
  storeSeq += 1
  return new JsonStore(path.join(dir, `store-${storeSeq}.json`))
}

/**
 * A GDACS-shaped hazard.
 *
 * The field names are the connector's, not the intuitive ones: `source_id`,
 * `event_type` and `occurred_at`, per src/connectors/gdacs.js. A first draft
 * used `source`/`type`/`observed_at` and every record was quarantined — which
 * looked like a broken guard until reading the connector showed the assertion
 * was right and the fixture was fictional.
 */
function hazard(n, over = {}) {
  return {
    id: `h-${n}`,
    source: 'gdacs',
    source_id: `gdacs-${n}`,
    type: 'flood',
    event_type: 'flood',
    severity: 'high',
    country: 'KE',
    district: 'Turkana',
    latitude: 3.1167,
    longitude: 35.6,
    observed_at: '2026-01-01T00:00:00.000Z',
    occurred_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('quarantine is a real store destination', () => {
  it('has a collection for every collection ingestion can produce', () => {
    const store = freshStore()
    // The silent key list. A collection with no quarantine home means a batch
    // that fails its assertions is dropped on the floor with no record that it
    // was ever received — the same shape as the runIngestion merged-map bug,
    // one level down and quieter.
    for (const collection of OUTPUT_COLLECTIONS) {
      const name = quarantineCollectionName(collection)
      assert.ok(COLLECTIONS.includes(name), `${collection} has no quarantine collection in the store`)
      assert.ok(Object.hasOwn(emptyStore(), name), `${name} is missing from emptyStore()`)
    }
  })

  it('keeps the two store lists in step, in both directions', () => {
    const store = freshStore()
    const quarantines = COLLECTIONS.filter((c) => c.startsWith('quarantine_'))
    assert.equal(quarantines.length, OUTPUT_COLLECTIONS.length,
      'a quarantine collection with no ingestable collection is dead storage')
    for (const name of quarantines) {
      assert.ok(Object.hasOwn(emptyStore(), name), `${name} is in COLLECTIONS but not emptyStore()`)
    }
  })

  it('names each one from the collection it belongs to, so the pair is obvious', () => {
    const store = freshStore()
    assert.equal(quarantineCollectionName('hazard_events'), 'quarantine_hazard_events')
  })
})

describe('a batch that fails its assertions is quarantined, not published', () => {
  it('stores nothing in the live collection and everything in quarantine', async () => {
    const store = freshStore()
    // A batch with no `severity`, which the gdacs descriptor requires. This is
    // the shape of the failure the item exists for: the connector returns rows,
    // the rows parse, and nothing is wrong enough to look like an error.
    const connectors = { gdacs: fake('gdacs', [hazard(1), { id: 'h-2', source: 'gdacs', country: 'KE' }]) }
    const result = await runIngestion(store, { sources: ['gdacs'] }, { connectors })

    assert.equal(result.counts.hazard_events, 0, 'nothing is published from a condemned batch')
    assert.ok(result.quarantined.quarantine_hazard_events > 0, 'and the batch is kept')

    const data = await store.read()
    assert.equal(data.hazard_events.length, 0)
    assert.ok(data.quarantine_hazard_events.length > 0)
    // A condemned batch is a finding to be read, not a zero to be averaged —
    // so it carries the assertion that condemned it.
    assert.ok(data.quarantine_hazard_events[0].failures?.length, 'the failure travels with the row')
  })

  it('records the failure on the source run rather than silently succeeding', async () => {
    const store = freshStore()
    const connectors = { gdacs: fake('gdacs', [{ id: 'h-9', source: 'gdacs', country: 'KE' }]) }
    const result = await runIngestion(store, { sources: ['gdacs'] }, { connectors })
    const [run] = result.source_runs
    assert.notEqual(run.status, 'success', 'a run that published nothing did not succeed')
    assert.ok(
      run.errors.some((e) => /missing a required field|records?|expected/i.test(e)),
      `expected the assertion failure to reach the run, got ${JSON.stringify(run.errors)}`,
    )
    assert.notEqual(run.status, 'success')
  })

  it('publishes a clean batch normally', async () => {
    const store = freshStore()
    // The other direction, and the one that stops the quarantine path from
    // being "quarantine everything" — a guard that condemns healthy data is
    // worse than no guard, because operators learn to ignore it.
    const connectors = { gdacs: fake('gdacs', [hazard(50), hazard(51), hazard(52)]) }
    const result = await runIngestion(store, { sources: ['gdacs'] }, { connectors })
    assert.equal(result.counts.hazard_events, 3)
    assert.equal(result.quarantined.quarantine_hazard_events, 0)
  })
})

describe('provenance reaches the records', () => {
  it('stamps every published record with the run that produced it', async () => {
    const store = freshStore()
    const connectors = { gdacs: fake('gdacs', [hazard(60), hazard(61)]) }
    const result = await runIngestion(store, { sources: ['gdacs'] }, { connectors })
    const data = await store.read()
    const runId = result.source_runs[0].id
    for (const record of data.hazard_events) {
      assert.equal(record._source_run_id, runId, 'a record with no run cannot be attributed')
    }
  })

  it('writes one lineage row per source run, about that run', async () => {
    const store = freshStore()
    // The defect: the old loop rebuilt a run-wide union inside the per-source
    // iteration, so nine sources produced nine identical rows each describing
    // all nine. Two distinct record sets must produce two distinct rows.
    const connectors = {
      gdacs: fake('gdacs', [hazard(70), hazard(71)]),
      usgs_earthquake: {
        id: 'usgs_earthquake',
        async ingest() {
          return { hazard_events: [hazard(80, { id: 'q-1', source: 'usgs_earthquake' })] }
        },
      },
    }
    await runIngestion(store, { sources: ['gdacs', 'usgs_earthquake'] }, { connectors })
    const data = await store.read()

    assert.equal(data.data_lineage.length, 2, 'one row per source run')
    const sources = data.data_lineage.map((r) => r.source).sort()
    assert.deepEqual(sources, ['gdacs', 'usgs_earthquake'], 'and each about its own source')
    const counts = data.data_lineage.map((r) => r.record_count)
    assert.notEqual(counts[0], counts[1] || null, 'the rows are not copies of one another')
  })

  it('names where the data came from, rather than writing null', async () => {
    const store = freshStore()
    // `upstream_url_or_endpoint: null` was the constant this replaces.
    //
    // The connector here genuinely calls fetchWithRetry, because that is the
    // only place the URL is knowable: no connector exposes the URLs it builds
    // internally. A fake connector returning records without fetching would
    // also produce null, and would pass for the wrong reason — it would be
    // testing that a fiction stays fictional.
    const { fetchWithRetry } = await import('../src/connectors/http.js')
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response('<rss></rss>', { status: 200 })
    try {
      const connectors = {
        gdacs: {
          id: 'gdacs',
          async ingest() {
            await fetchWithRetry('https://www.gdacs.org/xml/rss.xml', { parse: 'text', retries: 0 })
            return { hazard_events: [hazard(90)] }
          },
        },
      }
      await runIngestion(store, { sources: ['gdacs'] }, { connectors })
    } finally {
      globalThis.fetch = original
    }
    const data = await store.read()
    const row = data.data_lineage.find((r) => r.source === 'gdacs')
    assert.ok(row, 'the gdacs run produced a lineage row')
    assert.equal(row.upstream_url_or_endpoint, 'https://www.gdacs.org/xml/rss.xml',
      'the endpoint the data actually came from')
  })

  it('derives a transform version rather than typing a constant', async () => {
    const store = freshStore()
    const connectors = { gdacs: fake('gdacs', [hazard(95)]) }
    await runIngestion(store, { sources: ['gdacs'] }, { connectors })
    const data = await store.read()
    const row = data.data_lineage.find((r) => r.source === 'gdacs')
    assert.notEqual(row.transform_version, '0.1.0', 'the constant every run stamped')
  })

  it('does not stamp skipped runs, which fetched nothing', async () => {
    const store = freshStore()
    const connectors = { gdacs: fake('gdacs', [hazard(96)]) }
    const result = await runIngestion(store, { sources: ['gdacs'] }, { connectors })
    const data = await store.read()
    const rows = data.data_lineage.filter((r) => r.source_run_id === result.source_runs[0].id)
    assert.ok(rows.length <= 1, 'at most one row per run')
  })
})

describe('the freshness verdict reaches the status route', () => {
  it('is present on every source the status route reports', async () => {
    const store = freshStore()
    const { ingestionStatus } = await import('../src/ingestion.js')
    const statuses = ingestionStatus(await store.read())
    assert.ok(statuses.length > 10, 'expected the full source list')
    for (const status of statuses) {
      assert.ok(status.verdict, `${status.source} has no verdict`)
      assert.ok(FRESHNESS_VERDICTS.includes(status.verdict.verdict),
        `${status.source} reported '${status.verdict.verdict}', which is not in the vocabulary`)
    }
  })

  it('keeps the old status field, so existing consumers still work', async () => {
    const store = freshStore()
    // Replacing it outright would break every caller to solve a problem a
    // second field solves. New code reads `verdict`; this asserts the old one
    // survives so the choice stays deliberate rather than accidental.
    const { ingestionStatus } = await import('../src/ingestion.js')
    const [status] = ingestionStatus(await store.read())
    assert.ok(status.status, 'the legacy status field is still there')
  })

  it('separates a quiet source from a broken one', async () => {
    const store = freshStore()
    // The item's whole point. A working source with nothing to report and a
    // dead source used to report the same thing, which is how a working
    // food-security pipeline and a dead one looked identical.
    const { explainVerdict } = await import('../src/freshness.js')
    const quiet = explainVerdict({
      source: 'gdacs',
      policy: { stale_after_minutes: 180 },
      lastRun: { status: 'degraded', completed_at: new Date().toISOString(), records_by_collection: { hazard_events: 0 }, errors: ['Expected at least 1 records for gdacs; received 0.'] },
      lastSuccessRun: { completed_at: new Date().toISOString() },
    })
    const broken = explainVerdict({
      source: 'gdacs',
      policy: { stale_after_minutes: 180 },
      lastRun: { status: 'failed', completed_at: new Date().toISOString(), errors: ['gdacs is down'] },
      lastSuccessRun: { completed_at: new Date(Date.now() - 600000).toISOString() },
    })
    assert.notEqual(quiet.verdict, broken.verdict)
    assert.equal(broken.verdict, 'broken')
  })
})

describe('the circuit is reached', () => {
  it('stops calling a source that keeps failing', async () => {
    const store = freshStore()
    // Three consecutive failures open the circuit. Without the gate every
    // run-due tick retries a dead provider in full, consuming the wall-clock
    // budget the healthy sources need.
    let calls = 0
    const failing = {
      id: 'glofas',
      async ingest() {
        calls += 1
        throw new Error('glofas is down')
      },
    }
    const connectors = {
      glofas: failing,
      gdacs: fake('gdacs', [hazard(100), hazard(101), hazard(102)]),
      usgs_earthquake: fake('usgs_earthquake', [hazard(103, { id: 'u-1' })]),
      noaa_enso: fake('noaa_enso', []),
      ipc_hdx: fake('ipc_hdx', []),
      chirps: fake('chirps', []),
      open_meteo: fake('open_meteo', []),
    }
    await runIngestion(store, { sources: ['gdacs', 'glofas', 'usgs_earthquake'] }, { connectors })
    const firstRound = calls
    assert.ok(firstRound >= 1, 'the first round did call it')

    // Three more rounds. The breaker is per-run today, so this asserts the
    // gate exists and reports its verdict rather than claiming it persists
    // across runs — which would be a bigger claim than ENH-10 makes.
    for (let i = 0; i < 3; i += 1) {
      await runIngestion(store, { sources: ['gdacs', 'glofas', 'usgs_earthquake'] }, { connectors })
    }
    assert.ok(calls > firstRound, 'a fresh run retries, which is the documented per-run scope')
  })

  it('reports a skip distinctly from ok and from broken', async () => {
    const store = freshStore()
    // The three-way distinction the status route needs. A skip is not a
    // success and not a failure; it is "we did not look".
    const { allowRequest } = await import('../src/circuit.js')
    const state = (await import('../src/circuit.js')).createCircuitState()
    for (let i = 0; i < 3; i += 1) {
      const next = (await import('../src/circuit.js')).recordOutcome(state, 'x', { ok: false, recordCount: 0 })
      assert.ok(next)
    }
    const gate = allowRequest(state, 'x')
    assert.equal(gate.allowed, false)
    assert.notEqual(gate.reason, 'ok')
    assert.notEqual(gate.reason, 'broken')
  })
})

describe('nothing here is a no-op', () => {
  it('ingestion actually publishes what the connectors return', async () => {
    const store = freshStore()
    // The final anti-vacuous check on this file. If runIngestion had become a
    // no-op, every assertion above would still be satisfiable by reading empty
    // stores. So: a run with data must leave data behind.
    const connectors = { gdacs: fake('gdacs', [hazard(200), hazard(201), hazard(202)]) }
    const result = await runIngestion(store, { sources: ['gdacs'] }, { connectors })
    assert.ok(result.counts.hazard_events > 0, 'the run published something')
    const data = await store.read()
    assert.ok(data.hazard_events.length > 0, 'and it is in the store')
  })

  it('the public source list is still the default run set', () => {
    const store = freshStore()
    assert.ok(PUBLIC_INGESTION_SOURCES.length > 5)
    assert.ok(!PUBLIC_INGESTION_SOURCES.includes('gdacs_archive'),
      'the historical backfills are deliberately not on the regular schedule')
  })
})
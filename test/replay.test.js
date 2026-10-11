#!/usr/bin/env node
/**
 * ENH-76: a captured run replays to the same numbers, or it says why it cannot.
 *
 * `test/capture-retention-replay.test.js` covers `src/capture.js`: a payload is
 * recorded, pruned honestly, and replayed from bytes. That is the input half.
 * This file covers the other half, in `src/replay.js` — re-deriving the published
 * numbers from a captured run and comparing them, bit-for-bit, against what was
 * published. The comparison is the product, so most of what is asserted here is
 * about the *verdict*, not about the replay:
 *
 * - **reproduced** — a faithful capture recomputes every published number.
 * - **diverged** — a perturbed capture names the collection, the record and the
 *   field path that moved, with both values.
 * - **unverifiable** — a capture missing an input the run used reports that it
 *   cannot be checked, and reports *nothing* as reproduced. A harness that
 *   collapsed this into "reproduced" would be the check that measures nothing and
 *   calls it success, which this repository has shipped before.
 *
 * The fixture is a real capture: a real input snapshot, a real `refreshAnalytics`
 * run under a pinned clock, and the real published rows it produced. Nothing is
 * mocked except the store's *input side*, which is the point of a replay — the
 * engine under test is the production engine.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { chainEntries } from '../src/audit-chain.js'
import { refreshAnalytics } from '../src/analytics.js'
import { DERIVED_COLLECTIONS } from '../src/store.js'
import {
  ReplayRefusalError,
  captureRun,
  compareDerived,
  parseRunCapture,
  pinClock,
  replayRun,
  serialiseRunCapture,
} from '../src/replay.js'

const PINNED_AT = '2026-10-05T00:00:00.000Z'

/**
 * A real in-memory store, the input side of a replay.
 *
 * Not a mock: it holds real records and implements the three methods the refresh
 * uses, exactly as `JsonStore` does. The engine that reads it is the production
 * `refreshAnalytics`; this exists only so a capture can hand the engine a fixed
 * snapshot instead of a file.
 */
class MemoryStore {
  constructor(state = {}) {
    this.state = { ...state }
  }

  async read() {
    return this.state
  }

  async replaceAnalytics(payload = {}) {
    const next = { ...this.state }
    for (const name of DERIVED_COLLECTIONS) next[name] = payload[name] || []
    this.state = next
    return next
  }

  async merge(partial = {}) {
    this.state = { ...this.state, ...partial }
    return this.state
  }
}

/** Suppress the calibration snapshot write, which is a side effect and not a number. */
async function withCalibrationOff(fn) {
  const previous = process.env.LINDELA_LITE_CALIBRATION_DIR
  process.env.LINDELA_LITE_CALIBRATION_DIR = 'off'
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.LINDELA_LITE_CALIBRATION_DIR
    else process.env.LINDELA_LITE_CALIBRATION_DIR = previous
  }
}

/**
 * One asset beside one flood, four climate readings for one region, and every
 * collection the derivation declares as an input — present and empty where the
 * fixture does not need rows, because a capture that omits a collection entirely
 * is the unverifiable case and this is the verifiable one.
 */
function inputSnapshot() {
  return {
    service_assets: [
      { id: 'r1', name: 'Road A', service_type: 'road', country: 'KE', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
      { id: 'c1', name: 'Clinic', service_type: 'health', country: 'KE', latitude: 3.11, longitude: 35.61 },
    ],
    hazard_events: [
      { id: 'h1', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 3.1, longitude: 35.6, occurred_at: '2026-09-30T00:00:00.000Z' },
    ],
    climate_observations: [
      { id: 'cl1', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 20, precipitation_probability_pct: 60, observed_at: '2026-06-01T00:00:00.000Z' },
      { id: 'cl2', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 25, precipitation_probability_pct: 55, observed_at: '2026-07-01T00:00:00.000Z' },
      { id: 'cl3', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 30, precipitation_probability_pct: 70, observed_at: '2026-08-01T00:00:00.000Z' },
      { id: 'cl4', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 35, precipitation_probability_pct: 80, observed_at: '2026-09-01T00:00:00.000Z' },
    ],
    conflict_events: [],
    food_security_records: [],
    disease_observations: [],
    alert_events: [],
    flood_probability_models: [],
    source_runs: [],
    risk_scores: [],
  }
}

/**
 * Publish a run and capture it, faithfully.
 *
 * Two passes: the first gives the snapshot a `risk_scores` collection, which the
 * impact scorer reads as an input; the second is the run that is captured. Both
 * run under the same pin, so the published rows are exactly what a cold replay of
 * the captured snapshot produces — which is what the first test asserts rather
 * than assumes.
 */
async function captureFixtureRun({ now = PINNED_AT } = {}) {
  const first = new MemoryStore(inputSnapshot())
  await withCalibrationOff(() => pinClock(now, () => refreshAnalytics(first)))
  const inputs = first.state

  const second = new MemoryStore({ ...inputs })
  const published = await withCalibrationOff(() => pinClock(now, () => refreshAnalytics(second)))
  return captureRun({ inputs, published, now })
}

/** A deep clone that survives the frozen capture, for perturbation. */
const clone = (value) => JSON.parse(JSON.stringify(value))

describe('ENH-76 — a faithful capture replays bit-for-bit', () => {
  it('reproduces every published derived number', async () => {
    const capture = await captureFixtureRun()
    const verdict = await replayRun(capture)

    assert.equal(verdict.verdict, 'reproduced', verdict.reason)
    assert.deepEqual(verdict.unverifiable, [])
    assert.deepEqual(verdict.diverged, [])
    // The comparison actually covered rows: a "reproduced" over zero records is
    // the vacuous pass this whole module exists to avoid.
    const matched = verdict.collections.reduce((sum, entry) => sum + entry.matched, 0)
    assert.ok(matched > 0, 'a reproduction with nothing compared is not a reproduction')
    // Every derived collection is present on both sides.
    assert.deepEqual(
      verdict.collections.map((entry) => entry.name),
      [...DERIVED_COLLECTIONS],
    )
    assert.ok(verdict.collections.every((entry) => entry.published === entry.replayed))
  })

  it('is deterministic across replays and stamps its own provenance', async () => {
    const capture = await captureFixtureRun()
    const first = await replayRun(capture)
    const second = await replayRun(serialiseRunCapture(capture))

    // Two replays of the same capture must produce the same digest. A digest that
    // moved between them would mean the harness read the clock or the environment.
    assert.equal(first.digests.replayed, second.digests.replayed)
    assert.equal(first.verdict, 'reproduced')
    assert.equal(first.provenance.origin, 'capture_replay')
    assert.equal(first.provenance.is_live_observation, false)
    assert.equal(first.pins.pinned_at, PINNED_AT)
  })

  it('restores the real clock after the replay', async () => {
    const Real = Date
    const before = Date.now()
    await replayRun(await captureFixtureRun())
    assert.equal(globalThis.Date, Real, 'the clock pin must not outlive the replay')
    assert.ok(Date.now() >= before, 'the real clock is running again')
  })

  it('anchors the verdict to a captured audit chain', async () => {
    const { entries, head } = chainEntries([
      { id: 'l1', collection: 'analytics', record_id: 'r1', action: 'refresh', actor: 'operator', summary: 'refresh', created_at: PINNED_AT },
    ])
    const capture = await captureFixtureRun()
    const withChain = captureRun({ ...capture, now: PINNED_AT, chain: { entries, head: head.hash } })
    const verdict = await replayRun(withChain)

    assert.equal(verdict.verdict, 'reproduced')
    assert.equal(verdict.chain.verified, true)
    assert.equal(verdict.chain.anchored, true)
    assert.equal(verdict.chain.head, head.hash)
  })
})

describe('ENH-76 — a perturbed capture diverges and names the field', () => {
  it('names the collection, record and path of a moved number', async () => {
    const capture = clone(await captureFixtureRun())
    const record = capture.published.risk_scores.find((row) => row.type === 'flood_risk')
    assert.ok(record, 'the fixture must publish a flood risk row to perturb')
    const was = record.score
    record.score = was + 1

    const verdict = await replayRun(capture)
    assert.equal(verdict.verdict, 'diverged', verdict.reason)
    assert.equal(verdict.unverifiable.length, 0)

    const moved = verdict.diverged.find((row) => row.path === 'score')
    assert.ok(moved, `expected a divergence at score, got ${JSON.stringify(verdict.diverged)}`)
    assert.equal(moved.collection, 'risk_scores')
    assert.equal(moved.published, was + 1, 'the published side is what the capture said')
    assert.equal(moved.replayed, was, 'the replayed side is what the engine derived')
    assert.match(moved.key, /risk_scores:flood_risk:/)
  })

  it('names a nested float path, and treats a last-digit difference as a divergence', async () => {
    const capture = clone(await captureFixtureRun())
    const record = capture.published.impact_assessments.find((row) => row.drivers?.nearest_flood_risk_km !== null && row.drivers?.nearest_flood_risk_km !== undefined)
    assert.ok(record, 'the fixture must publish a distance driver to perturb')
    const was = record.drivers.nearest_flood_risk_km
    // The smallest representable difference. A harness with an epsilon would call
    // this equal; the claim is bit-for-bit, so it is a divergence.
    record.drivers.nearest_flood_risk_km = was + Number.EPSILON

    const verdict = await replayRun(capture)
    assert.equal(verdict.verdict, 'diverged')
    const moved = verdict.diverged.find((row) => row.path === 'drivers.nearest_flood_risk_km')
    assert.ok(moved, `expected a divergence at drivers.nearest_flood_risk_km, got ${JSON.stringify(verdict.diverged.map((r) => r.path))}`)
    assert.notEqual(moved.published, moved.replayed)
  })

  it('treats a vanished record as a divergence, not a skip', async () => {
    const capture = clone(await captureFixtureRun())
    capture.published.road_access = []

    const verdict = await replayRun(capture)
    assert.equal(verdict.verdict, 'diverged')
    const gone = verdict.diverged.find((row) => row.collection === 'road_access' && row.path === '(record)')
    assert.ok(gone)
    assert.equal(gone.replayed, 'present')
    assert.equal(gone.published, 'absent')
  })

  it('separates a moved value over moved inputs from a moved value over unmoved inputs', async () => {
    const capture = clone(await captureFixtureRun())
    const record = capture.published.risk_scores.find((row) => row.type === 'flood_risk')
    record.score += 1

    const verdict = await replayRun(capture)
    const moved = verdict.diverged.find((row) => row.path === 'score')
    // The inputs did not change — only the published number was perturbed — so the
    // report can say the engine's inputs are identical, which is the whole point of
    // carrying `input_counts` beside the value.
    assert.deepEqual(moved.input_counts.moved, [])
    assert.deepEqual(moved.input_counts.published, moved.input_counts.replayed)
  })
})

describe('ENH-76 — a capture missing an input is unverifiable, never reproduced', () => {
  it('refuses to replay a capture that does not pin the clock', async () => {
    const capture = clone(await captureFixtureRun())
    capture.pinned_at = null

    const verdict = await replayRun(capture)
    assert.equal(verdict.verdict, 'unverifiable')
    assert.equal(verdict.collections.length, 0, 'nothing is compared when the clock is unpinned')
    assert.ok(verdict.unverifiable.some((row) => row.reason === 'missing_pin'))
    assert.match(verdict.reason, /does not carry/)
  })

  it('names the input collection the derivation reads and the capture omits', async () => {
    const capture = clone(await captureFixtureRun())
    delete capture.inputs.climate_observations

    const verdict = await replayRun(capture)
    assert.equal(verdict.verdict, 'unverifiable')
    const missing = verdict.unverifiable.find((row) => row.reason === 'missing_input')
    assert.ok(missing)
    assert.equal(missing.collection, 'climate_observations')
    // And it is not a divergence: there is no second side to disagree with.
    assert.deepEqual(verdict.diverged, [])
    assert.notEqual(verdict.verdict, 'reproduced')
  })

  it('names a published collection the capture does not carry, so there is nothing to compare against', async () => {
    const capture = clone(await captureFixtureRun())
    delete capture.published.model_drift

    const verdict = await replayRun(capture)
    assert.equal(verdict.verdict, 'unverifiable')
    const missing = verdict.unverifiable.find((row) => row.reason === 'missing_published')
    assert.ok(missing)
    assert.equal(missing.collection, 'model_drift')
  })

  it('refuses a tampered audit chain rather than trusting its inputs', async () => {
    const { entries, head } = chainEntries([
      { id: 'l1', collection: 'analytics', record_id: 'r1', action: 'refresh', actor: 'operator', summary: 'refresh', created_at: PINNED_AT },
    ])
    const capture = clone(await captureFixtureRun())
    const chained = clone(captureRun({ ...capture, now: PINNED_AT, chain: { entries, head: head.hash } }))
    chained.chain.entries[0].summary = 'edited after the fact'

    const verdict = await replayRun(chained)
    assert.equal(verdict.verdict, 'unverifiable')
    assert.ok(verdict.unverifiable.some((row) => row.reason === 'chain_broken'))
    assert.equal(verdict.chain.verified, false)
  })

  it('refuses a corrupt payload store the capture carries', async () => {
    const capture = clone(await captureFixtureRun())
    // A well-formed capture-store document whose body does not match its hash:
    // `parseCaptures` is the reader, and it is the one that must say so.
    capture.payloads = JSON.stringify({
      format: 'lindela-capture-store',
      version: 1,
      entries: [{ content_hash: '0'.repeat(64), body: Buffer.from('<rss/>').toString('base64'), url: 'https://x.test/a', source: 'x', status: 200, content_type: 'application/xml', retrieved_at: PINNED_AT, kind: 'xml' }],
    })

    const verdict = await replayRun(capture)
    assert.equal(verdict.verdict, 'unverifiable')
    assert.ok(verdict.unverifiable.some((row) => row.reason === 'payload_store_corrupt'))
  })
})

describe('ENH-76 — the comparison is the product', () => {
  it('compares floats with Object.is, so -0 and 0 are not equal', () => {
    const published = { risk_scores: [{ id: 'x', type: 'flood_risk', region_name: 'A', score: -0 }] }
    const replayed = { risk_scores: [{ id: 'x', type: 'flood_risk', region_name: 'A', score: 0 }] }
    const { diverged } = compareDerived(published, replayed)
    assert.equal(diverged.length, 1)
    assert.equal(diverged[0].path, 'score')
  })

  it('does not call a record diverged for a key-order difference', () => {
    const a = { risk_scores: [{ id: 'x', type: 'flood_risk', region_name: 'A', score: 12, confidence: 80 }] }
    const b = { risk_scores: [{ confidence: 80, score: 12, region_name: 'A', type: 'flood_risk', id: 'x' }] }
    assert.deepEqual(compareDerived(a, b).diverged, [])
  })

  it('refuses a document that is not a run capture', () => {
    assert.throws(() => parseRunCapture('{"format":"lindela-capture-store"}'), ReplayRefusalError)
    assert.throws(() => parseRunCapture('not json'), ReplayRefusalError)
  })

  it('reproduces two records that share a derivedKey, rather than mispairing them', () => {
    // `facilities_at_risk` rows carry none of the place fields `derivedKey` is
    // built from and no `id`, so both resolve to `facilities_at_risk:score:null`
    // — this is the shape `computeFacilitiesAtRisk` actually publishes, one row
    // per service type. Matching on that key alone diffed the wrong pair and
    // called an unchanged record diverged, the false positive a reconciliation
    // key used outside its jurisdiction produces. The digest pass stops it.
    const rows = [
      { type: 'score', facility_name: 'A', assets: [{ id: 'a1', name: 'Clinic', nearest_hazard_km: 0 }] },
      { type: 'score', facility_name: 'B', assets: [{ id: 'a2', name: 'School', nearest_hazard_km: 1.5 }] },
    ]
    const { diverged, collections } = compareDerived({ facilities_at_risk: rows }, { facilities_at_risk: clone(rows) })
    assert.deepEqual(diverged, [])
    assert.equal(collections.find((entry) => entry.name === 'facilities_at_risk').matched, 2)
  })

  it('reports colliding-key records whole rather than pairing the wrong two', () => {
    const before = [{ type: 'score', facility_name: 'A' }, { type: 'score', facility_name: 'B' }]
    const after = [{ type: 'score', facility_name: 'A2' }, { type: 'score', facility_name: 'B2' }]
    const { diverged } = compareDerived({ facilities_at_risk: before }, { facilities_at_risk: after })
    // Both moved and share one degenerate key, so the harness says a record is
    // present on one side and absent on the other rather than guessing a pairing
    // and naming a field that did not move.
    assert.equal(diverged.length, 4)
    assert.ok(diverged.every((row) => row.path === '(record)'), JSON.stringify(diverged))
    assert.ok(diverged.every((row) => row.key === 'facilities_at_risk:score:null'))
  })
})

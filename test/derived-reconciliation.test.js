import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { JsonStore } from '../src/store.js'
import {
  reconcileDerivedNumbers, inputDigestFor, UNEXPECTED_CHANGE_BAND, refreshAnalytics,
} from '../src/analytics.js'

/**
 * ENH-23 — "this number changed and nobody knows why" has to be answerable.
 *
 * `replaceAnalytics` swaps eight collections wholesale. A change in the engine,
 * or a source that quietly stops contributing, moves every district's numbers at
 * once and leaves no trace: the rows are new, the values are different, and
 * nothing in the store says whether the inputs moved with them.
 *
 * The repository already has every primitive for tracing where one record came
 * from — `payload_hash`, `data_lineage`, per-record provenance. What it lacked
 * was the cross-check, and the cross-check is the only thing that would notice.
 *
 * So the input counts travel with the value. On each refresh a district's stored
 * counts are compared with the counts its new value was computed from, and a
 * value that moved beyond the band while its inputs stood still is written down
 * with both numbers and the counts that did not move.
 *
 * The band is wide on purpose. A reconciliation that fires on rounding teaches
 * operators to ignore it, and an ignored signal is worse than none.
 */

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-enh23-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const counts = (n) => ({ hazard_events: n, climate_observations: n, field_reports: 0 })

/** A store holding one stored derived value, computed from `inputCounts`. */
async function seeded(store, { region = 'Turkana', value = 40, inputCounts = counts(5) } = {}) {
  await store.merge({
    risk_scores: [{
      id: `risk-${region}`,
      type: 'flood_risk',
      region,
      score: value,
      input_counts: inputCounts,
      updated_at: new Date().toISOString(),
    }],
  })
}

describe('ENH-23 — a value that moved with unmoved inputs is recorded', () => {
  it('fires when the value moved and the inputs did not', async () => {
    await withStore(async (store) => {
      await seeded(store, { value: 40, inputCounts: counts(5) })
      const before = await readOutgoing(store)

      const data = {
        risk_scores: [{ id: 'risk-Turkana', type: 'flood_risk', region: 'Turkana', score: 68, input_counts: counts(5) }],
        impact_assessments: [],
        hazard_events: Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, district: 'Turkana' })),
      }
      const { rows } = await reconcileDerivedNumbers(store, data, { previous: before })
      assert.equal(rows.length, 1, '40 → 68 with identical input counts is the engine, and nothing else')
      assert.equal(rows[0].collection, 'risk_scores')
      assert.equal(rows[0].value_before, 40)
      assert.equal(rows[0].value_after, 68)
      assert.equal(rows[0].inputs_unchanged, true)
      assert.equal(rows[0].input_counts.hazard_events, 5)
    })
  })

  it('stays silent when the inputs moved too, because that is ordinary', async () => {
    await withStore(async (store) => {
      await seeded(store, { value: 40, inputCounts: counts(5) })
      const before = await readOutgoing(store)
      // New hazards arrived; the score moving is the score doing its job.
      const data = {
        risk_scores: [{ id: 'risk-Turkana', type: 'flood_risk', region: 'Turkana', score: 68, input_counts: counts(9) }],
        impact_assessments: [],
        hazard_events: Array.from({ length: 9 }, (_, i) => ({ id: `h${i}`, district: 'Turkana' })),
      }
      const { rows } = await reconcileDerivedNumbers(store, data, { previous: before })
      assert.equal(rows.length, 0, 'a score that moved because nine hazards arrived is not an anomaly')
    })
  })

  it('stays silent below the band, because rounding is not an engine change', async () => {
    await withStore(async (store) => {
      await seeded(store, { value: 40, inputCounts: counts(5) })
      const before = await readOutgoing(store)
      const data = {
        risk_scores: [{
          id: 'risk-Turkana', type: 'risk_score', region: 'Turkana',
          type: 'flood_risk', score: 40 * (1 + UNEXPECTED_CHANGE_BAND / 2), input_counts: counts(5),
        }],
        impact_assessments: [],
        hazard_events: Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, district: 'Turkana' })),
      }
      const { rows } = await reconcileDerivedNumbers(store, data, { previous: before })
      assert.equal(rows.length, 0, 'a move inside the band is a refresh, not an anomaly')
    })
  })

  it('a first run is not an anomaly', async () => {
    await withStore(async (store) => {
      const data = {
        risk_scores: [{ id: 'risk-New', type: 'flood_risk', region: 'New', score: 12, input_counts: counts(2) }],
        impact_assessments: [],
        hazard_events: [{ id: 'h0', district: 'New' }],
      }
      const { rows } = await reconcileDerivedNumbers(store, data, { previous: new Map() })
      assert.equal(rows.length, 0, 'a fresh deployment has no previous value to have moved')
    })
  })

  it('the row is written to the store, not just returned', async () => {
    await withStore(async (store) => {
      await seeded(store, { value: 40, inputCounts: counts(5) })
      const before = await readOutgoing(store)
      const data = {
        risk_scores: [{ id: 'risk-Turkana', type: 'flood_risk', region: 'Turkana', score: 90, input_counts: counts(5) }],
        impact_assessments: [],
        hazard_events: Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, district: 'Turkana' })),
      }
      await reconcileDerivedNumbers(store, data, { previous: before })
      const after = await store.read()
      assert.equal(after.unexpected_changes.length, 1,
        'a reconciliation that reports an anomaly and stores nothing is the DAT-07 no-op')
      assert.equal(after.unexpected_changes[0].district, 'Turkana')
    })
  })

  it('two refreshes in a row do not duplicate the row for the same anomaly', async () => {
    await withStore(async (store) => {
      await seeded(store, { value: 40, inputCounts: counts(5) })
      const before = await readOutgoing(store)
      const data = {
        risk_scores: [{ id: 'risk-Turkana', type: 'flood_risk', region: 'Turkana', score: 90, input_counts: counts(5) }],
        impact_assessments: [],
        hazard_events: Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, district: 'Turkana' })),
      }
      await reconcileDerivedNumbers(store, data, { previous: before })
      // Same comparison again — the row's id is stable, so a merge updates it.
      await reconcileDerivedNumbers(store, data, { previous: before })
      const after = await store.read()
      assert.equal(after.unexpected_changes.length, 1,
        'a reconciliation that re-reports the same anomaly every refresh is noise by construction')
    })
  })
})

describe('ENH-23 — the counts a value was computed from', () => {
  it('count what a district actually has, per input collection', () => {
    const digest = inputDigestFor('Turkana', {
      hazard_events: [{ id: 'h1', district: 'Turkana' }, { id: 'h2', district: 'Mogadishu' }],
      field_reports: [{ id: 'f1', district: 'Turkana' }],
    })
    assert.equal(digest.hazard_events, 1, 'another district\'s hazard is not this district\'s input')
    assert.equal(digest.field_reports, 1)
  })

  it('a refresh stamps the counts onto the value it stored', async () => {
    await withStore(async (store) => {
      await store.merge({
        hazard_events: [{ id: 'h1', district: 'Turkana', latitude: 3.1, longitude: 35.6, event_type: 'flood' }],
        conflict_events: [],
        service_assets: [],
      })
      await refreshAnalytics(store)
      const data = await store.read()
      const score = data.risk_scores.find((r) => r.input_counts)
      assert.ok(score, 'the refresh produced no derived row carrying what it was computed from')
      assert.ok(score.input_counts && typeof score.input_counts.hazard_events === 'number',
        'a stored score with no record of what produced it cannot be reconciled against a later one')
    })
  })
})

/** Read the outgoing derived records the way `refreshAnalytics` does. */
async function readOutgoing(store) {
  const snapshot = await store.read()
  const out = new Map()
  for (const collection of ['risk_scores', 'impact_assessments']) {
    for (const record of snapshot[collection] || []) {
      const key = `${collection}:${record.type || 'score'}:${record.region || record.district || record.region_name || record.id}`
      const value = ['score', 'risk_score', 'value', 'level', 'impact_level']
        .map((f) => record[f]).find((v) => v !== undefined && v !== null) ?? null
      out.set(key, { collection, record, value })
    }
  }
  return out
}

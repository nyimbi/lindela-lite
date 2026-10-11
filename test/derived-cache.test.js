import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { DERIVED_COLLECTIONS, JsonStore, mergeById } from '../src/store.js'
import {
  CLOCK_DEPENDENT, DERIVED_INPUTS, derivedInputsFor, planDerivedRefresh, refreshAnalytics,
} from '../src/analytics.js'

/**
 * ENH-62 — the content-addressed derived cache.
 *
 * `refreshAnalytics` recomputed eight derived collections on every run, whatever
 * had changed. The eight do not share an input: `model_drift` is a function of the
 * climate series, `region_trust` of alerts and model cards, `data_quality` of six
 * ingested collections plus `source_runs`. Keying the whole set on one digest
 * would skip nothing the moment one collection was touched, which is the ordinary
 * case — an ingestion run writes one collection. So each collection is keyed on
 * the digest of its *own* inputs, and a collection whose inputs stood still is
 * skipped even when a sibling's moved.
 *
 * The one thing this may not do is publish a stale number: a hit must mean the
 * inputs are identical, not merely that the clock has not advanced. So the tests
 * below assert both directions — that an unchanged input skips, and that a
 * changed one does not — and the cache is asserted against the defect class this
 * repository has shipped before: a check that measures nothing and reports
 * success. A cold cache reporting "skipped 8, recomputed 0" is that bug, and the
 * first test fails on it.
 */

async function withJsonStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-enh62-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/**
 * A real in-memory store of the same shape as `JsonStore`.
 *
 * Not a mock: it holds real records and implements the same three methods the
 * refresh uses. It exists because a `JsonStore` writes through `JSON.stringify`,
 * which cannot hold the undigestible values the "must miss" test needs — a
 * `BigInt` or a cyclic reference is exactly what a connector can leave behind and
 * exactly what a digest has to refuse rather than hash.
 */
class MemoryStore {
  constructor(initial = {}) {
    this.state = { ...initial }
  }

  async read() {
    return this.state
  }

  async merge(partial = {}) {
    for (const [key, records] of Object.entries(partial)) {
      if (!Array.isArray(records)) {
        this.state[key] = records
        continue
      }
      this.state[key] = mergeById(this.state[key] || [], records)
    }
    return this.state
  }

  async replaceAnalytics(payload = {}) {
    for (const name of DERIVED_COLLECTIONS) this.state[name] = payload[name] || []
    return this.state
  }
}

/** One asset near one hazard, so the risk, impact and road paths all produce rows. */
const seeded = () => ({
  service_assets: [
    { id: 'r1', name: 'Road A', service_type: 'road', country: 'KE', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
    { id: 'c1', name: 'Clinic', service_type: 'health', country: 'KE', latitude: 3.11, longitude: 35.61 },
  ],
  hazard_events: [
    { id: 'h1', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 3.1, longitude: 35.6 },
  ],
  climate_observations: [
    { id: 'cl1', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 20, observed_at: '2026-01-01T00:00:00.000Z' },
    { id: 'cl2', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 25, observed_at: '2026-02-01T00:00:00.000Z' },
    { id: 'cl3', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 30, observed_at: '2026-03-01T00:00:00.000Z' },
    { id: 'cl4', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 35, observed_at: '2026-04-01T00:00:00.000Z' },
  ],
  conflict_events: [],
  alert_events: [],
  flood_probability_models: [],
  source_runs: [],
})

/** Refresh until the plan is steady: the first run populates `risk_scores`, which `impact_assessments` reads. */
async function steady(store) {
  await refreshAnalytics(store)
  await refreshAnalytics(store)
  return refreshAnalytics(store)
}

const asSet = (list) => [...list].sort()

describe('ENH-62 — the cache keys the collections it owns, and nothing else', () => {
  it('names exactly the eight derived collections replaceAnalytics owns', () => {
    assert.deepEqual(
      asSet(DERIVED_INPUTS.map((entry) => entry.name)),
      asSet(DERIVED_COLLECTIONS),
      'a cache key for a collection replaceAnalytics does not own is a key for a value that is never swapped',
    )
  })

  it('declares the inputs each collection actually reads', () => {
    // Enumerated from the modules that compute them, not guessed: `model_drift`
    // reads the climate series and nothing else; `region_trust` reads alerts and
    // model cards; the three scorers read the four geometry collections through
    // `collectRegions`.
    assert.deepEqual(derivedInputsFor('model_drift'), ['climate_observations'])
    assert.deepEqual(derivedInputsFor('region_trust'), ['alert_events', 'flood_probability_models'])
    assert.deepEqual(derivedInputsFor('population_at_risk'), ['service_assets', 'hazard_events'])
    assert.ok(derivedInputsFor('risk_scores').includes('hazard_events'))
    assert.ok(derivedInputsFor('data_quality').includes('source_runs'))
    assert.deepEqual(derivedInputsFor('not_a_collection'), [], 'an unknown name covers nothing')
  })

  it('names the clock-dependent collections it must always recompute', () => {
    assert.deepEqual(asSet(CLOCK_DEPENDENT), asSet(['road_access', 'data_quality']))
    for (const name of CLOCK_DEPENDENT) {
      assert.ok(DERIVED_INPUTS.some((entry) => entry.name === name), `${name} is not a derived collection`)
    }
  })
})

describe('ENH-62 — a cold cache recomputes, and never reports a full skip', () => {
  it('recomputes every collection on the first run', async () => {
    await withJsonStore(async (store) => {
      await store.merge(seeded())
      const result = await refreshAnalytics(store)
      assert.equal(result.skipped.length, 0,
        'a cold cache that skipped anything reused a value it never computed')
      assert.equal(result.recomputed.length, DERIVED_COLLECTIONS.length,
        'the first run has no previous value for any collection, so all eight are recomputed')
    })
  })

  it('a matching digest with no stored rows is still a miss', () => {
    // The defect this guards: a plan that skips on a digest alone reports
    // "skipped 8, recomputed 0" against an empty store, because the digest of
    // empty inputs is a real value that matches a cache holding that same empty
    // digest. There are no rows to publish, so a skip would publish nothing.
    const plan = planDerivedRefresh(
      { climate_observations: [], service_assets: [], hazard_events: [] },
      { model_drift: 'the-hash-of-nothing', risk_scores: 'the-hash-of-nothing' },
      {},
    )
    assert.equal(plan.skip.length, 0, 'a skip with no rows behind it is the measures-nothing failure')
    assert.ok(plan.recompute.includes('model_drift'))
    assert.ok(plan.recompute.includes('risk_scores'))
  })
})

describe('ENH-62 — unchanged inputs skip, and only the clock-bound ones recompute', () => {
  it('skips every clock-free collection once the inputs stand still', async () => {
    await withJsonStore(async (store) => {
      await store.merge(seeded())
      const result = await steady(store)
      const clockFree = DERIVED_COLLECTIONS.filter((name) => !CLOCK_DEPENDENT.includes(name))
      assert.deepEqual(asSet(result.skipped), asSet(clockFree),
        'every collection whose inputs did not move should be skipped')
      assert.deepEqual(asSet(result.recomputed), asSet(CLOCK_DEPENDENT),
        'only the clock-dependent collections recompute when nothing in the store changed')
    })
  })

  it('the skipped collection keeps the rows it had, so the skip is observable in the store', async () => {
    await withJsonStore(async (store) => {
      await store.merge(seeded())
      await refreshAnalytics(store)
      const before = await store.read()
      const driftBefore = before.model_drift.map((r) => r.generated_at)

      const result = await refreshAnalytics(store)
      assert.ok(result.skipped.includes('model_drift'), 'drift reads only the climate series, which did not change')

      const after = await store.read()
      assert.deepEqual(after.model_drift.map((r) => r.generated_at), driftBefore,
        'a skipped collection is written back byte-for-byte, timestamps and all')
    })
  })
})

describe('ENH-62 — a changed input recomputes its collection and no sibling', () => {
  it('recomputes region_trust alone when only an alert is added', async () => {
    await withJsonStore(async (store) => {
      await store.merge(seeded())
      await steady(store)

      // An alert outcome is read by `region_trust` and by no other derived
      // collection. Its arrival must recompute that one and leave the rest —
      // including `model_drift`, whose input is the untouched climate series.
      await store.merge({
        alert_events: [{
          id: 'a1', region: 'Turkana', type: 'flood', severity: 'high',
          false_alert: true, outcome_reason: 'sensor_fault', created_at: '2026-05-01T00:00:00.000Z',
        }],
      })
      const result = await refreshAnalytics(store)

      assert.ok(result.recomputed.includes('region_trust'), 'an alert changed, so the trust score must be recomputed')
      assert.ok(result.skipped.includes('model_drift'), 'the climate series did not change')
      assert.ok(result.skipped.includes('risk_scores'), 'the geometry collections did not change')
      assert.ok(result.skipped.includes('population_at_risk'))
    })
  })

  it('recomputes the three scorers when a hazard changes, and impact with them', async () => {
    await withJsonStore(async (store) => {
      await store.merge(seeded())
      await steady(store)

      // A new hazard changes `risk_scores` (which reads hazard_events) and, through
      // the stored scores it borrows from, `impact_assessments`. It does not touch
      // `region_trust` or `model_drift`.
      await store.merge({
        hazard_events: [{ id: 'h2', event_type: 'flood', severity: 'high', title: 'Second flood', latitude: 3.2, longitude: 35.7 }],
      })
      const result = await refreshAnalytics(store)

      assert.ok(result.recomputed.includes('risk_scores'), 'a hazard is a risk-score input')
      assert.ok(result.recomputed.includes('impact_assessments'), 'impacts read the scores the hazard moved')
      assert.ok(result.skipped.includes('region_trust'), 'no alert or model card changed')
      assert.ok(result.skipped.includes('model_drift'))
    })
  })
})

describe('ENH-62 — the digest covers content, so a stale hit is impossible', () => {
  it('recomputes when a covered field changes without the count changing', async () => {
    await withJsonStore(async (store) => {
      await store.merge(seeded())
      await steady(store)

      // Same number of hazards, different severity. A count-based digest — the
      // shape a naive "did anything arrive" check would take — misses this and
      // serves the old score. The content digest must not.
      await store.merge({
        hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'low', title: 'Flood', latitude: 3.1, longitude: 35.6 }],
      })
      const result = await refreshAnalytics(store)
      assert.ok(result.recomputed.includes('risk_scores'),
        'severity moved and the count did not; a digest that only counts would have been fooled')
    })
  })

  it('recomputes model_drift when a climate reading changes but its count does not', async () => {
    await withJsonStore(async (store) => {
      await store.merge(seeded())
      await steady(store)

      // `driftFromStore` reads `precipitation_mm` from each observation. Four
      // readings become four different readings, so the count is identical and the
      // content is not. A digest that covered only presence would serve the old
      // verdict; this one covers the value.
      await store.merge({
        climate_observations: [{ id: 'cl1', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 200, observed_at: '2026-01-01T00:00:00.000Z' }],
      })
      const result = await refreshAnalytics(store)
      assert.ok(result.recomputed.includes('model_drift'),
        'a changed reading is a changed input, whatever the record count says')
    })
  })
})

describe('ENH-62 — an undigestible input forces a miss, never a false hit', () => {
  it('recomputes a collection whose inputs cannot be digested', () => {
    // A `BigInt` a connector left behind throws in `JSON.stringify`. The cache
    // holds a value and there are rows to reuse, so everything needed for a hit is
    // present except a digest that can be computed — and that is a miss.
    const plan = planDerivedRefresh(
      { flood_probability_models: [{ id: 'm1', region: 'Turkana', big: 10n }] },
      { region_trust: 'a-previous-digest' },
      { region_trust: [{ id: 'trust_x' }] },
    )
    assert.ok(plan.recompute.includes('region_trust'),
      'an input that cannot be hashed is an absent measurement, not a digest of the empty set')
    assert.ok(!plan.skip.includes('region_trust'))
  })

  it('recomputes a collection whose inputs are cyclic', () => {
    const cyclic = { id: 'm1', region: 'Turkana' }
    cyclic.self = cyclic
    const plan = planDerivedRefresh(
      { flood_probability_models: [cyclic] },
      { region_trust: 'a-previous-digest' },
      { region_trust: [{ id: 'trust_x' }] },
    )
    assert.ok(plan.recompute.includes('region_trust'))
  })

  it('misses end to end when a stored input cannot be digested', async () => {
    // The real path, not just the plan: a store holding an undigestible record.
    // First refresh warms the cache; the second has an identical-shaped but
    // undigestible input and must recompute rather than skip.
    const store = new MemoryStore(seeded())
    const first = await refreshAnalytics(store)
    assert.ok(first.recomputed.includes('region_trust'), 'the first run computes it')

    store.state.flood_probability_models = [{ id: 'm1', region: 'Turkana', folds: [], big: 5n }]
    const second = await refreshAnalytics(store)
    assert.ok(second.recomputed.includes('region_trust'),
      'an undigestible model card forces the trust score to miss rather than reuse a stale one')
  })
})

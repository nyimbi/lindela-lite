import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_SEED,
  ROUTE_RELIABILITY_BY_LEVEL,
  demandScenarios,
  expectedShortfall,
  planPrepositioning,
  routeReliability,
} from '../src/prepositioning.js'

/**
 * ENH-53 — resource pre-positioning optimiser.
 *
 * The tests are written against the two claims the entry makes. First, that the
 * allocation is *distribution-aware*: a site with the same mean demand but a
 * fatter tail gets more stock, and the mirror case swaps the allocation while
 * leaving the means untouched. Second, that the improvement is a measured number
 * rather than a claim — the expected unmet demand of the optimised plan is
 * reported beside the proportional-to-mean plan it beats, and the degenerate
 * (certain-demand) case is asserted to tie, so the gain in the spread case is
 * the uncertainty and not an artefact of the arithmetic.
 *
 * Every number below is hand-derivable from the scenario set, so a reader can
 * recompute it without running the code. See the header for the derivation.
 */

/** A trunk road at a point — the transport substrate the optimiser reads. */
const road = (id, lat, lon, roadClass = 'trunk') => ({
  id,
  name: id,
  service_type: 'road',
  road_class: roadClass,
  country: 'KE',
  latitude: lat,
  longitude: lon,
})

const ROADS = [road('rA', 3.1, 35.6), road('rB', 3.9, 41.8)]

/** A demand and/or staging site by coordinate. */
const site = (code, lat, lon) => ({ code, latitude: lat, longitude: lon })

/** The two sites every case shares: A near rA, B near rB, 660 km apart. */
const SITES = [site('A', 3.1, 35.6), site('B', 3.9, 41.8)]

/**
 * The spread case, exactly. Two equally likely scenarios over a budget of 150:
 *
 *   s1 (p 0.5): A dry (0), B wants 100
 *   s2 (p 0.5): A wants 200, B wants 100
 *
 * Means are 100 each, so the mean-only plan stages 75/75. But E[unmet] is convex:
 * A's own expected shortfall is minimised at 100, not 75. The optimiser stages
 * 50/100, giving E[unmet] 75 against the mean-only plan's 87.5.
 */
const SPREAD = [
  { probability: 0.5, demand: { A: 0, B: 100 } },
  { probability: 0.5, demand: { A: 200, B: 100 } },
]

const plan = (over = {}) => planPrepositioning({
  demandSites: SITES,
  stagingSites: SITES,
  data: { service_assets: ROADS, hazard_events: [] },
  budget: 150,
  steps: 300,
  scenarios: SPREAD,
  ...over,
})

describe('pre-positioning allocation is distribution-aware (ENH-53)', () => {
  it('stages toward the tail and reports the improvement as a number', () => {
    const result = plan()
    // A carries the spread, so it gets the stock sized to its 100-unit tail, not
    // its 100-unit mean. B, certain at 100, gets exactly 100.
    assert.equal(result.allocation.A, 50)
    assert.equal(result.allocation.B, 100)
    assert.equal(result.expected_unmet, 75)
    assert.equal(result.naive_expected_unmet, 87.5)
    assert.equal(result.improvement.absolute, 12.5)
    assert.equal(result.improvement.relative_pct, 14.29)
    assert.equal(result.refusal, null)
  })

  it('swaps the allocation when the spread moves, with the means unchanged', () => {
    // The mirror: B now carries the spread, A is certain. The means are still
    // 100/100, so a mean-only planner cannot tell this case from the one above —
    // and it stages the same 75/75 to both. The optimiser reverses.
    const mirrored = plan({
      scenarios: [
        { probability: 0.5, demand: { A: 100, B: 0 } },
        { probability: 0.5, demand: { A: 100, B: 200 } },
      ],
    })
    assert.equal(mirrored.allocation.A, 100)
    assert.equal(mirrored.allocation.B, 50)
    assert.equal(mirrored.expected_unmet, 75)
    // The mean-only plan is identical in both cases — the thing this entry is
    // about is that the optimised plan is not.
    assert.equal(mirrored.naive_expected_unmet, 87.5)
  })

  it('ties the mean-only plan when demand is certain, so the gain is the uncertainty', () => {
    // One scenario, no spread. With nothing to hedge there is nothing to gain,
    // and the optimiser and the mean-only plan agree. If the spread case showed
    // a gain and this one did not tie, the gain would be a modelling artefact.
    const certain = plan({ scenarios: [{ probability: 1, demand: { A: 100, B: 100 } }] })
    assert.equal(certain.expected_unmet, 50)
    assert.equal(certain.naive_expected_unmet, 50)
    assert.equal(certain.improvement.absolute, 0)
    // 150 stock against 200 demand: 50 unmet, whatever the split, because both
    // sites are equally reachable and equally needy.
    assert.equal(certain.allocation.A + certain.allocation.B, 150)
  })

  it('never does worse than the mean-only plan across a budget sweep', () => {
    for (const budget of [50, 100, 150, 200]) {
      const result = plan({ budget })
      assert.ok(
        result.expected_unmet <= result.naive_expected_unmet + 1e-9,
        `budget ${budget}: ${result.expected_unmet} > ${result.naive_expected_unmet}`,
      )
    }
  })

  it('spends no more than the budget and stages nothing negative', () => {
    const result = plan()
    const staged = Object.values(result.allocation).reduce((sum, value) => sum + value, 0)
    assert.ok(staged <= result.budget + 1e-9)
    for (const value of Object.values(result.allocation)) assert.ok(value >= 0)
  })
})

describe('transport is the road network, not a straight line (ENH-53)', () => {
  const NOW = new Date('2026-10-03T12:00:00.000Z')
  const floodAt = (lat, lon) => ({
    id: 'h1',
    event_type: 'flood',
    severity: 'red',
    title: 'Flood warning',
    latitude: lat,
    longitude: lon,
    occurred_at: '2026-10-02T00:00:00.000Z',
  })

  it('gives a cut-off road zero reliability and stages nothing there', () => {
    // A red flood sits on rA. `computeRoadAccess` returns access_level
    // 'cut_off', and a cut-off road carries no stock — staging to it is losing
    // the stock, not pre-positioning it. B, the reachable site, gets the 100 it
    // is certain to need; the remaining 50 buys no reduction anywhere and is
    // left unallocated rather than shipped into a road that is under water.
    const result = plan({
      now: NOW,
      data: { service_assets: ROADS, hazard_events: [floodAt(3.1, 35.6)] },
    })
    assert.equal(result.allocation.A, 0)
    assert.equal(result.allocation.B, 100)
    // A's 100 units are unreachable, so unmet is 100 however the budget is spent.
    assert.equal(result.expected_unmet, 100)
    // The mean-only plan wastes half the budget on the dead road: it ships 75 to
    // A (all of it lost) and 75 to B, leaving B 25 short — so 125 unmet, not the
    // 100 the optimiser reaches.
    assert.equal(result.naive_expected_unmet, 125)
    const link = result.transport.find((row) => row.demand_code === 'A')
    assert.equal(link.access_level, 'cut_off')
    assert.equal(link.route_reliability, ROUTE_RELIABILITY_BY_LEVEL.cut_off)
  })

  it('maps access levels to a fraction of stock that arrives', () => {
    assert.equal(routeReliability({ access_level: 'open' }), 1)
    assert.equal(routeReliability({ access_level: 'constrained' }), 0.6)
    assert.equal(routeReliability({ access_level: 'severely_constrained' }), 0.3)
    assert.equal(routeReliability({ access_level: 'cut_off' }), 0)
    // An unclassifiable level is unknown, not open.
    assert.equal(routeReliability({ access_level: 'something_else' }), null)
    assert.equal(routeReliability(null), null)
  })

  it('refuses a demand site with no scored road within the link radius', () => {
    // A site 200 km from any road. An unrecorded road is not a clear one, so
    // the transport cost is unknown rather than zero, and the plan refuses.
    const result = planPrepositioning({
      demandSites: [site('Z', 0, 0)],
      stagingSites: SITES,
      data: { service_assets: ROADS, hazard_events: [] },
      budget: 100,
      scenarios: [{ probability: 1, demand: { Z: 10 } }],
    })
    assert.equal(result.allocation, null)
    assert.equal(result.refusal, 'unroutable_demand')
    assert.match(result.reason, /unrecorded road is not a clear one/)
  })
})

describe('the optimiser refuses rather than inventing an input (ENH-53)', () => {
  it('refuses a demand site with no distribution, rather than reading it as zero demand', () => {
    // Routable, but no distribution and no scenario set. "No demand recorded" is
    // not "no demand"; the site is unmodelled.
    const result = planPrepositioning({
      demandSites: [site('A', 3.1, 35.6)],
      stagingSites: SITES,
      data: { service_assets: ROADS, hazard_events: [] },
      budget: 100,
    })
    assert.equal(result.refusal, 'unmodelled_demand')
    assert.equal(result.expected_unmet, null)
    assert.match(result.reason, /unmodelled rather than zero/)
  })

  it('refuses a distribution whose probabilities do not sum to one', () => {
    const result = planPrepositioning({
      demandSites: [{
        code: 'A',
        latitude: 3.1,
        longitude: 35.6,
        demandDistribution: [{ probability: 0.5, units: 10 }],
      }],
      stagingSites: SITES,
      data: { service_assets: ROADS, hazard_events: [] },
      budget: 100,
    })
    assert.equal(result.refusal, 'unmodelled_demand')
  })

  it('refuses an explicit scenario set with no weights', () => {
    const result = plan({
      scenarios: [{ probability: 0.5, demand: { A: 10, B: 10 } }],
    })
    assert.equal(result.refusal, 'unweighted_scenarios')
    assert.equal(result.expected_unmet, null)
    assert.match(result.reason, /do not sum to one/)
  })

  it('refuses an unusable budget', () => {
    const result = plan({ budget: 0 })
    assert.equal(result.refusal, 'unusable_budget')
    assert.equal(result.allocation, null)
  })

  it('refuses when no candidate staging site carries a coordinate', () => {
    const result = plan({ stagingSites: [{ code: 'A' }] })
    assert.equal(result.refusal, 'no_staging_sites')
  })

  it('reports every numeric field as null on a refusal, never zero', () => {
    const result = plan({ budget: null })
    assert.equal(result.allocation, null)
    assert.equal(result.expected_unmet, null)
    assert.equal(result.naive_expected_unmet, null)
    assert.equal(result.improvement, null)
    assert.deepEqual(result.transport, [])
  })
})

describe('the sampled path is seeded and reproducible (ENH-53)', () => {
  const demandSites = [
    {
      code: 'A',
      latitude: 3.1,
      longitude: 35.6,
      hazardProbability: 0.5,
      demandDistribution: [{ probability: 0.7, units: 0 }, { probability: 0.3, units: 300 }],
    },
    {
      code: 'B',
      latitude: 3.9,
      longitude: 41.8,
      hazardProbability: 0.5,
      demandDistribution: [{ probability: 1, units: 100 }],
    },
  ]
  const base = {
    demandSites,
    stagingSites: SITES,
    data: { service_assets: ROADS, hazard_events: [] },
    budget: 200,
  }

  it('produces the same allocation for the same seed', () => {
    const a = planPrepositioning({ ...base, seed: 42 })
    const b = planPrepositioning({ ...base, seed: 42 })
    assert.deepEqual(a.allocation, b.allocation)
    assert.equal(a.expected_unmet, b.expected_unmet)
    assert.equal(a.scenarios.source, 'sampled')
    assert.equal(a.scenarios.seed, 42)
  })

  it('defaults to a fixed seed, so two runs with no seed agree', () => {
    const a = planPrepositioning(base)
    const b = planPrepositioning(base)
    assert.deepEqual(a.allocation, b.allocation)
    assert.equal(a.scenarios.seed, DEFAULT_SEED)
  })

  it('draws zero demand when the hazard probability is zero', () => {
    const sampled = demandScenarios({
      demandSites: [{ code: 'A', hazardProbability: 0, demandDistribution: [{ probability: 1, units: 500 }] }],
      seed: 1,
      draws: 5,
    })
    for (const scenario of sampled.scenarios) assert.equal(scenario.demand.A, 0)
  })
})

describe('expected shortfall is convex, which is why the mean is not enough (ENH-53)', () => {
  it('gives different expected shortfall to two series with the same mean', () => {
    const spread = [{ probability: 0.5, demand: 0 }, { probability: 0.5, demand: 200 }]
    const flat = [{ probability: 1, demand: 100 }]
    // Both have mean 100. At a delivered 100 the flat series is fully covered and
    // the spread series is short 100 half the time.
    assert.equal(expectedShortfall(flat, 100), 0)
    assert.equal(expectedShortfall(spread, 100), 50)
  })

  it('is zero once the delivered stock covers the largest scenario', () => {
    const series = [{ probability: 0.5, demand: 0 }, { probability: 0.5, demand: 200 }]
    assert.equal(expectedShortfall(series, 200), 0)
  })
})

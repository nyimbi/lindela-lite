#!/usr/bin/env node
/**
 * ENH-21 — forecast versus observed.
 *
 * A reliability diagram is the easiest chart in the product to draw and the
 * easiest to make flattering by accident. Every test here is about a way that
 * happens: dropping the forecasts nobody has checked yet, letting a bin of one
 * look like a bin of three hundred, reporting an unmeasurable skill as a zero,
 * and pairing a forecast with the wrong observation so the diagram measures the
 * join rather than the forecast.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  binEdges, pairForecasts, reliability, reliabilityDiagram, verificationByLead,
} from '../public/shared/viz-verify.js'

/**
 * One forecast and one observation for the same place and day.
 *
 * The day is supplied because a join key is a *join*: two fixtures sharing a
 * date share a key, and pairing collapses them into one. That is the fixture's
 * bug, not the module's, and it is the same mistake a caller makes by joining on
 * a field that is not actually the identity.
 */
const pair = (probability, outcome, over = {}) => {
  const day = over.day ?? '2026-03-01'
  return {
    forecast: {
      id: `f-${day}-${probability}`, region_name: 'Kisumu',
      issued_at: `${day}T00:00:00Z`, valid_at: `${day}T12:00:00Z`,
      precipitation_probability_pct: probability, ...over.forecast,
    },
    observation: {
      id: `o-${day}-${probability}`, region_name: 'Kisumu',
      observed_at: `${day}T12:00:00Z`, precipitation_mm: outcome ? 24 : 0, ...over.observation,
    },
  }
}

// A forecast carries `valid_at`, an observation `observed_at` — the same event
// at two different hours. A join key has to reconcile them, which is exactly
// why `pairForecasts` refuses to guess one: a key that reads only one field
// matches nothing at all.
const key = (r) => `${r.region_name}|${(r.valid_at ?? r.observed_at).slice(0, 10)}`

const rainEvent = (o, { threshold = 1 } = {}) => (Number(o.precipitation_mm) >= threshold ? 1 : 0)

/**
 * Turn `{ p, o, day }` specs into a pairing. A spec with `o: null` contributes a
 * forecast and no observation, which is the "not yet verified" case.
 */
const build = (specs, options = {}) => {
  // Each spec gets its own day unless it names one: two specs sharing a day
  // share a join key, and the second silently replaces the first.
  const dated = specs.map((s, i) => ({ ...s, day: s.day ?? `2026-03-${String(i + 1).padStart(2, '0')}` }))
  const forecasts = dated.map((s) => pair(s.p, s.o, s).forecast)
  const observations = dated.filter((s) => s.o !== null).map((s) => pair(s.p, s.o, s).observation)
  return pairForecasts(forecasts, observations, {
    key, eventOf: rainEvent, asOf: Date.parse('2026-04-01T00:00:00Z'), ...options,
  })
}

describe('pairing refuses to guess', () => {
  it('will not pair anything without an explicit join key', () => {
    assert.throws(() => pairForecasts([], [], {}), /explicit join key/)
    // Matching a forecast to an observation on proximity alone would score a
    // Day-1 forecast against a Day-3 observation, measuring the join rather than
    // the forecast.
  })

  it('keeps a pending forecast rather than dropping it', () => {
    const f = pair(80, null).forecast
    const p = pairForecasts([f], [], { key, eventOf: rainEvent, asOf: Date.parse('2026-02-01T00:00:00Z') })
    assert.equal(p.pairs.length, 1)
    assert.equal(p.pairs[0].status, 'pending')
    assert.equal(p.counts.verified, undefined)
    assert.equal(p.pending.length, 1)
  })

  it('reports coverage as the fraction actually checked', () => {
    const specs = [
      { p: 80, o: 1, day: '2026-03-01' },
      { p: 20, o: 0, day: '2026-03-02' },
      // Valid in the future relative to `asOf` (2026-04-01 is well after, so
      // name a day past it): pending, and counted rather than dropped.
      { p: 60, o: null, day: '2026-05-01' },
    ]
    const p = build(specs)
    assert.equal(p.total, 3)
    assert.equal(p.counts.verified, 2)
    assert.equal(p.counts.pending, 1)
    assert.equal(p.coverage, 0.667)
  })

  it('says a forecast with no matching observation is uncheckable, not wrong', () => {
    const p = pairForecasts([pair(80, 1).forecast], [], { key, eventOf: rainEvent })
    assert.equal(p.pairs[0].status, 'no_outcome')
    assert.equal(p.pairs[0].outcome, null)
    assert.match(p.pairs[0].reason, /no observation carries this key/)
  })

  it('marks a forecast with no probability unusable rather than binning it', () => {
    const f = { ...pair(80, 1).forecast, precipitation_probability_pct: null }
    const p = pairForecasts([f], [pair(80, 1).observation], { key, eventOf: rainEvent })
    assert.equal(p.pairs[0].status, 'unusable')
    assert.match(p.pairs[0].reason, /no probability to bin/)
  })

  it('says no skill can be claimed when no event definition was supplied', () => {
    // A diagram whose event was never defined verifies nothing, and saying
    // "0 verified" is the honest answer rather than pairing everything.
    const p = pairForecasts([pair(80, 1).forecast], [pair(80, 1).observation], { key })
    assert.equal(p.pairs[0].status, 'no_outcome')
    assert.match(p.pairs[0].reason, /no event definition/)
  })

  it('treats a non-0/1 event answer as not determined, not as a miss', () => {
    const r = pairForecasts([pair(80, 1).forecast], [pair(80, 1).observation], { key, eventOf: () => null })
    assert.equal(r.pairs[0].status, 'no_outcome')
    assert.equal(r.pairs[0].outcome, null)
  })

  it('reads a boolean outcome as well as a number', () => {
    const truthy = pairForecasts([pair(80, 1).forecast], [pair(80, 1).observation], { key, eventOf: () => true })
    assert.equal(truthy.pairs[0].outcome, 1)
    const falsy = pairForecasts([pair(80, 1).forecast], [pair(80, 1).observation], { key, eventOf: () => false })
    assert.equal(falsy.pairs[0].outcome, 0)
  })

  it('survives an event function that throws', () => {
    const p = pairForecasts([pair(80, 1).forecast], [pair(80, 1).observation], {
      key,
      eventOf: () => { throw new Error('boom') },
    })
    assert.equal(p.pairs[0].status, 'no_outcome')
  })
})

describe('the join is reported, because a bad join makes the whole diagram wrong', () => {
  it('counts observations that no forecast matched', () => {
    const forecasts = [pair(80, 1).forecast]
    const observations = [pair(80, 1).observation, { region_name: 'Kisumu', observed_at: '2026-03-09T00:00:00Z' }]
    const p = pairForecasts(forecasts, observations, { key, eventOf: rainEvent })
    assert.equal(p.unmatchedObservations, 1)
  })

  it('flags a join where most observations fell out', () => {
    const forecasts = [pair(80, 1).forecast]
    const observations = [
      { region_name: 'Kisumu', observed_at: '2026-03-09T00:00:00Z' },
      { region_name: 'Kisumu', observed_at: '2026-03-10T00:00:00Z' },
      { region_name: 'Kisumu', observed_at: '2026-03-11T00:00:00Z' },
    ]
    const p = pairForecasts(forecasts, observations, { key, eventOf: rainEvent })
    assert.equal(p.joinSuspect, true)
  })

  it('does not flag a join where nothing fell out', () => {
    const p = build([{ p: 80, o: 1 }])
    assert.equal(p.joinSuspect, false)
    assert.equal(p.unmatchedObservations, 0)
  })

  it('scores one forecast against one observation when a key repeats', () => {
    // Two observations for one key is a revision, and scoring both would count
    // one forecast twice.
    const later = { region_name: 'Kisumu', observed_at: '2026-03-01T18:00:00Z', precipitation_mm: 0 }
    const earlier = { region_name: 'Kisumu', observed_at: '2026-03-01T12:00:00Z', precipitation_mm: 24 }
    const p = pairForecasts([pair(80, 1).forecast], [later, earlier], { key, eventOf: rainEvent })
    assert.equal(p.pairs.length, 1)
    assert.equal(p.pairs[0].outcome, 1, 'the earlier observation wins')
  })
})

describe('bins carry their sample size or they carry nothing', () => {
  it('will not draw bins narrower than the floor', () => {
    // Below ~10 points wide, a bin's observed frequency moves in steps of 10
    // points and the diagram is noisier than its own bins.
    assert.deepEqual(binEdges({ count: 40 }), binEdges({ count: 40, minWidth: 10 }).slice(0, binEdges({ count: 40 }).length))
    assert.ok(binEdges({ count: 50 }).every(([lo, hi]) => hi - lo >= 10))
  })

  it('reports an empty bin as null, never as zero frequency', () => {
    // 0% observed in a bin holding nothing says the product never forecasts
    // below 0%; 0% in a bin holding ten says all ten were wrong.
    const r = reliability(build([{ p: 80, o: 1 }]).pairs, { bins: 5 })
    const empty = r.bins.find((b) => b.n === 0)
    assert.equal(empty.observed, null)
    assert.equal(empty.forecast, null)
    assert.equal(empty.hits, 0)
  })

  it('refuses to call a small bin trustworthy', () => {
    const r = reliability(build([{ p: 45, o: 1 }]).pairs, { bins: 5, minBin: 5 })
    assert.equal(r.n, 1)
    assert.equal(r.trustworthy, false)
  })

  it('reports the mean lead time per bin, so a good average can hide a bad horizon', () => {
    const r = reliability(build([{ p: 80, o: 1 }]).pairs, { bins: 5 })
    assert.equal(r.bins.find((b) => b.n === 1).leadDays, 0.5, 'issued 12h before valid time')
  })
})

describe('metrics are null when undefined, never zero', () => {
  it('reports no Brier score at all when nothing is verified', () => {
    const r = reliability(build([{ p: 80, o: null }]).pairs)
    assert.equal(r.n, 0)
    assert.equal(r.brier, null)
    assert.equal(r.baseRate, null)
    assert.equal(r.skill, null)
    assert.match(r.statement, /Nothing has been verified yet/)
  })

  it('reports skill as undefined rather than zero when outcomes have no spread', () => {
    // Every verification landed the same way, so there is nothing to beat.
    const r = reliability(build([
      { p: 80, o: 1 }, { p: 90, o: 1 }, { p: 70, o: 1 },
    ]).pairs)
    assert.equal(r.baseRate, 1)
    assert.equal(r.skill, null, 'a failed comparison and an absent one are different')
    assert.match(r.statement, /not defined/)
  })

  it('reports negative skill plainly when the forecast is worse than the base rate', () => {
    const r = reliability(build([
      { p: 90, o: 0 }, { p: 80, o: 1 }, { p: 20, o: 0 }, { p: 10, o: 1 },
    ]).pairs)
    assert.ok(r.skill < 0, `expected negative skill, got ${r.skill}`)
    assert.match(r.statement, /worse than always quoting/)
  })

  it('reports the base rate it compared against', () => {
    const r = reliability(build([{ p: 80, o: 1 }, { p: 20, o: 0 }]).pairs)
    assert.equal(r.baseRate, 0.5)
  })
})

describe('the diagram cannot be read as verified when it is not', () => {
  it('draws unverified forecasts as their own row, never on the frequency scale', () => {
    const r = reliability(build([
      { p: 80, o: 1 }, { p: 20, o: 0 }, { p: 50, o: null }, { p: 60, o: null },
    ]).pairs)
    const c = reliabilityDiagram(r, { bins: 5 })
    // The two most damning lines in the file, and they are both here.
    assert.match(c.svg, /2 forecast\(s\) not yet observed/)
    assert.match(c.svg, /no skill is claimed/)
    assert.match(c.caption, /An unverified forecast is not a good one/)
    assert.equal(c.verified, 2)
    assert.equal(c.unverified, 2)
    assert.equal(c.coverage, 0.5)
  })

  it('plots no point and claims no skill when nothing is verified', () => {
    const r = reliability(build([{ p: 80, o: null }, { p: 30, o: null }]).pairs)
    const c = reliabilityDiagram(r, { bins: 5 })
    assert.ok(!c.svg.includes('viz-verify-point"'))
    assert.ok(!c.svg.includes('polyline class="viz-verify-line"'))
    assert.match(c.svg, /No forecast has been verified/)
    assert.match(c.svg, /no skill is claimed/)
    // The diagonal is still drawn: the reader needs the reference to see that
    // nothing has been plotted against it.
    assert.match(c.svg, /perfect calibration/)
  })

  it('labels every point with its bin and its n', () => {
    const c = reliabilityDiagram(reliability(build([{ p: 80, o: 1 }, { p: 80, o: 1 }]).pairs, { bins: 5 }))
    assert.match(c.svg, /80–100% · n=2/)
  })

  it('outlines a point whose bin is too small to carry a conclusion', () => {
    const c = reliabilityDiagram(reliability(build([{ p: 45, o: 1 }]).pairs, { bins: 5, minBin: 5 }))
    // A hollow point in the warn token: a bin of one landing at 100% observed
    // reads as a perfect forecast and is nothing of the kind.
    assert.match(c.svg, /viz-verify-point-thin/)
    assert.match(c.svg, /fill="var\(--surface\)" stroke="var\(--warn\)"/)
  })

  it('draws an empty bin as a hollow marker rather than skipping it', () => {
    // The gap is information about the forecast's own spread.
    const c = reliabilityDiagram(reliability(build([{ p: 80, o: 1 }]).pairs, { bins: 5 }))
    assert.ok(c.svg.includes('viz-verify-empty'))
  })

  it('never joins the line across an empty bin', () => {
    const r = reliability(build([{ p: 10, o: 0 }, { p: 85, o: 1 }]).pairs, { bins: 5 })
    const c = reliabilityDiagram(r, { bins: 5 })
    // Two occupied bins, three empty between them. A line across the hole would
    // assert a calibration that was never observed.
    assert.ok(!c.svg.includes('polyline class="viz-verify-line"'))
  })

  it('states the coverage in the caption a caller cannot omit', () => {
    const c = reliabilityDiagram(reliability(build([{ p: 80, o: 1 }, { p: 20, o: null }]).pairs), { bins: 5 })
    assert.match(c.caption, /Verified 1 of 2 forecast\(s\) \(50%\)/)
  })

  it('is honest in the table about a bin it cannot evaluate', () => {
    const c = reliabilityDiagram(reliability(build([
      { p: 80, o: 1, day: '2026-03-01' },
      { p: 50, o: null, day: '2026-05-01' },
    ]).pairs, { bins: 5 }))
    assert.match(c.table, /not enough verifications/)
    assert.match(c.table, /not yet observed/)
    assert.match(c.table, /not verified — no skill claimed/)
    assert.match(c.table, /Skill vs observed base rate/)
  })

  it('reports every metric as not measurable when nothing is verified', () => {
    // Not as zero. A Brier of 0 would say the forecasts were perfect.
    const c = reliabilityDiagram(reliability(build([{ p: 80, o: null, day: '2026-05-01' }]).pairs, { bins: 5 }))
    assert.match(c.table, /not measurable — nothing verified/)
    assert.match(c.table, /not defined/)
  })

  it('gives the chart a role, a title and a description carrying the metrics', () => {
    const c = reliabilityDiagram(reliability(build([{ p: 80, o: 1 }, { p: 20, o: 0 }]).pairs), { bins: 5 })
    assert.match(c.svg, /role="img"/)
    assert.match(c.svg, /<title id="viz-verify-t">Forecast reliability<\/title>/)
    assert.match(c.svg, /80–100%: .* across 1 forecast/)
  })

  it('draws against a 0–100 frequency scale it also prints', () => {
    const c = reliabilityDiagram(reliability(build([{ p: 80, o: 1 }]).pairs), { bins: 5 })
    assert.match(c.svg, /forecast probability/)
    assert.match(c.svg, /observed frequency/)
    assert.match(c.svg, /0%/)
    assert.match(c.svg, /100%/)
  })

  it('produces no NaN when a probability is a string or absent', () => {
    const p = pairForecasts(
      [{ ...pair(80, 1).forecast, precipitation_probability_pct: '80' }],
      [pair(80, 1).observation],
      { key, eventOf: rainEvent },
    )
    const c = reliabilityDiagram(reliability(p.pairs, { bins: 5 }))
    assert.ok(!c.svg.includes('NaN'), c.svg)
  })

  it('escapes the values it labels', () => {
    const f = { ...pair(80, 1).forecast, region_name: '<script>alert(1)</script>' }
    const o = { ...pair(80, 1).observation, region_name: '<script>alert(1)</script>' }
    const p = pairForecasts([f], [o], { key: () => 'x', eventOf: rainEvent })
    const c = reliabilityDiagram(reliability(p.pairs, { bins: 5 }), { title: '<script>' })
    assert.ok(!c.svg.includes('<script>'))
    assert.ok(!c.table.includes('<script>'))
  })
})

describe('skill is reported per lead time, because it is rarely uniform', () => {
  it('splits the verifications into lead buckets with their own counts', () => {
    const forecasts = [
      { ...pair(80, 1).forecast, id: 'f1', issued_at: '2026-03-02T00:00:00Z', valid_at: '2026-03-02T12:00:00Z' },
      { ...pair(20, 1).forecast, id: 'f2', issued_at: '2026-02-26T00:00:00Z', valid_at: '2026-03-02T12:00:00Z' },
    ]
    const observations = [
      { ...pair(80, 1).observation, observed_at: '2026-03-02T12:00:00Z' },
      { ...pair(20, 1).observation, observed_at: '2026-03-02T12:00:00Z' },
    ]
    const p = pairForecasts(forecasts, observations, { key: (r) => `${r.valid_at ?? r.observed_at}`, eventOf: rainEvent })
    const rows = verificationByLead(p.pairs)
    // One verification issued a few hours ahead, one issued five days ahead.
    const short = rows.find((r) => r.label === '0–0 days')
    const longer = rows.find((r) => r.label === '3–6 days')
    assert.equal(short.verified, 1, 'the near-horizon forecast')
    assert.equal(longer.verified, 1, 'the far-horizon forecast')
    // Two buckets of one each. Averaging them would describe neither.
    // A 20% forecast that verified (observed 1) scores worse than an 80% one
    // that verified (observed 1). Averaging them would describe neither
    // horizon, which is the whole reason this split exists.
    assert.notEqual(short.brier, longer.brier)
    assert.equal(short.observedRate, 1)
    assert.equal(longer.observedRate, 1)
  })

  it('counts pending forecasts per bucket so a horizon is not scored on nothing', () => {
    const p = pairForeastsPending()
    const rows = verificationByLead(p)
    assert.ok(rows.some((r) => r.pending > 0))
    assert.ok(rows.every((r) => r.verified === 0), 'nothing in this fixture is verified')

    function pairForeastsPending() {
      const f = { ...pair(80, 1).forecast, issued_at: '2026-03-01T00:00:00Z', valid_at: '2026-03-03T00:00:00Z' }
      return pairForecasts([f], [], { key, eventOf: rainEvent, asOf: Date.parse('2026-03-02T00:00:00Z') }).pairs
    }
  })
})

describe('lead time is computed from the two timestamps the record carries', () => {
  it('is null rather than zero when either timestamp is missing', () => {
    const f = { ...pair(80, 1).forecast }
    delete f.issued_at
    const p = pairForecasts([f], [pair(80, 1).observation], { key, eventOf: rainEvent })
    assert.equal(p.pairs[0].lead_days, null)
  })

  it('reports the lead in days, to a tenth', () => {
    const p = build([{ p: 80, o: 1 }])
    assert.equal(p.pairs[0].lead_days, 0.5)
  })
})
/**
 * ENH-09 — the route, asserted where it lives.
 *
 * `src/agreement.js` was complete, tested, and reached by nothing. It is the
 * largest unused fidelity signal in the repository: two independent rainfall
 * products are ingested and were never compared, and where they disagree the
 * disagreement *is* the finding. This file guards the half that was missing —
 * the part that knows which `source` values are two measurements of the same
 * rain, turns a daily series into a monthly one, and hands the engine something
 * it can actually correlate.
 *
 * Five things, each of which is a way for the endpoint to look healthy while
 * saying nothing:
 *
 *   1. The matcher is method-aware. Every route in this family is a read, and
 *      the family answered `DELETE` with a 200 before VER-14 was swept.
 *   2. Two populated products in one region produce a real verdict, and it is
 *      not `unavailable`. A route that pairs nothing still returns 200.
 *   3. One product in a region reports `unavailable` **with a reason**, as a
 *      200. A refusal is an answer; a 4xx would be a client bug.
 *   4. Two flat products report `unavailable`, never a fabricated correlation
 *      of 0. The engine's own contract, asserted through the route because the
 *      route is what a consumer reads.
 *   5. The pairing is on `period`, not array index. This one is a canary: the
 *      input is shuffled and the verdict must not move. If it does, the
 *      correlation describes a relationship between two months that were never
 *      the same month — a confident wrong answer, which is the worst failure
 *      this endpoint can produce.
 *
 * And the declarations, because they are what makes the refusals legible: a
 * source that is *not* a comparable product has to be named with its reason, or
 * a forecast quietly absent from the comparison reads as an oversight rather
 * than as a decision.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleDerivedRoute, matchDerivedRoute } from '../src/routes/derived.js'
import { MIN_MONTH_COVERAGE, PRODUCT_SOURCES, sourceAgreement } from '../src/source-agreement.js'

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.json = () => JSON.parse(res.chunks.join(''))
  return res
}

const jsonResponse = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const call = ({ data = {}, search = '', method = 'GET' } = {}) => {
  const res = fakeResponse()
  return handleDerivedRoute({ kind: 'source-agreement' }, {
    data, res,
    req: { method, __auth: { subject: 'tester', partner_org: null } },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

/**
 * A month whose daily records sum to exactly `total`.
 *
 * The whole total lands on the first day and the rest read 0, which is a real
 * reading rather than an absence — "it did not rain that day". Controlling the
 * *monthly total* is what a test needs, because a flat daily figure is not a
 * flat monthly total: February and March have different lengths, so the same
 * daily value gives two different sums and a fixture written that way asserts a
 * correlation it did not intend.
 */
function monthTotal({ region, source, year, month, total }) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const values = [total, ...Array.from({ length: days - 1 }, () => 0)]
  return values.map((mm, i) => ({
    id: `${source}-${region}-${year}-${month}-${i}`,
    source,
    type: 'rainfall_observation',
    region_name: region,
    observed_at: `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
    precipitation_mm: mm,
  }))
}

/** A month reported on only `days` of its length, so its total is a fraction. */
function thinMonth({ region, source, year, month, values }) {
  return values.map((mm, i) => ({
    id: `${source}-${region}-${year}-${month}-${i}`,
    source,
    type: 'rainfall_observation',
    region_name: region,
    observed_at: `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
    precipitation_mm: mm,
  }))
}

/** A year of monthly totals for one region and source. */
function yearOf({ region, source, year, totals }) {
  return totals.flatMap((total, i) => monthTotal({ region, source, year, month: i + 1, total }))
}

/** Named months only, so a fixture can leave a hole where a source reported nothing. */
function monthsOf({ region, source, year, months }) {
  return months.flatMap(({ month, total }) => monthTotal({ region, source, year, month, total }))
}

describe('ENH-09 — the route is a read, and says so', () => {
  it('matches the source-agreement read on GET only', () => {
    assert.deepEqual(matchDerivedRoute('/api/v1/source-agreement', 'GET'), { kind: 'source-agreement' })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(matchDerivedRoute('/api/v1/source-agreement', method), null, `${method} matched a read route`)
    }
    for (const pathname of ['/api/v1/source-agreement/', '/api/v1/source-agreements', '/api/v1/source']) {
      assert.equal(matchDerivedRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
  })

  it('answers a store with no climate observations rather than throwing', async () => {
    const { handled, res } = await call({ data: { climate_observations: [] } })
    assert.equal(handled, true)
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.success, true)
    assert.equal(body.regions, 0)
    assert.equal(body.refused, 0)
    assert.deepEqual(body.data, [])
  })
})

describe('ENH-09 — two products are compared, and the verdict is real', () => {
  it('correlates two products that track each other, month by month', async () => {
    // CHIRPS wetter in the same months ERA5 is wetter: the rank order matches,
    // so this is `agree` — and it is the case a broken pairing turns into a
    // confident disagreement.
    const chirps = yearOf({ region: 'Turkana', source: 'chirps', year: 2024, totals: [31, 84, 186, 60] })
    const era5 = yearOf({ region: 'Turkana', source: 'open_meteo_archive', year: 2024, totals: [34, 79, 192, 57] })

    const { res } = await call({ data: { climate_observations: [...chirps, ...era5] } })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.regions, 1)

    const [row] = body.data
    assert.deepEqual(row.products_present, ['chirps', 'era5'])
    assert.equal(row.pairs_compared, 1)
    assert.equal(row.report.periods_compared, 1, 'the year was comparable')
    assert.equal(row.report.comparisons[0].verdict, 'agree')
    assert.equal(row.report.comparisons[0].paired_months, 4)
    assert.equal(row.report.comparisons[0].product_a, 'chirps')
    assert.equal(row.report.comparisons[0].product_b, 'era5')
    assert.ok(row.report.comparisons[0].rank_correlation > 0.9, 'the two products rank the months the same way')
    assert.equal(row.refusal_reason, null, 'a compared region carries no refusal')
  })

  it('compares the monthly totals, not the daily figures', async () => {
    // The unit the engine correlates over is a month. A route that handed it
    // daily values would report a paired count of 31 for a one-month overlap
    // and a correlation over days, which is a different question.
    //
    // Three months, because the engine's floor is three paired months — two
    // points correlate at exactly ±1, which is arithmetic rather than evidence.
    const chirps = yearOf({ region: 'Juba', source: 'chirps', year: 2024, totals: [62, 90, 141] })
    const era5 = yearOf({ region: 'Juba', source: 'open_meteo_archive', year: 2024, totals: [77, 84, 150] })
    const { res } = await call({ data: { climate_observations: [...chirps, ...era5] } })
    const row = res.json().data[0]
    assert.equal(row.coverage.chirps.months, 3)
    assert.equal(row.coverage.chirps.reported_days, 31 + 29 + 31, 'every day was read')
    assert.equal(row.report.comparisons[0].paired_months, 3, 'and the month is the unit')
  })
})

describe('ENH-09 — a refusal is a 200 with a reason, never a 4xx', () => {
  it('reports a region with one product as unavailable, and says why', async () => {
    // The case the whole `refused` count exists for. An empty comparison list
    // with no reason reads as "these products agree"; it means "there was only
    // one to compare".
    const { res } = await call({
      data: { climate_observations: monthTotal({ region: 'Bor', source: 'chirps', year: 2024, month: 6, total: 120 }) },
    })
    assert.equal(res.status, 200, 'a refusal is an answer, not a client error')
    const body = res.json()
    assert.equal(body.regions, 1)
    assert.equal(body.refused, 1)
    const [row] = body.data
    assert.equal(row.report.periods_compared, 0)
    assert.deepEqual(row.products_present, ['chirps'])
    assert.ok(row.refusal_reason.includes('only one comparable rainfall product'), 'the refusal names the cause')
    assert.ok(row.refusal_reason.includes('chirps'), 'and names the product that is present')
  })

  it('reports two products that share no month as unavailable, with the other reason', async () => {
    const chirps = monthTotal({ region: 'Moroto', source: 'chirps', year: 2023, month: 6, total: 120 })
    const era5 = monthTotal({ region: 'Moroto', source: 'open_meteo_archive', year: 2024, month: 6, total: 120 })
    const { res } = await call({ data: { climate_observations: [...chirps, ...era5] } })
    const body = res.json()
    assert.equal(body.refused, 1)
    const [row] = body.data
    assert.equal(row.report.periods_compared, 0, 'two different years are two unavailable periods')
    assert.ok(row.refusal_reason.includes('share no month'), 'the reason is the coverage gap, not a missing product')
    // And the two years are still both in the verdict tally, so a region where
    // nothing was comparable does not read as healthy.
    assert.equal(row.verdicts.unavailable, 2)
  })

  it('reports two flat products as unavailable rather than a correlation of zero', async () => {
    // A constant series carries no ordering information, so a correlation of 0
    // would be read as "these products are unrelated" when it means "one is
    // flat". The engine refuses; the route must not turn that into a number.
    //
    // Note the two sides are flat at *different* levels, which is the sharpest
    // form: a mean absolute difference of 9 mm is well inside the threshold, so
    // a route that let a missing correlation default to zero would certify two
    // products `agree` off a comparison with no ordering information in it.
    const chirps = yearOf({ region: 'Wajir', source: 'chirps', year: 2024, totals: [50, 50, 50] })
    const era5 = yearOf({ region: 'Wajir', source: 'open_meteo_archive', year: 2024, totals: [59, 59, 59] })
    const { res } = await call({ data: { climate_observations: [...chirps, ...era5] } })
    const row = res.json().data[0]
    assert.equal(row.report.periods_compared, 0, 'no verdict is available')
    assert.equal(row.report.any_disputed, null, 'and nothing was found, which is not the same as nothing wrong')
    assert.equal(row.report.comparisons.length, 0)
    assert.ok(row.refusal_reason.includes('share no month') || row.refusal_reason.includes('flat') || row.refusal_reason,
      'a refused region always carries a reason')
  })

  it('counts a month too thinly reported rather than scaling it up', async () => {
    // Three days of a thirty-one day month is a tenth of the true total. Scaled,
    // it invents rainfall; used as-is, it manufactures disagreement out of a
    // coverage gap. It is dropped, and the drop is stated.
    const thin = thinMonth({ region: 'Marsabit', source: 'chirps', year: 2024, month: 7, values: [5, 5, 5] })
    const { res } = await call({ data: { climate_observations: thin } })
    const row = res.json().data[0]
    assert.equal(row.coverage.chirps.months, 0, 'a tenth of a month is not a monthly total')
    assert.deepEqual(row.coverage.chirps.thin_months, ['2024-07'])
    assert.ok(MIN_MONTH_COVERAGE > 0.1)
  })
})

describe('ENH-09 — the pairing is on the period, not on array position', () => {
  it('gives the same verdict when one side arrives in a different order', async () => {
    // The canary. Zipping by index compares March against April and returns a
    // real number describing a relationship between the wrong two things — and
    // a sign-inverted correlation hands a downstream score `disputed` as
    // grounds to distrust a product that agreed perfectly.
    const chirps = yearOf({ region: 'Turkana', source: 'chirps', year: 2024, totals: [31, 84, 186] })
    const era5 = yearOf({ region: 'Turkana', source: 'open_meteo_archive', year: 2024, totals: [34, 79, 192] })

    const ordered = sourceAgreement({ climate_observations: [...chirps, ...era5] })
    // Reversed within each source: the same records, in the order a store that
    // merged two ingestion runs would hand them over.
    const shuffled = sourceAgreement({ climate_observations: [...era5.reverse(), ...chirps.reverse()] })

    const a = ordered.data[0].report.comparisons[0]
    const b = shuffled.data[0].report.comparisons[0]
    assert.equal(b.verdict, a.verdict, 'the verdict moved when the input order did, so the pairing is positional')
    assert.equal(b.paired_months, a.paired_months)
    assert.equal(b.rank_correlation, a.rank_correlation)
    assert.equal(b.mean_absolute_difference, a.mean_absolute_difference)
  })

  it('drops a month one product did not report rather than shifting the rest', async () => {
    // A one-sided hole. Pairing by index would compare February against March
    // for every month after the hole — and the correlation that came out would
    // describe a relationship between two months that were never the same month.
    const chirps = yearOf({ region: 'Turkana', source: 'chirps', year: 2024, totals: [31, 59, 93, 120] })
    const era5 = monthsOf({
      region: 'Turkana', source: 'open_meteo_archive', year: 2024,
      months: [{ month: 1, total: 33 }, { month: 3, total: 91 }, { month: 4, total: 118 }],
    })
    const report = sourceAgreement({ climate_observations: [...chirps, ...era5] }).data[0].report
    const [comparison] = report.comparisons
    assert.equal(comparison.paired_months, 3, 'February was not paired against March')
    assert.equal(comparison.unmatched_months, 1, 'and the dropped month is part of the answer')
    assert.deepEqual(comparison.only_in_a, ['2024-02'])
    assert.equal(comparison.verdict, 'agree')
  })
})

describe('ENH-09 — a source that is not a rainfall product is named, not silently dropped', () => {
  it('refuses to compare a forecast against an observation, and says why', () => {
    // `open_meteo` writes `precipitation_forecast` records into the same
    // collection. Comparing it against CHIRPS measures forecast skill, which is
    // a different question with a different answer — and publishing it as
    // source disagreement would be a confident wrong answer.
    const payload = sourceAgreement({
      climate_observations: [
        ...monthTotal({ region: 'Turkana', source: 'chirps', year: 2024, month: 1, total: 62 }),
        ...monthTotal({ region: 'Turkana', source: 'open_meteo', year: 2024, month: 1, total: 279 }),
      ],
    })
    assert.deepEqual(payload.data[0].products_present, ['chirps'])
    assert.equal(payload.refused, 1, 'the forecast did not become a comparison')
    const ignored = payload.sources_ignored.find((entry) => entry.source === 'open_meteo')
    assert.ok(ignored, 'the skipped source is absent from the payload entirely')
    assert.ok(ignored.reason.includes('forecast'), 'and the reason says what it is instead')
    assert.equal(ignored.records, 31)
  })

  it('names an undeclared source as needing a decision', () => {
    const payload = sourceAgreement({
      climate_observations: monthTotal({ region: 'Turkana', source: 'some_new_source', year: 2024, month: 1, total: 62 }),
    })
    const ignored = payload.sources_ignored.find((entry) => entry.source === 'some_new_source')
    assert.ok(ignored.reason.includes('not declared'), 'an unknown source asks for a decision rather than assuming one')
  })

  it('publishes the declarations and the thresholds in the payload', () => {
    // A threshold a reader cannot see is one they cannot argue with, and this
    // module's entire output is the verdict its thresholds produce.
    const payload = sourceAgreement({ climate_observations: [] })
    assert.deepEqual(payload.products, PRODUCT_SOURCES)
    assert.ok(payload.thresholds.minPairedMonths >= 3, 'two points correlate at exactly ±1')
    assert.equal(payload.min_month_coverage, MIN_MONTH_COVERAGE)
    assert.ok(Array.isArray(payload.comparable_products))
  })

  it('counts a comparable product with no region rather than placing it', () => {
    // Attributing a point reading to a district by proximity is how a
    // measurement becomes a claim about ground it never covered.
    const payload = sourceAgreement({
      climate_observations: [{
        id: 'x', source: 'chirps', type: 'rainfall_observation', region_name: null,
        observed_at: '2024-01-01', precipitation_mm: 3,
      }],
    })
    assert.equal(payload.regions, 0)
    assert.equal(payload.unattributed_records, 1)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeFacilitiesAtRisk, computePopulationAtRisk } from '../src/analytics/impact.js'
import { districtOverview } from '../src/districts.js'
import { detectDispatchPrecisionBreaches, equityByDistrict } from '../src/equity.js'
import { responseMetrics } from '../src/rapidpro.js'
import { computeDataQuality } from '../src/analytics.js'

// Turkana centre. 0.1 degrees of latitude is about 11 km, so the offsets below
// are comfortably inside or outside the 25 km impact radius without depending
// on a fixture's precision.
const TURKANA = { lat: 3.1167, lon: 35.6 }

const hazard = (id, latOffset, severity) => ({
  id,
  event_type: 'flood',
  severity,
  latitude: TURKANA.lat + latOffset,
  longitude: TURKANA.lon,
})

const asset = (id, latOffset, extra = {}) => ({
  id,
  name: `Asset ${id}`,
  service_type: 'health',
  population_served: 500,
  latitude: TURKANA.lat + latOffset,
  longitude: TURKANA.lon,
  ...extra,
})

describe('facilities at risk counts facilities, not facility-hazard pairs', () => {
  it('counts one asset once when three hazards are in range', () => {
    // The regression: hazards outside, assets inside, no dedup. A clinic 20 km
    // from three separate flood events was reported three times.
    const data = {
      hazard_events: [
        hazard('h1', 0, 'critical'),
        hazard('h2', 0.01, 'high'),
        hazard('h3', 0.05, 'medium'),
      ],
      service_assets: [asset('a1', 0)],
    }

    const rows = computeFacilitiesAtRisk(data)
    assert.equal(rows.length, 1)

    const health = rows.find((r) => r.service_type === 'health')
    assert.equal(health.at_risk_count, 1, 'one building is one facility at risk')
    assert.equal(health.assets.length, 1)

    const record = health.assets[0]
    assert.equal(record.hazard_count, 3, 'the per-hazard information survives')
    assert.equal(record.high_severity_hazard_count, 2)
    assert.equal(record.worst_hazard_severity, 'critical')
    assert.equal(health.max_hazards_per_asset, 3)
  })

  it('treats an asset near one high and one low hazard as high severity at risk, counted once', () => {
    const data = {
      hazard_events: [hazard('h1', 0, 'high'), hazard('h2', 0.02, 'low')],
      service_assets: [asset('a1', 0)],
    }

    const [health] = computeFacilitiesAtRisk(data)
    assert.equal(health.at_risk_count, 1)
    assert.equal(health.high_severity_count, 1, 'within range of at least one high hazard')
    assert.equal(health.assets[0].hazard_count, 2)
    assert.equal(health.assets[0].high_severity_hazard_count, 1)
    assert.equal(health.assets[0].worst_hazard_severity, 'high')
  })

  it('does not multiply total_population_served by the number of nearby hazards', () => {
    const data = {
      hazard_events: [hazard('h1', 0, 'high'), hazard('h2', 0.01, 'medium'), hazard('h3', 0.02, 'low')],
      service_assets: [
        asset('a1', 0, { population_served: 500 }),
        asset('a2', 0.01, { population_served: 300 }),
      ],
    }

    const [health] = computeFacilitiesAtRisk(data)
    assert.equal(health.at_risk_count, 2)
    assert.equal(health.total_population_served, 800, '500 + 300, each counted once')
    assert.equal(health.high_severity_count, 2)
    assert.equal(health.high_severity_population_served, 800)
  })

  it('excludes an asset beyond 25 km of every hazard entirely', () => {
    const data = {
      hazard_events: [hazard('h1', 0, 'high'), hazard('h2', 0.01, 'medium')],
      service_assets: [asset('far', 0.5, { service_type: 'water' })],
    }

    const rows = computeFacilitiesAtRisk(data)
    assert.deepEqual(rows, [], 'no service type entry is created for an unexposed asset')
    assert.equal(rows.filter((r) => r.service_type === 'water').length, 0)
  })

  it('counts a duplicate store record once', () => {
    const data = {
      hazard_events: [hazard('h1', 0, 'high')],
      service_assets: [asset('a1', 0, { population_served: 500 }), asset('a1', 0, { population_served: 500 })],
    }

    const [health] = computeFacilitiesAtRisk(data)
    assert.equal(health.at_risk_count, 1)
    assert.equal(health.total_population_served, 500)
  })

  it('treats population_served 0 as an answer, not a missing value', () => {
    const data = {
      hazard_events: [hazard('h1', 0, 'high')],
      service_assets: [asset('a1', 0, { population_served: 0, beneficiaries: 900 })],
    }

    const [health] = computeFacilitiesAtRisk(data)
    assert.equal(health.at_risk_count, 1)
    assert.equal(health.total_population_served, 0)
  })

  it('skips hazards and assets without usable coordinates', () => {
    const data = {
      hazard_events: [
        { id: 'h1', event_type: 'flood', severity: 'high' },
        hazard('h2', 0, 'high'),
      ],
      service_assets: [
        { id: 'a1', service_type: 'health', population_served: 100 },
        asset('a2', 0),
      ],
    }

    const [health] = computeFacilitiesAtRisk(data)
    assert.equal(health.at_risk_count, 1)
    assert.equal(health.assets[0].id, 'a2')
  })

  it('population at risk stays keyed per hazard, so one hazard counts each asset once', () => {
    const data = {
      hazard_events: [hazard('h1', 0, 'high'), hazard('h2', 0.01, 'medium')],
      service_assets: [
        asset('a1', 0, { population_served: 500 }),
        asset('a2', 0.005, { population_served: 300 }),
        asset('a3', 0.3, { population_served: 100 }),
      ],
    }

    const rows = computePopulationAtRisk(data)
    assert.equal(rows.length, 2, 'one row per hazard, each with its own exposed population')

    const perHazard = rows.map((r) => r.population_at_risk).sort((x, y) => x - y)
    assert.deepEqual(perHazard, [800, 800], 'both hazards see the same two assets, 500 + 300')

    for (const row of rows) {
      assert.equal(row.service_assets_affected, 2)
      assert.equal(row.facilities.length, 2)
    }
  })
})

describe('district overview reports totals, not the size of its sample', () => {
  const fieldReport = (i) => ({
    id: `fr-${i}`,
    district: 'Turkana',
    summary: `report ${i}`,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
  })

  const alertEvent = (i, note) => ({
    id: `ae-${i}`,
    scope: { district: 'Turkana' },
    severity: 'medium',
    status: note ? 'resolved' : 'open',
    resolution_note: note,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
  })

  it('separates the true total from the 30 rows it returns', () => {
    const data = {
      field_reports: Array.from({ length: 45 }, (_, i) => fieldReport(i)),
      alert_events: Array.from({ length: 12 }, (_, i) => alertEvent(i, i < 2 ? 'false alarm' : null)),
    }

    const overview = districtOverview(data, 'turkana')

    assert.equal(overview.counts.field_reports, 45, 'the count is the total, not the window')
    assert.equal(overview.field_reports.length, 30)
    assert.equal(overview.samples.field_reports.total, 45)
    assert.equal(overview.samples.field_reports.returned, 30)
    assert.equal(overview.samples.field_reports.limit, 30)
    assert.equal(overview.samples.field_reports.truncated, true)

    assert.equal(overview.counts.alert_events, 12)
    assert.equal(overview.alert_events.length, 12)
    assert.equal(overview.samples.alert_events.truncated, false)
  })

  it('returns the most recent records, not the first thirty inserted', () => {
    const data = {
      field_reports: Array.from({ length: 45 }, (_, i) => fieldReport(i)),
      alert_events: [],
    }

    const overview = districtOverview(data, 'turkana')
    assert.equal(overview.field_reports[0].id, 'fr-44', 'newest first')
    assert.equal(overview.field_reports[29].id, 'fr-15')
  })

  it('computes false_alert_rate over every determined alert in the district', () => {
    // The assertion this test used to make was "4 false of 40, not 4 of
    // whatever the window happened to hold" — correct about the window, wrong
    // about the denominator. 40 alerts of which 36 nobody ever reviewed is not
    // "4 false out of 40"; it is 4 false out of 4 determined, which is four
    // records and below the floor of 30. The window question and the
    // denominator question are separate, and this test was half right.
    const data = {
      field_reports: [],
      alert_events: Array.from({ length: 40 }, (_, i) => ({
        ...alertEvent(i, i < 4 ? 'faulty sensor' : 'situation stabilised'),
        false_alert: i < 4 ? true : false,
      })),
    }

    const overview = districtOverview(data, 'turkana')
    assert.equal(overview.counts.alert_events, 40)
    assert.equal(overview.alert_events.length, 30)
    assert.equal(overview.kpi_snapshot.false_alert_rate, 10, '4 false of 40 determined')
    assert.equal(overview.kpi_snapshot.false_alert_determined, 40)
  })

  it('does not let a keyword-free resolution note hide a confirmed false alert', () => {
    // The Mandera case. The note reads "Reading traced to a faulty sensor" —
    // no `false`, no `invalid`, no `noop` — so the keyword scan this surface
    // used to run scored the district 0% for the one district where a false
    // alert was confirmed.
    const alerts = Array.from({ length: 40 }, (_, i) => ({
      ...alertEvent(i, i === 0 ? 'Reading traced to a faulty sensor' : 'Situation stabilised'),
      false_alert: i === 0,
    }))
    const overview = districtOverview({ field_reports: [], alert_events: alerts }, 'mandera')
    assert.equal(overview.kpi_snapshot.false_alert_rate, 2.5,
      '1 confirmed false alert of 40 determined is 2.5%, not 0%')
  })

  it('does not truncate a district that fits inside the limit', () => {
    const data = {
      field_reports: Array.from({ length: 3 }, (_, i) => fieldReport(i)),
      alert_events: [],
    }

    const overview = districtOverview(data, 'turkana')
    assert.equal(overview.counts.field_reports, 3)
    assert.equal(overview.field_reports.length, 3)
    assert.equal(overview.samples.field_reports.truncated, false)
  })

  it('leaves records without a timestamp at the end of the sample, in store order', () => {
    const data = {
      field_reports: [
        { id: 'undated-1', district: 'Turkana' },
        fieldReport(1),
        { id: 'undated-2', district: 'Turkana' },
      ],
      alert_events: [],
    }

    const overview = districtOverview(data, 'turkana')
    assert.deepEqual(
      overview.field_reports.map((r) => r.id),
      ['fr-1', 'undated-1', 'undated-2']
    )
    assert.equal(overview.counts.field_reports, 3)
  })
})

describe('equity precision divides by the population it subtracted from', () => {
  // The `false_alert` field is what these tests used to *infer* from the note
  // text. They now set it, because inference from a note is what made two
  // surfaces blind to the confirmed Mandera alert: its note reads "Reading
  // traced to a faulty sensor" and contains none of the three keywords the old
  // scan looked for. `note` is kept because `false_alert_rate` and the
  // determination field are separate, and a test that only set one of them
  // would not notice if the implementation started reading the other.
  const alert = (id, district, status, note, dispatched = true, falseAlert = undefined) => ({
    id,
    scope: { district },
    severity: 'high',
    status,
    resolution_note: note,
    false_alert: falseAlert,
    _dispatched: dispatched,
  })

  const pack = (alerts) => ({
    alert_events: alerts.map(({ _dispatched, ...rest }) => rest),
    rapidpro_dispatches: alerts
      .filter((a) => a._dispatched)
      .map((a) => ({ id: `d-${a.id}`, alert_event_id: a.id })),
  })

  it('matches a hand-computed precision, sample size included', () => {
    // Turkana: dispatched and determined = a1, a2, a5, a6, a7 (five), of which
    // a2 is recorded false; a3 is dispatched but undetermined; a4 was resolved
    // and recorded false but never dispatched, so it is outside both the
    // numerator and the denominator.
    //
    // Five rather than the three this test used to use: the sample floor is 5,
    // and a precision computed from three records is exactly the n=1 problem
    // one layer down. The arithmetic is unchanged — 4 of 5 warranted, 80% — and
    // the test still fails if the populations drift apart.
    const data = pack([
      alert('a1', 'Turkana', 'resolved', 'flood confirmed', true, false),
      alert('a2', 'Turkana', 'resolved', 'no flood, invalid report', true, true),
      alert('a3', 'Turkana', 'open', null, true, null),
      alert('a4', 'Turkana', 'resolved', 'false alarm', false, true),
      alert('a5', 'Turkana', 'resolved', 'flood confirmed', true, false),
      alert('a6', 'Turkana', 'resolved', 'flood confirmed', true, false),
      alert('a7', 'Turkana', 'resolved', 'flood confirmed', true, false),
    ])

    const [turkana] = equityByDistrict(data)

    assert.equal(turkana.dispatched, 6)
    assert.equal(turkana.determined_dispatched, 5)
    assert.equal(turkana.determined_false_positive, 1)
    assert.equal(turkana.acknowledged, 6)
    assert.equal(turkana.dispatch_precision_pct, 80, '4 of 5 determined dispatches were right')

    // The old formula divided every dispatch (4) by a numerator that also
    // subtracted an alert that was never dispatched, and returned 50.
    assert.equal(turkana.accuracy_pct, turkana.dispatch_precision_pct, 'legacy key aliases the named metric')
    assert.ok(
      turkana.data_gaps.some((g) => g.includes('accuracy_pct')),
      'the payload says the legacy name is not to be trusted'
    )
  })

  it('returns null when nothing in the district has an outcome yet', () => {
    // Every dispatch is still open. The old formula reported 100% — a perfect
    // score for a district that knows nothing.
    const data = pack([
      alert('a1', 'Turkana', 'open', null),
      alert('a2', 'Turkana', 'open', null),
    ])

    const [turkana] = equityByDistrict(data)
    assert.equal(turkana.dispatched, 2)
    assert.equal(turkana.determined_dispatched, 0)
    assert.equal(turkana.dispatch_precision_pct, null)
  })

  it('does not report a precision derived from a single record as a district figure', () => {
    const data = pack([
      alert('a1', 'Turkana', 'resolved', 'false alarm', true, true),
      alert('a2', 'Turkana', 'open', null),
      alert('a3', 'Turkana', 'open', null),
      alert('a4', 'Turkana', 'open', null),
      alert('a5', 'Turkana', 'open', null),
      alert('a6', 'Turkana', 'open', null),
    ])

    const [turkana] = equityByDistrict(data)
    // This used to assert `0` — "1 determined record, and it was false". A 0%
    // precision published from a single record is the sample-floor defect
    // R-93, in the direction that reads as a finding: the district's dispatch
    // quality is not measured, and one bad alert does not measure it.
    assert.equal(turkana.dispatch_precision_pct, null)
    assert.match(turkana.dispatch_precision_refusal, /not a precision/)
    assert.deepEqual(detectDispatchPrecisionBreaches(data), [], 'below the minimum sample')
  })

  it('breaches on the hand-computed value once the sample is large enough', () => {
    // 10 dispatched and determined, 3 recorded false: 7 of 10 = 70%, under 80.
    const alerts = Array.from({ length: 10 }, (_, i) =>
      alert(`a${i}`, 'Turkana', 'resolved', i < 3 ? 'invalid, no flood' : 'flood confirmed', true, i < 3)
    )
    alerts.push(alert('x1', 'Turkana', 'resolved', 'false alarm', false, true))
    const data = pack(alerts)

    const [turkana] = equityByDistrict(data)
    assert.equal(turkana.false_positive, 4, 'four alerts carry a false-positive note')
    assert.equal(turkana.determined_dispatched, 10)
    assert.equal(turkana.determined_false_positive, 3)
    assert.equal(turkana.dispatch_precision_pct, 70)

    const breaches = detectDispatchPrecisionBreaches(data)
    assert.equal(breaches.length, 1)
    assert.equal(breaches[0].district, 'Turkana')
    assert.equal(breaches[0].dispatch_precision_pct, 70)
    assert.equal(breaches[0].determined_dispatched, 10)
  })

  it('refuses to report a response rate when replies cannot be matched to people', () => {
    // One dispatch, two inbound messages, and no sender identity anywhere.
    // This used to report response_rate_pct: 200 — a percentage above 100,
    // because it was counting messages per dispatch. There is no rate here to
    // report, so it says so rather than producing one.
    const data = {
      rapidpro_dispatches: [{ id: 'd1', alert_event_id: 'ae-1', created_at: '2026-01-01T10:00:00.000Z' }],
      rapidpro_inbound_messages: [
        { id: 'm1', alert_event_id: 'ae-1', created_at: '2026-01-01T10:05:00.000Z' },
        { id: 'm2', alert_event_id: 'ae-1', created_at: '2026-01-01T10:06:00.000Z' },
      ],
    }

    const [metrics] = responseMetrics(data)
    assert.equal(metrics.dispatched_count, 1)
    assert.equal(metrics.response_count, 2, 'the message count is still reported, it is just not a rate')
    assert.equal(metrics.response_rate_pct, null)
    assert.match(metrics.response_rate_note, /not a rate/)
    assert.equal(metrics.mean_response_seconds, 300)

    // ...while the equity metric above measures dispatch precision. Two names,
    // two denominators, neither presented as the other. The precision figure
    // needs five determined dispatches before it says anything; one is not a
    // district quality figure in either direction.
    const equity = equityByDistrict({
      alert_events: [
        { id: 'ae-1', scope: { district: 'Turkana' }, status: 'resolved', false_alert: false, resolution_note: 'flood confirmed' },
      ],
      rapidpro_dispatches: [{ id: 'd1', alert_event_id: 'ae-1' }],
    })
    // One determined dispatch is below the floor of 5, so this is null rather
    // than a confident 100% — the same n=1 problem the response-rate refusal
    // above is about, on the other metric.
    assert.equal(equity[0].dispatch_precision_pct, null)
    // Neither metric has a rate, and they are two different quantities that
    // happen to both be unmeasurable here. That they coincide must be a
    // coincidence of the fixture, not the reason they share a value: the
    // denominators differ (inbound messages per dispatch, versus determined
    // dispatches), which is exactly why neither may be substituted for the
    // other by a consumer who has one and not the other.
    assert.match(equity[0].dispatch_precision_refusal, /not a precision/)
    assert.match(metrics.response_rate_note, /not a rate/)
  })
})

/**
 * A mean over a set nothing was ever added to.
 *
 * `computeDataQuality` initialised `confidence_sum: 0` on each source, read it
 * to produce `mean_confidence`, and never incremented it anywhere. The divisor
 * was `total_records`, so the result was `0 / n` — a confident 0 for every
 * source in the platform, including sources whose model produced perfectly good
 * confidences. It read as a measurement: a data-quality panel showing "mean
 * confidence 0%" next to a source with 4,000 records and a healthy run.
 *
 * The shape of the bug is the one this file collects: a field that looks like an
 * accumulator, is shaped like one, and is wired at both ends — except the
 * middle.
 */
describe('source data quality reports a confidence it can support', () => {
  const sourceRun = (source, status = 'success') => ({
    id: `run-${source}`, source, status, completed_at: new Date().toISOString(), errors: [],
  })

  const observations = (over = {}) => ([{
    id: 'obs-1', source: 'open_meteo', latitude: 3.1, longitude: 35.6, country: 'KE',
    observed_at: new Date().toISOString(), confidence: 0.82, ...over,
  }])

  it('averages the confidences that exist', () => {
    const quality = computeDataQuality({
      climate_observations: [
        ...observations(),
        { ...observations()[0], id: 'obs-2', confidence: 0.78 },
      ],
      source_runs: [sourceRun('open_meteo')],
    })
    const openMeteo = quality.find((item) => item.source === 'open_meteo')
    assert.equal(openMeteo.mean_confidence, 0.8, '0.82 and 0.78 average to 0.80')
    assert.equal(openMeteo.mean_confidence_pct, 80, 'and readable on the scale of its siblings')
  })

  it('reports nothing rather than zero when no record carries a confidence', () => {
    // Raw source rows have no model confidence. Counting their absence as zero
    // would drag the mean down for a source whose model simply did not run in
    // this pass — and 0% confidence reads as "we measured and it was terrible".
    const quality = computeDataQuality({
      climate_observations: [{ ...observations()[0], confidence: undefined }],
      source_runs: [sourceRun('open_meteo')],
    })
    const openMeteo = quality.find((item) => item.source === 'open_meteo')
    assert.equal(openMeteo.mean_confidence, null)
    assert.equal(openMeteo.mean_confidence_pct, null, 'no mean is not a mean of zero, on either scale')
    assert.equal(openMeteo.total_records, 1, 'the record still counts toward coverage')
  })

  it('excludes unconfident rows from the mean without excluding them from the count', () => {
    // The two populations are different: a source can hold many raw rows and a
    // few modelled ones. Averaging over all of them would understate the model.
    const quality = computeDataQuality({
      climate_observations: [
        ...observations(),
        { ...observations()[0], id: 'obs-2', confidence: 0.78 },
        { ...observations()[0], id: 'obs-3', confidence: undefined },
        { ...observations()[0], id: 'obs-4', confidence: undefined },
      ],
      source_runs: [sourceRun('open_meteo')],
    })
    const openMeteo = quality.find((item) => item.source === 'open_meteo')
    assert.equal(openMeteo.total_records, 4)
    assert.equal(openMeteo.mean_confidence, 0.8, 'the mean is over the two rows that have one')
  })

  it('carries a count a reader can check the mean against', () => {
    // The mean is unreadable without knowing what it was taken over: 0.8 over
    // four records and 0.8 over one are different statements, and the payload
    // has to let a reader tell them apart.
    const quality = computeDataQuality({
      climate_observations: [
        ...observations(),
        { ...observations()[0], id: 'obs-2', confidence: undefined },
        { ...observations()[0], id: 'obs-3', confidence: undefined },
      ],
      source_runs: [sourceRun('open_meteo')],
    })
    const openMeteo = quality.find((item) => item.source === 'open_meteo')
    assert.equal(openMeteo.total_records, 3)
    assert.equal(openMeteo.confidence_count, 1, 'one modelled row, two raw ones')
    assert.equal(openMeteo.confidence_sum, 0.82, 'the sum is over that same row')
    assert.equal(openMeteo.mean_confidence, 0.82)
  })
})

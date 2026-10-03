import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeFacilitiesAtRisk, computePopulationAtRisk } from '../src/analytics/impact.js'
import { districtOverview } from '../src/districts.js'
import { detectDispatchPrecisionBreaches, equityByDistrict } from '../src/equity.js'
import { responseMetrics } from '../src/rapidpro.js'

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

  it('computes false_alert_rate over every alert in the district', () => {
    const data = {
      field_reports: [],
      alert_events: Array.from({ length: 40 }, (_, i) => alertEvent(i, i < 4 ? 'false alarm' : null)),
    }

    const overview = districtOverview(data, 'turkana')
    assert.equal(overview.counts.alert_events, 40)
    assert.equal(overview.alert_events.length, 30)
    assert.equal(
      overview.kpi_snapshot.false_alert_rate,
      (100 * 4) / 40,
      '4 false of 40, not 4 of whatever the window happened to hold'
    )
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
  const alert = (id, district, status, note, dispatched = true) => ({
    id,
    scope: { district },
    severity: 'high',
    status,
    resolution_note: note,
    _dispatched: dispatched,
  })

  const pack = (alerts) => ({
    alert_events: alerts.map(({ _dispatched, ...rest }) => rest),
    rapidpro_dispatches: alerts
      .filter((a) => a._dispatched)
      .map((a) => ({ id: `d-${a.id}`, alert_event_id: a.id })),
  })

  it('matches a hand-computed precision, sample size included', () => {
    // Turkana: 4 dispatched (a1 confirmed, a2 invalid, a3 still open, a5
    // confirmed), 1 resolved alert that was never dispatched and is flagged
    // false. Determined sample = a1, a2, a5 = 3, of which 1 is false.
    const data = pack([
      alert('a1', 'Turkana', 'resolved', 'flood confirmed'),
      alert('a2', 'Turkana', 'resolved', 'no flood, invalid report'),
      alert('a3', 'Turkana', 'open', null),
      alert('a4', 'Turkana', 'resolved', 'false alarm', false),
      alert('a5', 'Turkana', 'resolved', 'flood confirmed'),
    ])

    const [turkana] = equityByDistrict(data)

    assert.equal(turkana.dispatched, 4)
    assert.equal(turkana.determined_dispatched, 3)
    assert.equal(turkana.determined_false_positive, 1)
    assert.equal(turkana.acknowledged, 4)
    assert.equal(turkana.dispatch_precision_pct, 66.67, '2 of 3 determined dispatches were right')

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
      alert('a1', 'Turkana', 'resolved', 'false alarm'),
      alert('a2', 'Turkana', 'open', null),
      alert('a3', 'Turkana', 'open', null),
      alert('a4', 'Turkana', 'open', null),
      alert('a5', 'Turkana', 'open', null),
      alert('a6', 'Turkana', 'open', null),
    ])

    const [turkana] = equityByDistrict(data)
    assert.equal(turkana.dispatch_precision_pct, 0, '1 determined record, and it was false')
    assert.deepEqual(detectDispatchPrecisionBreaches(data), [], 'below the minimum sample')
  })

  it('breaches on the hand-computed value once the sample is large enough', () => {
    // 10 dispatched and resolved, 3 flagged false: 7 of 10 = 70%, under 80.
    const alerts = Array.from({ length: 10 }, (_, i) =>
      alert(`a${i}`, 'Turkana', 'resolved', i < 3 ? 'invalid, no flood' : 'flood confirmed')
    )
    alerts.push(alert('x1', 'Turkana', 'resolved', 'false alarm', false))
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
    // two denominators, neither presented as the other.
    const equity = equityByDistrict({
      alert_events: [
        { id: 'ae-1', scope: { district: 'Turkana' }, status: 'resolved', resolution_note: 'flood confirmed' },
      ],
      rapidpro_dispatches: [{ id: 'd1', alert_event_id: 'ae-1' }],
    })
    assert.equal(equity[0].dispatch_precision_pct, 100)
    assert.notEqual(metrics.response_rate_pct, equity[0].dispatch_precision_pct)
  })
})
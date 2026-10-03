import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { districtOverview } from '../src/districts.js'
import { equityByDistrict } from '../src/equity.js'

// DATA-05 and DATA-07. Both are the same underlying mistake wearing two
// costumes: a district rate computed over a set that is not the set the rate is
// about, and an absence of measurement rendered as a measurement.
//
// The sample fixtures below are deliberately lopsided. The alerts an operator
// sees on the page are the newest thirty, so a truncation bug and a correct
// implementation produce visibly different numbers rather than the same number
// by luck: the eight false alarms are spread so the newest-30 window holds
// four of them, not eight.

const DISTRICT = 'Turkana'

const fieldReport = (i) => ({
  id: `fr-${i}`,
  district: DISTRICT,
  summary: `report ${i}`,
  created_at: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(),
})

/**
 * @param i        insertion index; older index means newer timestamp below
 * @param outcome  null = never resolved, otherwise a resolution note
 */
const alertEvent = (i, outcome) => ({
  id: `ae-${i}`,
  scope: { district: DISTRICT },
  severity: 'medium',
  status: outcome ? 'resolved' : 'open',
  resolution_note: outcome,
  created_at: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(),
})

const turkanaRow = (data) => equityByDistrict(data).find((r) => r.district === DISTRICT)

describe('DATA-05 — a district rate is computed over the district, not over the 30 rows it returns', () => {
  it('divides by every alert the district has, not by the window it ships', () => {
    // 40 alerts; the eight false alarms sit at indices 2,3,6,7,18,19,26,27, so
    // the newest thirty (indices 10..39) hold four of them. A denominator of 30
    // would report 13.3% — a rate about the truncation.
    const data = {
      field_reports: [],
      alert_events: Array.from({ length: 40 }, (_, i) =>
        alertEvent(i, [2, 3, 6, 7, 18, 19, 26, 27].includes(i) ? 'false alarm' : null)
      ),
    }

    const overview = districtOverview(data, 'turkana')

    assert.equal(overview.counts.alert_events, 40, 'the headline count is the district total')
    assert.equal(overview.alert_events.length, 30, 'the array is a bounded window')
    assert.equal(overview.samples.alert_events.total, 40)
    assert.equal(overview.samples.alert_events.returned, 30)
    assert.equal(overview.samples.alert_events.truncated, true)

    assert.equal(
      overview.kpi_snapshot.false_alert_rate,
      (100 * 8) / 40,
      'eight false of forty — not eight of thirty, and not four of thirty'
    )
    assert.equal(overview.kpi_snapshot.false_alert_determined, 8)
    assert.equal(overview.kpi_snapshot.false_alert_of_total, 40)
  })

  it('states the total for the field reports it truncates too', () => {
    const data = {
      field_reports: Array.from({ length: 45 }, (_, i) => fieldReport(i)),
      alert_events: [],
    }

    const overview = districtOverview(data, 'turkana')

    assert.equal(overview.counts.field_reports, 45)
    assert.equal(overview.field_reports.length, 30)
    assert.equal(overview.samples.field_reports.total, 45)
    assert.equal(overview.samples.field_reports.returned, 30)
    assert.equal(overview.samples.field_reports.limit, 30)
    assert.equal(overview.samples.field_reports.truncated, true)
  })

  it('agrees with the equity surface on the same data', () => {
    const data = {
      field_reports: [],
      alert_events: Array.from({ length: 40 }, (_, i) =>
        alertEvent(i, [2, 3, 6, 7, 18, 19, 26, 27].includes(i) ? 'false alarm' : null)
      ),
    }

    const overview = districtOverview(data, 'turkana')
    const row = turkanaRow(data)

    assert.equal(row.false_alert_rate, overview.kpi_snapshot.false_alert_rate)
    assert.equal(row.false_alert_determined, overview.kpi_snapshot.false_alert_determined)
    assert.equal(row.false_alert_of_total, overview.kpi_snapshot.false_alert_of_total)
  })
})

describe('DATA-07 — "not measured" is not "measured as zero"', () => {
  const unmeasured = () => ({
    field_reports: [],
    // 40 alerts, none of them ever resolved. Nothing is known about whether any
    // of them was a false alarm, so a rate here is a statement about the
    // absence of a keyword in free text, not about the district's accuracy.
    alert_events: Array.from({ length: 40 }, (_, i) => alertEvent(i, null)),
  })

  it('reports null, not 0%, when no alert outcome has been recorded', () => {
    const overview = districtOverview(unmeasured(), 'turkana')

    assert.equal(
      overview.kpi_snapshot.false_alert_rate,
      null,
      '40 alerts and zero recorded outcomes is an unknown, not a clean sheet'
    )
    assert.equal(overview.kpi_snapshot.false_alert_determined, 0)
    assert.equal(overview.kpi_snapshot.false_alert_of_total, 40)
  })

  it('says null on both surfaces for the same district', () => {
    const data = unmeasured()
    const overview = districtOverview(data, 'turkana')
    const row = turkanaRow(data)

    assert.equal(overview.kpi_snapshot.false_alert_rate, null)
    assert.equal(row.false_alert_rate, null, 'one district\'s honest unknown cannot be another\'s confident zero')
    assert.equal(row.false_alert_determined, 0)
  })

  it('still reports a real 0% when outcomes were reviewed and none were false', () => {
    // Ten alerts were resolved with a note. Ten outcomes looked at, none false.
    // That is a zero with a denominator, and it must survive the fix — a null
    // here would be its own kind of lie.
    const data = {
      field_reports: [],
      alert_events: Array.from({ length: 40 }, (_, i) =>
        alertEvent(i, i < 10 ? 'situation stabilised' : null)
      ),
    }

    const overview = districtOverview(data, 'turkana')

    assert.equal(overview.kpi_snapshot.false_alert_rate, 0, 'zero of ten, measured')
    assert.equal(overview.kpi_snapshot.false_alert_determined, 10)
    assert.equal(overview.kpi_snapshot.false_alert_of_total, 40)
    assert.equal(turkanaRow(data).false_alert_rate, 0, 'and the equity surface agrees it is zero, not null')
  })

  it('reports a district with no alerts at all as null on both surfaces', () => {
    const data = { field_reports: [], alert_events: [] }

    assert.equal(districtOverview(data, 'turkana').kpi_snapshot.false_alert_rate, null)
    assert.equal(turkanaRow(data), undefined)
  })
})
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decisionLatency } from '../src/decision-latency.js'

const raised = (id, at, severity = 'high') => ({ id, severity, created_at: at })
const decided = (alert_event_id, at, determination = 'justified') => ({
  id: `o-${alert_event_id}`,
  alert_event_id,
  determination,
  reason: determination === 'false' ? 'sensor_fault' : 'verified_on_ground',
  determined_by: 'ops-1',
  determined_at: at,
})

describe('time-to-decision instrumentation (ENH-73)', () => {
  it('measures the interval from an alert being raised to a determination being filed', () => {
    const result = decisionLatency({
      alert_events: [raised('a1', '2026-10-11T00:00:00Z')],
      alert_outcomes: [decided('a1', '2026-10-11T03:30:00Z')],
    })
    assert.equal(result.samples, 1)
    assert.equal(result.median_hours, 3.5)
    assert.equal(result.rows[0].measured, true)
    assert.equal(result.rows[0].determination, 'justified')
  })

  it('averages the two middle values at even length, rather than taking the upper', () => {
    // `sorted[Math.floor(n/2)]` returns 4 here and biased every even-length
    // median in this repository high until src/kpi.js:88 recorded it. The
    // correct answer for [2,4] is 3.
    const result = decisionLatency({
      alert_events: [raised('a1', '2026-10-11T00:00:00Z'), raised('a2', '2026-10-11T00:00:00Z')],
      alert_outcomes: [decided('a1', '2026-10-11T02:00:00Z'), decided('a2', '2026-10-11T04:00:00Z')],
    })
    assert.equal(result.median_hours, 3, 'the mean of 2 and 4, not the upper of the two')
  })

  it('does not fold an undetermined alert in as a zero', () => {
    // Zero would read as "decided instantly", the opposite of "nobody decided".
    // The undetermined count travels with the median because the median
    // describes a sample nobody chose.
    const result = decisionLatency({
      alert_events: [raised('a1', '2026-10-11T00:00:00Z'), raised('a2', '2026-10-11T00:00:00Z')],
      alert_outcomes: [decided('a1', '2026-10-11T02:00:00Z')],
    })
    assert.equal(result.samples, 1)
    assert.equal(result.undetermined, 1)
    assert.equal(result.rows.find((r) => r.alert_event_id === 'a2').decision_hours, null)
    assert.equal(result.rows.find((r) => r.alert_event_id === 'a2').excluded, 'undetermined')
  })

  it('excludes a determination timestamped before its alert, and counts it', () => {
    // A negative duration would drag the median down and read as a very fast
    // decision. It is a clock skew or a backdated record, and both are worth
    // seeing rather than averaging away.
    const result = decisionLatency({
      alert_events: [raised('a1', '2026-10-11T05:00:00Z')],
      alert_outcomes: [decided('a1', '2026-10-11T01:00:00Z')],
    })
    assert.equal(result.samples, 0)
    assert.equal(result.excluded_non_positive, 1)
    assert.equal(result.rows[0].excluded, 'determined_before_raised')
    assert.equal(result.median_hours, null)
  })

  it('returns null with a refusal rather than a substituted interval', () => {
    const result = decisionLatency({ alert_events: [raised('a1', '2026-10-11T00:00:00Z')], alert_outcomes: [] })
    assert.equal(result.median_hours, null)
    assert.match(result.refusal, /returns null rather than substituting a different interval/)
  })

  it('says what it is not comparable to', () => {
    const result = decisionLatency({ alert_events: [], alert_outcomes: [] })
    assert.match(result.limit, /not comparable to warning_to_action_median_hours/)
    assert.match(result.measure, /determination being filed/)
  })

  it('splits the median by the severity of what was decided', () => {
    const result = decisionLatency({
      alert_events: [
        raised('a1', '2026-10-11T00:00:00Z', 'critical'),
        raised('a2', '2026-10-11T00:00:00Z', 'critical'),
        raised('a3', '2026-10-11T00:00:00Z', 'low'),
      ],
      alert_outcomes: [
        decided('a1', '2026-10-11T01:00:00Z'),
        decided('a2', '2026-10-11T03:00:00Z'),
        decided('a3', '2026-10-11T09:00:00Z'),
      ],
    })
    assert.deepEqual(result.by_severity.critical, { median_hours: 2, samples: 2 })
    assert.deepEqual(result.by_severity.low, { median_hours: 9, samples: 1 })
  })

  it('returns the per-alert rows, so a median can be decomposed', () => {
    const result = decisionLatency({
      alert_events: [raised('a1', '2026-10-11T00:00:00Z')],
      alert_outcomes: [decided('a1', '2026-10-11T02:00:00Z')],
    })
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].raised_at, '2026-10-11T00:00:00Z')
    assert.equal(result.rows[0].determined_at, '2026-10-11T02:00:00Z')
  })

  it('honours an explicit alert subset rather than the whole store', () => {
    const data = {
      alert_events: [raised('a1', '2026-10-11T00:00:00Z'), raised('a2', '2026-10-11T00:00:00Z')],
      alert_outcomes: [decided('a1', '2026-10-11T02:00:00Z'), decided('a2', '2026-10-11T08:00:00Z')],
    }
    assert.equal(decisionLatency(data).median_hours, 5)
    assert.equal(decisionLatency(data, [data.alert_events[1]]).median_hours, 8)
  })

  it('uses the latest determination when an alert was decided more than once', () => {
    // A correction is a new record, not an overwrite (src/outcomes.js). The
    // interval that matters is to the determination that stands.
    const result = decisionLatency({
      alert_events: [raised('a1', '2026-10-11T00:00:00Z')],
      alert_outcomes: [
        { ...decided('a1', '2026-10-11T02:00:00Z'), id: 'o-first' },
        { ...decided('a1', '2026-10-11T06:00:00Z', 'false'), id: 'o-second' },
      ],
    })
    assert.equal(result.median_hours, 6)
    assert.equal(result.rows[0].determination, 'false')
  })
})

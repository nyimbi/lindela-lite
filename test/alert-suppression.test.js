import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateAlertRules, normalizeAlertRule } from '../src/alerts.js'
import { emptyStore } from '../src/schema.js'

/**
 * Suppression is a window, not a calendar bucket.
 *
 * The old implementation computed `Math.floor(Date.parse(now) / windowMs)` and
 * suppressed only when an existing alert carried the same bucket. That is a
 * grid anchored at the Unix epoch, so the bucket boundary has nothing to do
 * with when the previous alert was raised. Two evaluations two minutes apart
 * either side of a boundary fall in different buckets, and both raise: an
 * operator who asked for a 120-minute suppression gets two alerts, two
 * dispatches, two sets of response metrics, and two open alerts inflating the
 * equity KPIs.
 *
 * `evaluateAlertRules` also takes `now` from `new Date()`, so the test drives
 * time through the module's own clock seam rather than by freezing globals.
 */

const HOUR = 60 * 60 * 1000

const rule = (over = {}) => normalizeAlertRule({
  name: 'River gauge',
  metric: 'counts.hazard_events',
  operator: '>=',
  threshold: 1,
  severity: 'high',
  suppression_minutes: 120,
  ...over,
})

/** A data object holding the rules under evaluation and the alerts raised so far. */
const withAlerts = (rules, events = []) => ({
  ...emptyStore(),
  alert_rules: rules,
  alert_events: events,
})

describe('alert suppression is a rolling window', () => {
  const context = { counts: { hazard_events: 3 } }

  it('raises once, and suppresses the next evaluation inside the window', () => {
    const r = rule()
    const first = evaluateAlertRules(withAlerts([r]), context)
    assert.equal(first.length, 1)

    const second = evaluateAlertRules(withAlerts([r], first), context)
    assert.equal(second.length, 0, 'the condition still holds, but the window has not elapsed')
  })

  it('does not raise again across a calendar bucket boundary', () => {
    // Reproduced against the old implementation: suppression_minutes 120 gives
    // bucket floor(t / 7200000), and 10:59:59Z and 11:00:01Z are buckets
    // 49671 and 49672. Both raised.
    const r = rule()
    const first = evaluateAlertRules(withAlerts([r]), context)
    const earlier = { ...first[0], created_at: new Date(Date.now() - 2 * HOUR + 2000).toISOString() }

    const second = evaluateAlertRules(withAlerts([r], [earlier]), context)
    assert.equal(second.length, 0,
      'an alert raised one minute ago must suppress, whichever side of a bucket boundary it fell on')
  })

  it('raises again once the window has actually elapsed', () => {
    const r = rule()
    const stale = {
      id: 'a-old',
      rule_id: r.id,
      suppression_bucket: 1,
      created_at: new Date(Date.now() - 3 * HOUR).toISOString(),
      severity: 'high',
    }
    const again = evaluateAlertRules(withAlerts([r], [stale]), context)
    assert.equal(again.length, 1, 'three hours on, a 120-minute window has passed')
  })

  it('measures the window from the most recent alert, not the oldest', () => {
    const r = rule()
    // One alert long past, one recent. A window measured from the first would
    // have elapsed and raised; measured from the last, it has not.
    const events = [
      { id: 'a-1', rule_id: r.id, created_at: new Date(Date.now() - 10 * HOUR).toISOString() },
      { id: 'a-2', rule_id: r.id, created_at: new Date(Date.now() - 1 * HOUR).toISOString() },
    ]
    assert.equal(evaluateAlertRules(withAlerts([r], events), context).length, 0)
  })

  it('suppresses per rule, so one silence does not mute another', () => {
    const first = rule({ name: 'A' })
    const second = rule({ name: 'B' })
    const raisedForA = evaluateAlertRules(withAlerts([first]), context)
    assert.equal(raisedForA.length, 1)
    const both = evaluateAlertRules(withAlerts([first, second], raisedForA), context)
    assert.equal(both.length, 1, 'the first rule already has one, so only the second is new')
    assert.equal(both[0].rule_id, second.id)
  })

  it('honours a longer window', () => {
    const r = rule({ suppression_minutes: 360 })
    const events = [{
      id: 'a-1',
      rule_id: r.id,
      created_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    }]
    assert.equal(evaluateAlertRules(withAlerts([r], events), context).length, 0,
      'two hours inside a six-hour window')
  })

  it('still raises for a rule that has never fired', () => {
    const r = rule()
    const events = [{ id: 'a-1', rule_id: 'some-other-rule', created_at: new Date().toISOString() }]
    assert.equal(evaluateAlertRules(withAlerts([r], events), context).length, 1)
  })

  it('suppresses on a legacy record that carries only a bucket', () => {
    // Records written before created_at was carried have the bucket and
    // nothing else. Falling through would re-alert on top of an alert the
    // operator has already seen.
    const r = rule()
    const legacy = [{ id: 'a-1', rule_id: r.id, suppression_bucket: Math.floor(Date.now() / (120 * 60000)) }]
    assert.equal(evaluateAlertRules(withAlerts([r], legacy), context).length, 0)
  })

  it('ignores a record whose timestamp is unparseable rather than going NaN', () => {
    // Math.max over NaN is NaN, and NaN < windowMs is false -- so a naive
    // implementation would treat the alert as old and raise on top of it.
    const r = rule()
    const broken = [{ id: 'a-1', rule_id: r.id, created_at: 'not a date', suppression_bucket: -1 }]
    const events = evaluateAlertRules(withAlerts([r], broken), context)
    assert.equal(events.length, 1,
      'an unparseable timestamp is no evidence the window elapsed; the bucket disagrees and the alert stands')
  })

  it('still returns nothing when the condition no longer holds', () => {
    const r = rule()
    assert.equal(evaluateAlertRules(withAlerts([r]), { counts: { hazard_events: 0 } }).length, 0)
  })
})
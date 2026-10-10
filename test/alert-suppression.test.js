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
 * `evaluateAlertRules` takes `now` from `new Date()`, so the tests drive time
 * through the timestamps on the records they pass in rather than by freezing
 * globals.
 *
 * Prior alerts here are `resolved`. A rule with an *open* alert no longer
 * reaches the suppression window at all — that is the one-open-alert-per-rule
 * behaviour tested separately below — so a fixture left open would be testing
 * the wrong mechanism.
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

const withAlerts = (rules, events = []) => ({
  ...emptyStore(),
  alert_rules: rules,
  alert_events: events,
})

/** A prior alert, closed, so the next evaluation reaches the window check. */
const closed = (r, over = {}) => ({
  id: 'a-prior',
  rule_id: r.id,
  severity: 'high',
  value: 1,
  created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  updated_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  ...over,
  // Last, so a fixture cannot leave an alert open and reach a different branch
  // than the one it means to test.
  status: 'resolved',
})

describe('alert suppression is a rolling window', () => {
  const context = { counts: { hazard_events: 3 } }

  it('raises once, then suppresses for the window even after the alert is closed', () => {
    const r = rule()
    const first = evaluateAlertRules(withAlerts([r]), context)
    assert.equal(first.raised.length, 1)

    const second = evaluateAlertRules(withAlerts([r], first.raised.map((e) => closed(r, e))), context)
    assert.equal(second.raised.length, 0, 'the condition still holds, but the window has not elapsed')
  })

  it('does not raise again across a calendar bucket boundary', () => {
    // Reproduced against the old implementation: suppression_minutes 120 gives
    // bucket floor(t / 7200000), and two evaluations a minute apart either
    // side of a boundary land in different buckets. Both raised.
    const r = rule()
    const earlier = closed(r, { created_at: new Date(Date.now() - 119 * 60 * 1000).toISOString() })
    const second = evaluateAlertRules(withAlerts([r], [earlier]), context)
    assert.equal(second.raised.length, 0,
      'an alert raised two minutes ago must suppress, whichever side of a bucket boundary it fell on')
  })

  it('raises again once the window has actually elapsed', () => {
    const r = rule()
    const stale = closed(r, { created_at: new Date(Date.now() - 3 * HOUR).toISOString() })
    const again = evaluateAlertRules(withAlerts([r], [stale]), context)
    assert.equal(again.raised.length, 1, 'three hours on, a 120-minute window has passed')
  })

  it('measures the window from the most recent alert, not the oldest', () => {
    const r = rule()
    const events = [
      closed(r, { id: 'a-1', created_at: new Date(Date.now() - 10 * HOUR).toISOString() }),
      closed(r, { id: 'a-2', created_at: new Date(Date.now() - 1 * HOUR).toISOString() }),
    ]
    assert.equal(evaluateAlertRules(withAlerts([r], events), context).raised.length, 0)
  })

  it('suppresses per rule, so one rule does not mute another', () => {
    const first = rule({ name: 'A' })
    const second = rule({ name: 'B' })
    const raisedForA = evaluateAlertRules(withAlerts([first]), context).raised
    assert.equal(raisedForA.length, 1)
    const both = evaluateAlertRules(withAlerts([first, second], raisedForA.map((e) => closed(first, e))), context)
    assert.equal(both.raised.length, 1, 'the first rule already fired, so only the second is new')
    assert.equal(both.raised[0].rule_id, second.id)
  })

  it('honours a longer window', () => {
    const r = rule({ suppression_minutes: 360 })
    const events = [closed(r, { created_at: new Date(Date.now() - 2 * HOUR).toISOString() })]
    assert.equal(evaluateAlertRules(withAlerts([r], events), context).raised.length, 0,
      'two hours inside a six-hour window')
  })

  it('still raises for a rule that has never fired', () => {
    const r = rule()
    const events = [closed(r, { rule_id: 'some-other-rule', created_at: new Date().toISOString() })]
    assert.equal(evaluateAlertRules(withAlerts([r], events), context).raised.length, 1)
  })

  it('suppresses on a legacy record that carries only a bucket', () => {
    // Records written before created_at was carried have the bucket and
    // nothing else. Falling through would re-alert on top of an alert the
    // operator has already seen.
    const r = rule()
    const legacy = [{
      id: 'a-1',
      rule_id: r.id,
      status: 'resolved',
      suppression_bucket: Math.floor(Date.now() / (120 * 60000)),
    }]
    assert.equal(evaluateAlertRules(withAlerts([r], legacy), context).raised.length, 0)
  })

  it('ignores a record whose timestamp is unparseable rather than going NaN', () => {
    // Math.max over NaN is NaN, and NaN < windowMs is false -- so a naive
    // implementation would treat the alert as old and raise on top of it.
    const r = rule()
    const broken = [closed(r, { id: 'a-1', created_at: 'not a date', suppression_bucket: -1 })]
    const result = evaluateAlertRules(withAlerts([r], broken), context)
    assert.equal(result.raised.length, 1,
      'an unparseable timestamp is no evidence the window elapsed; the bucket disagrees and the alert stands')
  })

  it('still returns nothing when the condition no longer holds', () => {
    const r = rule()
    assert.equal(evaluateAlertRules(withAlerts([r]), { counts: { hazard_events: 0 } }).raised.length, 0)
  })
})

describe('one open alert per rule', () => {
  const context = { counts: { hazard_events: 3 } }

  // Default is a reading from outside the suppression window, so these tests
  // exercise escalation rather than the window that gates it.
  const open = (r, over = {}) => ({
    id: 'a-open',
    rule_id: r.id,
    status: 'open',
    severity: 'high',
    value: 3,
    created_at: new Date(Date.now() - 3 * HOUR).toISOString(),
    updated_at: new Date(Date.now() - 3 * HOUR).toISOString(),
    ...over,
  })

  it('does not accumulate a second open alert for a condition that persists', () => {
    // The defect: a persistent condition raised an open, dispatchable alert
    // every suppression window -- about 84 a week at the 120-minute default --
    // all of them counting toward the equity KPIs.
    const r = rule()
    let events = []
    for (let i = 0; i < 10; i += 1) {
      const { raised, updated } = evaluateAlertRules(withAlerts([r], events), context)
      events = [...events, ...raised, ...updated]
    }
    // The store keys on id, so what an operator would see is the distinct
    // open alerts, not the number of times a record was rewritten.
    const openIds = new Set(events.filter((e) => e.status === 'open').map((e) => e.id))
    assert.equal(openIds.size, 1, 'a condition that has not changed is one alert, not ten')
  })

  it('records the repeat as an observation on the existing alert', () => {
    const r = rule()
    const existing = open(r)
    const { raised, updated } = evaluateAlertRules(withAlerts([r], [existing]), context)
    assert.equal(raised.length, 0)
    assert.equal(updated.length, 1)
    assert.equal(updated[0].status, 'open')
    assert.equal(updated[0].observations, 2)
    assert.ok(updated[0].last_observed_at)
  })

  it('keeps the peak reading across repeats', () => {
    const r = rule()
    const existing = open(r, { value: 3, peak_value: 9, created_at: new Date().toISOString() })
    const { updated } = evaluateAlertRules(withAlerts([r], [existing]), { counts: { hazard_events: 5 } })
    assert.equal(updated[0].peak_value, 9, 'the value has gone down since the peak; the peak is still the peak')
  })

  it('supersedes the open alert when the condition genuinely worsens', () => {
    const r = rule()
    const existing = open(r, { value: 3 })
    const { raised, updated } = evaluateAlertRules(withAlerts([r], [existing]), { counts: { hazard_events: 8 } })

    assert.equal(raised.length, 1)
    assert.equal(raised[0].supersedes, existing.id)
    assert.equal(raised[0].prior_value, 3)
    assert.equal(updated.length, 1)
    assert.equal(updated[0].status, 'superseded')
    assert.match(updated[0].resolution_note, /superseded/)
  })

  it('does not supersede on a worse reading inside the suppression window', () => {
    const r = rule()
    const existing = open(r, { value: 3, created_at: new Date().toISOString() })
    const { raised, updated } = evaluateAlertRules(withAlerts([r], [existing]), { counts: { hazard_events: 8 } })
    assert.equal(raised.length, 0, 'a worse reading two seconds later is not a second alert')
    assert.equal(updated[0].status, 'open')
    assert.equal(updated[0].peak_value, 8)
  })

  it('escalates on the recorded value, not the rule threshold', () => {
    // The threshold is what the rule asks for; the recorded value is what last
    // happened. Comparing against the threshold would call 4 and 5 equally
    // severe and never escalate at all.
    const r = rule()
    const existing = open(r, { value: 4 })
    assert.equal(evaluateAlertRules(withAlerts([r], [existing]), { counts: { hazard_events: 5 } }).raised.length, 1)
    assert.equal(evaluateAlertRules(withAlerts([r], [existing]), { counts: { hazard_events: 2 } }).raised.length, 0)
  })

  it('escalates correctly for a rule that fires on a falling value', () => {
    const r = rule({ metric: 'data_quality.coverage', operator: '<=', threshold: 0.5 })
    const existing = open(r, { value: 0.5 })
    const worse = evaluateAlertRules(withAlerts([r], [existing]), { data_quality: { coverage: 0.2 } })
    assert.equal(worse.raised.length, 1, 'coverage falling further below the floor is worse, not better')
    const better = evaluateAlertRules(withAlerts([r], [existing]), { data_quality: { coverage: 0.9 } })
    assert.equal(better.raised.length, 0)
  })
})

describe('hysteresis', () => {
  it('does nothing unless configured', () => {
    const r = rule({ hysteresis: 0 })
    const existing = {
      id: 'a-open', rule_id: r.id, status: 'open', severity: 'high', value: 3,
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    }
    const { updated } = evaluateAlertRules(withAlerts([r], [existing]), { counts: { hazard_events: 0 } })
    assert.deepEqual(updated, [], 'an alert stays open until a person closes it, as before')
  })

  it('closes an alert the metric has fallen back from', () => {
    const r = rule({ hysteresis: 2, operator: '>', threshold: 10 })
    const existing = {
      id: 'a-open', rule_id: r.id, status: 'open', severity: 'high', value: 14,
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    }
    // threshold 10, hysteresis 2: released at 8. A reading of 8 has fallen
    // back past the margin, so the gauge has settled.
    const { updated } = evaluateAlertRules(withAlerts([r], [existing]), { counts: { hazard_events: 8 } })
    assert.equal(updated.length, 1)
    assert.equal(updated[0].status, 'resolved')
    assert.equal(updated[0].resolution, 'cleared')
    assert.ok(updated[0].cleared_at)
    assert.match(updated[0].resolution_note, /release margin/)
  })

  it('leaves the alert open while the metric is still in the release band', () => {
    // threshold 10, hysteresis 2: released at 8. A reading of 9 has fallen
    // below the threshold but not by the margin, so the operator has not seen
    // it settle and closing the alert would report a condition that may return.
    const r = rule({ hysteresis: 2, operator: '>', threshold: 10 })
    const existing = {
      id: 'a-open', rule_id: r.id, status: 'open', severity: 'high', value: 14,
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    }
    const { updated } = evaluateAlertRules(withAlerts([r], [existing]), { counts: { hazard_events: 9 } })
    assert.deepEqual(updated, [])
  })

  it('does not close an alert twice', () => {
    const r = rule({ hysteresis: 2, operator: '>', threshold: 10 })
    const existing = {
      id: 'a-open', rule_id: r.id, status: 'open', severity: 'high', value: 14,
      cleared_at: new Date(Date.now() - HOUR).toISOString(),
      created_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    }
    const { updated } = evaluateAlertRules(withAlerts([r], [existing]), { counts: { hazard_events: 5 } })
    assert.deepEqual(updated, [])
  })

  it('releases in the other direction for a rule that fires on a falling value', () => {
    const r = rule({
      metric: 'data_quality.coverage', operator: '<', threshold: 0.5, hysteresis: 0.1,
    })
    const existing = {
      id: 'a-open', rule_id: r.id, status: 'open', severity: 'high', value: 0.2,
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    }
    // Cleared at 0.5 + 0.1 = 0.6. Coverage of 0.7 has recovered past it.
    const { updated } = evaluateAlertRules(withAlerts([r], [existing]), { data_quality: { coverage: 0.7 } })
    assert.equal(updated[0].status, 'resolved')
    assert.equal(updated[0].resolution, 'cleared')
  })

  it('defaults to zero on a rule that never declared one', () => {
    const r = normalizeAlertRule({ name: 'Legacy', metric: 'counts.hazard_events', operator: '>=', threshold: 1 })
    assert.equal(r.hysteresis, 0)
    assert.equal(r.suppression_minutes, 120)
  })
})
describe('CON-05 evaluation groups events once and folds without an argument limit', () => {
  const context = { counts: { hazard_events: 3 } }

  it('answers for a rule with a history longer than the argument limit', () => {
    // `Math.max(...seen)` passes one argument per prior event. At roughly
    // 125,000 arguments V8 throws `RangeError: Maximum call stack size
    // exceeded`, so the rule an operator most needs an answer about — the one
    // that has fired most — was the one that crashed the evaluation.
    const r = rule({ suppression_minutes: 120 })
    const history = Array.from({ length: 200000 }, (_, i) => closed(r, {
      id: `a-${i}`,
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    }))
    const result = evaluateAlertRules(withAlerts([r], history), context)
    assert.equal(result.raised.length, 0, 'the window has not elapsed, so nothing should raise')
  })

  it('still reads the newest event when the history is out of order', () => {
    // The fold must take the maximum, not the last element: events are not
    // guaranteed to arrive sorted, and the whole window check hangs off which
    // one is most recent.
    const r = rule({ suppression_minutes: 120 })
    const old = closed(r, { id: 'a-old', created_at: new Date(Date.now() - 10 * HOUR).toISOString() })
    const recent = closed(r, { id: 'a-new', created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() })
    // Newest first, so a `prior[prior.length - 1]` shortcut would read the old one.
    const { raised } = evaluateAlertRules(withAlerts([r], [recent, old]), context)
    assert.equal(raised.length, 0, 'the most recent event is five minutes old, inside the window')
  })

  it('groups by rule, so one rule does not suppress another', () => {
    const a = rule({ name: 'A', suppression_minutes: 120 })
    const b = rule({ name: 'B', suppression_minutes: 120 })
    const events = [closed(a, { id: 'a-1', rule_id: a.id })]
    const { raised } = evaluateAlertRules(withAlerts([a, b], events), context)
    assert.deepEqual(raised.map((e) => e.rule_id), [b.id], 'rule B has no history and must raise')
  })
})

describe('CON-05 the collection is walked once per evaluation, not once per rule', () => {
  const context = { counts: { hazard_events: 3 } }

  /** An array that counts how many times it is filtered or iterated. */
  const counting = (items) => {
    const stats = { filters: 0, iterations: 0 }
    const target = [...items]
    target[Symbol.iterator] = function* countingIterator() {
      stats.iterations += 1
      yield* items
    }
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === 'filter') {
          return (...args) => {
            stats.filters += 1
            return obj.filter(...args)
          }
        }
        return Reflect.get(obj, prop, receiver)
      },
    })
    return { proxy, stats }
  }

  it('does not walk every event once per active rule', () => {
    // Ten rules over one shared history. The old code ran `filter` twice per
    // rule — once for the open set, once inside `isSuppressed` — so the cost of
    // evaluation grew with the product of the two collections, and both only
    // grow. The grouping makes it independent of the rule count.
    const rules = Array.from({ length: 10 }, (_, i) => rule({ name: `Rule ${i}` }))
    const events = Array.from({ length: 50 }, (_, i) => closed(rules[0], { id: `e-${i}` }))
    const { proxy, stats } = counting(events)

    evaluateAlertRules({ ...emptyStore(), alert_rules: rules, alert_events: proxy }, context)

    assert.equal(stats.filters, 0, `${stats.filters} full-collection filters ran; the grouping should have removed them all`)
    assert.equal(stats.iterations, 1, `the collection was walked ${stats.iterations} times, expected once`)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { backtestTriggerProtocol } from '../src/alerts.js'
import { emptyStore } from '../src/schema.js'

/**
 * A trigger backtest has to evaluate the trigger.
 *
 * The old implementation ignored `metric`, `operator` and `threshold`
 * completely and scored every ingestion run on "did any hazard event follow",
 * so backtesting a protocol and backtesting a completely unrelated one
 * produced identical numbers. It also classified every sample as either a true
 * or a false positive, which makes `misses` identically zero and forces
 * `recall` to equal `precision` — two numbers that could never disagree and so
 * could never disagree usefully.
 */

function run(id, completedAt) {
  return { id, source: 'open_meteo', status: 'success', started_at: completedAt, completed_at: completedAt, records_processed: 10 }
}

function event(id, occurredAt) {
  return { id, event_type: 'flood', source: 'gdacs', severity: 'high', occurred_at: occurredAt }
}

/** One hazard event per run that should count as a hit. */
function store({ runs, events, hazards = [] }) {
  return { ...emptyStore(), source_runs: runs, hazard_events: [...events, ...hazards] }
}

const DAY = 24 * 60 * 60 * 1000
const protocol = (over = {}) => ({
  id: 'p1',
  name: 'Flood watch',
  metric: 'counts.hazard_events',
  operator: '>',
  threshold: 0,
  lead_time_days: 3,
  ...over,
})

describe('trigger protocol backtest evaluates the trigger', () => {
  it('scores the protocol condition, not merely "an event followed"', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z'), run('r2', '2026-01-05T00:00:00Z')]
    // Both runs are followed by an event, so the old code returned
    // precision === recall === 1.0 for anything at all.
    const events = [event('e1', '2026-01-02T00:00:00Z'), event('e2', '2026-01-06T00:00:00Z')]

    const fires = backtestTriggerProtocol(protocol({ operator: '>', threshold: 0 }), store({ runs, events }))
    const never = backtestTriggerProtocol(protocol({ operator: '>', threshold: 1000 }), store({ runs, events }))

    assert.notEqual(fires.precision, never.precision,
      'two protocols with different thresholds produced the same precision, so the threshold was ignored')
    assert.equal(never.true_positives, 0)
    assert.match(never.verdict, /never fired/)
  })

  it('counts the runs it never fired on as misses', () => {
    // Threshold of 1000: the condition is never met, yet an event follows
    // both runs. Those two runs are false negatives, and the old arithmetic
    // had nowhere to put them.
    const runs = [run('r1', '2026-01-01T00:00:00Z'), run('r2', '2026-01-05T00:00:00Z')]
    const events = [event('e1', '2026-01-02T00:00:00Z'), event('e2', '2026-01-06T00:00:00Z')]

    const result = backtestTriggerProtocol(protocol({ operator: '>', threshold: 1000 }), store({ runs, events }))
    assert.equal(result.misses, 2, 'a protocol that never fires when events follow is not perfect')
    assert.equal(result.true_positives, 0)
    assert.equal(result.recall, 0)
    assert.equal(result.precision, null, 'precision is undefined when the protocol never fires, not zero')
  })

  it('separates precision from recall', () => {
    // Four runs: two fire (one event follows), two do not (both have events).
    const runs = [
      run('r1', '2026-01-01T00:00:00Z'),
      run('r2', '2026-01-05T00:00:00Z'),
      run('r3', '2026-01-09T00:00:00Z'),
      run('r4', '2026-01-13T00:00:00Z'),
    ]
    const events = [
      event('e1', '2026-01-02T00:00:00Z'),
      event('e2', '2026-01-06T00:00:00Z'),
      event('e3', '2026-01-10T00:00:00Z'),
      event('e4', '2026-01-14T00:00:00Z'),
    ]
    // Fires on r1/r2 only: the hazard count crossing 0 happens at r2, when
    // e1 has been ingested. Construct the context via buildContext instead,
    // so the test states the firing pattern directly.
    const pattern = new Map([['r1', false], ['r2', true], ['r3', false], ['r4', false]])
    const result = backtestTriggerProtocol(
      protocol(),
      store({ runs, events }),
      { buildContext: (data, r) => ({ counts: { hazard_events: pattern.get(r.id) ? 1 : 0 } }) },
    )
    // r2 fires and an event follows -> true positive. The other three runs each
    // had an event follow without the protocol firing -> three misses.
    assert.equal(result.true_positives, 1)
    assert.equal(result.false_positives, 0)
    assert.equal(result.misses, 3)
    assert.equal(result.true_negatives, 0)
    // The two figures finally differ, which is the entire point: the old
    // arithmetic made them equal by construction.
    assert.equal(result.precision, 1)
    assert.equal(result.recall, 0.25)
    assert.equal(result.f1, 0.4)
    assert.equal(result.evaluable, 4)
    assert.equal(result.samples, 4)
  })

  it('reports the base rate, so precision can be read against it', () => {
    // A protocol that fires on every run and is followed by an event 50% of
    // the time has precision 0.5 and has learned nothing.
    const runs = Array.from({ length: 10 }, (_, i) => run(`r${i}`, new Date(Date.UTC(2026, 0, 1 + i * 4)).toISOString()))
    const events = runs
      .filter((_, i) => i % 2 === 0)
      .map((r, i) => event(`e${i}`, new Date(Date.parse(r.completed_at) + DAY).toISOString()))

    const result = backtestTriggerProtocol(
      protocol(),
      store({ runs, events }),
      { buildContext: () => ({ counts: { hazard_events: 1 } }) },
    )
    assert.equal(result.event_base_rate, 0.5)
    assert.equal(result.precision, 0.5)
    assert.equal(result.precision_lift, 1)
    assert.match(result.verdict, /no better than firing always/,
      'precision must not be reported without the base rate it has to beat')
  })

  it('credits a protocol that beats firing on every run', () => {
    const runs = Array.from({ length: 10 }, (_, i) => run(`r${i}`, new Date(Date.UTC(2026, 0, 1 + i * 4)).toISOString()))
    // Events follow only the first five runs.
    const events = runs
      .slice(0, 5)
      .map((r, i) => event(`e${i}`, new Date(Date.parse(r.completed_at) + DAY).toISOString()))
    // Fires only on the first five.
    const firesEarly = new Map(runs.map((r, i) => [r.id, i < 5]))

    const result = backtestTriggerProtocol(
      protocol(),
      store({ runs, events }),
      { buildContext: (data, r) => ({ counts: { hazard_events: firesEarly.get(r.id) ? 1 : 0 } }) },
    )
    assert.equal(result.precision, 1)
    assert.equal(result.recall, 1)
    assert.equal(result.misses, 0)
    assert.equal(result.false_positives, 0)
    assert.equal(result.true_negatives, 5)
    assert.ok(result.precision_lift > 1)
    assert.match(result.verdict, /outperformed firing on every run/)
  })

  it('does not score a run against data that had not been ingested yet', () => {
    // The hazard event for r1 is ingested only after r1 completed. A backtest
    // that sees it anyway is evaluating with knowledge of the future.
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const events = [event('e1', '2026-01-02T00:00:00Z')]
    const data = store({ runs, events, hazards: [{ id: 'hz-late', occurred_at: '2026-01-01T12:00:00Z', first_seen_at: '2026-01-03T00:00:00Z' }] })

    const result = backtestTriggerProtocol(protocol(), data)
    // The late hazard must not be visible to the run it post-dates: the
    // condition is not met, so the protocol does not fire — even though the
    // run is followed by a real event, which makes it a miss.
    assert.equal(result.true_positives, 0, 'the late hazard leaked into the run it post-dates')
    assert.equal(result.misses, 1)
    assert.equal(result.evaluable, 1)
  })

  it('separates unevaluable runs from negatives', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z'), run('r2', '2026-01-05T00:00:00Z')]
    const events = [event('e1', '2026-01-02T00:00:00Z')]
    // A metric that only resolves on the second run.
    const result = backtestTriggerProtocol(
      protocol({ metric: 'counts.never_defined' }),
      store({ runs, events }),
    )
    assert.equal(result.samples, 2)
    assert.equal(result.evaluable, 0)
    assert.equal(result.unevaluable, 2)
    assert.equal(result.precision, null)
    assert.equal(result.recall, null)
    assert.match(result.verdict, /not evaluable/)
  })

  it('warns when most runs could not be evaluated', () => {
    const runs = Array.from({ length: 10 }, (_, i) => run(`r${i}`, new Date(Date.UTC(2026, 0, 1 + i * 4)).toISOString()))
    const events = runs.slice(0, 8).map((r, i) => event(`e${i}`, new Date(Date.parse(r.completed_at) + DAY).toISOString()))
    const evaluable = new Map(runs.map((r, i) => [r.id, i >= 7]))
    const result = backtestTriggerProtocol(
      protocol(),
      store({ runs, events }),
      { buildContext: (data, r) => (evaluable.get(r.id) ? { counts: { hazard_events: 1 } } : {}) },
    )
    assert.equal(result.evaluable, 3)
    assert.equal(result.unevaluable, 7)
    assert.match(result.verdict, /weak evidence/)
  })

  it('reports the condition it evaluated alongside the result', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const result = backtestTriggerProtocol(
      protocol({ metric: 'counts.hazard_events', operator: '>=', threshold: 2, lead_time_days: 5 }),
      store({ runs, events: [] }),
    )
    assert.equal(result.metric, 'counts.hazard_events')
    assert.equal(result.operator, '>=')
    assert.equal(result.threshold, 2)
    assert.equal(result.lead_time_days, 5)
  })

  it('honours the lead time when deciding whether an event followed', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const farEvent = [event('e1', '2026-01-20T00:00:00Z')]
    const nearEvent = [event('e1', '2026-01-03T00:00:00Z')]

    const shortLead = backtestTriggerProtocol(
      protocol({ lead_time_days: 3 }),
      store({ runs, events: farEvent }),
      { buildContext: () => ({ counts: { hazard_events: 1 } }) },
    )
    const longLead = backtestTriggerProtocol(
      protocol({ lead_time_days: 30 }),
      store({ runs, events: farEvent }),
      { buildContext: () => ({ counts: { hazard_events: 1 } }) },
    )
    assert.equal(shortLead.false_positives, 1, 'a 19-day-distant event is outside a 3-day lead time')
    assert.equal(longLead.true_positives, 1)
    assert.equal(nearEvent.length, 1)
  })

  it('returns a well-formed empty result for an empty store', () => {
    const result = backtestTriggerProtocol(protocol(), { ...emptyStore() })
    assert.equal(result.samples, 0)
    assert.equal(result.evaluable, 0)
    assert.equal(result.precision, null)
    assert.equal(result.recall, null)
    assert.equal(result.f1, null)
    assert.equal(result.event_base_rate, null)
    assert.equal(result.precision_lift, null)
    assert.match(result.verdict, /not evaluable/)
  })
})
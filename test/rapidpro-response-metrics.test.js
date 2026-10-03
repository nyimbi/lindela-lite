import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { responseMetrics } from '../src/rapidpro.js'
import { emptyStore } from '../src/schema.js'

/**
 * A response rate is a rate of people, not of messages.
 *
 * `response_rate_pct` divided inbound *messages* by dispatches. One CHW can
 * answer the same alert twice, and a RapidPro flow emits several messages per
 * answer, so the figure exceeded 100% — one dispatch and two messages reported
 * 200%. A percentage above 100 is not a precision problem, it is a metric
 * that does not mean what its name says, and an operator cannot tell the
 * difference between "twice as responsive" and "broken".
 */

function store(dispatches, inbounds) {
  return { ...emptyStore(), rapidpro_dispatches: dispatches, rapidpro_inbound_messages: inbounds }
}

const dispatch = (id, alertEventId, from) => ({
  id, alert_event_id: alertEventId, from, created_at: '2026-10-01T00:00:00Z', status: 'sent',
})

const inbound = (id, alertEventId, from, createdAt = '2026-10-01T00:05:00Z') => ({
  id, alert_event_id: alertEventId, from, created_at: createdAt, status: 'processed',
})

describe('rapidpro response metrics', () => {
  it('counts distinct responders, not messages', () => {
    const result = responseMetrics(store(
      [dispatch('d1', 'alert-1', '+254700000001')],
      [
        inbound('m1', 'alert-1', '+254700000001'),
        inbound('m2', 'alert-1', '+254700000001'),
        inbound('m3', 'alert-1', '+254700000001'),
      ],
    ))
    assert.equal(result.length, 1)
    assert.equal(result[0].dispatched_count, 1)
    assert.equal(result[0].response_count, 1, 'three messages from one person is one response')
    assert.equal(result[0].response_rate_pct, 100)
  })

  it('cannot exceed 100%', () => {
    const result = responseMetrics(store(
      [dispatch('d1', 'alert-1', '+254700000001')],
      // One recipient, twelve messages from them.
      Array.from({ length: 12 }, (_, i) => inbound(`m${i}`, 'alert-1', '+254700000001')),
    ))
    assert.equal(result[0].response_count, 1)
    assert.ok(result[0].response_rate_pct <= 100, `a response rate of ${result[0].response_rate_pct} is not a rate`)
  })

  it('separates several responders of one alert', () => {
    const result = responseMetrics(store(
      [dispatch('d1', 'alert-1', '+254700000001'), dispatch('d2', 'alert-1', '+254700000002')],
      [inbound('m1', 'alert-1', '+254700000001'), inbound('m2', 'alert-1', '+254700000002')],
    ))
    assert.equal(result[0].dispatched_count, 2)
    assert.equal(result[0].response_count, 2)
    assert.equal(result[0].response_rate_pct, 100)
  })

  it('reports a partial rate as partial, not as a failure', () => {
    const result = responseMetrics(store(
      [dispatch('d1', 'alert-1', 'a'), dispatch('d2', 'alert-1', 'b'), dispatch('d3', 'alert-1', 'c')],
      [inbound('m1', 'alert-1', 'a')],
    ))
    assert.equal(result[0].response_count, 1)
    assert.equal(result[0].response_rate_pct, 33.33)
  })

  it('says null rather than 0% when nobody has answered yet', () => {
    // A dispatch nobody has responded to is an open question. Zero would
    // report silence as a measured outcome, which is the same conflation the
    // alert model refuses elsewhere with false_alert: null.
    const result = responseMetrics(store([dispatch('d1', 'alert-1', 'a')], []))
    assert.equal(result[0].response_rate_pct, null)
    assert.equal(result[0].response_count, 0)
    assert.equal(result[0].first_response_at, null)
  })

  it('counts a reply from someone who was never alerted separately', () => {
    // A bystander, a shared handset, or a number that was not in the target
    // list. Real signal — but it is not a response to the dispatch, and it
    // cannot be a percentage of it.
    const result = responseMetrics(store(
      [dispatch('d1', 'alert-1', '+254700000001')],
      [inbound('m1', 'alert-1', '+254700000001'), inbound('m2', 'alert-1', '+254799999999')],
    ))
    assert.equal(result[0].response_rate_pct, 100)
    assert.equal(result[0].response_count, 1)
    assert.equal(result[0].undispatched_response_count, 1)
  })

  it('keeps the earliest response as the first response', () => {
    const result = responseMetrics(store(
      [dispatch('d1', 'alert-1', 'a')],
      [
        inbound('m2', 'alert-1', 'a', '2026-10-01T00:30:00Z'),
        inbound('m1', 'alert-1', 'a', '2026-10-01T00:05:00Z'),
      ],
    ))
    assert.equal(result[0].first_response_at, '2026-10-01T00:05:00Z')
    assert.equal(result[0].mean_response_seconds, 300)
  })

  it('keeps alerts separate', () => {
    const result = responseMetrics(store(
      [dispatch('d1', 'alert-1', 'a'), dispatch('d2', 'alert-2', 'b')],
      [inbound('m1', 'alert-1', 'a')],
    ))
    assert.equal(result.length, 2)
    const one = result.find((r) => r.alert_event_id === 'alert-1')
    const two = result.find((r) => r.alert_event_id === 'alert-2')
    assert.equal(one.response_rate_pct, 100)
    assert.equal(two.response_rate_pct, null)
  })

  it('does not leak its internal bookkeeping into the response', () => {
    const result = responseMetrics(store([dispatch('d1', 'alert-1', 'a')], [inbound('m1', 'alert-1', 'a')]))
    assert.equal(result[0].responders, undefined, 'the responder Set leaked into the API payload')
  })
})
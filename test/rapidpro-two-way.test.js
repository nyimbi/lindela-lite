import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REPLY_REASON_CODES,
  applyAcknowledgement,
  applyEscalation,
  ackInstructions,
  ackSlaMinutes,
  correlateReply,
  deliveryReport,
  dueEscalations,
  formatDeliveryReport,
  parseRapidProReply,
  parseReplyVerb,
  recipientStates,
  reconcileInbound,
  withAckInstructions,
} from '../src/rapidpro.js'

/**
 * ENH-26: two-way SMS.
 *
 * The product is humanitarian and the failure mode is not a crash. An
 * escalation that fires when nobody is in danger pages a supervisor, teaches
 * the team the alert does not mean anything, and the next real flood is the one
 * nobody comes. A delivery record that says "delivered" because RapidPro
 * returned 200 is a false compliance record — the exact class DAT-07 was.
 *
 * So most of these tests are refusals. Each one pins a way the feature could
 * have been built to fire falsely, or to claim more than it knows.
 */

const T0 = '2026-10-01T08:00:00.000Z'
const URN_A = 'tel:+254700000001'
const URN_B = 'tel:+254700000002'

const dispatch = (over = {}) => ({
  id: 'd1',
  provider: 'rapidpro',
  alert_event_id: 'alert_1',
  severity: 'high',
  status: 'sent',
  mode: 'flow_start',
  message: 'Flooding at Baringo',
  recipients: { urns: [URN_A], contacts: [], groups: [] },
  endpoint: 'https://rapidpro.io/api/v2/flow_starts.json',
  response_status: 200,
  error: null,
  sent_at: T0,
  created_at: T0,
  ...over,
})

const inbound = (over = {}) => ({
  id: 'm1',
  provider: 'rapidpro',
  direction: 'incoming',
  kind: 'reply',
  source_id: 'src1',
  from: '+254700000001',
  text: 'ACK',
  verb: 'ACK',
  reason_code: null,
  alert_event_id: 'alert_1',
  dispatch_id: 'd1',
  received_at: '2026-10-01T08:04:00.000Z',
  created_at: '2026-10-01T08:04:00.000Z',
  ...over,
})

const data = (dispatches, inbounds = []) => ({ rapidpro_dispatches: dispatches, rapidpro_inbound_messages: inbounds })

const ENV = { RAPIDPRO_ESCALATION_URNS: '+254700000090' }

describe('reply verbs', () => {
  it('parses a bare verb', () => {
    const parsed = parseReplyVerb('ACK')
    assert.equal(parsed.verb, 'ACK')
    assert.equal(parsed.recognised, true)
    assert.equal(parsed.reason_code, null)
  })

  it('parses a verb with a reason code and a note', () => {
    const parsed = parseReplyVerb('ACK blocked - the ford is under water')
    assert.equal(parsed.verb, 'ACK')
    assert.equal(parsed.reason_code, 'blocked')
    assert.equal(parsed.note, 'the ford is under water')
  })

  it('accepts the four verbs', () => {
    for (const verb of ['ACK', 'ESCALATE', 'RESOLVED', 'NAK']) {
      assert.equal(parseReplyVerb(verb).verb, verb)
      assert.equal(parseReplyVerb(verb.toLowerCase()).verb, verb)
    }
  })

  it('does not read a verb out of the middle of a sentence', () => {
    // "the barrier crew ACK the closure" is not an acknowledgement. Treating it
    // as one cancels a real escalation window.
    assert.equal(parseReplyVerb('the barrier crew ack the closure').verb, null)
    assert.equal(parseReplyVerb('back at the office').verb, null)
    assert.equal(parseReplyVerb('PACKAGE DELAYED').verb, null)
  })

  it('preserves an unrecognised reason as raw text rather than inventing a code', () => {
    const parsed = parseReplyVerb('ACK knee-deep')
    assert.equal(parsed.verb, 'ACK')
    assert.equal(parsed.reason_code, null)
    assert.equal(parsed.reason_raw, 'knee-deep')
    assert.ok(!REPLY_REASON_CODES.includes(parsed.reason_raw))
  })

  it('tolerates the prefixes phone keyboards add', () => {
    assert.equal(parseReplyVerb(' ACK').verb, 'ACK')
    assert.equal(parseReplyVerb('>ACK').verb, 'ACK')
    assert.equal(parseReplyVerb('* RESOLVED').verb, 'RESOLVED')
  })

  it('reports free text as recognised: false rather than throwing it away', () => {
    const parsed = parseReplyVerb('on my way, no need to send help')
    assert.equal(parsed.verb, null)
    assert.equal(parsed.recognised, false)
    assert.equal(parsed.note, 'on my way, no need to send help')
  })
})

describe('acknowledgement SLA', () => {
  it('defaults by severity', () => {
    assert.equal(ackSlaMinutes('critical', {}), 15)
    assert.equal(ackSlaMinutes('high', {}), 30)
    assert.equal(ackSlaMinutes('medium', {}), 60)
    assert.equal(ackSlaMinutes('low', {}), 120)
  })

  it('resolves an unknown severity to an explicit number, not to nothing', () => {
    // An unset SLA is not neutral: escalation is computed from it, so a null
    // here is a false-alarm generator.
    assert.equal(ackSlaMinutes(undefined, {}), 60)
    assert.equal(ackSlaMinutes('surge', {}), 60)
  })

  it('lets a deployment override every severity at once', () => {
    assert.equal(ackSlaMinutes('critical', { RAPIDPRO_ACK_SLA_MINUTES: '5' }), 5)
  })

  it('ignores a nonsensical override rather than paging everyone at once', () => {
    assert.equal(ackSlaMinutes('critical', { RAPIDPRO_ACK_SLA_MINUTES: '0' }), 15)
    assert.equal(ackSlaMinutes('critical', { RAPIDPRO_ACK_SLA_MINUTES: 'soon' }), 15)
  })
})

describe('reply correlation', () => {
  const dispatches = [dispatch()]

  it('uses an explicit alert_event_id when RapidPro echoes one', () => {
    const result = correlateReply({ from: URN_A, alert_event_id: 'alert_9' }, data(dispatches))
    assert.equal(result.alert_event_id, 'alert_9')
    assert.equal(result.correlated, true)
  })

  it('matches the sender inside the window when nothing explicit is given', () => {
    const result = correlateReply({ from: '+254700000001' }, data(dispatches), { now: '2026-10-01T09:00:00.000Z' })
    assert.equal(result.alert_event_id, 'alert_1')
    assert.equal(result.dispatch_id, 'd1')
  })

  it('matches across the urn forms a gateway actually emits', () => {
    for (const form of ['tel:+254700000001', '+254700000001', '254700000001', '0 254 700 000 001']) {
      const result = correlateReply({ from: form }, data(dispatches), { now: '2026-10-01T09:00:00.000Z' })
      assert.equal(result.alert_event_id, 'alert_1', `failed for ${form}`)
    }
  })

  it('refuses to guess when the window has passed', () => {
    // A number reassigned six months later must not inherit a year-old alert.
    const result = correlateReply({ from: URN_A }, data(dispatches), { now: '2026-10-02T09:00:00.000Z' })
    assert.equal(result.alert_event_id, null)
    assert.equal(result.correlated, false)
    assert.match(result.correlation_note, /closes no SLA/)
  })

  it('refuses to guess when the sender was never alerted', () => {
    const result = correlateReply({ from: '+254709999999' }, data(dispatches), { now: '2026-10-01T09:00:00.000Z' })
    assert.equal(result.correlated, false)
  })

  it('correlates to the most recent dispatch when an alert was sent twice', () => {
    const later = dispatch({ id: 'd2', created_at: '2026-10-01T07:30:00.000Z' })
    const result = correlateReply({ from: URN_A }, data([dispatch(), later]), { now: '2026-10-01T09:00:00.000Z' })
    assert.equal(result.dispatch_id, 'd1')
  })
})

describe('inbound idempotency (ALERT-06)', () => {
  const parsed = parseRapidProReply(
    { id: 'src-abc', from: URN_A, text: 'ACK blocked' },
    data([dispatch()]),
    { now: T0 },
  )

  it('applies a reply the first time it arrives', () => {
    const result = reconcileInbound(data([]), parsed)
    assert.equal(result.duplicate, false)
    assert.equal(result.applied, true)
  })

  it('discards the retried webhook rather than restamping the acknowledgement', () => {
    // RapidPro retries anything it thinks was not acknowledged. Restamping
    // acknowledged_at would destroy the latency figure an operator judges the
    // response process by, and would create a second field report.
    const first = reconcileInbound(data([]), parsed)
    const store = data([], [first.inbound])
    const second = reconcileInbound(store, parsed)
    assert.equal(second.duplicate, true)
    assert.equal(second.applied, false)
    assert.equal(second.inbound.id, first.inbound.id)
  })

  it('gives a genuinely repeated reply its own id', () => {
    const first = parseRapidProReply({ id: 'src-1', from: URN_A, text: 'ACK' }, data([dispatch()]), { now: T0 })
    const second = parseRapidProReply({ id: 'src-2', from: URN_A, text: 'ACK' }, data([dispatch()]), { now: T0 })
    assert.notEqual(first.id, second.id)
  })

  it('dedupes against the field-report inbound path, not only within itself', () => {
    // Same id shape as parseRapidProFieldReport, so a retried webhook that
    // arrives on both routes collapses to one row rather than two.
    const existing = { id: parsed.id }
    assert.equal(reconcileInbound(data([], [existing]), parsed).duplicate, true)
  })
})

describe('per-recipient acknowledgement state', () => {
  it('reports awaiting for a recipient who has not replied', () => {
    const [state] = recipientStates(dispatch())
    assert.equal(state.urn, URN_A)
    assert.equal(state.ack_status, 'awaiting')
    assert.equal(state.ack_at, null)
  })

  it('records the acknowledgement time, not the report time', () => {
    const [state] = recipientStates(dispatch(), [inbound()])
    assert.equal(state.ack_status, 'acknowledged')
    assert.equal(state.ack_at, '2026-10-01T08:04:00.000Z')
    assert.equal(state.verb, 'ACK')
  })

  it('stops at "accepted by the gateway" and never says delivered', () => {
    // HTTP 200 means RapidPro took the request. It does not mean a handset
    // received it. A delivery receipt is a signal this integration does not have.
    const [state] = recipientStates(dispatch())
    assert.equal(state.delivery_status, 'accepted_by_gateway')
    assert.equal(state.delivery_receipt, null)
  })

  it('does not call a failed dispatch awaiting', () => {
    const failed = dispatch({ status: 'failed', response_status: 500, error: 'RapidPro HTTP 500' })
    const [state] = recipientStates(failed)
    assert.equal(state.ack_status, 'not_dispatched')
    assert.equal(state.note, 'RapidPro HTTP 500')
  })

  it('marks an address it cannot key as unidentified rather than dropping it', () => {
    // An invisible recipient is indistinguishable from one that was never
    // contacted, and a delivery report that quietly shrinks is a false record.
    const unkeyable = dispatch({ recipients: { urns: ['tel:chw-marama'], contacts: [], groups: [] } })
    const [state] = recipientStates(unkeyable)
    assert.equal(state.ack_status, 'unidentified')
    assert.equal(state.urn, 'tel:chw-marama')
    assert.match(state.note, /cannot be tracked per person/)
  })

  it('has no per-recipient row for a contact or group dispatch', () => {
    // A contact uuid cannot be matched against a sender, so there is nothing
    // per-recipient to report — the delivery report says so rather than
    // inventing rows.
    assert.equal(recipientStates(dispatch({ recipients: { urns: [], contacts: ['chw1'], groups: [] } })).length, 0)
    assert.equal(recipientStates(dispatch({ recipients: { urns: [], contacts: [], groups: ['g1'] } })).length, 0)
  })

  it('counts an unparsed reply as response, not as acknowledgement', () => {
    const [state] = recipientStates(dispatch(), [inbound({ verb: null, text: 'on my way' })])
    assert.equal(state.ack_status, 'responded_unparsed')
    assert.match(state.note, /without a recognised reply verb/)
  })

  it('prefers a stamped acknowledgement over a rescan of the inbox', () => {
    const stamped = applyAcknowledgement(dispatch(), { from: URN_A, verb: 'ACK', received_at: '2026-10-01T08:04:00.000Z' })
    const [state] = recipientStates(stamped, [])
    assert.equal(state.ack_status, 'acknowledged')
    assert.equal(state.ack_at, '2026-10-01T08:04:00.000Z')
  })

  it('maps each verb to a distinct state', () => {
    const for_ = (verb) => recipientStates(dispatch(), [inbound({ verb })])[0].ack_status
    assert.equal(for_('ACK'), 'acknowledged')
    assert.equal(for_('RESOLVED'), 'resolved')
    assert.equal(for_('ESCALATE'), 'escalated_by_responder')
    assert.equal(for_('NAK'), 'rejected')
  })
})

describe('acknowledgement stamping', () => {
  it('does not restamp a second reply from the same person', () => {
    const once = applyAcknowledgement(dispatch(), { from: URN_A, verb: 'ACK', received_at: T0 })
    const twice = applyAcknowledgement(once, { from: URN_A, verb: 'ACK', received_at: '2026-10-01T09:00:00.000Z' })
    assert.deepEqual(twice.acknowledgements, once.acknowledgements)
  })

  it('ignores a reply with no usable sender', () => {
    const result = applyAcknowledgement(dispatch(), { from: null, verb: 'ACK' })
    assert.equal(result.acknowledgements, undefined)
  })

  it('records the escalation and then refuses to record it twice', () => {
    const raised = applyEscalation(dispatch(), { recipient: URN_A, at: '2026-10-01T08:30:00.000Z', escalate_to: ['tel:+254700000090'] })
    assert.equal(raised.acknowledgements['+254700000001'].escalated_at, '2026-10-01T08:30:00.000Z')
    const again = applyEscalation(raised, { recipient: URN_A, at: '2026-10-01T09:00:00.000Z', escalate_to: [] })
    assert.equal(again, raised)
  })
})

describe('escalation', () => {
  const LATER = '2026-10-01T09:00:00.000Z' // 60 min after dispatch; high severity SLA is 30

  it('fires nothing before the deadline', () => {
    const due = dueEscalations(data([dispatch()]), { now: '2026-10-01T08:29:00.000Z', env: ENV })
    assert.deepEqual(due, [])
  })

  it('fires exactly at the deadline and not one second before', () => {
    // The boundary is asserted rather than assumed: an off-by-one here is a
    // false page, and "at the deadline" is the case nobody tests by hand.
    assert.deepEqual(dueEscalations(data([dispatch()]), { now: '2026-10-01T08:29:59.999Z', env: ENV }), [])
    assert.equal(dueEscalations(data([dispatch()]), { now: '2026-10-01T08:30:00.000Z', env: ENV }).length, 1)
  })

  it('reports the window it measured', () => {
    const due = dueEscalations(data([dispatch()]), { now: '2026-10-01T08:30:00.001Z', env: ENV })
    assert.equal(due.length, 1)
    assert.equal(due[0].recipient, URN_A)
    assert.equal(due[0].sla_minutes, 30)
    assert.equal(due[0].deadline_at, '2026-10-01T08:30:00.000Z')
    assert.deepEqual(due[0].escalate_to, ['tel:+254700000090'])
    assert.equal(due[0].escalation_target_unresolved, false)
    assert.match(due[0].reason, /no response from tel:\+254700000001 within 30 min/)
  })

  it('does not fire for a recipient who acknowledged', () => {
    assert.deepEqual(dueEscalations(data([dispatch()], [inbound()]), { now: LATER, env: ENV }), [])
  })

  it('does not fire for a recipient who replied without a recognised verb', () => {
    const unparsed = data([dispatch()], [inbound({ verb: null, text: 'we are on the way' })])
    assert.deepEqual(dueEscalations(unparsed, { now: LATER, env: ENV }), [])
  })

  it('does not let a stale inbox row silence a person forever', () => {
    // A reply from before the dispatch is not a response to it. If it counted,
    // one old message in the collection would suppress every future escalation
    // for that number — the failure mode where a feature gets switched off by
    // data nobody looks at again.
    const stale = data([dispatch()], [inbound({ received_at: '2026-09-01T00:00:00.000Z' })])
    const due = dueEscalations(stale, { now: LATER, env: ENV })
    assert.equal(due.length, 1)
    assert.equal(due[0].recipient, URN_A)
  })

  it('does not fire for a dispatch the gateway refused', () => {
    // Escalating a message RapidPro rejected would page a supervisor about an
    // outage on our side and about nobody being in danger.
    const failed = dispatch({ status: 'failed', response_status: 503, error: 'RapidPro HTTP 503' })
    assert.deepEqual(dueEscalations(data([failed]), { now: LATER, env: ENV }), [])
  })

  it('does not fire for the same person twice', () => {
    const raised = applyEscalation(dispatch(), { recipient: URN_A, at: '2026-10-01T08:31:00.000Z', escalate_to: [] })
    assert.deepEqual(dueEscalations(data([raised]), { now: LATER, env: ENV }), [])
  })

  it('measures from the first page, not the last', () => {
    // A rule that fires twice within the hour must not restart the clock on the
    // second page: the person has been unacknowledged for 45 minutes already.
    const second = dispatch({ id: 'd2', created_at: '2026-10-01T08:45:00.000Z' })
    const due = dueEscalations(data([dispatch(), second]), { now: '2026-10-01T08:46:00.000Z', env: ENV })
    assert.equal(due.length, 2)
    assert.equal(due[0].deadline_at, '2026-10-01T08:30:00.000Z')
  })

  it('pages only the person who is silent', () => {
    const two = dispatch({ recipients: { urns: [URN_A, URN_B], contacts: [], groups: [] } })
    const due = dueEscalations(data([two], [inbound()]), { now: LATER, env: ENV })
    assert.equal(due.length, 1)
    assert.equal(due[0].recipient, URN_B)
  })

  it('uses a severity-specific SLA', () => {
    const critical = dispatch({ severity: 'critical' })
    assert.equal(dueEscalations(data([critical]), { now: '2026-10-01T08:14:59.000Z', env: ENV }).length, 0)
    assert.equal(dueEscalations(data([critical]), { now: '2026-10-01T08:15:01.000Z', env: ENV }).length, 1)
  })

  it('reports an escalation with nowhere to go as unresolved', () => {
    // Saying "escalated" when RAPIDPRO_ESCALATION_URNS is unset claims a human
    // was summoned. Nobody was.
    const due = dueEscalations(data([dispatch()]), { now: LATER, env: {} })
    assert.equal(due.length, 1)
    assert.equal(due[0].escalation_target_unresolved, true)
    assert.deepEqual(due[0].escalate_to, [])
  })

  it('is a pure function of now, so it can be tested without waiting', () => {
    const snapshot = data([dispatch()])
    assert.deepEqual(dueEscalations(snapshot, { now: LATER, env: ENV }), dueEscalations(snapshot, { now: LATER, env: ENV }))
    assert.deepEqual(snapshot.rapidpro_dispatches[0].acknowledgements, undefined, 'it must not mutate the store')
  })

  it('escalates only against dispatches actually made before now', () => {
    const future = dispatch({ created_at: '2026-10-01T09:30:00.000Z' })
    assert.deepEqual(dueEscalations(data([future]), { now: LATER, env: ENV }), [])
  })
})

describe('delivery report', () => {
  const two = dispatch({ recipients: { urns: [URN_A, URN_B], contacts: [], groups: [] } })

  it('divides by identified recipients, not by dispatch count (ALERT-05)', () => {
    const report = deliveryReport(data([two], [inbound()]), { alert_event_id: 'alert_1', now: '2026-10-01T08:10:00.000Z' })
    assert.equal(report.ack_rate_pct, 50)
    assert.equal(report.ack_rate_basis, '1 of 2 identified recipients responded')
  })

  it('never exceeds 100 even with two replies from one person', () => {
    const store = data([two], [inbound(), inbound({ id: 'm2', source_id: 's2' })])
    const report = deliveryReport(store, { now: '2026-10-01T08:10:00.000Z' })
    assert.equal(report.ack_rate_pct, 50)
  })

  it('reports the rate as null when there is no identity to divide by', () => {
    const group = dispatch({ recipients: { urns: [], contacts: [], groups: ['district-leads'] } })
    const report = deliveryReport(data([group]), { now: '2026-10-01T08:10:00.000Z' })
    assert.equal(report.ack_rate_pct, null)
    assert.match(report.ack_rate_basis, /not computable/)
    assert.ok(report.notes.some((note) => /no dispatch in scope carries recipient identity/.test(note)))
  })

  it('scopes to one alert event when asked', () => {
    const other = dispatch({ id: 'd9', alert_event_id: 'alert_2' })
    const report = deliveryReport(data([two, other]), { alert_event_id: 'alert_1', now: '2026-10-01T08:10:00.000Z' })
    assert.equal(report.recipients.length, 2)
  })

  it('separates acknowledged from escalated and from rejected', () => {
    const store = data([two], [inbound(), inbound({ id: 'm3', from: '+254700000002', verb: 'NAK' })])
    const report = deliveryReport(store, { now: '2026-10-01T08:10:00.000Z' })
    assert.equal(report.counts.acknowledged, 1)
    assert.equal(report.counts.rejected, 1)
    assert.equal(report.counts.awaiting, 0)
  })

  it('lists escalations due and already raised without conflating them', () => {
    // A is acknowledged, B was already escalated: neither is due again, and the
    // report says which is which rather than showing "2 handled".
    const acknowledged = applyAcknowledgement(two, { from: URN_A, verb: 'ACK', received_at: '2026-10-01T08:04:00.000Z' })
    const raised = applyEscalation(acknowledged, { recipient: URN_B, at: '2026-10-01T08:31:00.000Z', escalate_to: [] })
    const report = deliveryReport(data([raised]), { now: '2026-10-01T09:00:00.000Z', env: ENV })
    assert.equal(report.escalations_due.length, 0)
    assert.equal(report.escalations_raised.length, 1)
    assert.equal(report.escalations_raised[0].urn, URN_B)
  })

  it('omits a dispatch created after the report instant', () => {
    const future = dispatch({ created_at: '2026-10-01T09:30:00.000Z' })
    const report = deliveryReport(data([future]), { now: '2026-10-01T09:00:00.000Z' })
    assert.equal(report.recipients.length, 0)
  })

  it('flags escalations that have nowhere to go', () => {
    const report = deliveryReport(data([two]), { now: '2026-10-01T09:00:00.000Z', env: {} })
    assert.ok(report.notes.some((note) => /RAPIDPRO_ESCALATION_URNS is unset/.test(note)))
  })
})

describe('delivery report, as an operator reads it', () => {
  const report = deliveryReport(
    data([dispatch({ recipients: { urns: [URN_A, URN_B], contacts: [], groups: [] } })], [inbound()]),
    { alert_event_id: 'alert_1', now: '2026-10-01T09:00:00.000Z', env: ENV },
  )
  const text = formatDeliveryReport(report)

  it('names the alert, the SLA, and the rate with its denominator', () => {
    assert.match(text, /alert_1/)
    assert.match(text, /SLA 30 min/)
    assert.match(text, /Acknowledgement rate: 50% \(1 of 2 identified recipients responded\)/)
  })

  it('lists every recipient with their state', () => {
    assert.match(text, /\+254700000001\s+acknowledged at 2026-10-01T08:04:00\.000Z/)
    assert.match(text, /\+254700000002\s+awaiting/)
  })

  it('shows the escalation that is due, and says where it would go', () => {
    assert.match(text, /Escalations due \(1\)/)
    assert.match(text, /deadline 2026-10-01T08:30:00\.000Z elapsed, no response → tel:\+254700000090/)
  })

  it('says NOT COMPUTABLE rather than printing an empty percentage', () => {
    const blind = deliveryReport(data([dispatch({ recipients: { urns: [], contacts: [], groups: ['g'] } })]), { now: T0 })
    assert.match(formatDeliveryReport(blind), /Acknowledgement rate: not computable/)
  })
})

describe('the outbound message teaches the grammar', () => {
  const alert = { id: 'alert_1', severity: 'high', rule_name: 'River gauge' }

  it('states the verbs and the deadline', () => {
    const text = ackInstructions(alert, {}, {})
    assert.match(text, /ACK\/ESCALATE\/RESOLVED\/NAK/)
    assert.match(text, /30 min/)
  })

  it('fits inside the 480-character budget formatAlertMessage enforces', () => {
    const long = 'Flooding. '.repeat(200)
    const text = withAckInstructions(long, alert, {}, {})
    assert.ok(text.length <= 480, `got ${text.length}`)
    assert.match(text, /We escalate if we hear nothing for 30 min\./)
  })

  it('does not truncate the instruction off the end', () => {
    const text = withAckInstructions('Flooding at Baringo bridge. '.repeat(30), alert, {}, {})
    assert.match(text, /ESCALATE/)
  })
})

describe('reply webhook input', () => {
  it('records an uncorrelated reply rather than dropping it', () => {
    const parsed = parseRapidProReply({ id: 's1', from: '+254709999999', text: 'ACK' }, data([]), { now: T0 })
    assert.equal(parsed.correlated, false)
    assert.equal(parsed.verb, 'ACK')
    assert.match(parsed.correlation_note, /recorded but closes no SLA/)
  })

  it('carries the parsed verb and reason onto the record', () => {
    const parsed = parseRapidProReply({ id: 's1', from: URN_A, text: 'ESCALATE no_access' }, data([dispatch()]), { now: T0 })
    assert.equal(parsed.verb, 'ESCALATE')
    assert.equal(parsed.reason_code, 'no_access')
    assert.equal(parsed.alert_event_id, 'alert_1')
    assert.equal(parsed.kind, 'reply')
  })

  it('prefers the reply id it can be reconciled against', () => {
    const parsed = parseRapidProReply({ id: 's1', from: URN_A, text: 'ACK' }, data([dispatch()]), { now: T0 })
    assert.equal(parsed.id, parseRapidProReply({ id: 's1', from: URN_A, text: 'ACK' }, data([dispatch()]), { now: T0 }).id)
  })
})
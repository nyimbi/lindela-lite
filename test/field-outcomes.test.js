import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import {
  FIELD_OUTCOME_CODES,
  fieldActionLatency,
  normalizeFieldOutcome,
  outcomeCounts,
} from '../src/field-outcomes.js'
import { dueEscalations, parseRapidProReply } from '../src/rapidpro.js'

/**
 * Phase E — the confirmation loop.
 *
 * The metric that exists measures SMS latency: how long after an alert the
 * gateway accepted the send. That is a number about software. This phase is
 * about the other end — a responder confirming the action happened — and the
 * two are not comparable, which is the entire reason this exists.
 *
 * Every test here fails against code with no `field_outcomes` collection, no
 * `DONE` verb and no confirmation route, which is a stronger form of failure
 * than a subtly-wrong number: there was no number to be wrong.
 */

const TOKENS = JSON.stringify([{ token: 'tok-admin', scopes: ['*'] }])
const T0 = '2026-10-08T06:00:00.000Z'
const WEBHOOK_SECRET = 'rapidpro-test-secret'

let listener, base, store, dir, previous, previousSecret

/**
 * Post a reply webhook, authenticated the way this route actually accepts.
 *
 * The shared secret, not an HMAC signature. `verifyRapidProWebhook` checks an
 * HMAC first and falls back to the shared secret, but `verifyBodySignature`
 * needs `req.rawBody`, and the reply route never buffers it — only
 * `field-report` does. So on `/reply` a signature header is compared against an
 * undefined body, always mismatches, and the route 401s no matter how
 * correctly the caller signed. (Worth knowing before anyone wires a signature in
 * production: it cannot work on this route without also buffering the body.)
 *
 * Authenticated rather than switched off, though: the platform refuses an
 * unconfigured secret outright, and the `LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED`
 * escape hatch would let these tests pass while the route only worked with auth
 * disabled — which is not the deployment anyone runs.
 */
const post = async (path, body, token = 'tok-admin') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rapidpro-secret': WEBHOOK_SECRET,
      ...(token ? { 'x-api-key': token } : {}),
    },
    body: JSON.stringify(body),
  })

const get = async (path, token = 'tok-admin') =>
  fetch(`${base}${path}`, { headers: token ? { 'x-api-key': token } : {} })

before(async () => {
  previous = process.env.LINDELA_LITE_TOKENS
  process.env.LINDELA_LITE_TOKENS = TOKENS
  delete process.env.RAPIDPRO_API_TOKEN
  previousSecret = process.env.RAPIDPRO_WEBHOOK_SECRET
  process.env.RAPIDPRO_WEBHOOK_SECRET = WEBHOOK_SECRET
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lindela-field-outcomes-'))
  store = new JsonStore(path.join(dir, 'store.json'))
  await store.write({
    trigger_protocols: [],
    alert_rules: [],
    alert_events: [],
    alert_outcomes: [],
    protocol_executions: [],
    incidents: [],
    interventions: [],
    intervention_tasks: [],
    field_outcomes: [],
    rapidpro_dispatches: [],
    rapidpro_inbound_messages: [],
    action_logs: [],
    hazard_events: [],
  })
  listener = createServer({ store }).listen(0)
  base = `http://localhost:${listener.address().port}`
})

after(async () => {
  listener?.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.LINDELA_LITE_TOKENS
  else process.env.LINDELA_LITE_TOKENS = previous
  if (previousSecret === undefined) delete process.env.RAPIDPRO_WEBHOOK_SECRET
  else process.env.RAPIDPRO_WEBHOOK_SECRET = previousSecret
})

/**
 * An alert plus a dispatch to one responder, so a reply can correlate.
 *
 * Two shape details are load-bearing and both are wrong by default:
 *
 * `recipients` is `{ urns: [...] }`, not an array of objects. `dispatchRecipients`
 * reads `recipients.urns`; given the object form it returns an empty list, every
 * recipient comes back `unidentified`, and a sender-key correlation finds no
 * candidate — so the reply is filed as an orphan and the test fails on a 202
 * where it expected a 200.
 *
 * `created_at` is recent rather than a fixed historical timestamp. Correlation
 * matches only inside a window measured from *now*, so a dispatch seeded at a
 * fixed past date falls outside it and every reply is uncorrelated.
 */
async function seedDispatch({ alertId = 'alert_1', from = 'tel:+254700000001', minutesAgo = 30 } = {}) {
  const createdAt = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  await store.merge({
    alert_events: [{
      id: alertId,
      rule_id: null,
      rule_name: 'Flood escalation',
      status: 'open',
      severity: 'high',
      created_at: createdAt,
      updated_at: createdAt,
      approval: { state: 'auto_approved', pre_authorised: true },
      metadata: { protocol_id: 'proto_1', pre_authorised: true },
    }],
    rapidpro_dispatches: [{
      id: `dispatch_${alertId}`,
      alert_event_id: alertId,
      status: 'sent',
      recipients: { urns: [from] },
      created_at: createdAt,
    }],
  })
  return { alertId, createdAt }
}

describe('a field outcome refuses what it cannot attribute', () => {
  it('requires an outcome code from the closed set', () => {
    assert.throws(
      () => normalizeFieldOutcome({ outcome_code: 'because_i_said_so', confirmed_by: 'w1' }),
      /outcome_code/,
    )
    assert.throws(
      () => normalizeFieldOutcome({ confirmed_by: 'w1' }),
      /outcome_code/,
    )
    for (const code of FIELD_OUTCOME_CODES) {
      const record = normalizeFieldOutcome({ outcome_code: code, confirmed_by: 'w1' })
      assert.equal(record.outcome_code, code)
    }
  })

  it('requires an author, because an unattributed confirmation is not evidence', () => {
    // A confirmation whose author is unknown cannot be audited and cannot be
    // counted as a person having acted, so it is refused rather than stored with
    // a null author — which would silently deflate the sample count instead.
    assert.throws(
      () => normalizeFieldOutcome({ outcome_code: 'vaccine_safe' }),
      /confirmed_by is required/,
    )
    assert.throws(
      () => normalizeFieldOutcome({ outcome_code: 'vaccine_safe', confirmed_by: '   ' }),
      /confirmed_by is required/,
    )
  })

  it('rejects a timestamp that is not a date', () => {
    assert.throws(
      () => normalizeFieldOutcome({ outcome_code: 'vaccine_safe', confirmed_by: 'w1', confirmed_at: 'yesterday' }),
      /ISO-8601/,
    )
  })

  it('keeps the free text beside the code rather than narrowing to it', () => {
    const record = normalizeFieldOutcome({
      outcome_code: 'vaccine_safe',
      confirmed_by: 'tel:+254700000001',
      note: 'fridge 3 at Baringo',
      channel: 'ussd',
    })
    assert.equal(record.note, 'fridge 3 at Baringo')
    assert.equal(record.channel, 'ussd')
    assert.equal(record.source, 'rapidpro_reply')
  })

  it('the id is stable for the same dispatch, author and time', () => {
    const input = { outcome_code: 'children_fed', confirmed_by: 'w1', dispatch_id: 'd1', confirmed_at: T0 }
    assert.equal(normalizeFieldOutcome(input).id, normalizeFieldOutcome(input).id)
  })
})

describe('the latency figure refuses rather than degrades', () => {
  const alert = (id, createdAt) => ({ id, created_at: createdAt })
  const outcome = (alertId, confirmedAt, code = 'vaccine_safe') =>
    normalizeFieldOutcome({ outcome_code: code, confirmed_by: `w-${alertId}`, alert_id: alertId, confirmed_at: confirmedAt })

  const hoursAfter = (base, h) => new Date(Date.parse(base) + h * 3_600_000).toISOString()

  it('refuses below five samples and says how many it had', () => {
    // One confirmation is one district's one incident. A median printed off it
    // would be one person's Tuesday with a decimal place on it.
    const data = {
      alert_events: [alert('a1', T0)],
      field_outcomes: [outcome('a1', hoursAfter(T0, 3))],
    }
    const result = fieldActionLatency(data)
    assert.match(result.refusal, /only 1 confirmed outcome/)
    assert.equal(result.samples, 1)
    assert.equal('median_hours' in result, false, 'a refusal must not also carry a figure')
  })

  it('reports a median at or above the floor, with its samples and its basis', () => {
    const hours = [2, 3, 4, 5, 6]
    const data = {
      alert_events: hours.map((_, i) => alert(`a${i}`, T0)),
      field_outcomes: hours.map((h, i) => outcome(`a${i}`, hoursAfter(T0, h))),
    }
    const result = fieldActionLatency(data)
    assert.equal(result.median_hours, 4)
    assert.equal(result.samples, 5)
    // The basis is load-bearing: the figure sits beside the SMS-latency figure
    // on the same dashboard and answers a different question.
    assert.match(result.basis, /not comparable to the SMS-latency figure/)
  })

  it('one very late confirmation does not drag the median', () => {
    // A responder whose phone was off for a week. With a mean, or with the
    // usual two-element average, this single case pushes the reported figure
    // past every other sample and makes five fast responses look slow.
    const hours = [2, 3, 4, 5, 6, 900]
    const data = {
      alert_events: hours.map((_, i) => alert(`a${i}`, T0)),
      field_outcomes: hours.map((h, i) => outcome(`a${i}`, hoursAfter(T0, h))),
    }
    assert.equal(fieldActionLatency(data).median_hours, 4)
  })

  it('excludes a confirmation it cannot time, and does not count it as a sample', () => {
    const data = {
      alert_events: [alert('a1', T0), ...[2, 3, 4, 5].map((n) => alert(`a${n}`, T0))],
      field_outcomes: [
        // No alert id at all: nothing to time against.
        normalizeFieldOutcome({ outcome_code: 'vaccine_safe', confirmed_by: 'orphan', confirmed_at: hoursAfter(T0, 1) }),
        // Confirmed before the alert was raised: a clock disagreement, not a
        // very fast response.
        outcome('a1', '2026-10-07T00:00:00.000Z'),
        ...[2, 3, 4, 5].map((n) => outcome(`a${n}`, hoursAfter(T0, n))),
      ],
    }
    const result = fieldActionLatency(data)
    assert.equal(result.samples, 4, 'unmeasurable cases must not inflate the denominator')
    assert.match(result.refusal, /only 4/)
  })

  it('period_start filters on when the alert was raised, not when it was confirmed', () => {
    // A quarter asking "how fast were we when these alerts were raised" must
    // not be answered by confirmations that arrived after the window closed.
    const hours = [2, 3, 4, 5, 6]
    const data = {
      alert_events: hours.map((_, i) => alert(`a${i}`, T0)),
      field_outcomes: hours.map((h, i) => outcome(`a${i}`, hoursAfter(T0, h))),
    }
    const afterAll = fieldActionLatency(data, { period_start: '2026-10-09T00:00:00.000Z' })
    assert.equal(afterAll.samples, 0)
    assert.match(afterAll.refusal, /only 0 confirmed outcome/)
    assert.equal(fieldActionLatency(data, { period_start: '2026-10-01T00:00:00.000Z' }).samples, 5)
  })

  it('counts by outcome code for the summary route', () => {
    const data = { field_outcomes: [
      outcome('a1', T0, 'supplies_arrived'),
      outcome('a2', T0, 'supplies_arrived'),
      outcome('a3', T0, 'vaccine_safe'),
    ] }
    assert.deepEqual(outcomeCounts(data), { supplies_arrived: 2, vaccine_safe: 1 })
  })
})

describe('DONE is its own verb, not a synonym for RESOLVED', () => {
  it('parses from SMS text with a code', () => {
    const parsed = parseRapidProReply({ from: 'tel:+254700000001', text: 'DONE vaccine_safe fridge 3' }, {})
    assert.equal(parsed.verb, 'DONE')
    assert.equal(parsed.reason_code, 'vaccine_safe')
    assert.equal(parsed.note, 'fridge 3')
  })

  it('parses from a USSD key press', () => {
    const parsed = parseRapidProReply({ from: 'tel:+254700000001', channel: { name: 'USSD' }, input: { ussd: '*5#' } }, {}, { now: T0 })
    assert.equal(parsed.verb, 'DONE')
    assert.equal(parsed.channel, 'ussd')
    assert.equal(parsed.text, '*5#', 'the raw session input is kept, not the mapped verb')
  })

  it('is terminal for the acknowledgement SLA, so a confirmer is not escalated', () => {
    // Asserted through `dueEscalations` rather than through the state constant,
    // because the constant is an implementation detail and the escalation is the
    // consequence: a CHW who replied "DONE supplies_arrived" and then still got
    // escalated for never acknowledging would be paged, and so would their
    // supervisor, about work already finished.
    //
    // The fixture is shaped to the real reader: `dispatchRecipients` maps
    // `recipients.urns`, and a `recipients` array of objects yields every
    // recipient as `unidentified` — which is silently skipped, so a
    // wrongly-shaped fixture produces zero escalations and the DONE assertion
    // would pass without proving anything. The `withNothing` half of the test is
    // what catches that: it requires the fixture to escalate before the DONE
    // case can mean anything.
    const dispatch = {
      id: 'd_done',
      alert_event_id: 'a_done',
      severity: 'critical',
      status: 'sent',
      created_at: T0,
      recipients: { urns: ['tel:+254700000001'] },
    }
    const longAfter = new Date(Date.parse(T0) + 6 * 3_600_000).toISOString()
    const base = { alert_events: [], rapidpro_dispatches: [dispatch] }

    const withNothing = dueEscalations({ ...base, rapidpro_inbound_messages: [] }, { now: longAfter, env: {} })
    const withDone = dueEscalations({
      ...base,
      rapidpro_inbound_messages: [{
        id: 'i1', alert_event_id: 'a_done', verb: 'DONE', reason_code: 'supplies_arrived',
        // `from` is what ties the reply to the recipient. An inbound with an
        // alert_event_id but no sender matches nobody, so the recipient is still
        // `awaiting` and the escalation fires — the test would then appear to
        // prove the opposite of what it claims.
        from: 'tel:+254700000001',
        received_at: longAfter, created_at: longAfter,
      }],
    }, { now: longAfter, env: {} })

    assert.ok(withNothing.length > 0, 'the fixture does not escalate at all, so the DONE case proves nothing')
    assert.equal(withDone.length, 0, 'a responder who confirmed the action was escalated anyway')
  })
})

describe('a correlated DONE writes both the inbound and the outcome', () => {
  it('creates one field_outcomes row in the same merge as the reply', async () => {
    await seedDispatch()
    const res = await post('/api/v1/rapidpro/reply', {
      from: 'tel:+254700000001',
      text: 'DONE supplies_arrived 2 crates at Baringo',
      received_on: '2026-10-08T08:00:00.000Z',
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.correlated, true)
    assert.equal(body.field_outcome, 'recorded')
    assert.ok(body.field_outcome_id, 'the caller must be able to learn whether it became an outcome')

    const data = await store.read()
    assert.equal(data.field_outcomes.length, 1)
    const [outcome] = data.field_outcomes
    assert.equal(outcome.outcome_code, 'supplies_arrived')
    assert.equal(outcome.alert_id, 'alert_1')
    assert.equal(outcome.dispatch_id, 'dispatch_alert_1')
    // The normalised sender, not the raw `tel:` form. `normalizeSender` is what the
// correlation and the recipient matching both key on, so storing the raw string
// would put two spellings of the same person in the audit trail and make
// "confirmed_by" a field that cannot be compared.
    assert.equal(outcome.confirmed_by, '+254700000001')
    // The note survives beside the code.
    assert.match(outcome.note, /2 crates at Baringo/)
    // And the inbound is still there — the reply log is not replaced by the
    // outcome, it is joined to it.
    assert.equal(data.rapidpro_inbound_messages.length, 1)
    assert.equal(data.rapidpro_inbound_messages[0].verb, 'DONE')
    assert.ok(
      data.action_logs.some((log) => log.collection === 'field_outcomes'),
      'the outcome is written without an audit row',
    )
    await store.write({ field_outcomes: [], rapidpro_inbound_messages: [] })
  })

  it('a DONE with no recognised code is kept as a reply and refused as an outcome', async () => {
    // "DONE" with no code says a person replied. Recording it under an invented
    // `other` would manufacture exactly the aggregation the closed set exists to
    // keep honest.
    await seedDispatch({ alertId: 'alert_nc', from: 'tel:+254700000002' })
    const res = await post('/api/v1/rapidpro/reply', {
      from: 'tel:+254700000002',
      text: 'DONE something I will not categorise',
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.verb, 'DONE')
    assert.match(body.field_outcome, /refused/)

    const data = await store.read()
    assert.equal(data.field_outcomes.length, 0)
    assert.equal(data.rapidpro_inbound_messages.length, 1, 'the reply itself must not be lost')
    await store.write({ field_outcomes: [], rapidpro_inbound_messages: [] })
  })

  it('an uncorrelated DONE is an orphan inbound and confirms nothing', async () => {
    // No dispatch from this sender, so there is no alert to time it against and
    // no author to attribute it to. Same rule as every other unrecognised reply.
    //
    // State is cleared first because the previous cases leave an outcome behind,
    // and a shared store across cases means this assertion would otherwise be
    // checking the last test's rows rather than its own.
    await store.write({ field_outcomes: [], rapidpro_inbound_messages: [] })
    const res = await post('/api/v1/rapidpro/reply', {
      from: 'tel:+254799999999',
      text: 'DONE vaccine_safe',
    })
    assert.equal(res.status, 202)
    const body = await res.json()
    assert.equal(body.correlated, false)
    const data = await store.read()
    assert.equal(data.field_outcomes.length, 0)
    await store.write({ rapidpro_inbound_messages: [] })
  })

  it('a plain ACK writes no field outcome at all', async () => {
    await seedDispatch({ alertId: 'alert_ack', from: 'tel:+254700000003' })
    const res = await post('/api/v1/rapidpro/reply', {
      from: 'tel:+254700000003',
      text: 'ACK on my way',
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.field_outcome, null, 'an acknowledgement is not a confirmation of action')
    assert.equal((await store.read()).field_outcomes.length, 0)
    await store.write({ rapidpro_inbound_messages: [] })
  })
})

describe('the quarterly KPI publishes the figure it previously said did not exist', () => {
  it('carries both warning-to-action figures, and they are not the same number', async () => {
    // `warning_to_action_is_field_outcome: false` has always been published
    // beside the dispatch latency, and the `WARNING_TO_ACTION_LIMIT` sentence
    // says in words that it is not a field action. This adds the field figure it
    // was disclaiming, so a reader is given the alternative rather than only the
    // caveat.
    const { computeQuarterlyKpi } = await import('../src/kpi.js')
    const kpi = computeQuarterlyKpi({ alert_events: [], field_outcomes: [] }, { quarter: 'Q1', year: 2026 })

    assert.equal(kpi.warning_to_action_is_field_outcome, false)
    assert.equal(kpi.warning_to_action_field_median_hours, null)
    assert.equal(kpi.warning_to_action_field_samples, 0)
    assert.match(kpi.warning_to_action_field_refusal, /fewer than 5/)
    // The refusal is also a data gap, so it is counted where every other
    // unmeasurable figure is counted.
    assert.ok(
      kpi.data_gaps.some((gap) => gap.field === 'warning_to_action_field_median_hours'),
      'a refusal the data_gaps list does not carry will not be counted anywhere',
    )
  })

  it('reports the median and the samples once the floor is met', async () => {
    const { computeQuarterlyKpi } = await import('../src/kpi.js')
    // Alerts raised inside the quarter, so period_start admits them.
    // Alerts raised a few days into the quarter, so `period_start` admits them.
    const from = '2026-01-01'
    const hours = [2, 3, 4, 5, 6]
    const raised = new Date(Date.parse(from) + 3 * 86_400_000).toISOString()
    const data = {
      alert_events: hours.map((_, i) => ({
        id: `k${i}`,
        severity: 'high',
        created_at: raised,
      })),
      field_outcomes: hours.map((h, i) => normalizeFieldOutcome({
        outcome_code: 'supplies_arrived',
        confirmed_by: `w${i}`,
        alert_id: `k${i}`,
        confirmed_at: new Date(Date.parse(raised) + h * 3_600_000).toISOString(),
      })),
    }
    const kpi = computeQuarterlyKpi(data, { quarter: 'Q1', year: 2026 })
    assert.equal(kpi.warning_to_action_field_median_hours, 4)
    assert.equal(kpi.warning_to_action_field_samples, 5)
    assert.equal(kpi.warning_to_action_field_refusal, null)
    assert.match(kpi.warning_to_action_field_basis, /not comparable to the SMS-latency figure/)
  })

  it('the PDF text and Markdown both carry the row, refusal included', async () => {
    const { renderQuarterlyReportMarkdown } = await import('../src/pdf.js')
    const { computeQuarterlyKpi } = await import('../src/kpi.js')
    const kpi = computeQuarterlyKpi({ alert_events: [], field_outcomes: [] }, { quarter: 'Q1', year: 2026 })
    const md = renderQuarterlyReportMarkdown(kpi)
    assert.match(md, /Warning-to-field-action median/)
    // The refusal is printed as the value, not as a dash: a dash reads as "we do
    // not know" and gets skipped past.
    assert.match(md, /not reported: only 0 confirmed outcome/)
  })
})

describe('the outcomes routes answer with the figure or the refusal', () => {
  it('lists confirmations paged', async () => {
    const res = await get('/api/v1/field-outcomes?limit=10')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.ok('total' in body, 'a list with no total cannot be told from a truncated one')
    await store.write({ field_outcomes: [] })
  })

  it('summarises, and never answers with a bare null where a refusal is owed', async () => {
    const res = await get('/api/v1/field-outcomes/summary')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.equal(body.total, 0)
    // The refusal travels as a sentence. A null renders as a dash, and a dash
    // reads as "zero hours" or "no data" — the sentence is what distinguishes them.
    assert.match(body.refusal, /fewer than 5 is not a figure/)
    assert.equal(body.median_hours, undefined)
  })

  it('requires a token when auth is configured', async () => {
    const res = await get('/api/v1/field-outcomes/summary', null)
    assert.equal(res.status, 401)
  })
})
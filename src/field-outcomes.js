/**
 * Field-outcome confirmation: the other end of warning-to-action.
 *
 * The metric that exists today measures SMS latency — how long after an alert
 * the gateway accepted the send. That is a number about the software. The claim
 * this module exists to support is a number about the ground: how long from an
 * alert being raised to a responder confirming the action actually happened.
 *
 * The two are not comparable and the difference is the whole point. A carrier
 * DLR says a handset received a message; a `DONE` reply says a person read it
 * and did something. Measuring the first and calling it action latency is how a
 * system reports 4-minute warning-to-action while the water arrives tomorrow.
 *
 * So `fieldActionLatency` refuses rather than degrades: below its sample floor it
 * returns a `refusal` string and no figure. A median from three confirmations is
 * not a weak median, it is one person's Tuesday, and printing it with a decimal
 * place would let it be compared against the SMS figure it is not comparable to.
 */

import { REPLY_REASON_CODES } from './rapidpro.js'
import { stableId, toNumber } from './utils.js'

/**
 * Outcome codes a responder can confirm.
 *
 * The four `DONE` reason codes plus `other`. Reusing the reply grammar's own
 * closed set is deliberate: the code arrives from a text message typed by
 * someone on a phone, so the set has to be one a responder can type, and two
 * lists that disagree would leave confirmations that parse and then cannot be
 * categorised.
 */
export const FIELD_OUTCOME_CODES = Object.freeze([
  'supplies_arrived',
  'vaccine_safe',
  'clinic_triaged',
  'children_fed',
  'other',
])

/**
 * Below this many confirmations, no median is reported.
 *
 * Five is not a statistical threshold and is not presented as one. It is the
 * point at which the figure stops describing the people who happened to answer
 * and starts describing the response. One confirmation is one district's one
 * incident, and a dashboard that prints "warning to field action: 6.2 h" off it
 * invites a quarterly comparison it cannot support.
 */
export const LATENCY_MIN_SAMPLES = 5

function isoDate(value, field) {
  const raw = value || new Date().toISOString()
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) {
    throw Object.assign(new Error(`${field} must be an ISO-8601 timestamp`), { statusCode: 400 })
  }
  return new Date(parsed).toISOString()
}

function enumOrThrow(value, allowed, field) {
  if (!value || !allowed.includes(value)) {
    throw Object.assign(new Error(`${field} is required and must be one of ${allowed.join(', ')}`), { statusCode: 400 })
  }
  return value
}

/**
 * Normalise one confirmation.
 *
 * `outcome_code` is required and closed. `note` holds the free text that
 * followed the code on the reply, so nothing a responder typed is discarded —
 * "DONE vaccine_safe fridge 3 at Baringo" becomes the code `vaccine_safe` plus
 * the note, rather than being narrowed to the code or kept only as prose.
 *
 * `confirmed_by` is required, and required to be *somebody*. A confirmation
 * whose author is unknown cannot be attributed in an audit trail and cannot be
 * counted as evidence that a person acted, so it is refused rather than stored
 * with a null author.
 */
export function normalizeFieldOutcome(input, existing = null) {
  const now = new Date().toISOString()
  const outcomeCode = enumOrThrow(
    input.outcome_code ?? existing?.outcome_code,
    FIELD_OUTCOME_CODES,
    'outcome_code',
  )
  const confirmedBy = String(input.confirmed_by ?? existing?.confirmed_by ?? '').trim()
  if (!confirmedBy) {
    throw Object.assign(new Error('confirmed_by is required: a confirmation with no author is not evidence that a person acted'), { statusCode: 400 })
  }
  const confirmedAt = isoDate(input.confirmed_at ?? existing?.confirmed_at, 'confirmed_at')

  return {
    id: existing?.id || input.id || stableId('field_outcome', [input.dispatch_id, confirmedBy, confirmedAt]),
    // `alert_id` is what makes the latency computation possible at all: the
    // figure is the gap between the alert being raised and the confirmation
    // arriving, and that join has to exist on the record rather than be
    // inferred from a dispatch that may have been sent to several people.
    alert_id: input.alert_id ?? existing?.alert_id ?? null,
    dispatch_id: input.dispatch_id ?? existing?.dispatch_id ?? null,
    // Carried, not required: a confirmation whose playbook created no
    // intervention has nothing to point at, and a null here is the honest value
    // rather than a reason to refuse a real confirmation.
    intervention_id: input.intervention_id ?? existing?.intervention_id ?? null,
    outcome_code: outcomeCode,
    note: input.note ?? existing?.note ?? null,
    confirmed_by: confirmedBy,
    confirmed_at: confirmedAt,
    // Which channel the confirmation came in on. USSD/IVR has no room for a
    // code and a note, so a `DONE` from key 5 arrives with the outcome implied
    // rather than typed — and this field is what later tells an auditor whether
    // that was the case.
    channel: input.channel ?? existing?.channel ?? 'sms',
    source: input.source ?? existing?.source ?? 'rapidpro_reply',
    first_seen_at: existing?.first_seen_at || now,
    created_at: existing?.created_at || now,
    updated_at: now,
  }
}

/**
 * Lower median rather than mean, and rather than the usual two-element average.
 *
 * The reason is the same one `src/assertions.js` gives its own median: one
 * confirmation 400 hours late, because the responder's phone was off for a week,
 * must not drag the reported figure past every other sample. Averaging the
 * middle pair of [2, 3, 4, 5, 900] hands back 4.5 and the single stranded case
 * vanishes; the lower median returns 4 and the tail is still visible in the
 * sample count.
 */
function lowerMedian(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!numbers.length) return null
  return numbers[Math.floor((numbers.length - 1) / 2)]
}

/**
 * Warning-to-field-action, in hours.
 *
 * Hours, not minutes: the interesting range runs from "the clinic is two hours
 * away" to "the county office takes a day to send anything", and a figure in
 * minutes turns both into two and three digits with nothing in common.
 *
 * The returned `basis` is not decoration. Every number this platform publishes
 * carries the sentence saying what it measured and what it is not, because the
 * figure sitting next to it on the same dashboard — SMS latency — answers a
 * different question from the same word "latency".
 *
 * @param {object} data the store
 * @param {object} [options] `minSamples` overrides the floor; `period_start`
 *   restricts to alerts raised on or after it, which is how the quarterly KPI
 *   computes the figure for its own window rather than all time.
 */
export function fieldActionLatency(data, { minSamples = LATENCY_MIN_SAMPLES, period_start = null } = {}) {
  const outcomes = (data?.field_outcomes || []).filter((outcome) => outcome?.confirmed_at)
  const alertsById = new Map((data?.alert_events || []).map((alert) => [alert.id, alert]))
  const since = period_start ? Date.parse(period_start) : null

  const hours = []
  for (const outcome of outcomes) {
    const alert = outcome.alert_id ? alertsById.get(outcome.alert_id) : null
    // A confirmation whose alert is not in the store cannot be timed against
    // anything. It is skipped rather than dropped from the sample count: the
    // confirmation happened, we simply cannot say how long it took, and counting
    // it as a sample would inflate the denominator with unmeasurable cases.
    if (!alert?.created_at) continue
    const raised = Date.parse(alert.created_at)
    const confirmed = Date.parse(outcome.confirmed_at)
    if (!Number.isFinite(raised) || !Number.isFinite(confirmed)) continue
    // With `period_start`, the alert's own creation decides membership, not the
    // confirmation. A quarter that asked "how fast were we when these alerts
    // were raised" must not be answered by confirmations that arrived later.
    if (since !== null && !(Number.isFinite(since) && raised >= since)) continue
    // A confirmation dated before the alert is a clock disagreement or a
    // mis-keyed message. Negative hours are not a fast response, so they are
    // excluded rather than reported as a record.
    if (confirmed < raised) continue
    hours.push((confirmed - raised) / 3_600_000)
  }

  if (hours.length < minSamples) {
    return {
      refusal: `only ${hours.length} confirmed outcome(s); a median from fewer than ${minSamples} is not a figure`,
      samples: hours.length,
    }
  }

  return {
    median_hours: round1(lowerMedian(hours)),
    samples: hours.length,
    basis: 'median hours from protocol/rule alert creation to a responder DONE confirmation on the same alert; a confirmation is evidence a person sent, not a dispatch-DLR; not comparable to the SMS-latency figure',
  }
}

function round1(value) {
  return value === null ? null : Math.round(value * 10) / 10
}

/** Counts by outcome code, for the summary route. */
export function outcomeCounts(data) {
  const rows = data?.field_outcomes || []
  const counts = {}
  for (const row of rows) {
    const code = row?.outcome_code
    if (code) counts[code] = (counts[code] || 0) + 1
  }
  return counts
}

/**
 * Reason codes a `DONE` reply may carry, as a set for cheap membership tests.
 *
 * Exported because the reply route has to decide whether an inbound `DONE` is a
 * field outcome before it has parsed the code, and re-deriving the list from
 * `REPLY_REASON_CODES` at the call site would let the two drift.
 */
export const DONE_OUTCOME_CODES = new Set(
  REPLY_REASON_CODES.filter((code) => FIELD_OUTCOME_CODES.includes(code)),
)

/** `toNumber` is re-exported for the route's own parsing of a threshold. */
export { toNumber }
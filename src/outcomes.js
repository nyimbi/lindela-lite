import { stableId, toNumber } from './utils.js'

/**
 * ENH-19 — the outcome channel.
 *
 * Every calibration surface this platform has shipped reports "not estimable",
 * and the reason is one line long: nothing records whether the warning was
 * justified. `false_alert` is a field on the alert, filled in by hand when
 * somebody remembers, and a free-text `resolution_note` was read as a
 * substitute for a long time — the confirmed miss on Mandera reads "Reading
 * traced to a faulty sensor", which matches no keyword any of those readers
 * looked for.
 *
 * So the determination becomes a record with a *reason from a closed set*, a
 * person, a time, and whatever evidence was attached. A free-text note cannot be
 * a denominator: it cannot be counted, aggregated, or compared across districts.
 * This one can.
 *
 * The reasons are the interesting part. `false` is not one judgement — a sensor
 * that read high, a threshold set for a different season, a duplicate of an
 * alert already open, and a warning that was simply wrong are four different
 * defects with four different fixes, and a metric that lumps them together tells
 * an operator only that the false-alert rate is high.
 */
export const DETERMINATIONS = Object.freeze(['justified', 'false'])

export const OUTCOME_REASONS = Object.freeze({
  justified: [
    'hazard_occurred_as_warned',
    'action_taken_in_time',
    'confirmed_by_ground_report',
    'confirmed_by_partner',
  ],
  false: [
    'sensor_fault',
    'threshold_mistuned',
    'duplicate_of_open_alert',
    'no_hazard_observed',
    'data_stale_or_missing',
  ],
})

/** Every reason, for a client that wants to render the choice. */
export function outcomeReasons(determination = null) {
  if (determination) {
    return { determination, reasons: [...(OUTCOME_REASONS[determination] || [])] }
  }
  return {
    determinations: [...DETERMINATIONS],
    reasons: Object.fromEntries(
      Object.entries(OUTCOME_REASONS).map(([key, list]) => [key, [...list]]),
    ),
  }
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

/**
 * Normalise an outcome submission.
 *
 * Rejections are specific and they are refusals, not coercions: a determination
 * that is not in the closed set is refused rather than stored as "something
 * else", because a denominator that quietly excludes unrecognised values is the
 * defect this record exists to end.
 */
export function normalizeAlertOutcome(input, { existing = null, now = new Date().toISOString() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('an alert outcome must be a JSON object')
  }
  const alertEventId = input.alert_event_id || existing?.alert_event_id
  if (!alertEventId) throw badRequest('alert_event_id is required: an outcome without the alert it is about is not an outcome')

  const determination = String(input.determination ?? existing?.determination ?? '').toLowerCase()
  if (!DETERMINATIONS.includes(determination)) {
    throw badRequest(`determination must be one of ${DETERMINATIONS.join(', ')} (got ${JSON.stringify(input.determination)})`)
  }

  const reason = String(input.reason ?? existing?.reason ?? '')
  const allowed = OUTCOME_REASONS[determination]
  if (!allowed.includes(reason)) {
    // The list is the reason this record is countable: `false` with the reason
    // "sensor_fault" is a repair ticket, and "false" with the reason "it just
    // looked wrong" is not a category anyone can act on.
    throw badRequest(`reason must be one of ${allowed.join(', ')} for a "${determination}" determination (got ${JSON.stringify(reason)})`)
  }

  const determinedBy = input.determined_by ?? existing?.determined_by
  if (!determinedBy) throw badRequest('determined_by is required: an outcome nobody owns is a claim, not a determination')

  // A correction is a new record; a retry is the same record. Distinguishing them
  // on the judgement itself rather than on the clock is what makes the route
  // idempotent *and* keeps the history: a mobile client that retries after a
  // dropped response must not file two determinations, and an operator who
  // changed their mind must not overwrite the first one.
  const sameJudgement = existing
    && existing.determination === determination
    && existing.reason === reason
  const superseding = existing && !sameJudgement

  return {
    id: input.id
      || (existing && sameJudgement ? existing.id : null)
      || stableId('outcome', [alertEventId, determination, reason, now]),
    type: 'alert_outcome',
    alert_event_id: alertEventId,
    determination,
    false_alert: determination === 'false',
    reason,
    // Narrative, and deliberately not load-bearing: the reason above is what
    // counts, and a note that contradicts it changes nothing.
    note: String(input.note ?? existing?.note ?? '').slice(0, 2000),
    determined_by: determinedBy,
    determined_at: input.determined_at || existing?.determined_at || now,
    // What the determination was made against. Ids rather than values: the
    // values are in the records, and a copied number goes stale silently.
    evidence_record_ids: Array.isArray(input.evidence_record_ids)
      ? input.evidence_record_ids.map(String).slice(0, 50)
      : (existing?.evidence_record_ids || []),
    // A correction is recorded, not overwritten. The first determination is
    // part of the record: "we were wrong, and then we found we were wrong
    // again" is a different signal from "we never got it right".
    supersedes: superseding ? existing.id : (input.supersedes ?? existing?.supersedes ?? null),
    revision: superseding ? toNumber(existing.revision, 1) + 1 : toNumber(existing?.revision, 0) + 1,
    created_at: existing?.created_at || now,
    updated_at: now,
  }
}

/**
 * The determination an alert carries, from its outcomes.
 *
 * The latest revision wins, and an alert with no outcome has none — `null`, not
 * `false`. That distinction is the whole defect ENH-50 was filed for: an
 * unreviewed alert folded into the denominator as sound is how a district with
 * a confirmed miss reported 0%.
 */
export function determinationFor(alertEventId, outcomes = []) {
  const forEvent = outcomes
    .filter((outcome) => outcome.alert_event_id === alertEventId)
    .sort((a, b) => (a.revision ?? 1) - (b.revision ?? 1)
      || String(a.determined_at).localeCompare(String(b.determined_at)))
  if (!forEvent.length) return null
  return forEvent[forEvent.length - 1]
}

/**
 * Attach the projection every existing consumer already reads.
 *
 * `alert.false_alert` is what the metric registry, the district page and the
 * equity table all read, and replacing those with a join would be three
 * re-implementations of a definition that already caused this class of defect
 * twice. So the field stays and is written from the outcome — one writer, in
 * one place, with a test asserting the two never disagree.
 */
export function projectDetermination(alertEvent, outcome) {
  if (!alertEvent) return alertEvent
  if (!outcome) {
    const { false_alert, ...rest } = alertEvent
    return rest
  }
  return {
    ...alertEvent,
    false_alert: outcome.false_alert,
    outcome_id: outcome.id,
    outcome_reason: outcome.reason,
    determined_at: outcome.determined_at,
  }
}

/** The rollup a calibration surface needs: counted, false, and still unknown. */
export function outcomeTally(alerts = [], outcomes = []) {
  const byEvent = new Map()
  for (const outcome of outcomes) {
    const current = byEvent.get(outcome.alert_event_id)
    if (!current || (outcome.revision ?? 1) >= (current.revision ?? 1)) {
      byEvent.set(outcome.alert_event_id, outcome)
    }
  }
  let determined = 0
  let falseAlerts = 0
  let justified = 0
  const byReason = {}
  for (const outcome of byEvent.values()) {
    determined += 1
    if (outcome.determination === 'false') falseAlerts += 1
    else justified += 1
    const key = `${outcome.determination}:${outcome.reason}`
    byReason[key] = (byReason[key] || 0) + 1
  }
  return {
    alerts: alerts.length,
    determined,
    justified,
    false_alerts: falseAlerts,
    // The number that makes "we do not know" a measurement rather than a
    // feeling. A platform with 400 alerts and 12 determinations is not
    // calibrated; it is unmeasured, and the two must not look alike.
    undetermined: Math.max(0, alerts.length - determined),
    coverage: alerts.length ? Number((determined / alerts.length).toFixed(4)) : null,
    by_reason: byReason,
  }
}

import { apiFetch } from './runtime.js'

/**
 * The determination surface — ENH-19's other half.
 *
 * The outcome channel on the server is worthless without somebody entering one.
 * Every calibration surface this platform ships reports "not estimable" for the
 * same reason: nothing records whether the warning was justified, and the only
 * way to record it was to edit a field by hand in a store, if you knew it
 * existed. So the API and the metric registry were built and the product could
 * still not learn whether it was right.
 *
 * This is that entry point: an operator reads an alert, decides whether it was
 * justified, and picks *why* from a closed set. The reasons are the substance.
 * "False" is five different defects — a sensor fault is a maintenance visit, a
 * mistuned threshold is a rule change, and a metric that lumps them together
 * tells an operator only that the number is high.
 *
 * Pure where it can be. `determinationFor` is the decision the dialog makes
 * about what to show, and it is exported and tested directly, because a dialog
 * that renders is not a dialog that decides correctly.
 */

/** Shown when the catalogue cannot be fetched and we must not pretend to know it. */
const FALLBACK_REASONS = {
  justified: ['hazard_occurred_as_warned', 'action_taken_in_time'],
  false: ['sensor_fault', 'threshold_mistuned', 'no_hazard_observed'],
}

/**
 * What the dialog should offer for this alert.
 *
 * Three cases and the distinction matters more than the markup:
 *
 *   - an alert already determined shows *what* was recorded and offers a
 *     correction, because a determination somebody changed their mind about is
 *     not the same as one nobody made;
 *   - an open alert with nothing recorded offers the choice;
 *   - an alert that is neither — no id, no state — offers nothing rather than a
 *     form that cannot be submitted.
 */
export function determinationFor(alert, { reasons = FALLBACK_REASONS } = {}) {
  if (!alert || !alert.id) {
    return { kind: 'unavailable', reason: 'this row has no alert id, so a determination could not be attached to it' }
  }
  const determination = alert.false_alert === true || alert.false_alert === false
    ? (alert.false_alert ? 'false' : 'justified')
    : null
  if (determination) {
    return {
      kind: 'recorded',
      determination,
      reason: alert.outcome_reason || null,
      determined_at: alert.determined_at || null,
      determined_by: alert.determined_by || null,
      // The reasons offered for a *correction* are the union: a correction may
      // legitimately move from "sensor fault" to "threshold mistuned", which is
      // not available from either list alone.
      reasons: { ...reasons, justified: reasons.justified, false: reasons.false },
    }
  }
  return { kind: 'offered', reasons }
}

/**
 * The sentence the rail shows about calibration coverage.
 *
 * The number an operator needs *before* any rate: a false-alert rate computed
 * from twelve determinations out of four hundred alerts describes a sample nobody
 * chose, and the registry will happily publish it if the twelve clear its floor.
 * Stating the coverage next to the panel is what makes "why should I believe
 * this number" answerable without reading the registry's source.
 */
export function coverageNote(tally, { t } = {}) {
  if (!tally || !Number.isFinite(tally.alerts)) return ''
  const { alerts, determined, false_alerts: falseAlerts, justified } = tally
  const pct = alerts ? Math.round((determined / alerts) * 100) : 0
  const label = t || ((s, vars) => `${s}: ${Object.values(vars || {}).join(' ')}`)
  if (determined === 0) {
    return label('outcome.coverage_none', { alerts, pct })
  }
  return label('outcome.coverage_some', {
    alerts,
    determined,
    pct,
    false_alerts: falseAlerts,
    justified,
  })
}

/** Reasons as `<option>` elements, with the raw value preserved. */
export function reasonOptions(list, selected) {
  return (list || [])
    .map((reason) => `<option value="${reason}"${reason === selected ? ' selected' : ''}>${humanReason(reason)}</option>`)
    .join('')
}

/**
 * A reason id as words.
 *
 * The ids are the storage vocabulary and the words are a person's. `sensor_fault`
 * in a dropdown is a bug report to nobody; "Sensor fault — the reading, not the
 * rain" is a decision somebody can make.
 */
const REASON_WORDS = {
  hazard_occurred_as_warned: 'The hazard happened as warned',
  action_taken_in_time: 'Action was taken in time',
  confirmed_by_ground_report: 'A ground report confirms it',
  confirmed_by_partner: 'A partner confirms it',
  sensor_fault: 'Sensor fault — the reading, not the rain',
  threshold_mistuned: 'Threshold mistuned for this season',
  duplicate_of_open_alert: 'Duplicate of an alert already open',
  no_hazard_observed: 'No hazard was observed',
  data_stale_or_missing: 'The data was stale or missing',
}

export function humanReason(reason) {
  return REASON_WORDS[reason] || String(reason || '').replace(/_/g, ' ')
}

/**
 * Submit a determination.
 *
 * Returns `{ ok, error }` rather than throwing, because every caller here is a
 * click handler inside a re-rendering panel: an exception would leave the dialog
 * open with no explanation, which is the failure mode the dispatch gate already
 * had once.
 */
export async function submitOutcome({ alertId, determination, reason, determinedBy, note }, { post } = {}) {
  if (!alertId) return { ok: false, error: 'no alert was selected' }
  if (determination !== 'justified' && determination !== 'false') {
    return { ok: false, error: 'choose whether the alert was justified' }
  }
  if (!reason) return { ok: false, error: 'choose a reason — a bare verdict cannot be counted' }
  if (!determinedBy) return { ok: false, error: 'say who determined it' }
  if (typeof post !== 'function') {
    // The poster is injected rather than imported: the console's `postJson`
    // carries the auth header and lives in `app.js`, and importing a 4,000-line
    // module to reach one function is how a shared module ends up importing the
    // whole console. The refusal is explicit so a caller cannot silently post
    // unauthenticated.
    throw new Error('submitOutcome needs a `post` function; the caller owns the auth header')
  }
  const payload = await post(`/api/v1/alert-events/${encodeURIComponent(alertId)}/outcome`, {
    determination,
    reason,
    determined_by: determinedBy,
    note: note || undefined,
  })
  return payload.success
    ? { ok: true, data: payload.data }
    : { ok: false, error: payload.error || 'the server gave no reason' }
}

/**
 * The fetch for the coverage line. Failure is not an error state: an unanswerable
 * tally means the rail says nothing about coverage rather than claiming zero.
 */
export async function fetchCoverage({ fetchImpl = apiFetch } = {}) {
  // `apiFetch` rather than a raw fetch, and that is not a style preference: it
  // is what puts a timeout and an `ok` check on this request. The tally is
  // cosmetic — a line above the alert list — and on a weak link a request with
  // no timeout never settles, so the console sits with a pending coverage line
  // for the life of the page.
  //
  // A throw is caught for the same reason as a non-OK response: this is an
  // offline-first console, and "the tally could not be fetched" is the common
  // case rather than the exceptional one.
  try {
    const payload = await fetchImpl('/api/v1/alert-outcomes/tally')
    if (!payload.ok) return null
    const body = await payload.json()
    return body.success ? body.data : null
  } catch {
    return null
  }
}

/** The reason catalogue, fetched once per dialog. Never invented locally. */
export async function fetchReasons({ fetchImpl = apiFetch } = {}) {
  try {
    const payload = await fetchImpl('/api/v1/alert-outcomes/reasons')
    if (!payload.ok) return FALLBACK_REASONS
    const body = await payload.json()
    return body.success ? body.data.reasons : FALLBACK_REASONS
  } catch {
    return FALLBACK_REASONS
  }
}
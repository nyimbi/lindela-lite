import { determinationFor } from './outcomes.js'

/**
 * ENH-73 — how long it takes to reach a decision, measured rather than assumed.
 *
 * The console redesign's premise is a cognitive-cost hypothesis: a command band
 * cut from 195px to 55px, controls moved above the fold, a triage order instead
 * of recency. Nothing measured whether any of it worked. A layout change whose
 * benefit is asserted and never observed is a belief with a commit behind it.
 *
 * **What is measured.** The interval from an alert being raised (`created_at`)
 * to a determination being filed against it (`determined_at`). That is the one
 * decision the platform records with both endpoints, and it is a real one: an
 * operator read the alert and judged it justified or false. Everything else —
 * opening a panel, filtering a list, clicking a district — leaves no trace, and
 * a proxy built from click telemetry would measure the layout rather than the
 * decision.
 *
 * **What it is not.** It is not time-to-action. A determination is a judgement,
 * not a dispatch, and the platform's own `warning_to_action_median_hours`
 * measures something else entirely (see `src/kpi.js:95-99` for the discipline
 * that figure carries). This is not comparable to it, and the payload says so
 * rather than letting two similarly-named numbers sit side by side unqualified.
 *
 * **The refusals are the measurement's other half.** An alert with no
 * determination contributes no interval — it is *unmeasured*, not zero, and the
 * median over determined alerts describes a sample nobody chose. So the count of
 * undetermined alerts travels with the median, and an alert determined before it
 * was raised (a clock skew, or a determination backdated by hand) is excluded
 * and counted rather than becoming a negative duration that drags the median
 * down.
 */

/** A duration in hours, or `null` when the pair is not measurable. */
function hoursBetween(from, to) {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const ms = end - start
  return ms >= 0 ? ms / 3600000 : null
}

/**
 * The median of a numeric list, averaging the two middle values at even length.
 *
 * `sorted[Math.floor(n/2)]` returns the *upper* middle at even n — 3 for
 * [1,2,3,4] — which biased every even-length median in this repository high by
 * up to half the central gap until `src/kpi.js:88` recorded it. Reusing the
 * wrong expression in a new module would reintroduce the bug one file over.
 */
function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Time-to-decision over the alerts in a store.
 *
 * `alerts` defaults to every alert event; pass a subset to scope it to a period
 * or a district. The per-alert rows are returned as well as the summary,
 * because a median an operator cannot decompose is a number they must take on
 * faith — and the whole point of this module is that a claim about operator cost
 * should be checkable.
 */
export function decisionLatency(data, alerts = null) {
  const pool = Array.isArray(alerts) ? alerts : (data?.alert_events || [])
  const outcomes = data?.alert_outcomes || []

  const rows = []
  let undetermined = 0
  let nonPositive = 0

  for (const alert of pool) {
    const outcome = determinationFor(alert?.id, outcomes)
    if (!outcome) {
      undetermined += 1
      rows.push({
        alert_event_id: alert?.id ?? null,
        severity: alert?.severity ?? null,
        raised_at: alert?.created_at ?? null,
        determined_at: null,
        decision_hours: null,
        determination: null,
        reason: null,
        measured: false,
        excluded: 'undetermined',
      })
      continue
    }
    const hours = hoursBetween(alert?.created_at, outcome.determined_at)
    if (hours === null) {
      nonPositive += 1
      rows.push({
        alert_event_id: alert?.id ?? null,
        severity: alert?.severity ?? null,
        raised_at: alert?.created_at ?? null,
        determined_at: outcome.determined_at ?? null,
        decision_hours: null,
        determination: outcome.determination ?? null,
        reason: outcome.reason ?? null,
        measured: false,
        // Named rather than dropped silently: a determination timestamped before
        // its alert is either a clock problem or a backdated record, and both
        // are worth seeing.
        excluded: 'determined_before_raised',
      })
      continue
    }
    rows.push({
      alert_event_id: alert?.id ?? null,
      severity: alert?.severity ?? null,
      raised_at: alert?.created_at ?? null,
      determined_at: outcome.determined_at ?? null,
      decision_hours: Math.round(hours * 100) / 100,
      determination: outcome.determination ?? null,
      reason: outcome.reason ?? null,
      measured: true,
      excluded: null,
    })
  }

  const measured = rows.filter((row) => row.measured)
  const hours = measured.map((row) => row.decision_hours)

  return {
    median_hours: median(hours) === null ? null : Math.round(median(hours) * 100) / 100,
    samples: hours.length,
    alerts: rows.length,
    undetermined,
    excluded_non_positive: nonPositive,
    by_severity: bySeverity(measured),
    rows,
    measure: 'median hours from an alert being raised (created_at) to a determination being filed against it (determined_at)',
    limit: "A determination is a judgement, not an action: this is how long an operator took to decide whether an alert was justified, and it says nothing about how long the response took. It is not comparable to warning_to_action_median_hours, which measures when a dispatch was sent. It also measures only alerts someone determined — the undetermined count below is the size of the sample nobody chose.",
    refusal: hours.length === 0
      ? 'no alert carries both a raised-at and a later determination, so no decision interval can be measured; returns null rather than substituting a different interval'
      : null,
  }
}

/** The same median, split by the severity of the alert that was decided. */
function bySeverity(measured) {
  const groups = new Map()
  for (const row of measured) {
    const key = row.severity || 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row.decision_hours)
  }
  const out = {}
  for (const [severity, values] of groups) {
    out[severity] = {
      median_hours: Math.round(median(values) * 100) / 100,
      samples: values.length,
    }
  }
  return out
}

import { normalizeWorkflowInstance } from './workflows.js'
import { computeMetric } from './analytics/metrics.js'

const SEVERITIES = ['critical', 'high', 'medium', 'low']

const DATA_GAPS = [
  'alerts_by_gender_demographic: no gender field on alert_events',
  'alerts_by_age_band: no age field on alert_events',
  'false_positive: count of alerts carrying a recorded false_alert determination, not a keyword scan of resolution_note',
  'accuracy_pct: legacy alias of dispatch_precision_pct — read the named field',
]

// Group alert_events by district and compute dispatch quality metrics
export function equityByDistrict(data) {
  const alertEvents = data.alert_events || []
  const dispatches = data.rapidpro_dispatches || []

  // Build set of alert_event_ids that have a matching dispatch
  const dispatchedAlertIds = new Set(dispatches.map((d) => d.alert_event_id).filter(Boolean))

  // Group by district
  const byDistrict = new Map()

  for (const alert of alertEvents) {
    const district = alert.scope?.district || alert.district || 'unknown'
    if (!byDistrict.has(district)) {
      byDistrict.set(district, {
        district,
        alert_records: [],
        dispatched: 0,
        acknowledged: 0,
        false_positive: 0,
        // The alerts whose outcome is recorded, and the ones recorded false.
        // These are counts of a declared field, not a scan of free text: the
        // keyword version could not see the confirmed Mandera alert, whose note
        // reads "Reading traced to a faulty sensor" and contains none of the
        // three words it looked for.
        determined: 0,
        determined_false_positive: 0,
        alerts_by_severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
        alerts_by_gender_demographic: {},
        alerts_by_age_band: {},
        _data_gaps: DATA_GAPS,
      })
    }

    const row = byDistrict.get(district)
    row.alert_records.push(alert)

    // Dispatched = alert_event had a matching dispatch
    const wasDispatched = dispatchedAlertIds.has(alert.id)
    if (wasDispatched) {
      row.dispatched += 1
    }

    // Acknowledged = status acknowledged or resolved
    if (['acknowledged', 'resolved'].includes(alert.status)) {
      row.acknowledged += 1
    }

    // A determination is `false_alert === true` or `=== false`. Anything else —
    // null, absent, a string — is the absence of one, and an alert without an
    // outcome is not a sound alert.
    const determination = alert.false_alert === true || alert.false_alert === false
      ? alert.false_alert
      : null
    if (determination === true) {
      row.false_positive += 1
      row.determined += 1
      row.determined_false_positive += 1
    } else if (determination === false) {
      row.determined += 1
    }

    // Severity breakdown
    const sev = alert.severity || 'unknown'
    const sevKey = SEVERITIES.includes(sev) ? sev : 'unknown'
    row.alerts_by_severity[sevKey] = (row.alerts_by_severity[sevKey] || 0) + 1
  }

  return Array.from(byDistrict.values()).map((row) => {
    // Both rates come from `src/analytics/metrics.js`, which declares their
    // numerators, denominators, floors and refusals. This surface used to
    // compute its own, and its comment claimed it was "defined exactly as
    // `districtOverview` defines it" immediately before defining it otherwise.
    // It is not a comment that was out of date; it was a second definition
    // wearing the first one's clothes.
    const precision = computeMetric('dispatch_precision_pct', {
      alerts: row.alert_records,
      dispatchedAlertIds,
    })
    const far = computeMetric('false_alert_rate', { alerts: row.alert_records })

    return {
      district: row.district,
      alerts: row.alert_records.length,
      dispatched: row.dispatched,
      acknowledged: row.acknowledged,
      false_positive: row.false_positive,
      determined_dispatched: precision.denominator,
      determined_false_positive: precision.numerator === null
        ? row.determined_false_positive
        : precision.denominator - precision.numerator,
      dispatch_precision_pct: precision.value,
      dispatch_precision_refusal: precision.refusal,
      false_alert_rate: far.value,
      false_alert_determined: far.denominator,
      false_alert_of_total: row.alert_records.length,
      false_alert_refusal: far.refusal,
      // Kept so existing consumers keep rendering. The value is the metric
      // above; the name is the old lie, and callers should migrate to
      // `dispatch_precision_pct`.
      accuracy_pct: precision.value,
      alerts_by_severity: row.alerts_by_severity,
      alerts_by_gender_demographic: row.alerts_by_gender_demographic,
      alerts_by_age_band: row.alerts_by_age_band,
      data_gaps: row._data_gaps,
    }
  })
}

// Return districts where dispatch_precision_pct < threshold AND the determined
// sample reaches `minSample`. The determined sample is the gate: a district
// with 50 dispatched alerts and 1 resolved one has a 100% precision computed
// from a single record, which is worse than no number.
export function detectDispatchPrecisionBreaches(data, { threshold = 80, minSample = 5 } = {}) {
  const districts = equityByDistrict(data)
  return districts
    .filter(
      (d) =>
        d.determined_dispatched >= minSample &&
        d.dispatch_precision_pct !== null &&
        d.dispatch_precision_pct < threshold
    )
    .map((d) => ({
      district: d.district,
      dispatch_precision_pct: d.dispatch_precision_pct,
      determined_dispatched: d.determined_dispatched,
      determined_false_positive: d.determined_false_positive,
      dispatched: d.dispatched,
      accuracy_pct: d.dispatch_precision_pct,
    }))
}

// Legacy name. The route in `server.js` imports this symbol, so the old spelling
// stays wired; the metric behind it is `dispatch_precision_pct`.
export const detectAccuracyBreaches = detectDispatchPrecisionBreaches

// Idempotently create equity_audit_action workflow instances for each breach
export async function createEquityAuditWorkflows(store, data, actor = 'equity-monitor') {
  const breaches = detectAccuracyBreaches(data)
  const existing = data.workflow_instances || []
  const openAudits = new Set(
    existing
      .filter(
        (w) =>
          w.type === 'equity_audit_action' &&
          !['closed'].includes(w.state)
      )
      .map((w) => w.district)
  )

  const created = []
  const toMerge = []

  for (const breach of breaches) {
    if (openAudits.has(breach.district)) continue

    const now = new Date().toISOString()
    const instance = normalizeWorkflowInstance({
      type: 'equity_audit_action',
      state: 'threshold_breached',
      district: breach.district,
      subject_kind: 'district',
      subject_id: breach.district,
      actor,
      metadata: {
        dispatch_precision_pct: breach.dispatch_precision_pct,
        determined_dispatched: breach.determined_dispatched,
        determined_false_positive: breach.determined_false_positive,
        dispatched: breach.dispatched,
        detected_at: now,
      },
    })
    created.push(instance.id)
    toMerge.push(instance)
  }

  if (toMerge.length) {
    await store.merge({ workflow_instances: toMerge })
  }

  return created
}

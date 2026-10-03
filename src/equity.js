import { normalizeWorkflowInstance } from './workflows.js'
import { stableId } from './utils.js'

const FALSE_POSITIVE_NOTE = /false|invalid|noop/i
const SEVERITIES = ['critical', 'high', 'medium', 'low']

const DATA_GAPS = [
  'alerts_by_gender_demographic: no gender field on alert_events',
  'alerts_by_age_band: no age field on alert_events',
  'false_positive: keyword scan of resolution_note, not a confirmed outcome label',
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
        alerts: 0,
        dispatched: 0,
        acknowledged: 0,
        false_positive: 0,
        // The subset that can carry an outcome: dispatched AND resolved. The
        // old metric divided by every dispatch while subtracting false positives
        // that included alerts never dispatched — two different populations, so
        // the result could go negative and meant nothing.
        determined: 0,
        determined_false_positive: 0,
        alerts_by_severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
        alerts_by_gender_demographic: {},
        alerts_by_age_band: {},
        _data_gaps: DATA_GAPS,
      })
    }

    const row = byDistrict.get(district)
    row.alerts += 1

    // Dispatched = alert_event had a matching dispatch
    const wasDispatched = dispatchedAlertIds.has(alert.id)
    if (wasDispatched) {
      row.dispatched += 1
    }

    // Acknowledged = status acknowledged or resolved
    if (['acknowledged', 'resolved'].includes(alert.status)) {
      row.acknowledged += 1
    }

    const flaggedFalsePositive =
      alert.status === 'resolved' &&
      alert.resolution_note &&
      FALSE_POSITIVE_NOTE.test(alert.resolution_note)

    // False positive = resolved with false/invalid/noop note
    if (flaggedFalsePositive) {
      row.false_positive += 1
    }

    if (wasDispatched && alert.status === 'resolved') {
      row.determined += 1
      if (flaggedFalsePositive) row.determined_false_positive += 1
    }

    // Severity breakdown
    const sev = alert.severity || 'unknown'
    const sevKey = SEVERITIES.includes(sev) ? sev : 'unknown'
    row.alerts_by_severity[sevKey] = (row.alerts_by_severity[sevKey] || 0) + 1
  }

  return Array.from(byDistrict.values()).map((row) => {
    // Of the alert events this district both dispatched and resolved, the share
    // not marked false positive. Numerator and denominator are the same
    // population, the sample size travels with it, and it is null when nothing
    // in the district has an outcome yet.
    //
    // It is a keyword-derived precision proxy, not response rate. The response
    // metric lives in `rapidpro.responseMetrics` (`response_rate_pct`: inbound
    // messages per dispatch) and counts messages, not people who replied.
    const dispatch_precision_pct =
      row.determined > 0
        ? Math.round((10000 * (row.determined - row.determined_false_positive)) / row.determined) / 100
        : null
    return {
      district: row.district,
      alerts: row.alerts,
      dispatched: row.dispatched,
      acknowledged: row.acknowledged,
      false_positive: row.false_positive,
      determined_dispatched: row.determined,
      determined_false_positive: row.determined_false_positive,
      dispatch_precision_pct,
      // Kept so existing consumers keep rendering. The value is the metric
      // above; the name is the old lie, and callers should migrate to
      // `dispatch_precision_pct`.
      accuracy_pct: dispatch_precision_pct,
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

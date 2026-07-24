import { normalizeWorkflowInstance } from './workflows.js'
import { stableId } from './utils.js'

// Group alert_events by district and compute accuracy metrics
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
        dispatched: 0,
        acknowledged: 0,
        false_positive: 0,
        alerts_by_severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
        alerts_by_gender_demographic: {},
        alerts_by_age_band: {},
        _data_gaps: ['alerts_by_gender_demographic: no gender field on alert_events', 'alerts_by_age_band: no age field on alert_events'],
      })
    }

    const row = byDistrict.get(district)

    // Dispatched = alert_event had a matching dispatch
    if (dispatchedAlertIds.has(alert.id)) {
      row.dispatched += 1
    }

    // Acknowledged = status acknowledged or resolved
    if (['acknowledged', 'resolved'].includes(alert.status)) {
      row.acknowledged += 1
    }

    // False positive = resolved with false/invalid/noop note
    if (
      alert.status === 'resolved' &&
      alert.resolution_note &&
      /false|invalid|noop/i.test(alert.resolution_note)
    ) {
      row.false_positive += 1
    }

    // Severity breakdown
    const sev = alert.severity || 'unknown'
    const sevKey = ['critical', 'high', 'medium', 'low'].includes(sev) ? sev : 'unknown'
    row.alerts_by_severity[sevKey] = (row.alerts_by_severity[sevKey] || 0) + 1
  }

  return Array.from(byDistrict.values()).map((row) => {
    const accuracy_pct =
      row.dispatched > 0
        ? (100 * (row.dispatched - row.false_positive)) / row.dispatched
        : null
    return {
      district: row.district,
      dispatched: row.dispatched,
      acknowledged: row.acknowledged,
      false_positive: row.false_positive,
      accuracy_pct,
      alerts_by_severity: row.alerts_by_severity,
      alerts_by_gender_demographic: row.alerts_by_gender_demographic,
      alerts_by_age_band: row.alerts_by_age_band,
      data_gaps: row._data_gaps,
    }
  })
}

// Return districts where accuracy_pct < threshold AND dispatched >= 5
export function detectAccuracyBreaches(data, { threshold = 80 } = {}) {
  const districts = equityByDistrict(data)
  return districts
    .filter((d) => d.dispatched >= 5 && d.accuracy_pct !== null && d.accuracy_pct < threshold)
    .map((d) => ({ district: d.district, accuracy_pct: d.accuracy_pct, dispatched: d.dispatched }))
}

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
        accuracy_pct: breach.accuracy_pct,
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

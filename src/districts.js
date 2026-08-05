export const KNOWN_DISTRICTS = Object.freeze([
  { slug: 'turkana', name: 'Turkana', country: 'KE', center: { lat: 3.1167, lon: 35.6 }, radius_km: 200 },
  { slug: 'aweil', name: 'Aweil', country: 'SS', center: { lat: 8.767, lon: 27.4 }, radius_km: 150 },
  { slug: 'bor', name: 'Bor', country: 'SS', center: { lat: 6.207, lon: 31.548 }, radius_km: 150 },
  { slug: 'karamoja', name: 'Karamoja', country: 'UG', center: { lat: 2.5333, lon: 34.6667 }, radius_km: 200 },
  { slug: 'mandera', name: 'Mandera', country: 'KE', center: { lat: 3.9366, lon: 41.8569 }, radius_km: 150 },
])

const SYNONYMS = { moroto: 'karamoja' }

export function resolveDistrict(slugOrName) {
  if (!slugOrName) return null
  const key = String(slugOrName).toLowerCase().trim()
  const resolved = SYNONYMS[key] || key
  return KNOWN_DISTRICTS.find(d => d.slug === resolved || d.name.toLowerCase() === resolved) || null
}

function haversineKm(center, lat, lon) {
  const R = 6371
  const dLat = (lat - center.lat) * Math.PI / 180
  const dLon = (lon - center.lon) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(center.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function inDistrict(district, record) {
  const df = String(record.district || record.scope?.district || record.metadata?.district || '')
  if (df && df.toLowerCase() === district.name.toLowerCase()) return true
  const lat = record.latitude ?? record.lat
  const lon = record.longitude ?? record.lon
  if (typeof lat === 'number' && typeof lon === 'number') {
    return haversineKm(district.center, lat, lon) <= district.radius_km
  }
  return false
}

function filterForDistrict(district, records) {
  const seen = new Set()
  const out = []
  for (const r of records) {
    if (seen.has(r.id)) continue
    if (inDistrict(district, r)) {
      seen.add(r.id)
      out.push(r)
    }
  }
  return out
}

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 }

export function districtOverview(data, districtSlug) {
  const district = resolveDistrict(districtSlug)
  if (!district) return null

  const serviceAssets = filterForDistrict(district, data.service_assets || [])
  const incidents = filterForDistrict(district, data.incidents || [])
  const interventions = filterForDistrict(district, data.interventions || [])
  const interventionTasks = filterForDistrict(district, data.intervention_tasks || [])
  const fieldReports = filterForDistrict(district, data.field_reports || []).slice(0, 30)
  const alertEvents = filterForDistrict(district, data.alert_events || []).slice(0, 30)
  const workflowInstances = filterForDistrict(district, data.workflow_instances || [])
  const hazardEvents = filterForDistrict(district, data.hazard_events || [])
  const riskScores = filterForDistrict(district, data.risk_scores || [])
  const communityFeedback = filterForDistrict(district, data.community_feedback || [])

  const activeHazards = [...hazardEvents]
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 4) - (SEV_ORDER[b.severity] ?? 4))

  const dispatches = filterForDistrict(district, data.rapidpro_dispatches || [])
  const people_reached = dispatches.reduce(
    (s, d) => s + (d.recipients_count || d.metadata?.recipients_count || 0), 0
  )

  const feedingInterventions = interventions.filter(i => i.type === 'feeding')
  const feedingCompleted = feedingInterventions.filter(i => ['completed', 'verified'].includes(i.status))
  const feeding_repositioning_rate = feedingInterventions.length
    ? (100 * feedingCompleted.length) / feedingInterventions.length : null

  const coldChainWorkflows = workflowInstances.filter(w => w.type === 'cold_chain_protection')
  const coldChainTerminal = coldChainWorkflows.filter(w => ['closed', 'verified'].includes(w.state))
  const cold_chain_protection_rate = coldChainWorkflows.length
    ? (100 * coldChainTerminal.length) / coldChainWorkflows.length : null

  const falseAlerts = alertEvents.filter(a => a.resolution_note && /false|invalid|noop/i.test(a.resolution_note))
  const false_alert_rate = alertEvents.length
    ? (100 * falseAlerts.length) / alertEvents.length : null

  const lags = []
  for (const d of dispatches) {
    if (d.matched_signal_at && d.sent_at) {
      const ms = new Date(d.sent_at).getTime() - new Date(d.matched_signal_at).getTime()
      if (ms >= 0) lags.push(ms / 3600000)
    }
  }
  lags.sort((a, b) => a - b)
  const warning_to_action_median_hours = lags.length ? lags[Math.floor(lags.length / 2)] : null

  return {
    district: {
      slug: district.slug,
      name: district.name,
      country: district.country,
      center: district.center,
      radius_km: district.radius_km,
    },
    generated_at: new Date().toISOString(),
    counts: {
      service_assets: serviceAssets.length,
      incidents: incidents.length,
      interventions: interventions.length,
      tasks: interventionTasks.length,
      field_reports: fieldReports.length,
      alert_events: alertEvents.length,
      workflow_instances: workflowInstances.length,
      hazard_events: hazardEvents.length,
      risk_scores: riskScores.length,
      community_feedback: communityFeedback.length,
    },
    active_hazards: activeHazards,
    risk_scores: riskScores,
    service_assets: serviceAssets,
    incidents,
    interventions,
    intervention_tasks: interventionTasks,
    field_reports: fieldReports,
    alert_events: alertEvents,
    workflow_instances: workflowInstances,
    community_feedback: communityFeedback,
    kpi_snapshot: {
      people_reached,
      warning_to_action_median_hours,
      false_alert_rate,
      feeding_repositioning_rate,
      cold_chain_protection_rate,
    },
  }
}

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

// The overview embeds sample arrays so the page can render without a second
// fetch. The cap stays — an unbounded field-report list is a payload problem,
// not a correctness one — but it must never stand in for the total.
const SAMPLE_LIMIT = 30
const SAMPLE_ORDER = 'most recent first; records with no timestamp keep store order at the end'

const TIME_KEYS = ['created_at', 'reported_at', 'occurred_at', 'observed_at', 'sent_at', 'updated_at']

function recordTime(record) {
  for (const key of TIME_KEYS) {
    const ms = Date.parse(record[key] ?? '')
    if (Number.isFinite(ms)) return ms
  }
  return -Infinity
}

// `.slice(0, 30)` took the first 30 inserted, which is neither the 30 most
// recent nor a sample of anything — a district with 400 field reports was told
// it had 30. Sort before slicing so the retained window is the one an operator
// opening the page actually wants to read, and say so in the payload.
function newestFirst(records) {
  return [...records].sort((a, b) => {
    const ta = recordTime(a)
    const tb = recordTime(b)
    if (ta === -Infinity) return tb === -Infinity ? 0 : 1
    if (tb === -Infinity) return -1
    return tb - ta
  })
}

function sampleBlock(total, returned) {
  return {
    total,
    returned,
    limit: SAMPLE_LIMIT,
    truncated: total > returned,
    order: SAMPLE_ORDER,
  }
}

export function districtOverview(data, districtSlug) {
  const district = resolveDistrict(districtSlug)
  if (!district) return null

  const serviceAssets = filterForDistrict(district, data.service_assets || [])
  const incidents = filterForDistrict(district, data.incidents || [])

  // Interventions and tasks carry no coordinates. They are reached through
  // the incident (and the task through the intervention), so filtering them by
  // proximity found nothing and every district reported 0 interventions and 0
  // tasks — while Turkana had an active supply reroute on its books. A district
  // overview that says "no activity" when activity is attached to it is worse
  // than one that says "unknown", because it reads as a finding.
  const incidentIds = new Set(incidents.map((i) => i.id))
  const interventions = (data.interventions || [])
    .filter((i) => incidentIds.has(i.incident_id))
  const interventionIds = new Set(interventions.map((i) => i.id))
  const interventionTasks = (data.intervention_tasks || [])
    .filter((t) => interventionIds.has(t.intervention_id))
  const allFieldReports = filterForDistrict(district, data.field_reports || [])
  const allAlertEvents = filterForDistrict(district, data.alert_events || [])
  const fieldReports = newestFirst(allFieldReports).slice(0, SAMPLE_LIMIT)
  const alertEvents = newestFirst(allAlertEvents).slice(0, SAMPLE_LIMIT)
  const workflowInstances = filterForDistrict(district, data.workflow_instances || [])
  const hazardEvents = filterForDistrict(district, data.hazard_events || [])
  const riskScores = filterForDistrict(district, data.risk_scores || [])
  const communityFeedback = filterForDistrict(district, data.community_feedback || [])

  const activeHazards = [...hazardEvents]
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 4) - (SEV_ORDER[b.severity] ?? 4))

  // Dispatches carry neither coordinates nor a district field. They are
  // reached through the alert event they were sent for, which does carry
  // scope.district. Filtering them directly matched nothing, so "People
  // reached" read 0 in every district while 20 dispatches existed.
  const alertById = new Map((data.alert_events || []).map((a) => [a.id, a]))
  const dispatches = (data.rapidpro_dispatches || [])
    .filter((d) => {
      const alert = d.alert_event_id ? alertById.get(d.alert_event_id) : null
      return alert ? inDistrict(district, alert) : false
    })
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

  // Over the whole district, not the returned window. The numerator is a scan of
  // every alert the district has, so dividing it by the first 30 of them
  // described an arbitrary prefix as a district rate.
  const falseAlerts = allAlertEvents.filter(a => a.resolution_note && /false|invalid|noop/i.test(a.resolution_note))
  const false_alert_rate = allAlertEvents.length
    ? (100 * falseAlerts.length) / allAlertEvents.length : null

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
      field_reports: allFieldReports.length,
      alert_events: allAlertEvents.length,
      workflow_instances: workflowInstances.length,
      hazard_events: hazardEvents.length,
      risk_scores: riskScores.length,
      community_feedback: communityFeedback.length,
    },
    // Every number in `counts` is a true total. The two arrays below are
    // samples, and these blocks say how large they are and whether anything is
    // missing — so a consumer can never mistake a 30-row window for a total
    // without the payload telling it first.
    samples: {
      field_reports: sampleBlock(allFieldReports.length, fieldReports.length),
      alert_events: sampleBlock(allAlertEvents.length, alertEvents.length),
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

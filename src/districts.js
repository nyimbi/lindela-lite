import { METRICS, computeMetric } from './analytics/metrics.js'
import { median } from './analytics/numeric.js'

// The payload quotes the declared basis verbatim, so a reader comparing this
// page with the CO tile or the equity table sees the same sentence and knows
// the same number is being described.
const FALSE_ALERT_BASIS = METRICS.false_alert_rate.basis

export const KNOWN_DISTRICTS = Object.freeze([
  { slug: 'turkana', name: 'Turkana', country: 'KE', center: { lat: 3.1167, lon: 35.6 }, radius_km: 200 },
  { slug: 'aweil', name: 'Aweil', country: 'SS', center: { lat: 8.767, lon: 27.4 }, radius_km: 150 },
  { slug: 'bor', name: 'Bor', country: 'SS', center: { lat: 6.207, lon: 31.548 }, radius_km: 150 },
  { slug: 'karamoja', name: 'Karamoja', country: 'UG', center: { lat: 2.5333, lon: 34.6667 }, radius_km: 200 },
  { slug: 'mandera', name: 'Mandera', country: 'KE', center: { lat: 3.9366, lon: 41.8569 }, radius_km: 150 },
])

/**
 * Names the data uses that are not the district names the platform publishes.
 *
 * `moroto → karamoja` used to be consulted by `resolveDistrict` alone, so a
 * slug resolved and a record matched by its own `district` field did not:
 * `inDistrict` compared `"moroto"` against `"Karamoja"`, found no match, and the
 * Karamoja page read `people_reached: 0` while 3,504 Moroto recipients existed.
 * Two functions, one vocabulary, and the gap between them was a district that
 * looked like it had never been warned.
 */
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

/**
 * The canonical slug a free-text district name refers to.
 *
 * Applied inside `inDistrict` so the synonym table governs every match, not
 * only the slug a caller typed. A table consulted by one of two functions that
 * need it is not a synonym table; it is a lookup the second function does not
 * know about.
 */
function canonicalDistrictName(value) {
  const key = String(value ?? '').toLowerCase().trim()
  if (!key) return ''
  return SYNONYMS[key] || key
}

function inDistrict(district, record) {
  const df = record.district || record.scope?.district || record.metadata?.district
  const districtName = String(district.name).toLowerCase()
  if (df) {
    const named = canonicalDistrictName(df)
    // Either the record names this district, or it names one of its synonyms.
    // Both directions: `inDistrict(karamoja, {district:'moroto'})` and
    // `inDistrict(<the Moroto record>, {district:'karamoja'})` are the same
    // statement, and resolving only one direction is how the page and the
    // record disagreed.
    const resolvesToThis = named === districtName
    const isSynonymOfThis = KNOWN_DISTRICTS.some((d) =>
      String(d.name).toLowerCase() !== districtName && canonicalDistrictName(d.name) === named)
    if (resolvesToThis || isSynonymOfThis) return true
  }
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

/**
 * Which district a dispatch belongs to, and whether the two sources agree.
 *
 * Dispatches carry neither coordinates nor a district field. They used to be
 * attributed through `alert.scope.district` — and that disagreed with the
 * dispatch's own `metadata.region` on 12 of 20 dispatches on the live store.
 * The alert's scope is a claim about where the warning applied; the dispatch's
 * region is a claim about where the message went, and people were reached
 * where the message went.
 *
 * So the dispatch's own region wins where it names a district the platform
 * knows, and the disagreement is reported rather than resolved silently —
 * a reader who sees `attribution_conflicts` can go and fix the underlying
 * record instead of trusting either number without knowing they conflict.
 */
function districtForDispatch(dispatch, alert, knownDistricts) {
  const byName = (value) => {
    const key = String(value ?? '').toLowerCase().trim()
    if (!key) return null
    return knownDistricts.find(d => String(d.name).toLowerCase() === key || d.slug === key) || null
  }
  const fromDispatch = byName(dispatch?.metadata?.region || dispatch?.metadata?.district)
  const fromAlert = alert
    ? (byName(alert.scope?.district || alert.district || alert.metadata?.district))
    : null
  return {
    district: fromDispatch ?? fromAlert,
    conflict: Boolean(fromDispatch && fromAlert && fromDispatch.slug !== fromAlert.slug),
    attributed_to: fromDispatch ? 'dispatch.metadata.region' : fromAlert ? 'alert.scope.district' : null,
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
  const allDispatches = data.rapidpro_dispatches || []
  const dispatches = []
  let attributionConflicts = 0
  for (const d of allDispatches) {
    const alert = d.alert_event_id ? alertById.get(d.alert_event_id) : null
    const { district: owner, conflict } = districtForDispatch(d, alert, KNOWN_DISTRICTS)
    if (!owner) continue
    if (owner.slug !== district.slug) continue
    if (conflict) attributionConflicts += 1
    dispatches.push(d)
  }

  // People reached, from the registry rather than from an inline sum.
  //
  // Three things this changed, all of which moved the number toward the truth
  // and none of which moved it toward looking complete:
  //
  // - Failed dispatches are excluded. `status: 'failed', sent_at: null`, HTTP
  //   503, `recipients_count: 40` — the old sum counted them at their intended
  //   size. 1,399 people, of whom 503's reached nobody.
  // - District attribution prefers the dispatch's own `metadata.region`, which
  //   disagreed with the alert's `scope.district` on 12 of 20 dispatches.
  // - Recipients are still summed, not de-duplicated, and the payload says so.
  //   There is no stable person identifier in the payload: 20 dispatches to 20
  //   distinct numbers summed to 22,130 recipients, and a union would be
  //   guesswork. A guess here inflates or deflates a funder's headline number,
  //   so the surface says "not de-duplicated" instead.
  const reached = computeMetric('people_reached', { dispatches })

  const feeding = computeMetric('feeding_repositioning_rate', { interventions })
  const coldChain = computeMetric('cold_chain_protection_rate', { workflows: workflowInstances })

  // False alert rate, from the registry. This surface used to scan
  // `resolution_note` for /false|invalid|noop/i over every alert the district
  // had, dividing by `reviewedAlerts.length` — two different populations in
  // adjacent lines, with a long comment arguing for the denominator. It scored
  // Mandera 0% on a district whose confirmed false alert reads "Reading traced
  // to a faulty sensor": no `false`, no `invalid`, no `noop`. The comment was
  // locally reasonable and false, and so is the one it replaced.
  const far = computeMetric('false_alert_rate', { alerts: allAlertEvents })

  const lags = []
  for (const d of dispatches) {
    if (d.matched_signal_at && d.sent_at) {
      const ms = new Date(d.sent_at).getTime() - new Date(d.matched_signal_at).getTime()
      if (ms >= 0) lags.push(ms / 3600000)
    }
  }
  // `lags[Math.floor(n/2)]` returns the upper of the two middle values at even
  // n — 3 for [1,2,3,4] — so every even-length median on this page was biased
  // high by up to half the central gap. `median()` averages the pair.
  const warning_to_action_median_hours = median(lags)

  // Turkana and Karamoja centres are 122 km apart with 200 km radii, so 17 of
  // 34 service assets fall inside both. Each page is correct about its own
  // filter and a reader summing the two double-counts. Stated here because the
  // payload is where a reader can be told, and because the alternative is a
  // silent invitation to add up pages that are not disjoint.
  const overlapping = KNOWN_DISTRICTS
    .filter((d) => d.slug !== district.slug)
    .map((other) => {
      const shared = filterForDistrict(district, data.service_assets || [])
        .filter((asset) => filterForDistrict(other, [asset]).length > 0)
      return { district: other.name, shared_service_assets: shared.length }
    })
    .filter((row) => row.shared_service_assets > 0)

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
    // Stated rather than left for a reader to discover by comparing pages.
    // Turkana and Karamoja are 122 km apart with 200 km radii, so an asset in
    // both is counted on both pages and district pages must not be summed.
    overlaps_with: overlapping,
    kpi_snapshot: {
      people_reached: reached.value,
      // The send count, the excluded failures and the de-duplication refusal
      // travel with the number. "People reached" without them is a claim that
      // nobody can check.
      people_reached_basis: {
        sends: reached.sends,
        failed_dispatches_excluded: reached.failed_excluded,
        without_recipient_count: reached.without_recipient_count,
        de_duplicated: reached.de_duplicated,
        de_duplication_refusal: 'the dispatch payload carries no stable person identifier — only a phone number per send — so a union of recipients across sends would be a guess, and a guess here inflates or deflates a funder\'s headline reach number',
        attribution_conflicts: attributionConflicts,
        attribution_note: attributionConflicts > 0
          ? `${attributionConflicts} dispatch(es) name a different region in metadata.region than the alert names in scope.district; the dispatch's own region is used and the conflict is counted here`
          : 'every dispatch agrees with its alert on district',
      },
      warning_to_action_median_hours,
      warning_to_action_measure: 'median hours from a dispatch matching a signal to that dispatch being sent; the median of an even-length series averages the two middle values',
      false_alert_rate: far.value,
      // The denominator, the floor and the method travel with the rate. A rate
      // with no denominator beside it is a claim, not a measurement, and the
      // same three fields name the sample on `src/kpi.js`, so an officer
      // reading either page sees the same words.
      false_alert_determined: far.denominator,
      false_alert_of_total: allAlertEvents.length,
      false_alert_method: FALSE_ALERT_BASIS,
      false_alert_refusal: far.refusal,
      feeding_repositioning_rate: feeding.value,
      feeding_repositioning_refusal: feeding.refusal,
      cold_chain_protection_rate: coldChain.value,
      cold_chain_refusal: coldChain.refusal,
    },
  }
}

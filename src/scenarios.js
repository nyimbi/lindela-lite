import { computeFloodRisk, computeClimateConflictRisk, computeServiceImpacts } from './analytics.js'
import { PRIORITY_LEVELS } from './schema.js'
import { stableId, nowIso } from './utils.js'

function round2(n) {
  return Math.round(n * 100) / 100
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

/** WGS84 degrees. Latitude is pole to pole; longitude wraps the globe once. */
const LATITUDE_LIMIT = 90
const LONGITUDE_LIMIT = 180

/**
 * A coordinate that a `haversineKm` call can actually consume.
 *
 * Latitude and longitude are the one thing in a perturbation the model has no
 * way to survive being wrong about: `nearby()` drops any record whose
 * coordinates are not finite, so an event at 999 degrees is not an event at the
 * wrong place, it is no event at all — and the run reports a complete result
 * with the event silently missing from it. The status line said "created" for a
 * record describing nothing.
 */
function coordinate(value, limit, field, index, kind) {
  if (value === null || value === undefined || value === '') {
    throw badRequest(`${kind} event ${index + 1} needs a ${field}`)
  }
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw badRequest(`${kind} event ${index + 1} ${field} must be a number, got ${JSON.stringify(value)}`)
  }
  if (n < -limit || n > limit) {
    throw badRequest(
      `${kind} event ${index + 1} ${field} must be between ${-limit} and ${limit}, got ${n}`
    )
  }
  return n
}

/**
 * One synthetic hazard or conflict event.
 *
 * Only the fields the model reads or that the record would otherwise misstate
 * are checked. `event_type` stays free text because the flood-risk model filters
 * hazards with `/flood|storm|disaster/i` and the datalist in the workbench is
 * explicitly described as vocabulary, not a closed set. `source` is not taken
 * from the caller at all: an event that arrives claiming to be from a live
 * connector is a scenario event, and the record says so.
 */
function normalizeEvent(event, index, kind) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw badRequest(`${kind} event ${index + 1} must be an object`)
  }
  const latitude = coordinate(event.latitude, LATITUDE_LIMIT, 'latitude', index, kind)
  const longitude = coordinate(event.longitude, LONGITUDE_LIMIT, 'longitude', index, kind)

  const severity = String(event.severity ?? 'medium').toLowerCase()
  if (!PRIORITY_LEVELS.includes(severity)) {
    throw badRequest(
      `${kind} event ${index + 1} severity must be one of: ${PRIORITY_LEVELS.join(', ')}`
    )
  }

  const occurred_at = event.occurred_at ?? nowIso()
  if (!Number.isFinite(Date.parse(occurred_at))) {
    throw badRequest(`${kind} event ${index + 1} occurred_at is not a date: ${JSON.stringify(occurred_at)}`)
  }

  return {
    ...event,
    latitude,
    longitude,
    severity,
    occurred_at,
    source: 'scenario_synthetic',
  }
}

function eventList(value, kind) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw badRequest(`${kind} must be an array`)
  return value.map((event, i) => normalizeEvent(event, i, kind))
}

/**
 * The perturbation as the model will run it, or a 400 explaining what is wrong.
 *
 * Everything here was accepted with a 201 until now. A share token is a URL, so
 * a malformed perturbation was not only stored — it was written into a link and
 * answered as a complete result on every later run of it.
 *
 * Deliberately not validated, and why:
 *
 * - `offline_asset_ids` membership. An id naming no asset takes nothing offline
 *   and the run is still a true statement about the store as it stands. The
 *   workbench only ever offers ids the API returned.
 * - The upper bound on `precipitation_multiplier`. The schema states none; a
 *   large multiplier saturates the 0-100 score rather than distorting it, and
 *   inventing a ceiling would reject a scenario the model can honestly run.
 * - Unknown keys. A perturbation is not a schema-closed object here, and
 *   dropping a key a future client sends is how fields go quietly missing.
 */
export function normalizeScenarioPerturbation(input) {
  if (input === undefined || input === null) input = {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('a scenario perturbation must be a JSON object')
  }
  const perturbation = input

  let multiplier = 1
  if (perturbation.precipitation_multiplier !== undefined && perturbation.precipitation_multiplier !== null) {
    const n = Number(perturbation.precipitation_multiplier)
    if (!Number.isFinite(n) || n <= 0) {
      throw badRequest(
        `precipitation_multiplier must be a number greater than 0, got ${JSON.stringify(perturbation.precipitation_multiplier)}`
      )
    }
    multiplier = n
  }

  let offlineAssetIds = []
  if (perturbation.offline_asset_ids !== undefined && perturbation.offline_asset_ids !== null) {
    if (!Array.isArray(perturbation.offline_asset_ids)) {
      throw badRequest('offline_asset_ids must be an array of asset ids')
    }
    offlineAssetIds = perturbation.offline_asset_ids.map((id) => {
      if (typeof id !== 'string' || !id) throw badRequest('offline_asset_ids must contain asset id strings')
      return id
    })
  }

  return {
    ...perturbation,
    precipitation_multiplier: multiplier,
    offline_asset_ids: offlineAssetIds,
    added_hazard_events: eventList(perturbation.added_hazard_events, 'hazard'),
    added_conflict_events: eventList(perturbation.added_conflict_events, 'conflict'),
  }
}

export function runScenario(data, input = {}) {
  const perturbation = normalizeScenarioPerturbation(input)
  const scenario_id = stableId('scenario', [JSON.stringify(perturbation), nowIso()])

  const cloned = JSON.parse(JSON.stringify(data))

  if (perturbation.precipitation_multiplier) {
    const multiplier = Number(perturbation.precipitation_multiplier)
    for (const obs of cloned.climate_observations || []) {
      if (Number.isFinite(obs.precipitation_mm)) {
        obs.precipitation_mm = obs.precipitation_mm * multiplier
      }
      if (Number.isFinite(obs.ensemble_p10)) {
        obs.ensemble_p10 = obs.ensemble_p10 * multiplier
      }
      if (Number.isFinite(obs.ensemble_p50)) {
        obs.ensemble_p50 = obs.ensemble_p50 * multiplier
      }
      if (Number.isFinite(obs.ensemble_p90)) {
        obs.ensemble_p90 = obs.ensemble_p90 * multiplier
      }
    }
  }

  if (perturbation.offline_asset_ids && Array.isArray(perturbation.offline_asset_ids)) {
    const offlineIds = new Set(perturbation.offline_asset_ids)
    cloned.service_assets = (cloned.service_assets || []).filter((a) => !offlineIds.has(a.id))
  }

  if (perturbation.added_hazard_events && Array.isArray(perturbation.added_hazard_events)) {
    cloned.hazard_events = [...(cloned.hazard_events || []), ...perturbation.added_hazard_events]
  }

  if (perturbation.added_conflict_events && Array.isArray(perturbation.added_conflict_events)) {
    cloned.conflict_events = [...(cloned.conflict_events || []), ...perturbation.added_conflict_events]
  }

  const risk_scores = [
    ...computeFloodRisk(cloned),
    ...computeClimateConflictRisk(cloned),
  ]

  const impact_assessments = computeServiceImpacts(cloned, risk_scores)

  const baseline_risk_scores = [
    ...computeFloodRisk(data),
    ...computeClimateConflictRisk(data),
  ]
  const baseline_impacts = computeServiceImpacts(data, baseline_risk_scores)

  const flood_risk_baseline = baseline_risk_scores
    .filter((r) => r.type === 'flood_risk')
    .reduce((sum, r) => sum + r.score, 0) / (baseline_risk_scores.filter((r) => r.type === 'flood_risk').length || 1)

  const flood_risk_scenario = risk_scores
    .filter((r) => r.type === 'flood_risk')
    .reduce((sum, r) => sum + r.score, 0) / (risk_scores.filter((r) => r.type === 'flood_risk').length || 1)

  const conflict_risk_baseline = baseline_risk_scores
    .filter((r) => r.type === 'climate_conflict_risk')
    .reduce((sum, r) => sum + r.score, 0) / (baseline_risk_scores.filter((r) => r.type === 'climate_conflict_risk').length || 1)

  const conflict_risk_scenario = risk_scores
    .filter((r) => r.type === 'climate_conflict_risk')
    .reduce((sum, r) => sum + r.score, 0) / (risk_scores.filter((r) => r.type === 'climate_conflict_risk').length || 1)

  const impacts_baseline = baseline_impacts.reduce((sum, i) => sum + i.impact_score, 0) / (baseline_impacts.length || 1)
  const impacts_scenario = impact_assessments.reduce((sum, i) => sum + i.impact_score, 0) / (impact_assessments.length || 1)

  // Pair each scenario assessment with its baseline counterpart so the workbench
  // can compare like with like.
  //
  // It previously had no baseline at all, and the UI computed a per-asset delta
  // as `scenario - (baseline ?? 0)` — which reported a fabricated +75 impact
  // change on every asset, and sorted a "top affected" list whose members all had
  // the identical score. The mean delta above was honest because it used two real
  // averages; the per-asset table was not.
  const baselineByAsset = new Map(baseline_impacts.map((i) => [i.asset_id, i]))
  const paired_impacts = impact_assessments.map((a) => {
    const b = baselineByAsset.get(a.asset_id)
    return {
      ...a,
      baseline_impact_score: b ? b.impact_score : null,
      baseline_impact_level: b ? b.impact_level : null,
      impact_delta: b ? a.impact_score - b.impact_score : null,
      region_name: a.region_name
        || a.drivers?.nearest_flood_risk
        || a.drivers?.nearest_climate_conflict_risk
        || null,
      service_type: a.service_type || null,
    }
  })

  return {
    scenario_id,
    perturbation,
    risk_scores,
    impact_assessments: paired_impacts,
    diff: {
      flood_risk_delta_mean: Math.round((flood_risk_scenario - flood_risk_baseline) * 100) / 100,
      conflict_risk_delta_mean: Math.round((conflict_risk_scenario - conflict_risk_baseline) * 100) / 100,
      impacts_delta_mean: Math.round((impacts_scenario - impacts_baseline) * 100) / 100,
      unit: 'score points',
      // What the delta is, in the payload rather than only in the UI. It is the
      // change in the mean of an uncalibrated 0-100 sensitivity score, not a
      // percentage and not a physical quantity. Labelled "(mean %)" on screen it
      // read as though doubling rainfall had been modelled into a 19% increase in
      // flood risk.
      baseline_flood_risk_mean: round2(flood_risk_baseline),
      scenario_flood_risk_mean: round2(flood_risk_scenario),
      baseline_conflict_risk_mean: round2(conflict_risk_baseline),
      scenario_conflict_risk_mean: round2(conflict_risk_scenario),
      regions_compared: risk_scores.length,
    },
    model_limit: 'Delta is the change in the mean of an uncalibrated 0-100 sensitivity score, in score points. It is not a percentage, not a probability, and not a forecast: the underlying score reflects data coverage as well as conditions, and has not been calibrated for uncertainty.',
    generated_at: nowIso(),
  }
}

export function encodeScenarioUrl(perturbation) {
  const json = JSON.stringify(perturbation)
  const b64 = Buffer.from(json).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function decodeScenarioUrl(token) {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (token.length % 4)) % 4)
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    throw Object.assign(new Error('Invalid scenario token'), { statusCode: 400 })
  }
}

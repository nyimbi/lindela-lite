import { computeFloodRisk, computeClimateConflictRisk, computeServiceImpacts } from './analytics.js'
import { stableId, nowIso } from './utils.js'

function round2(n) {
  return Math.round(n * 100) / 100
}

export function runScenario(data, perturbation = {}) {
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
    model_limit: 'Delta is the change in the mean of an uncalibrated 0-100 sensitivity score, in score points. It is not a percentage, not a probability, and not a forecast: the underlying score reflects data coverage as well as conditions, and carries calibrated_uncertainty: false.',
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

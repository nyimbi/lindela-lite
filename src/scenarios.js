import { computeFloodRisk, computeClimateConflictRisk, computeServiceImpacts } from './analytics.js'
import { stableId, nowIso } from './utils.js'

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

  return {
    scenario_id,
    perturbation,
    risk_scores,
    impact_assessments,
    diff: {
      flood_risk_delta_mean: Math.round((flood_risk_scenario - flood_risk_baseline) * 100) / 100,
      conflict_risk_delta_mean: Math.round((conflict_risk_scenario - conflict_risk_baseline) * 100) / 100,
      impacts_delta_mean: Math.round((impacts_scenario - impacts_baseline) * 100) / 100,
    },
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

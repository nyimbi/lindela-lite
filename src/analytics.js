import fs from 'node:fs/promises'
import path from 'node:path'
import { riskLevel, severityWeight } from './schema.js'
import { clamp, haversineKm, stableId } from './utils.js'
import { computeEnsembleStats } from './analytics/ensemble.js'
import { computePopulationAtRisk, computeFacilitiesAtRisk } from './analytics/impact.js'
import { biasCorrectClimate } from './analytics/downscaling.js'
import { computeRoadAccess } from './road-access.js'

export async function refreshAnalytics(store) {
  const data = await store.read()
  const risk_scores = [
    ...computeFloodRisk(data),
    ...computeClimateConflictRisk(data),
  ]
  const impact_assessments = computeServiceImpacts(data, risk_scores)
  const data_quality = computeDataQuality(data)
  const population_at_risk = computePopulationAtRisk(data)
  const facilities_at_risk = computeFacilitiesAtRisk(data)
  const road_access = computeRoadAccess(data)
  await store.replaceAnalytics({ risk_scores, impact_assessments, data_quality, population_at_risk, facilities_at_risk, road_access })

  // Persist calibration snapshot (best-effort, don't fail refresh)
  if (process.env.LINDELA_LITE_CALIBRATION_DIR !== 'off' && process.env.NODE_ENV !== 'test') {
    try {
      const calibDir = path.resolve(process.env.LINDELA_LITE_CALIBRATION_DIR || 'data/calibration')
      await fs.mkdir(calibDir, { recursive: true })
      await fs.writeFile(path.join(calibDir, 'latest.json'), JSON.stringify({ risk_scores, data_quality, generated_at: new Date().toISOString() }, null, 2))
    } catch {
      // swallow errors
    }
  }

  return { risk_scores, impact_assessments, data_quality, population_at_risk, facilities_at_risk }
}

export function computeFloodRisk(data, options = {}) {
  const regions = collectRegions(data, options)
  return regions.map((region) => {
    const climate = nearby(data.climate_observations, region, 125)
    const hazards = nearby(data.hazard_events.filter((event) => /flood|storm|disaster/i.test(event.event_type)), region, 250)

    // Bias-corrected value, else the deterministic point value.
    //
    // This used to prefer ensemble p90 over the point value. Those percentiles
    // were synthesized from the same point value by an invented spread, so
    // preferring them meant scoring against an inflated number — at a reported
    // probability of 10%, p90 was about 1.9x the observed precipitation. A
    // percentile is only preferred when a real probabilistic forecast supplied
    // it, which is now identified by `ensemble_source`.
    const precipValues = climate.map((item) => {
      if (Number.isFinite(item.bias_corrected_precipitation_mm)) return Number(item.bias_corrected_precipitation_mm)
      if (item.ensemble_source === 'open_meteo_ensemble' && Number.isFinite(item.ensemble_p90)) {
        return Number(item.ensemble_p90)
      }
      // A missing reading is unknown, not zero. `|| 0` made an absent
      // precipitation record look like a measured dry spell, which lowers the
      // score — the worst direction for an absent input.
      return Number.isFinite(item.precipitation_mm) ? Number(item.precipitation_mm) : null
    })
    const usablePrecip = precipValues.filter((v) => v !== null)
    const missingPrecip = precipValues.length - usablePrecip.length
    const precipitation = usablePrecip.reduce((sum, v) => sum + v, 0)
    // Only a percentile from a genuine probabilistic forecast counts as ensemble
    // coverage. Percentiles previously synthesized from a point value would
    // otherwise always satisfy this and report uncertainty the data does not have.
    const hasEnsemble = climate.some((c) => c.ensemble_source === 'open_meteo_ensemble' && Number.isFinite(c.ensemble_p90))
    const hasBiasCorrection = climate.some((c) => Number.isFinite(c.bias_corrected_precipitation_mm))

    // Same rule for probability: an absent forecast is not a 0% chance of rain.
    const probabilities = climate
      .map((item) => (Number.isFinite(item.precipitation_probability_pct) ? Number(item.precipitation_probability_pct) : null))
      .filter((v) => v !== null)
    const missingProbability = climate.length - probabilities.length
    const maxProbability = probabilities.length ? Math.max(0, ...probabilities) : null
    const hazardPressure = hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 30, 0)
    const score = clamp(Math.round(precipitation * 1.5 + (maxProbability ?? 0) * 0.35 + hazardPressure), 0, 100)
    // Confidence counts readings actually used, not records present. A region
    // whose observations arrived without precipitation gets a lower confidence,
    // so an absent input lowers how sure the score is rather than lowering the
    // score — which is the only safe direction for missing data.
    const confidence = confidenceScore([
      { count: usablePrecip.length, weight: 45 },
      { count: hazards.length, weight: 40 },
      { count: probabilities.length, weight: 15 },
    ])

    // Sensitivity band around the point score, NOT a probabilistic interval.
    //
    // These fields were originally named score_p10/p50/p90, which reads as
    // quantiles of a calibrated predictive distribution. They are not. The
    // width is a fixed function of the input-coverage confidence score, so a
    // well-populated region returns p10 == p50 == p90 with interval_width 0,
    // which presents as "no uncertainty" when it means "enough inputs to
    // compute a point score". Renamed to state what they are; the values and
    // the p10/p50/p90 aliases are unchanged so existing consumers and stored
    // records keep working.
    const halfWidth = Math.round((100 - confidence) * 0.4)
    const score_p50 = score
    const score_p10 = clamp(score - halfWidth, 0, 100)
    const score_p90 = clamp(score + halfWidth, 0, 100)
    const interval_width = score_p90 - score_p10

    const drivers = {
      precipitation_mm: Math.round(precipitation * 10) / 10,
      precipitation_probability_pct: maxProbability,
      // Exposed so a caller can see how much of the input was missing rather than
      // inferring completeness from a plausible-looking total.
      climate_observations_in_scope: climate.length,
      missing_precipitation_records: missingPrecip,
      missing_probability_records: missingProbability,
      flood_hazard_events: hazards.length,
    }
    if (hasBiasCorrection) drivers.bias_corrected = true
    if (hasEnsemble) drivers.ensemble_used = true

    return {
      id: stableId('risk', ['flood', region.key]),
      type: 'flood_risk',
      region_name: region.name,
      country: region.country,
      latitude: region.latitude,
      longitude: region.longitude,
      score,
      // Truthful names for what these are.
      sensitivity_low: score_p10,
      sensitivity_mid: score_p50,
      sensitivity_high: score_p90,
      sensitivity_width: interval_width,
      // Retained aliases for existing consumers and stored records.
      score_p10,
      score_p50,
      score_p90,
      interval_width,
      calibrated_uncertainty: false,
      risk_level: riskLevel(score),
      confidence,
      generated_at: new Date().toISOString(),
      drivers,
      methodology: 'Transparent baseline: precipitation forecast + flood/storm/disaster alerts near exposed locations.',
      limits: [
        'Point score from input data, with a sensitivity band driven by input coverage, not a calibrated predictive distribution.',
        'A zero band means inputs were sufficient, not that the outcome is certain.',
        missingPrecip || missingProbability
          ? `Incomplete input: ${missingPrecip} of ${climate.length} in-scope climate observation(s) carry no precipitation reading and ${missingProbability} carry no probability forecast. Those contribute nothing to the score, so a low score here may reflect missing data rather than low risk.`
          : 'All in-scope climate observations carried a precipitation reading.',
        'Rainfall intensity/duration to flood probability is not modelled: that needs an agreed hydrological model basis and a validated record.',
      ].join(' '),
    }
  })
}

export function computeClimateConflictRisk(data, options = {}) {
  const regions = collectRegions(data, options)
  return regions.map((region) => {
    const climate = nearby(data.climate_observations, region, 125)
    const hazards = nearby(data.hazard_events, region, 250)
    const conflicts = nearby(data.conflict_events, region, 125)
    const serviceAssets = nearby(data.service_assets, region, 75)
    const climatePressure = Math.min(35, climate.reduce((sum, item) => sum + Number(item.precipitation_mm || 0), 0))
    const hazardPressure = Math.min(25, hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 12, 0))
    const conflictPressure = Math.min(30, conflicts.reduce((sum, event) => sum + 4 + Number(event.fatalities || 0) * 0.8, 0))
    const servicePressure = Math.min(10, serviceAssets.length * 1.5)
    const score = clamp(Math.round(climatePressure + hazardPressure + conflictPressure + servicePressure), 0, 100)
    const confidence = confidenceScore([
      { count: climate.length, weight: 30 },
      { count: hazards.length, weight: 25 },
      { count: conflicts.length, weight: 30 },
      { count: serviceAssets.length, weight: 15 },
    ])

    // Sensitivity band, not a probabilistic interval. See the note in
    // computeFloodRisk: the width reflects input coverage, not uncertainty.
    const halfWidth = Math.round((100 - confidence) * 0.4)
    const score_p50 = score
    const score_p10 = clamp(score - halfWidth, 0, 100)
    const score_p90 = clamp(score + halfWidth, 0, 100)
    const interval_width = score_p90 - score_p10

    return {
      id: stableId('risk', ['climate_conflict', region.key]),
      type: 'climate_conflict_risk',
      region_name: region.name,
      country: region.country,
      latitude: region.latitude,
      longitude: region.longitude,
      score,
      sensitivity_low: score_p10,
      sensitivity_mid: score_p50,
      sensitivity_high: score_p90,
      sensitivity_width: interval_width,
      score_p10,
      score_p50,
      score_p90,
      interval_width,
      calibrated_uncertainty: false,
      risk_level: riskLevel(score),
      confidence,
      generated_at: new Date().toISOString(),
      drivers: {
        climate_observations: climate.length,
        hazard_events: hazards.length,
        conflict_events: conflicts.length,
        nearby_service_assets: serviceAssets.length,
      },
      methodology: 'Transparent baseline: climate stress + hazard pressure + user-supplied or licensed conflict events + exposed service assets.',
      limits: 'Weighted sum of input counts and severities, with a sensitivity band driven by input coverage rather than a calibrated predictive distribution. A zero band means inputs were sufficient, not that the outcome is certain.',
    }
  })
}

export function computeServiceImpacts(data, riskScores) {
  const floodRisks = riskScores.filter((risk) => risk.type === 'flood_risk')
  const conflictRisks = riskScores.filter((risk) => risk.type === 'climate_conflict_risk')
  const assessments = []
  for (const asset of data.service_assets) {
    const assetPoint = { latitude: asset.latitude, longitude: asset.longitude }
    const nearestFlood = nearest(floodRisks, assetPoint)
    const nearestConflict = nearest(conflictRisks, assetPoint)
    const floodScore = nearestFlood && nearestFlood.distance_km <= 150 ? nearestFlood.item.score : 0
    const conflictScore = nearestConflict && nearestConflict.distance_km <= 150 ? nearestConflict.item.score : 0
    const score = clamp(Math.round(floodScore * 0.55 + conflictScore * 0.45), 0, 100)
    const confidence = Math.round(((nearestFlood?.item?.confidence || 0) * 0.55) + ((nearestConflict?.item?.confidence || 0) * 0.45))
    assessments.push({
      id: stableId('impact', [asset.id, score]),
      asset_id: asset.id,
      asset_name: asset.name,
      service_type: asset.service_type,
      country: asset.country,
      latitude: asset.latitude,
      longitude: asset.longitude,
      impact_score: score,
      impact_level: riskLevel(score),
      confidence,
      generated_at: new Date().toISOString(),
      drivers: {
        nearest_flood_risk: nearestFlood?.item?.region_name || null,
        nearest_climate_conflict_risk: nearestConflict?.item?.region_name || null,
      },
      recommended_actions: recommendedActions(asset.service_type, score),
    })
  }
  return assessments
}

export function calibrationReport(data) {
  const byType = new Map()
  for (const score of data.risk_scores || []) {
    const type = score.type
    if (!byType.has(type)) {
      byType.set(type, {
        type,
        count: 0,
        total_score: 0,
        total_confidence: 0,
        total_interval_width: 0,
      })
    }
    const item = byType.get(type)
    item.count += 1
    item.total_score += score.score || 0
    item.total_confidence += score.confidence || 0
    item.total_interval_width += score.interval_width || 0
  }

  return [...byType.values()].map((item) => ({
    type: item.type,
    count: item.count,
    mean_score: item.count > 0 ? Math.round(item.total_score / item.count) : 0,
    mean_confidence: item.count > 0 ? Math.round(item.total_confidence / item.count) : 0,
    mean_interval_width: item.count > 0 ? Math.round(item.total_interval_width / item.count) : 0,
    brier_score: null,
  }))
}

export function computeDataQuality(data) {
  const collections = {
    climate_observations: data.climate_observations,
    hazard_events: data.hazard_events,
    conflict_events: data.conflict_events,
    service_assets: data.service_assets,
    food_security_records: data.food_security_records,
    disease_observations: data.disease_observations,
  }
  const bySource = new Map()
  for (const [collection, records] of Object.entries(collections)) {
    for (const record of records || []) {
      const source = record.source || 'operator'
      if (!bySource.has(source)) {
        bySource.set(source, {
          id: `quality_${source}`,
          source,
          records_by_collection: {},
          total_records: 0,
          geocoded_records: 0,
          latest_record_at: null,
          confidence_sum: 0,
        })
      }
      const quality = bySource.get(source)
      quality.records_by_collection[collection] = (quality.records_by_collection[collection] || 0) + 1
      quality.total_records += 1
      if (Number.isFinite(record.latitude) && Number.isFinite(record.longitude)) quality.geocoded_records += 1
      quality.latest_record_at = latestDate(quality.latest_record_at, record.observed_at || record.occurred_at || record.updated_at || record.generated_at)
    }
  }

  for (const run of data.source_runs || []) {
    const source = run.source || 'unknown'
    if (!bySource.has(source)) {
      bySource.set(source, {
        id: `quality_${source}`,
        source,
        records_by_collection: {},
        total_records: 0,
        geocoded_records: 0,
        latest_record_at: null,
        confidence_sum: 0,
      })
    }
    const quality = bySource.get(source)
    quality.last_run_status = run.status
    quality.last_run_at = latestDate(quality.last_run_at, run.completed_at)
    quality.error_count = (quality.error_count || 0) + (run.errors?.length || 0)
  }

  return [...bySource.values()].map((quality) => {
    const geocodeCoverage = quality.total_records ? quality.geocoded_records / quality.total_records : 0
    const runPenalty = quality.last_run_status === 'failed' ? 35 : quality.last_run_status === 'degraded' ? 15 : 0
    const freshnessPenalty = freshnessPenaltyFor(quality.latest_record_at || quality.last_run_at)
    const confidence = clamp(Math.round(geocodeCoverage * 55 + Math.min(quality.total_records, 25) * 1.8 - runPenalty - freshnessPenalty), 0, 100)
    const mean_confidence = quality.total_records > 0 ? Math.round(quality.confidence_sum / quality.total_records) : 0
    return {
      ...quality,
      geocode_coverage_pct: Math.round(geocodeCoverage * 100),
      freshness: freshnessLabel(quality.latest_record_at || quality.last_run_at),
      confidence,
      mean_confidence,
      updated_at: new Date().toISOString(),
    }
  }).sort((a, b) => b.confidence - a.confidence)
}

/**
 * Regions to score.
 *
 * Every record with coordinates used to become a region, so a global alert feed
 * defined the analytical surface: after a live GDACS pull the console computed
 * risk for 87 regions across 25 countries, 82 of them outside the area the
 * platform operates in. The risk surface then said nothing about the five
 * pilot districts, because it was 94% other places.
 *
 * Regions are now bounded to the operational area, using the same anchor the
 * map framing uses. Records outside it are still ingested, still stored, and
 * still drawn on the map — they simply do not generate risk scores for an
 * operator who is not working there.
 *
 * `options.scope` can widen or narrow this. With no scope, the Horn of Africa
 * pilot area is used.
 */
const RISK_SCOPE = Object.freeze({
  minLat: -6,
  maxLat: 15,
  minLon: 27,
  maxLon: 52,
  marginDeg: 6,
})

function inRiskScope(point, scope) {
  return point.latitude >= scope.minLat - scope.marginDeg
    && point.latitude <= scope.maxLat + scope.marginDeg
    && point.longitude >= scope.minLon - scope.marginDeg
    && point.longitude <= scope.maxLon + scope.marginDeg
}

function collectRegions(data, options = {}) {
  const scope = options.scope || RISK_SCOPE
  const points = [
    ...data.climate_observations,
    ...data.hazard_events,
    ...data.conflict_events,
    ...data.service_assets,
  ].filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
    .filter((item) => inRiskScope(item, scope))

  const byKey = new Map()
  for (const point of points) {
    const roundedLat = Math.round(point.latitude)
    const roundedLon = Math.round(point.longitude)
    const key = `${point.country || 'unknown'}:${roundedLat}:${roundedLon}`
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name: point.region_name || point.admin1 || point.country || `${roundedLat},${roundedLon}`,
        country: point.country || null,
        latitude: point.latitude,
        longitude: point.longitude,
      })
    }
  }
  return [...byKey.values()]
}

function nearby(records, point, radiusKm) {
  return records.filter((record) => Number.isFinite(record.latitude) && Number.isFinite(record.longitude) && haversineKm(point, record) <= radiusKm)
}

function nearest(records, point) {
  let best = null
  for (const item of records) {
    if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) continue
    const distance_km = haversineKm(point, item)
    if (!best || distance_km < best.distance_km) best = { item, distance_km }
  }
  return best
}

function recommendedActions(serviceType, score) {
  if (score >= 80) return [`Activate continuity plan for ${serviceType}`, 'Validate access routes', 'Pre-position contingency supplies']
  if (score >= 60) return [`Monitor ${serviceType} service continuity`, 'Confirm backup providers', 'Review flood and security access constraints']
  if (score >= 35) return ['Maintain routine monitoring', 'Check source freshness before operational decisions']
  return ['No immediate action beyond periodic monitoring']
}

function confidenceScore(parts) {
  return clamp(Math.round(parts.reduce((sum, part) => sum + (part.count > 0 ? part.weight : 0), 0)), 0, 100)
}

function latestDate(current, candidate) {
  if (!candidate) return current || null
  if (!current) return new Date(candidate).toISOString()
  const currentMs = Date.parse(current)
  const candidateMs = Date.parse(candidate)
  if (!Number.isFinite(candidateMs)) return current
  return candidateMs > currentMs ? new Date(candidateMs).toISOString() : current
}

function freshnessPenaltyFor(value) {
  if (!value) return 30
  const ageDays = (Date.now() - Date.parse(value)) / 86400000
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0
  if (ageDays <= 2) return 0
  if (ageDays <= 14) return 10
  if (ageDays <= 45) return 20
  return 30
}

function freshnessLabel(value) {
  if (!value) return 'unknown'
  const ageDays = (Date.now() - Date.parse(value)) / 86400000
  if (!Number.isFinite(ageDays) || ageDays < 0) return 'current'
  if (ageDays <= 2) return 'current'
  if (ageDays <= 14) return 'recent'
  if (ageDays <= 45) return 'stale'
  return 'expired'
}

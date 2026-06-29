import fs from 'node:fs/promises'
import path from 'node:path'
import { riskLevel, severityWeight } from './schema.js'
import { clamp, haversineKm, stableId } from './utils.js'
import { computeEnsembleStats } from './analytics/ensemble.js'
import { computePopulationAtRisk, computeFacilitiesAtRisk } from './analytics/impact.js'
import { biasCorrectClimate } from './analytics/downscaling.js'

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
  await store.replaceAnalytics({ risk_scores, impact_assessments, data_quality, population_at_risk, facilities_at_risk })

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

export function computeFloodRisk(data) {
  const regions = collectRegions(data)
  return regions.map((region) => {
    const climate = nearby(data.climate_observations, region, 125)
    const hazards = nearby(data.hazard_events.filter((event) => /flood|storm|disaster/i.test(event.event_type)), region, 250)

    // Prefer bias-corrected values, else ensemble p90, else raw precipitation
    const precipValues = climate.map((item) => {
      if (Number.isFinite(item.bias_corrected_precipitation_mm)) return Number(item.bias_corrected_precipitation_mm)
      if (Number.isFinite(item.ensemble_p90)) return Number(item.ensemble_p90)
      return Number(item.precipitation_mm || 0)
    })
    const precipitation = precipValues.reduce((sum, v) => sum + v, 0)
    const hasEnsemble = climate.some((c) => Number.isFinite(c.ensemble_p90))
    const hasBiasCorrection = climate.some((c) => Number.isFinite(c.bias_corrected_precipitation_mm))

    const maxProbability = Math.max(0, ...climate.map((item) => Number(item.precipitation_probability_pct || 0)))
    const hazardPressure = hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 30, 0)
    const score = clamp(Math.round(precipitation * 1.5 + maxProbability * 0.35 + hazardPressure), 0, 100)
    const confidence = confidenceScore([
      { count: climate.length, weight: 45 },
      { count: hazards.length, weight: 40 },
      { count: climate.filter((item) => Number.isFinite(Number(item.precipitation_probability_pct))).length, weight: 15 },
    ])

    // Probabilistic bands: narrower when confidence is high
    const halfWidth = Math.round((100 - confidence) * 0.4)
    const score_p50 = score
    const score_p10 = clamp(score - halfWidth, 0, 100)
    const score_p90 = clamp(score + halfWidth, 0, 100)
    const interval_width = score_p90 - score_p10

    const drivers = {
      precipitation_mm: Math.round(precipitation * 10) / 10,
      precipitation_probability_pct: maxProbability,
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
      score_p10,
      score_p50,
      score_p90,
      interval_width,
      risk_level: riskLevel(score),
      confidence,
      generated_at: new Date().toISOString(),
      drivers,
      methodology: 'Transparent baseline: precipitation forecast + flood/storm/disaster alerts near exposed locations.',
    }
  })
}

export function computeClimateConflictRisk(data) {
  const regions = collectRegions(data)
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

    // Probabilistic bands: narrower when confidence is high
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
      score_p10,
      score_p50,
      score_p90,
      interval_width,
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

function collectRegions(data) {
  const points = [
    ...data.climate_observations,
    ...data.hazard_events,
    ...data.conflict_events,
    ...data.service_assets,
  ].filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))

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

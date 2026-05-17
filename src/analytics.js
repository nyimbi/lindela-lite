import { riskLevel, severityWeight } from './schema.js'
import { clamp, haversineKm, stableId } from './utils.js'

export async function refreshAnalytics(store) {
  const data = await store.read()
  const risk_scores = [
    ...computeFloodRisk(data),
    ...computeClimateConflictRisk(data),
  ]
  const impact_assessments = computeServiceImpacts(data, risk_scores)
  await store.replaceAnalytics({ risk_scores, impact_assessments })
  return { risk_scores, impact_assessments }
}

export function computeFloodRisk(data) {
  const regions = collectRegions(data)
  return regions.map((region) => {
    const climate = nearby(data.climate_observations, region, 125)
    const hazards = nearby(data.hazard_events.filter((event) => /flood|storm|disaster/i.test(event.event_type)), region, 250)
    const precipitation = climate.reduce((sum, item) => sum + Number(item.precipitation_mm || 0), 0)
    const maxProbability = Math.max(0, ...climate.map((item) => Number(item.precipitation_probability_pct || 0)))
    const hazardPressure = hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 30, 0)
    const score = clamp(Math.round(precipitation * 1.5 + maxProbability * 0.35 + hazardPressure), 0, 100)
    return {
      id: stableId('risk', ['flood', region.key]),
      type: 'flood_risk',
      region_name: region.name,
      country: region.country,
      latitude: region.latitude,
      longitude: region.longitude,
      score,
      risk_level: riskLevel(score),
      generated_at: new Date().toISOString(),
      drivers: {
        precipitation_mm: Math.round(precipitation * 10) / 10,
        precipitation_probability_pct: maxProbability,
        flood_hazard_events: hazards.length,
      },
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
    return {
      id: stableId('risk', ['climate_conflict', region.key]),
      type: 'climate_conflict_risk',
      region_name: region.name,
      country: region.country,
      latitude: region.latitude,
      longitude: region.longitude,
      score,
      risk_level: riskLevel(score),
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

import { haversineKm } from '../utils.js'

export function computePopulationAtRisk(data, { radiusKm = 25 } = {}) {
  const result = []
  const resultMap = new Map()

  for (const hazard of data.hazard_events || []) {
    if (!Number.isFinite(hazard.latitude) || !Number.isFinite(hazard.longitude)) continue

    const hazardKey = hazard.id
    if (!resultMap.has(hazardKey)) {
      resultMap.set(hazardKey, {
        hazard_event_id: hazard.id,
        hazard_type: hazard.event_type,
        population_at_risk: 0,
        service_assets_affected: 0,
        facilities: [],
        generated_at: new Date().toISOString(),
      })
    }

    const entry = resultMap.get(hazardKey)
    let populationSum = 0

    for (const asset of data.service_assets || []) {
      if (!Number.isFinite(asset.latitude) || !Number.isFinite(asset.longitude)) continue
      const distance = haversineKm(hazard, asset)
      if (distance <= radiusKm) {
        const population = Number(asset.population_served || asset.beneficiaries || 0)
        populationSum += population
        entry.service_assets_affected += 1

        const distance_km = Math.round(distance * 100) / 100
        entry.facilities.push({
          id: asset.id,
          name: asset.name,
          service_type: asset.service_type,
          distance_km,
          population_served: population,
        })
      }
    }

    entry.population_at_risk = populationSum
  }

  return [...resultMap.values()]
}

export function computeFacilitiesAtRisk(data) {
  const byServiceType = new Map()

  for (const hazard of data.hazard_events || []) {
    if (!Number.isFinite(hazard.latitude) || !Number.isFinite(hazard.longitude)) continue

    for (const asset of data.service_assets || []) {
      if (!Number.isFinite(asset.latitude) || !Number.isFinite(asset.longitude)) continue
      const distance = haversineKm(hazard, asset)
      if (distance <= 25) {
        const serviceType = asset.service_type || 'unknown'
        if (!byServiceType.has(serviceType)) {
          byServiceType.set(serviceType, {
            service_type: serviceType,
            at_risk_count: 0,
            high_severity_count: 0,
            total_population_served: 0,
          })
        }

        const entry = byServiceType.get(serviceType)
        entry.at_risk_count += 1
        if (hazard.severity === 'high' || hazard.severity === 'critical') entry.high_severity_count += 1
        entry.total_population_served += Number(asset.population_served || asset.beneficiaries || 0)
      }
    }
  }

  return [...byServiceType.values()]
}

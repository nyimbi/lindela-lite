import { haversineKm } from '../utils.js'

const HIGH_SEVERITY = new Set(['high', 'critical'])
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 }

// `population_served: 0` is a real answer from a facility that serves nobody
// today; `asset.population_served || asset.beneficiaries` reads 0 as "absent"
// and substitutes the beneficiaries figure instead.
function servedPopulation(asset) {
  if (Number.isFinite(Number(asset.population_served))) return Number(asset.population_served)
  if (Number.isFinite(Number(asset.beneficiaries))) return Number(asset.beneficiaries)
  return 0
}

// A store can hold the same asset twice (a re-ingested connector payload). Left
// alone, a duplicate inflates every count below without any visible sign.
function distinctAssets(assets) {
  const seen = new Set()
  const out = []
  assets.forEach((asset, i) => {
    const key = asset.id ? `id:${asset.id}` : `at:${i}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(asset)
  })
  return out
}

export function computePopulationAtRisk(data, { radiusKm = 25 } = {}) {
  const resultMap = new Map()
  const assets = distinctAssets(data.service_assets || [])

  // Keyed by hazard, so an asset near two hazards appears in both rows. That is
  // the intent here — each hazard has its own exposed population — and it is
  // the reason the sibling function below could get away with counting assets
  // rather than pairs.
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

    for (const asset of assets) {
      if (!Number.isFinite(asset.latitude) || !Number.isFinite(asset.longitude)) continue
      const distance = haversineKm(hazard, asset)
      if (distance <= radiusKm) {
        const population = servedPopulation(asset)
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

export function computeFacilitiesAtRisk(data, { radiusKm = 25 } = {}) {
  const byServiceType = new Map()
  const assets = distinctAssets(data.service_assets || [])
  const hazards = (data.hazard_events || []).filter(
    (h) => Number.isFinite(h.latitude) && Number.isFinite(h.longitude)
  )

  // The loop order is the bug. Hazards outside, assets inside, and no dedup on
  // asset identity: one clinic 20 km from three separate flood events was
  // counted three times and its population served added three times. The field
  // is named `at_risk_count` and the payload reads "34 facilities at risk" when
  // the answer could be 12. Impact forecasting is what moves this platform from
  // hazard intensity to consequence, and it was wrong in the direction that
  // makes the problem look worse.
  //
  // Assets outer, hazards inner, and each asset contributes exactly once. What
  // was genuinely per-hazard — how many hazards it sits near, how many of them
  // are high, how bad the worst one is — is preserved per asset below rather
  // than smuggled back into the headline counts.
  for (const asset of assets) {
    if (!Number.isFinite(asset.latitude) || !Number.isFinite(asset.longitude)) continue

    let hazardCount = 0
    let highSeverityCount = 0
    let nearestKm = Infinity
    let worstSeverity = 'unknown'
    let worstRank = Infinity

    for (const hazard of hazards) {
      const distance = haversineKm(hazard, asset)
      if (distance > radiusKm) continue

      hazardCount += 1
      if (HIGH_SEVERITY.has(hazard.severity)) highSeverityCount += 1
      if (distance < nearestKm) nearestKm = distance

      const rank = SEVERITY_RANK[hazard.severity] ?? 4
      if (rank < worstRank) {
        worstRank = rank
        worstSeverity = hazard.severity || 'unknown'
      }
    }

    if (!hazardCount) continue

    const serviceType = asset.service_type || 'unknown'
    if (!byServiceType.has(serviceType)) {
      byServiceType.set(serviceType, {
        service_type: serviceType,
        at_risk_count: 0,
        high_severity_count: 0,
        total_population_served: 0,
        high_severity_population_served: 0,
        max_hazards_per_asset: 0,
        assets: [],
      })
    }

    const entry = byServiceType.get(serviceType)
    const population = servedPopulation(asset)

    entry.at_risk_count += 1
    entry.total_population_served += population
    if (highSeverityCount > 0) {
      entry.high_severity_count += 1
      entry.high_severity_population_served += population
    }
    if (hazardCount > entry.max_hazards_per_asset) entry.max_hazards_per_asset = hazardCount

    entry.assets.push({
      id: asset.id,
      name: asset.name,
      population_served: population,
      hazard_count: hazardCount,
      high_severity_hazard_count: highSeverityCount,
      nearest_hazard_km: Math.round(nearestKm * 100) / 100,
      worst_hazard_severity: worstSeverity,
    })
  }

  return [...byServiceType.values()]
}

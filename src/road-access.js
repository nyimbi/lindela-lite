import { ACCESS_BLOCKING_HAZARDS, ROAD_CLASSES, ROAD_PASSABILITY } from './schema.js'
import { clamp, haversineKm, stableId } from './utils.js'

/**
 * Road access and passage risk.
 *
 * Answers the operational question "can a vehicle reach the facility, and how
 * reliably?" — which a per-asset hazard score does not. An asset can sit in a
 * high-risk district yet stay reachable via a good road; another can be in a
 * low-risk district and be cut off entirely because the only road through it
 * is submerged.
 *
 * Method, stated so it can be challenged:
 * - A hazard obstructs a road when the road lies inside the hazard's bounding
 *   box, or within `blockRadiusKm` of the hazard point when no box is known.
 *   Distance alone is not sufficient, because a bbox spanning a whole country
 *   would otherwise block every road inside it.
 * - Flood and landslide block the segment outright; a wider clearance threshold
 *   is used for landslide, since debris flow travels beyond the mapped point
 *   more readily than standing water does.
 * - Severity scales the impact. A green advisory restricts nothing; a red alert
 *   makes the segment impassable.
 * - When a road has no road_class it is treated as 'unpaved' rather than
 *   assumed all-weather. Absence of data should not read as good news.
 */

const DEFAULT_FLOOD_BLOCK_RADIUS_KM = 2
const DEFAULT_LANDSLIDE_BLOCK_RADIUS_KM = 5

/**
 * Computes passage status for every road asset against current hazards.
 * Returns one record per road, whether or not it is currently obstructed,
 * so that "clear" is an observable state rather than an absence.
 */
export function computeRoadAccess(data, options = {}) {
  const roads = (data.service_assets || []).filter((asset) => asset.service_type === 'road')
  const hazards = blockingHazards(data)
  const floodRadiusKm = options.floodRadiusKm ?? DEFAULT_FLOOD_BLOCK_RADIUS_KM
  const slideRadiusKm = options.landslideRadiusKm ?? DEFAULT_LANDSLIDE_BLOCK_RADIUS_KM

  return roads.map((road) => {
    const roadClass = ROAD_CLASSES.includes(road.road_class) ? road.road_class : 'unpaved'
    const reportedPassability = ROAD_PASSABILITY.includes(road.passability) ? road.passability : null

    const obstructions = []
    for (const hazard of hazards) {
      const radiusKm = hazard.event_type === 'landslide' ? slideRadiusKm : floodRadiusKm
      const hit = obstructionFor(road, hazard, radiusKm)
      if (hit) obstructions.push(hit)
    }

    // Worst obstruction wins; ties are broken by the stronger severity.
    obstructions.sort((a, b) => b.impact_rank - a.impact_rank || b.severity_weight - a.severity_weight)
    const worst = obstructions[0] || null

    const access = deriveAccess(worst, reportedPassability)
    const score = accessScore(worst, roadClass, access)

    return {
      id: stableId('road_access', [road.id, worst?.hazard_id || 'clear']),
      road_id: road.id,
      road_name: road.name,
      road_class: roadClass,
      country: road.country,
      admin1: road.admin1 || null,
      latitude: road.latitude,
      longitude: road.longitude,
      access_status: access.status,
      access_reason: access.reason,
      access_score: score,
      access_level: accessLevel(score),
      reported_passability: reportedPassability,
      width_m: road.width_m ?? null,
      obstruction_count: obstructions.length,
      obstructions: obstructions.map((item) => ({
        hazard_id: item.hazard_id,
        event_type: item.event_type,
        severity: item.severity,
        title: item.title,
        distance_km: Math.round(item.distance_km * 10) / 10,
        matched_by: item.matched_by,
        blocking: item.blocking,
      })),
      primary_hazard_id: worst?.hazard_id || null,
      primary_hazard_type: worst?.event_type || null,
      generated_at: new Date().toISOString(),
      confidence: confidenceFor(obstructions, worst),
    }
  })
}

/**
 * Hazards that can physically obstruct a road, with only the fields the
 * matching logic needs.
 */
function blockingHazards(data) {
  return (data.hazard_events || [])
    .filter((hazard) => ACCESS_BLOCKING_HAZARDS.includes(hazard.event_type))
    .filter((hazard) => Number.isFinite(hazard.latitude) && Number.isFinite(hazard.longitude) || hazard.bbox)
    .map((hazard) => ({
      hazard_id: hazard.id,
      event_type: hazard.event_type,
      severity: hazard.severity,
      severity_weight: severityWeight(hazard.severity),
      title: hazard.title || `${hazard.event_type} hazard`,
      latitude: hazard.latitude,
      longitude: hazard.longitude,
      bbox: hazard.bbox || null,
      occurred_at: hazard.occurred_at || null,
    }))
}

/**
 * Returns an obstruction descriptor when a hazard affects a road, else null.
 */
function obstructionFor(road, hazard, radiusKm) {
  const roadPoint = { latitude: road.latitude, longitude: road.longitude }

  // A bbox is authoritative: if the road falls inside it, the hazard covers
  // the location regardless of how far the centre is.
  if (hazard.bbox && pointInBbox(roadPoint, hazard.bbox)) {
    const distanceKm = Number.isFinite(hazard.latitude) && Number.isFinite(hazard.longitude)
      ? haversineKm(roadPoint, { latitude: hazard.latitude, longitude: hazard.longitude })
      : 0
    return buildObstruction(hazard, distanceKm, 'bbox', roadPoint)
  }

  if (Number.isFinite(hazard.latitude) && Number.isFinite(hazard.longitude)) {
    const distanceKm = haversineKm(roadPoint, { latitude: hazard.latitude, longitude: hazard.longitude })
    if (distanceKm <= radiusKm) return buildObstruction(hazard, distanceKm, 'proximity', roadPoint)
  }

  return null
}

function buildObstruction(hazard, distanceKm, matchedBy, roadPoint) {
  // Outside the bbox/proximity threshold the hazard may still warrant caution,
  // so a non-blocking advisory is still recorded with the road's distance.
  const blocking = hazard.severity_weight >= 2 || distanceKm <= 1
  return {
    hazard_id: hazard.hazard_id,
    event_type: hazard.event_type,
    severity: hazard.severity,
    severity_weight: hazard.severity_weight,
    title: hazard.title,
    distance_km: distanceKm,
    matched_by: matchedBy,
    blocking,
    // Distance inside the threshold counts against the road regardless of
    // alert colour; distance beyond it only matters if the alert is serious.
    impact_rank: (blocking ? 100 : 0) + hazard.severity_weight * 10 - Math.min(distanceKm, 20),
  }
}

function pointInBbox(point, bbox) {
  const { south, west, north, east } = bbox
  if (![south, west, north, east].every(Number.isFinite)) return false
  return point.latitude >= south && point.latitude <= north
    && point.longitude >= west && point.longitude <= east
}

function deriveAccess(worst, reportedPassability) {
  if (!worst) {
    if (reportedPassability === 'impassable') {
      return { status: 'impassable', reason: 'Reported impassable by field source' }
    }
    if (reportedPassability === 'restricted') {
      return { status: 'restricted', reason: 'Reported restricted by field source' }
    }
    return { status: 'passable', reason: 'No active hazard obstruction' }
  }

  if (!worst.blocking) {
    return {
      status: reportedPassability === 'impassable' ? 'impassable' : 'restricted',
      reason: `${worst.event_type} nearby (${worst.severity}) but not blocking this segment`,
    }
  }

  return {
    status: 'impassable',
    reason: `Blocked by ${worst.event_type} (${worst.severity}): ${worst.title}`,
  }
}

function accessScore(worst, roadClass, access) {
  const base = { passable: 100, restricted: 55, impassable: 5 }[access.status]
  // An all-weather trunk route losing access is worse than a dirt track
  // losing it: more people depend on it and fewer alternatives exist.
  const criticality = {
    trunk: 1.0,
    primary: 0.9,
    secondary: 0.75,
    tertiary: 0.6,
    unpaved: 0.4,
    track: 0.25,
  }[roadClass] ?? 0.4
  return clamp(Math.round(base * (0.7 + 0.3 * criticality)), 0, 100)
}

function accessLevel(score) {
  if (score >= 80) return 'open'
  if (score >= 50) return 'constrained'
  if (score >= 20) return 'severely_constrained'
  return 'cut_off'
}

function confidenceFor(obstructions, worst) {
  if (!worst) return 100
  // Precise match means high confidence; a broad proximity catch is weaker.
  if (worst.matched_by === 'bbox') return 90
  return worst.distance_km <= 1 ? 75 : 55
}

function severityWeight(severity) {
  switch (String(severity || '').toLowerCase()) {
    case 'critical':
    case 'red':
      return 3
    case 'high':
    case 'orange':
      return 2
    case 'medium':
    case 'green':
      return 1
    default:
      return 0
  }
}

/**
 * Roll-up for dashboards and reports.
 */
export function summarizeRoadAccess(records) {
  const byStatus = { passable: 0, restricted: 0, impassable: 0 }
  const blockedByType = {}
  for (const record of records) {
    byStatus[record.access_status] = (byStatus[record.access_status] || 0) + 1
    for (const item of record.obstructions) {
      if (!item.blocking) continue
      blockedByType[item.event_type] = (blockedByType[item.event_type] || 0) + 1
    }
  }
  const total = records.length
  return {
    generated_at: new Date().toISOString(),
    total_roads: total,
    passable: byStatus.passable || 0,
    restricted: byStatus.restricted || 0,
    impassable: byStatus.impassable || 0,
    cut_off_rate_pct: total ? Math.round(((byStatus.impassable || 0) / total) * 10000) / 100 : 0,
    blocked_by_hazard_type: blockedByType,
    cut_off_roads: records
      .filter((record) => record.access_status === 'impassable')
      .map((record) => ({
        road_id: record.road_id,
        road_name: record.road_name,
        road_class: record.road_class,
        reason: record.access_reason,
        primary_hazard_type: record.primary_hazard_type,
      })),
  }
}
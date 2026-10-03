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
 * - Only a hazard-scale bbox may block on containment alone. GDACS attaches a
 *   bbox to every event, and for green/orange alerts that box is often
 *   administrative rather than the inundation footprint; an oversized box falls
 *   back to proximity matching against its centre. See
 *   MAX_BLOCKING_BBOX_SPAN_DEG.
 * - Flood and landslide block the segment outright; a wider clearance threshold
 *   is used for landslide, since debris flow travels beyond the mapped point
 *   more readily than standing water does.
 * - Severity scales the impact. A green advisory restricts nothing; a red alert
 *   makes the segment impassable.
 * - When a road has no road_class it is treated as 'unpaved' rather than
 *   assumed all-weather. Absence of data should not read as good news.
 * - A hazard blocks only within its active window (`DEFAULT_ACTIVE_WINDOW_DAYS`).
 *   Past that it is recorded with `temporal_status: 'stale'` and downgraded to
 *   an advisory, because a road-access record describes the present and a
 *   thirty-year-old archive entry is not evidence about the present. A hazard
 *   with no usable `occurred_at` is `'undated'`, which is neither evidence nor
 *   an excuse to dismiss it: it still blocks, and it lowers the confidence of
 *   the statement it appears in.
 */

const DEFAULT_FLOOD_BLOCK_RADIUS_KM = 2
const DEFAULT_LANDSLIDE_BLOCK_RADIUS_KM = 5

/**
 * How long a hazard of each type is allowed to obstruct a road.
 *
 * The question a road-access record answers is "can a vehicle reach this
 * facility now", and `occurred_at` was carried all the way from the hazard
 * record to the obstruction descriptor and then never read. A 1985 archive
 * flood closed roads today, with the same confidence as one from this morning,
 * and the summary counted it in `blocked_by_hazard_type` beside live events.
 *
 * The windows differ because the physical processes differ: standing water
 * recedes within days, a landslide deposit stays on the carriageway until it is
 * cleared, and an eruption lasts as long as it is producing. Beyond its window
 * a hazard stops being an obstruction and becomes history — reported, counted
 * separately, and explicitly not treated as evidence about the present.
 */
const DEFAULT_ACTIVE_WINDOW_DAYS = Object.freeze({ flood: 7, landslide: 30, eruption: 30 })

/**
 * Confidence in a *present* access statement, given the strongest evidence in
 * the set that does not speak about the present.
 *
 * 100 is reserved for a road with no hazard near it at all. A road whose only
 * nearby evidence is an undated record is not observed-clear; it is
 * unexamined-clear, and reporting the two at the same confidence is the same
 * error as the blocking one, in the opposite direction.
 */
const TEMPORAL_CONFIDENCE = Object.freeze({ active: 100, forecast: 85, stale: 80, undated: 65 })

/**
 * Largest bounding box, in degrees of latitude, that may block a road.
 *
 * GDACS publishes a bounding box for every event, but for green and orange
 * alerts that box is frequently country- or multi-country-scale rather than the
 * inundation footprint: a live green flood alert for France arrived with a box
 * spanning ~40 degrees of latitude and ~40 of longitude. Matching that box as
 * authoritative marked every road in the Horn of Africa "restricted" because of
 * an alert 2,000 km away.
 *
 * Five degrees is roughly 555 km north-south, which comfortably contains a
 * large flood plain or landslide run-out while excluding administrative and
 * regional alerts. Beyond it the box is treated as non-local: it is still
 * reported as an advisory, but it can only block a road through proximity to
 * the box centre.
 */
const MAX_BLOCKING_BBOX_SPAN_DEG = 5

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
  // The clock is injected rather than read inside the loop so that a recency
  // rule can be tested at all: a test that has to wait for real time to pass
  // does not get written, and a recency rule with no test is a rule nobody has.
  const now = options.now ?? new Date()
  const activeWindowDays = { ...DEFAULT_ACTIVE_WINDOW_DAYS, ...(options.activeWindowDays || {}) }

  return roads.map((road) => {
    const roadClass = ROAD_CLASSES.includes(road.road_class) ? road.road_class : 'unpaved'
    const reportedPassability = ROAD_PASSABILITY.includes(road.passability) ? road.passability : null

    const obstructions = []
    for (const hazard of hazards) {
      const radiusKm = hazard.event_type === 'landslide' ? slideRadiusKm : floodRadiusKm
      const hit = obstructionFor(road, hazard, radiusKm, now, activeWindowDays)
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
        occurred_at: item.occurred_at,
        age_days: item.age_days,
        temporal_status: item.temporal_status,
      })),
      primary_hazard_id: worst?.hazard_id || null,
      primary_hazard_type: worst?.event_type || null,
      generated_at: new Date().toISOString(),
      confidence: confidenceFor(obstructions, worst),
      // Whether the status rests on something that happened recently. A record
      // resting on a historical or undated event says so, so a reader can tell
      // a road somebody checked from one nobody had reason to check lately.
      access_basis: worst ? worst.temporal_status : 'current',
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
function obstructionFor(road, hazard, radiusKm, now, activeWindowDays) {
  const roadPoint = { latitude: road.latitude, longitude: road.longitude }

  // A bbox is authoritative: if the road falls inside it, the hazard covers
  // the location regardless of how far the centre is. That only holds for a
  // hazard-scale box, though. An administrative-scale box is not a claim that
  // the whole area is under water, so it is not allowed to block on its own.
  if (hazard.bbox && pointInBbox(roadPoint, hazard.bbox)) {
    if (bboxIsHazardScale(hazard.bbox)) {
      const distanceKm = Number.isFinite(hazard.latitude) && Number.isFinite(hazard.longitude)
        ? haversineKm(roadPoint, { latitude: hazard.latitude, longitude: hazard.longitude })
        : 0
      return buildObstruction(hazard, distanceKm, 'bbox', roadPoint, now, activeWindowDays)
    }
    // Inside an oversized box: fall through to the proximity check below, so a
    // road near the reported centre can still be blocked while one 2,000 km
    // away is merely noted.
  }

  if (Number.isFinite(hazard.latitude) && Number.isFinite(hazard.longitude)) {
    const distanceKm = haversineKm(roadPoint, { latitude: hazard.latitude, longitude: hazard.longitude })
    if (distanceKm <= radiusKm) return buildObstruction(hazard, distanceKm, 'proximity', roadPoint, now, activeWindowDays)
  }

  return null
}

/**
 * Whether this hazard speaks about the present, and how much of the present.
 *
 * `stale` and `undated` are kept distinct because they are different states:
 * stale is known-old, undated is unknown-age. Collapsing them would either let
 * an archive entry close a road, or let an undated one look as examined as a
 * flood from this morning.
 */
function temporalStatus(hazard, now, activeWindowDays) {
  const windowDays = activeWindowDays[hazard.event_type] ?? 7
  if (!hazard.occurred_at) return { status: 'undated', age_days: null }
  const occurred = Date.parse(hazard.occurred_at)
  // An unparseable timestamp is not a timestamp. Treating it as absent leaves
  // the hazard blocking, which is the safe direction, but calling it 'undated'
  // is what stops the resulting record claiming to be current.
  if (!Number.isFinite(occurred)) return { status: 'undated', age_days: null }
  const ageDays = (now.getTime() - occurred) / 86_400_000
  // A hazard dated in the future is a forecast, not a memory. Flood forecasts
  // are a declared event type and blocking on one is defensible; it is called
  // out so the reader is not told a road is blocked by something that has not
  // happened.
  if (ageDays < 0) return { status: 'forecast', age_days: ageDays }
  if (ageDays <= windowDays) return { status: 'active', age_days: ageDays }
  return { status: 'stale', age_days: ageDays }
}

function buildObstruction(hazard, distanceKm, matchedBy, roadPoint, now, activeWindowDays) {
  // Outside the bbox/proximity threshold the hazard may still warrant caution,
  // so a non-blocking advisory is still recorded with the road's distance.
  const temporal = temporalStatus(hazard, now, activeWindowDays)
  const blocking = temporal.status !== 'stale' && (hazard.severity_weight >= 2 || distanceKm <= 1)
  return {
    hazard_id: hazard.hazard_id,
    event_type: hazard.event_type,
    severity: hazard.severity,
    severity_weight: hazard.severity_weight,
    title: hazard.title,
    distance_km: distanceKm,
    matched_by: matchedBy,
    blocking,
    occurred_at: hazard.occurred_at || null,
    age_days: temporal.age_days === null ? null : Math.round(temporal.age_days * 10) / 10,
    temporal_status: temporal.status,
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

/**
 * Whether a bbox is small enough to assert that everything inside it is
 * affected. Anything wider than MAX_BLOCKING_BBOX_SPAN_DEG in either axis is
 * treated as a regional or administrative extent.
 */
function bboxIsHazardScale(bbox) {
  if (!bbox) return false
  const { south, north, west, east } = bbox
  if (![south, west, north, east].every(Number.isFinite)) return false
  return (north - south) <= MAX_BLOCKING_BBOX_SPAN_DEG && (east - west) <= MAX_BLOCKING_BBOX_SPAN_DEG
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
    if (worst.temporal_status === 'stale') {
      // The honest sentence. "Nearby but not blocking" would describe a road
      // nobody looked at recently as one somebody checked and cleared.
      return {
        status: reportedPassability === 'impassable' ? 'impassable' : 'restricted',
        reason: `Last recorded ${worst.event_type} here was ${worst.age_days} days ago `
          + `(${worst.severity}); too old to describe the present, not counted as an obstruction`,
      }
    }
    return {
      status: reportedPassability === 'impassable' ? 'impassable' : 'restricted',
      reason: `${worst.event_type} nearby (${worst.severity}) but not blocking this segment`,
    }
  }

  const prefix = worst.temporal_status === 'forecast'
    ? `Forecast ${worst.event_type}`
    : `Blocked by ${worst.event_type} (${worst.severity})`
  return {
    status: 'impassable',
    reason: `${prefix}: ${worst.title}`,
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
  if (worst) {
    // Precise match means high confidence; a broad proximity catch is weaker.
    if (worst.matched_by === 'bbox') return 90
    return worst.distance_km <= 1 ? 75 : 55
  }
  // Nothing is blocking. If there is also no nearby hazard of any age, that is
  // an observation. If there is one whose age does not speak about now, the
  // road is merely unexamined, and the two are not the same claim.
  if (!obstructions.length) return 100
  return obstructions.reduce(
    (lowest, item) => Math.min(lowest, TEMPORAL_CONFIDENCE[item.temporal_status] ?? 65),
    100,
  )
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
  const byTemporalStatus = { active: 0, forecast: 0, stale: 0, undated: 0 }
  for (const record of records) {
    byStatus[record.access_status] = (byStatus[record.access_status] || 0) + 1
    for (const item of record.obstructions) {
      if (item.temporal_status in byTemporalStatus) byTemporalStatus[item.temporal_status] += 1
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
    // How much of the evidence behind these statuses actually speaks about the
    // present. A dashboard that reports '4 roads cut off' without this invites
    // the reader to assume all four obstructions are live; with it, `stale` and
    // `undated` are visible without opening a single road.
    obstructions_by_temporal_status: byTemporalStatus,
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
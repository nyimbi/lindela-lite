/**
 * Map framing: which extent the dashboard draws and which extent the terrain
 * service is asked for.
 *
 * Extracted from public/app.js so it can be tested without a DOM. The bug this
 * fixes was found by screenshotting the running dashboard on 2026-10-01.
 */

/** The pilot region the map is about: Turkana, Bor, Aweil, Moroto, Mandera. */
import { PILOT_DISTRICTS } from './basemap.js'

export const REGION_OF_INTEREST = Object.freeze({
  minLat: -6,
  maxLat: 15,
  minLon: 27,
  maxLon: 52,
})

/**
 * Degrees of margin around the region of interest that still shapes the frame.
 *
 * GDACS is a worldwide feed. A seeded demo pulls ~125 geolocated events
 * spanning 131 degrees of longitude, and under 1% fall inside the region.
 * Framing on all of them squeezed five pilot districts into an unreadable
 * smudge, so near-region points shape the extent and distant ones are drawn but
 * do not dictate it.
 */
export const NEAR_REGION_MARGIN_DEG = 12

export function isFinitePoint(record) {
  return Number.isFinite(record?.latitude) && Number.isFinite(record?.longitude)
}

/** Whether a record lies inside a bbox, optionally expanded by a margin. */
export function withinBbox(record, box, marginDeg = 0) {
  if (!isFinitePoint(record)) return false
  return record.latitude >= box.minLat - marginDeg
    && record.latitude <= box.maxLat + marginDeg
    && record.longitude >= box.minLon - marginDeg
    && record.longitude <= box.maxLon + marginDeg
}

export function computeBbox(records, padDeg = 1.5) {
  const geo = records.filter(isFinitePoint)
  if (!geo.length) return null
  const lats = geo.map((r) => r.latitude)
  const lons = geo.map((r) => r.longitude)
  return {
    minLat: Math.min(...lats) - padDeg,
    maxLat: Math.max(...lats) + padDeg,
    minLon: Math.min(...lons) - padDeg,
    maxLon: Math.max(...lons) + padDeg,
  }
}

/**
 * The extent to draw, and the extent to request terrain for.
 *
 * `focus` is an optional box to frame on instead of the region of interest —
 * used when a flood simulation is active, so the shaded extent actually fills
 * the viewport rather than sitting as a few pixels in the corner of a
 * Horn-wide view.
 *
 * Returns `frame` (what the map shows, always at least the focus or region of
 * interest) and `dataExtent` (what a flood-depth request should cover). They
 * are the same object: a terrain request for the globe would time out or
 * silently drop to a zoom where cell depths average across whole landscapes.
 */
export function mapFrame(records, regionOfInterest = REGION_OF_INTEREST, focus = null) {
  const geo = records.filter(isFinitePoint)
  const near = geo.filter((r) => withinBbox(r, regionOfInterest, NEAR_REGION_MARGIN_DEG))
  // Fall back to all data when nothing is near, so an empty region still draws
  // something rather than collapsing to a zero-area box.
  const driver = near.length ? near : geo
  const dataBbox = computeBbox(driver)

  // The anchor is the PILOT DISTRICTS, not the whole region of interest.
  //
  // The region box is 21 degrees tall and 25 wide; the five districts an operator
  // actually works are inside 6.2 by 14.5 of that. Unioning the data with the
  // region box therefore spent most of the canvas on ocean north of Kenya and
  // west of Sudan — roughly 890x1290px of map in which the data occupied the
  // lower-left quarter. Framing on the districts keeps every one of them in
  // view, which is the constraint the region union was serving, and lets the
  // plotted records fill the frame.
  const frame = focus ? { ...focus } : buildFrame(driver, dataBbox, pilotBbox())

  return {
    frame,
    dataExtent: frame,
    nearCount: near.length,
    outOfRegionCount: geo.length - near.length,
    framedBy: focus ? 'focus' : near.length ? 'pilot_districts_plus_nearby_data' : 'all_data',
  }
}

/** Bounding box of the five pilot districts. */
function pilotBbox() {
  const lats = PILOT_DISTRICTS.map((d) => d.center[1])
  const lons = PILOT_DISTRICTS.map((d) => d.center[0])
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
  }
}

/**
 * A frame around the anchor, padded so records are not flush to the edge.
 *
 * The padding is a fraction of the anchor's own span rather than a constant, so
 * a tight cluster is not padded into the same emptiness the region union caused
 * — and a degenerate anchor (every record at one point) still yields a box with
 * some area, which is what stops the projection dividing by zero.
 */
function buildFrame(driver, dataBbox, anchor) {
  // Nothing plotted: there is no data to fit, so the region of interest is the
  // honest answer rather than a box around the districts alone.
  if (!dataBbox) return { ...REGION_OF_INTEREST }
  const base = dataBbox && anchor
    ? {
      minLat: Math.min(dataBbox.minLat, anchor.minLat),
      maxLat: Math.max(dataBbox.maxLat, anchor.maxLat),
      minLon: Math.min(dataBbox.minLon, anchor.minLon),
      maxLon: Math.max(dataBbox.maxLon, anchor.maxLon),
    }
    : dataBbox || anchor

  // Below this many distinct records, anchoring on them would frame a single
  // point, so the region box is the honest answer: there is nothing to fit.
  if (!driver || driver.length < 3) return base

  const padLat = Math.max(0.25, (base.maxLat - base.minLat) * 0.06)
  const padLon = Math.max(0.25, (base.maxLon - base.minLon) * 0.06)
  return {
    minLat: base.minLat - padLat,
    maxLat: base.maxLat + padLat,
    minLon: base.minLon - padLon,
    maxLon: base.maxLon + padLon,
  }
}

/**
 * The event queries the map needs.
 *
 * The map used to fetch `/api/v1/events?limit=50` and nothing else. That is the
 * 50 most recent events worldwide, and with GDACS and USGS both live it is
 * always the same handful of Pacific and Caribbean earthquakes. The two hazards
 * the entire road-access and routing walkthrough depends on — a flood cutting
 * the Lodwar corridor and a landslide across the Turkana supply route — were
 * paginated out and never reached the map. Nothing failed: the API answered,
 * the map drew 33 circles, and the operational area looked free of hazards.
 *
 * So the map asks for two things: everything inside the region it is about, and
 * a bounded slice of recent global events for context. Neither can starve the
 * other, because they are separate requests. A busy day on the global feed can
 * no longer hide a landslide on the road the response depends on.
 */

/** Degrees of margin around the region of interest to include as local context. */
export const LOCAL_CONTEXT_MARGIN_DEG = 3

/** How many recent global events to show alongside the local set. */
export const GLOBAL_CONTEXT_LIMIT = 50

/** How many events to accept from inside the region of interest. */
export const LOCAL_CONTEXT_LIMIT = 400

export function localEventQuery(regionOfInterest = REGION_OF_INTEREST, marginDeg = LOCAL_CONTEXT_MARGIN_DEG, limit = LOCAL_CONTEXT_LIMIT) {
  const b = {
    minLat: regionOfInterest.minLat - marginDeg,
    maxLat: regionOfInterest.maxLat + marginDeg,
    minLon: regionOfInterest.minLon - marginDeg,
    maxLon: regionOfInterest.maxLon + marginDeg,
  }
  // The API takes west,south,east,north — not the minLat/minLon order used
  // internally. Getting this order wrong yields a valid-looking query that
  // silently matches nothing.
  const bbox = [b.minLon, b.minLat, b.maxLon, b.maxLat].map((v) => Math.round(v * 100) / 100).join(',')
  return `/api/v1/events?bbox=${bbox}&limit=${limit}`
}

export function globalEventQuery(limit = GLOBAL_CONTEXT_LIMIT) {
  return `/api/v1/events?limit=${limit}`
}

/**
 * Merge the local and global result sets by id, local first so that when the
 * same event arrives in both it is the locally-scoped copy that wins.
 */
export function mergeEventSets(local = [], global_ = []) {
  const seen = new Set()
  const out = []
  for (const item of [...local, ...global_]) {
    if (!item?.id || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

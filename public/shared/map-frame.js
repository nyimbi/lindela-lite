/**
 * Map framing: which extent the dashboard draws and which extent the terrain
 * service is asked for.
 *
 * Extracted from public/app.js so it can be tested without a DOM. The bug this
 * fixes was found by screenshotting the running dashboard on 2026-10-01.
 */

/** The pilot region the map is about: Turkana, Bor, Aweil, Moroto, Mandera. */
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
  // A focus REPLACES the region-of-interest anchor rather than unioning with
  // it. Unioning is what makes framing work when the anchor is derived from
  // data, but an explicit focus is the operator saying "zoom here" — unioning
  // it with a 25-degree region would leave the focus a no-op and the shaded
  // district still a few pixels wide.
  const frame = focus ? { ...focus } : (dataBbox
    ? {
      minLat: Math.min(dataBbox.minLat, regionOfInterest.minLat),
      maxLat: Math.max(dataBbox.maxLat, regionOfInterest.maxLat),
      minLon: Math.min(dataBbox.minLon, regionOfInterest.minLon),
      maxLon: Math.max(dataBbox.maxLon, regionOfInterest.maxLon),
    }
    : { ...regionOfInterest })

  return {
    frame,
    dataExtent: frame,
    nearCount: near.length,
    outOfRegionCount: geo.length - near.length,
    framedBy: focus ? 'focus' : near.length ? 'region_of_interest_plus_nearby_data' : 'all_data',
  }
}

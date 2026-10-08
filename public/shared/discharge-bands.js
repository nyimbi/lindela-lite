/**
 * River discharge banding for the GloFAS modelled overlay.
 *
 * Pure functions only, no DOM. The thresholds are absolute operational cut
 * points for modelled river discharge across the pilot region; they do not
 * replace local gauge thresholds, and the overlay says so in its tooltip.
 */

/**
 * Absolute discharge bands in m³/s for GloFAS modelled river discharge.
 *
 * `severity` maps the band onto the map's existing severity vocabulary (radius
 * and dash pattern), so the overlay does not invent a second visual language
 * an operator must relearn.
 */
export const DISCHARGE_BANDS = Object.freeze([
  Object.freeze({ max: 50, key: 'low', label: 'Low discharge', severity: 'low' }),
  Object.freeze({ max: 200, key: 'moderate', label: 'Moderate discharge', severity: 'medium' }),
  Object.freeze({ max: 500, key: 'high', label: 'High discharge', severity: 'high' }),
  Object.freeze({ max: Number.POSITIVE_INFINITY, key: 'extreme', label: 'Extreme discharge', severity: 'critical' }),
])

/** Human-readable note attached to every overlay reading. */
export const DISCHARGE_MODEL_NOTE = 'Modelled discharge from GloFAS; not a local gauge observation.'

/**
 * The discharge band for a value in m³/s, or null when the value is not reported.
 *
 * A negative or non-finite value is treated as absent: drawing a parse failure
 * as "low" would launder bad data into a measurement.
 */
export function dischargeBand(m3s) {
  if (m3s === null || m3s === undefined) return null
  if (typeof m3s !== 'number' || !Number.isFinite(m3s) || m3s < 0) return null
  // Boundaries are lower-inclusive: 50 m³/s is the first moderate day.
  if (m3s < 50) return DISCHARGE_BANDS[0]
  if (m3s < 200) return DISCHARGE_BANDS[1]
  if (m3s < 500) return DISCHARGE_BANDS[2]
  return DISCHARGE_BANDS[3]
}

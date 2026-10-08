/**
 * Weather overlay banding and WMO code labels, shared by the console renderer
 * and the test suite.
 *
 * Pure functions only, no DOM. The band cut points are operational rather than
 * arbitrary: on the dry, compacted soils of the pilot districts, 20 mm in a day
 * is where runoff starts cutting roads, and 50 mm is a flash-flood day. A band
 * boundary that rendered 4 mm and 45 mm identically would hide exactly the
 * difference an operator routes around.
 *
 * The zero/absence discipline is the same one `src/connectors/open-meteo.js`
 * documents: 0 mm is a measured dry day, null is a day the API did not report.
 * `precipBand(null)` returns null — unknown — and never the dry band, because a
 * missing forecast reading as "no rain" is a claim nobody made.
 */

/**
 * Daily precipitation bands, mm per day, for the glyph's size and colour.
 *
 * `severity` maps the band onto the map's existing severity vocabulary
 * (radius and dash pattern — see `sevRadius`/`severityDash` in app.js), so the
 * overlay does not invent a second visual language an operator must relearn.
 * It is a presentation mapping, not a hazard grading: heavy rain is not an
 * alert, and nothing here is fed to the alert rules.
 */
export const PRECIP_BANDS = Object.freeze([
  Object.freeze({ max: 0.5, key: 'dry', label: 'No measurable rain', severity: 'low' }),
  Object.freeze({ max: 5, key: 'light', label: 'Light rain', severity: 'low' }),
  Object.freeze({ max: 20, key: 'moderate', label: 'Moderate rain', severity: 'medium' }),
  Object.freeze({ max: 50, key: 'heavy', label: 'Heavy rain', severity: 'high' }),
  Object.freeze({ max: Number.POSITIVE_INFINITY, key: 'extreme', label: 'Extreme rain', severity: 'critical' }),
])

/** The band for a daily precipitation total, or null when the day was not reported. */
export function precipBand(mm) {
  if (mm === null || mm === undefined) return null
  if (typeof mm !== 'number' || !Number.isFinite(mm)) return null
  // A negative total is not weather; it is a parse failure, and drawing it as
  // "dry" would launder the failure into a measurement.
  if (mm < 0) return null
  return PRECIP_BANDS.find((band) => mm <= band.max) || PRECIP_BANDS[PRECIP_BANDS.length - 1]
}

/**
 * Temperature bands for the current-conditions label, degrees Celsius.
 *
 * 32 °C is where heat stress becomes an operational concern for field teams
 * and cold-chain margins, so that is the only boundary with a class of its own
 * that the stylesheet makes loud.
 */
export const TEMP_BANDS = Object.freeze([
  Object.freeze({ max: 15, key: 'cool', label: 'Cool' }),
  Object.freeze({ max: 25, key: 'mild', label: 'Mild' }),
  Object.freeze({ max: 32, key: 'warm', label: 'Warm' }),
  Object.freeze({ max: Number.POSITIVE_INFINITY, key: 'hot', label: 'Hot' }),
])

/** The band for a temperature, or null when it was not reported. */
export function tempBand(c) {
  if (c === null || c === undefined) return null
  if (typeof c !== 'number' || !Number.isFinite(c)) return null
  return TEMP_BANDS.find((band) => c <= band.max) || TEMP_BANDS[TEMP_BANDS.length - 1]
}

/**
 * WMO 4677 weather codes, as the Open-Meteo forecast API reports them.
 *
 * The full table, not the codes seen so far: a code absent here renders as
 * "not labelled" rather than being guessed at, and `weatherCodeLabel` says so
 * by returning null.
 */
export const WMO_WEATHER_CODES = Object.freeze({
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
})

/** The human label for a WMO code, or null when the code is absent or unknown. */
export function weatherCodeLabel(code) {
  if (code === null || code === undefined) return null
  const key = Number(code)
  if (!Number.isInteger(key)) return null
  return WMO_WEATHER_CODES[key] ?? null
}

/**
 * The render plan for the weather layer: which districts get a glyph, and which
 * were withheld and why.
 *
 * Staleness is re-derived here from `as_of` rather than read off the payload's
 * `stale` flag: the service worker may serve a cached response hours later,
 * and the flag would describe the moment it was cached, not now. A stale or
 * undated district is not drawn — the overlay's rule is that it shows nothing
 * rather than presenting an old forecast as current — and is counted so the
 * status line can say exactly that.
 */
export function weatherLayerView(payload, { now = Date.now() } = {}) {
  if (!payload || !Array.isArray(payload.districts)) {
    return { glyphs: [], staleSlugs: [], missingSlugs: [], asOf: null, available: false }
  }
  const nowMs = typeof now === 'number' ? now : Date.parse(now)
  const staleAfterMs = (Number.isFinite(payload.stale_after_minutes) ? payload.stale_after_minutes : 360) * 60 * 1000

  const glyphs = []
  const staleSlugs = []
  const missingSlugs = []
  let asOf = null

  for (const district of payload.districts) {
    if (!district?.current && !(district?.forecast || []).length) {
      missingSlugs.push(district?.slug || district?.name || 'unknown')
      continue
    }
    if (district.as_of && (!asOf || district.as_of > asOf)) asOf = district.as_of
    const asOfMs = Date.parse(district.as_of || '')
    const isStale = !Number.isFinite(asOfMs)
      || (Number.isFinite(nowMs) && nowMs - asOfMs > staleAfterMs)
    if (isStale) {
      staleSlugs.push(district.slug || district.name || 'unknown')
      continue
    }

    const today = (district.forecast || [])[0] || null
    // Today's forecast total is the glyph's band; the current-block
    // precipitation is a rate snapshot, not a daily total, and banding on it
    // would grade a district by whatever the minute happened to be.
    const precipMm = today ? today.precipitation_mm ?? null : null
    const band = precipBand(precipMm)
    glyphs.push({
      slug: district.slug,
      name: district.name,
      latitude: district.latitude,
      longitude: district.longitude,
      asOf: district.as_of,
      temperatureC: district.current?.temperature_c ?? null,
      temperatureBand: tempBand(district.current?.temperature_c ?? null),
      conditionLabel: weatherCodeLabel(district.current?.weather_code ?? null)
        ?? weatherCodeLabel(today?.weather_code ?? null),
      todayPrecipitationMm: precipMm,
      todayProbabilityPct: today?.precipitation_probability_pct ?? null,
      todayTemperatureMaxC: today?.temperature_max_c ?? null,
      precipBand: band,
      // Ungraded when the total was not reported: the glyph gets the map's
      // ungraded dash pattern rather than the dry band's, because "no reading"
      // is not "no rain".
      severity: band ? band.severity : 'ungraded',
      district,
    })
  }

  return { glyphs, staleSlugs, missingSlugs, asOf, available: true }
}

import { fetchWithRetry } from './http.js'
import { normalizeSeverity } from '../schema.js'
import { stableId, toNumber } from '../utils.js'
import { defineConnector } from './spec.js'

const SUMMARY_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary'
const FEEDS = {
  hour: `${SUMMARY_BASE}/4.5_hour.geojson`,
  day: `${SUMMARY_BASE}/2.5_day.geojson`,
  week: `${SUMMARY_BASE}/2.5_week.geojson`,
  month: `${SUMMARY_BASE}/1.0_month.geojson`,
}

async function usgsEarthquakeIngest(options = {}) {
  const hazard_events = []
  const errors = []
  let unmagnituded = 0
  let undated = 0
  const window = options.usgs_window || 'day'
  const feed = options.usgs_feed || FEEDS[window] || FEEDS.day

  try {
    const payload = await fetchWithRetry(feed, {
      timeoutMs: options.timeout_ms || 20000,
      retries: options.retries ?? 2,
      parse: 'json',
      source: options.source,
    })

    for (const feature of payload?.features || []) {
      const props = feature?.properties || {}
      const coords = feature?.geometry?.coordinates
      if (!Array.isArray(coords) || coords.length < 2) continue

      const longitude = toNumber(coords[0])
      const latitude = toNumber(coords[1])
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue

      // A magnitude the feed could not state is not a magnitude of zero.
      // `toNumber(props.mag, 0)` turned a null, a blank and `'abc'` into M0.0,
      // which `magnitudeToSeverity` graded `low` and the title announced as
      // "M0.0 earthquake" — a detection the source reported, published as a
      // measured microquake, and inside the `value_range` assertion's [-2, 10]
      // so nothing flagged it. The record is dropped instead: magnitude is the
      // one field a `2.5_day` feed filters on, and a quake without one cannot
      // be graded or ranked.
      const magnitude = toNumber(props.mag)
      if (magnitude === null) { unmagnituded += 1; continue }
      const occurredAt = toNumber(props.time)
      if (occurredAt === null) { undated += 1; continue }
      const felt = toNumber(props.felt)
      const cdi = toNumber(props.cdi)
      const tsunami = toNumber(props.tsunami, 0) === 1
      const alert = typeof props.alert === 'string' ? props.alert : null

      hazard_events.push({
        id: stableId('hazard', ['usgs_earthquake', feature.id]),
        source: 'usgs_earthquake',
        source_id: feature.id,
        event_type: 'earthquake',
        severity: normalizeSeverity(magnitudeToSeverity(magnitude)),
        title: props.title?.trim() || `M${magnitude.toFixed(1)} earthquake`,
        description: props.title?.trim() || 'USGS earthquake event',
        // A quake with no readable origin time was stamped with the moment it
        // was fetched, which put it at the top of every "recent" query and
        // inside every freshness window — the same shape D21 fixed in FIRMS.
        // Dropped and counted instead; `occurred_at` is required.
        occurred_at: new Date(occurredAt).toISOString(),
        source_url: props.url || 'https://earthquake.usgs.gov/',
        country: null,
        latitude,
        longitude,
        depth_km: Number.isFinite(toNumber(coords[2])) ? toNumber(coords[2]) : null,
        affected_population: null,
        metadata: {
          provider: 'USGS',
          magnitude,
          place: props.place || null,
          felt_reports: Number.isFinite(felt) ? felt : null,
          cdi,
          tsunami,
          alert,
          status: props.status || null,
          tsunami_flag: props.tsunami ?? null,
          window,
        },
      })
    }
  } catch (error) {
    errors.push(`usgs_earthquake: ${error.message}`)
  }

  // Dropped features are counted, not swallowed: a feed whose `mag` or `time`
  // column stopped arriving would otherwise return a smaller batch that looks
  // exactly like a quiet day, and the `min_count_vs_trailing` assertion is
  // deliberately loose enough (ratio 0.2) that it would not catch it either.
  if (unmagnituded > 0) {
    errors.push(`usgs_earthquake: ${unmagnituded} feature(s) carried no readable magnitude and were dropped; every USGS feature has one, so the feed shape has changed.`)
  }
  if (undated > 0) {
    errors.push(`usgs_earthquake: ${undated} feature(s) carried no readable origin time and were dropped; every USGS feature has one, so the feed shape has changed.`)
  }

  return { hazard_events, errors }
}

/**
 * Maps a USGS magnitude to a severity band.
 * Thresholds follow USGS magnitude-based damage categories.
 */
function magnitudeToSeverity(magnitude) {
  if (magnitude >= 7) return 'critical'
  if (magnitude >= 6) return 'high'
  if (magnitude >= 5) return 'medium'
  return 'low'
}

export const spec = defineConnector({
  id: 'usgs_earthquake',
  description: 'USGS real-time earthquake feed (GeoJSON)',
  schema: {
    requestSchema: {
      usgs_window: 'one of: hour, day, week, month (default day)',
      usgs_feed: 'override feed URL',
      timeout_ms: 'number (default 20000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      hazard_events: 'array of earthquake events parsed from USGS GeoJSON',
    },
  },
  defaults: {
    rateLimit: { perMinute: 60 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  ingest: usgsEarthquakeIngest,
})

export const usgsEarthquakeConnector = {
  id: 'usgs_earthquake',
  ingest: usgsEarthquakeIngest,
}
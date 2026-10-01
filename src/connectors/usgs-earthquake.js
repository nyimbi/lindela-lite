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
  const window = options.usgs_window || 'day'
  const feed = options.usgs_feed || FEEDS[window] || FEEDS.day

  try {
    const payload = await fetchWithRetry(feed, {
      timeoutMs: options.timeout_ms || 20000,
      retries: options.retries ?? 2,
      parse: 'json',
    })

    for (const feature of payload?.features || []) {
      const props = feature?.properties || {}
      const coords = feature?.geometry?.coordinates
      if (!Array.isArray(coords) || coords.length < 2) continue

      const longitude = toNumber(coords[0])
      const latitude = toNumber(coords[1])
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue

      const magnitude = toNumber(props.mag, 0)
      const occurredAt = toNumber(props.time)
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
        occurred_at: Number.isFinite(occurredAt)
          ? new Date(occurredAt).toISOString()
          : new Date().toISOString(),
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
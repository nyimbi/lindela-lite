import { fetchWithRetry } from './http.js'
import { normalizeSeverity } from '../schema.js'
import { stableId, toNumber } from '../utils.js'
import { defineConnector, readNamespacedTag } from './spec.js'

// GDACS serves one combined feed. The per-hazard URLs (rss_floods.xml,
// rss_droughts.xml, rss_tropicalcyclones.xml) now return an HTML admin page
// rather than RSS, so requesting them yields nothing. rss.xml carries every
// event type — FL, EQ, TC, DR, WF, VO — and is the single feed to use.
// Verified live: 222 items, of which 23 flood, 9 cyclone, 12 drought.
const FEEDS = [
  'https://www.gdacs.org/xml/rss.xml',
]

async function gdacsIngest(options = {}) {
    const hazard_events = []
    const errors = []
    const feeds = options.gdacs_feeds?.length ? options.gdacs_feeds : FEEDS

    for (const feed of feeds) {
      try {
        const xml = await fetchWithRetry(feed, { timeoutMs: options.timeout_ms || 20000, retries: options.retries ?? 2 })
        for (const item of parseRssItems(xml)) {
          const parsed = parseGdacsItem(item)
          hazard_events.push({
            id: stableId('hazard', ['gdacs', parsed.source_id || item.link || item.title]),
            source: 'gdacs',
            source_id: parsed.source_id || item.guid || item.link || item.title,
            event_type: parsed.event_type,
            severity: parsed.severity,
            title: item.title || 'GDACS alert',
            description: stripTags(item.description || ''),
            occurred_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
            source_url: item.link || feed,
            country: parsed.country,
            latitude: parsed.latitude,
            longitude: parsed.longitude,
            bbox: parsed.bbox,
            affected_population: parsed.affected_population,
            metadata: {
              provider: 'GDACS',
              feed,
              event_type_code: item.eventtype || null,
              alert_level: parsed.alert_level,
              alert_score: parsed.alert_score,
              severity_data: parsed.severity_data,
              // Explains a null coordinate rather than leaving it to be
              // mistaken for a location we failed to resolve.
              geolocation_note: parsed.metadata_note,
            },
          })
        }
      } catch (error) {
        errors.push(`${feed}: ${error.message}`)
      }
    }

    return { hazard_events, errors }
}

export const spec = defineConnector({
  id: 'gdacs',
  description: 'GDACS disaster alerts (floods, earthquakes, droughts, cyclones)',
  schema: {
    requestSchema: {
      gdacs_feeds: 'array of RSS feed URLs',
      timeout_ms: 'number (default 20000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      hazard_events: 'array of GDACS alerts parsed from RSS',
    },
  },
  defaults: {
    rateLimit: { perMinute: 120 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  ingest: gdacsIngest,
})

export const gdacsConnector = {
  id: 'gdacs',
  ingest: gdacsIngest,
}

function parseRssItems(xml) {
  const matches = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
  return matches.map((match) => ({
    title: readTag(match[1], 'title'),
    link: readTag(match[1], 'link'),
    description: readTag(match[1], 'description'),
    pubDate: readTag(match[1], 'pubDate'),
    guid: readTag(match[1], 'guid'),
    eventtype: readNamespacedTag(match[1], 'eventtype'),
    alertlevel: readNamespacedTag(match[1], 'alertlevel'),
    alertscore: readNamespacedTag(match[1], 'alertscore'),
    severity_data: readNamespacedTag(match[1], 'severity'),
    bbox: readNamespacedTag(match[1], 'bbox'),
    country: readNamespacedTag(match[1], 'country'),
  }))
}

function parseGdacsItem(item) {
  const text = `${item.title || ''} ${stripTags(item.description || '')}`
  const lower = text.toLowerCase()

  // Prefer the structured gdacs:eventtype over keyword sniffing: it is
  // unambiguous where "landslide" or "mudslide" appear in free text.
  const EVENT_TYPE_BY_CODE = {
    FL: 'flood',
    TC: 'storm',
    EQ: 'earthquake',
    DR: 'drought',
    WF: 'fire',
    VO: 'volcano',
    LS: 'landslide',
  }
  const code = String(item.eventtype || '').trim().toUpperCase()
  let event_type = EVENT_TYPE_BY_CODE[code]
  if (!event_type) {
    if (/\b(landslide|mudslide|mud ?flow|rockslide|slope failure|earth ?slide|debris flow)\b/i.test(text)) {
      event_type = 'landslide'
    } else if (lower.includes('flood')) {
      event_type = 'flood'
    } else if (lower.includes('drought')) {
      event_type = 'drought'
    } else if (lower.includes('cyclone') || lower.includes('storm')) {
      event_type = 'storm'
    } else if (lower.includes('earthquake')) {
      event_type = 'earthquake'
    } else {
      event_type = 'disaster'
    }
  }

  const alertLevel = String(item.alertlevel || '').trim().toLowerCase()
  const severity = normalizeSeverity(
    alertLevel === 'red' || lower.includes('red')
      ? 'red'
      : alertLevel === 'orange' || lower.includes('orange')
        ? 'orange'
        : alertLevel === 'green' || lower.includes('green')
          ? 'green'
          : 'unknown',
  )

  // gdacs:bbox is "south west north east" in decimal degrees. Prefer it over
  // scraping coordinates out of the description, which the RSS rarely carries.
  const box = parseBbox(item.bbox)
  const lat = readNumber(text, /lat(?:itude)?[:\s]+(-?\d+(?:\.\d+)?)/i)
  const lon = readNumber(text, /lon(?:gitude)?[:\s]+(-?\d+(?:\.\d+)?)/i)
  const affected = readNumber(text, /(?:population|people)[^\d]+(\d[\d,]*)/i)
  const countryField = item.country ? item.country.trim().slice(0, 80) : null
  const country = countryField || readText(text, /Country[:\s]+([A-Za-z ,'-]+)/i)?.trim().slice(0, 80) || null

  // A bbox centre is only a location when the box is small enough to be a
  // plausible footprint. GDACS attaches a country- or region-scale box to many
  // green alerts, and its centre can be hundreds of kilometres from the event:
  // a live green flood alert for France carried a box spanning ~40 degrees of
  // longitude, so its "centre" was at 27.8E — in Chad. That plotted a French
  // event in the Sahel, where it then contributed to risk scores and to
  // road-access matching.
  //
  // So: an oversized box keeps its coordinates null and relies on bbox
  // containment, which is what road-access does anyway. The event stays
  // geographically honest instead of acquiring a confident wrong point.
  const bboxIsLocal = box && (box.north - box.south) <= 5 && (box.east - box.west) <= 5

  return {
    event_type,
    severity,
    latitude: box ? (bboxIsLocal ? box.latitude : null) : lat,
    longitude: box ? (bboxIsLocal ? box.longitude : null) : lon,
    bbox: box ? { west: box.west, south: box.south, east: box.east, north: box.north } : null,
    metadata_note: box && !bboxIsLocal
      ? 'Coordinates omitted: the source bbox is regional, and its centre is not the event location'
      : null,
    affected_population: affected,
    country,
    source_id: item.guid || item.link,
    alert_level: alertLevel || null,
    alert_score: toNumber(item.alertscore),
    severity_data: item.severity_data || null,
  }
}

/**
 * GDACS bbox is "south west north east". Returns the centre point so the
 * hazard can be mapped and proximity-matched, plus the bounds for filtering.
 */
function parseBbox(value) {
  const parts = String(value || '').trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [south, west, north, east] = parts
  if (south >= north || west >= east) return null
  return { west, south, east, north, latitude: (south + north) / 2, longitude: (west + east) / 2 }
}

function readTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? decodeXml(match[1].trim()) : ''
}

function readNumber(text, regex) {
  const match = text.match(regex)
  return match ? toNumber(match[1].replaceAll(',', '')) : null
}

function readText(text, regex) {
  const match = text.match(regex)
  return match ? match[1] : null
}

function stripTags(value) {
  return decodeXml(String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function decodeXml(value) {
  return String(value)
    .replaceAll('<![CDATA[', '')
    .replaceAll(']]>', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
}

import { normalizeSeverity } from '../schema.js'
import { stableId, toNumber } from '../utils.js'

const FEEDS = [
  'https://www.gdacs.org/xml/rss.xml',
  'https://www.gdacs.org/xml/rss_floods.xml',
  'https://www.gdacs.org/xml/rss_droughts.xml',
  'https://www.gdacs.org/xml/rss_tropicalcyclones.xml',
]

export const gdacsConnector = {
  id: 'gdacs',
  async ingest(options = {}) {
    const hazard_events = []
    const errors = []
    const feeds = options.gdacs_feeds?.length ? options.gdacs_feeds : FEEDS

    for (const feed of feeds) {
      try {
        const response = await fetch(feed, { signal: AbortSignal.timeout(options.timeout_ms || 20000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const xml = await response.text()
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
            affected_population: parsed.affected_population,
            metadata: { provider: 'GDACS', feed },
          })
        }
      } catch (error) {
        errors.push(`${feed}: ${error.message}`)
      }
    }

    return { hazard_events, errors }
  },
}

function parseRssItems(xml) {
  const matches = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
  return matches.map((match) => ({
    title: readTag(match[1], 'title'),
    link: readTag(match[1], 'link'),
    description: readTag(match[1], 'description'),
    pubDate: readTag(match[1], 'pubDate'),
    guid: readTag(match[1], 'guid'),
  }))
}

function parseGdacsItem(item) {
  const text = `${item.title || ''} ${stripTags(item.description || '')}`
  const lower = text.toLowerCase()
  const event_type = lower.includes('flood') ? 'flood'
    : lower.includes('drought') ? 'drought'
      : lower.includes('cyclone') || lower.includes('storm') ? 'storm'
        : lower.includes('earthquake') ? 'earthquake'
          : 'disaster'
  const severity = normalizeSeverity(lower.includes('red') ? 'red' : lower.includes('orange') ? 'orange' : lower.includes('green') ? 'green' : 'unknown')
  const lat = readNumber(text, /lat(?:itude)?[:\s]+(-?\d+(?:\.\d+)?)/i)
  const lon = readNumber(text, /lon(?:gitude)?[:\s]+(-?\d+(?:\.\d+)?)/i)
  const affected = readNumber(text, /(?:population|people)[^\d]+(\d[\d,]*)/i)
  const country = readText(text, /Country[:\s]+([A-Za-z ,'-]+)/i)
  return {
    event_type,
    severity,
    latitude: lat,
    longitude: lon,
    affected_population: affected,
    country: country ? country.trim().slice(0, 80) : null,
    source_id: item.guid || item.link,
  }
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

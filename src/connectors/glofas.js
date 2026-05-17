import { stableId } from '../utils.js'

const FEEDS = [
  'https://global-flood.emergency.copernicus.eu/rss.xml',
]

export const glofasConnector = {
  id: 'glofas',
  async ingest(options = {}) {
    const hazard_events = []
    const errors = []
    const feeds = options.glofas_feeds?.length ? options.glofas_feeds : FEEDS

    for (const feed of feeds) {
      try {
        const response = await fetch(feed, { signal: AbortSignal.timeout(options.timeout_ms || 20000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const text = await response.text()
        const items = [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
        for (const match of items) {
          const title = readTag(match[1], 'title') || 'GloFAS flood forecast update'
          const link = readTag(match[1], 'link') || feed
          const description = readTag(match[1], 'description')
          hazard_events.push({
            id: stableId('hazard', ['glofas', link, title]),
            source: 'glofas',
            source_id: link,
            event_type: 'flood_forecast',
            severity: /high|severe|red/i.test(`${title} ${description}`) ? 'high' : 'medium',
            title,
            description,
            occurred_at: readTag(match[1], 'pubDate') ? new Date(readTag(match[1], 'pubDate')).toISOString() : new Date().toISOString(),
            source_url: link,
            country: null,
            latitude: null,
            longitude: null,
            metadata: { provider: 'Copernicus GloFAS', feed },
          })
        }
      } catch (error) {
        errors.push(`${feed}: ${error.message}`)
      }
    }

    return { hazard_events, errors }
  },
}

function readTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
}

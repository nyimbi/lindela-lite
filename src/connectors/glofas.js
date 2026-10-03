import { fetchWithRetry } from './http.js'
import { stableId } from '../utils.js'
import { defineConnector } from './spec.js'

const FEEDS = [
  'https://global-flood.emergency.copernicus.eu/rss.xml',
]

async function glofasIngest(options = {}) {
    const hazard_events = []
    const errors = []
    const feeds = options.glofas_feeds?.length ? options.glofas_feeds : FEEDS

    for (const feed of feeds) {
      try {
        const text = await fetchWithRetry(feed, { timeoutMs: options.timeout_ms || 20000, retries: options.retries ?? 2 })

        // A feed that returns an HTML page still answers 200, so a naive parse
        // finds zero items and reports success. Verified 2026-10-01: the
        // published rss.xml path served the EFAS single-page app instead, and
        // the connector ingested nothing while reporting no error. Say so
        // rather than letting an empty result read as "no floods forecast".
        if (!looksLikeFeed(text)) {
          errors.push(`${feed}: response is not an RSS or Atom feed (${describeResponse(text)}); the endpoint likely moved or is serving a web app`)
          continue
        }

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
            // No severity. The feed publishes none, and inferring one from the
            // title matched "high" in "high latitude" and "red" in a place
            // name; everything else fell through to a flat 'medium', which
            // asserted a moderate forecast the connector had not measured.
            // analytics.js weights a null severity below any measured level,
            // so an unmeasured forecast contributes less than a measured one
            // instead of standing in for it.
            severity: null,
            title,
            description,
            occurred_at: readTag(match[1], 'pubDate') ? new Date(readTag(match[1], 'pubDate')).toISOString() : new Date().toISOString(),
            source_url: link,
            country: null,
            latitude: null,
            longitude: null,
            // No flood extent and no ensemble: this feed carries neither, and
            // publishing zeros in the percentile fields made an absent
            // probabilistic forecast look like a certain one.
            ensemble_members: [],
            ensemble_p10: null,
            ensemble_p50: null,
            ensemble_p90: null,
            model_limit: 'GloFAS feed carries no extent, no ensemble members, and no severity; none of them is derived from it.',
            metadata: { provider: 'Copernicus GloFAS', feed },
          })
        }
      } catch (error) {
        errors.push(`${feed}: ${error.message}`)
      }
    }

    return { hazard_events, errors }
}

export const spec = defineConnector({
  id: 'glofas',
  description: 'Copernicus GloFAS flood forecast RSS',
  schema: {
    requestSchema: {
      glofas_feeds: 'array of RSS feed URLs',
      timeout_ms: 'number (default 20000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      hazard_events: 'array of flood forecast alerts parsed from RSS',
    },
  },
  defaults: {
    rateLimit: { perMinute: 120 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  ingest: glofasIngest,
})

export const glofasConnector = {
  id: 'glofas',
  ingest: glofasIngest,
}

function readTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
}

/** Whether a response body is plausibly RSS, Atom, or RDF rather than a web page. */
export function looksLikeFeed(text) {
  if (typeof text !== 'string' || !text.trim()) return false
  return /<rss[\s>]/i.test(text)
    || /<feed[\s>]/i.test(text)
    || /<rdf:RDF[\s>]/i.test(text)
}

/** Short description of what actually came back, for the error message. */
function describeResponse(text) {
  const head = String(text || '').trim().slice(0, 200)
  if (/^\s*<(!doctype html|html)/i.test(head)) return 'received an HTML page'
  if (!head) return 'empty response'
  return `starts with ${JSON.stringify(head.slice(0, 60))}`
}

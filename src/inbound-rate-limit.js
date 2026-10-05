import { createRateLimiter } from './rate-limit.js'

/**
 * R-09 — there was no inbound rate limiting of any kind.
 *
 * `src/rate-limit.js` is an *outbound* connector limiter whose only importer was
 * `src/connectors/http.js`. Nothing counted what came in. So:
 *
 *   - one upload saturates the store, because every write is a full-table read
 *     plus a merge;
 *   - `POST /api/v1/ingest/run` fans out to ~46 countries against two real
 *     third-party services, and a caller can start one per second;
 *   - a token-guessing attempt costs the server a full authentication path per
 *     guess, and there is no cost to making the guesses.
 *
 * `tryAcquire` rather than `acquire`, deliberately: an inbound limiter that
 * queues turns a flood into a memory backlog. 429 with `Retry-After` tells the
 * caller what to do and costs the server one map lookup.
 */

/** Requests per window for one client, by request class. */
export const INBOUND_POLICIES = Object.freeze({
  // A console polls a dozen endpoints every thirty seconds, and a *cold page
  // load* asks for twenty-odd assets in parallel. Concurrency is 24 for that
  // reason: at 8 the ninth simultaneous asset request was refused while it was
  // in flight, so a field worker's first page load after a deploy came up
  // partly unstyled — and the browser gate caught it, 69 refusals across seven
  // surfaces. The per-minute rate still refuses a loop; the cap exists to bound
  // simultaneous work, not to ration a page load.
  //
  // The rate moved from 120 to 300 for a measured reason: it was set when a
  // read materialised the whole store — 110 ms and 143 MB for one endpoint,
  // measured at 39,696 records. ENH-07 gave `read()` a collection manifest, and a
  // single-collection read is now 14 ms. The budget is a claim about what a read
  // costs, so it has to follow the cost: at 300/min a supervisor can keep four
  // consoles polling (12 endpoints every 30 s each) and still navigate, while a
  // loop that hammers one endpoint is refused inside a second.
  read: { ratePerWindow: 300, windowMs: 60_000, concurrency: 24 },
  // Writes are the expensive ones: each is a store merge. A field worker's
  // offline queue drains in a burst when signal returns, so the burst is real
  // and the budget has to admit it.
  write: { ratePerWindow: 60, windowMs: 60_000, concurrency: 6 },
  // Ingestion and other fan-outs: one at a time per client. Two concurrent runs
  // from one caller is a bug, and it costs ~92 upstream requests.
  //
  // Unchanged by the read fix above, because a browser never issues two of these.
  heavy: { ratePerWindow: 6, windowMs: 60_000, concurrency: 1 },
})

/**
 * Paths that must never be limited, because a limit is an outage.
 *
 * `/ready` is here so a load balancer can reach it, and `/metrics` because a
 * scrape is a monitoring system, not a client.
 */
export const UNLIMITED = Object.freeze([
  '/api/v1/health',
  '/api/v1/ready',
  '/api/v1/readyz',
  '/metrics',
  '/api/v1/metrics',
])

/**
 * Static assets are not a read.
 *
 * The limiter exists to bound the two things that can be expensive: work against
 * the store, and requests against upstream providers. A stylesheet is neither —
 * it is a file served from disk, and it happens once per page load because the
 * browser cannot cache it across a cold start.
 *
 * Charging it to the read budget is a defect, and the browser gate is what
 * found it: seven surfaces × ~25 assets is ~175 GETs in a couple of minutes
 * from one address, which is over any sane per-minute budget, so every surface
 * after the first came up partly unstyled. R-09's harm — one upload saturating
 * the store — is not reachable through a CSS file, so the budget was refusing
 * pages to protect against something it cannot protect against.
 *
 * The API keeps its budget; `/api/v1/*` is a read no matter what it asks for.
 */
const STATIC_ASSET = /\.(?:js|mjs|css|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|map|webmanifest|txt|md)(\?|$)/i
const STATIC_PREFIX = /^\/(?:shared|workflow|panels|assets|img|images|fonts)\//

/** The fan-out endpoints, which get the `heavy` budget. */
const HEAVY = [
  /^\/api\/v1\/ingest\/run(-one)?$/,
  /^\/api\/v1\/ingest\/run-due$/,
  /^\/api\/v1\/ingest\/schedules\/defaults$/,
  /^\/api\/v1\/report-schedules\/run-due$/,
]

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Which budget a request draws on.
 *
 * By method and path, and the path rules are enumerated rather than guessed: a
 * prefix rule (`/api/v1/ingest`) would put `/ingest/sources` — a cheap read —
 * on the one-per-minute budget, and the console would start seeing 429s on a
 * page load.
 */
export function inboundClassFor(method, pathname) {
  if (UNLIMITED.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return null
  // A write is a write whatever it fetches: a POST that downloads a file is
  // still spending the caller's budget against us.
  const isWrite = WRITE_METHODS.has(String(method || 'GET').toUpperCase())
  // Not an API path, and not a spatial catalogue over the store, so this is a
  // document or an asset: a file read from disk.
  //
  // `/stac/` and `/ogc/` are the exception, and deliberately — they look like
  // static routes and are not. Both read the store and render collections, so
  // they carry a read budget like any other read of the data.
  const readsStore = pathname.startsWith('/api/v1') || pathname === '/metrics'
    || pathname.startsWith('/stac/') || pathname.startsWith('/ogc/')
  if (!isWrite && !readsStore) return null
  if (HEAVY.some((re) => re.test(pathname))) return 'heavy'
  return WRITE_METHODS.has(String(method || 'GET').toUpperCase()) ? 'write' : 'read'
}

/**
 * The client identity, and how much we trust it.
 *
 * `x-forwarded-for` is a client-settable header. It is used only when the
 * deployment says a proxy sets it (`LINDELA_LITE_TRUST_PROXY=1`), and then only
 * its *last* hop — the entry a trusting proxy appended itself, which a client
 * cannot overwrite. A spoofed chain can therefore widen a caller's own budget
 * (they burn tokens under a name they invented) but never narrow someone
 * else's: the last entry is the one the trusted proxy observed.
 *
 * With no proxy trusted, the socket address is the only identity available, and
 * it is the honest one.
 */
export function clientKeyFor(req, { trustProxy = process.env.LINDELA_LITE_TRUST_PROXY === '1' } = {}) {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for']
    const hops = String(header || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (hops.length) {
      const observed = hops[hops.length - 1]
      return { key: `xf:${observed}`, viaProxy: true }
    }
  }
  const address = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown'
  return { key: `addr:${address}`, viaProxy: false }
}

/**
 * A registry of per-client limiters, evicted so a deployment cannot be
 * exhausted by making the key space large. The bound is the point: an unbounded
 * map keyed on a client-supplied string is a memory leak with a 429 in front
 * of it.
 */
export function createInboundLimiter({
  policies = INBOUND_POLICIES,
  maxClients = 10_000,
  now = Date.now,
  sleep,
} = {}) {
  /** clientKey → className → limiter, in last-seen order. */
  const byClient = new Map()

  const limiterFor = (clientKey, className) => {
    let entry = byClient.get(clientKey)
    if (!entry) {
      entry = new Map()
      byClient.set(clientKey, entry)
    }
    let limiter = entry.get(className)
    if (!limiter) {
      const policy = policies[className]
      if (!policy) return null
      limiter = createRateLimiter({ ...policy, now, sleep, name: `${className}:${clientKey}` })
      entry.set(className, limiter)
    }
    // Re-insert so Map's insertion order is a recency order for eviction.
    byClient.delete(clientKey)
    byClient.set(clientKey, entry)
    while (byClient.size > maxClients) {
      byClient.delete(byClient.keys().next().value)
    }
    return limiter
  }

  return {
    /**
     * Charge this request to the caller.
     *
     * Returns `{ allowed: true, release }` or `{ allowed: false, retryAfterMs }`.
     * The caller must invoke `release` when the response is finished, or the
     * concurrency slot is held until the process ends.
     */
    charge(req, url) {
      const className = inboundClassFor(req.method, url.pathname)
      if (!className) return { allowed: true, release: () => {}, unlimited: true, className: null }
      const { key } = clientKeyFor(req)
      const limiter = limiterFor(key, className)
      if (!limiter) return { allowed: true, release: () => {}, className }
      const result = limiter.tryAcquire()
      if (!result.allowed) {
        return { allowed: false, className, retryAfterMs: result.retryAfterMs }
      }
      return { allowed: true, className, release: result.release }
    },

    /** Diagnostics for `/ready` and a test. */
    clients: () => byClient.size,
    classes: (clientKey) => [...(byClient.get(clientKey)?.keys() || [])],
  }
}

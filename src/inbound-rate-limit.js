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
  // A console polls a dozen endpoints every thirty seconds. Two a second is
  // generous for one operator and still refuses a loop.
  read: { ratePerWindow: 120, windowMs: 60_000, concurrency: 8 },
  // Writes are the expensive ones: each is a store merge. A field worker's
  // offline queue drains in a burst when signal returns, so the burst is real
  // and the budget has to admit it.
  write: { ratePerWindow: 60, windowMs: 60_000, concurrency: 6 },
  // Ingestion and other fan-outs: one at a time per client. Two concurrent runs
  // from one caller is a bug, and it costs ~92 upstream requests.
  heavy: { ratePerWindow: 6, windowMs: 60_000, concurrency: 1 },
})

/** Paths that must never be limited, because a limit is an outage. */
export const UNLIMITED = Object.freeze([
  '/api/v1/health',
  '/api/v1/ready',
  '/api/v1/readyz',
  '/metrics',
  '/api/v1/metrics',
])

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

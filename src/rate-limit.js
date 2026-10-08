/**
 * ENH-11: the rate limits the connectors already declare, made to bind.
 *
 * Seven connectors carry `defaults.rateLimit` — `ipc_hdx` at 20/min, `gdacs` and
 * `glofas` at 120/min, the rest between 30 and 60 — and nothing read the field.
 * It was documentation that actively lied: `ipc-hdx.js:265` fans ~46 countries
 * through one `Promise.all`, two requests each, so a single run issues ~92 calls
 * against a 20/min budget. Meanwhile `http.js:6` throws on a non-2xx without
 * reading `Retry-After`, so a provider asking for a pause gets hammered through
 * the backoff instead, and `distributeReport` has no timeout at all.
 *
 * This module is the mechanism, not the wiring. It is imported by the connector
 * layer (a parallel change) and by nothing else yet. The contract it offers:
 *
 *   createRateLimiter({ ratePerWindow, windowMs, concurrency, jitterMs,
 *                       now, sleep, jitter, name })
 *       .acquire()            -> Promise<release: () => void>  FIFO, never drops
 *       .tryAcquire()         -> { allowed, release?, retryAfterMs }  never queues
 *       .nextTokenMs()        -> ms until the next grant would be allowed,
 *                                 read-only and non-consuming; what the 429
 *                                 path in `connectors/http.js` consults
 *       .inFlight() .queued() -> observability for metrics and for tests
 *   enforce(limiter, fn)     -> runs fn under the limiter, releases in `finally`
 *   parseRetryAfter(value)   -> ms, or null when absent/unparseable (never 0)
 *   coerceLimit(declared)    -> { ratePerWindow, windowMs } or null; no default
 *   createBudget({ totalMs, name, expectedRequests, now })
 *       .remainingMs() .isExhausted() .remaining() .issue()
 *   RATE_LIMIT_POLICIES      -> frozen source id -> { ratePerWindow, windowMs,
 *                                          concurrency }, straight from the
 *                                          connectors' own declarations
 *
 * The clock and the sleep function are constructor arguments because the test
 * suite is `node --test` and a timing-sensitive test is a flaky test. Nothing in
 * here calls `Date.now()` or `setTimeout` on the default path except the two
 * documented defaults themselves.
 *
 * Two deliberate refusals:
 *
 * - `coerceLimit` returns `null` for a declaration it cannot read. A limiter
 *   that falls back to a permissive default on a malformed field is worse than
 *   no limiter at all, because the call site now believes the source is
 *   protected. A `null` is a refusal the caller has to handle; a default is a
 *   lie nobody has to handle, which is exactly how `rateLimit` spent two years.
 * - `parseRetryAfter` returns `null` rather than `0` for an absent header.
 *   Zero means "the provider said nothing, so go now", and a retry loop that
 *   reads it that way turns a rate-limit response into a hot loop. `null` sends
 *   the caller to its own backoff instead.
 */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Unit spellings accepted in the string form (`'20/min'`). Everything here is a
// declaration somebody could plausibly type; an unlisted one returns null.
const UNITS = Object.freeze({
  ms: 1,
  s: SECOND,
  sec: SECOND,
  secs: SECOND,
  second: SECOND,
  seconds: SECOND,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
})

/** `perSecond`/`perMinute`/`perHour`/`perDay` object keys, same mapping. */
const PER_KEYS = Object.freeze({
  persecond: SECOND,
  per_second: SECOND,
  perminute: MINUTE,
  per_minute: MINUTE,
  perhour: HOUR,
  per_hour: HOUR,
  perday: DAY,
  per_day: DAY,
})

const STRING_LIMIT = /^(\d+)\s*(?:\/|\s+per\s+)\s*([a-z]+)$/i

/**
 * A token bucket plus a hard concurrency cap, with an injected clock.
 *
 * The bucket refills continuously rather than resetting on a window boundary:
 * a fixed window admits 2N requests either side of a reset, which is how a
 * declared "20/min" becomes 40 in the worst minute. Capacity is
 * `ratePerWindow`, so an idle run starts with a full bucket and a busy one
 * settles to a steady drip.
 *
 * `concurrency` is a queue, not a rejection: a caller that must not block uses
 * `tryAcquire`, and everything else waits in FIFO order. Nothing is ever
 * dropped — a dropped waiter is a silently missing country, which is the
 * failure mode this repository keeps paying for.
 */
export function createRateLimiter({
  ratePerWindow = 1,
  windowMs = MINUTE,
  concurrency = 1,
  jitterMs = 0,
  now = Date.now,
  sleep = defaultSleep,
  jitter = defaultJitter,
  name = 'unnamed',
} = {}) {
  if (!Number.isFinite(ratePerWindow) || ratePerWindow <= 0) {
    throw new TypeError(`createRateLimiter: ratePerWindow must be a positive number; got ${ratePerWindow}`)
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError(`createRateLimiter: windowMs must be a positive number; got ${windowMs}`)
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError(`createRateLimiter: concurrency must be a positive integer; got ${concurrency}`)
  }
  if (!Number.isFinite(jitterMs) || jitterMs < 0) {
    throw new TypeError(`createRateLimiter: jitterMs must be zero or more; got ${jitterMs}`)
  }

  // Tokens as a float. Rounding them to integers here would make a
  // 20/min budget leak a token per refill, and a budget that leaks is a budget
  // that is not there.
  let tokens = ratePerWindow
  let lastRefillAt = now()
  let inFlight = 0
  let wakePending = false
  const queue = []

  function refill() {
    const at = now()
    const elapsed = at - lastRefillAt
    if (!(elapsed > 0)) return
    tokens = Math.min(ratePerWindow, tokens + (elapsed * ratePerWindow) / windowMs)
    lastRefillAt = at
  }

  // Time until one whole token exists, ignoring concurrency. ceil() because
  // flooring to the wake time wakes the timer a hair early and the drain
  // simply declines; the loop cost is one extra no-op pass, not a busy spin.
  function tokenWaitMs() {
    if (tokens >= 1) return 0
    return Math.max(1, Math.ceil(((1 - tokens) * windowMs) / ratePerWindow))
  }

  function grant(waiter) {
    tokens -= 1
    inFlight += 1
    let released = false
    waiter.resolve(() => {
      // Idempotent. A double release would hand out a slot nobody holds and
      // let the cap drift above its own setting, which is a limit that has
      // stopped limiting.
      if (released) return
      released = true
      inFlight -= 1
      drain()
    })
  }

  function drain() {
    for (;;) {
      const head = queue[0]
      if (!head) return
      refill()
      if (inFlight >= concurrency || tokens < 1) {
        // Blocked on the clock: wake exactly one waiter when a token lands.
        // Blocked only on a slot: no timer, because the slot frees on a
        // release() and a guessed interval would either busy-wait or stall.
        if (inFlight < concurrency) scheduleWake()
        return
      }
      queue.shift()
      grant(head)
    }
  }

  function scheduleWake() {
    if (wakePending) return
    wakePending = true
    const delay = tokenWaitMs() + jitterDelay()
    sleep(delay).then(() => {
      wakePending = false
      drain()
    })
  }

  // Jitter spreads a fan-out that wakes on the same token. Without it 46
  // countries queued behind a 20/min bucket release in lockstep at the token
  // boundary and arrive at the provider as a burst.
  function jitterDelay() {
    return jitterMs > 0 ? Math.floor(jitter(jitterMs)) : 0
  }

  return {
    name,
    ratePerWindow,
    windowMs,
    concurrency,

    /** Wait for a token and a free slot. Resolves with the release function. */
    acquire() {
      return new Promise((resolve) => {
        queue.push({ resolve })
        drain()
      })
    },

    /**
     * Take a token and a slot if both are free, else say so and return.
     *
     * `retryAfterMs` is null when the block is a held slot rather than a short
     * bucket: no clock time releases it, so there is no honest number to
     * report and a fabricated one would invite a caller to poll on a deadline
     * that does not exist.
     */
    tryAcquire() {
      refill()
      if (inFlight >= concurrency || tokens < 1) {
        return { allowed: false, release: null, retryAfterMs: inFlight >= concurrency ? null : tokenWaitMs() }
      }
      let release = null
      const waiter = { resolve: (fn) => { release = fn } }
      grant(waiter)
      return { allowed: true, release, retryAfterMs: 0 }
    },

    inFlight: () => inFlight,
    queued: () => queue.length,
    /** Tokens on hand, for a log line or a test. Not a stable public contract. */
    tokens: () => tokens,

    /**
     * How long until this limiter would grant the next request, in ms. Zero
     * when one is available now.
     *
     * Read-only and non-consuming, which is the whole reason it exists and the
     * reason `tryAcquire` cannot answer the question. `tryAcquire` *takes* a
     * token to find out, so asking "how long would I wait?" that way spends the
     * answer: a caller probing before deciding whether to sleep would empty its
     * own bucket one probe at a time, and a bucket that leaks under observation
     * is not a budget.
     *
     * A held concurrency slot contributes nothing here. No clock time releases
     * a slot — a `release()` does — so folding it in would produce a deadline
     * that never arrives, and a caller sleeping to it would stall on a number
     * that is not waiting for anything.
     *
     * This is what makes the 429 path in `connectors/http.js` consult the
     * limiter's own state: a provider refusing a request has told us the bucket
     * is ahead of the provider's idea of the budget, and the honest delay is
     * whichever is longer — the provider's `Retry-After` or the time until this
     * bucket has a token — rather than a fixed backoff that ignores both.
     */
    nextTokenMs() {
      refill()
      return tokenWaitMs()
    },
  }
}

/**
 * Run `fn` under `limiter`, releasing the slot whatever happens.
 *
 * The `finally` is the whole point. A leaked slot is the quietest degradation in
 * this codebase: one connector throwing once would hold its slot for the rest of
 * the process, and the source would fall to exactly one in-flight request
 * forever while every test still passed and every run still "succeeded". The
 * leak test in `test/rate-limit.test.js` fails if this block is removed.
 */
export async function enforce(limiter, fn) {
  const release = await limiter.acquire()
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * `Retry-After` in either of its two forms, as milliseconds.
 *
 * delta-seconds: `Retry-After: 120`. HTTP-date: `Retry-After: Wed, 21 Oct 2015
 * 07:28:00 GMT`, which is absolute and therefore needs the clock to become
 * relative — hence the injectable `now`.
 *
 * Absent, malformed, negative and inverted all return null. Zero is never the
 * right answer to "the provider did not tell us": it is the one value that
 * makes a retry loop tight instead of polite, which is the exact behaviour this
 * function replaces. A date in the past is clamped to 1ms for the same reason —
 * a server whose clock is behind ours would otherwise be answered with an
 * instant retry, once per response.
 *
 * Node hands headers over as a string or an array of strings; an array takes
 * its first element, because a duplicate `Retry-After` with the smaller value
 * would need parsing both and no provider sends one.
 */
export function parseRetryAfter(headerValue, { now = Date.now } = {}) {
  if (Array.isArray(headerValue)) headerValue = headerValue[0]
  if (headerValue === null || headerValue === undefined) return null

  if (typeof headerValue === 'number') {
    if (!Number.isFinite(headerValue) || headerValue < 0) return null
    return headerValue === 0 ? null : Math.round(headerValue * SECOND)
  }

  if (typeof headerValue !== 'string') return null

  const raw = headerValue.trim()
  if (!raw) return null

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw)
    return seconds === 0 ? null : seconds * SECOND
  }

  // Date.parse is a generous parser, not a validator: it reads '-5' as the year
  // 2000 and '1.2.3' as 3 February. An HTTP-date always carries a month name,
  // so a letter is the cheapest honest test for "this is meant to be a date".
  if (!/[a-z]/i.test(raw) || raw.startsWith('-') || raw.startsWith('+')) return null

  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null

  return Math.max(1, at - now())
}

/**
 * Normalise a connector's `rateLimit` declaration into `{ ratePerWindow,
 * windowMs }`, or null when it cannot be read.
 *
 * Shapes accepted, and where each comes from:
 *
 *   { perMinute: 120 }            the only shape in `src/connectors/*.js` today
 *   '20/min', '20 per minute'     string form; nothing uses it yet, so it is
 *                                 here before someone writes it and expects it
 *                                 to work rather than after it silently does not
 *   { ratePerWindow, windowMs }   this module's own output, so a policy can be
 *                                 fed back through its own normaliser
 *   { requests, windowMs }        { max, windowMs } also read, matching the
 *                                 `retry: { max, backoffMs }` idiom already in
 *                                 the connector defaults
 *   { perHour }, { perDay }, …    the rest of the PER_KEYS table
 *
 * Null on: a missing field, a non-object, a zero or negative rate, a
 * non-integer rate, an unlisted unit, and anything numeric that is not finite.
 * All of those return null rather than a default, because a default here reads
 * downstream as "this source is limited".
 */
export function coerceLimit(declared) {
  if (declared === null || declared === undefined) return null

  if (typeof declared === 'string') return fromString(declared)
  if (typeof declared !== 'object' || Array.isArray(declared)) return null

  // This module's own shape first: ratePerWindow is unambiguous, and a policy
  // object carrying a `concurrency` key should not fall through to a unit table
  // that would reject it.
  if (declared.ratePerWindow !== undefined) return pair(declared.ratePerWindow, declared.windowMs)

  // The declared key is matched case-insensitively against PER_KEYS rather than
  // looked up by its own spelling: the connector writes `perMinute` and the
  // table is keyed lowercase, so an exact lookup silently found nothing and
  // every `{ perMinute: N }` read as an unreadable declaration.
  //
  // A `windowMs` alongside a per-unit key has to agree with it. Silently
  // dropping one half of a contradictory declaration is how `{ perMinute: 10,
  // windowMs: 0 }` becomes "10 per minute" and a limiter that looks configured
  // is running on the wrong window.
  for (const [key, value] of Object.entries(declared)) {
    const unit = PER_KEYS[key.toLowerCase()]
    if (unit === undefined) continue
    if (declared.windowMs !== undefined && declared.windowMs !== unit) return null
    return pair(value, unit)
  }

  for (const key of ['requests', 'max', 'count']) {
    if (declared[key] !== undefined) return pair(declared[key], declared.windowMs)
  }

  return null
}

function fromString(value) {
  const match = value.trim().match(STRING_LIMIT)
  if (!match) return null
  const unit = UNITS[match[2].toLowerCase()]
  if (!unit) return null
  return pair(Number(match[1]), unit)
}

function pair(rate, windowMs) {
  if (!Number.isInteger(rate) || rate < 1) return null
  if (!Number.isInteger(windowMs) || windowMs < 1) return null
  return { ratePerWindow: rate, windowMs }
}

/**
 * A per-source wall-clock budget.
 *
 * The failure it exists for: `gdacs-archive` walks 1985→now quarter by quarter,
 * and a full-range backfill has been observed reaching ~4.2 hours while holding
 * a request socket and a run slot the entire time. A timeout on the individual
 * request does not help — each one is a healthy 30s call, and it is the sum that
 * runs away. The budget is spent across the whole source, so the caller checks
 * `remainingMs()` between requests and abandons the run while it can still say
 * why, instead of being reaped by a socket that outlives the process.
 *
 * `remaining()` is the pacing half: the interval the next request may wait so
 * the rest of the run fits inside what is left. It needs a denominator — pass
 * `expectedRequests`, or the budget is a guard only and `remaining()` is 0,
 * because "how many requests are left" is not derivable from a clock.
 */
export function createBudget({ totalMs, name = 'unnamed', expectedRequests = 0, now = Date.now } = {}) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    throw new TypeError(`createBudget: totalMs must be a positive number; got ${totalMs}`)
  }
  if (!Number.isInteger(expectedRequests) || expectedRequests < 0) {
    throw new TypeError(`createBudget: expectedRequests must be a non-negative integer; got ${expectedRequests}`)
  }

  const startedAt = now()
  let issued = 0

  function remainingMs() {
    // max(0, ...) so an overspent budget reports zero and not a negative
    // interval that a caller would honour by sleeping backwards.
    return Math.max(0, totalMs - (now() - startedAt))
  }

  function remaining() {
    const left = remainingMs()
    if (left <= 0 || expectedRequests < 1) return 0
    const slotsLeft = Math.max(1, expectedRequests - issued)
    return Math.floor(left / slotsLeft)
  }

  return {
    name,
    totalMs,
    expectedRequests,
    remainingMs,
    isExhausted: () => remainingMs() <= 0,
    remaining,
    /** Reserve one request against the budget. Counts even when it is denied. */
    issue() {
      // The wait belongs to the request being issued, so it is computed against
      // the slots that exist *before* this one takes one. Counting first would
      // hand out a shorter interval for every request and overrun the budget by
      // the length of the run.
      const left = remainingMs()
      const waitMs = left > 0 ? remaining() : null
      issued += 1
      if (left <= 0) {
        return { allowed: false, waitMs: null, reason: `${name}: wall-clock budget of ${totalMs}ms exhausted` }
      }
      return { allowed: true, waitMs, reason: null }
    },
    issued: () => issued,
    elapsedMs: () => now() - startedAt,
  }
}

/**
 * The declared budgets, made real.
 *
 * Every rate here is copied from a `defaults.rateLimit` the connector already
 * carried and nothing read — `ipc_hdx` 20/min, `gdacs` 120/min, `glofas`
 * 120/min, `open_meteo` 60/min, `usgs_earthquake` 60/min, `noaa_enso` 30/min,
 * `who_gho` 30/min. Check any of them against the provider's published budget
 * and correct the connector; this table is not a place to invent a number.
 *
 * `concurrency` is the one field no connector declares, so it is stated rather
 * than assumed, and it differs for one source. `ipc-hdx.js:265` is the only
 * fan-out in the connector layer: ~46 countries through one `Promise.all`, two
 * requests each, ~92 calls against 20/min. It gets 2 — one country in flight
 * while the next one's `package_show` is in transit — because a cap of 1 would
 * serialise the run and a cap of 46 is the defect. Everything else runs its
 * requests in a `for...of` loop and never fans out, so 1 records what is
 * already true and puts a floor under any fan-out added later. Nothing here
 * claims a provider's concurrency ceiling, because no connector says one.
 *
 * `gdacs_archive`, `chirps`, `nasa_firms`, `open_meteo_archive`,
 * `open_meteo_flood`, `dhis2` and the upload sources declare no rate limit at
 * all and are therefore absent. That absence is the gap `test/rate-limit.test.js`
 * checks: the moment one of them adds a declaration, the test fails until the
 * policy lands here.
 */
export const RATE_LIMIT_POLICIES = Object.freeze({
  ipc_hdx: Object.freeze({ ratePerWindow: 20, windowMs: MINUTE, concurrency: 2 }),
  who_gho: Object.freeze({ ratePerWindow: 30, windowMs: MINUTE, concurrency: 1 }),
  noaa_enso: Object.freeze({ ratePerWindow: 30, windowMs: MINUTE, concurrency: 1 }),
  open_meteo: Object.freeze({ ratePerWindow: 60, windowMs: MINUTE, concurrency: 1 }),
  usgs_earthquake: Object.freeze({ ratePerWindow: 60, windowMs: MINUTE, concurrency: 1 }),
  gdacs: Object.freeze({ ratePerWindow: 120, windowMs: MINUTE, concurrency: 1 }),
  glofas: Object.freeze({ ratePerWindow: 120, windowMs: MINUTE, concurrency: 1 }),

  // R-11's remainder. These five call sites already pass `source`, so the
  // limiter keyed on it was live for them the moment a policy existed — the
  // table was the whole gap, which is why the audit could find fourteen
  // call sites and seven declarations and call the configuration inert.
  //
  // Values are deliberately below what each provider tolerates rather than at
  // it, and every one is paired with concurrency 1: these are polling archives
  // and a directory crawls, not APIs being used.
  //
  // A per-minute bucket cannot express a daily allowance, and one of these
  // providers has one (`nasa_firms`). That is a real limit this table does not
  // model, and the honest thing is to say so here rather than let 5/min read as
  // "we are inside FIRMS' daily cap" — at five a minute, twenty-four hours of
  // running would exceed it. `test/rate-limit-wiring.test.js` asserts the
  // coverage, not the correctness of these numbers against a provider.
  chirps: Object.freeze({ ratePerWindow: 10, windowMs: MINUTE, concurrency: 1 }),
  nasa_firms: Object.freeze({ ratePerWindow: 5, windowMs: MINUTE, concurrency: 1 }),
  gdacs_archive: Object.freeze({ ratePerWindow: 20, windowMs: MINUTE, concurrency: 1 }),
  open_meteo_archive: Object.freeze({ ratePerWindow: 30, windowMs: MINUTE, concurrency: 1 }),
  open_meteo_flood: Object.freeze({ ratePerWindow: 30, windowMs: MINUTE, concurrency: 1 }),
  // Same host and same published budget as open_meteo; the forecast overlay
  // polls five districts per run, sequentially.
  open_meteo_forecast: Object.freeze({ ratePerWindow: 60, windowMs: MINUTE, concurrency: 1 }),
  // ReliefWeb (ADR-014): one RSS fetch or one v2 API call per ingest — a
  // handful per 6-hour window. The connector's own declared budget (spec
  // defaults rateLimit.perMinute: 30) is what this table must match; the
  // declarations test fails the drift.
  reliefweb_epidemics: Object.freeze({ ratePerWindow: 30, windowMs: MINUTE, concurrency: 1 }),
})

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultJitter(ceilingMs) {
  return Math.random() * ceilingMs
}
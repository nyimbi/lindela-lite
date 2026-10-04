/**
 * The one funnel every connector's HTTP passes through.
 *
 * It did three things: fetch, retry, parse. Two things it should have done were
 * left to the callers, and both were the same kind of omission — a mechanism
 * that existed and was never asked for.
 *
 * ## Limits (`src/rate-limit.js`)
 *
 * Seven connectors declare `defaults.rateLimit` — `ipc_hdx` at 20/min,
 * `gdacs` and `glofas` at 120/min — and `ipc-hdx.js:265` fans ~46 countries
 * through one `Promise.all`, two requests each, so a single run issues ~92
 * calls against a 20/min budget. Nothing read the field, because nothing here
 * read it. A caller now passes `rateLimit` (any shape `coerceLimit` accepts,
 * including the string form) or a `source` id that names a row in
 * `RATE_LIMIT_POLICIES`; either way the request waits for a token rather than
 * bursting, and the limiter is keyed by host as well as source, because two
 * sources on two hosts have two budgets and a shared one would limit the sum of
 * two unrelated things against the smaller of their declarations.
 *
 * `Retry-After` was discarded. `!response.ok` threw `new Error('HTTP ' + status)`
 * with the headers still on the response object nobody held, so a provider
 * saying "two minutes" got the 150ms backoff instead. The error now carries
 * `status`, `headers` and `retryAfterMs`, and the retry delay is
 * `max(backoff, retryAfterMs)`. `parseRetryAfter` returns `null` for a header
 * that says nothing, so a provider that omits it lands on the backoff it always
 * did — the 16 existing callers pass neither `rateLimit` nor `source` and get
 * byte-identical behaviour to before, because `limiterFor` returns null and the
 * acquire/release pair is simply absent.
 *
 * `now` and `sleep` are forwarded to the limiter so a test can exercise a
 * 60-second window without sleeping through it. Neither is a production option;
 * both default to the module's own clock.
 *
 * ## Capture (`src/capture.js`)
 *
 * This function returns a *parsed* body and throws the raw bytes away, so
 * `upstream_url_or_endpoint` could only ever be null and no fixture could be cut
 * from a real response. `beginCapture()` turns that on for the process:
 * every response is read once as bytes, hashed, and stored with its URL,
 * status, content type, headers and retrieval time before it is parsed. The
 * parsing decision does not change what a caller receives — a text connector
 * still gets a string, a binary one still gets a Buffer — but the evidence is
 * now kept instead of discarded.
 *
 * `withCapture` is not used here, and that is a decision rather than an
 * oversight. It is a `globalThis.fetch` wrapper that needs `response.clone()`,
 * so capturing costs a second full copy of every body and a Response the
 * connectors never asked for. At this seam the bytes are already in hand, in
 * the only buffer anyone will read, which is also why capture happens *before*
 * the `!response.ok` check: a 429 body is the evidence for a source that failed
 * at 03:00, and it is the body a naive wrapper loses.
 *
 * `beginCapture({ replay: true })` serves stored bytes instead of fetching, so a
 * connector test replays a real response rather than hand-writing a stub. The
 * replay store throws on a URL it does not hold rather than answering with an
 * empty body, because an empty body is indistinguishable from a provider that
 * genuinely returned nothing — which is how the GloFAS and CHIRPS defects got
 * in, and how a replay that hides them gets in again.
 *
 * `scripts/capture-fixtures.mjs` stays the CLI, and it and this path write
 * through the same `CaptureStore.add` with the same fields, so a capture taken
 * from a run and a capture taken by the script are the same object: same hash,
 * same kind, same manifest line. That is the reconciliation — one entry point
 * was already the seam, and it was waiting for the code that used it.
 */
import { CaptureStore, createReplayStore } from '../capture.js'
import { coerceLimit, createRateLimiter, parseRetryAfter, RATE_LIMIT_POLICIES } from '../rate-limit.js'

/** Limiters, keyed by source and host. Created on first use, reused after. */
const limitersByKey = new Map()

/** Non-null only between `beginCapture` and `endCapture`. */
let activeCapture = null

/**
 * Start capturing every response this process fetches.
 *
 * `store` defaults to a fresh in-memory one, which is the whole store — the
 * service can hold it and prune it, or hand it to `seedFixturesFromCaptures`.
 * `source` labels every capture; without it each entry is labelled with the
 * response's own hostname, which is a worse name than a connector's id but an
 * honest one, and no connector passes one today.
 *
 * `replay: true` serves what the store already holds and performs no fetch at
 * all. Captures taken during a replay would be copies of copies, so they are
 * not taken.
 */
export function beginCapture({ store = new CaptureStore(), source = null, replay = false } = {}) {
  if (!(store instanceof CaptureStore)) throw new TypeError('beginCapture: store must be a CaptureStore')
  activeCapture = {
    store,
    source,
    replay: Boolean(replay),
    // With the tombstones, so a replay can say "we captured that and the
    // retention policy took it" rather than returning an empty provider response.
    // Without them a pruned capture and a capture that never existed are the same
    // absence, which is the exact confusion the tombstone exists to prevent.
    replayFetch: replay ? createReplayStore(store.list(), { tombstones: store.tombstones?.() || [] }) : null,
  }
  return activeCapture
}

/** Stop capturing. Returns the store so far, or null if capture was off. */
export function endCapture() {
  const active = activeCapture
  activeCapture = null
  return active?.store ?? null
}

/** The capture store while capture is on, else null. */
export function captureStore() {
  return activeCapture?.store ?? null
}

/** True when `fetchWithRetry` is serving stored bodies instead of fetching. */
export function isReplaying() {
  return Boolean(activeCapture?.replay)
}

// ---------------------------------------------------------------
// Per-run request recording
// ---------------------------------------------------------------
// `beginCapture` is the fixture path: a caller that wants bodies kept takes the
// whole store and prunes it. Ingestion wants something narrower and shorter-
// lived — it wants the URLs one source run pulled through, so the lineage row
// can say where the data came from, because no connector exposes the URLs it
// builds internally.
//
// That was added as `beginFetchRecording`/`endFetchRecording` in ingestion.js
// and never landed here, so the server has not booted since. A key per run
// rather than a single active capture: two sources ingesting concurrently each
// see only their own requests, which a single slot cannot express.

const recordingsByKey = new Map()

/** Begin attributing fetches to `key`. Returns the list it will be appended to. */
export function beginFetchRecording(key) {
  const list = []
  recordingsByKey.set(key, list)
  return list
}

/**
 * Stop attributing to `key` and return what it pulled through.
 *
 * Returns an empty list for a key that was never begun, or one already ended,
 * rather than throwing: a lineage row that cannot name a source is a blank
 * field, and a crash in the ingestion loop over a missing recording is a far
 * worse outcome than the blank.
 */
export function endFetchRecording(key) {
  const list = recordingsByKey.get(key)
  recordingsByKey.delete(key)
  return list ?? []
}

/** The active recording list for `key`, or null. */
export function fetchRecording(key) {
  return recordingsByKey.get(key) ?? null
}

/** Forget every recording. Tests need it so two runs do not share one. */
export function resetFetchRecordings() {
  recordingsByKey.clear()
}

/**
 * Forget every limiter.
 *
 * A limiter is stateful and a policy change or a long-lived process needs to
 * drop the old buckets; tests need it so two runs do not share one. Rates are
 * read from `RATE_LIMIT_POLICIES` at creation, so this is also how a corrected
 * declaration takes effect without a restart.
 */
export function resetRateLimiters() {
  limitersByKey.clear()
}

export async function fetchWithRetry(url, {
  retries = 2,
  timeoutMs = 20000,
  parse = 'text',
  headers,
  // Wiring for the two modules below. Every one of these is absent from all
  // sixteen existing call sites, which is what keeps their behaviour unchanged.
  source = null,
  rateLimit = null,
  concurrency,
  jitterMs = 0,
  now,
  sleep,
  ratePerWindow,
  windowMs,
} = {}) {
  const target = String(url instanceof URL ? url.href : url)
  const limiter = limiterFor(target, { source, rateLimit, concurrency, jitterMs, now, sleep, ratePerWindow, windowMs })
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let release = null
    try {
      if (limiter) release = await limiter.acquire()
      const response = await performFetch(target, { timeoutMs, headers })
      const bytes = await captureBody(response, target, source)
      if (!response.ok) throw httpError(response)
      return decode(bytes, response, parse)
    } catch (error) {
      lastError = error
      if (attempt < retries) await delay(retryDelayMs(error, attempt, limiter), sleep)
    } finally {
      // Per attempt, not per call: a retry is another request and takes another
      // token. A slot held across the backoff would let a rate-limited source
      // sit on its only permit while doing nothing.
      if (release) release()
    }
  }
  throw lastError
}

/**
 * The limiter for this request, or null when the caller declared nothing.
 *
 * `coerceLimit` returning null for an unreadable declaration is honoured
 * rather than replaced by a default: a limiter built on a guess is worse than
 * none, because the call site would then believe the source is protected. The
 * refusal is visible here instead — no limiter, and the fetch is not slowed by
 * one that was configured from a number nobody vouched for.
 */
function limiterFor(target, { source, rateLimit, concurrency, jitterMs, now, sleep, ratePerWindow, windowMs }) {
  const declared = rateLimit === null || rateLimit === undefined ? policyFor(source) : coerceLimit(rateLimit)
  if (!declared) return null

  // An explicit window overrides the declared one. Without this a caller cannot
  // ask for a shorter window than the policy states, which is what makes the
  // limiter testable — asserting a 60-second refill takes a minute of wall
  // clock, so every such test either runs slowly or asserts nothing.
  if (Number.isFinite(ratePerWindow) && ratePerWindow > 0) declared.ratePerWindow = ratePerWindow
  if (Number.isFinite(windowMs) && windowMs > 0) declared.windowMs = windowMs

  const key = `${source ?? '*'}@${hostOf(target) ?? target}`
  let limiter = limitersByKey.get(key)
  if (!limiter) {
    limiter = createRateLimiter({
      ratePerWindow: declared.ratePerWindow,
      windowMs: declared.windowMs,
      // An explicit cap wins, then the declared policy's, then one. `coerceLimit`
      // reads the rate and drops the rest, so the concurrency has to be picked
      // back off the original object rather than off its normal output.
      concurrency: concurrency ?? rateLimit?.concurrency ?? RATE_LIMIT_POLICIES[source]?.concurrency ?? 1,
      jitterMs,
      name: key,
      ...(now ? { now } : {}),
      ...(sleep ? { sleep } : {}),
    })
    limitersByKey.set(key, limiter)
  }
  return limiter
}

function policyFor(source) {
  if (!source) return null
  const policy = RATE_LIMIT_POLICIES[source]
  return policy ? coerceLimit(policy) : null
}

/** A non-2xx as an error that still knows what the server said. */
function httpError(response) {
  const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after') ?? null)
  const error = new Error(`HTTP ${response.status}`)
  error.name = 'HttpError'
  error.status = response.status
  error.retryAfterMs = retryAfterMs
  error.headers = response.headers
  return error
}

/**
 * Backoff, the provider's own `Retry-After`, or the limiter's own clock —
 * whichever is longest.
 *
 * Three answers to "how long before trying again", taken with `max` because
 * they are answers to the same question and the honest one is the longest
 * delay. They were two before this, and the two were not the same question:
 *
 *   - `150 * 2 ** attempt` is our own guess at a retry schedule. It knows
 *     nothing about the provider and nothing about the bucket.
 *   - `Retry-After` is the provider telling us its budget is spent. Absent on
 *     most 429s, because most providers assume their clients read the rate
 *     limit they published rather than the one they sent.
 *   - the limiter's `nextTokenMs()` is this bucket's own state: how long until
 *     the next request would be permitted locally. This is the one that was
 *     missing, and it is the one that matters for a *sustained* 429 — a source
 *     answering 429 three times in a row is not having a bad 150ms, it is
 *     being run above its declared budget, and a backoff that grows 150 → 300
 *     → 600ms while the bucket sits empty keeps hammering a source the
 *     limiter had already decided to slow down.
 *
 * A 429 is the only status that consults the bucket. A 500 or a timeout says
 * nothing about anyone's rate budget, and widening those delays to the refill
 * interval would make an outage slower to clear for no reason: a provider that
 * is failing is usually not also rate-limiting, and the bucket is already
 * pacing us correctly for whatever does come back.
 *
 * With no limiter the third term is absent and the result is exactly what it
 * always was — `max(150 * 2 ** attempt, Retry-After)`. All sixteen existing
 * call sites declare nothing, so none of their behaviour changes.
 */
function retryDelayMs(error, attempt, limiter) {
  const backoff = 150 * (2 ** attempt)
  const retryAfter = typeof error?.retryAfterMs === 'number' ? error.retryAfterMs : 0
  // `parseRetryAfter` returns null for a header that says nothing, which keeps
  // a malformed `Retry-After: 0` from becoming a hot loop.
  const limiterWait = error?.status === 429 && limiter?.nextTokenMs ? limiter.nextTokenMs() : 0
  return Math.max(backoff, retryAfter, limiterWait)
}

async function performFetch(target, { timeoutMs, headers }) {
  const init = { signal: AbortSignal.timeout(timeoutMs), headers }
  if (activeCapture?.replayFetch) return activeCapture.replayFetch(target, init)
  return fetch(target, init)
}

/**
 * Read the body as bytes for the capture store, or null when capture is off.
 *
 * Called before the `!response.ok` check on purpose — an error body is the
 * evidence. A failure here must not fail the request, so a body that cannot be
 * read returns null and the caller's own parse path is used, which is the
 * behaviour every connector has today.
 */
async function captureBody(response, url, source) {
  // Attributed before the capture check below. Recording the URL a run pulled
  // through has nothing to do with keeping the body: it is what lets a lineage
  // row name where the data came from, and it is needed on every ordinary run.
  // Putting it inside the fixture path meant the list was always empty outside a
  // capture, and every lineage row came back `upstream_url_or_endpoint: null` —
  // the exact constant this was meant to replace.
  for (const list of recordingsByKey.values()) {
    list.push({ url, status: response.status, recorded_at: new Date().toISOString() })
  }

  const capture = activeCapture
  if (!capture || capture.replay) return null
  try {
    const bytes = Buffer.from(await response.arrayBuffer())
    capture.store.add({
      url,
      // The hostname is a worse fixture name than a connector's id and an
      // honest one; nothing today passes `source` and nothing is lost.
      source: capture.source ?? source ?? hostOf(url) ?? 'unknown',
      status: response.status,
      contentType: response.headers?.get?.('content-type') ?? null,
      headers: response.headers,
      body: bytes,
    })
    return bytes
  } catch {
    return null
  }
}

/**
 * Parse from the captured bytes, or from the response as before.
 *
 * The two paths must agree. `Buffer.from(bytes).toString('utf8')` is what
 * `response.text()` produces for the utf-8 every connector here is served;
 * `JSON.parse` of it is what `response.json()` parses. Capture on, capture off,
 * the connector sees the same value — that is the property that lets capture
 * be switched on in production without a behavioural change.
 */
async function decode(bytes, response, parse) {
  // `bytes !== null`, not `bytes`: an empty body is a real capture — a 204, or
  // the WHO endpoint emptying on `$top` — and must not fall back to reading a
  // response whose body is already spent.
  if (parse === 'json') return bytes !== null ? JSON.parse(bytes.toString('utf8')) : response.json()
  if (parse === 'buffer') {
    // Consume the body as bytes so binary payloads (tiles, archives) are
    // not corrupted by a utf-8 decode.
    return bytes !== null ? bytes : Buffer.from(await response.arrayBuffer())
  }
  return bytes !== null ? bytes.toString('utf8') : response.text()
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function delay(ms, sleep) {
  if (sleep) return sleep(ms)
  return new Promise((resolve) => setTimeout(resolve, ms))
}
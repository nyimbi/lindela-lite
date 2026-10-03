/**
 * ENH-12: raw payload retention, replay, and fixture seeding.
 *
 * Every parsing defect in this history was diagnosed by hand against a live
 * response, and then encoded as a fixture written by the same person, holding
 * the same assumptions, in the same sitting as the parser that was wrong:
 *
 * - GloFAS served the EFAS single-page app at its rss.xml URL. HTTP 200, so the
 *   connector parsed zero items and reported success. The fixture encoded RSS.
 * - CHIRPS moved its daily rasters into year subdirectories, so the connector
 *   matched filenames against the product root and ingested nothing while
 *   reporting no error. The fixture encoded the old flat listing.
 * - WHO's endpoint silently emptied on `$top`.
 *
 * A fixture hand-built after the diagnosis is a description of the fix, not
 * evidence about the provider. It can only ever confirm what the author already
 * believed. What cannot be hand-built is the response that actually broke, so
 * that is what this module keeps: every fetch body, verbatim, under a content
 * hash, with the metadata needed to know where it came from and when.
 *
 * ## What the wiring layer needs
 *
 * `src/connectors/http.js` is the only fetch site in the codebase. To capture
 * without editing anything else, assign the wrapper as the global:
 *
 *   globalThis.fetch = withCapture(globalThis.fetch, store)
 *
 * `withCapture(fetchImpl, store, { enabled, captureNonOk })` delegates to the
 * real fetch and records the body on the way past. Nothing else changes; every
 * connector keeps working because a wrapper that returns the original Response
 * is indistinguishable from the fetch it replaced.
 *
 * For storage, `CAPTURE_COLLECTION` names the collection to use if captures go
 * through the JSON store, and `CaptureStore` is the in-memory form with the
 * content-addressed dedupe the JSON store cannot give. `pruneCaptures` is the
 * retention boundary. `createReplayStore(captures)` is the `fetch`-shaped
 * object to assign in a test: it replays captured bytes and refuses, loudly,
 * anything it does not hold. `seedFixturesFromCaptures(captures, { targetDir })`
 * writes the suite's on-disk fixture shape; `scripts/capture-fixtures.mjs` is a
 * thin CLI over it.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Collection name, if captures are persisted through the JSON store. */
export const CAPTURE_COLLECTION = 'payload_captures'

/**
 * The kinds a capture can be. Frozen and exhaustive on purpose: `captureKind`
 * can only return a member, and the test suite asserts both that every member
 * is reachable from some content type and that nothing outside the list is
 * reachable. A kind list that drifts from the classifier is the silent-drop bug
 * this repository has already paid for twice — once in the store's COLLECTIONS
 * loop and once in the ingestion merged map.
 */
export const CAPTURE_KINDS = Object.freeze(['json', 'xml', 'html', 'csv', 'text', 'binary'])

/**
 * How long a capture is kept.
 *
 * Thirty days, because the failure this defends against is a provider changing
 * format *after* the deploy that broke on it. In a district deployment with
 * intermittent connectivity a regression can sit unreported for weeks, and the
 * only way to reproduce it is the exact bytes that failed. Thirty days is also
 * the point where content addressing has done its job: a GDACS response
 * re-fetched daily for a month is one stored body, not thirty, so the window
 * costs a row rather than a repository.
 */
export const DEFAULT_RETENTION_DAYS = 30

export const HASH_ALGORITHM = 'sha256'

/** File extension per kind — the half of the fixture naming that *is* derivable. */
const KIND_EXTENSIONS = Object.freeze({
  json: 'json',
  xml: 'xml',
  html: 'html',
  csv: 'csv',
  text: 'txt',
  binary: 'bin',
})

const BINARY_CONTENT_TYPES = Object.freeze([
  'application/octet-stream',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/pdf',
  'application/wasm',
])

const BINARY_PREFIXES = Object.freeze(['image/', 'video/', 'audio/', 'font/'])

/**
 * Fixture names, keyed by source.
 *
 * Three of the seven existing fixtures cannot be derived from their source id —
 * `firms.csv`, `nino34.txt` and `chirps-index.html` — so a rule of "slug of the
 * source" would emit a shape nothing reads, which is worse than emitting
 * nothing. These are the names `test/fixtures.test.js` actually opens, and the
 * CHIRPS entry is a function because that source has three fixtures from three
 * different URLs (the product root and one page per year directory).
 *
 * `ipc_hdx` is deliberately absent: its fixture is a hand-picked district
 * sample, and a sample cannot be derived from a capture. Capture it and pass a
 * `nameFor` to the seeder.
 */
const FIXTURE_NAMES = Object.freeze({
  chirps: (capture) => {
    const year = /(20\d{2})/.exec(pathOf(capture.url))
    return year ? `chirps-${year[1]}` : 'chirps-index'
  },
  gdacs: 'gdacs',
  glofas: 'glofas',
  nasa_firms: 'firms',
  noaa_enso: 'nino34',
  open_meteo: 'open-meteo',
  usgs_earthquake: 'usgs-earthquake',
})

const DAY_MS = 24 * 60 * 60 * 1000

/** Thrown when a replay is asked for a URL no capture holds. */
export class ReplayMissError extends Error {
  constructor(url, captured) {
    super(
      `replay store has no capture for ${url} (${captured} URL${captured === 1 ? '' : 's'} captured)`
      + ' — a replay that returned an empty body instead would pass a connector '
      + 'and prove nothing, which is how the empty-result bugs got in',
    )
    this.name = 'ReplayMissError'
    this.url = url
  }
}

/** Thrown when a response capability the store does not implement is called. */
export class ReplayCapabilityError extends Error {
  constructor(capability) {
    super(
      `replay response does not implement ${capability}()`
      + ' — it materialises the body in memory and offers text(), json(), '
      + 'arrayBuffer(), bytes(), blob() and clone(). Returning undefined here '
      + 'would surface downstream as a parser bug against a response that was '
      + 'never read.',
    )
    this.name = 'ReplayCapabilityError'
    this.capability = capability
  }
}

/**
 * Normalise a body to bytes.
 *
 * The same payload arrives as text from `response.text()`, as an ArrayBuffer
 * from a binary fetch, and as an already-parsed object from a connector that
 * called `json()` before anyone thought to capture it. A hash taken over the
 * transport-specific value is not a content hash: the same GDACS feed would
 * land under three keys depending on which layer captured it, and the dedupe
 * that stops 4,000 records becoming 4,000 stored copies would silently do
 * nothing. Everything is normalised to the bytes the wire carried.
 */
export function toBodyBytes(body) {
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (Buffer.isBuffer(body)) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) return Buffer.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  if (body === null || body === undefined) {
    throw new TypeError('capture body must be text, bytes or parsed JSON, not ' + String(body))
  }
  if (typeof body === 'object') {
    const serialised = JSON.stringify(body)
    if (serialised === undefined) {
      throw new TypeError(`capture body of type ${body.constructor?.name ?? 'unknown'} has no JSON form`)
    }
    return Buffer.from(serialised, 'utf8')
  }
  throw new TypeError(`capture body must be text, bytes or parsed JSON, not ${typeof body}`)
}

/** sha256 over bytes, hex. The address is the content and nothing else. */
export function contentHash(bytes) {
  return createHash(HASH_ALGORITHM).update(bytes).digest('hex')
}

/**
 * Classify a content type into one of {@link CAPTURE_KINDS}.
 *
 * `charset=utf-8` and other parameters are stripped before matching, and a type
 * nobody recognises is `binary` rather than `text`. Unknown bytes written as
 * utf-8 are not a readable fixture, they are a corrupt one that still parses
 * far enough to fail somewhere else.
 */
export function captureKind(contentType) {
  if (contentType === null || contentType === undefined || contentType === '') return 'binary'
  const type = String(contentType).split(';')[0].trim().toLowerCase()
  if (!type) return 'binary'
  if (type === 'application/json' || type === 'text/json' || type.endsWith('+json')) return 'json'
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === 'text/csv') return 'csv'
  if (type === 'text/plain') return 'text'
  if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml')) return 'xml'
  if (BINARY_CONTENT_TYPES.includes(type)) return 'binary'
  if (BINARY_PREFIXES.some((prefix) => type.startsWith(prefix))) return 'binary'
  if (type.startsWith('text/')) return 'text'
  return 'binary'
}

/**
 * Record one fetch body, content-addressed by its bytes.
 *
 * The metadata is what turns a blob of bytes into evidence: the URL says which
 * request produced it, `status` and `content_type` say how the server chose to
 * present it (the GloFAS defect is entirely a content-type fact), and
 * `retrieved_at` is what retention prunes on.
 *
 * `retrievedAt` defaults to now. An empty body is a legitimate capture — a 204,
 * or the WHO endpoint emptying on `$top` — so only `null`/`undefined` is
 * refused, not the empty string.
 */
export function capturePayload({ url, source, status, contentType, body, retrievedAt, headers } = {}) {
  requireText(url, 'url')
  requireText(source, 'source')
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError(`capture status must be an HTTP status code, got ${String(status)}`)
  }
  const bytes = toBodyBytes(body)
  const retrieved = requireTimestamp(retrievedAt ?? new Date(), 'retrievedAt')
  const contentTypeValue = contentType === null || contentType === undefined
    ? null
    : requireText(contentType, 'contentType')
  const kind = captureKind(contentTypeValue)
  if (!CAPTURE_KINDS.includes(kind)) {
    throw new TypeError(`classified kind ${kind} is not one of CAPTURE_KINDS`)
  }

  return Object.freeze({
    content_hash: contentHash(bytes),
    byte_length: bytes.length,
    kind,
    url,
    source,
    status,
    content_type: contentTypeValue,
    retrieved_at: retrieved,
    // A repeat capture updates these rather than storing a second body; see
    // CaptureStore.add. Both exist from the first capture so an entry's shape
    // does not depend on how many times the payload happened to be fetched.
    last_seen_at: retrieved,
    seen_count: 1,
    headers: Object.freeze(normaliseHeaders(headers)),
    body: bytes,
  })
}

/**
 * Content-addressed capture store.
 *
 * Dedupe is the whole reason bodies are stored by hash. GDACS returns thousands
 * of records in one response and the response is refetched on every run; a
 * store keyed by URL or timestamp accumulates a full copy per run and then
 * needs a retention window to hide the fact. Keyed by content, a week of
 * identical responses is one entry with `seen_count: 7`.
 */
export class CaptureStore {
  #byHash = new Map()

  constructor(entries = []) {
    for (const entry of entries) this.#insert(entry)
  }

  get size() {
    return this.#byHash.size
  }

  get(hash) {
    return this.#byHash.get(hash) ?? null
  }

  has(hash) {
    return this.#byHash.has(hash)
  }

  /** Insertions in capture order. The array is a copy; the entries are frozen. */
  list() {
    return [...this.#byHash.values()]
  }

  urls() {
    return [...new Set(this.list().map((entry) => entry.url))]
  }

  /**
   * Capture a body, or record a repeat sighting of one already held.
   *
   * Returns `{ entry, duplicate }` rather than the entry alone, because "did
   * this store a new body or recognise an old one" is the only question a
   * caller has, and a bare entry cannot answer it.
   */
  add(params) {
    const capture = capturePayload(params)
    return this.#insert(capture)
  }

  /**
   * Drop captures older than the retention window, in place.
   *
   * Pruning keys on `retrieved_at` — first sighting — not `last_seen_at`. A
   * body still being refetched daily is in active use and must survive; a body
   * last seen in March is the one a March regression needs.
   */
  prune(options = {}) {
    const now = options.now ?? new Date()
    const before = this.#byHash.size
    const kept = pruneCaptures(this.list(), { ...options, now })
    const keptHashes = new Set(kept.map((entry) => entry.content_hash))
    for (const hash of [...this.#byHash.keys()]) {
      if (!keptHashes.has(hash)) this.#byHash.delete(hash)
    }
    return { pruned: before - this.#byHash.size, kept: this.#byHash.size }
  }

  toJSON() {
    return serialiseCaptures(this.list())
  }

  #insert(capture) {
    const bytes = Buffer.from(capture.body)
    const entry = Object.freeze({ ...capture, body: bytes })
    const existing = this.#byHash.get(entry.content_hash)
    if (!existing) {
      this.#byHash.set(entry.content_hash, entry)
      return { entry, duplicate: false }
    }
    const merged = Object.freeze({
      ...existing,
      // First retrieval wins the identity fields: the entry records when this
      // body first appeared, and the later sighting is a sighting.
      seen_count: existing.seen_count + 1,
      last_seen_at: epochOf(existing.last_seen_at) >= epochOf(entry.last_seen_at)
        ? existing.last_seen_at
        : entry.last_seen_at,
    })
    this.#byHash.set(entry.content_hash, merged)
    return { entry: merged, duplicate: true }
  }
}

/**
 * Keep captures inside the retention window.
 *
 * The boundary is inclusive: an entry retrieved exactly `retentionDays` before
 * `now` is kept, and one millisecond earlier is not. A window that pruned the
 * boundary would make "exactly at the edge" untestable, because the answer would
 * depend on clock skew between the capture host and the pruning host — and a
 * retention rule whose result moves with a millisecond of skew is not a rule.
 *
 * Pure: returns a new array, leaves the input alone.
 */
export function pruneCaptures(entries, { now = new Date(), retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('pruneCaptures expects an array of captures')
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new TypeError(`retentionDays must be a positive number of days, got ${String(retentionDays)}`)
  }
  const cutoff = epochOf(now) - retentionDays * DAY_MS
  return entries.filter((entry) => epochOf(requireTimestamp(entry.retrieved_at, 'retrieved_at')) >= cutoff)
}

/** The most recent capture for a URL, or null. */
export function latestCaptureFor(captures, url) {
  let best = null
  for (const entry of captures) {
    if (entry.url !== url) continue
    if (!best || epochOf(entry.retrieved_at) >= epochOf(best.retrieved_at)) best = entry
  }
  return best
}

/**
 * A `fetch`-shaped object that replays captured payloads with no network.
 *
 * A connector's `fetchWithRetry` works against it unchanged: it checks `ok`,
 * branches on `status`, and reads `text()`, `json()` or `arrayBuffer()`. Where
 * a URL was never captured it throws {@link ReplayMissError} rather than
 * answering 404-with-an-empty-body — a synthetic empty response is
 * indistinguishable from a provider that returned nothing, which is precisely
 * the bug this module exists to keep testable.
 *
 * `asOf` replays the body as it stood at a moment, which is how a
 * "what did the feed say on 14 March" question gets answered.
 */
export function createReplayStore(captures, { asOf = null } = {}) {
  const list = [...captures]
  const index = new Map()
  for (const entry of list) {
    if (asOf && epochOf(entry.retrieved_at) > epochOf(asOf)) continue
    const current = index.get(entry.url)
    if (!current || epochOf(entry.retrieved_at) >= epochOf(current.retrieved_at)) index.set(entry.url, entry)
  }

  const requested = []
  const misses = []

  const store = async (url, init = {}) => {
    const target = String(url instanceof URL ? url.href : url)
    requested.push(target)
    if (init?.signal?.aborted) {
      throw new Error(`replay of ${target} aborted before it started`)
    }
    const entry = index.get(target)
    if (!entry) {
      misses.push(target)
      throw new ReplayMissError(target, index.size)
    }
    return replayResponse(entry)
  }

  store.captures = list
  store.urls = () => [...index.keys()]
  store.requested = requested
  store.misses = misses
  return store
}

/**
 * Build one replay response. Each body method hands back a *copy*: a caller
 * that mutates what it received would otherwise poison the store for every
 * later replay, and the resulting failure would look like a parser bug.
 */
function replayResponse(entry) {
  const responseHeaders = new ReplayHeaders({ 'content-type': entry.content_type, ...entry.headers })
  const copy = () => Buffer.from(entry.body)
  return Object.freeze({
    ok: entry.status >= 200 && entry.status < 300,
    status: entry.status,
    statusText: String(entry.status),
    url: entry.url,
    redirected: false,
    type: 'replay',
    headers: responseHeaders,
    content_hash: entry.content_hash,
    async text() {
      return copy().toString('utf8')
    },
    async json() {
      return JSON.parse(copy().toString('utf8'))
    },
    async arrayBuffer() {
      // Slice to the exact bytes. A Buffer may be a view into a shared pool,
      // and handing back `buffer.buffer` would return the pool — unrelated
      // bytes, in a different order, as a binary connector's terrain tile.
      const bytes = copy()
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
    async bytes() {
      return new Uint8Array(copy())
    },
    async blob() {
      return new Blob([copy()], { type: entry.content_type ?? '' })
    },
    clone() {
      return replayResponse(entry)
    },
    get body() {
      throw new ReplayCapabilityError('body')
    },
    async formData() {
      throw new ReplayCapabilityError('formData')
    },
    stream() {
      throw new ReplayCapabilityError('stream')
    },
  })
}

/**
 * Case-insensitive header access, matching the `Headers` contract: `get`
 * answers `null` for an absent header, never `undefined`.
 */
class ReplayHeaders {
  #map = new Map()

  constructor(init = {}) {
    for (const [key, value] of Object.entries(init)) {
      if (value === null || value === undefined) continue
      this.#map.set(String(key).toLowerCase(), String(value))
    }
  }

  get(name) {
    return this.#map.get(String(name).toLowerCase()) ?? null
  }

  has(name) {
    return this.#map.has(String(name).toLowerCase())
  }

  keys() {
    return this.#map.keys()
  }

  *entries() {
    yield* this.#map.entries()
  }

  *values() {
    yield* this.#map.values()
  }

  forEach(fn, thisArg) {
    for (const [key, value] of this.#map) fn.call(thisArg, value, key, this)
  }

  [Symbol.iterator]() {
    return this.entries()
  }
}

/**
 * Wrap a fetch so every response body is captured on the way past.
 *
 * This is the seam for `src/connectors/http.js` and nothing else in the codebase
 * needs to change: the wrapper returns the original Response object, so a
 * connector cannot tell it apart from the fetch it replaced.
 *
 * `captureNonOk` defaults to true because a 429 or a 503 body is exactly the
 * evidence for "the source failed at 03:00", and content addressing means the
 * repeats cost a row.
 */
export function withCapture(fetchImpl, store, { enabled = true, captureNonOk = true, source = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('withCapture requires a fetch implementation')
  if (!(store instanceof CaptureStore)) throw new TypeError('withCapture requires a CaptureStore')

  return async function capturingFetch(url, init = {}) {
    const response = await fetchImpl(url, init)
    if (!enabled) return response
    if (!captureNonOk && !response.ok) return response
    // clone() is the only way to read a body without consuming it. A fetch
    // implementation without it cannot be captured without stealing the body
    // from the caller, so the capture is skipped rather than silently breaking
    // the request it was meant to observe.
    if (typeof response.clone !== 'function') return response
    try {
      const mirror = response.clone()
      const bytes = Buffer.from(await mirror.arrayBuffer())
      store.add({
        url: String(url instanceof URL ? url.href : url),
        source: source ?? new URL(String(url)).hostname,
        status: response.status,
        contentType: response.headers?.get?.('content-type') ?? null,
        headers: headerEntries(response.headers),
        body: bytes,
      })
    } catch {
      // Capture must never be the reason a request fails. A storage error here
      // is an observability loss, not an ingestion loss.
    }
    return response
  }
}

/**
 * Write captures into the fixture shape `test/fixtures.test.js` reads.
 *
 * The reader there opens a flat file by name, hands the bytes to a connector,
 * and passes the content type in by hand. So the seeder emits exactly that: one
 * file per fixture name, the captured bytes verbatim, and a manifest carrying
 * the content type and provenance so the reader no longer has to be told what
 * the provider said it was serving.
 *
 * `targetDir` is required. A seeder with a default write path is one stray call
 * away from overwriting hand-built fixtures that cannot be regenerated.
 *
 * Returns `{ fixtures, superseded, manifest_path }`.
 */
export async function seedFixturesFromCaptures(captures, { targetDir, nameFor = null } = {}) {
  requireText(targetDir, 'targetDir')
  if (!Array.isArray(captures)) throw new TypeError('seedFixturesFromCaptures expects an array of captures')
  await fs.mkdir(targetDir, { recursive: true })

  const named = new Map()
  const superseded = []
  for (const capture of captures) {
    const name = fixtureNameFor(capture, nameFor)
    const current = named.get(name)
    if (!current) {
      named.set(name, capture)
      continue
    }
    // One file, one name: the reader can only open one. The most recent
    // capture wins and the loser is recorded rather than dropped, because
    // silently overwriting a good fixture with a worse capture of the same
    // source is how a suite starts confirming the wrong thing again.
    superseded.push({ ...manifestRecord(name, current), superseded_by: capture.content_hash })
    if (epochOf(capture.retrieved_at) >= epochOf(current.retrieved_at)) named.set(name, capture)
  }

  const fixtures = []
  for (const [name, capture] of named) {
    const extension = KIND_EXTENSIONS[capture.kind]
    if (!extension) throw new TypeError(`capture kind ${capture.kind} has no fixture extension`)
    const file = `${name}.${extension}`
    await fs.writeFile(path.join(targetDir, file), Buffer.isBuffer(capture.body) ? capture.body : toBodyBytes(capture.body))
    fixtures.push(manifestRecord(name, capture))
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    note: 'Provenance for the fixtures beside this file. The bodies are verbatim captures.',
    fixtures: fixtures.sort((a, b) => a.file.localeCompare(b.file)),
    superseded,
  }
  const manifestPath = path.join(targetDir, 'captures.manifest.json')
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return { fixtures: manifest.fixtures, superseded, manifest_path: manifestPath }
}

/** One manifest line: what the file is, and which response it was cut from. */
function manifestRecord(name, capture) {
  const extension = KIND_EXTENSIONS[capture.kind]
  return {
    file: `${name}.${extension ?? 'bin'}`,
    url: capture.url,
    source: capture.source,
    status: capture.status,
    content_type: capture.content_type,
    kind: capture.kind,
    byte_length: capture.byte_length,
    content_hash: capture.content_hash,
    retrieved_at: capture.retrieved_at,
  }
}

/** Resolve a capture's fixture name: explicit callback, then the source table. */
function fixtureNameFor(capture, nameFor) {
  const explicit = nameFor ? nameFor(capture) : null
  const table = FIXTURE_NAMES[capture.source]
  const name = explicit
    ?? (typeof table === 'function' ? table(capture) : table)
    ?? String(capture.source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  requireText(name, 'fixture name')
  // A name built from a URL is a name that can carry a path separator, and this
  // writes to disk. Anything but a bare filename is refused, not sanitised:
  // silently rewriting it would write a file the caller did not ask for.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new TypeError(`fixture name ${JSON.stringify(name)} is not a bare filename`)
  }
  return name
}

/**
 * Serialise captures for storage: body as base64, because JSON has no bytes and
 * a utf-8 round trip corrupts a binary capture into plausible-looking text.
 */
export function serialiseCaptures(entries) {
  return JSON.stringify({
    format: 'lindela-capture-store',
    version: 1,
    hash_algorithm: HASH_ALGORITHM,
    entries: entries.map((entry) => ({ ...entry, body: entry.body.toString('base64') })),
  })
}

/**
 * Read captures back, verifying each body against its recorded hash.
 *
 * A truncated or edited capture file would otherwise replay confident wrong
 * bytes, and the resulting test failure would be blamed on the connector. The
 * store is evidence; evidence that has been corrupted has to say so.
 */
export function parseCaptures(serialised) {
  const parsed = JSON.parse(typeof serialised === 'string' ? serialised : String(serialised))
  if (parsed?.format !== 'lindela-capture-store') {
    throw new TypeError('not a capture store document')
  }
  return parsed.entries.map((entry) => {
    const body = Buffer.from(entry.body, 'base64')
    const hash = contentHash(body)
    if (hash !== entry.content_hash) {
      throw new Error(`capture ${entry.content_hash} does not match its body (${hash})`)
    }
    return Object.freeze({ ...entry, body })
  })
}

/** Header entries from a Map, Headers instance or plain object. */
function headerEntries(headers) {
  if (!headers) return undefined
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries())
  return normaliseHeaders(headers)
}

function normaliseHeaders(input) {
  if (input === null || input === undefined) return {}
  if (typeof input.entries === 'function') {
    return Object.fromEntries([...input.entries()].map(([key, value]) => [String(key).toLowerCase(), String(value)]))
  }
  if (typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [String(key).toLowerCase(), String(value)]))
  }
  throw new TypeError('headers must be a Headers, Map, or plain object')
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

function requireTimestamp(value, name) {
  const epoch = epochOf(value)
  if (epoch === null || Number.isNaN(epoch)) {
    throw new TypeError(`${name} must be a Date, epoch ms, or ISO-8601 string, got ${JSON.stringify(value)}`)
  }
  return typeof value === 'string' ? value : new Date(epoch).toISOString()
}

/** Epoch ms for Date | number | ISO string, or null when unusable. */
function epochOf(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** URL pathname, or '' when the capture's URL is not parseable. */
function pathOf(url) {
  try {
    return new URL(String(url)).pathname
  } catch {
    return String(url)
  }
}
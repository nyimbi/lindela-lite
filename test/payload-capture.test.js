#!/usr/bin/env node
/**
 * ENH-12: the capture store, the replay store, and the seeder.
 *
 * Every fixture in `test/fixtures/` was written by hand, by the person who had
 * just diagnosed the upstream failure, holding the same assumptions as the
 * parser that was wrong. That is the defect this suite guards: a fixture
 * assembled after the fix can only confirm what the author already believed, so
 * it cannot catch the class of bug it was made for. The GloFAS feed served the
 * EFAS web app at its RSS URL and the RSS-shaped fixture hid it; CHIRPS moved
 * its rasters into year directories and the flat-listing fixture hid that too.
 *
 * So the guards here are about the *evidence*, not about the parsers:
 *
 * - A content hash must not depend on the transport. The same GDACS body
 *   arriving as text from `response.text()` and as an ArrayBuffer from a binary
 *   fetch is one body, and if it hashed to two keys the dedupe would do nothing
 *   while appearing to — 4,000 records re-fetched daily becomes 4,000 stored
 *   copies, and the store's cost hides in a retention window instead.
 * - A replay must throw on what it does not hold. A replay store that answers
 *   an uncaptured URL with an empty 200 makes "the provider returned nothing"
 *   indistinguishable from "the test knows nothing" — the exact shape of the
 *   three empty-result bugs above.
 * - A missing capability must throw rather than answer `undefined`. A binary
 *   connector handed `undefined` from `arrayBuffer()` fails deep inside a
 *   parser, and the resulting bug report points at the parser.
 * - Retention must be decidable at the boundary. A rule whose answer moves with
 *   a millisecond of clock skew between hosts is not a rule.
 * - `CAPTURE_KINDS` must be exactly the set the classifier can produce. Same
 *   silent-drop class as the store's `COLLECTIONS` loop.
 *
 * The seeder's output is checked through the reader that exists today —
 * `parseNino34` over the seeded file, exactly as `test/fixtures.test.js` reads
 * `nino34.txt`, and a real connector run against the seeded bytes through the
 * replay store. A seeder writing a shape nothing reads would pass a test that
 * only inspected the bytes it wrote.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CAPTURE_COLLECTION,
  CAPTURE_KINDS,
  CaptureStore,
  DEFAULT_RETENTION_DAYS,
  ReplayCapabilityError,
  ReplayMissError,
  captureKind,
  capturePayload,
  createReplayStore,
  parseCaptures,
  pruneCaptures,
  seedFixturesFromCaptures,
  serialiseCaptures,
  toBodyBytes,
  withCapture,
} from '../src/capture.js'
import { fetchWithRetry } from '../src/connectors/http.js'
import { parseNino34, noaaNinoConnector } from '../src/connectors/noaa-enso.js'
import { usgsEarthquakeConnector } from '../src/connectors/usgs-earthquake.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = path.join(ROOT, 'test', 'fixtures')
const DAY_MS = 24 * 60 * 60 * 1000
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const GDACS_XML = await fs.readFile(path.join(FIXTURES, 'gdacs.xml'), 'utf8')
const NINO34_TEXT = await fs.readFile(path.join(FIXTURES, 'nino34.txt'), 'utf8')
const USGS_JSON = JSON.parse(await fs.readFile(path.join(FIXTURES, 'usgs-earthquake.json'), 'utf8'))

describe('content-addressed capture', () => {
  it('hashes the same bytes identically however they arrived', () => {
    const asText = capturePayload({ url: 'https://x.test/a', source: 'gdacs', status: 200, contentType: 'application/xml', body: GDACS_XML })
    const asBuffer = capturePayload({ url: 'https://x.test/a', source: 'gdacs', status: 200, contentType: 'application/xml', body: Buffer.from(GDACS_XML, 'utf8') })
    const asUint8 = capturePayload({ url: 'https://x.test/a', source: 'gdacs', status: 200, contentType: 'application/xml', body: new Uint8Array(Buffer.from(GDACS_XML, 'utf8')) })
    const asArrayBuffer = capturePayload({
      url: 'https://x.test/a', source: 'gdacs', status: 200, contentType: 'application/xml',
      body: new TextEncoder().encode(GDACS_XML).buffer,
    })
    // A hash that depends on the transport is not a content hash. Three
    // captures of one feed body would be three rows, and the growth would be
    // blamed on the source rather than on the store's key.
    assert.equal(asBuffer.content_hash, asText.content_hash)
    assert.equal(asUint8.content_hash, asText.content_hash)
    assert.equal(asArrayBuffer.content_hash, asText.content_hash)

    const asObject = capturePayload({ url: 'https://x.test/a', source: 'usgs_earthquake', status: 200, contentType: 'application/json', body: USGS_JSON })
    const asJsonText = capturePayload({ url: 'https://x.test/a', source: 'usgs_earthquake', status: 200, contentType: 'application/json', body: JSON.stringify(USGS_JSON) })
    assert.equal(asObject.content_hash, asJsonText.content_hash, 'a parsed body hashes as the bytes the wire carried')
    assert.equal(asObject.byte_length, asJsonText.byte_length)
  })

  it('stores an identical body once and counts the sightings', () => {
    const store = new CaptureStore()
    const first = store.add({ url: 'https://www.gdacs.org/rss.xml', source: 'gdacs', status: 200, contentType: 'application/xml', body: GDACS_XML, retrievedAt: '2026-09-01T00:00:00.000Z' })
    assert.equal(first.duplicate, false)

    // Same bytes, different day, different URL query: the feed did not change.
    const again = store.add({ url: 'https://www.gdacs.org/rss.xml?v=2', source: 'gdacs', status: 200, contentType: 'application/xml', body: GDACS_XML, retrievedAt: '2026-10-01T00:00:00.000Z' })
    assert.equal(again.duplicate, true)
    assert.equal(store.size, 1, 'a refetched response must not become a second stored copy')
    assert.equal(store.list()[0].seen_count, 2)
    assert.equal(again.entry.retrieved_at, '2026-09-01T00:00:00.000Z', 'the first sighting is the entry identity')
    assert.equal(again.entry.last_seen_at, '2026-10-01T00:00:00.000Z')

    const changed = store.add({ url: 'https://www.gdacs.org/rss.xml', source: 'gdacs', status: 200, contentType: 'application/xml', body: `${GDACS_XML}<!--revised-->`, retrievedAt: '2026-10-02T00:00:00.000Z' })
    assert.equal(changed.duplicate, false)
    assert.equal(store.size, 2, 'a genuinely different body is a new entry')
  })

  it('keeps its own copy of the bytes', () => {
    const store = new CaptureStore()
    const mutable = Buffer.from(GDACS_XML, 'utf8')
    const { entry } = store.add({ url: 'https://x.test/a', source: 'gdacs', status: 200, contentType: 'application/xml', body: mutable })
    mutable.fill(0)
    assert.equal(store.get(entry.content_hash).byte_length, GDACS_XML.length)
    assert.equal(store.get(entry.content_hash).body.toString('utf8'), GDACS_XML)
  })

  it('records the metadata that turns bytes into evidence', () => {
    const entry = capturePayload({
      url: 'https://www.efas.europa.eu/glofas/rss.xml',
      source: 'glofas',
      // The GloFAS defect is entirely a content-type fact: HTTP 200 serving a
      // single-page app. Without the type on the capture, the capture is
      // evidence of nothing.
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>EFAS</title>',
      retrievedAt: '2026-10-01T09:00:00.000Z',
      headers: { 'Retry-After': '120' },
    })
    assert.equal(entry.kind, 'html')
    assert.equal(entry.status, 200)
    assert.equal(entry.content_type, 'text/html; charset=utf-8')
    assert.equal(entry.url, 'https://www.efas.europa.eu/glofas/rss.xml')
    assert.equal(entry.retrieved_at, '2026-10-01T09:00:00.000Z')
    assert.equal(entry.byte_length, Buffer.byteLength('<!doctype html><title>EFAS</title>'))
    assert.equal(entry.headers['retry-after'], '120')
    assert.equal(entry.content_hash.length, 64)
    assert.throws(() => { entry.byte_length = 0 }, TypeError, 'a stored entry must not be mutable')
  })

  it('captures an empty body rather than treating it as nothing', () => {
    // The WHO endpoint emptying on `$top` returned 200 and zero records. A store
    // that refused empty bodies would have no record of the exact failure.
    const entry = capturePayload({ url: 'https://x.test/w', source: 'who_gho', status: 200, contentType: 'application/json', body: '' })
    assert.equal(entry.byte_length, 0)
    assert.equal(entry.kind, 'json')
  })

  it('refuses a body it cannot hash', () => {
    assert.throws(() => toBodyBytes(undefined), TypeError)
    assert.throws(() => toBodyBytes(null), TypeError)
    assert.throws(() => toBodyBytes(42), TypeError)
    assert.throws(() => capturePayload({ url: 'https://x.test/a', source: 'gdacs', status: 99, body: 'x' }), TypeError)
    assert.throws(() => capturePayload({ url: '', source: 'gdacs', status: 200, body: 'x' }), TypeError)
    assert.throws(() => capturePayload({ url: 'https://x.test/a', source: 'gdacs', status: 200, body: 'x', retrievedAt: 'not a date' }), TypeError)
  })

  it('names its collection for the store to persist under', () => {
    assert.equal(CAPTURE_COLLECTION, 'payload_captures')
  })
})

describe('CAPTURE_KINDS is exactly what the classifier can produce', () => {
  const REACHABLE = new Map([
    ['application/json', 'json'],
    ['application/geo+json', 'json'],
    ['text/json', 'json'],
    ['application/xml', 'xml'],
    ['application/atom+xml', 'xml'],
    ['text/html', 'html'],
    ['text/csv', 'csv'],
    ['text/plain', 'text'],
    ['text/plain; charset=utf-8', 'text'],
    ['application/zip', 'binary'],
    ['image/tiff', 'binary'],
    ['application/octet-stream', 'binary'],
    ['application/vnd.nonsense', 'binary'],
    ['application/x-unknown-thing', 'binary'],
    [null, 'binary'],
    [undefined, 'binary'],
    ['', 'binary'],
  ])

  it('produces nothing outside the list', () => {
    for (const [contentType, kind] of REACHABLE) {
      assert.equal(captureKind(contentType), kind, `content type ${String(contentType)}`)
      assert.ok(CAPTURE_KINDS.includes(kind))
    }
  })

  it('lists nothing the classifier cannot produce', () => {
    // The unlisted-kind direction is the one that bites: an entry added for a
    // hypothetical format is unreachable, and the seeder would then have an
    // extension table with a hole in it.
    const produced = new Set([...REACHABLE.values()])
    assert.deepEqual([...CAPTURE_KINDS].sort(), [...produced].sort())
  })

  it('rejects a kind that is not in the list', () => {
    const entry = capturePayload({ url: 'https://x.test/a', source: 'gdacs', status: 200, contentType: 'text/html', body: '<p/>' })
    assert.equal(entry.kind, 'html')
    assert.throws(() => Object.defineProperty(entry, 'kind', { value: 'spreadsheet' }), TypeError)
  })
})

describe('replay', () => {
  const capture = (overrides = {}) => capturePayload({
    url: 'https://www.gdacs.org/rss.xml',
    source: 'gdacs',
    status: 200,
    contentType: 'application/xml',
    body: GDACS_XML,
    retrievedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  })

  it('serves text, json and arrayBuffer from one capture', async () => {
    const store = createReplayStore([capture()])
    const response = await store('https://www.gdacs.org/rss.xml')
    assert.equal(response.ok, true)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'application/xml')
    assert.equal(response.headers.get('content-type'), 'application/xml')
    assert.equal(await response.text(), GDACS_XML)

    const jsonCapture = capture({ url: 'https://x.test/u.json', contentType: 'application/geo+json', body: USGS_JSON })
    const jsonStore = createReplayStore([jsonCapture])
    const jsonResponse = await jsonStore('https://x.test/u.json')
    const parsed = await jsonResponse.json()
    assert.deepEqual(parsed, USGS_JSON, 'a replayed JSON body must be deep-equal to the original')
    assert.deepEqual(await jsonStore('https://x.test/u.json').then((r) => r.json()), USGS_JSON)

    const bytes = await jsonResponse.arrayBuffer()
    assert.equal(bytes.byteLength, JSON.stringify(USGS_JSON).length)
    assert.deepEqual(Buffer.from(bytes).toString('utf8'), JSON.stringify(USGS_JSON))
    assert.equal(Buffer.from(bytes).length, jsonCapture.byte_length)
  })

  it('hands out copies, not the store\'s own bytes', async () => {
    const store = createReplayStore([capture({ url: 'https://x.test/b', contentType: 'application/octet-stream', body: Buffer.from([1, 2, 3, 4]) })])
    const first = Buffer.from(await (await store('https://x.test/b')).arrayBuffer())
    first.fill(9)
    const second = Buffer.from(await (await store('https://x.test/b')).arrayBuffer())
    // A caller mutating what it read must not poison every later replay; the
    // resulting failure would arrive dressed as a parser bug.
    assert.deepEqual([...second], [1, 2, 3, 4])
  })

  it('throws for an uncaptured URL instead of inventing a response', async () => {
    const store = createReplayStore([capture()])
    await assert.rejects(
      () => store('https://www.efas.europa.eu/glofas/rss.xml'),
      (error) => {
        assert.ok(error instanceof ReplayMissError)
        assert.match(error.message, /no capture for https:\/\/www\.efas\.europa\.eu\/glofas\/rss\.xml/)
        return true
      },
    )
    assert.deepEqual(store.misses, ['https://www.efas.europa.eu/glofas/rss.xml'])
    assert.equal(store.requested.length, 1)
  })

  it('throws for a capability it does not implement', async () => {
    const store = createReplayStore([capture()])
    const response = await store('https://www.gdacs.org/rss.xml')
    // Returning undefined here is how a binary connector fails as a parser bug.
    await assert.rejects(() => response.formData(), ReplayCapabilityError)
    assert.throws(() => response.stream(), ReplayCapabilityError)
    assert.throws(() => response.body, ReplayCapabilityError)
    // A zero-length body must not be mistaken for a missing capability either.
    assert.equal((await response.text()).length, GDACS_XML.length)
  })

  it('replays the status the capture recorded', async () => {
    const store = createReplayStore([
      capture({ url: 'https://x.test/down', status: 503, body: 'upstream down' }),
      capture({ url: 'https://x.test/slow', status: 429, headers: { 'Retry-After': '30' } }),
    ])
    const down = await store('https://x.test/down')
    assert.equal(down.ok, false)
    assert.equal(down.status, 503)
    assert.equal(await down.text(), 'upstream down')

    const slow = await store('https://x.test/slow')
    assert.equal(slow.ok, false)
    assert.equal(slow.headers.get('retry-after'), '30')
    assert.equal(slow.headers.get('RETRY-AFTER'), '30')
    // Absent is null, per the Headers contract — not undefined.
    assert.equal(slow.headers.get('retry-after-absent'), null)
    assert.equal(slow.headers.has('content-type'), true)
  })

  it('works with fetchWithRetry unchanged', async () => {
    // The connectors' only fetch path. If this does not work, replay is a toy.
    const store = createReplayStore([
      capture({ url: 'https://x.test/feed.xml', contentType: 'application/xml' }),
      capture({ url: 'https://x.test/feed.json', source: 'usgs_earthquake', contentType: 'application/json', body: USGS_JSON }),
      capture({ url: 'https://x.test/tile.bin', source: 'chirps', contentType: 'application/octet-stream', body: Buffer.from([0, 1, 2, 250, 251, 255]) }),
    ])
    const previous = globalThis.fetch
    globalThis.fetch = store
    try {
      assert.equal(await fetchWithRetry('https://x.test/feed.xml', { retries: 0 }), GDACS_XML)
      assert.deepEqual(await fetchWithRetry('https://x.test/feed.json', { retries: 0, parse: 'json' }), USGS_JSON)
      const buffer = await fetchWithRetry('https://x.test/tile.bin', { retries: 0, parse: 'buffer' })
      assert.ok(Buffer.isBuffer(buffer))
      assert.deepEqual([...buffer], [0, 1, 2, 250, 251, 255], 'bytes must survive the buffer path intact')
      await assert.rejects(() => fetchWithRetry('https://x.test/never-captured', { retries: 0 }), ReplayMissError)
    } finally {
      globalThis.fetch = previous
    }
  })

  it('replays the body as it stood at a moment', async () => {
    const store = createReplayStore([
      capture({ url: 'https://x.test/n', body: 'first' }),
      capture({ url: 'https://x.test/n', body: 'second', retrievedAt: '2026-10-05T00:00:00.000Z' }),
    ])
    assert.equal(await (await store('https://x.test/n')).text(), 'second')
    const asOf = createReplayStore(store.captures, { asOf: '2026-10-02T00:00:00.000Z' })
    assert.equal(await (await asOf('https://x.test/n')).text(), 'first')
    assert.deepEqual(asOf.urls(), ['https://x.test/n'])
  })
})

describe('retention', () => {
  const NOW = new Date('2026-10-01T12:00:00.000Z')
  const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()
  const at = (msAgo, id) => ({ content_hash: id, retrieved_at: ago(msAgo) })

  it('prunes strictly older entries and keeps the boundary', () => {
    const window = 10 * DAY_MS
    const entries = [
      at(0, 'fresh'),
      at(window, 'edge'),
      at(window + 1, 'past-edge'),
      at(window + DAY_MS, 'old'),
    ]
    const kept = pruneCaptures(entries, { now: NOW, retentionDays: 10 })
    // The boundary is inclusive: the entry retrieved exactly 10 days ago is
    // inside the window, and one millisecond earlier is not. A rule that pruned
    // the boundary would be decided by clock skew between the capture host and
    // the pruning host, which is not a rule anyone can reason about.
    assert.deepEqual(kept.map((entry) => entry.content_hash), ['fresh', 'edge'])
  })

  it('defaults to the documented window', () => {
    assert.equal(DEFAULT_RETENTION_DAYS, 30)
    const kept = pruneCaptures([at(29 * DAY_MS, 'inside'), at(31 * DAY_MS, 'outside')], { now: NOW })
    assert.deepEqual(kept.map((entry) => entry.content_hash), ['inside'])
  })

  it('leaves the input untouched and rejects a useless window', () => {
    const entries = [at(90 * DAY_MS, 'old'), at(0, 'fresh')]
    const kept = pruneCaptures(entries, { now: NOW, retentionDays: 1 })
    assert.equal(entries.length, 2, 'pruning must not consume the input it was handed')
    assert.deepEqual(kept.map((entry) => entry.content_hash), ['fresh'])
    assert.throws(() => pruneCaptures(entries, { retentionDays: 0 }), TypeError)
    assert.throws(() => pruneCaptures(entries, { retentionDays: -3 }), TypeError)
    assert.throws(() => pruneCaptures('nope'), TypeError)
  })

  it('prunes a store in place by first retrieval, not last sighting', () => {
    const store = new CaptureStore()
    const stale = store.add({ url: 'https://x.test/a', source: 'gdacs', status: 200, body: 'a', retrievedAt: '2026-08-01T00:00:00.000Z' })
    // Still being refetched daily: seen again today, but first seen in August.
    store.add({ url: 'https://x.test/a', source: 'gdacs', status: 200, body: 'a', retrievedAt: '2026-10-01T00:00:00.000Z' })
    const fresh = store.add({ url: 'https://x.test/b', source: 'gdacs', status: 200, body: 'b', retrievedAt: '2026-09-28T00:00:00.000Z' })

    const result = store.prune({ now: new Date('2026-10-01T00:00:00.000Z'), retentionDays: 30 })
    assert.deepEqual(result, { pruned: 1, kept: 1 })
    // The entry that was refetched yesterday still went: retention keys on the
    // first retrieval, because a regression reproducing from August needs the
    // August bytes, and last_seen_at would have kept them for ever.
    assert.equal(store.has(stale.entry.content_hash), false)
    assert.equal(store.get(fresh.entry.content_hash).seen_count, 1)
  })
})

describe('fixture seeding', () => {
  it('writes a shape the existing fixture reader can open', async () => {
    const target = await tempDir()
    const captures = [
      capturePayload({ url: 'https://psl.noaa.gov/data/correlation/nina34.data.txt', source: 'noaa_enso', status: 200, contentType: 'text/plain', body: NINO34_TEXT, retrievedAt: '2026-10-01T00:00:00.000Z' }),
      capturePayload({ url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', source: 'usgs_earthquake', status: 200, contentType: 'application/geo+json', body: USGS_JSON, retrievedAt: '2026-10-01T00:00:00.000Z' }),
      capturePayload({ url: 'https://data.chc.ucsb.edu/products/chirps/global_daily/tifs/p05/', source: 'chirps', status: 200, contentType: 'text/html', body: '<html><a href="2026/">2026/</a></html>', retrievedAt: '2026-10-01T00:00:00.000Z' }),
      capturePayload({ url: 'https://data.chc.ucsb.edu/products/chirps/global_daily/tifs/p05/2026/', source: 'chirps', status: 200, contentType: 'text/html', body: '<html><a href="chirps-v2.0.2026.08.31.tif.gz">x</a></html>', retrievedAt: '2026-10-01T00:00:00.000Z' }),
    ]
    const { fixtures, manifest_path: manifestPath } = await seedFixturesFromCaptures(captures, { targetDir: target })

    assert.deepEqual(
      fixtures.map((fixture) => fixture.file),
      ['chirps-2026.html', 'chirps-index.html', 'nino34.txt', 'usgs-earthquake.json'],
      'the names must be the ones test/fixtures.test.js opens',
    )

    // The reader at fixtures.test.js:295, run against the seeded file.
    const rows = parseNino34(await fs.readFile(path.join(target, 'nino34.txt'), 'utf8'))
    assert.equal(rows.length, 10)
    assert.deepEqual(rows[0], { year: 1949, month: 12, anomaly_c: -1.15 })
    assert.deepEqual(rows, parseNino34(NINO34_TEXT), 'the seeded bytes must parse identically to the suite\'s own fixture')

    // The content type is the whole GloFAS defect, so it must survive on disk
    // rather than being passed in by hand as the current reader does.
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    assert.equal(manifest.fixtures.find((fixture) => fixture.file === 'nino34.txt').content_type, 'text/plain')
    assert.equal(manifest.fixtures.find((fixture) => fixture.file === 'usgs-earthquake.json').content_type, 'application/geo+json')
    assert.equal(manifest.fixtures.find((fixture) => fixture.file === 'usgs-earthquake.json').url, 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson')
  })

  it('runs a connector against seeded bytes with no network', async () => {
    const target = await tempDir()
    await seedFixturesFromCaptures([
      capturePayload({ url: 'https://psl.noaa.gov/data/correlation/nina34.data.txt', source: 'noaa_enso', status: 200, contentType: 'text/plain', body: NINO34_TEXT }),
      capturePayload({ url: 'https://earthquake.usgs.gov/feed.geojson', source: 'usgs_earthquake', status: 200, contentType: 'application/geo+json', body: USGS_JSON }),
    ], { targetDir: target })

    const nino = await fs.readFile(path.join(target, 'nino34.txt'))
    const usgs = await fs.readFile(path.join(target, 'usgs-earthquake.json'))
    globalThis.fetch = createReplayStore([
      capturePayload({ url: 'https://psl.noaa.gov/data/correlation/nina34.data.txt', source: 'noaa_enso', status: 200, contentType: 'text/plain', body: nino }),
      capturePayload({ url: 'https://earthquake.usgs.gov/feed.geojson', source: 'usgs_earthquake', status: 200, contentType: 'application/geo+json', body: usgs }),
    ])

    // Same counts `test/fixtures.test.js` asserts against its hand-built files,
    // now from captured bytes: the point of ENH-12 is that this works with the
    // response that really arrived, not with one shaped by the parser.
    const ninoResult = await noaaNinoConnector.ingest({ enso_feed: 'https://psl.noaa.gov/data/correlation/nina34.data.txt', enso_window_months: 4, retries: 0 })
    assert.deepEqual(ninoResult.errors, [])
    assert.equal(ninoResult.climate_observations.length, 4)
    assert.equal(ninoResult.climate_observations[0].value, 2.17)

    const usgsResult = await usgsEarthquakeConnector.ingest({ usgs_feed: 'https://earthquake.usgs.gov/feed.geojson', retries: 0 })
    assert.deepEqual(usgsResult.errors, [])
    assert.equal(usgsResult.hazard_events.length, 2)
    assert.equal(usgsResult.hazard_events[1].metadata.magnitude, 7.2)
  })

  it('keeps the newest capture for a name and records the one it dropped', async () => {
    const target = await tempDir()
    const { fixtures, superseded } = await seedFixturesFromCaptures([
      capturePayload({ url: 'https://x.test/gdacs', source: 'gdacs', status: 200, contentType: 'application/xml', body: '<rss><item>old</item></rss>', retrievedAt: '2026-09-01T00:00:00.000Z' }),
      capturePayload({ url: 'https://x.test/gdacs', source: 'gdacs', status: 200, contentType: 'application/xml', body: '<rss><item>new</item></rss>', retrievedAt: '2026-10-01T00:00:00.000Z' }),
    ], { targetDir: target })
    assert.equal(fixtures.length, 1)
    assert.equal(fixtures[0].file, 'gdacs.xml')
    assert.equal(superseded.length, 1)
    // Overwriting a good fixture with a worse capture of the same name is how a
    // suite starts confirming the wrong thing again, so the loser is recorded.
    assert.equal((await fs.readFile(path.join(target, 'gdacs.xml'), 'utf8')).includes('new'), true)
  })

  it('refuses to guess a write path or write outside the target', async () => {
    await assert.rejects(() => seedFixturesFromCaptures([], {}), TypeError)
    const target = await tempDir()
    await assert.rejects(
      () => seedFixturesFromCaptures(
        [capturePayload({ url: 'https://x.test/a', source: 'gdacs', status: 200, contentType: 'application/xml', body: '<rss/>' })],
        { targetDir: target, nameFor: () => '../escaped' },
      ),
      TypeError,
    )
  })
})

describe('capture through a wrapper, and through a store file', () => {
  it('passes the original response through untouched', async () => {
    const store = new CaptureStore()
    const upstream = async () => new Response(GDACS_XML, { status: 200, headers: { 'content-type': 'application/xml' } })
    const response = await withCapture(upstream, store, { source: 'gdacs' })('https://www.gdacs.org/rss.xml')
    // The connector downstream cannot tell the wrapper from the fetch it
    // replaced, which is what lets this ship without editing `http.js`.
    assert.equal(response.status, 200)
    assert.equal(await response.text(), GDACS_XML)
    assert.equal(store.size, 1)
    assert.equal(store.list()[0].content_type, 'application/xml')
    assert.equal(store.list()[0].source, 'gdacs')
  })

  it('round-trips a store through JSON and rejects a corrupted one', () => {
    const store = new CaptureStore()
    store.add({ url: 'https://x.test/b', source: 'chirps', status: 200, contentType: 'application/octet-stream', body: Buffer.from([0, 128, 255, 10, 13]) })
    const restored = parseCaptures(serialiseCaptures(store.list()))
    assert.equal(restored.length, 1)
    assert.deepEqual([...restored[0].body], [0, 128, 255, 10, 13], 'a base64 round trip must not corrupt bytes')

    const document = JSON.parse(serialiseCaptures(store.list()))
    document.entries[0].body = Buffer.from('tampered').toString('base64')
    assert.throws(() => parseCaptures(JSON.stringify(document)), /does not match its body/)
    assert.throws(() => parseCaptures('{"format":"something-else"}'), TypeError)
  })
})

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lindela-capture-'))
}
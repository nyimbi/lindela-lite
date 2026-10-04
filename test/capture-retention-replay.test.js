#!/usr/bin/env node
/**
 * ENH-12: retention stated, pruning honest, replay identifiable.
 *
 * `test/payload-capture.test.js` covers the mechanics — the hash, the kinds, the
 * seeder's output shape. This file covers the two properties that make those
 * mechanics honest rather than merely working, and both are properties of what
 * the system *says* when something is absent:
 *
 * - **A pruned capture says it was pruned.** Retention that drops bytes without
 *   recording the drop leaves a store that cannot distinguish "we never
 *   captured this" from "we captured it and threw it away last month". Both
 *   look identical to a replay, and both look like an empty provider response —
 *   the exact failure mode of the GloFAS, CHIRPS and WHO defects this whole
 *   subsystem exists to keep testable. So a prune leaves a tombstone, the
 *   tombstone names the dates, and a replay of an expired URL raises
 *   `ReplayPrunedError` rather than returning an empty body.
 * - **A replay is identifiable as a replay.** The stamp comes out of the store
 *   and onto the records built from it, and there is deliberately no way to
 *   take it off. A fixture that reads as a live observation is how a
 *   regression gets fixed in the test suite and ships anyway.
 *
 * The retention window itself is asserted against `RETENTION_POLICY` rather
 * than a literal, because a guard on a duplicated number guards nothing: change
 * the policy and every assertion here follows it, which is the point of stating
 * it in one place.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  CaptureStore,
  DEFAULT_RETENTION_DAYS,
  REPLAY_ORIGIN,
  RETENTION_POLICY,
  ReplayMissError,
  ReplayPrunedError,
  capturePayload,
  createReplayStore,
  isReplayDerived,
  parseCaptures,
  pruneCaptures,
  retentionWindow,
  seedFixturesFromCaptures,
  serialiseCaptures,
  stampReplayProvenance,
} from '../src/capture.js'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-01T12:00:00.000Z')

const GDACS_XML = '<?xml version="1.0"?><rss><item><title>Flood — Turkana</title></item></rss>'

/** A capture `days` before NOW, so retention arithmetic is checked against a clock. */
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY_MS).toISOString()

function capture(overrides = {}) {
  return capturePayload({
    url: 'https://www.gdacs.org/rss.xml',
    source: 'gdacs',
    status: 200,
    contentType: 'application/xml',
    body: GDACS_XML,
    retrievedAt: daysAgo(1),
    ...overrides,
  })
}

/**
 * A store holding exactly these captures.
 *
 * The constructor, not `add`: `add` takes `retrievedAt` while a capture object
 * carries `retrieved_at`, so round-tripping through `add` silently re-dates
 * every entry to now and a retention assertion passes for the wrong reason.
 */
function storeWith(entries) {
  return new CaptureStore(entries)
}

describe('the retention window is stated, not implied', () => {
  it('states one policy and renders it as one sentence', () => {
    assert.equal(RETENTION_POLICY.retention_days, DEFAULT_RETENTION_DAYS)
    const sentence = retentionWindow()
    assert.match(sentence, /30 days from first retrieval/)
    // The two facts a reader needs to predict a disappearance: what the clock
    // runs on, and what happens at the boundary. "30 days" alone does not say
    // whether the capture expires the moment it reaches 30 or survives it.
    assert.match(sentence, /retrieved_at/)
    assert.match(sentence, /inclusive/)
    assert.match(sentence, /tombstone/)
    // And why, because a window nobody can justify is one nobody will believe.
    assert.match(sentence, /provider changes format/)
  })

  it('keys the window on first retrieval and says so', () => {
    assert.equal(RETENTION_POLICY.keyed_on, 'retrieved_at')
    const store = storeWith([capture({ retrievedAt: daysAgo(45) })])
    store.add({
      url: 'https://www.gdacs.org/rss.xml',
      source: 'gdacs',
      status: 200,
      contentType: 'application/xml',
      body: GDACS_XML,
      retrievedAt: NOW.toISOString(),
    })
    assert.equal(store.size, 1, 'a re-fetch dedupes onto the existing entry')
    assert.equal(store.list()[0].seen_count, 2)
    store.prune({ now: NOW })
    assert.equal(store.size, 0, 'refetching yesterday does not keep August bytes alive forever')
  })

  it('records an overridden window on the tombstone it writes', () => {
    const store = storeWith([capture({ retrievedAt: daysAgo(5) })])
    store.prune({ now: NOW, retentionDays: 1 })
    const [stone] = store.tombstones()
    assert.equal(stone.retention_days, 1)
    // Someone reading a store file in six weeks needs to know which rule
    // applied, because the stated default and the applied window differ.
    assert.notEqual(stone.retention_days, RETENTION_POLICY.retention_days)
  })
})

describe('a pruned capture says so', () => {
  it('leaves a tombstone naming what went, when, and why', () => {
    const store = storeWith([
      capture({ url: 'https://x.test/old', retrievedAt: daysAgo(40), body: '<rss>old</rss>' }),
      capture({ url: 'https://x.test/new', retrievedAt: daysAgo(2), body: '<rss>new</rss>' }),
    ])
    const old = store.list().find((entry) => entry.url === 'https://x.test/old')

    assert.deepEqual(store.prune({ now: NOW }), { pruned: 1, kept: 1 })
    assert.equal(store.get(old.content_hash), null)

    const [stone] = store.tombstones()
    assert.equal(stone.content_hash, old.content_hash)
    assert.equal(stone.url, 'https://x.test/old')
    assert.equal(stone.source, 'gdacs')
    assert.equal(stone.reason, 'retention_window_expired')
    assert.equal(stone.retention_days, RETENTION_POLICY.retention_days)
    assert.equal(stone.pruned_at, NOW.toISOString())
    assert.equal(store.prunedFor('https://x.test/old').content_hash, old.content_hash)
    assert.equal(store.prunedFor('https://x.test/new'), null)
  })

  it('replays an expired URL as pruned, not as empty and not as a miss', async () => {
    const store = storeWith([capture({ retrievedAt: daysAgo(40) })])
    store.prune({ now: NOW })

    const replay = createReplayStore(store.list(), { tombstones: store.tombstones() })
    await assert.rejects(
      () => replay('https://www.gdacs.org/rss.xml'),
      (error) => {
        assert.ok(error instanceof ReplayPrunedError, 'must be distinguishable from a plain miss')
        // A miss says the store knows nothing; a prune says the store knew and
        // the policy took it. Collapsing the two sends the caller to the wrong
        // fix — recapture versus go looking for what closed the window.
        assert.match(error.message, /pruned/)
        assert.match(error.message, /retention window/)
        assert.match(error.message, /not an empty result and not a miss/)
        assert.equal(error.url, 'https://www.gdacs.org/rss.xml')
        return true
      },
    )
    assert.deepEqual(replay.prunedMisses, ['https://www.gdacs.org/rss.xml'])
  })

  it('still says "never captured" for a URL it never held', async () => {
    const store = storeWith([capture({ retrievedAt: daysAgo(40) })])
    store.prune({ now: NOW })
    const replay = createReplayStore(store.list(), { tombstones: store.tombstones() })

    await assert.rejects(() => replay('https://x.test/never-seen'), ReplayMissError)
    assert.deepEqual(replay.prunedMisses, [], 'a URL with no tombstone is a miss, not an expiry')
  })

  it('treats an as-of replay before the capture as a miss, not an expiry', async () => {
    const store = storeWith([capture({ retrievedAt: daysAgo(40) })])
    store.prune({ now: NOW })
    const replay = createReplayStore(store.list(), {
      tombstones: store.tombstones(),
      asOf: new Date(NOW.getTime() - 60 * DAY_MS),
    })
    // The capture had not been retrieved yet at the replayed moment. "Pruned"
    // would be a different false story from "miss", and just as much of one.
    await assert.rejects(
      () => replay('https://www.gdacs.org/rss.xml'),
      (error) => error instanceof ReplayMissError && !(error instanceof ReplayPrunedError),
    )
  })

  it('refuses a reloaded tombstone for a body the store holds again', async () => {
    const entry = capture({ retrievedAt: daysAgo(40) })
    const store = storeWith([entry])
    store.prune({ now: NOW })
    assert.equal(store.tombstone(entry.content_hash) !== null, true)

    // Re-capturing the same bytes means the URL is servable again. A tombstone
    // that outlived its body would make a working replay raise ReplayPrunedError,
    // which is the guard failing in the direction that blocks real use.
    store.add({
      url: entry.url,
      source: entry.source,
      status: entry.status,
      contentType: entry.content_type,
      body: entry.body,
      retrievedAt: NOW.toISOString(),
    })
    assert.equal(store.adoptTombstone({ content_hash: entry.content_hash, url: entry.url }), false)
    assert.equal(store.tombstone(entry.content_hash), null)

    const replay = createReplayStore(store.list(), { tombstones: store.tombstones() })
    assert.equal(await (await replay(entry.url)).status, 200)
  })
})

describe('tombstones survive a store file', () => {
  it('round-trips through JSON and reloads into a store', async () => {
    const store = storeWith([
      capture({ url: 'https://x.test/old', retrievedAt: daysAgo(40), body: '<rss>old</rss>' }),
      capture({ url: 'https://x.test/new', retrievedAt: daysAgo(1), body: '<rss>new</rss>' }),
    ])
    store.prune({ now: NOW })

    const restored = parseCaptures(store.toJSON())
    assert.equal(restored.length, 1)
    assert.equal(restored.tombstones.length, 1)
    assert.equal(restored.retention.retention_days, RETENTION_POLICY.retention_days)

    const reloaded = new CaptureStore(restored, { tombstones: restored.tombstones })
    assert.equal(reloaded.prunedFor('https://x.test/old').reason, 'retention_window_expired')
    // And the reason the replay can still tell the two apart after a restart.
    const replay = createReplayStore(reloaded.list(), { tombstones: reloaded.tombstones() })
    await assert.rejects(() => replay('https://x.test/old'), ReplayPrunedError)
  })

  it('keeps the array contract for a document with no tombstones', () => {
    const entries = parseCaptures(serialiseCaptures([capture()]))
    assert.ok(Array.isArray(entries))
    assert.equal(entries.length, 1)
    assert.equal(entries.tombstones.length, 0)
  })
})

describe('a reloaded capture keeps the fields that say how the provider served it', () => {
  it('keeps content_type and first-retrieval time through a store round trip', () => {
    // `add` takes `contentType`/`retrievedAt` while a stored entry carries
    // `content_type`/`retrieved_at`. Handing one to the other silently drops
    // both: the XML capture came back classified as `binary` and seeded into the
    // fixture suite as `.bin`, and the retention clock restarted from the load.
    // The content type is not decoration — the GloFAS defect was entirely a
    // content-type fact.
    const original = capture({ retrievedAt: daysAgo(3) })
    const store = storeWith([original])
    const reloaded = storeWith(parseCaptures(store.toJSON()))

    const [entry] = reloaded.list()
    assert.equal(entry.content_type, 'application/xml')
    assert.equal(entry.kind, 'xml')
    assert.equal(entry.retrieved_at, daysAgo(3))
    assert.equal(entry.last_seen_at, daysAgo(3))
    assert.equal(entry.byte_length, original.byte_length)
  })

  it('does not reset the sighting count when a seen body is reloaded', () => {
    const store = storeWith([capture({ retrievedAt: daysAgo(10) })])
    store.add({
      url: 'https://www.gdacs.org/rss.xml',
      source: 'gdacs',
      status: 200,
      contentType: 'application/xml',
      body: GDACS_XML,
      retrievedAt: daysAgo(2),
    })
    assert.equal(store.list()[0].seen_count, 2)
    assert.equal(storeWith(parseCaptures(store.toJSON())).list()[0].seen_count, 2)
  })
})

describe('a replay is identifiable as a replay', () => {
  it('stamps the store it replays from', () => {
    // Distinct bodies: identical bytes are one capture by content hash, so two
    // captures of one body would be a store holding one thing, not two.
    const store = storeWith([
      capture({ url: 'https://x.test/a', body: '<rss>a</rss>' }),
      capture({ url: 'https://x.test/b', body: '<rss>b</rss>' }),
    ])
    const replay = createReplayStore(store.list())

    assert.equal(replay.provenance.origin, REPLAY_ORIGIN)
    assert.equal(replay.provenance.is_live_observation, false)
    assert.equal(replay.provenance.captured_bodies, 2)
    assert.deepEqual([...replay.provenance.replayed_urls], ['https://x.test/a', 'https://x.test/b'])
    assert.equal(isReplayDerived({ provenance: replay.provenance }), true)
  })

  it('dates a replay by when the bytes were retrieved, not when they were read', () => {
    const store = storeWith([
      capture({ url: 'https://x.test/older', retrievedAt: daysAgo(20), body: '<rss>older</rss>' }),
      capture({ url: 'https://x.test/newer', retrievedAt: daysAgo(3), body: '<rss>newer</rss>' }),
    ])
    const provenance = store.replayProvenance({ asOf: NOW, now: NOW })
    // September evidence read in October. Dating the replay October would
    // assert a currency the bytes do not have, which is the whole claim being
    // stamped, so `as_of` is the newest body and the read is named separately.
    assert.equal(provenance.as_of, daysAgo(3))
    assert.equal(provenance.replayed_at, NOW.toISOString())
    assert.equal(provenance.earliest_retrieved_at, daysAgo(20))
    assert.equal(provenance.is_live_observation, false)
  })

  it('excludes bodies retrieved after the replay moment, as the replay does', () => {
    const store = storeWith([
      capture({ url: 'https://x.test/old', retrievedAt: daysAgo(20), body: '<rss>old</rss>' }),
      capture({ url: 'https://x.test/future', retrievedAt: NOW.toISOString(), body: '<rss>future</rss>' }),
    ])
    const replay = createReplayStore(store.list(), { asOf: daysAgo(10) })
    assert.deepEqual(replay.urls(), ['https://x.test/old'])
    const provenance = store.replayProvenance({ asOf: daysAgo(10), now: NOW })
    // The stamp has to match what the replay serves, not what the store holds.
    assert.equal(provenance.captured_bodies, 1)
    assert.deepEqual([...provenance.urls], ['https://x.test/old'])
    assert.equal(provenance.as_of, daysAgo(20))
  })

  it('has no provenance for an empty store rather than a vacuous one', () => {
    assert.equal(new CaptureStore().replayProvenance(), null)
  })

  it('stamps records built from a replay, and refuses to unstamp them', () => {
    const stamp = { origin: REPLAY_ORIGIN, is_live_observation: false }
    const record = stampReplayProvenance({ id: 'evt-1', title: 'Flood', severity: 'high' }, stamp)

    assert.equal(isReplayDerived(record), true)
    assert.equal(record.provenance.is_live_observation, false)
    assert.equal(record.title, 'Flood', 'the record itself is untouched')
    assert.equal(Object.isFrozen(record), true)
    // The original is not mutated in place: a shared object stamped by one
    // replay path would silently reclassify every other holder of it.
    const raw = { id: 'evt-2' }
    stampReplayProvenance(raw, stamp)
    assert.equal(raw.provenance, undefined)
  })

  it('stamps every element of a list, since records travel in lists', () => {
    const records = stampReplayProvenance([{ id: 'a' }, { id: 'b' }])
    assert.deepEqual(records.map(isReplayDerived), [true, true])
  })
})

describe('a seeded fixture is marked as replayed evidence', () => {
  it('says so once, at the top of the manifest', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-capture-export-'))
    await seedFixturesFromCaptures([capture()], { targetDir: target })

    const manifest = JSON.parse(await fs.readFile(path.join(target, 'captures.manifest.json'), 'utf8'))
    assert.equal(manifest.replay.origin, REPLAY_ORIGIN)
    assert.equal(manifest.replay.is_live_observation, false)
    assert.equal(manifest.replay.retention.retention_days, RETENTION_POLICY.retention_days)
    // Stated as a sentence a test author will read while writing the next
    // parser, because the reader of a fixture is exactly who must know it is
    // looking at a recording rather than at a live provider.
    assert.match(manifest.replay.statement, /never be presented as live observations/)
    assert.match(manifest.fixtures[0].file, /^gdacs\.xml$/)
    await fs.rm(target, { recursive: true, force: true })
  })
})

describe('pruning is not the only thing that can go wrong', () => {
  it('prunes the boundary inclusively, so skew cannot decide it', () => {
    const at = (ms, id) => ({ content_hash: id, retrieved_at: new Date(NOW.getTime() - ms).toISOString() })
    const window = 10 * DAY_MS
    const kept = pruneCaptures([at(0, 'fresh'), at(window, 'edge'), at(window + 1, 'past')], {
      now: NOW,
      retentionDays: 10,
    })
    assert.deepEqual(kept.map((entry) => entry.content_hash), ['fresh', 'edge'])
  })
})

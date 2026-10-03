#!/usr/bin/env node
/**
 * ENH-13: a revised record keeps the value it used to have.
 *
 * GDACS, USGS, WHO and NOAA CPC all correct their own numbers after
 * publication. `mergeById` does `{...existing, ...incoming}` keyed on id, so
 * every one of those corrections was an unrecoverable overwrite. For a tool
 * whose product claim is auditability this is the worst class of bug in the
 * repository: it does not fail, it does not look wrong, and the answer it
 * destroys is the answer a donor asks for.
 *
 * What makes it worth a dedicated suite is that the fix has a boundary that is
 * easy to get wrong in the *helpful* direction. Record every merge as a
 * revision and the history table fills with rows recording nothing; the real
 * corrections then become unfindable, and a reader who has been trained by that
 * table stops trusting it. So both halves are asserted here: a real revision is
 * kept, and an unchanged re-delivery writes nothing.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import {
  BITEMPORAL_COLLECTIONS,
  changedFields,
  isRevision,
  valueAsOf,
  versionRow,
  versionsFor,
} from '../src/bitemporal.js'
import { COLLECTIONS, JsonStore, supersededVersions } from '../src/store.js'
import { SOURCE_IDS } from '../src/schema.js'

function hazard(overrides = {}) {
  return {
    id: 'hazard-1',
    source: 'gdacs',
    type: 'flood',
    severity: 'high',
    country: 'KE',
    observed_at: '2019-03-01T00:00:00.000Z',
    first_seen_at: '2019-03-02T09:00:00.000Z',
    updated_at: '2019-03-02T09:00:00.000Z',
    ...overrides,
  }
}

describe('what counts as a revision', () => {
  it('is a record that changed, not one that came back', () => {
    // The distinction the whole module rests on. A healthy daily re-ingest
    // re-delivers the same payload and must write nothing; the upstream
    // correction writes one row.
    const before = hazard({ payload_hash: 'h1' })
    assert.equal(isRevision(before, { ...before }), false, 'byte-identical is not a revision')
    assert.equal(isRevision(before, { ...before, payload_hash: 'h2' }), true, 'a new hash is a revision')
    assert.equal(isRevision(null, before), false, 'a first write has no predecessor to supersede')
  })

  it('treats an unhashed record as a revision, because it cannot prove otherwise', () => {
    // No payload_hash means "unchanged" is unknowable. Erring toward recording
    // is the recoverable direction: a spurious history row is deletable, a lost
    // one is not.
    assert.equal(isRevision(hazard(), { id: 'hazard-1', severity: 'critical' }), true)
  })

  it('reports what changed, and nothing when nothing did', () => {
    assert.deepEqual(changedFields(hazard(), hazard()), null)
    assert.deepEqual(changedFields(hazard(), hazard({ severity: 'critical' })), {
      severity: { from: 'high', to: 'critical' },
    })
  })

  it('does not call a lost optional field a change of value', () => {
    // An absent field is not a null field. Reporting `{to: null}` for a column
    // upstream simply stopped sending would write a change to every value that
    // was ever null, which is most of them.
    const changed = changedFields(hazard({ deaths: 5 }), hazard())
    assert.equal(changed.deaths.presence, 'removed')
    assert.equal(changed.deaths.to, null)
  })

  it('ignores the timestamps that change on every write', () => {
    // updated_at moves on every merge by construction. Counting it would report
    // a revision on every single write and make the table unreadable.
    assert.equal(changedFields(hazard(), hazard({ updated_at: '2026-10-03T00:00:00.000Z' })), null)
  })

  it('keeps a legitimate zero', () => {
    // Zero deaths and zero millimetres of rain are values. A falsy-zero check
    // here would report the record as unchanged when a 3 became a 0.
    assert.deepEqual(changedFields(hazard({ deaths: 3 }), hazard({ deaths: 0 })), {
      deaths: { from: 3, to: 0 },
    })
  })
})

describe('the version row', () => {
  it('opens the interval at when we first held the value, not now', () => {
    // The whole point. A record written last Tuesday and corrected today must
    // carry Tuesday as the start of the value that held until today, or
    // "what did we say last quarter" answers with the correction's date.
    const row = versionRow({
      collection: 'hazard_events',
      recordId: 'hazard-1',
      previous: hazard(),
      next: hazard({ severity: 'critical' }),
      supersededAt: '2026-10-03T00:00:00.000Z',
    })
    assert.equal(row.valid_from, '2019-03-02T09:00:00.000Z')
    assert.equal(row.valid_to, '2026-10-03T00:00:00.000Z')
    assert.equal(row.body.severity, 'high')
    assert.deepEqual(row.changed_fields, { severity: { from: 'high', to: 'critical' } })
  })

  it('carries no payload_hash, because the predecessor already has that hash', () => {
    // mergeById skips an incoming record whose hash it has seen. A version row
    // wearing the body's hash would be discarded as a duplicate upstream
    // delivery the first time that value came round again — the history losing
    // the revision it exists to record.
    const row = versionRow({
      collection: 'hazard_events',
      recordId: 'hazard-1',
      previous: hazard({ payload_hash: 'h1' }),
      next: hazard({ payload_hash: 'h2' }),
    })
    assert.equal(row.payload_hash, null)
  })

  it('refuses a collection it cannot version, and says why', () => {
    assert.throws(
      () => versionRow({ collection: 'alert_events', recordId: 'a', previous: hazard() }),
      /not a bitemporal collection/,
      'alert events are append-only; versioning them writes rows recording nothing',
    )
  })

  it('refuses a record with no timestamp rather than inventing an interval', () => {
    // An unbounded history entry makes valueAsOf() answer for times it cannot
    // justify, which is the failure mode bitemporality exists to remove.
    assert.throws(
      () => versionRow({ collection: 'hazard_events', recordId: 'h', previous: { id: 'h', severity: 'high' } }),
      /no timestamp to open the interval/,
    )
  })
})

describe('supersededVersions', () => {
  it('returns the previous values before the merge destroys them', () => {
    const existing = [hazard({ payload_hash: 'h1' })]
    const incoming = [hazard({ payload_hash: 'h2', severity: 'critical' })]
    const rows = supersededVersions('hazard_events', existing, incoming)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].body.severity, 'high', 'the pre-merge value, not the incoming one')
  })

  it('writes nothing for an unchanged re-delivery', () => {
    // A healthy daily re-ingest re-delivers identical payloads. One history row
    // per day per record would bury the corrections in noise and train a reader
    // to skip the table.
    const existing = [hazard({ payload_hash: 'h1' })]
    assert.deepEqual(supersededVersions('hazard_events', existing, [hazard({ payload_hash: 'h1' })]), [])
  })

  it('says nothing rather than guessing when the predecessor has no timestamp', () => {
    const rows = supersededVersions(
      'hazard_events',
      [{ id: 'hazard-1', payload_hash: 'h1' }],
      [{ id: 'hazard-1', payload_hash: 'h2', severity: 'critical' }],
    )
    assert.deepEqual(rows, [], 'drops the row rather than writing an unbounded interval')
  })
})

describe('the query a donor actually asks', () => {
  it('answers what the platform said at a past time', () => {
    const versions = [versionRow({
      collection: 'hazard_events',
      recordId: 'hazard-1',
      previous: hazard({ severity: 'high', payload_hash: 'h1' }),
      next: hazard({ severity: 'critical', payload_hash: 'h2' }),
      supersededAt: '2026-10-01T00:00:00.000Z',
    })]
    const current = hazard({ severity: 'critical', payload_hash: 'h2' })

    const lastQuarter = valueAsOf(versions, {
      collection: 'hazard_events',
      recordId: 'hazard-1',
      at: '2026-07-01T00:00:00.000Z',
      current,
    })
    assert.equal(lastQuarter.severity, 'high', 'the corrected figure, not the correction')

    const today = valueAsOf(versions, {
      collection: 'hazard_events',
      recordId: 'hazard-1',
      at: '2026-10-02T00:00:00.000Z',
      current,
    })
    assert.equal(today.severity, 'critical')
  })

  it('returns null before we held anything, which is not a zero', () => {
    const answer = valueAsOf([], {
      collection: 'hazard_events',
      recordId: 'never-ingested',
      at: '2026-07-01T00:00:00.000Z',
    })
    assert.equal(answer, null, 'an absent answer is not an empty record')
  })

  it('returns null for an unparseable time rather than the newest value', () => {
    const answer = valueAsOf([], { collection: 'hazard_events', recordId: 'h', at: 'not-a-date' })
    assert.equal(answer, null)
  })

  it('counts the revisions it has', () => {
    const versions = versionsFor([
      versionRow({ collection: 'hazard_events', recordId: 'h', previous: hazard({ payload_hash: 'a' }), supersededAt: '2020-01-01T00:00:00.000Z' }),
      versionRow({ collection: 'hazard_events', recordId: 'h', previous: hazard({ payload_hash: 'b' }), supersededAt: '2021-01-01T00:00:00.000Z' }),
    ], { collection: 'hazard_events', recordId: 'h', current: hazard({ payload_hash: 'c' }) })
    assert.equal(versions.revisions, 2)
    assert.equal(versions.current.payload_hash, 'c')
  })
})

describe('the store round-trip', () => {
  let dir
  let store

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-bitemporal-'))
    store = new JsonStore(path.join(dir, 'store.json'))
  })

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('keeps the superseded value across a real merge', async () => {
    await store.merge({ hazard_events: [hazard({ payload_hash: 'h1' })] })
    await store.merge({ hazard_events: [hazard({ payload_hash: 'h2', severity: 'critical' })] })

    const data = await store.read()
    assert.equal(data.hazard_events[0].severity, 'critical', 'the live record carries the correction')
    assert.equal(data.record_versions.length, 1, 'and the value it replaced is still there')
    assert.equal(data.record_versions[0].body.severity, 'high')
  })

  it('writes no history for a re-delivery', async () => {
    await store.merge({ hazard_events: [hazard({ payload_hash: 'h2', severity: 'critical' })] })
    const data = await store.read()
    assert.equal(data.record_versions.length, 1, 'an unchanged re-delivery is not a revision')
  })

  it('accumulates rather than overwriting across successive corrections', async () => {
    await store.merge({ hazard_events: [hazard({ payload_hash: 'h3', severity: 'low' })] })
    const data = await store.read()
    assert.equal(data.record_versions.length, 2)
    const severities = data.record_versions.map((v) => v.body.severity).sort()
    assert.deepEqual(severities, ['critical', 'high'], 'every prior value survives')
  })

  it('survives a fresh read on a file that has never existed', async () => {
    // emptyStore() must carry the key or `data.record_versions` throws on the
    // very first merge — a store-conformance bug, not a bitemporality one.
    const empty = new JsonStore(path.join(dir, 'never-written.json'))
    const data = await empty.read()
    assert.deepEqual(data.record_versions, [])
  })
})

describe('the list of collections is checkable', () => {
  it('names only collections the store has', () => {
    // Both lists are hand-maintained and this repository's signature defect is
    // a hand-maintained list that nothing checks. Naming a collection that
    // does not exist means its history is silently never written.
    for (const collection of BITEMPORAL_COLLECTIONS) {
      assert.ok(COLLECTIONS.includes(collection), `${collection} is versioned but not a collection`)
    }
  })

  it('covers the sources that revise in place', () => {
    // Not every source is in there — those are the ones that overwrite.
    for (const collection of ['hazard_events', 'conflict_events', 'disease_observations', 'food_security_records']) {
      assert.ok(BITEMPORAL_COLLECTIONS.includes(collection), `${collection} is revised upstream`)
    }
  })

  it('excludes the append-only collections, which have nothing to version', () => {
    for (const collection of ['alert_events', 'action_logs', 'webhook_subscriptions']) {
      assert.ok(!BITEMPORAL_COLLECTIONS.includes(collection), `${collection} is append-only`)
    }
  })

  it('names collections, not source ids, except for the one that is both', () => {
    // An earlier draft of this suite asserted no overlap at all with
    // SOURCE_IDS. It failed, and it was wrong: `service_assets` is spelled
    // identically as a source id (src/schema.js) and as a collection, because
    // the DHIS2-style asset upload writes straight into that collection. The
    // overlap is real, so it is pinned here rather than asserted away — a
    // future rename on either side should be a deliberate edit here.
    const overlaps = BITEMPORAL_COLLECTIONS.filter((c) => SOURCE_IDS.includes(c))
    assert.deepEqual(overlaps, ['service_assets'])
    assert.ok(BITEMPORAL_COLLECTIONS.every((c) => typeof c === 'string' && c.includes('_')),
      'every entry is a collection name, not a source name')
  })
})
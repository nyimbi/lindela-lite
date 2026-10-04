import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { VERSIONS_PER_RECORD, pruneVersions } from '../src/bitemporal.js'

/**
 * A version table without a bound is not history, it is a second copy of the
 * store that only grows.
 *
 * This is not a theoretical worry. The demo store reached 37,735 version rows
 * and 300 MB, and `JsonStore.read()` parses the whole file, so every API request
 * allocated hundreds of megabytes of objects: 120 requests took the process from
 * 66 MB to 1.5 GB and then an OOM killed it. A version row's id includes the
 * supersession time, so re-running ingestion adds rows rather than replacing
 * them, and nothing was removing any.
 *
 * These assertions pin the pruning decision itself, not just that it runs.
 */

const version = (recordId, day, overrides = {}) => ({
  id: `v-${recordId}-${day}`,
  collection: 'climate_observations',
  record_id: recordId,
  body: { value: day },
  valid_from: `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  valid_to: `2026-02-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  ...overrides,
})

describe('version retention', () => {
  it('keeps the most recent revisions of a record', () => {
    const versions = Array.from({ length: 30 }, (_, i) => version('rec-a', i + 1))
    const kept = pruneVersions(versions)

    assert.equal(kept.length, VERSIONS_PER_RECORD)
    assert.deepEqual(
      kept.map((v) => v.body.value),
      // Days 26..30: the newest five of a 30-revision record.
      Array.from({ length: VERSIONS_PER_RECORD }, (_, i) => i + 26),
      'the oldest revisions are the ones dropped — a query about a record\'s recent past must still answer',
    )
  })

  it('bounds each record separately, not the table as a whole', () => {
    const versions = [
      ...Array.from({ length: 25 }, (_, i) => version('rec-a', i + 1)),
      ...Array.from({ length: 25 }, (_, i) => version('rec-b', i + 1)),
      ...Array.from({ length: 25 }, (_, i) => version('rec-c', i + 1)),
    ]
    const kept = pruneVersions(versions)

    assert.equal(kept.length, VERSIONS_PER_RECORD * 3,
      'one record\'s history must not be spent by another\'s')
    for (const id of ['rec-a', 'rec-b', 'rec-c']) {
      const mine = kept.filter((v) => v.record_id === id)
      assert.equal(mine.length, VERSIONS_PER_RECORD)
      assert.equal(mine.at(-1).body.value, 25, `${id} keeps its most recent revision`)
    }
  })

  it('ranks on valid_to, not on array position', () => {
    // A later run can supersede a record whose earlier revision carried the
    // later timestamp. Ranking by insertion order would then keep the wrong
    // window, and the wrong window is the one `valueAsOf` reads.
    const versions = [
      version('rec-a', 1, { valid_to: '2026-09-01T00:00:00.000Z' }),
      ...Array.from({ length: 25 }, (_, i) => version('rec-a', i + 2)),
    ]
    const kept = pruneVersions(versions)

    assert.ok(kept.some((v) => v.valid_to === '2026-09-01T00:00:00.000Z'),
      'the row with the latest valid_to survives, even though it was written first')
  })

  it('applies a total ceiling across records', () => {
    const versions = Array.from({ length: 60 }, (_, i) => version(`rec-${i}`, 1))
    const kept = pruneVersions(versions, { perRecord: 20, total: 25 })

    assert.equal(kept.length, 25)
    assert.ok(kept.every((v) => versions.includes(v)), 'pruning removes rows; it never invents one')
  })

  it('keeps a row it cannot attribute to a record', () => {
    const orphan = { id: 'v-orphan', collection: 'climate_observations', body: {} }
    const kept = pruneVersions([orphan])
    assert.deepEqual(kept, [orphan],
      'dropping history we cannot classify is a different decision from bounding it')
  })

  it('is a no-op on a table within bounds', () => {
    const versions = [version('rec-a', 1), version('rec-b', 2)]
    assert.deepEqual(pruneVersions(versions), versions)
    assert.deepEqual(pruneVersions([]), [])
    assert.deepEqual(pruneVersions(undefined), [])
  })
})
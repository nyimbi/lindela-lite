import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { JsonStore } from '../src/store.js'
import { runIngestion } from '../src/ingestion.js'

/**
 * Watermark state has to survive a run.
 *
 * The contract existed — a connector reads `options.watermark_state` and returns
 * `output.watermark_state` — and nothing supplied either end, so a 40-year
 * archive walked its whole series on every run and re-downloaded it to discover
 * nothing was new.
 */

function scratchStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-wm-'))
  return new JsonStore(path.join(dir, 'store.json'))
}

/** A connector that records the state it was handed and returns a new one. */
function watermarkConnector(received, next) {
  return {
    id: 'open_meteo_archive',
    async ingest(options) {
      received.push(options.watermark_state)
      return {
        climate_observations: [{ id: `obs-${received.length}`, value: 1 }],
        errors: [],
        watermark_state: next,
      }
    },
  }
}

describe('watermark state survives a run', () => {
  it('hands the second run what the first stored', async () => {
    const store = scratchStore()
    await store.write({})

    const first = []
    const next = { sources: { open_meteo_archive: { last_success_at: '2026-01-01T00:00:00Z' } } }
    await runIngestion(
      store,
      { sources: ['open_meteo_archive'] },
      { connectors: { open_meteo_archive: watermarkConnector(first, next) } },
    )

    assert.deepEqual(first[0], {}, 'the first run has nothing stored to resume from')
    const stored = await store.read()
    assert.equal(stored.watermark_state.length, 1)
    assert.deepEqual(stored.watermark_state[0].state, next)

    const second = []
    await runIngestion(
      store,
      { sources: ['open_meteo_archive'] },
      { connectors: { open_meteo_archive: watermarkConnector(second, next) } },
    )
    assert.deepEqual(second[0], next, 'the second run resumes from the stored position')
  })

  it('keeps a source\'s position when a run does not report one', async () => {
    const store = scratchStore()
    await store.write({})

    const seeded = { sources: { open_meteo_archive: { last_success_at: '2026-01-01T00:00:00Z' } } }
    await store.merge({ watermark_state: [{ id: 'watermark_open_meteo_archive', source: 'open_meteo_archive', state: seeded }] })

    // A connector that has not been wired up returns no state at all.
    const silent = { id: 'open_meteo_archive', async ingest() { return { climate_observations: [], errors: [] } } }
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: silent } })

    const after = await store.read()
    assert.equal(after.watermark_state.length, 1, 'the row is not cleared')
    assert.deepEqual(
      after.watermark_state[0].state,
      seeded,
      'an unwired connector keeps the position it had rather than resetting it',
    )
  })

  it('does not share one source\'s position with another', async () => {
    const store = scratchStore()
    await store.write({})
    // Real source ids: runIngestion validates against SOURCE_IDS, and a fake one
    // fails the run before the watermark is ever handed over.
    const A = 'open_meteo_archive'
    const B = 'gdacs_archive'
    await store.merge({
      watermark_state: [
        { id: `watermark_${A}`, source: A, state: { sources: { [A]: { last_success_at: '2026-01-01T00:00:00Z' } } } },
        { id: `watermark_${B}`, source: B, state: { sources: { [B]: { last_success_at: '2026-02-02T00:00:00Z' } } } },
      ],
    })

    const received = []
    const conn = (id) => ({ id, async ingest(o) { received.push([id, o.watermark_state]); return { hazard_events: [], errors: [] } } })
    await runIngestion(store, { sources: [A, B] }, { connectors: { [A]: conn(A), [B]: conn(B) } })

    assert.deepEqual(received[0][1], { sources: { [A]: { last_success_at: '2026-01-01T00:00:00Z' } } })
    assert.deepEqual(received[1][1], { sources: { [B]: { last_success_at: '2026-02-02T00:00:00Z' } } })
  })

  it('declares the collection, so its rows are not dropped on write', async () => {
    const store = scratchStore()
    await store.merge({ watermark_state: [{ id: 'watermark_x', source: 'x', state: {} }] })
    const data = await store.read()
    assert.equal(data.watermark_state.length, 1,
      'an undeclared collection is dropped silently — the bug this declaration exists to prevent')
  })
})

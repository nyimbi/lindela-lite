import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { DERIVED_COLLECTIONS, mergeById } from '../src/store.js'
import { refreshAnalytics } from '../src/analytics.js'
import { metrics, resetMetrics } from '../src/observability.js'

/**
 * R-50 — a calibration snapshot that cannot be written must say so.
 *
 * The snapshot is written best-effort *by design*: a refresh that computed every
 * derived collection correctly must not fail because an optional artefact on the
 * side could not be persisted, and failing the refresh would throw away work the
 * pipeline needs. That decision is right and this does not change it.
 *
 * What was wrong is that "best-effort" was implemented as `catch { }`. A disk
 * that filled, a `data/calibration` directory that lost its write bit, a path
 * that is a file where a directory was expected — each produced a stale
 * `latest.json` and *nothing else*: no log line, no counter, no field. An
 * operator reading a calibration snapshot from three weeks ago had no way to
 * learn it was three weeks old, which is the same silent-disk class R-49 is
 * about, one layer up. A failure that is tolerated is not the same as a failure
 * that is unobservable, and only the first is a design decision.
 *
 * These tests drive a real `refreshAnalytics` against a store double and a real
 * directory that cannot be written, and read the metric the failure is reported
 * through. No mock of the failure — the directory is genuinely read-only.
 */

const CALIBRATION_METRIC = 'calibration_snapshot_write_failed_total'

/** A store double holding real records, as `test/derived-cache.test.js` uses. */
class MemoryStore {
  constructor(initial = {}) {
    this.state = { ...initial }
  }

  async read() {
    return this.state
  }

  async merge(partial = {}) {
    for (const [key, records] of Object.entries(partial)) {
      if (!Array.isArray(records)) { this.state[key] = records; continue }
      this.state[key] = mergeById(this.state[key] || [], records)
    }
    return this.state
  }

  async replaceAnalytics(payload = {}) {
    for (const name of DERIVED_COLLECTIONS) this.state[name] = payload[name] || []
    return this.state
  }
}

const seeded = () => ({
  service_assets: [{ id: 'c1', name: 'Clinic', service_type: 'health', country: 'KE', latitude: 3.11, longitude: 35.61 }],
  hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 3.1, longitude: 35.6 }],
  climate_observations: [],
  conflict_events: [],
  alert_events: [],
  flood_probability_models: [],
  source_runs: [],
})

/**
 * Count of the calibration-failure counter, summed across label sets, read from
 * the exposition a scrape sees. Summed rather than matched on one label set:
 * the counter is labelled by `code`, and a reader pinned to `ENOTDIR` would
 * report zero for a failure that arrived as `EACCES` — a measurement that only
 * sees the case it was written for.
 */
function counterValue(name) {
  return metrics.render().split('\n')
    .filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `))
    .reduce((sum, l) => sum + Number(l.split(' ').pop()), 0)
}

const savedDir = process.env.LINDELA_LITE_CALIBRATION_DIR
const savedNodeEnv = process.env.NODE_ENV

afterEach(() => {
  if (savedDir === undefined) delete process.env.LINDELA_LITE_CALIBRATION_DIR
  else process.env.LINDELA_LITE_CALIBRATION_DIR = savedDir
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedNodeEnv
  resetMetrics()
})

describe('R-50 — a calibration snapshot that cannot be written is reported, not swallowed', () => {
  it('counts and logs a write failure, and still returns the computed payload', async () => {
    // The refresh must not fail — that decision stands — but the failure must be
    // observable. Both halves are asserted, because a fix that made the refresh
    // throw would be a worse bug than the one it repairs.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r50-'))
    // A file where the snapshot directory should be: `mkdir` then fails ENOTDIR,
    // a real and reachable state, not a mock.
    const blocked = path.join(dir, 'calibration')
    await fs.writeFile(blocked, 'not a directory')
    process.env.LINDELA_LITE_CALIBRATION_DIR = blocked
    process.env.NODE_ENV = 'production'

    const before = counterValue(CALIBRATION_METRIC)
    const result = await refreshAnalytics(new MemoryStore(seeded()))

    assert.ok(result.risk_scores, 'the refresh must still return its computed payload')
    assert.equal(counterValue(CALIBRATION_METRIC), before + 1,
      'a snapshot that could not be written left no trace an operator could see')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('does not count a failure when the snapshot is written', async () => {
    // The canary's counterpart: the counter must be silent on the success path,
    // or "1" means nothing.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r50-ok-'))
    process.env.LINDELA_LITE_CALIBRATION_DIR = dir
    process.env.NODE_ENV = 'production'

    const before = counterValue(CALIBRATION_METRIC)
    await refreshAnalytics(new MemoryStore(seeded()))

    assert.equal(counterValue(CALIBRATION_METRIC), before,
      'the failure counter fired on a write that succeeded')
    const written = JSON.parse(await fs.readFile(path.join(dir, 'latest.json'), 'utf8'))
    assert.ok(written.generated_at, 'the snapshot must have been written')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('does not count anything when the snapshot is turned off', async () => {
    // `LINDELA_LITE_CALIBRATION_DIR=off` is a deliberate refusal, not a failure.
    // Counting it would make the metric fire on every refresh of every
    // deployment that has opted out, which is how a metric becomes noise.
    process.env.LINDELA_LITE_CALIBRATION_DIR = 'off'
    process.env.NODE_ENV = 'production'

    const before = counterValue(CALIBRATION_METRIC)
    await refreshAnalytics(new MemoryStore(seeded()))

    assert.equal(counterValue(CALIBRATION_METRIC), before,
      'an opted-out snapshot was counted as a failure')
  })
})

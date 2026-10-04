#!/usr/bin/env node
/**
 * ENH-12: the capture CLI.
 *
 * `scripts/capture-fixtures.mjs` had no test at all, which is how it shipped two
 * defects that only appear on the paths a person actually runs:
 *
 * - `process.stdout.warn(...)` — there is no `warn` on a WriteStream. The
 *   superseded-capture path threw a TypeError *after* the fixtures had been
 *   written, so the run reported failure for work it had completed, and the
 *   warning — the only record that a capture was dropped — was lost.
 * - a store file reloaded through `add` lost `content_type`, so an XML capture
 *   seeded as `.bin`. The manifest then said `-` where it should have named how
 *   the provider presented the bytes.
 *
 * So the CLI is driven as a subprocess the way an operator drives it, and
 * asserted on what it printed and what it wrote. Argument parsing and the
 * retention arithmetic are the parts that decide whether a capture survives, so
 * they are worth exercising end to end rather than through an import.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { CaptureStore, RETENTION_POLICY } from '../src/capture.js'

const run = promisify(execFile)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO, 'scripts', 'capture-fixtures.mjs')

async function workdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lindela-capture-cli-'))
}

/** Run the CLI, returning stdout, stderr and the exit code rather than throwing. */
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: REPO })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 }
  }
}

/** A store file holding one capture `days` old. */
async function storeFile(dir, { days, url = 'https://www.gdacs.org/rss.xml', body = '<rss>item</rss>' } = {}) {
  const store = new CaptureStore()
  store.add({
    url,
    source: 'gdacs',
    status: 200,
    contentType: 'application/xml',
    body,
    retrievedAt: new Date(Date.now() - days * 86400000).toISOString(),
  })
  const file = path.join(dir, 'store.json')
  await fs.writeFile(file, store.toJSON(), 'utf8')
  return file
}

describe('the capture CLI states the retention window before pruning anything', () => {
  it('prints the policy on every run', async () => {
    const dir = await workdir()
    const store = await storeFile(dir, { days: 1 })
    const { stdout } = await cli(['--store', store, '--prune-only'])
    assert.match(stdout, new RegExp(`${RETENTION_POLICY.retention_days} days from first retrieval`))
    assert.match(stdout, /inclusive/)
    assert.match(stdout, /tombstone/)
  })

  it('refuses a window that is not a positive number of days', async () => {
    const dir = await workdir()
    const store = await storeFile(dir, { days: 1 })
    // A zero or negative window would prune everything, and NaN would prune
    // nothing while reporting a window — neither is a retention policy.
    for (const bad of ['0', '-5', 'soon']) {
      const result = await cli(['--store', store, '--prune-only', '--retention-days', bad])
      assert.notEqual(result.code, 0, `--retention-days ${bad} must fail`)
      assert.match(result.stderr, /positive number of days/)
    }
  })

  it('says so when the window is overridden, and records it on the tombstone', async () => {
    const dir = await workdir()
    const store = await storeFile(dir, { days: 10 })
    const { stdout } = await cli(['--store', store, '--prune-only', '--retention-days', '5'])
    assert.match(stdout, /overrides the stated 30d window/)
    const saved = JSON.parse(await fs.readFile(store, 'utf8'))
    assert.equal(saved.tombstones.length, 1)
    assert.equal(saved.tombstones[0].retention_days, 5)
  })

  it('names each capture it pruned rather than only counting them', async () => {
    const dir = await workdir()
    const store = await storeFile(dir, { days: 60 })
    const { stdout } = await cli(['--store', store, '--prune-only'])
    assert.match(stdout, /1 pruned at 30d/)
    assert.match(stdout, /pruned \w{12}/)
    assert.match(stdout, /https:\/\/www\.gdacs\.org\/rss\.xml/)
  })
})

describe('the capture CLI does not lose a record of what it dropped', () => {
  it('reports a superseded capture instead of crashing', async () => {
    const dir = await workdir()
    const store = new CaptureStore()
    // Two captures of one source under one fixture name: the newest wins and
    // the loser must be reported, which is the path that used to throw.
    for (const [days, body] of [[10, '<rss>older</rss>'], [1, '<rss>newer</rss>']]) {
      store.add({
        url: 'https://www.gdacs.org/rss.xml',
        source: 'gdacs',
        status: 200,
        contentType: 'application/xml',
        body,
        retrievedAt: new Date(Date.now() - days * 86400000).toISOString(),
      })
    }
    const file = path.join(dir, 'store.json')
    await fs.writeFile(file, store.toJSON(), 'utf8')

    const { code, stderr } = await cli(['--store', file, '--out', path.join(dir, 'fix')])
    assert.equal(code, 0, `the run must not crash on the superseded path: ${stderr}`)
    assert.match(stderr, /superseded gdacs\.xml/)
    assert.match(stderr, / by \w{12}/)
    // And the winner is the newer capture, which is the whole point.
    const written = await fs.readFile(path.join(dir, 'fix', 'gdacs.xml'), 'utf8')
    assert.match(written, /newer/)
  })

  it('marks the seeded fixtures as replayed, not observed', async () => {
    const dir = await workdir()
    const store = await storeFile(dir, { days: 1 })
    const { stdout } = await cli(['--store', store, '--out', path.join(dir, 'fix')])
    assert.match(stdout, /every seeded fixture is a replay of a captured response/)

    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'fix', 'captures.manifest.json'), 'utf8'))
    assert.equal(manifest.replay.is_live_observation, false)
  })

  it('keeps the content type through the store round trip', async () => {
    const dir = await workdir()
    const store = await storeFile(dir, { days: 1 })
    await cli(['--store', store, '--out', path.join(dir, 'fix')])
    // An XML capture seeded as `.bin` says the provider served something opaque,
    // which is the GloFAS defect's exact shape asserted backwards.
    const files = await fs.readdir(path.join(dir, 'fix'))
    assert.ok(files.includes('gdacs.xml'), `expected gdacs.xml, got ${files.join(', ')}`)
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'fix', 'captures.manifest.json'), 'utf8'))
    assert.equal(manifest.fixtures[0].content_type, 'application/xml')
  })
})

describe('the capture CLI refuses an unsafe invocation', () => {
  it('will not write fixtures without --out', async () => {
    const result = await cli(['--url', 'https://x.test/a', '--source', 'gdacs'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /--out is required/)
  })

  it('will not --url without --source, since an unlabelled capture cannot be seeded', async () => {
    const result = await cli(['--url', 'https://x.test/a', '--out', '/tmp/nope'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /--source is required/)
  })

  it('rejects an unknown flag rather than ignoring it', async () => {
    const result = await cli(['--out', '/tmp/nope', '--retention', '5'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /unknown argument/)
  })

  it('will not prune without a store to record the pruning in', async () => {
    const result = await cli(['--prune-only'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /--prune-only needs --store/)
  })
})

describe('--list reports both what is held and what has gone', () => {
  it('prints live captures and tombstones, and writes nothing', async () => {
    const dir = await workdir()
    const store = new CaptureStore()
    store.add({
      url: 'https://www.gdacs.org/rss.xml',
      source: 'gdacs',
      status: 200,
      contentType: 'application/xml',
      body: '<rss>old</rss>',
      retrievedAt: new Date(Date.now() - 60 * 86400000).toISOString(),
    })
    store.add({
      url: 'https://x.test/fresh',
      source: 'gdacs',
      status: 200,
      contentType: 'application/xml',
      body: '<rss>fresh</rss>',
      retrievedAt: new Date(Date.now() - 86400000).toISOString(),
    })
    store.prune()
    const file = path.join(dir, 'store.json')
    await fs.writeFile(file, store.toJSON(), 'utf8')

    const { stdout, code } = await cli(['--from-store', file, '--out', path.join(dir, 'unused'), '--list'])
    assert.equal(code, 0)
    assert.match(stdout, /https:\/\/x\.test\/fresh/)
    assert.match(stdout, /pruned/)
    // The sighting count, because "seen once" and "seen daily for a month" are
    // different facts about how much a provider has actually been watched.
    assert.match(stdout, /seen \d+x/)
    assert.ok(!(await fs.stat(path.join(dir, 'unused')).catch(() => null)), '--list must write nothing')
  })
})

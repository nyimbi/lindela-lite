import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { JsonStore } from '../src/store.js'

/**
 * R-49 — a failed write must not leave its temp file behind.
 *
 * `JsonStore.#writeFile` writes the whole store to `${file}.${pid}.${rand}.tmp`
 * and renames it into place, so a crash mid-write leaves the previous store
 * intact. The rename is the commit point; everything before it is disposable.
 *
 * But the temp file was only cleaned up by a *successful* rename. A write that
 * failed — `ENOSPC` on the store's own write, a rename that could not complete —
 * left the `.tmp` on disk, and the `.tmp` is the store's full size. So the disk
 * did not merely stay full: it lost another store's worth of space at the exact
 * moment it had none, and the next write had less room than the one that failed.
 * Repeated, the directory fills with orphaned full-size temp files that nothing
 * reads and nothing removes.
 *
 * The repro below is a real failure with the same shape as ENOSPC: a rename that
 * cannot complete because the destination is a directory. No mock — the temp
 * file is written for real and the rename fails for real, which is the path the
 * cleanup has to cover.
 */

let dir

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-write-cleanup-'))
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Every temp file the store's write path could have left in `dir`. */
async function tempFiles(directory) {
  const entries = await fs.readdir(directory)
  return entries.filter((name) => name.endsWith('.tmp'))
}

describe('R-49 — a write that fails leaves no temp file behind', () => {
  it('removes the temp file when the rename cannot complete', async () => {
    // The destination is a directory, so `rename(tmp, filePath)` fails with
    // EISDIR/ENOTDIR after the temp file has been written in full — the exact
    // sequence ENOSPC produces on the write itself.
    const storeDir = await fs.mkdtemp(path.join(dir, 'blocked-'))
    const target = path.join(storeDir, 'store.json')
    await fs.mkdir(target) // the destination is now un-renameable-onto

    const store = new JsonStore(target)
    await assert.rejects(
      () => store.write({ incidents: [{ id: 'i1', title: 'x' }] }),
      'a write whose rename cannot complete must reject, not silently succeed',
    )

    assert.deepEqual(await tempFiles(storeDir), [],
      'a failed write left its full-size temp file on disk, doubling usage exactly when disk is tight')
  })

  it('removes the temp file when the write itself fails', async () => {
    // The write fails before the rename: the destination directory is removed
    // out from under the store after the store has resolved it, so the temp
    // write has nowhere to land. Also a real failure, also no mock.
    const storeDir = await fs.mkdtemp(path.join(dir, 'vanished-'))
    const target = path.join(storeDir, 'store.json')
    const store = new JsonStore(target)
    // First write succeeds so the store is warm and has a cache.
    await store.write({ incidents: [{ id: 'i1', title: 'x' }] })
    // Now make the directory read-only so the next temp write fails with EACCES.
    await fs.chmod(storeDir, 0o500)
    try {
      await assert.rejects(
        () => store.write({ incidents: [{ id: 'i2', title: 'y' }] }),
        'a write into a read-only directory must reject',
      )
    } finally {
      await fs.chmod(storeDir, 0o700)
    }
    assert.deepEqual(await tempFiles(storeDir), [],
      'a write that could not even land its temp file left one behind')
  })

  it('reports free space and the store size, which is what predicts the next failure', async () => {
    // R-49's other half. The temp file is gone; nothing yet says the disk is
    // filling. The predicate the write path actually obeys is
    // `free_bytes < store_bytes` — the rewrite needs a second copy of the store
    // to land — so both numbers are reported and neither alone is the answer.
    const storeDir = await fs.mkdtemp(path.join(dir, 'usage-'))
    const target = path.join(storeDir, 'store.json')
    const store = new JsonStore(target)
    await store.write({ incidents: [{ id: 'i1', title: 'x' }] })

    const usage = await store.storageUsage()
    assert.equal(usage.supported, true, 'a real filesystem must answer statfs')
    assert.equal(usage.backend, 'json')
    assert.ok(usage.store_bytes > 0, 'the store has been written and must report a size')
    assert.ok(usage.free_bytes > 0, 'a tmpdir has free space')
    assert.ok(usage.free_bytes < usage.total_bytes, 'free space cannot exceed the volume')
  })

  it('reports a size for a store that has never been written', async () => {
    // A store about to be created has no size, but its directory has free space,
    // and that is the number the write about to create it needs. Returning
    // `supported: false` here would make a fresh deployment permanently unable
    // to answer the probe.
    const storeDir = await fs.mkdtemp(path.join(dir, 'fresh-'))
    const store = new JsonStore(path.join(storeDir, 'not-yet.json'))
    const usage = await store.storageUsage()
    assert.equal(usage.supported, true)
    assert.equal(usage.store_bytes, 0)
    assert.ok(usage.free_bytes > 0)
  })

  it('says it has no schema ledger rather than inventing a version', async () => {
    // R-48, the JSON half. A backend with no migrations cannot be behind them,
    // and reporting drift here would make every JSON deployment unready.
    const store = new JsonStore(path.join(dir, 'schema.json'))
    const status = await store.schemaStatus()
    assert.equal(status.supported, false)
    assert.equal(status.current, null)
    assert.deepEqual(status.pending, [])
  })

  it('still writes normally, and renames the temp into place', async () => {
    // The cleanup must not have broken the success path: a good write lands the
    // store and leaves no temp file, which is the behaviour the temp file exists
    // to provide.
    const storeDir = await fs.mkdtemp(path.join(dir, 'ok-'))
    const target = path.join(storeDir, 'store.json')
    const store = new JsonStore(target)
    await store.write({ incidents: [{ id: 'i1', title: 'x' }] })
    const data = await store.read(['incidents'])
    assert.equal(data.incidents.length, 1, 'the write did not land')
    assert.deepEqual(await tempFiles(storeDir), [],
      'a successful write left a temp file behind')
  })
})

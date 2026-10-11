import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { contentHash, vintageOf, createVintageIndex, EXPORT_COLLECTIONS } from '../src/vintage.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-vintage-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://127.0.0.1:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('dataset vintaging (CAP-04)', () => {
  it('hashes content, not bytes, so key order does not change the vintage', () => {
    // The ETag this replaces changed when a re-serialisation reordered keys —
    // a different identifier for the same dataset. A consumer comparing
    // vintages is asking "is this the same data", not "the same response".
    assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }))
    assert.equal(contentHash([{ x: 1, y: 2 }]), contentHash([{ y: 2, x: 1 }]))
    assert.notEqual(contentHash({ a: 1 }), contentHash({ a: '1' }), 'a stringified number is a different value')
    assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }))
  })

  it('is stable across two reads of the same records, whatever the write stamps say', () => {
    // The whole point: two reads an hour apart of unchanged data agree.
    const records = [{ id: 'r1', value: 5, updated_at: '2026-01-01T00:00:00Z' }]
    const first = vintageOf(records)
    const second = vintageOf([{ id: 'r1', value: 5, updated_at: '2026-10-11T00:00:00Z' }])
    assert.equal(first.vintage, second.vintage, 'a write stamp changed the vintage')
    assert.notEqual(first.generated_at, undefined)
  })

  it('changes when a record changes', () => {
    assert.notEqual(vintageOf([{ id: 'r1', value: 5 }]).vintage, vintageOf([{ id: 'r1', value: 6 }]).vintage)
  })

  it('states what the hash covers, so the identifier is verifiable', () => {
    const v = vintageOf([{ id: 'r1' }])
    assert.match(v.hashed_fields, /every field of every record except/)
    assert.equal(v.record_count, 1)
  })

  it('bounds the index and says when it dropped entries', () => {
    const index = createVintageIndex({ limit: 2 })
    index.record({ vintage: 'a', generated_at: '2026-10-11T00:00:00Z' })
    index.record({ vintage: 'b', generated_at: '2026-10-11T00:00:01Z' })
    index.record({ vintage: 'c', generated_at: '2026-10-11T00:00:02Z' })
    const list = index.list()
    assert.equal(list.returned, 2)
    assert.equal(list.dropped, 1)
    assert.match(list.note, /evicted/)
    assert.deepEqual(list.vintages.map((v) => v.vintage), ['c', 'b'])
  })

  it('counts repeat serves of one vintage rather than listing it twice', () => {
    const index = createVintageIndex()
    index.record({ vintage: 'a', generated_at: '2026-10-11T00:00:00Z' })
    index.record({ vintage: 'a', generated_at: '2026-10-11T00:00:05Z' })
    const list = index.list()
    assert.equal(list.returned, 1)
    assert.equal(list.vintages[0].served_count, 2)
  })

  it('serves the CSV export with a vintage header and a self-identifying filename', async () => {
    await withServer(async (base, store) => {
      await store.merge({ field_reports: [{ id: 'f1', district: 'Turkana', summary: 'Flooded road' }] })
      const res = await fetch(`${base}/api/v1/export.csv`)
      assert.equal(res.status, 200)
      const vintage = res.headers.get('x-lindela-vintage')
      assert.match(vintage, /^[0-9a-f]{64}$/, 'the vintage is not a content hash')
      assert.equal(res.headers.get('x-lindela-record-count'), '1')
      assert.match(res.headers.get('content-disposition'), new RegExp(vintage.slice(0, 12)), 'the filename does not name the vintage')
    })
  })

  it('gives two reads of unchanged data the same vintage over HTTP', async () => {
    await withServer(async (base, store) => {
      await store.merge({ field_reports: [{ id: 'f1', district: 'Turkana', summary: 'Flooded road' }] })
      const first = await fetch(`${base}/api/v1/export.csv`)
      const second = await fetch(`${base}/api/v1/export.csv`)
      assert.equal(first.headers.get('x-lindela-vintage'), second.headers.get('x-lindela-vintage'))
    })
  })

  it('refuses ?vintage= rather than accepting a parameter it cannot honour', async () => {
    await withServer(async (base, store) => {
      await store.merge({ field_reports: [{ id: 'f1', district: 'Turkana' }] })
      const res = await fetch(`${base}/api/v1/export.csv?vintage=${'0'.repeat(64)}`)
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /stores no snapshots/)
    })
  })

  it('lists the served vintages through the front door', async () => {
    await withServer(async (base, store) => {
      await store.merge({ field_reports: [{ id: 'f1', district: 'Turkana' }] })
      const exported = await fetch(`${base}/api/v1/export.csv`)
      const vintage = exported.headers.get('x-lindela-vintage')
      const res = await fetch(`${base}/api/v1/exports`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.vintages.some((v) => v.vintage === vintage), 'the served vintage is not in the manifest')
    })
  })

  it('does not claim a vintage on the streaming route, which cannot know its set', async () => {
    await withServer(async (base, store) => {
      await store.merge({ field_reports: [{ id: 'f1', district: 'Turkana' }] })
      const res = await fetch(`${base}/api/v1/export.ndjson`)
      assert.equal(res.status, 200)
      // A value computed from a partial read would name a dataset the caller
      // does not hold, so the header says it is unavailable instead.
      assert.match(res.headers.get('x-lindela-vintage'), /^unavailable:/)
      await res.text()
    })
  })

  it('declares the collections a vintage covers', () => {
    assert.ok(EXPORT_COLLECTIONS.includes('field_reports'))
    assert.ok(EXPORT_COLLECTIONS.includes('alert_events'))
    assert.equal(new Set(EXPORT_COLLECTIONS).size, EXPORT_COLLECTIONS.length, 'a collection is listed twice')
  })
})

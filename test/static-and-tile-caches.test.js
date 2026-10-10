#!/usr/bin/env node
/**
 * SCL-04 and SCL-06: two caches that were not caches.
 *
 * SCL-04  `sendFile` read, sha1-hashed and `gzipSync`-compressed every static
 *         asset on every request — including the conditional revalidations that
 *         were going to answer 304 and send none of it — and stamped
 *         `last-modified` with *now*, so `If-Modified-Since` could never match.
 * SCL-06  `terrain.js` held decoded elevation rasters in an uncapped Map for
 *         the life of the process, half a megabyte per tile.
 */

import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createServer, resetStaticCache, staticCacheStats } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { clearTileCache, elevationAtCacheInfo, loadTile } from '../src/terrain.js'

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-static-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('SCL-04 static assets are prepared once and revalidate honestly', () => {
  it('answers If-Modified-Since with 304 rather than the whole body', async () => {
    // `last-modified` was `new Date().toUTCString()` — now, on every response —
    // so a client that sent the value it was given asked "has this changed
    // since just now", was told yes, and re-downloaded the file. Only the ETag
    // path could ever 304.
    await withServer(async (base) => {
      const first = await fetch(`${base}/shared/app-version.js`)
      assert.equal(first.status, 200)
      const lastModified = first.headers.get('last-modified')
      assert.ok(lastModified, 'no last-modified header')
      await first.text()

      const revalidated = await fetch(`${base}/shared/app-version.js`, {
        headers: { 'if-modified-since': lastModified },
      })
      assert.equal(revalidated.status, 304, 'the server disowned the last-modified it had just sent')
      assert.equal(await revalidated.text(), '')
    })
  })

  it('sends a last-modified that is the file time, not the request time', async () => {
    // A static file's own mtime, read from disk. The bug wrote `new Date()` on
    // every response, so the header moved with the clock and told every client
    // the file had just changed.
    await withServer(async (base) => {
      const expected = new Date((await fs.stat(path.join(PUBLIC, 'shared/app-version.js'))).mtimeMs).toUTCString()
      const res = await fetch(`${base}/shared/app-version.js`)
      await res.text()
      assert.equal(res.headers.get('last-modified'), expected)
    })
  })

  it('compresses each asset once, not once per request', async () => {
    // `gzipSync` blocks the event loop. A page pulling twenty modules used to
    // serialise twenty compressions of bytes that had not changed since the
    // last release.
    resetStaticCache()
    await withServer(async (base) => {
      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${base}/shared/app-version.js`, { headers: { 'accept-encoding': 'gzip' } })
        await res.text()
      }
      const stats = staticCacheStats()
      assert.equal(stats.gzip_compressions, 1, `compressed ${stats.gzip_compressions} times for five requests`)
      assert.equal(stats.files_prepared, 1, `read and hashed the file ${stats.files_prepared} times`)
    })
  })

  it('re-prepares a file that changed on disk', async () => {
    // The cache is keyed on mtime and size, so a deploy that rewrites an asset
    // underneath a running process is picked up rather than served stale for
    // the lifetime of the process.
    resetStaticCache()
    await withServer(async (base) => {
      const first = await fetch(`${base}/shared/app-version.js`)
      const before = first.headers.get('etag')
      await first.text()
      const file = path.join(PUBLIC, 'shared/app-version.js')
      const original = await fs.readFile(file)
      try {
        await fs.writeFile(file, `${original.toString('utf8')}\n// cache-buster\n`)
        const after = await fetch(`${base}/shared/app-version.js`)
        await after.text()
        assert.notEqual(after.headers.get('etag'), before, 'the changed file kept its old ETag')
      } finally {
        await fs.writeFile(file, original)
      }
    })
  })

  it('still answers a matching If-None-Match with 304', async () => {
    await withServer(async (base) => {
      const first = await fetch(`${base}/shared/app-version.js`)
      const etag = first.headers.get('etag')
      await first.text()
      const second = await fetch(`${base}/shared/app-version.js`, { headers: { 'if-none-match': etag } })
      assert.equal(second.status, 304)
    })
  })

  it('serves the gzipped body a gzip client asked for, and the raw one otherwise', async () => {
    await withServer(async (base) => {
      const gz = await fetch(`${base}/shared/app-version.js`, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(gz.headers.get('content-encoding'), 'gzip')
      const decoded = await gz.text()
      const plain = await fetch(`${base}/shared/app-version.js`, { headers: { 'accept-encoding': 'identity' } })
      assert.equal(plain.headers.get('content-encoding'), null)
      assert.equal(await plain.text(), decoded, 'the cached gzip body does not decode to the file')
    })
  })
})

describe('SCL-06 the terrain tile cache is bounded', () => {
  /**
   * A 1×1 Terrarium PNG. The decoder wants a real PNG — signature, IHDR, IDAT,
   * IEND — so the fixture is built rather than faked; the cache does not care
   * what is in the raster, only that decoding it is the expensive step being
   * skipped.
   */
  const tilePng = (() => {
    const crcTable = (() => {
      const table = new Int32Array(256)
      for (let n = 0; n < 256; n += 1) {
        let c = n
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c
      }
      return table
    })()
    const crc32 = (buf) => {
      let c = 0xffffffff
      for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    }
    const chunk = (type, data) => {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(data.length)
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(body))
      return Buffer.concat([length, body, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(1, 0)   // width
    ihdr.writeUInt32BE(1, 4)   // height
    ihdr[8] = 8                // bit depth
    ihdr[9] = 2                // truecolour
    // Filter byte 0, then one RGB triple. Terrarium packs elevation as
    // r*256 + g + b/256 - 32768, so 500 m is r=129, g=244, b=0.
    const raw = Buffer.from([0, 129, 244, 0])
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  })()

  it('reports its own limit alongside its size', () => {
    const info = elevationAtCacheInfo()
    assert.equal(typeof info.tiles, 'number')
    assert.ok(Number.isInteger(info.limit) && info.limit > 0, 'the cache reports no bound')
  })

  it('serves a repeated tile from the cache without refetching', async () => {
    clearTileCache()
    let fetches = 0
    const fetchTile = async () => { fetches += 1; return tilePng }
    const first = await loadTile(1, 2, 10, { fetch: fetchTile })
    const second = await loadTile(1, 2, 10, { fetch: fetchTile })
    assert.equal(fetches, 1, 'the second load went back to the network')
    assert.equal(second, first, 'the second load did not return the cached object')
    assert.equal(first.grid[0], 500, `decoded ${first.grid[0]} m, expected 500`)
  })

  it('evicts rather than growing without limit', async () => {
    // 70 distinct tiles against a 64-entry cap: the size must stop at the cap.
    clearTileCache()
    const fetchTile = async () => tilePng
    for (let i = 0; i < 70; i += 1) await loadTile(i, 0, 10, { fetch: fetchTile })
    const info = elevationAtCacheInfo()
    assert.equal(info.tiles, info.limit, `${info.tiles} tiles held against a limit of ${info.limit}`)
  })

  it('evicts the least recently used, not the least recently fetched', async () => {
    clearTileCache()
    const fetchTile = async () => tilePng
    for (let i = 0; i < 64; i += 1) await loadTile(i, 0, 10, { fetch: fetchTile })
    // Touch tile 0, then push a new one in. A plain FIFO would drop tile 0.
    await loadTile(0, 0, 10, { fetch: fetchTile })
    await loadTile(999, 0, 10, { fetch: fetchTile })
    let refetches = 0
    const counting = async () => { refetches += 1; return tilePng }
    await loadTile(0, 0, 10, { fetch: counting })
    assert.equal(refetches, 0, 'the tile that was just used was evicted anyway')
  })
})

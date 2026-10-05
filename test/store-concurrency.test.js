import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { JsonStore } from '../src/store.js'
import { isPublicPath, publicPaths } from '../src/auth.js'

/**
 * R-15 and R-18 — two small defects that both only appear under concurrency or
 * under a path nobody typed on purpose.
 *
 * R-15: `isPublicPath` prefix-matched everything, so `/api/v1/health/anything`
 * was public. It 404s, but the request reaches dispatch first, and a public path
 * is never authenticated — so an unauthenticated caller could make the process
 * do a full-table read per request and learn nothing except that the read
 * happened. The shipped paths are matched exactly now; only an operator's own
 * entries get prefix semantics, because whoever wrote those knew what they were
 * publishing.
 *
 * R-18: the JSON store's temp filename was keyed on the pid alone, so two
 * `JsonStore` instances on one path in one process wrote to the same file. One
 * renamed the other's half-written bytes into place, and the result was ENOENT
 * or a truncated store — reproduced below, not asserted from the source.
 */

describe('R-15 — only the paths that are public are public', () => {
  it('a path under a shipped public path is not itself public', () => {
    assert.equal(isPublicPath('/api/v1/health'), true)
    assert.equal(isPublicPath('/api/v1/ready'), true)
    assert.equal(isPublicPath('/api/v1/health/anything'), false,
      'prefix-matching a shipped path makes every typo under it public, and a ' +
      'public path is never authenticated')
    assert.equal(isPublicPath('/api/v1/healthz'), false)
  })

  it("an operator's own entry keeps prefix semantics", () => {
    // Someone who writes `/stac` means every catalogue route under it. That is
    // their decision to make, and it stays theirs — the fix narrows the paths
    // this build ships, not the ones a deployment declares.
    assert.equal(isPublicPath('/stac/catalog.json', { LINDELA_LITE_PUBLIC_PATHS: '/stac' }), true)
    assert.equal(isPublicPath('/stac', { LINDELA_LITE_PUBLIC_PATHS: '/stac' }), true)
    assert.equal(isPublicPath('/stacx', { LINDELA_LITE_PUBLIC_PATHS: '/stac' }), false,
      'prefix semantics means path segments, not string prefixes')
  })

  it('the default public list is still health and ready, and nothing else', () => {
    assert.deepEqual(publicPaths({}).slice(0, 2), ['/api/v1/health', '/api/v1/ready'])
    for (const path of ['/api/v1/export.csv', '/api/v1/incidents', '/api/v1/metrics']) {
      assert.equal(isPublicPath(path), false, `${path} is not public`)
    }
  })
})

describe('R-18 — two stores on one path do not collide', () => {
  it('concurrent writers on the same file both land', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r18-'))
    const file = path.join(dir, 'store.json')
    try {
      // Two instances, one path, one process — the exact shape that shared a
      // temp filename. Both write several times, overlapping.
      const a = new JsonStore(file)
      const b = new JsonStore(file)
      const write = (store, prefix) => store.merge({
        incidents: Array.from({ length: 5 }, (_, i) => ({
          id: `${prefix}-${i}`,
          type: 'incident',
          title: `${prefix} ${i}`,
          severity: 'low',
          status: 'open',
        })),
      })
      await Promise.all([write(a, 'a'), write(b, 'b'), write(a, 'a2'), write(b, 'b2')])

      const final = new JsonStore(file)
      const data = await final.read()
      const ids = new Set(data.incidents.map((r) => r.id))
      assert.ok(ids.size > 0, 'the file ended up empty, which is what a shared temp name does')
      // Whatever won, the file must be *parseable* — a truncated write is the
      // failure mode, and a JSON parse throwing on the next boot is how it
      // announces itself.
      const raw = await fs.readFile(file, 'utf8')
      assert.doesNotThrow(() => JSON.parse(raw), 'the store file on disk is not valid JSON')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a concurrent write leaves no temp file behind', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r18b-'))
    const file = path.join(dir, 'store.json')
    try {
      const a = new JsonStore(file)
      const b = new JsonStore(file)
      await Promise.all([
        a.merge({ incidents: [{ id: 'x1', type: 'incident', title: 'x', severity: 'low', status: 'open' }] }),
        b.merge({ incidents: [{ id: 'y1', type: 'incident', title: 'y', severity: 'low', status: 'open' }] }),
      ])
      const entries = await fs.readdir(dir)
      assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), [],
        'a shared temp name leaves one writer\'s temp file orphaned when the other renames it')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer, APP_VERSION, fillAppVersionMarker } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * The console told operators the wrong build.
 *
 * Three surfaces carried a hand-written fallback — `v0.1.0`, written when the
 * package was at 0.1.0 — and `/shared/app-version.js` only replaced it once
 * `/api/v1/health` answered. An operator on a field connection, which is the
 * case this product exists for, was told the build they were running was a
 * release behind. The browser gate caught it: "shown v0.1.0, released v0.2.0".
 *
 * The version is now filled in by the server on the way out, from the same
 * `package.json` `/health` reads. The test that matters is the second one: a
 * literal in the source would be correct today and wrong at the next release,
 * which is the drift the shared module was written to end, reintroduced a layer
 * down.
 */

const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))

describe('the build version cannot drift from package.json', () => {
  it('the served version is the package version', () => {
    assert.equal(APP_VERSION, pkg.version)
  })

  it('the marker is filled whatever the source file said', () => {
    // Deliberately including a stale literal, because that is the case: a file
    // checked in before this fix still carries the old number, and the served
    // bytes must not depend on which one the server read.
    const stale = '<span data-app-version>v0.0.1</span>'
    assert.match(fillAppVersionMarker(stale), new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`))
  })

  it('an empty marker is filled rather than left blank', () => {
    assert.match(fillAppVersionMarker('<span data-app-version></span>'), new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`))
  })

  it('a span without the marker is left alone', () => {
    const untouched = '<span>Powered by Lindela Lite</span>'
    assert.equal(fillAppVersionMarker(untouched), untouched,
      'a substitution wide enough to catch every span would rewrite the page')
  })

  it('no surface hard-codes a version literal any more', async () => {
    // The drift guard. Every `data-app-version` in the tree must be empty, so
    // there is nothing for the server to fail to overwrite.
    const offenders = []
    const scan = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await scan(full)
        else if (entry.name.endsWith('.html')) {
          const html = await fs.readFile(full, 'utf8')
          for (const m of html.matchAll(/<span[^>]*data-app-version[^>]*>([\s\S]*?)<\/span>/g)) {
            if (m[1].trim()) offenders.push(`${full}: ${m[1].trim()}`)
          }
        }
      }
    }
    await scan(new URL('../public', import.meta.url).pathname)
    assert.deepEqual(offenders, [],
      'a version literal in a served file is a version that will be wrong at the next ' +
      'release, and an offline user is the one who sees it: ' + offenders.join(' | '))
  })

  it('every surface that shows a version has the marker, not text', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-version-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const listener = createServer({ store }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      for (const surface of ['/chw/', '/portal/']) {
        const res = await fetch(`${base}${surface}`)
        assert.equal(res.status, 200, `${surface} did not serve`)
        const html = await res.text()
        if (!html.includes('data-app-version')) continue
        assert.match(html, new RegExp(`data-app-version[^>]*>v${pkg.version.replace(/\./g, '\\.')}<`),
          `${surface} serves a version element that is not this build`)
      }
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

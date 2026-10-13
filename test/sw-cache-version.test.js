import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { fillCacheVersionMarker, fillAppVersionMarker } from '../src/server.js'

/**
 * R-66 — the service worker's cache name is derived from the release, not typed.
 *
 * `CACHE_NAME` was `'lindela-lite-v4'`, hand-maintained, and nothing validated
 * it against `package.json`. The comment above it says why that is load-bearing:
 * cache-first static assets are only safe while the name changes, so a deploy
 * that edits `app.js` without editing `sw.js` leaves the old worker installed
 * with no re-precache trigger. A fix ships and never reaches the operator who
 * already has the app open — and the mixed module set loads *silently* when the
 * exports happen to line up, which is the case that reads as "the fix did not
 * work" rather than as a caching bug.
 *
 * The server already injects the version into every HTML surface on the way out
 * (`fillAppVersionMarker`, for the same class of drift one layer up). This is
 * that mechanism applied to the worker.
 */

const ROOT = new URL('..', import.meta.url)
const SW = readFileSync(new URL('public/sw.js', ROOT), 'utf8')
const PKG = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'))

describe('R-66 — the service worker cache name tracks the release', () => {
  it('declares the cache name as a placeholder the server fills, not a literal', () => {
    // The source must not carry a version literal. If it does, the injection
    // below has nothing to replace and the name silently stops moving.
    assert.match(SW, /__CACHE_VERSION__/,
      'sw.js has no cache-version placeholder for the server to fill')
    assert.doesNotMatch(SW, /const CACHE_NAME = 'lindela-lite-v\d+'/,
      'sw.js still hardcodes a cache version, so a release cannot bump it')
  })

  it('fills the placeholder with the package version, so a release bumps the cache', () => {
    const filled = fillCacheVersionMarker(SW, PKG.version)
    assert.ok(filled.includes(`lindela-lite-v${PKG.version}`),
      `the cache name was not filled with the release version ${PKG.version}`)
    assert.ok(!filled.includes('__CACHE_VERSION__'),
      'a placeholder survived the fill, which the browser would treat as a literal name')
  })

  it('changes the cache name when the version changes — the property the row is about', () => {
    // The whole point: two releases must not share a cache name.
    const a = fillCacheVersionMarker(SW, '1.0.0')
    const b = fillCacheVersionMarker(SW, '1.0.1')
    assert.notEqual(a, b, 'two different releases produced the same worker bytes')
  })

  it('leaves the html version injection alone — the two markers are independent', () => {
    // `fillCacheVersionMarker` must not touch `data-app-version`, and
    // `fillAppVersionMarker` must not touch the cache placeholder; a shared
    // regex would couple two unrelated injections.
    const html = '<span data-app-version></span>'
    assert.equal(fillAppVersionMarker(html, '9.9.9'), '<span data-app-version>v9.9.9</span>')
    assert.equal(fillCacheVersionMarker(html, '9.9.9'), html,
      'the cache filler rewrote html it does not own')
    assert.ok(fillAppVersionMarker(SW, '9.9.9').includes('__CACHE_VERSION__'),
      'the html filler rewrote the worker it does not own')
  })
})

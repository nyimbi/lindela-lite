#!/usr/bin/env node
/**
 * R-67 — raw `fetch` is gone from the front end.
 *
 * `apiFetch` was written specifically to remove these call sites, and its own
 * comment records the exact failure they cause: a service-worker offline-miss
 * body parses fine as `json()`, so `await res.json()` returns a payload-shaped
 * object that was never the data, `res.ok` is never consulted, and a
 * disconnected console blanks a metric with no error anywhere. Seven call
 * sites across `app.js` and `co/app.js` survived it.
 *
 * The failure is silent by construction, which is why it needs a gate rather
 * than a review habit. A reviewer reading `const r = await fetch(url); const d
 * = await r.json()` sees ordinary code. What is missing — the `ok` check, the
 * timeout, the error path — is invisible on the line that is present.
 *
 * Two distinct defects hide behind the same grep, and the gate separates them
 * because they need different amounts of attention:
 *
 *   no `res.ok` check   the response shape is trusted unconditionally, so a 500
 *                       with a JSON error body renders as data.
 *   no timeout          a request that never settles. This is the one that bites
 *                       on a field connection, and it is invisible in review
 *                       because nothing about the line looks wrong.
 *
 * `/i18n/*.json` is deliberately exempt: those are static catalogue files served
 * by the same origin with no auth and no partial-response semantics, and every
 * call site already handles a non-ok response by keeping the English layer.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** Source with comments stripped; these files document the strings they forbid. */
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/**
 * Every front-end module. Enumerated by walking `public/`, so a new surface
 * added tomorrow is checked tomorrow without editing this file — which is the
 * whole point, given that "somebody remembered" is how seven call sites
 * survived a helper written to remove them.
 */
function frontEndModules(dir = PUBLIC, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'sw.js') continue                       // the worker's own scope
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) { frontEndModules(full, acc); continue }
    if (entry.endsWith('.js')) acc.push(path.relative(ROOT, full))
  }
  return acc
}

/**
 * `apiFetch` is the wrapper. Its own `fetch` call is the one legitimate use of
 * the global in this codebase — banning it would ban the fix — so the module
 * that defines it is excluded from the scan and asserted on directly below.
 */
/**
 * Is the fetch at `line` inside the body of `functionName`?
 *
 * Found by scanning to the next line that is exactly `}` at column zero, which
 * is how every top-level function in this codebase ends. That is a
 * convention rather than a guarantee, so it is stated here rather than
 * pretended at: it is correct for the file it is asked about, and the
 * alternative — brace-counting — is worse, because a single template literal
 * containing a brace silently ends the count early and the helper then returns
 * false forever, exempting nothing while appearing to work.
 *
 * Scoped to one named function rather than matched on a path, because the
 * deferred panel's path arrives as a variable: `fetch(url)` where `url` came
 * from DEFERRED_PANELS. Matching the string would either miss it, or exempt
 * every call using a variable called `url`, which is not an exemption anyone
 * can reason about.
 *
 * `src` must be the same comment-stripped text the fetch scan ran against, so
 * the two line numbering schemes agree.
 */
function inFunction(lines, line, functionName) {
  const decl = new RegExp(`^(?:async\\s+)?function\\s+${functionName}\\s*\\(`)
  const start = lines.findIndex((l) => decl.test(l))
  if (start === -1) return false
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return line > start + 1 && line < i + 1
  }
  return false
}

const WRAPPER_MODULE = path.join('public', 'shared', 'runtime.js')

const MODULES = frontEndModules().filter((m) => m !== WRAPPER_MODULE)

/** A call to `fetch(` that is not one of the sanctioned wrappers. */
function rawApiFetches(src) {
  const out = []
  let offset = 0
  src.split('\n').forEach((line, i) => {
    const m = /\bfetch\s*\(/.exec(line)
    if (!m) { offset += line.length + 1; return }
    // A call with a `.` before it is a method on some object, not global fetch.
    if (/\.\s*fetch\s*\(/.test(line)) { offset += line.length + 1; return }
    out.push({ line: i + 1, offset: offset + m.index, text: line.trim() })
  })
  return out
}

describe('R-67 — no front-end module calls the global fetch on an API path', () => {
  it('the scan found the modules it is meant to scan', () => {
    // A guard against the walk silently returning nothing — e.g. if the path
    // resolution broke, every assertion below would pass vacuously.
    assert.ok(MODULES.length >= 25,
      `expected the front-end module walk to find the surfaces; found ${MODULES.length}`)
    assert.ok(MODULES.includes(path.join('public', 'app.js')))
    assert.ok(MODULES.includes(path.join('public', 'co', 'app.js')))
  })

  const offenders = []
  for (const rel of MODULES) {
    const src = code(rel)
    for (const hit of rawApiFetches(src)) {
      // The i18n catalogues are exempt by design; see the header.
      if (/\/i18n\/|\/i18n\$\{|\/i18n['"`]/.test(hit.text)) continue
      // A deferred template — a rail panel's or the determination dialog's —
      // fetched by the one loader both share. Same
      // category as the catalogues: a static same-origin file with no
      // partial-response semantics and no auth. It checks `res.ok` and renders
      // a named failure, so `apiFetch` would add a bearer token and a JSON
      // parse to a request that wants neither.
      //
      // Scoped to the one function rather than matched on a path, because the
      // path arrives as a variable — `fetch(url)` where `url` came from
      // DEFERRED_PANELS. Matching on the string would either miss it or match
      // any call using a variable named `url`, which is not an exemption
      // anyone can reason about.
      // `loadTemplate` is the shared loader; `mountPanel` is named for the case
      // where a raw fetch is reintroduced inside it rather than routed through
      // it. Both are template fetches, and neither is an API call.
      if (inFunction(src.split('\n'), hit.line, 'loadTemplate')) continue
      if (inFunction(src.split('\n'), hit.line, 'mountPanel')) continue
      offenders.push(`${rel}:${hit.line}: ${hit.text}`)
    }
  }

  it('zero global fetch calls outside the locale catalogues', () => {
    assert.deepEqual(offenders, [],
      'these call sites bypass apiFetch, so they have no ok check and no timeout; ' +
      'route them through apiFetch, or apiSettled where one dead endpoint must ' +
      'not blank the others')
  })
})

describe('R-67 — the sanctioned wrappers are actually used', () => {
  it('app.js imports apiSettled for the per-endpoint status bar read', () => {
    // Settled-per-endpoint rather than `Promise.all` on raw fetch: a dead
    // /events must not blank the /dispatches metric, because they are two
    // independent facts about one question.
    assert.match(read('public/app.js'), /import\s*\{[^}]*apiSettled[^}]*\}\s*from\s*['"]\/shared\/runtime\.js['"]/,
      'the console must import apiSettled')
  })

  it('co/app.js imports apiSettled for its five dashboard endpoints', () => {
    // These had `res.ok` checks but no timeout: on a weak link a hung request
    // never settles, so `failed` never increments and the dashboard sits on
    // "Checking the figures" indefinitely.
    assert.match(read('public/co/app.js'), /import\s*\{[^}]*apiSettled[^}]*\}\s*from/,
      'the donor dashboard must import apiSettled')
  })

  it('every dashboard endpoint in co/ goes through the settled wrapper', () => {
    const src = code('public/co/app.js')
    const settled = (src.match(/apiSettled\(/g) || []).length
    // Five endpoints: quarterly KPI, equity, dispatches, feedback, trend.
    assert.ok(settled >= 5,
      `expected the five dashboard endpoints to use apiSettled; found ${settled}`)
  })

  it('the console write path reports its own failure', () => {
    // An import with no timeout and no catch left the status line reading
    // "Importing service assets as GEOJSON…" for the life of the page —
    // promising work still in progress that had already been abandoned.
    //
    // Read from the ingestion module rather than app.js: the import path moved
    // there with the rest of that panel's behaviour, and a guard that reads a
    // file the code no longer lives in reports a pass while checking nothing.
    const src = code('public/panels/ingestion.js')
    const fn = /async function importServiceAssets[\s\S]*?\n\}/.exec(src)?.[0]
    assert.ok(fn, 'importServiceAssets exists')
    assert.match(fn, /apiFetch\(/, 'the import must go through apiFetch')
    assert.match(fn, /catch\s*\(/, 'the import must handle its own failure')
    assert.doesNotMatch(fn, /\bfetch\(/, 'no raw fetch may survive in the import path')
  })
})

describe('R-67 — the wrapper it routes through is the one that does the work', () => {
  const runtime = read('public/shared/runtime.js')

  it('exactly one module is allowed to call the global fetch', () => {
    // The exemption above is a hole with a known width. Pinning the width means
    // a second exemption cannot be added quietly: this counts the wrappers,
    // rather than trusting the exclusion list to stay at one entry.
    const wrappers = MODULES.concat([WRAPPER_MODULE]).filter((m) => {
      const src = code(m)
      const lines = src.split('\n')
      // Same two exemptions as the scan above, or this would count the very
      // fetches the scan allows and report the wrapper's exemption as a
      // second one.
      return rawApiFetches(src).some((h) =>
        !/\/i18n\//.test(h.text)
        && !inFunction(lines, h.line, 'loadTemplate')
        && !inFunction(lines, h.line, 'mountPanel'))
    })
    assert.deepEqual(wrappers, [WRAPPER_MODULE],
      'only the module that defines apiFetch may call the global fetch')
  })

  it('apiFetch checks res.ok and attaches the status', () => {
    // The test asserts on the wrapper's own behaviour, because the seven call
    // sites it replaces are only safe if this holds. A future refactor that
    // drops the ok check would silently re-open every migrated call site.
    assert.match(runtime, /if \(!res\.ok\)/, 'apiFetch must check res.ok')
    assert.match(runtime, /err\.status\s*=\s*res\.status/, 'and carry the status on the error')
  })

  it('apiFetch has a default timeout', () => {
    assert.match(runtime, /REQUEST_TIMEOUT_MS/,
      'apiFetch needs a default timeout, or migrating a call site fixes nothing')
  })

  it('apiSettled returns null rather than throwing, and callers handle null', () => {
    // This is the trap the co/ migration walks into: `apiSettled` resolves to
    // `null` on failure, so `res.ok` no longer exists and `res.data` throws.
    // Assert the null is handled where it is consumed.
    assert.match(runtime, /export async function apiSettled[\s\S]*?return null/,
      'apiSettled resolves to null on failure')
    const co = code('public/co/app.js')
    assert.doesNotMatch(co, /if \(\w+Res\.ok\)/,
      'co/ still branches on .ok; apiSettled returns a payload or null, not a Response')
    const console_ = code('public/app.js')
    assert.doesNotMatch(console_, /eventsRes\.json|dispatchesRes\.json/,
      'the console must consume apiSettled results directly, not call .json() on them')
  })
})
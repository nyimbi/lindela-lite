#!/usr/bin/env node
/**
 * R-65 / ENH-41 — the precache graph reaches the lazy graph, and stays told.
 *
 * This replaces `test/web-precache-report.test.js`, which measured the defect
 * and passed *while it was live*: it asserted that `REFERENCE_PATTERNS` could
 * not match a `lazy()` call, so the day the patterns landed the report had to be
 * retired. The measurement is now the thing that is asserted — the shipped
 * traversal reaches every deferred module — which fails the other way round,
 * and fails the way a defect should.
 *
 * The first version of this file was the report with the sign flipped, and it
 * passed against code that had not changed. So:
 *
 *   - it drives the real exported `shellGraph`, not a reimplementation of it
 *     (a test that derives its expectation from its own regex cannot fail);
 *   - it checks the bootstrap list against the files actually on disk, so a
 *     catalogue or a panel added later fails here rather than at 3am on a
 *     device that has no network.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

function allFiles(dir = PUBLIC, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) allFiles(full, acc)
    else acc.push(full)
  }
  return acc
}

const JS = allFiles().filter((f) => f.endsWith('.js') && !f.endsWith('sw.js'))

/** Every `lazy('/x.js')` and `import('/x.js')` target in the front end. */
function deferredTargets() {
  const targets = new Set()
  for (const file of JS) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/\blazy\s*\(\s*[`'"]([^`'"]+)[`'"']/g)) targets.add(m[1])
    for (const m of text.matchAll(/\bimport\s*\(\s*[`'"]([^`'"]+)[`'"']/g)) targets.add(m[1])
  }
  return targets
}

/** The shipped traversal, run over this repo's public tree. */
async function reach() {
  const { shellGraph } = await import(new URL('../public/sw.js', import.meta.url))
  const load = async (url) => {
    const rel = decodeURIComponent(url.pathname.replace(/^\//, ''))
    try {
      const text = readFileSync(path.join(PUBLIC, rel), 'utf8')
      return { ok: true, clone() { return this }, text: async () => text }
    } catch {
      return { ok: false }
    }
  }
  return new Set(await shellGraph(load, 'http://lindela.test/'))
}

describe('R-65 — every deferred module is precached', () => {
  it('the console does defer modules, so this is a real claim', () => {
    const targets = deferredTargets()
    assert.ok(targets.size >= 10,
      `expected the console to defer a dozen modules; found ${targets.size}`)
  })

  it('the shipped traversal reaches every one of them', async () => {
    const reached = await reach()
    const missing = [...deferredTargets()].filter((t) => !reached.has(t))
    assert.deepEqual(missing, [],
      'the precache cannot see ' + missing.length + ' deferred module(s): ' +
      missing.join(', ') + '. workflow/panel.js is the offline drill-down — the ' +
      'feature a field user is most likely to need when there is no connection.')
  })

  it('the comment-tolerant dynamic import is matched, not just the bare one', async () => {
    // `import(/* chunk */ '/x.js')` is ordinary bundler output. A pattern that
    // fixes the bare form and misses this one would pass the assertion above
    // while leaving the next one broken, so it is checked on its own.
    const { parseReferences } = await import(new URL('../public/sw.js', import.meta.url))
    const found = parseReferences("await import(/* wire-up */ '/workflow/panel.js')", 'https://lindela.test/app.js')
    assert.ok(found.includes('/workflow/panel.js'),
      'a bundler comment between the paren and the path must not hide the import; ' +
      'found ' + JSON.stringify(found))
  })

  it('prose mentioning import() yields no path', async () => {
    // The comment-tolerant pattern's own trap, live for one commit before this
    // test existed. `[\s\S]*?\*\/` between the paren and the quote matches
    // across prose: sw.js's own comment mentioning `import()` produced a "path"
    // running through the middle of a sentence. The pattern is now
    // `([^*]|\*(?!/))*`, which cannot leave the comment.
    const { parseReferences } = await import(new URL('../public/sw.js', import.meta.url))
    const prose = [
      '// the closure stopped where the code stopped being static:',
      '// modules load through `lazy()` and `import()` — including',
      "// workflow/panel.js — so no pattern may read a path out of here.",
    ].join('\n')
    const found = parseReferences(prose, 'https://lindela.test/app.js')
    assert.deepEqual(found, [],
      'prose mentioning import() produced precache entries: ' + JSON.stringify(found))
  })

  it('a path read out of a string literal never reaches the precache list', async () => {
    // The scanner reads text, not tokens, so a real false positive is possible:
    // `ingest-gates.js` has a confirmation label ending "…and import", and the
    // import-from pattern reads the rest of the sentence as a module path. It
    // only became visible when the closure reached that file for the first time
    // — the deferred-module fix, not the scanner, is what surfaced it.
    //
    // The defence is not a parser: it is that a reference is admitted only once
    // it has loaded. A phantom 404s, and a 404 in the precache list fails the
    // whole install, taking the offline capability down with it.
    const reached = await reach()
    const phantom = [...reached].filter((p) => p.includes('%20') || p.includes('%7B'))
    assert.deepEqual(phantom, [],
      'a path with percent-encoding came from prose, not from a file: ' + phantom.join(', '))
  })
})

describe('the bootstrap list matches the files that exist', () => {
  it('every shipped locale is registered', async () => {
    const { BOOTSTRAP_ASSETS } = await import(new URL('../public/sw.js', import.meta.url))
    const onDisk = readdirSync(path.join(PUBLIC, 'i18n'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => `/i18n/${f}`)
    const missing = onDisk.filter((p) => !BOOTSTRAP_ASSETS.includes(p))
    assert.deepEqual(missing, [],
      'these catalogues exist and are not precached: ' + missing.join(', ') +
      '. They are fetched by string construction, so no pattern can reach them, ' +
      'and a locale switch offline is the one thing the offer list promises.')
  })

  it('every deferred panel is registered', async () => {
    const { BOOTSTRAP_ASSETS } = await import(new URL('../public/sw.js', import.meta.url))
    const onDisk = readdirSync(path.join(PUBLIC, 'panels'))
      .filter((f) => f.endsWith('.html'))
      .map((f) => `/panels/${f}`)
    const missing = onDisk.filter((p) => !BOOTSTRAP_ASSETS.includes(p))
    assert.deepEqual(missing, [],
      'these panels exist and are not precached: ' + missing.join(', ') +
      '. A deferred panel that is not precached is a tab that fails exactly when ' +
      'it is opened without a connection.')
  })

  it('nothing in the list points at a file that does not exist', async () => {
    const { BOOTSTRAP_ASSETS } = await import(new URL('../public/sw.js', import.meta.url))
    // The other direction: a stale entry fails the install itself, so a typo
    // here takes the whole offline capability down rather than one tab.
    const absent = BOOTSTRAP_ASSETS.filter((p) => !statSync(path.join(PUBLIC, p), { throwIfNoEntry: false }))
    assert.deepEqual(absent, [],
      'BOOTSTRAP_ASSETS lists files that are not on disk: ' + absent.join(', '))
  })
})

describe('the oracle does not re-derive the answer it is checking', () => {
  it('the precache assertions call shellGraph rather than their own regex', () => {
    // How the original oracle stopped being able to fail: it scanned `from "…"`
    // literals — the same shape REFERENCE_PATTERNS matched — so it computed the
    // same answer as the code it was checking and agreed with it. The file
    // above imports `shellGraph` instead, and this assertion keeps it that way.
    const oracle = read('test/sw-bootstrap-assets.test.js')
    assert.match(oracle, /import\(new URL\('\.\.\/public\/sw\.js'/,
      'the guard must drive the shipped traversal')
    const other = read('test/web-chw-offline.test.js')
    assert.doesNotMatch(other, /for?\s*\(.*\)\s*\{\s*const\s+m\s*=\s*text\.matchAll\(\s*\/\^\[\\s;\}\]\(\?:import\|export\)/,
      'the oracle appears to re-derive the reference set from its own regex rather than ' +
      'calling shellGraph, which is how it agreed with the broken traversal')
  })
})

describe('a comment is not a reference', () => {
  // Found by `scripts/check-offline-roundtrip.mjs`: with the server genuinely
  // stopped, the cold start served the browser's error page. The worker's
  // precache had thirty-odd entries whose paths were sentences out of this
  // repository's own comments — `/,%20and%20the%20import-from%20pattern…` —
  // because `parseReferences` scanned source text without stripping comments.
  // Each one was fetched at install, install was slow enough that the worker
  // sometimes never activated, and an unactivated worker cannot answer a
  // navigation.
  const load = async () => ({
    ok: true,
    clone() { return this },
    text: async () => [
      '/**',
      ' * Dynamic import is handled by the import(...) pattern below.',
      ' * A comment about `import("some prose")` is not a reference.',
      ' */',
      'import real from "/real.js"',
      '// import commented from "/commented.js"',
      'const u = "https://example.com/not-a-reference.js"',
    ].join('\n'),
  })

  it('reads the import and ignores both kinds of comment', async () => {
    const { shellGraph } = await import(new URL('../public/sw.js', import.meta.url))
    const reached = await shellGraph(load, 'http://lindela.test/')
    assert.ok(reached.includes('/real.js'), 'the real import must still be found')
    assert.ok(!reached.includes('/commented.js'),
      'a line comment describing an import is not an import')
  })

  it('no reference in the closure looks like prose', async () => {
    const { shellGraph } = await import(new URL('../public/sw.js', import.meta.url))
    const reached = await shellGraph(load, 'http://lindela.test/')
    const prose = reached.filter((p) => /\s|%[0-9A-Fa-f]{2}/.test(p))
    assert.deepEqual(prose, [],
      'a precache entry built from a sentence is a request for a document that does not exist')
  })

  it('the shipped closure carries no prose either', async () => {
    // The regression guard for the shipped assets, not a fixture: a new comment
    // that reads like an import would otherwise be cached silently.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const PUBLIC = path.join(import.meta.dirname, '..', 'public')
    const realLoad = async (url) => {
      const rel = decodeURIComponent(url.pathname.replace(/^\//, ''))
      try {
        const text = fs.readFileSync(path.join(PUBLIC, rel), 'utf8')
        return { ok: true, clone() { return this }, text: async () => text }
      } catch {
        return { ok: false }
      }
    }
    const { shellGraph } = await import(new URL('../public/sw.js', import.meta.url))
    const reached = await shellGraph(realLoad, 'http://lindela.test/')
    const prose = reached.filter((p) => /\s|%[0-9A-Fa-f]{2}/.test(p))
    assert.deepEqual(prose, [], 'the shipped closure has entries that are sentences: ' + prose.join(' | '))
    assert.ok(reached.length > 40, `the closure shrank to ${reached.length} paths; the parser is probably no longer reading real references`)
  })
})

describe('a claim about the server is never answered from a cache', () => {
  // Found by scripts/check-offline-roundtrip.mjs, with the server genuinely
  // stopped: `fetch('/api/v1/health')` returned **200** — a copy taken before it
  // died. Every other response in the API cache is data a surface can label as
  // stale; these three are statements, and a statement served from cache is a
  // lie told to whoever is deciding whether to trust the deployment.
  it('the never-cached list is the claims, not the data', async () => {
    const { NEVER_CACHED, isNeverCached } = await import(new URL('../public/sw.js', import.meta.url))
    for (const path of ['/api/v1/health', '/api/v1/ready', '/api/v1/auth-info']) {
      assert.ok(isNeverCached(path), `${path} answers a question only the server can answer`)
    }
    for (const path of ['/api/v1/incidents', '/api/v1/field-reports', '/index.html', '/shared/runtime.js']) {
      assert.equal(isNeverCached(path), false, `${path} is data or an asset, and caching it is the point`)
    }
    assert.ok(NEVER_CACHED.length >= 3)
  })

  it('classifyApiRequest refuses them, so no bucket claims them', async () => {
    const { classifyApiRequest } = await import(new URL('../public/sw.js', import.meta.url))
    for (const path of ['/api/v1/health', '/api/v1/ready', '/api/v1/auth-info']) {
      assert.equal(classifyApiRequest(path), null,
        `${path} must not be routed into an API cache bucket`)
    }
    assert.ok(classifyApiRequest('/api/v1/incidents'), 'ordinary data is still cached')
  })

  it('and the fetch handler sends them to the network without storing the answer', async () => {
    // The exclusion alone was not enough: the paths then fell through to the
    // static branch, whose job is to cache what it fetches, and the first online
    // visit wrote a copy of "healthy" into the shell cache.
    const src = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
    const handler = src.slice(src.indexOf("addEventListener('fetch'"), src.indexOf('addEventListener(\'sync\''))
    assert.match(handler, /if \(isNeverCached\(url\.pathname\)\)/,
      'the never-cached paths need their own branch, or they land in the cache-first one')
    const branch = handler.slice(handler.indexOf('isNeverCached(url.pathname)'))
    assert.doesNotMatch(branch.slice(0, branch.indexOf('return')), /cache\.put|caches\.open/,
      'the never-cached branch must not write the answer it fetched')
  })
})

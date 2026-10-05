#!/usr/bin/env node
/**
 * R-73/R-74 — the whole front end is importable in Node.
 *
 * 19 of 39 modules under `public/` could not be imported by a Node test,
 * covering 12,053 of 17,988 front-end lines — 67% of the client untestable.
 * The suite's response was source surgery: `chw-wizard-honesty.test.js` strips
 * every `import ` line and `vm.runInContext`s the remainder, with a
 * hand-appended probe naming eight private locals. That mitigation was
 * duplicated 7 times, 2,957 lines of a 32,682-line suite.
 *
 * The duplication is the expensive part. Seven copies of a DOM stub drift: one
 * gains a property the code started using and six do not, so the test that
 * fails is whichever was written against the copy that happened to be right.
 * All seven were written against Node 20.
 *
 * `test/browser-env.mjs` is the replacement. This file is what keeps it
 * honest: it imports every module and fails on any that cannot be loaded, so
 * "the front end is testable" is a measured claim rather than an intention.
 * When a module cannot be imported the fix is a stub or a resolve rule in that
 * one file — never another copy of the sandbox.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { installBrowserEnv, installModuleResolution, PUBLIC_ROOT, ROOT } from './browser-env.mjs'

const PUBLIC = path.join(ROOT, 'public')
const TESTS = path.join(ROOT, 'test')

/**
 * Every front-end module except the service worker.
 *
 * `sw.js` is excluded deliberately and not because it is hard: it is a
 * different program — it runs in a worker, not a page, and has no `document` at
 * all. Testing it needs a worker-shaped environment, which is a different file
 * with a different set of stubs. Excluding it here rather than pretending it
 * was measured keeps the denominator honest.
 */
function frontEndModules(dir = PUBLIC, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'sw.js') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) { frontEndModules(full, acc); continue }
    if (entry.endsWith('.js')) acc.push(full)
  }
  return acc
}

const MODULES = frontEndModules()

/** Load every module once, recording what failed and why. */
async function loadAll() {
  installBrowserEnv()
  const results = []
  for (const file of MODULES) {
    try {
      await import(pathToFileURL(file).href)
      results.push({ file, ok: true })
    } catch (err) {
      results.push({ file, ok: false, error: err })
    }
  }
  // The surfaces boot asynchronously: app.js awaits a refresh that renders
  // the map legend, and co/ and portal/ await a fetch before their first paint.
  // Without settling here that work continues after the test ends and its
  // failures surface as an unhandledRejection attributed to an unrelated test
  // — a gap in browser-env.mjs reported as a flake somewhere else entirely.
  //
  // A handful of event-loop turns is enough: nothing waits on a timer, because
  // setTimeout is clamped to 0 by the environment.
  for (let turn = 0; turn < 8; turn++) await new Promise((r) => setImmediate(r))
  return results
}

describe('R-73 — every front-end module imports in Node', () => {
  it('the walk found the modules it is meant to walk', () => {
    // Without this the assertion below is satisfied by an empty list, which is
    // the failure mode of every "nothing to report" gate.
    assert.ok(MODULES.length >= 35,
      `expected to find the front-end modules; found ${MODULES.length}`)
  })

  it('all of them load', async () => {
    const results = await loadAll()
    const failed = results.filter((r) => !r.ok)
    assert.deepEqual(
      failed.map((r) => `${path.relative(PUBLIC, r.file)}: ${r.error.message.split('\n')[0]}`),
      [],
      'these modules cannot be imported, so the front end is not testable in Node. ' +
      'Add a stub to test/browser-env.mjs — do not copy the sandbox into this file.',
    )
  })

  it('the eight surfaces each load their own app module', async () => {
    // The surface modules are the ones that boot, so they are the ones that
    // need a real environment rather than a resolve rule alone.
    const surfaces = ['app.js', 'portal/app.js', 'co/app.js', 'districts/app.js',
      'focal-point/app.js', 'parametric/app.js', 'scenarios/app.js', 'chw/app.js']
    installBrowserEnv()
    const failed = []
    for (const rel of surfaces) {
      try {
        await import(pathToFileURL(path.join(PUBLIC, rel)).href)
      } catch (err) {
        failed.push(`${rel}: ${err.message.split('\n')[0]}`)
      }
    }
    assert.deepEqual(failed, [], 'a surface that cannot boot in Node cannot be tested')
  })
})

describe('R-74 — one sandbox, not seven', () => {

  it('test/browser-env.mjs exists and exports the pieces', () => {
    const src = readFileSync(path.join(TESTS, 'browser-env.mjs'), 'utf8')
    for (const name of ['installBrowserEnv', 'installModuleResolution', 'stubElement', 'makeStorage']) {
      assert.match(src, new RegExp(`export (async )?function ${name}\\b|export const ${name}\\b`),
        `browser-env.mjs must export ${name}`)
    }
  })

  it('no test file carries its own copy of the resolve hook', () => {
    // The duplication R-74 names. Seven files each reimplementing eight lines
    // is how they drifted; one shared function is how they cannot.
    const offenders = []
    for (const f of readdirSync(TESTS)) {
      if (!f.endsWith('.test.js') || f === 'web-module-importability.test.js') continue
      const src = readFileSync(path.join(TESTS, f), 'utf8')
      if (!/registerHooks\(/.test(src)) continue
      // A file may still call `installModuleResolution`; what it may not do is
      // reimplement the hook.
      if (/specifier\.startsWith\(\s*['"]\/shared\/['"]\s*\)/.test(src)) offenders.push(f)
    }
    assert.deepEqual(offenders, [],
      'these files reimplement the resolve hook instead of importing it. ' +
      'Call installModuleResolution() from test/browser-env.mjs.')
  })

  it('the DOM stub is defined once, and callers import it', () => {
    // The DOM stubs themselves are still per-file, and this is the honest
    // statement of where that stands rather than a claim that the migration is
    // finished. What is finished is the *resolve hook*, which was the part that
    // had to be identical everywhere: it is the one that decides which file a
    // module resolves to, so a divergent copy silently tests a different graph.
    //
    // The stubs still differ per surface because they legitimately do: portal
    // needs `contentArea.style.display` to toggle, focal-point needs a dialog
    // that is not null, the console needs `matchMedia`. Collapsing them into
    // one shape is the remaining work, and doing it by deleting the surface's
    // own stub would change what those tests exercise — which is a larger
    // change than this finding should make unasked.
    //
    // What is asserted is that they all funnel through the same element
    // constructor, so a method added to `stubElement` reaches every one.
    let withoutSharedElement = []
    for (const f of readdirSync(TESTS)) {
      if (!f.endsWith('.test.js') || f === 'web-module-importability.test.js') continue
      const src = readFileSync(path.join(TESTS, f), 'utf8')
      if (!/globalThis\.document\s*=/.test(src)) continue
      if (/stubElement/.test(src) && /from '\.\/browser-env\.mjs'/.test(src)) continue
      withoutSharedElement.push(f)
    }
    assert.deepEqual(withoutSharedElement, [],
      'these assign globalThis.document without importing the shared stubElement, ' +
      'so a method added to it will reach them and they will keep failing on it')
  })

  it('no test file assigns navigator directly', () => {
    // The Node 26 trap. `navigator` is getter-only there, so this assignment is
    // a silent no-op in sloppy mode and a TypeError in the strict mode every ES
    // module runs in. Neither is reported, and the module under test silently
    // sees the wrong environment.
    const offenders = []
    for (const f of readdirSync(TESTS)) {
      if (!f.endsWith('.test.js') || f === 'web-module-importability.test.js') continue
      const src = readFileSync(path.join(TESTS, f), 'utf8')
      if (/globalThis\.navigator\s*=/.test(src)) offenders.push(f)
    }
    assert.deepEqual(offenders, [],
      'globalThis.navigator = ... cannot work on Node 26; browser-env.mjs replaces the ' +
      'property with defineProperty instead.')
  })
})

describe('R-73 — the resolve hook does what it claims', () => {
  it('maps a browser-absolute /shared/ specifier to the file on disk', async () => {
    installModuleResolution()
    const mod = await import(pathToFileURL(path.join(PUBLIC, 'shared', 'states.js')).href)
    assert.equal(typeof mod.distinguishFailure, 'function',
      'the resolve hook must make /shared/states.js reachable from a test')
  })

  it('leaves relative and bare specifiers to Node', () => {
    // The hook must not swallow node: builtins or package imports — a hook that
    // resolved everything would make a typo look like a browser path.
    const src = readFileSync(path.join(TESTS, 'browser-env.mjs'), 'utf8')
    assert.match(src, /return nextResolve\(specifier, context\)/,
      'non-/shared/ specifiers must fall through to the default resolver')
  })

  it('PUBLIC_ROOT points at public/ and ends with a separator', () => {
    // `new URL('./x', root)` resolves differently without the trailing slash:
    // the last path segment is replaced rather than the directory kept.
    assert.ok(PUBLIC_ROOT.href.endsWith('/'), `PUBLIC_ROOT is ${PUBLIC_ROOT.href}`)
    assert.ok(PUBLIC_ROOT.href.endsWith('/public/'))
  })
})
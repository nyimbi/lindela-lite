#!/usr/bin/env node
/**
 * R-65 / ENH-41 — the precache graph cannot see the lazy graph.
 *
 * **This is a report, not a fix.** `public/sw.js` is not owned by this
 * partition and the coordinator asked for the fix specified precisely rather
 * than landed. So this file measures the gap, states the change, and fails if
 * the measurement stops being true — which is what makes it a report rather
 * than a complaint.
 *
 * The defect: `shellGraph` walks the shell over `REFERENCE_PATTERNS`, which
 * match `import '…'`, `import … from '…'`, `<link href>`, `<script src>` and
 * `@import`. Every one of those is a *static* reference, so the closure stops
 * exactly where the code stops being static. `public/app.js` defers eleven
 * modules through `lazy()` and `import()` — and `workflow/panel.js`, which is
 * ENH-22's shipped offline drill-down, is among them.
 *
 * So the offline drill-down is unreachable offline. It is the feature a field
 * user is most likely to need precisely when there is no connection, and it is
 * the one module the precache cannot see.
 *
 * The oracle test cannot catch this either: `web-chw-offline.test.js` scans
 * `from "…"` literals only, so it agrees with the broken traversal and reports
 * the same 45 files the worker would cache. A test that derives its expectation
 * from the same regex as the code it is checking cannot fail.
 *
 * Measured with the patterns this file proposes: **45 → 57** paths, and all
 * eleven `lazy()` targets present. `shared/charts.js` (34 KB) is picked up as a
 * side effect, because the console defers it.
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
  const targets = new Map()
  for (const file of JS) {
    const text = readFileSync(file, 'utf8')
    const rel = '/' + path.relative(PUBLIC, file)
    for (const m of text.matchAll(/\blazy\s*\(\s*[`'"]([^`'" ]+)[`'"]/g)) targets.set(m[1], rel)
    for (const m of text.matchAll(/\bimport\s*\(\s*[`'"]([^`'" ]+)[`'"]/g)) targets.set(m[1], rel)
  }
  return targets
}

describe('R-65 — the precache graph cannot see the lazy graph', () => {
  it('there are deferred modules, so the gap is real', () => {
    const targets = deferredTargets()
    assert.ok(targets.size >= 10,
      `expected the console to defer a dozen modules; found ${targets.size}`)
    assert.ok(targets.has('/workflow/panel.js'),
      'workflow/panel.js is ENH-22\'s offline drill-down and must be deferred')
  })

  it('no REFERENCE_PATTERNS entry can match a lazy() call', () => {
    // The defect, stated as a test. Every existing pattern requires a literal in
    // a static position: `import 'x'`, `import x from 'y'`, `<link href>`,
    // `<script src>`, `@import`. None can see `lazy('/workflow/panel.js')`,
    // because there is no `from` and no quote directly after the keyword.
    //
    // Asserted per target rather than per pattern: several of these patterns do
    // match *something* in the front end — `import` appears everywhere. The
    // claim is narrower and the narrow claim is the true one.
    const sw = read('public/sw.js')
    const block = /const REFERENCE_PATTERNS = \[([\s\S]*?)\n\]/.exec(sw)
    assert.ok(block, 'REFERENCE_PATTERNS is declared')
    const patterns = [...block[1].matchAll(/\/((?:[^\\\n]|\\.)+)\/[gimsuy]+/g)].map((m) => m[1])
    assert.ok(patterns.length >= 5, `expected five patterns; parsed ${patterns.length}`)

    const targets = deferredTargets()
    for (const [target, from] of targets) {
      // A synthetic file containing only this one call, so a match means the
      // pattern genuinely reaches it rather than matching something else in a
      // large body of source.
      const sample = `lazy('${target}')\nimport('${target}')\nimport(/* c */ '${target}')\n`
      for (const pattern of patterns) {
        let re
        try { re = new RegExp(pattern, 'g') } catch { continue }
        re.lastIndex = 0
        assert.equal(re.test(sample), false,
          `REFERENCE_PATTERNS entry /${pattern}/ matches ${target} (referenced from ${from}). ` +
          'R-65 may already be fixed in sw.js — delete this report rather than leaving it stale.')
      }
    }
  })

  it('the proposed patterns close the gap — this is the change for sw.js', () => {
    // The precise fix. Two patterns added to `REFERENCE_PATTERNS` in
    // `public/sw.js:224`:
    //
    //   // Dynamic import with a literal argument, including a webpack-style
    //   // comment between `(` and the path:
    //   //   import(/* chunk */ '/workflow/panel.js')
    //   /(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?[`'"]([^`'"]+)[`'"]\s*\)/g,
    //   // This repo's own deferred-module helper, `lazy()` in public/app.js.
    //   // Named separately because it is a local convention, not a language
    //   // feature: a reader looking for why workflow/panel.js is missing will
    //   // not find it under `import`.
    //   /\blazy\s*\(\s*[`'"]([^`'"]+)[`'"]\s*\)/g,
    //
    // Both return the path in group 1, which is what `parseReferences` expects.
    //
    // The comment-tolerant form matters because the original brief names
    // `import(/** … */ path)` specifically: a bundler-style comment between the
    // paren and the string is common enough that a pattern without it fixes
    // the reported case and leaves the next one.
    const PROPOSED = [
      /(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?[`'"]([^`'"]+)[`'"]\s*\)/g,
      /\blazy\s*\(\s*[`'"]([^`'" ]+)[`'"]\s*\)/g,
    ]
    const sample = JS.map((f) => readFileSync(f, 'utf8')).join('\n')
    const found = new Set()
    for (const p of PROPOSED) {
      p.lastIndex = 0
      for (const m of sample.matchAll(p)) found.add(m[1])
    }
    for (const target of deferredTargets().keys()) {
      assert.ok(found.has(target),
        `the proposed patterns do not reach ${target}; the fix would be incomplete`)
    }
    // Also picks up a 34 KB module the console defers and the current patterns
    // miss entirely — the argument for the general form over a fixed list.
    assert.ok(found.has('/shared/charts.js'),
      'shared/charts.js is a deferred module the current patterns cannot see')
  })

  it('an explicit entry list is still needed for what no pattern can see', () => {
    // Three gaps a reference pattern cannot close, because the reference is made
    // at runtime by a property assignment rather than by markup:
    //
    //   /workflow/panel.css  — `link.href = '/workflow/panel.css'` in
    //                          workflow/panel.js:15. A stylesheet injected by a
    //                          script is invisible to any scan of source text.
    //   /i18n/*.json         — nine catalogues fetched by string construction,
    //                          `/i18n/${locale}.json`. A locale switch while
    //                          offline must work; ENH-41's own metric is
    //                          "locales switchable offline 1 → 10".
    //   /panels/*.html       — the deferred tab panels, same shape as the lazy
    //                          modules and added by ENH-46.
    //
    // These belong in `BOOTSTRAP_ASSETS` in sw.js alongside the existing
    // entries. Registering the paths is more honest than widening the regexes
    // further: a pattern that guesses at runtime string construction will also
    // match things that are not paths.
    const sw = read('public/sw.js')
    assert.match(sw, /BOOTSTRAP_ASSETS/, 'sw.js has an explicit bootstrap list to extend')
    for (const p of ['/workflow/panel.css', '/panels/settings.html']) {
      const exists = allFiles().some((f) => '/' + path.relative(PUBLIC, f) === p)
      assert.ok(exists, `${p} should exist on disk`)
    }
    const locales = readdirSync(path.join(PUBLIC, 'i18n')).filter((f) => f.endsWith('.json'))
    assert.ok(locales.length >= 9,
      `expected nine shipped locales; found ${locales.length}`)
  })

  it('the oracle test derives its expectation from a different regex than the code', () => {
    // How the oracle stopped being able to fail. `web-chw-offline.test.js`
    // scanned `from "…"` literals — the same shape `REFERENCE_PATTERNS` matched
    // — so it computed the same 45 the broken worker cached, and agreed.
    //
    // The fix is not a better regex; it is that the oracle asserts against
    // `shellGraph` itself rather than re-deriving the answer. The test below
    // does that: it drives the real exported function with a loader that reads
    // this repo's public/ tree, so the two cannot drift.
    const oracle = read('test/web-chw-offline.test.js')
    assert.doesNotMatch(oracle, /for?\s*\(.*\)\s*\{\s*const\s+m\s*=\s*text\.matchAll\(\s*\/\^\[\\s;\}\]\(\?:import\|export\)/,
      'the oracle appears to re-derive the reference set from its own regex rather than ' +
      'calling shellGraph, which is how it agreed with the broken traversal')
  })
})

describe('R-65 — the measurement, so this report can be retired', () => {
  it('shellGraph reaches the lazy graph once the patterns are added', async () => {
    // Drives the real `shellGraph` from sw.js — the point of this test. It
    // passes `load` a function that reads the repo, so the answer comes from
    // the shipped traversal rather than from a reimplementation of it.
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
    const reached = new Set(await shellGraph(load, 'http://lindela.test/'))
    const targets = deferredTargets()

    const missing = [...targets.keys()].filter((t) => !reached.has(t))
    assert.ok(missing.length >= 10,
      `expected the shipped traversal to miss most deferred modules — that is the defect. ` +
      `It now misses ${missing.length}: ${missing.join(', ')}. If this is 0, the fix has ` +
      'landed in sw.js and this whole file should be deleted, not updated.')
  })

  it('panel.js is reachable today only by accident, which is the point', () => {
    // Confirms the severity claim rather than asserting it. If some other
    // reference path picked up panel.js, the drill-down would work offline and
    // this would be a much smaller finding.
    const sw = read('public/sw.js')
    const patterns = /const REFERENCE_PATTERNS = \[([\s\S]*?)\n\]/.exec(sw)[1]
    const re = new RegExp(patterns.split(',')[0].trim().slice(1, -2), 'g')
    assert.equal(typeof re.exec, 'function')
    assert.ok(!new RegExp('panel\\.js').test(patterns),
      'REFERENCE_PATTERNS does mention panel.js directly; R-65 may already be addressed')
  })
})
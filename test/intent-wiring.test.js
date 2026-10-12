#!/usr/bin/env node
/**
 * ENH-71 — the console follows an explicit intent.
 *
 * `public/shared/intent.js` is the decision and `test/intent.test.js` is its
 * unit suite; `public/shared/intent-console.js` is the surface that renders it,
 * and this file is that surface's wiring. It asserts what the module cannot
 * assert about itself:
 *
 *   - **No intent shows every control.** The console opens with no intent, and
 *     the decided default is that this shows the whole console. The role's
 *     `defaultIntent` is deliberately *not* applied: `operator` defaults to
 *     `triage`, whose `show` list is the alert rail alone, so opening on the
 *     role default would hide 30 of 39 controls — all six map filters among
 *     them — before the operator has said what they came to do. A console that
 *     opens with its map filters gone is the failure the feature exists to
 *     prevent, so the first tests are the console's own opening state.
 *
 *   - **The picker is the only thing that hides a control, and a hidden one
 *     carries its reason.** `triage` is driven through the real `change` handler
 *     on the real `<select>` the renderer built, and the reason the hidden map
 *     filters carry is read back out of the rendered markup.
 *
 *   - **The module and its renderer are not in the first-load graph.**
 *     `scripts/check-budget.mjs` measures 229.5 KB of a 230.0 KB ceiling; a
 *     *static* import of either file would land on the first load and fail the
 *     gate, so `app.js` reaches them through `lazy()`.
 *
 * The reachability canary at the end is the one test that cannot drive the
 * console: the property it guards lives in the module, not the surface, so it is
 * checked against a copy of the module with `palette` dropped from `manage.show`.
 * The copy is imported from a temp dir; the real tree is never written.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

import { installBrowserEnv, stubElement } from './browser-env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')

/**
 * Run the budget gate against the real tree and return what it printed.
 *
 * `moduleGraph()` is not exported and the script runs its measurement at top
 * level, so it cannot be imported without executing — the gate is invoked as a
 * child process and its own stdout read, which is the only surface it exposes.
 */
function budgetOutput() {
  try {
    return execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-budget.mjs')], { encoding: 'utf8' })
  } catch (error) {
    if (typeof error.stdout === 'string') return error.stdout
    throw error
  }
}

const INTENT = await import(pathToFileURL(path.join(PUBLIC, 'shared', 'intent.js')).href)

/**
 * Render the intent bar the way the console does, into a host stub, and return
 * the host plus a driver for its picker.
 *
 * The renderer is imported with the browser environment installed, because it
 * injects its own `<style>` through `document.createElement`. The stub element
 * records `innerHTML`, so the assertions read the markup a browser would get.
 */
async function renderBar({ role = 'operator', intent = null } = {}) {
  installBrowserEnv()
  const { renderIntentBar, INTENT_SELECT_ID } = await import(
    pathToFileURL(path.join(PUBLIC, 'shared', 'intent-console.js')).href)
  const host = stubElement('section')
  let chosen = intent
  renderIntentBar(host, {
    role,
    intent,
    onChange: (next) => { chosen = next },
  })
  return {
    host,
    /** Fire the picker's change handler the way a browser would. */
    choose(value) {
      const select = host.querySelector(`#${INTENT_SELECT_ID}`)
      assert.ok(select, 'the renderer did not build the intent picker')
      const handlers = select.listeners('change')
      assert.ok(handlers.length > 0, 'the intent picker has no change handler')
      for (const fn of handlers) fn({ target: { value } })
      return chosen
    },
  }
}

describe('ENH-71 — the console follows an explicit intent', () => {
  it('shows every control and says so before an intent is chosen', async () => {
    const { host } = await renderBar({ intent: null })
    const html = host.innerHTML
    assert.match(html, /No intent chosen/, 'the intent bar does not say the console is showing everything')
    assert.match(html, /showing every control/i)
    // No control is hidden, so the hidden-controls list is not rendered at all.
    assert.doesNotMatch(html, /intent-hidden/, 'a control is hidden before any intent was chosen')
    // The picker offers the absent-intent option, so an operator can return here.
    assert.match(html, /No intent — show everything/)
  })

  it('the module agrees: no intent is a fallback, not the role default', () => {
    // The console reads `state.intent = null`; the module must read that as
    // "show everything" and never as `operator`'s `triage`. Asserted on the
    // module's own call so the two cannot drift.
    const decision = INTENT.decideSurface('operator', null)
    assert.equal(decision.mode, 'fallback')
    assert.equal(decision.shown.length, Object.keys(INTENT.CONTROLS).length)
    assert.deepEqual(decision.hidden, [])
    // The failure this guards: `triage` would drop the six map filters.
    for (const id of ['mapTimeRange', 'mapSeverity', 'mapSource', 'mapTileSource', 'coldChainToggle', 'sensorsToggle']) {
      assert.ok(decision.shown.includes(id), `${id} is hidden with no intent chosen`)
    }
  })

  it('choosing triage hides the map filters and names the reason', async () => {
    // Drive the picker the way a person does — the change event, not a
    // re-render with a different argument — so the handler itself is exercised.
    const first = await renderBar({ intent: null })
    const chosen = first.choose('triage')
    assert.equal(chosen, 'triage', 'the picker did not report the chosen intent')

    // Re-render with the chosen intent, as the console's onChange does.
    const { host } = await renderBar({ intent: 'triage' })
    const html = host.innerHTML
    assert.match(html, /intent-hidden/, 'triage hid nothing, so this asserts nothing')
    // The reason, per control, is the module's `hiddenBecause` — the renderer
    // must show it, not swallow it.
    assert.match(html, /mapTimeRange/)
    assert.match(html, /the map time window/)
    // And the only-route way back is shown too, not just the reason.
    assert.match(html, /only route/)
    assert.match(html, /Show everything/)
    // The header states the decision, so a narrowed console never reads as a
    // broken one.
    assert.match(html, /Triage incoming alerts/)
  })

  it('an unknown role still shows everything, through the same surface', async () => {
    const decision = INTENT.decideSurface('region-coordinator', 'triage')
    assert.equal(decision.mode, 'fallback')
    assert.equal(decision.shown.length, Object.keys(INTENT.CONTROLS).length)
    assert.deepEqual(decision.hidden, [])
    assert.match(decision.header, /Unrecognised role/)
    // And the surface renders that fallback with no hidden list.
    const { host } = await renderBar({ role: 'region-coordinator', intent: 'triage' })
    assert.match(host.innerHTML, /Unrecognised role/)
    assert.doesNotMatch(host.innerHTML, /intent-hidden/)
  })

  it('keeps the module and its renderer out of the first-load graph', () => {
    // Two assertions, because they fail differently.
    //
    // The first reads the gate's own asset list: if either file is on it, a
    // static import has pulled it onto the first load and the gate is over
    // budget. This is the honest measurement — it is the same number the gate
    // enforces.
    const assets = budgetOutput().split('\n')
      .map((line) => line.match(/^\s{2}(\S+\.(?:js|css|json))\s/))
      .filter(Boolean)
      .map((match) => match[1])
    for (const rel of ['shared/intent.js', 'shared/intent-console.js']) {
      assert.ok(!assets.includes(rel),
        `${rel} is on the first-load path; a static import has pulled it in and the budget gate will fail`)
    }

    // The second reads the entry module's own source: both must be reached
    // through `lazy()`, never a static `from '…'`. This fails the moment someone
    // writes the import the other way, even before the gate's byte count moves.
    const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8')
    assert.doesNotMatch(app, /^\s*import\b[^\n]*['"]\/shared\/intent(?:-console)?\.js['"]/m,
      'app.js statically imports an intent module; it must go through lazy() to stay off the first load')
    assert.match(app, /lazy\(\s*['"]\/shared\/intent-console\.js['"]\s*\)/,
      'app.js does not reach shared/intent-console.js through lazy(), so the surface is not wired in')
  })

  it('the reachability property fires when a group is dropped from the total intent', async () => {
    // The canary. `manage` is the total intent and is what makes the
    // reachability property hold by construction; drop one group from its
    // `show` list and a control must become unreachable for a role. If the
    // assertion below passes against the broken copy, the property is not
    // checking anything.
    //
    // The copy is imported from a temp dir rather than editing `public/`: a
    // test that writes a tracked file while `node --test` runs other files in
    // parallel against the same tree is non-deterministic by construction.
    const source = fs.readFileSync(path.join(PUBLIC, 'shared', 'intent.js'), 'utf8')
    const before = "show: Object.freeze(['console', 'map', 'simulation', 'routing', 'rail', 'palette', 'dialog'])"
    assert.ok(source.includes(before), 'canary target not found — the patch would be a no-op')
    const after = "show: Object.freeze(['console', 'map', 'simulation', 'routing', 'rail', 'dialog'])"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-canary-'))
    // The removal must happen *after* the import resolves, not in a `finally`
    // around the `return`. `import()` reads the file asynchronously, so a
    // synchronous `finally` deletes the directory before the loader opens it —
    // and macOS's loader happened to win the race where Linux's did not, so
    // this passed locally and failed on every CI push with ENOENT. Awaiting the
    // import first makes the order explicit rather than lucky.
    try {
      const file = path.join(dir, 'intent.js')
      fs.writeFileSync(file, source.replace(before, after))
      const { reachability } = await import(pathToFileURL(file).href)
      const report = reachability()
      assert.ok(report.unreachable.length > 0,
        'dropping palette from manage.show stranded nothing; the reachability property is not firing')
      assert.ok(report.onlyRouteUnreachable.some((u) => u.control === 'paletteInput'),
        'paletteInput is the only-route control the dropped group stranded, and it was not reported')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

#!/usr/bin/env node
/**
 * R-64 — the console's alert rail must not assert an unearned negative.
 *
 * The defect, measured and screenshot-confirmed: with `/api/v1/alerts` down on
 * a cold start, the rail printed **"No alerts. All rules quiet."** while the
 * status bar on the same screen said nothing had been checked. Two panels,
 * flatly contradictory claims, and no way for the operator to tell which one is
 * lying. This is the panel that answers "what needs my attention right now",
 * so it is the worst possible place to be reassuring and wrong.
 *
 * The mechanism was `if (!filtered.length)`. `filtered` cannot distinguish
 * "the server says there are none" from "the server never answered", because
 * `state.data.alerts?.data || []` converts both into the same empty array.
 * That `|| []` is the bug in five characters: it is a falsy-coalesce standing in
 * for a claim about the world.
 *
 * `state.failedSources` was populated on every single refresh and read by
 * exactly one renderer — `renderWorkflowInstanceList`, four hundred lines up,
 * which already does the right thing. The information was present the whole
 * time. The alerts branch just never asked.
 *
 * The fix extracts the decision as a pure exported function, because the
 * decision *is* the fix. Asserting on rendered HTML would prove only that
 * `innerHTML` was called; asserting on this function pins the logic that was
 * missing.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'
import { before, describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_ROOT = new URL('../public/', import.meta.url)
const APP = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')

/**
 * Source with comments and template strings stripped.
 *
 * app.js documents each of these decisions at length, and the prose quotes the
 * very strings the assertions forbid — including "No alerts. All rules quiet."
 * A scan that reads comments tests the documentation, not the program.
 */
const code = APP
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/* ------------------------------------------------------------ sandbox */

let alertListOutcome

before(async () => {
  // `alertListOutcome` is a pure export, but it lives in a module that boots
  // the whole console at import time — element lookups, a fetch loop, a poll.
  // The console is imported with the DOM stub below so the export is reachable
  // without executing a browser.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('/shared/')) {
        return { url: new URL(`.${specifier}`, PUBLIC_ROOT).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })

  const stub = () => ({
    tagName: 'DIV',
    style: {},
    dataset: {},
    attrs: {},
    hidden: false,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    options: [],
    selectedIndex: 0,
    childNodes: [],
    children: [],
    length: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    hasAttribute: () => false, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, blur() {}, appendChild() {}, removeChild() {},
    insertBefore() {}, setSelectionRange() {},
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }),
    contains: () => false, cloneNode: () => stub(),
  })

  const byId = new Map()
  const location = { hash: '', search: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' }
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, location,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout, clearTimeout,
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    scrollTo() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  }
  globalThis.document = {
    getElementById: (id) => { if (!byId.has(id)) byId.set(id, stub()); return byId.get(id) },
    querySelectorAll: () => [], querySelector: () => null,
    createElement: stub, createElementNS: (_ns, tag) => stub(tag),
    createTextNode: (t) => ({ textContent: t }),
    documentElement: stub(), body: stub(), head: stub(),
    scrollingElement: stub(), readyState: 'complete',
    hidden: false, visibilityState: 'visible',
    addEventListener() {}, fonts: { ready: Promise.resolve() },
  }
  globalThis.location = location
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ success: true, data: [] }), text: async () => '',
  })
  // The console's poll self-reschedules through setTimeout. Left real, the test
  // file never finishes.
  globalThis.setInterval = () => 0
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}

  const mod = await import(new URL('app.js', PUBLIC_ROOT).href)
  alertListOutcome = mod.alertListOutcome
})

/* ---------------------------------------------------------------- helpers */

/** A state as the console holds it after a refresh. */
const loaded = (rows, failed = []) => ({
  data: { alerts: { data: rows } },
  failedSources: new Set(failed),
})

describe('R-64 — the alert rail distinguishes failed / unchecked / genuinely empty', () => {
  it('the console exports the decision as a pure function', () => {
    assert.equal(typeof alertListOutcome, 'function',
      'app.js must export alertListOutcome; asserting on rendered HTML would ' +
      'prove only that innerHTML was called')
  })

  it('a failed alerts fetch is an error, not an empty list', () => {
    // The headline defect: `state.data.alerts` is unset, so the old
    // `|| []` branch rendered "No alerts. All rules quiet."
    const out = alertListOutcome({ data: {}, failedSources: new Set(['alerts']) })
    assert.equal(out.state, 'error')
    assert.equal(out.neverChecked, false, 'a failure that was reported is not "never checked"')
  })

  it('a cold start with no refresh yet is unchecked, not empty', () => {
    // No failure to report and no rows to show. This is the third outcome that
    // did not exist, and it is the state of the page for every operator between
    // first paint and the first refresh completing.
    const out = alertListOutcome({ data: {}, failedSources: new Set() })
    assert.equal(out.state, 'unchecked')
    assert.equal(out.neverChecked, true)
  })

  it('a missing failedSources is treated as unchecked rather than trusted', () => {
    // Defensive: a state object built before `state` is fully initialised has
    // no Set yet. Defaulting that to "nothing failed" and then finding the row
    // list empty would render the reassuring string again.
    const out = alertListOutcome({ data: {} })
    assert.equal(out.state, 'unchecked')
    const noState = alertListOutcome({})
    assert.notEqual(noState.state, 'empty', 'an absent state must never read as empty')
  })

  it('a server that answered with no alerts is genuinely empty', () => {
    const out = alertListOutcome(loaded([]))
    assert.equal(out.state, 'empty')
  })

  it('a server that answered with alerts is ok', () => {
    const out = alertListOutcome(loaded([{ id: 'a1', status: 'open' }]))
    assert.equal(out.state, 'ok')
  })

  it('a failure of some other source does not poison the alert rail', () => {
    // The endpoint that fails must be the one that decides. A dead workflow
    // endpoint must not make the console claim the alert feed is unchecked.
    const out = alertListOutcome(loaded([{ id: 'a1' }], ['workflows']))
    assert.equal(out.state, 'ok')
  })

  it('an alerts response with a null data array is empty, not a crash', () => {
    // `success: true, data: null` is a real shape from the API substrate.
    const out = alertListOutcome({ data: { alerts: { data: null } }, failedSources: new Set() })
    assert.equal(out.state, 'empty')
  })
})

describe('R-64 — the reassuring string is unreachable when nothing was checked', () => {
  it('the empty-state branch is guarded by the outcome, not by row count alone', () => {
    // The old branch was `if (!filtered.length)` with nothing before it. The
    // check must come first, or the reassurance still renders.
    const outcomeIdx = code.indexOf('const outcome = alertListOutcome(state)')
    const branchIdx = code.indexOf("if (outcome.state !== 'ok' && outcome.state !== 'empty')")
    const emptyIdx = code.indexOf("escapeHtml(t('state.empty_alerts'))")
    assert.ok(outcomeIdx > 0, 'the outcome decision is present')
    assert.ok(branchIdx > outcomeIdx, 'the outcome branch follows the decision')
    assert.ok(emptyIdx > branchIdx,
      'the reassuring empty-state string must be downstream of the failure branch, ' +
      'or a dead endpoint still prints "No alerts. All rules quiet."')
  })

  it('the failure branch returns before the empty branch can run', () => {
    const start = code.indexOf("if (outcome.state !== 'ok' && outcome.state !== 'empty')")
    const slice = code.slice(start, start + 2000)
    const retIdx = slice.indexOf('return')
    const emptyIdx = slice.indexOf("t('state.empty_alerts')")
    assert.ok(retIdx > 0, 'the failure branch returns')
    if (emptyIdx > 0) {
      assert.ok(retIdx < emptyIdx, 'it returns before reaching the empty-state markup')
    }
  })

  it('the tab badge gains an unchecked state, since it is a claim too', () => {
    // The badge took an array and nothing else, so every upstream failure
    // arrived as [] and it hid itself — indistinguishable from a quiet queue.
    // An operator scanning the tab strip saw no badge on a dead console.
    assert.match(code, /function renderAlertsBadge\([^)]*checked\s*=/,
      'renderAlertsBadge must take a `checked` flag')
    assert.match(code, /renderAlertsBadge\(\[\],\s*\{\s*checked:\s*false\s*\}\)/,
      'the failure branch must render the badge as unchecked')
  })

  it('the rail uses the shipped vocabulary rather than inventing its own wording', () => {
    // shared/states.js is the shared contract, adopted by three surfaces
    // already. A fourth copy of "could not reach the server" is a fourth
    // wording to keep in sync.
    assert.match(APP, /import \{[^}]*describeState[^}]*\} from '\/shared\/states\.js'/,
      'app.js should import the shared state vocabulary')
    assert.match(code, /describeState\(ERROR,\s*\{\s*subject:\s*'Alerts'/,
      'the rail should describe its own error state with the shared helper')
  })
})

describe('R-64 — the failure state is visibly not the reassuring one', () => {
  const styles = readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')

  it('.empty-state-error exists and is distinguishable from .empty-state', () => {
    // Two panels that look alike at a glance are the original defect rendered
    // twice: the operator cannot tell which grey means "checked, quiet" and
    // which means "never checked".
    assert.match(styles, /\.empty-state-error\s*\{[^}]*\}/)
    const base = /\.empty-state\s*\{([^}]*)\}/.exec(styles)?.[1] || ''
    const err = /\.empty-state-error\s*\{([^}]*)\}/.exec(styles)?.[1] || ''
    assert.notEqual(base.trim(), err.trim(),
      'the error variant must differ from the base empty state, or the two read alike')
    assert.match(err, /var\(--danger\)/,
      'the error variant should be visibly distinct, not a slightly darker grey')
  })

  it('the error variant stylesheet ships on every surface that links styles.css', () => {
    // It lives in styles.css rather than in one surface's inline block, so the
    // four surfaces that render a failure state all get it.
    for (const f of ['index.html', 'co/index.html', 'portal/index.html', 'focal-point/index.html']) {
      const html = readFileSync(path.join(ROOT, 'public', f), 'utf8')
      assert.match(html, /href="\/styles\.css"/, `${f} must load styles.css`)
    }
  })
})
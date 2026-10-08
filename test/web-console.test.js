#!/usr/bin/env node
/**
 * The console frontend: WEB-02, WEB-04, WEB-07, WEB-09, WEB-10.
 *
 * `public/app.js` runs a boot sequence at import time — it looks elements up by
 * id, writes to them, and fetches — so it cannot be imported in a bare Node
 * process. The DOM stub below is the same one `falsy-zero.test.js` uses, and
 * the fixes are written so that the load-bearing decision in each is a pure
 * function the test drives directly. Asserting on rendered HTML would prove
 * only that `innerHTML` was called.
 *
 * Every test here fails against the pre-fix code, and for a reason rather than
 * a coincidence: each assertion names the behaviour the defect removed.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { installModuleResolution } from './browser-env.mjs'

const PUBLIC_ROOT = new URL('../public/', import.meta.url)

// ---------------------------------------------------------------
// Browser module sandbox
// ---------------------------------------------------------------

function stubElement(tag = 'DIV') {
  return {
    tagName: tag.toUpperCase(),
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
    selectionStart: null,
    selectionEnd: null,
    scrollTop: 0,
    isContentEditable: false,
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute: (k) => (k in this.attrs ? this.attrs[k] : null),
    removeAttribute(k) { delete this.attrs[k] },
    append() {},
    appendChild() {},
    removeChild() {},
    replaceChildren() {},
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    focus() {},
    blur() {},
    insertBefore() {},
    setSelectionRange() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }),
    contains: () => false,
    cloneNode: () => stubElement(tag),
  }
}

async function loadConsole() {
  installModuleResolution()
  const byId = new Map()
  const location = { hash: '', search: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' }
  const body = stubElement('body')

  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    location,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout,
    clearTimeout,
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    scrollTo() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  }
  globalThis.document = {
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, stubElement())
      return byId.get(id)
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => stubElement(tag),
    createElementNS: (_ns, tag) => stubElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    documentElement: stubElement('html'),
    body,
    head: stubElement('head'),
    scrollingElement: stubElement('html'),
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    addEventListener() {},
    fonts: { ready: Promise.resolve() },
  }
  globalThis.location = location
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ success: true, data: [] }),
    text: async () => '',
  })
  // A live timer keeps `node --test` from exiting. The console's poll
  // self-reschedules through `setTimeout`, so both are stubbed: with a real one
  // the test file runs until the harness is killed rather than finishing.
  globalThis.setInterval = () => 0
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}

  return import(new URL('app.js', PUBLIC_ROOT).href)
}

// ---------------------------------------------------------------
// Fake elements for the focus/scroll helpers
// ---------------------------------------------------------------

function focusable(key, extra = {}) {
  return {
    tagName: 'BUTTON',
    isContentEditable: false,
    selectionStart: null,
    selectionEnd: null,
    focused: null,
    selection: null,
    attrs: key ? { 'data-focus-key': key } : {},
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    focus(opts) { this.focused = opts },
    setSelectionRange(a, b) { this.selection = [a, b] },
    closest: () => null,
    ...extra,
  }
}

function rootOf(elements) {
  return { querySelectorAll: () => elements }
}

// ---------------------------------------------------------------
// The module under test
// ---------------------------------------------------------------

let app

describe('public/app.js — console frontend', () => {
  before(async () => { app = await loadConsole() })

  // ==============================================================
  // WEB-02 — the severity filter admits every unclassified record
  // ==============================================================
  describe('WEB-02 — a severity filter that means it', () => {
    it('excludes a record with no severity when a severity is chosen', () => {
      const verdict = app.evaluateMapFilters({ severity: null, source: 'gdacs' }, { severity: 'critical' })
      assert.equal(verdict.shown, false,
        'a record nobody graded is not a critical record')
      assert.equal(verdict.undetermined, 'severity',
        'and it must be reported as undetermined, not silently counted as filtered')
    })

    it('excludes the empty string, which is what a blank form field posts', () => {
      const verdict = app.evaluateMapFilters({ severity: '' }, { severity: 'critical' })
      assert.equal(verdict.shown, false)
    })

    it('excludes undefined and keeps a real match', () => {
      assert.equal(app.evaluateMapFilters({}, { severity: 'high' }).shown, false)
      assert.equal(app.evaluateMapFilters({ severity: 'high' }, { severity: 'high' }).shown, true)
    })

    it('keeps unclassified records when no filter is set', () => {
      assert.equal(app.evaluateMapFilters({ severity: null }, { severity: '' }).shown, true)
    })

    it('does not treat a score of 0 as an absent severity', () => {
      // The falsy-zero trap in the other direction.
      assert.equal(app.evaluateMapFilters({ severity: 0 }, { severity: '' }).shown, true,
        'zero is a value; only null/undefined/"" mean undetermined')
      assert.equal(app.evaluateMapFilters({ severity: 0 }, { severity: 'critical' }).shown, false)
    })

    it('applies the same rule to source', () => {
      assert.equal(app.evaluateMapFilters({ source: null }, { source: 'gdacs' }).shown, false)
      assert.equal(app.evaluateMapFilters({ source: 'gdacs' }, { source: 'gdacs' }).shown, true)
    })

    it('never reports undetermined when no filter is active', () => {
      const verdict = app.evaluateMapFilters({ severity: null, source: null }, {})
      assert.equal(verdict.shown, true)
      assert.equal(verdict.undetermined, null)
    })
  })

  // ==============================================================
  // WEB-04 — colour was the only carrier of type and severity
  // ==============================================================
  describe('WEB-04 — a second channel besides colour', () => {
    const HAZARDS = [
      'flood', 'river flood', 'flash flood',
      'landslide', 'debris flow', 'mudslide',
      'tropical storm', 'cyclone',
      'wildfire', 'forest fire',
      'earthquake', 'disaster',
      'civil conflict', 'communal tension',
      'something the classifier has never seen',
    ]

    it('gives the hazard types at least four distinct shapes', () => {
      const shapes = new Set(HAZARDS.map((h) => app.hazardShape(h)))
      assert.ok(shapes.size >= 4,
        `type must not be readable only as a hue; got ${shapes.size} shapes: ${[...shapes]}`)
    })

    it('keeps landslide and flood distinct — the classifier already separates them', () => {
      assert.notEqual(app.hazardShape('landslide'), app.hazardShape('flood'))
    })

    it('gives every graded severity a distinct stroke pattern', () => {
      const sevs = ['critical', 'high', 'medium', 'low']
      const dashes = sevs.map((s) => app.severityDash(s))
      assert.equal(new Set(dashes).size, sevs.length,
        `severity must survive in greyscale: ${JSON.stringify(dashes)}`)
    })

    it('collapses every spelling of "no severity" onto one pattern', () => {
      // null, undefined and "" are three spellings of one fact, and they must
      // not read as three different things on the map.
      const blanks = app.severityDash(null)
      assert.equal(app.severityDash(undefined), blanks)
      assert.equal(app.severityDash(''), blanks)
      assert.equal(app.severityDash('ungraded'), blanks)
      assert.equal(app.severityDash('  '), blanks)
    })

    it('does not paint an ungraded record as "low"', () => {
      assert.notEqual(app.severityDash(null), app.severityDash('low'))
      assert.equal(app.severityDash(undefined), app.severityDash(''))
    })

    it('is case-insensitive on severity, so Low and low do not split', () => {
      assert.equal(app.severityDash('LOW'), app.severityDash('low'))
      assert.equal(app.severityDash('Critical'), app.severityDash('critical'))
    })

    it('draws every shape at roughly the radius it claims', () => {
      // A triangle inscribed in radius r is 1.73r across and 1.5r tall — that
      // is what a triangle is. The failure this guards against is a shape that
      // collapses to a dot, or one scaled so small it is smaller than the
      // circle it is meant to replace.
      for (const shape of ['circle', 'triangle', 'hexagon', 'square', 'diamond', 'cross']) {
        const { w, h } = app.shapeExtent(shape, 10)
        assert.ok(Math.max(w, h) >= 15,
          `${shape} at r=10 spans ${w.toFixed(1)}x${h.toFixed(1)}`)
        assert.ok(Math.min(w, h) >= 10,
          `${shape} at r=10 spans ${w.toFixed(1)}x${h.toFixed(1)}`)
      }
    })

    it('makes the non-circle shapes measurably non-circular', () => {
      // Two shapes that trace the same bounding box read as one shape. Aspect
      // ratio is enough to separate them: the circle is the only 1:1 that is
      // not also a square.
      const ratios = ['triangle', 'cross'].map((s) => {
        const { w, h } = app.shapeExtent(s, 10)
        return w === h
      })
      assert.ok(ratios.some((square) => !square),
        'triangle and cross must be distinguishable from a square outline')
      assert.equal(app.shapeExtent('circle', 10).w, app.shapeExtent('circle', 10).h)
    })
  })

  // ==============================================================
  // WEB-10 — markers below the 24px touch-target floor
  // ==============================================================
  describe('WEB-10 — a target you can hit', () => {
    it('computes 12 viewBox units for a map rendered 1:1', () => {
      assert.equal(app.hitRadiusUnits(800, 800), 12)
    })

    it('scales the target up as the map gets narrower on screen', () => {
      // 800 viewBox units across a 360px phone is 2.22 units per pixel, so a
      // 12-unit radius is 5.4 CSS px. The target has to grow with the ratio or
      // it is small exactly where the phone is.
      const r = app.hitRadiusUnits(800, 360)
      assert.ok(r >= 24, `expected a grown target on a phone, got ${r}`)
    })

    it('meets 24 CSS px at every viewport the responsive gate uses', () => {
      for (const width of [320, 360, 414, 768, 1024, 1440, 1920]) {
        const units = app.hitRadiusUnits(800, width)
        const cssPx = (units * 2) / app.viewBoxUnitsPerPx(800, width)
        assert.ok(cssPx >= 24, `at ${width}px the target is ${cssPx.toFixed(1)} CSS px`)
      }
    })

    it('falls back to the conservative floor when there is no layout to measure', () => {
      // Before first paint getBoundingClientRect reports 0. Dividing by it would
      // yield Infinity; the 12-unit fallback is the desktop-size target, which
      // is the larger of the two mistakes.
      assert.equal(app.hitRadiusUnits(800, 0), 12)
      assert.equal(app.viewBoxUnitsPerPx(0, 800), 1)
    })

    it('never divides by a width that is not one', () => {
      // Before first paint, and on a detached or display:none map, the rect is
      // 0. The result has to stay finite and at least the desktop floor.
      for (const [vb, css] of [[800, 0], [800, -100], [0, 0], [0, 800], [-800, 100]]) {
        const r = app.hitRadiusUnits(vb, css)
        assert.ok(Number.isFinite(r) && r >= 12, `hitRadiusUnits(${vb}, ${css}) = ${r}`)
      }
    })
  })

  // ==============================================================
  // Pan/zoom geometry — client px mapped through the meet fit
  // ==============================================================
  describe('map pan/zoom — client px mapped through the meet fit', () => {
    const setMapRect = (width, height) => {
      const el = globalThis.document.getElementById('situationMap')
      el.getBoundingClientRect = () => ({ width, height, left: 0, top: 0 })
    }
    after(() => setMapRect(0, 0))

    it('converts both axes with the constraining axis on a wide-and-short panel', () => {
      // 1039x480 CSS px against an 800x500 viewBox: the height constrains
      // (0.96 px per unit), the drawn map is 768 CSS px wide, and the leftover
      // 271 px splits into two 135.5 px bands. Drag math that ignores this
      // lags the cursor by the full ratio.
      setMapRect(1039, 480)
      const g = app.mapClientGeometry()
      assert.ok(Math.abs(g.unitsPerPx - 1 / 0.96) < 1e-9, `unitsPerPx ${g.unitsPerPx}`)
      assert.equal(g.originX, 135.5)
      assert.equal(g.originY, 0)
    })

    it('letters a tall-and-narrow phone on the vertical axis instead', () => {
      setMapRect(360, 400)
      const g = app.mapClientGeometry()
      assert.ok(Math.abs(g.unitsPerPx - 800 / 360) < 1e-9, `unitsPerPx ${g.unitsPerPx}`)
      assert.equal(g.originX, 0)
      assert.equal(g.originY, 87.5)
    })

    it('falls back to identity when there is no layout to measure', () => {
      setMapRect(0, 0)
      assert.deepEqual(app.mapClientGeometry(), { unitsPerPx: 1, originX: 0, originY: 0 })
    })
  })

  // ==============================================================
  // WEB-07 — the 30-second redraw ate the caret
  // ==============================================================
  describe('WEB-07 — a redraw that leaves the keyboard alone', () => {
    it('captures a keyed element with its caret offsets', () => {
      const el = focusable('alert:a1:approve', { selectionStart: 4, selectionEnd: 9 })
      assert.deepEqual(app.captureFocus(el), { key: 'alert:a1:approve', start: 4, end: 9 })
    })

    it('captures nothing for an element with no stable key', () => {
      // Restoring focus to "the third button" after records shift is worse than
      // dropping it, so an unkeyed element is not captured at all.
      assert.equal(app.captureFocus(focusable(null)), null)
      assert.equal(app.captureFocus(null), null)
      assert.equal(app.captureFocus(undefined), null)
    })

    it('survives a null selection, as on a button', () => {
      assert.deepEqual(app.captureFocus(focusable('k')), { key: 'k', start: null, end: null })
    })

    it('restores focus by key, not by position, after the node is replaced', () => {
      // The rebuilt list put the same control at a different index.
      const target = focusable('alert:a1:approve', { selectionStart: 2, selectionEnd: 7 })
      const root = rootOf([focusable('alert:a9:approve'), focusable('alert:a1:reject'), target])
      const done = app.restoreFocus(root, { key: 'alert:a1:approve', start: 2, end: 7 })
      assert.equal(done, true)
      assert.deepEqual(target.focused, { preventScroll: true },
        'focusing without preventScroll scrolls the rebuilt list to the element')
      assert.deepEqual(target.selection, [2, 7], 'the caret goes back mid-word, not to the end')
    })

    it('reports failure instead of throwing when the element is gone', () => {
      assert.equal(app.restoreFocus(rootOf([]), { key: 'gone', start: null, end: null }), false)
      assert.equal(app.restoreFocus(null, { key: 'k' }), false)
      assert.equal(app.restoreFocus(rootOf([focusable('k')]), null), false)
    })

    it('stands down a redraw while a text field is being typed into', () => {
      for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
        assert.equal(app.shouldDeferRedraw({ tagName: tag, getAttribute: () => null, closest: () => null }), true,
          `${tag} has focus; a rebuild would discard the keystroke`)
      }
      assert.equal(app.shouldDeferRedraw({ tagName: 'DIV', isContentEditable: true, getAttribute: () => null }), true)
    })

    it('proceeds when focus is on something that is not being typed into', () => {
      assert.equal(app.shouldDeferRedraw(null), false)
      assert.equal(app.shouldDeferRedraw(focusable('k')), false)
    })

    it('keeps scroll offsets, and skips the ones already at the top', () => {
      const deep = { scrollTop: 412 }
      const top = { scrollTop: 0 }
      const snap = app.captureScroll([deep, top, null, undefined])
      assert.equal(snap.length, 1)
      assert.equal(snap[0][0], deep)
      // A rebuild resets scrollTop to 0. Restoring is the whole point.
      deep.scrollTop = 0
      assert.equal(app.restoreScroll(snap), 1)
      assert.equal(deep.scrollTop, 412)
    })

    it('does not throw restoring onto a node that was detached mid-rebuild', () => {
      const frozen = Object.freeze({ scrollTop: 0 })
      assert.equal(app.restoreScroll([[frozen, 100]]), 1)
    })
  })

  // ==============================================================
  // WEB-09 — thirteen endpoints, every thirty seconds, forever
  // ==============================================================
  describe('WEB-09 — a poll that backs off', () => {
    it('starts at thirty seconds', () => {
      assert.equal(app.pollDelayMs({ failures: 0 }), 30_000)
      assert.equal(app.POLL_BASE_MS, 30_000)
    })

    it('doubles on every consecutive failure', () => {
      const d = (n) => app.pollDelayMs({ failures: n })
      assert.deepEqual([0, 1, 2, 3, 4].map(d), [30_000, 60_000, 120_000, 240_000, 300_000])
    })

    it('keeps backing off but never past the cap', () => {
      assert.equal(app.pollDelayMs({ failures: 20 }), app.POLL_MAX_MS)
      assert.equal(app.pollDelayMs({ failures: 20 }), 300_000)
      assert.ok(app.pollDelayMs({ failures: 6 }) <= app.POLL_MAX_MS)
    })

    it('actually backs off — a failure must delay more than a success', () => {
      const ok = app.pollDelayMs({ failures: 0 })
      const bad = app.pollDelayMs({ failures: 3 })
      assert.ok(bad > ok * 4, `three failures gave ${bad}ms against a ${ok}ms success tick`)
    })

    it('does not poll a hidden tab at all', () => {
      assert.equal(app.pollDelayMs({ failures: 0, hidden: true }), null)
      assert.equal(app.pollDelayMs({ failures: 3, hidden: true }), null,
        'a hidden tab is exactly where the backoff would otherwise leak')
    })

    it('does not start a second poll while one is in flight', () => {
      assert.equal(app.pollDelayMs({ failures: 0, inFlight: true }), null)
    })

    it('tolerates nonsense inputs', () => {
      assert.equal(app.pollDelayMs({ failures: -5 }), 30_000)
      assert.equal(app.pollDelayMs({ failures: 1.7 }), 60_000)
      assert.equal(app.pollDelayMs(), 30_000)
    })

    // -- dedupe -------------------------------------------------
    it('never fetches an endpoint for a tab that is not open', () => {
      const onAlerts = app.endpointsForTab('alerts')
      assert.ok(onAlerts.has('alerts'))
      assert.ok(!onAlerts.has('reports'),
        'the reports list is 20 rows of JSON nobody is looking at')
      assert.ok(!onAlerts.has('reportTemplates'))

      const onReports = app.endpointsForTab('reports')
      assert.ok(!onReports.has('alerts'))
      assert.ok(!onReports.has('dispatches'))
      assert.ok(!onReports.has('workflows'))
    })

    it('always fetches what the map and the status bar are showing', () => {
      for (const tab of ['alerts', 'reports', 'equity', 'ingestion', 'workflows', 'settings']) {
        const want = app.endpointsForTab(tab)
        for (const name of ['health', 'sources', 'flood', 'conflict', 'events', 'assets']) {
          assert.ok(want.has(name), `${tab} tab must still fetch ${name}`)
        }
      }
    })

    it('fetches everything on the first load, so no tab opens empty', () => {
      const first = app.endpointsForTab('alerts', { first: true })
      assert.equal(first.size, app.ALL_ENDPOINTS.length)
      for (const name of app.ALL_ENDPOINTS) assert.ok(first.has(name), `boot must fetch ${name}`)
    })

    it('covers every endpoint across the tabs, so nothing is unreachable', () => {
      const seen = new Set()
      for (const tab of Object.keys({ alerts: 1, reports: 1, equity: 1, ingestion: 1 })) {
        for (const name of app.endpointsForTab(tab)) seen.add(name)
      }
      for (const name of app.ALL_ENDPOINTS) {
        assert.ok(seen.has(name), `${name} is fetched by no tab`)
      }
    })

    it('has no fixed-interval poll left in the module', async () => {
      // The regression this replaces was `setInterval(refresh, 30_000)` at module
      // scope: one handle, forever, immune to what happened last time, and
      // uncancellable. A self-rescheduling timer is the only shape that can
      // read the last attempt's outcome, so this checks for its absence.
      const { readFile } = await import('node:fs/promises')
      const src = await readFile(new URL('app.js', PUBLIC_ROOT), 'utf8')
      // Comments are stripped first: the prose explaining the old interval
      // names it, and a regex that matched the explanation would pass on a file
      // that still schedules one.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      assert.ok(!/setInterval\(\s*refresh/.test(code), 'the fixed-interval poll must be gone')
      assert.ok(/setTimeout\([\s\S]{0,200}pollDelayMs|schedulePoll/.test(code),
        'the poll must reschedule itself from pollDelayMs')
    })

    it('stops the timer when the tab is hidden, rather than merely skipping a tick', async () => {
      const { readFile } = await import('node:fs/promises')
      const src = await readFile(new URL('app.js', PUBLIC_ROOT), 'utf8')
      const handler = src.slice(src.indexOf("document.addEventListener('visibilitychange'"))
      assert.ok(handler.includes('clearTimeout(_pollTimer)'),
        'a hidden tab must cancel the pending poll, not just skip the next one')
    })
  })
})

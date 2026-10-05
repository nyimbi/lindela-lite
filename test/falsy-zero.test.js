/**
 * Zero is a value. Null is the absence of one.
 *
 * This rule is written down twice in the codebase — `src/server.js` warns
 * against it and `src/analytics.js` carries the comment "an absent forecast is
 * not a 0% chance of rain" — and was still being broken in both directions:
 * coordinates at 0° silently skipped privacy coarsening and were dropped from
 * two maps, while records whose severity was `null` passed every severity
 * filter as though undetermined meant "matches everything".
 *
 * The rule against asserting on source text, from docs/improvements/_research/
 * 00-audit-baseline.md §B1, is taken seriously here. Two of the four sites live
 * in browser modules that cannot be imported without a DOM, and the burn was
 * exactly this: guards that asserted a string was present while the real defect
 * sat elsewhere in the file, so fixing the bug FAILED the guard.
 *
 * Both browser files are ES modules served as-is, so `registerHooks` can stand
 * in for the browser's own `/shared/...` resolution and load them against a
 * minimal DOM stub. `public/districts/app.js` boots cleanly that way; `public/
 * app.js` runs a boot sequence at import time (fetching the catalogue, starting
 * the 30-second refresh timer), which the stub below absorbs. What is asserted
 * is the return value of the real function — the SVG the map renders, the
 * verdict the filter returns — never a regex over the file.
 */

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { redactPii } from '../src/pii.js'
import { installModuleResolution } from './browser-env.mjs'

const PUBLIC_ROOT = new URL('../public/', import.meta.url)

// ---------------------------------------------------------------
// Browser module sandbox
// ---------------------------------------------------------------

/** An element that absorbs every property the console writes to one. */
function stubElement(tag = 'DIV') {
  const el = {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
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
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
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
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }),
    contains: () => false,
    cloneNode: () => stubElement(tag),
  }
  return el
}

/**
 * Load a browser module against a DOM stub.
 *
 * The console looks elements up by id and writes to them unconditionally in
 * several places, so `getElementById` returns a fresh stub per id rather than
 * null — null fails on the first property write, at import, not at the call
 * under test.
 */
async function loadBrowserModule(relativePath) {
  installModuleResolution()
  const byId = new Map()
  const location = { hash: '', search: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' }

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
    body: stubElement('body'),
    head: stubElement('head'),
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    addEventListener() {},
    fonts: { ready: Promise.resolve() },
  }
  globalThis.location = location
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  // The boot sequence fetches. Every endpoint answers with an empty success
  // envelope, which is the shape these loaders already handle.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [] }), text: async () => '' })
  // The console installs a 30-second refresh interval at module scope. A live
  // timer would keep `node --test` from exiting.
  globalThis.setInterval = () => 0

  return import(new URL(relativePath, PUBLIC_ROOT).href)
}

// ---------------------------------------------------------------
// src/pii.js — geo coarsening, end to end through the export
// ---------------------------------------------------------------

describe('pii geo coarsening', () => {
  const COARSE = { coarsenGeoToH3Cell: 4 }

  it('coarsens a record on the prime meridian', () => {
    // 36.8°E to the nearest 1/16° is 36.8125. Under the old
    // `record.latitude && record.longitude` this record kept its exact
    // longitude and carried no `geo_precision_deg` at all: the privacy control
    // did not apply, and nothing said so.
    const out = redactPii({ latitude: 3.1167, longitude: 0, note: 'on the meridian' }, COARSE)
    assert.equal(out.geo_precision_deg, 1 / 16)
    assert.equal(out.longitude, 0)
    assert.ok(out.latitude !== 3.1167, 'latitude must be coarsened too')
  })

  it('coarsens a record on the equator', () => {
    const out = redactPii({ latitude: 0, longitude: 36.8 }, COARSE)
    assert.equal(out.geo_precision_deg, 1 / 16)
    assert.equal(out.latitude, 0)
    assert.notEqual(out.longitude, 36.8)
  })

  it('coarsens a record at the intersection of both zero lines', () => {
    const out = redactPii({ latitude: 0, longitude: 0 }, COARSE)
    assert.equal(out.geo_precision_deg, 1 / 16)
    assert.equal(out.latitude, 0)
    assert.equal(out.longitude, 0)
  })

  it('coarsens a negative coordinate rather than treating it as absent', () => {
    const out = redactPii({ latitude: -8.767, longitude: 27.4 }, COARSE)
    assert.equal(out.geo_precision_deg, 1 / 16)
    assert.equal(out.latitude, -8.75)
    assert.notEqual(out.longitude, 27.4)
  })

  it('coarsens a string-number coordinate', () => {
    const numeric = redactPii({ latitude: 3.1167, longitude: 36.8 }, COARSE)
    const asString = redactPii({ latitude: '3.1167', longitude: '36.8' }, COARSE)
    assert.equal(asString.geo_precision_deg, 1 / 16)
    assert.equal(asString.latitude, numeric.latitude)
    assert.equal(asString.longitude, numeric.longitude)
  })

  it('leaves a record with no determined coordinate alone', () => {
    // Not determined is not Null Island. `Number(null)` and `Number('')` are
    // both 0, so a naive `Number.isFinite(Number(x))` would coarsen all three
    // of these onto the equator and the prime meridian.
    for (const record of [
      { latitude: null, longitude: 36.8 },
      { latitude: 3.1167, longitude: null },
      { latitude: null, longitude: null },
      { latitude: undefined, longitude: undefined },
      { latitude: '', longitude: '' },
      { latitude: 'north-ish', longitude: 'somewhere' },
      { latitude: NaN, longitude: 36.8 },
    ]) {
      const out = redactPii(record, COARSE)
      assert.equal(
        out.geo_precision_deg, undefined,
        `a record with no usable coordinate must not be coarsened: ${JSON.stringify(record)}`,
      )
      assert.equal(out.latitude, record.latitude)
      assert.equal(out.longitude, record.longitude)
    }
  })

  it('never writes a coordinate the record did not carry', () => {
    const out = redactPii({ latitude: 0, longitude: 0 }, COARSE)
    assert.ok('latitude' in out && 'longitude' in out, 'the record keeps its own fields')
    const absent = redactPii({ note: 'no coordinates at all' }, COARSE)
    assert.ok(!('latitude' in absent), 'coarsening must not invent a latitude')
    assert.ok(!('geo_precision_deg' in absent), 'and must not claim a precision it did not apply')
  })
})

// ---------------------------------------------------------------
// public/districts/app.js — the district officer's SVG map
// ---------------------------------------------------------------

describe('district SVG map coordinates', () => {
  let buildSvgMap
  let coordinatePair

  before(async () => {
    const mod = await loadBrowserModule('districts/app.js')
    buildSvgMap = mod.buildSvgMap
    coordinatePair = mod.coordinatePair
  })

  const district = { name: 'Test District', center: { lat: 3.1167, lon: 36.8 } }

  /** How many record dots the rendered SVG carries, excluding the centre mark. */
  const plottedDots = (svg) => svg.split('<circle').length - 3

  const record = (extra) => ({ event_type: 'flood', ...extra })

  it('plots a record on the prime meridian', () => {
    // Dropped under `.filter(p => p.lat && p.lon)`: longitude 0 is falsy.
    const svg = buildSvgMap(district, [record({ latitude: 3.4, longitude: 0 })])
    assert.equal(plottedDots(svg), 1)
    assert.match(svg, /1 recorded location plotted/)
  })

  it('plots a record on the equator', () => {
    const svg = buildSvgMap(district, [record({ latitude: 0, longitude: 36.9 })])
    assert.equal(plottedDots(svg), 1)
    assert.match(svg, /1 recorded location plotted/)
  })

  it('plots a record at both zero lines', () => {
    const svg = buildSvgMap(district, [record({ latitude: 0, longitude: 0 })])
    assert.equal(plottedDots(svg), 1)
    assert.match(svg, /1 recorded location plotted/)
  })

  it('plots negative coordinates', () => {
    const svg = buildSvgMap(district, [record({ latitude: -3.4, longitude: -36.9 })])
    assert.equal(plottedDots(svg), 1)
  })

  it('plots a string-number coordinate', () => {
    const svg = buildSvgMap(district, [record({ latitude: '3.4', longitude: '36.9' })])
    assert.equal(plottedDots(svg), 1)
  })

  it('accepts the short field naming, zero included', () => {
    const svg = buildSvgMap(district, [{ event_type: 'flood', lat: 0, lon: 0 }])
    assert.equal(plottedDots(svg), 1)
  })

  it('skips only records with no determined coordinate, and says how many', () => {
    const svg = buildSvgMap(district, [
      record({ latitude: 3.4, longitude: 36.9 }),
      record({ latitude: 3.5, longitude: null }),
      record({ latitude: 3.6, longitude: 37.0 }),
      { event_type: 'flood', latitude: null, longitude: null },
      // `??` shields null from the `r.lat` fallback but not an empty string,
      // and `Number('')` is 0 — so a blank field is the case that gets a dot
      // planted on Null Island by a guard that only asks "is this finite?".
      { event_type: 'flood', latitude: '', longitude: 36.95 },
    ])
    assert.equal(plottedDots(svg), 2)
    // The old label said "2 plotted" over 2 dots and never mentioned the
    // records that vanished, which reads as "that is all of them".
    assert.match(svg, /2 recorded locations plotted/)
    assert.match(svg, /3 records had no usable coordinates and are not shown/)
  })

  it('reads the centre as a coordinate, not as a filter input', () => {
    // The centre is always drawn. It was never filtered, but it was projected
    // with the raw fields, so a `null` centre produced NaN in the viewBox.
    const svg = buildSvgMap({ name: 'Null Island', center: { lat: null, lon: null } }, [])
    assert.doesNotMatch(svg, /NaN/)
    assert.match(svg, /0 recorded locations plotted/)
  })

  it('separates a present coordinate from an absent one', () => {
    assert.deepEqual(coordinatePair(0, 0), { lat: 0, lon: 0 })
    assert.deepEqual(coordinatePair('0', '-0'), { lat: 0, lon: -0 })
    assert.equal(coordinatePair(null, 0), null)
    assert.equal(coordinatePair(0, undefined), null)
    assert.equal(coordinatePair(0, ''), null)
    assert.equal(coordinatePair('', 0), null)
    assert.equal(coordinatePair(NaN, 0), null)
    assert.equal(coordinatePair(0, Infinity), null)
    assert.equal(coordinatePair('east', 0), null)
  })
})

// ---------------------------------------------------------------
// public/app.js — the severity filter
// ---------------------------------------------------------------

describe('map severity filter', () => {
  let evaluateMapFilters
  let isUndetermined

  before(async () => {
    const mod = await loadBrowserModule('app.js')
    evaluateMapFilters = mod.evaluateMapFilters
    isUndetermined = mod.isUndetermined
  })

  const at = (severity, extra = {}) => ({ latitude: 3.1167, longitude: 36.8, severity, ...extra })
  const shown = (record, filters) => evaluateMapFilters(record, filters).shown

  it('admits a record whose severity matches the filter', () => {
    assert.equal(shown(at('critical'), { severity: 'critical' }), true)
  })

  it('excludes a record whose severity is not the one asked for', () => {
    assert.equal(shown(at('low'), { severity: 'critical' }), false)
  })

  it('excludes an undetermined record from a specific severity filter', () => {
    // The defect: `sevFilter && r.severity && r.severity !== sevFilter` let
    // `severity: null` — the honest "not determined" this project goes out of
    // its way to emit — through every filter, so "Critical" showed everything.
    for (const severity of [null, undefined, '']) {
      const verdict = evaluateMapFilters(at(severity), { severity: 'critical' })
      assert.equal(verdict.shown, false, `severity ${JSON.stringify(severity)} must not pass a specific filter`)
      assert.equal(verdict.undetermined, 'severity', 'and must be reported as undetermined, not merely mismatched')
    }
  })

  it('admits every undetermined record when no severity filter is set', () => {
    for (const severity of [null, undefined, '']) {
      assert.equal(shown(at(severity), {}), true)
      assert.equal(shown(at(severity), { severity: '' }), true)
    }
  })

  it('does not treat a severity of zero as undetermined', () => {
    // The other direction. Nothing emits a numeric severity today; a filter
    // that quietly admits `0` as "every severity" is the same conflation.
    assert.equal(isUndetermined(0), false)
    assert.equal(shown(at(0), { severity: 'critical' }), false)
    assert.equal(evaluateMapFilters(at(0), { severity: 'critical' }).undetermined, null)
  })

  it('applies the same rule to the source filter', () => {
    assert.equal(shown(at('critical', { source: null }), { source: 'gdacs' }), false)
    assert.equal(evaluateMapFilters(at('critical', { source: null }), { source: 'gdacs' }).undetermined, 'source')
    assert.equal(shown(at('critical', { source: 'gdacs' }), { source: 'gdacs' }), true)
  })

  it('reports the severity reason before the source reason', () => {
    const verdict = evaluateMapFilters({ latitude: 0, longitude: 0, severity: null, source: null }, {
      severity: 'high', source: 'gdacs',
    })
    assert.equal(verdict.shown, false)
    assert.equal(verdict.undetermined, 'severity')
  })

  it('still filters on time and cold-chain after the severity change', () => {
    const recent = { ...at('critical'), occurred_at: new Date().toISOString() }
    const old = { ...at('critical'), occurred_at: '2001-01-01T00:00:00.000Z' }
    const since = new Date(Date.now() - 24 * 3600 * 1000)
    assert.equal(shown(recent, { severity: 'critical', since }), true)
    assert.equal(shown(old, { severity: 'critical', since }), false)
    assert.equal(shown(at('critical'), { coldChainOnly: true }), false)
    assert.equal(shown(at('critical', { metadata: { cold_chain: true } }), { coldChainOnly: true }), true)
  })
})

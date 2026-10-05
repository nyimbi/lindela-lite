/**
 * WEB-01 and WEB-03 from docs/improvements/defects.md.
 *
 * WEB-01 is stale. The audited finding was true when written — `p.lat && p.lon`
 * at `public/districts/app.js:208` and `if (!lat || !lon) continue` at `:229` are
 * the truthiness-on-a-coordinate bug, and both dropped every district record
 * sitting on the equator or the prime meridian. The site has since grown an
 * exported `coordinatePair` that rules absence out explicitly, and
 * `test/falsy-zero.test.js` covers it. The tests below are a second guard on the
 * same invariant, kept here because WEB-01 is one of the two findings this file
 * is scoped to. The comment on `coordinatePair` records the trap: the tidier
 * `Number.isFinite(Number(x))` looks correct and reinstates the bug, because
 * `Number(null)` and `Number('')` are both 0 and put Null Island on the map.
 *
 * WEB-03 was real, and the scale is the substance of the fix. These assert the
 * computation — the extent and bar geometry — not the markup, because there is
 * no DOM harness in this repo beyond a stub. `setDeltaCard` is additionally
 * driven directly, because "unlabelled" is only a defect if the axis stays
 * unlabelled; the rendered output is the return value under test there.
 */

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { installModuleResolution } from './browser-env.mjs'

const PUBLIC_ROOT = new URL('../public/', import.meta.url)

// ---------------------------------------------------------------
// Browser module sandbox — stands in for the browser's /shared/... resolution
// ---------------------------------------------------------------

function stubElement(tag = 'DIV') {
  return {
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
}

const byId = new Map()
const location = { hash: '', search: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' }

function installDom() {
  installModuleResolution()
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
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: [] }),
    text: async () => '',
  })
  globalThis.setInterval = () => 0
}

const loadBrowserModule = (relativePath) => import(new URL(relativePath, PUBLIC_ROOT).href)
const el = (id) => document.getElementById(id)

// ---------------------------------------------------------------
// WEB-01 — a district map drops every record on the equator or prime meridian
// ---------------------------------------------------------------

describe('WEB-01 — district map coordinates', () => {
  let buildSvgMap
  let coordinatePair

  before(async () => {
    installDom()
    const mod = await loadBrowserModule('districts/app.js')
    buildSvgMap = mod.buildSvgMap
    coordinatePair = mod.coordinatePair
  })

  const district = { name: 'Test', center: { lat: -1.28, lon: 36.81 } }
  const at = (latitude, longitude) => ({
    latitude, longitude, severity: 'high', event_type: 'flood',
  })
  const circles = (svg) => (svg.match(/<circle/g) || []).length
  // The district centre contributes two circles; every plotted record one.
  const plotted = (svg) => circles(svg) - 2

  it('keeps a record on the prime meridian', () => {
    // longitude 0 is falsy. Under `p.lat && p.lon` this record never reached
    // the map and the "N recorded locations" label silently undercounted.
    assert.equal(plotted(buildSvgMap(district, [at(-1.28, 0)])), 1)
  })

  it('keeps a record on the equator', () => {
    // latitude 0 is falsy, same defect from the other axis.
    assert.equal(plotted(buildSvgMap(district, [at(0, 36.81)])), 1)
  })

  it('keeps the record at Null Island, 0/0', () => {
    assert.equal(plotted(buildSvgMap(district, [at(0, 0)])), 1)
  })

  it('keeps a record at negative zero longitude', () => {
    // `-0` is a coordinate. It is falsy, and it is not the string ''.
    assert.equal(plotted(buildSvgMap(district, [at(-1.28, -0)])), 1)
  })

  it('keeps a record whose coordinates arrive as strings', () => {
    const r = { lat: '0', lon: '0', severity: 'low', event_type: 'flood' }
    assert.equal(plotted(buildSvgMap(district, [r])), 1)
  })

  it('drops only records with genuinely absent coordinates', () => {
    const svg = buildSvgMap(district, [at(0, 0), { severity: 'low' }, { lat: null, lon: 5 }])
    assert.equal(plotted(svg), 1)
    // The shortfall is named rather than absorbed, so the count on the map is
    // answerable from the map.
    assert.match(svg, /2 records had no usable coordinates and are not shown/)
  })

  it('refuses a pair that is one axis short, without inferring the other', () => {
    assert.equal(coordinatePair(0, null), null)
    assert.equal(coordinatePair(null, 0), null)
    assert.equal(coordinatePair(undefined, 36.8), null)
    assert.equal(coordinatePair(3.4, ''), null)
  })

  it('refuses Null Island arriving as null or empty string', () => {
    // The trap: `Number.isFinite(Number(x))` is true for null and '' because
    // both coerce to 0, so it reinstates the original defect. A record with
    // `latitude: null` must not become a dot at 0°,0.
    assert.equal(coordinatePair(null, null), null)
    assert.equal(coordinatePair('', ''), null)
    assert.equal(coordinatePair(NaN, 0), null)
    assert.equal(coordinatePair(0, Infinity), null)
  })

  it('accepts zero in either naming and either sign', () => {
    assert.deepEqual(coordinatePair(0, 0), { lat: 0, lon: 0 })
    assert.deepEqual(coordinatePair('0', '36.81'), { lat: 0, lon: 36.81 })
    assert.equal(coordinatePair(-0.5, 0).lon, 0)
    assert.ok(Object.is(coordinatePair(0, '-0').lon, -0))
  })

  it('projects a zero coordinate to the middle of the map rather than dropping it', () => {
    const svg = buildSvgMap(district, [at(0, 0)])
    assert.match(svg, /<circle cx="[\d.]+" cy="[\d.]+" r="4" fill="var\(--sev-high\)"/)
  })
})

// ---------------------------------------------------------------
// WEB-03 — scenario delta bars are truncated, unlabelled, and fixed-origin
// ---------------------------------------------------------------

describe('WEB-03 — scenario delta scale', () => {
  let deltaBar
  let deltaExtent
  let niceExtent
  let setDeltaCard

  before(async () => {
    installDom()
    const mod = await loadBrowserModule('scenarios/app.js')
    deltaBar = mod.deltaBar
    deltaExtent = mod.deltaExtent
    niceExtent = mod.niceExtent
    setDeltaCard = mod.setDeltaCard
  })

  describe('niceExtent — the extent comes from the data', () => {
    it('rounds up to the smallest 1/2/5 that contains the magnitude', () => {
      assert.equal(niceExtent(0.4), 1)
      assert.equal(niceExtent(1), 1)
      assert.equal(niceExtent(2.3), 5)
      assert.equal(niceExtent(5), 5)
      assert.equal(niceExtent(40), 50)
      assert.equal(niceExtent(120), 200)
      assert.equal(niceExtent(2500), 5000)
    })

    it('never returns zero, which would divide by zero and fill every bar', () => {
      // A scenario with no change at all still has to draw a usable axis.
      assert.equal(niceExtent(0), 1)
      assert.equal(niceExtent(null), 1)
      assert.equal(niceExtent(undefined), 1)
      assert.equal(niceExtent('nonsense'), 1)
    })

    it('takes the magnitude, so the axis is symmetric for a negative delta', () => {
      assert.equal(niceExtent(-40), 50)
    })
  })

  describe('deltaExtent — one axis across all three cards', () => {
    it('covers the largest delta on the page', () => {
      // The three cards carry the same quantity in the same units, so one
      // extent makes them comparable. Per-card extents would render a -2, a
      // +19 and a +40 as three equal-length bars.
      assert.equal(deltaExtent([2, 19, -40]), 50)
      assert.equal(deltaExtent([-2, 19, 40]), 50)
    })

    it('ignores absent deltas rather than counting them as zero-length peaks', () => {
      assert.equal(deltaExtent([null, undefined, '', 19]), 20)
    })

    it('falls back to a readable axis when every delta is absent', () => {
      assert.equal(deltaExtent([null, null]), 1)
      assert.equal(deltaExtent([]), 1)
    })
  })

  describe('deltaBar — length is monotonic and never truncated', () => {
    const EXTENT = 50
    const bar = (v) => deltaBar(v, EXTENT)

    it('grows with magnitude, right across the range, and is never clipped', () => {
      // The old geometry was `clamp(40 + v, 4, 80)`: a +2 and a +40 came out at
      // 42px and 80px, and everything past +40 came out identically. That is the
      // truncation — two different answers rendered the same. Here the extent is
      // derived from the values, as it is in `showResults`, so every one of them
      // has room.
      const values = [1, 2, 10, 20, 39, 41, 60, 200, 5000]
      const extent = deltaExtent(values)
      const lengths = values.map((v) => deltaBar(v, extent).lengthPx)
      for (let i = 1; i < lengths.length; i += 1) {
        assert.ok(lengths[i] > lengths[i - 1], `${values[i]} must render longer than ${values[i - 1]}`)
      }
      for (const l of lengths) assert.ok(l <= 48, 'a bar must fit its track')
    })

    it('stops at the track edge when handed a value past the extent', () => {
      // The guard, not the scale. On the real path the extent is computed from
      // the deltas so this never fires; when it does, the bar stops at the
      // track rather than overflowing it.
      assert.equal(deltaBar(120, EXTENT).lengthPx, 48)
      assert.equal(deltaBar(120, EXTENT).ratio, 1)
    })

    it('separates the -2 and +40 delta the finding calls out', () => {
      // Both are legal values of the same score, on the same shared axis.
      const extent = deltaExtent([-2, 40])
      assert.ok(deltaBar(-40, extent).lengthPx > deltaBar(2, extent).lengthPx * 10)
    })

    it('fills the track exactly when the delta equals the extent', () => {
      assert.equal(bar(50).ratio, 1)
      assert.equal(bar(-50).lengthPx, 48)
    })

    it('draws an equal length either side of zero', () => {
      assert.equal(bar(-12.5).lengthPx, bar(12.5).lengthPx)
    })

    it('points the bar away from zero', () => {
      assert.equal(bar(3).direction, 'positive')
      assert.equal(bar(-3).direction, 'negative')
      assert.equal(bar(0).direction, 'none')
    })

    it('draws nothing for a zero delta, and everything for the rest', () => {
      // A zero is a measurement, and it is drawn as no bar at all against a
      // stated axis — not as the minimum 4px stub the clamp forced.
      assert.equal(bar(0).lengthPx, 0)
      assert.ok(bar(0.01).lengthPx > 0)
    })

    it('refuses an absent delta rather than drawing a zero-length bar', () => {
      // null is not 0. An em dash and an empty track are the honest rendering.
      for (const absent of [null, undefined, '', 'abc', NaN, Infinity]) {
        assert.equal(deltaBar(absent, EXTENT), null, `${String(absent)} must not become a bar`)
      }
    })

    it('carries the extent it was drawn on, so the bar is self-describing', () => {
      assert.equal(bar(19).extent, 50)
    })

    it('guards a zero or negative extent instead of dividing by it', () => {
      assert.ok(Number.isFinite(deltaBar(5, 0).lengthPx))
      assert.ok(Number.isFinite(deltaBar(5, -10).lengthPx))
    })
  })

  describe('setDeltaCard — the axis states its extent and units', () => {
    it('labels both ends of the axis and names the unit', () => {
      setDeltaCard('flood', 19.4, 50)
      const html = el('floodBars').innerHTML
      assert.match(html, /−50/)
      assert.match(html, />\+50</)
      assert.match(html, /score points/)
      assert.match(html, /class="delta-zero"/)
    })

    it('spells the delta out for a screen reader, on the axis it was drawn', () => {
      setDeltaCard('flood', -19.4, 50)
      const html = el('floodBars').innerHTML
      assert.match(html, /aria-label="Down 19\.4 score points on an axis running from −50 to \+50 score points\."/)
    })

    it('anchors the bar at the zero rule and grows it the right way', () => {
      setDeltaCard('flood', 25, 50)
      assert.match(el('floodBars').innerHTML, /class="delta-fill positive" style="width:24\.00px"/)

      setDeltaCard('flood', -25, 50)
      assert.match(el('floodBars').innerHTML, /class="delta-fill negative" style="width:24\.00px"/)
    })

    it('says no change rather than drawing a stub bar for a zero delta', () => {
      setDeltaCard('flood', 0, 50)
      const html = el('floodBars').innerHTML
      assert.match(html, /No change in the mean sensitivity score/)
      assert.doesNotMatch(html, /delta-fill/)
      assert.equal(el('floodDelta').textContent, '0.0')
    })

    it('renders an em dash and no chart for an absent delta', () => {
      setDeltaCard('flood', null, 50)
      assert.equal(el('floodDelta').textContent, '—')
      assert.equal(el('floodBars').innerHTML, '')
    })

    it('keeps the delta in score points, not per cent', () => {
      // An earlier revision suffixed '%', which read as a modelled physical
      // outcome rather than a change in an uncalibrated sensitivity score.
      setDeltaCard('flood', 19.4, 50)
      assert.equal(el('floodDelta').textContent, '+19.4')
      assert.doesNotMatch(el('floodDelta').textContent, /%/)
    })

    it('renders the full width of a 0-100 score as a finite, on-axis bar', () => {
      // The score is 0-100, so a delta is bounded by 100 in practice. The largest
      // value the formatter handles in plain decimals is far below that.
      setDeltaCard('flood', 100, 100)
      const html = el('floodBars').innerHTML
      assert.match(html, /aria-label="Up 100\.0 score points on an axis running from −100 to \+100 score points\."/)
      assert.match(html, /class="delta-fill positive" style="width:48\.00px"/)
    })
  })
})
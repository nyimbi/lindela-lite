#!/usr/bin/env node
/**
 * The CO dashboard's period honesty (WEB-08) and the i18n gate (WEB-11).
 *
 * `public/co/app.js` runs a boot sequence at import time, so the DOM stub below
 * is the one `web-console.test.js` uses, and the fixes are written so the
 * decision each one makes is a function the test can drive directly.
 *
 * WEB-08 was that `/api/v1/kpi/monthly-series` has no period parameter: it
 * returns the last N months ending *this month*, while the KPI tiles beside it
 * come from `/api/v1/kpi/quarterly?quarter=Q&year=Y`. Pick any quarter but the
 * current one and the charts described months after the period in their own
 * heading — a reader comparing a tile against the chart under it was reading two
 * different quarters, presented as one. Nothing marked them stale either:
 * nothing was hidden at the start of a load, and the announcement counted a
 * section as loaded when it was merely *not hidden*.
 *
 * Every test here fails against the pre-fix code, for the reason named in its
 * assertion rather than by coincidence.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { before, describe, it } from 'node:test'
import { installModuleResolution } from './browser-env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_ROOT = path.join(ROOT, 'public')

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

/** The ids `public/co/index.html` names, so the stub answers like the page. */
const CO_IDS = [
  'quarter-select', 'year-select', 'locale-select', 'export-btn', 'loading-banner',
  'load-status', 'load-error', 'kpi-grid', 'cohort-body', 'equity-body', 'qoq-body',
  'histogram', 'feedback-body', 'trend-grid', 'trend-window',
  'sig-hash', 'gen-time', 'main',
  'kpi-section', 'trend-section', 'cohort-section', 'equity-section', 'qoq-section',
  'histogram-section', 'feedback-section',
]

const els = new Map()
function el(id) {
  if (!els.has(id)) els.set(id, stubElement())
  return els.get(id)
}

async function loadCo() {
  installModuleResolution()
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: 'http://localhost/' } }
  globalThis.document = {
    getElementById: (id) => el(id),
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => stubElement(tag),
    documentElement: stubElement('html'),
    body: stubElement('body'),
    readyState: 'complete',
    addEventListener() {},
  }
  globalThis.location = { href: 'http://localhost/' }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [] }), text: async () => '' })

  return import(new URL('co/app.js', `file://${PUBLIC_ROOT}/`).href)
}

/** A trailing series, as the server builds it: the last `count` months, ending now. */
function monthlySeries(endYear, endMonth, count = 20) {
  const out = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(endYear, endMonth - 1 - i, 1))
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    out.push({ month, people_reached: 100, warning_to_action_median_hours: 2, false_alert_rate: 5, cold_chain_protection_rate: 90 })
  }
  return out
}

/** Point every fetch at the same responses and record the URLs asked for. */
function routeFetch(routes) {
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    for (const [fragment, res] of routes) {
      if (String(url).includes(fragment)) return res
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }), text: async () => '' }
  }
  return urls
}

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }), text: async () => '' })
const fail = () => ({ ok: false, status: 503, json: async () => ({ success: false, error: 'down' }), text: async () => '' })

const KPI = {
  people_reached: 1200, percent_children_u18: 40, percent_women_and_girls: 50,
  percent_pwd: 5, community_reporters_count: 30, youth_mappers_count: 4,
  oss_releases_count: 2, warning_to_action_median_hours: 1.5, api_uptime_pct: 99.9,
  cohort: { total: 1200, u18: 480, women_and_girls: 600, pwd: 60, refugees_idps: 10 },
  generated_at: '2026-10-01T00:00:00.000Z',
}

// ================================================================
// WEB-08 — the charts and the KPI tiles must describe one period
// ================================================================

let co

describe('public/co/app.js — the period a chart describes', () => {
  before(async () => { co = await loadCo() })

  it('asks for enough months to reach back past the selected quarter', () => {
    const oct = new Date(Date.UTC(2026, 9, 15))
    // Q2 2026 ended in June; the server's trailing window starts in November
    // 2025 at monthsBack=12, which is four months short of the quarter.
    assert.equal(co.monthsBackFor('Q2', 2026, 12, oct), 16)
    assert.equal(co.monthsBackFor('Q4', 2026, 12, oct), 12, 'the current quarter needs no extra')
    assert.equal(co.monthsBackFor('Q4', 2027, 12, oct), 12, 'a future quarter cannot need less than the window')
    assert.equal(co.monthsBackFor('nonsense', 2026, 12, oct), 12, 'an unreadable quarter asks for the default, not NaN')
  })

  it('keeps out every month after the selected quarter', () => {
    const series = monthlySeries(2026, 10) // 2025-03 … 2026-10
    const win = co.selectTrendWindow(series, 'Q2', 2026, 12)
    assert.equal(win.length, 12)
    assert.equal(win[0].month, '2025-07', 'the twelve months ending in the selected quarter')
    assert.equal(win[win.length - 1].month, '2026-06')
    assert.ok(!win.some((m) => m.month > '2026-06'),
      'a month after the quarter in the heading is a month of the wrong period')
  })

  it('orders the window oldest first regardless of what the server sent', () => {
    const win = co.selectTrendWindow(monthlySeries(2026, 10).reverse(), 'Q3', 2026, 12)
    assert.deepEqual([win[0].month, win[win.length - 1].month], ['2025-10', '2026-09'])
    assert.deepEqual(win.map((m) => m.month), [...win.map((m) => m.month)].sort(),
      'a sparkline that plots out of order plots a shape that is not there')
  })

  it('returns nothing rather than a partial window for a period with no data', () => {
    assert.deepEqual(co.selectTrendWindow(monthlySeries(2026, 10), 'Q1', 2024, 12), [],
      'fewer than twelve months of history is a gap, not a chart')
    assert.deepEqual(co.selectTrendWindow([], 'Q2', 2026, 12), [])
    assert.deepEqual(co.selectTrendWindow(monthlySeries(2026, 10), null, 2026, 12), [])
  })

  it('names the window it plotted instead of claiming "last 12 months"', () => {
    assert.equal(co.windowLabel(co.selectTrendWindow(monthlySeries(2026, 10), 'Q2', 2026)), '2025-07 → 2026-06')
    assert.equal(co.windowLabel([]), '')
  })

  describe('through load()', () => {
    it('requests a period-aware series, not the default trailing one', async () => {
      el('quarter-select').value = 'Q2'
      el('year-select').value = '2026'
      const urls = routeFetch([['/monthly-series', ok(monthlySeries(2026, 10))]])
      await co.load()
      const series = urls.find((u) => u.includes('/api/v1/kpi/monthly-series'))
      assert.match(series, /monthsBack=16/,
        'without the parameter the server returns months ending now, whatever the reader selected')
    })

    it('stamps the plotted range on the section', async () => {
      el('quarter-select').value = 'Q2'
      el('year-select').value = '2026'
      routeFetch([['/monthly-series', ok(monthlySeries(2026, 10))]])
      await co.load()
      assert.equal(el('trend-window').textContent, '2025-07 → 2026-06')
    })

    it('shows no chart at all when the selected period predates the data', async () => {
      el('quarter-select').value = 'Q1'
      el('year-select').value = '2024'
      routeFetch([['/monthly-series', ok(monthlySeries(2026, 10))]])
      await co.load()
      assert.equal(el('trend-section').hidden, true,
        'an empty chart under a heading naming a quarter is better than the wrong twelve months')
      assert.equal(el('qoq-section').hidden, true)
    })

    it('does not leave the previous period on screen when a section fails', async () => {
      el('quarter-select').value = 'Q2'
      el('year-select').value = '2026'
      routeFetch([
        ['/kpi/quarterly', ok(KPI)],
        ['/equity/by-district', ok([{ district: 'Jubaa', dispatched: 40, acknowledged: 30, dispatch_precision_pct: 75, determined_dispatched: 9 }])],
        ['/monthly-series', ok(monthlySeries(2026, 10))],
      ])
      await co.load()
      assert.equal(el('equity-section').hidden, false)
      assert.match(el('equity-body').innerHTML, /Jubaa/)

      // Same page, next quarter, and the equity endpoint is down.
      el('quarter-select').value = 'Q3'
      routeFetch([
        ['/kpi/quarterly', ok(KPI)],
        ['/equity/by-district', fail()],
        ['/monthly-series', ok(monthlySeries(2026, 10))],
      ])
      await co.load()
      assert.equal(el('equity-section').hidden, true,
        'the previous quarter\'s districts, still on screen under the new quarter\'s heading')
      assert.equal(el('equity-body').innerHTML, '', 'and nothing left in the table for a screen reader to read out')
    })

    it('does not count a section as loaded because it is not hidden', async () => {
      el('quarter-select').value = 'Q2'
      el('year-select').value = '2026'
      routeFetch([
        ['/kpi/quarterly', ok(KPI)],
        ['/equity/by-district', fail()],
        ['/monthly-series', ok(monthlySeries(2026, 10))],
      ])
      await co.load()
      // A 200 that paints nothing is not a loaded section either.
      el('quarter-select').value = 'Q1'
      routeFetch([
        ['/kpi/quarterly', ok(KPI)],
        ['/monthly-series', ok([])],
      ])
      await co.load()

      const state = co.loadState(
        ['kpi-section', 'cohort-section', 'trend-section', 'qoq-section',
         'equity-section', 'histogram-section', 'feedback-section'],
        ['kpi-section', 'cohort-section'],
      )
      assert.equal(state.loaded, 2)
      assert.deepEqual(state.unpainted, ['trend-section', 'qoq-section', 'equity-section', 'histogram-section', 'feedback-section'])
      assert.match(el('load-error').innerHTML, /could not be loaded|could not/,
        'a page missing five of seven sections says so where a reader meets it')
    })

    it('reports a total failure rather than a clean load', async () => {
      routeFetch([['/', fail()]])
      await co.load()
      assert.match(el('load-error').innerHTML, /did not load|Could not load|did not/)
      assert.equal(el('load-status').textContent.length > 0, true)
    })
  })
})

// ================================================================
// WEB-11 — coverage, and a gate that catches the next regression
// ================================================================

/** A runnable copy of the check over a copy of the tree it reads. */
function sandbox(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-i18n-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.cpSync(path.join(ROOT, 'scripts', 'check-i18n.mjs'), path.join(dir, 'scripts', 'check-i18n.mjs'))
  fs.mkdirSync(path.join(dir, 'public', 'i18n'), { recursive: true })
  for (const file of fs.readdirSync(path.join(PUBLIC_ROOT, 'i18n'))) {
    if (file.endsWith('.json')) fs.cpSync(path.join(PUBLIC_ROOT, 'i18n', file), path.join(dir, 'public', 'i18n', file))
  }
  for (const sub of fs.readdirSync(PUBLIC_ROOT)) {
    const html = path.join(PUBLIC_ROOT, sub, 'index.html')
    if (fs.existsSync(html)) {
      fs.mkdirSync(path.join(dir, 'public', sub), { recursive: true })
      fs.cpSync(html, path.join(dir, 'public', sub, 'index.html'))
    }
  }
  mutate(dir)
  try {
    const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts', 'check-i18n.mjs')], { encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' }
  }
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'i18n', rel), 'utf8'))

describe('WEB-11 — i18n coverage and the gate over it', () => {
  it('translates every CO string the page shows into Swahili', () => {
    const sw = readJson('sw.json')
    const en = readJson('en.json')
    // co.kpi_title is the heading of the KPI Summary section. Swahili was
    // offered on this page while the key was absent, and the surface's own
    // t() leaves the English text standing under a Swahili flag.
    assert.equal(sw['co.kpi_title'], 'Muhtasari wa KPI')
    for (const key of Object.keys(en).filter((k) => k.startsWith('co.'))) {
      assert.ok(sw[key], `co.kpi_title was one missing key among many; ${key} is missing now`)
    }
  })

  it('carries the shared footer string into Swahili too', () => {
    // The CHW page offers Swahili and renders footer.powered through the shared
    // runtime, which resolves a missing key to the key itself: the reader saw
    // the literal text "footer.powered" in the footer.
    assert.equal(readJson('sw.json')['footer.powered'], 'Inaendeshwa na Lindela Lite')
  })

  it('does not claim a window it cannot name', () => {
    assert.equal(readJson('en.json')['co.trend_title'], 'Trend',
      '"last 12 months" is false for every quarter but the current one, and the range is printed beneath')
    assert.equal(readJson('sw.json')['co.trend_title'], 'Mwenendo')
  })

  it('passes on the tree as it stands', () => {
    const result = sandbox(() => {})
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /i18n ok/)
  })

  it('fails when a locale loses a translated string', () => {
    const result = sandbox((dir) => {
      const p = path.join(dir, 'public', 'i18n', 'sw.json')
      const sw = JSON.parse(fs.readFileSync(p, 'utf8'))
      for (const key of Object.keys(sw)) if (key.startsWith('chw.')) delete sw[key]
      fs.writeFileSync(p, JSON.stringify(sw))
    })
    assert.equal(result.code, 1, 'the CHW strings this gate exists to protect were deleted and it passed')
    const total = Object.keys(JSON.parse(fs.readFileSync(path.join(PUBLIC_ROOT, 'i18n', 'en.json'), 'utf8'))).length
    assert.match(result.stderr, new RegExp(`sw\\.json covers \\d+ of ${total} keys, below the recorded floor`))
  })

  it('fails when a surface offers a locale it cannot render', () => {
    const result = sandbox((dir) => {
      const p = path.join(dir, 'public', 'co', 'index.html')
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(
        '<option value="sw">Swahili</option>',
        '<option value="sw">Swahili</option>\n          <option value="so">Soomaali</option>'))
      const q = path.join(dir, 'public', 'i18n', 'so.json')
      const so = JSON.parse(fs.readFileSync(q, 'utf8'))
      delete so['co.kpi_title']
      fs.writeFileSync(q, JSON.stringify(so))
    })
    assert.equal(result.code, 1, 'Soomaali is 0% of the co.* namespace and the picker offered it anyway')
    assert.match(result.stderr, /co offers "so"/)
  })

  it('fails when a page names a key no catalogue defines', () => {
    const result = sandbox((dir) => {
      const p = path.join(dir, 'public', 'co', 'index.html')
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(
        'data-i18n="co.kpi_title"', 'data-i18n="co.kpi_title_needs_a_speaker"'))
    })
    assert.equal(result.code, 1, 'a key absent from en.json renders as the key name itself')
    assert.match(result.stderr, /co.kpi_title_needs_a_speaker/)
  })

  it('reports coverage and the surfaces that have none', () => {
    const { stdout } = sandbox(() => {})
    // The key count is read, not written down. It was hardcoded at 227 and went
    // stale the moment three surfaces were layered, at which point the assertion
    // would have failed for the wrong reason — or, had the regex been loose
    // enough, kept passing while measuring a catalogue nobody had.
    const total = Object.keys(JSON.parse(fs.readFileSync(path.join(PUBLIC_ROOT, 'i18n', 'en.json'), 'utf8'))).length
    assert.match(stdout, new RegExp(`Catalogue coverage against en\\.json \\(${total} keys\\)`))
    for (const code of ['am', 'ar', 'din', 'en', 'fr', 'km', 'nk', 'pt', 'so', 'sw']) {
      assert.match(stdout, new RegExp(`\\n  ${code}\\s+\\d+/${total}\\s+\\d+\\.\\d%`), `coverage for ${code} is reported`)
    }
    // Every surface has a layer now, so the note is gone — and this used to
    // assert the opposite, which meant adding an i18n layer to a surface failed
    // the test that was supposed to be watching for a surface without one. The
    // next test proves the gate still names one when there is one to name.
    assert.doesNotMatch(stdout, /surfaces with no i18n layer at all:/,
      'no surface is left unlayered')
    assert.doesNotMatch(stdout, /^\s+(districts|co|portal|chw|focal-point|parametric|scenarios)\s+asks for/m,
      'a surface with an i18n layer still asks for a key no catalogue defines')
  })

  it('still names a surface that has no layer', () => {
    // The counterpart to the assertion above, because "the list is empty" and
    // "the gate stopped looking" look identical from the outside. Stripping the
    // keys out of one surface must bring the note back with that surface's name
    // in it — otherwise a future regression in the detector is invisible.
    const { stdout } = sandbox((dir) => {
      const p = path.join(dir, 'public', 'districts', 'index.html')
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\sdata-i18n(-[a-z]+)?="[^"]*"/g, ''))
    })
    const unlayered = stdout.match(/surfaces with no i18n layer at all: (.*)/)?.[1] ?? ''
    assert.match(unlayered, /districts/, 'and it names the surface by name, not just that one exists')
  })

  it('still fails for a locale it has already recorded as short', () => {
    // Soomaali is 44% of the catalogue and the CHW page still cannot render
    // its footer. Named, counted, printed — and a second missing key fails.
    const result = sandbox((dir) => {
      const p = path.join(dir, 'public', 'i18n', 'so.json')
      const so = JSON.parse(fs.readFileSync(p, 'utf8'))
      delete so['chw.title']
      fs.writeFileSync(p, JSON.stringify(so))
    })
    assert.equal(result.code, 1, 'the known-untranslated list absorbs one key, not a class')
    assert.match(result.stderr, /chw\.title/)
  })
})

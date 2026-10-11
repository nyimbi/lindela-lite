#!/usr/bin/env node
/**
 * ARC-06 — the console must not present a fetched page as the whole set.
 *
 * `public/shared/paging.js` was a second paging implementation beside the
 * server's `parseLimit`/`matchedAndPage`, and the registered worry was that a
 * clamp fixed in one would persist in the other. Measured, the defect is worse
 * and simpler than that: the two never disagreed by arithmetic because the
 * client's numbers were not the server's at all. Every list route answers with
 * `{data, returned, total, has_more, next_cursor}` and the console read `data`,
 * then handed `data.length` to `pageWindow` and `renderPager` as the size of the
 * set.
 *
 * On `/api/v1/alert-events` against a store of 61 alerts with `?limit=30` that
 * is two wrong answers at once. The pager renders "Showing 1–25 of 30" and stops
 * — the other 31 rows are unreachable, because the client pages inside the
 * window it already holds and never follows `next_cursor` — and the row count
 * reads as a complete list of 30 over a set the envelope says is 61. A silent
 * cap reading as completeness, which is the one failure the file's own
 * `pagerSummary` was written to prevent and then never called from anywhere.
 *
 * `listScope` is the seam: it takes the envelope and returns what may honestly
 * be claimed. The pure arithmetic is tested in `test/paging.test.js`.
 *
 * **Why this file drives the real renders.** It used to assert on the source
 * text of the two call sites — `assert.match(APP_CODE, /renderPager\(\$\(…/` —
 * which is QUA-02's exemplar. That broke the moment ENH-81 renamed a local
 * (`scope.total` → `walked.total`) while the behaviour stayed correct, which is
 * the failure mode exactly: a test that fails on a rename and passes on a
 * regression. The three wiring tests below now observe the numbers the pager is
 * actually handed — the alerts rail through the real boot, the reports panel
 * through its real `mount()` — so a rename cannot touch them and a revert to
 * `filtered.length` fails them.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, describe, it } from 'node:test'

import { installBrowserEnv } from './browser-env.mjs'
import { listScope, pageWindow } from '../public/shared/paging.js'
import { esc, truncate } from '../public/shared/fmt.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_ROOT = new URL('../public/', import.meta.url)
const INDEX = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')

let renderPagerScope

before(async () => {
  installBrowserEnv()
  const mod = await import(new URL('app.js', PUBLIC_ROOT).href)
  renderPagerScope = mod.renderPagerScope
})

/* ---------------------------------------------------------------- helpers */

/** A minimal element stand-in: the function writes `textContent` and `hidden`. */
const node = () => ({ textContent: '', hidden: true })

const envelope = (over = {}) => ({
  data: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}` })),
  returned: 30,
  limit: 30,
  total: 61,
  has_more: true,
  next_cursor: 'YTM0',
  ...over,
})

/**
 * Boot the console against a stubbed store and hand back the elements it wrote.
 *
 * A fresh specifier per call, because ESM caches by URL: two scenarios sharing
 * one `app.js` URL would run the second against the first's module state, and
 * the second assertion would be measuring the first boot. The module's own
 * top-level `await refresh({ first: true })` means the import resolving *is* the
 * boot having finished — including the renders — so there is no timer to wait
 * on and nothing to poll.
 *
 * `fetch` is answered by URL, so a scenario states its envelope rather than
 * driving a server: what is under test is what the console does with the
 * numbers, not where they came from.
 */
let boots = 0
async function boot({ alerts, health = { storage: { mode: 'json' } } }) {
  boots += 1
  const elements = new Map()
  installBrowserEnv({
    elements,
    respond: (url) => {
      if (url.includes('/api/v1/alert-events')) return { body: alerts }
      if (url.includes('/api/v1/health')) return { body: { success: true, data: health } }
      return undefined
    },
  })
  await import(new URL(`app.js?boot=${boots}`, PUBLIC_ROOT).href)
  return elements
}

/** The `Showing a–b of N` line `renderPager` writes, or null if it wrote none. */
const pagerStatus = (host) => (host?.innerHTML || '').match(/pagination-status">([^<]*)/)?.[1] ?? null

/**
 * A console object for `panels/reports.js`, with the pager observed.
 *
 * `renderPager` is a recorder rather than a stub of the thing under test: the
 * panel's obligation is to *pass* the scope total, and the third argument is
 * where that obligation is discharged. `listScope` is the real one, so the
 * panel is exercised against the arithmetic the console uses.
 */
function reportsConsole({ state, onPager }) {
  const calls = []
  const seen = { listScope: 0 }
  return {
    calls,
    console_: {
      // The panel writes `innerHTML` and then binds `[data-action]` on the
      // container; the stub has to answer `querySelectorAll` with an empty list
      // or the render dies before it reaches the pager, which is the call under
      // test. Everything else is a field the panel reads and never acts on.
      $: (id) => ({
        id, innerHTML: '', value: '', hidden: true,
        querySelector: () => null, querySelectorAll: () => [],
      }),
      state,
      escapeHtml: esc,
      truncate,
      displayDate: (v) => String(v ?? ''),
      pageWindow,
      renderPager: (host, key, total, onGo) => { calls.push({ key, total }); onPager?.(host, key, total, onGo) },
      listScope: (env, rows) => { seen.listScope += 1; return listScope(env, rows) },
      setStatus() {},
      postJson: async () => ({}),
      refresh: async () => {},
      t: (key) => key,
      safeClass: (v) => String(v ?? ''),
    },
    seen,
  }
}

/* ------------------------------------------------------------------ tests */

describe('ARC-06 — the pager total comes from the envelope, not the fetched page', () => {
  it('the alerts rail pages the envelope total, not the page it holds', async () => {
    // 30 rows in hand, an envelope that says the set is 61. The defect renders
    // "of 30" here and stops, because `pageWindow` would be told the set is the
    // fetch. Observed on the pager's own output rather than at the call site.
    const elements = await boot({
      alerts: {
        data: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, status: 'pending', severity: 'high' })),
        returned: 30, limit: 200, total: 61, has_more: false, next_cursor: null,
      },
    })
    assert.equal(
      pagerStatus(elements.get('alertsPager')),
      'Showing 1–25 of 61',
      'the alerts pager must count the envelope total; "of 30" is the fetched page presented as the set',
    )
  })

  it('the reports panel pages the envelope total too', () => {
    // `/api/v1/reports?limit=20` against a store holding 40 is the same defect
    // on a second surface, which is why it is checked on both. The panel takes
    // its console as a parameter, so the observation needs no browser: the
    // recorded third argument is the number the pager renders.
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, title: `Report ${i}`, status: 'draft' }))
    const { console_, calls } = reportsConsole({
      state: { reports: rows, data: { reports: { data: rows, returned: 20, total: 40, has_more: true } }, templates: [] },
    })
    return import(new URL('panels/reports.js', PUBLIC_ROOT).href).then(({ mount }) => {
      mount(console_).renderReportsPanel()
      assert.equal(calls.length, 1, 'the reports panel rendered without paging')
      assert.equal(calls[0].key, 'reports')
      assert.equal(
        calls[0].total, 40,
        'the reports pager must count the envelope total; 20 is the fetched page presented as the set',
      )
    })
  })

  it('the reports panel consults the listScope it is handed', () => {
    // The parameter is load-bearing, not decorative. `mount` destructures it,
    // so a console that does not pass it hands the panel `undefined` and the
    // first render throws — which is why the console passes it in explicitly at
    // both sites, and why the check is on the mount rather than on the source
    // text that spells the parameter's name.
    //
    // The other direction matters too: a panel that took the parameter and then
    // computed the total itself would pass the check above by coincidence. The
    // recorder counts the calls, so "handed it" and "used it" are separate
    // facts.
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, title: `Report ${i}`, status: 'draft' }))
    const state = { reports: rows, data: { reports: { data: rows, returned: 20, total: 40, has_more: true } }, templates: [] }
    const { console_, seen } = reportsConsole({ state })

    return import(new URL('panels/reports.js', PUBLIC_ROOT).href).then(({ mount }) => {
      mount(console_).renderReportsPanel()
      assert.ok(seen.listScope > 0, 'the panel computed its own total instead of reading the envelope')

      const incomplete = { ...console_ }
      delete incomplete.listScope
      assert.throws(
        () => mount(incomplete).renderReportsPanel(),
        TypeError,
        'without listScope the render must fail loudly — a silent `undefined` total is the defect',
      )
    })
  })
})

describe('ARC-06 — the count says what the pager is not showing', () => {
  it('names the shortfall when the server said there is more', () => {
    const host = node()
    renderPagerScope(host, listScope(envelope()), 'alert', { filtered: 30, fetched: 30 })
    assert.equal(host.hidden, false)
    assert.match(host.textContent, /Showing the 30 alerts most recent of 61 alerts/)
    assert.match(host.textContent, /31 are not loaded/)
  })

  it('claims completeness only when the server said the page was whole', () => {
    const host = node()
    renderPagerScope(host, listScope(envelope({ has_more: false, total: 30 })), 'alert', { filtered: 30, fetched: 30 })
    assert.match(host.textContent, /^All 30 alerts loaded\.$/)
    assert.ok(!/not loaded/.test(host.textContent), 'a complete page must not warn about rows that do not exist')
  })

  it('distinguishes the filtered count from the fetched page', () => {
    // Three alerts match the filter out of a fetched page of 30. Reporting the
    // page length there is a third wrong number, on top of the two this fixes.
    const host = node()
    renderPagerScope(host, listScope(envelope({ has_more: false, total: 30 })), 'alert', { filtered: 3, fetched: 30 })
    assert.match(host.textContent, /3 alerts match the current filter/)
    assert.ok(!/27/.test(host.textContent), 'the difference is not a fact anyone asked for')
  })

  it('says nothing extra when the filter did not narrow anything', () => {
    const host = node()
    renderPagerScope(host, listScope(envelope({ has_more: false, total: 30 })), 'alert', { filtered: 30, fetched: 30 })
    assert.ok(!/match the current filter/.test(host.textContent))
  })

  it('does not pluralise a single row', () => {
    const host = node()
    renderPagerScope(host, listScope({ data: [{ id: 'a' }], total: 1, has_more: false }), 'alert', { filtered: 1, fetched: 1 })
    assert.match(host.textContent, /^All 1 alert loaded\.$/)
  })

  it('is a no-op when the host element is absent', () => {
    // The pager nodes live in markup the panel fetches; a render that runs
    // before it arrives must not throw.
    assert.doesNotThrow(() => renderPagerScope(null, listScope(envelope()), 'alert'))
  })
})

describe('ARC-06 — the console has a node to write the count into', () => {
  it('the alerts scope line exists in the served markup', () => {
    // Asserted against `index.html` rather than observed in a boot, because the
    // sandbox's `getElementById` fabricates any id on demand — a boot would pass
    // with the node absent from the page. Reading markup is not the QUA-02
    // failure; reading the *program's* text was.
    assert.match(INDEX, /id="alertsScope"/, 'index.html must carry the alerts scope line')
    assert.match(INDEX, /id="alertsScope"[^>]*role="status"/, 'it is a status region, not decoration')
  })

  it('the boot writes the count into that node', async () => {
    // The call site, observed: the text can only arrive from the render, so a
    // dropped or renamed call site leaves the node empty and fails here.
    const elements = await boot({
      alerts: {
        data: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, status: 'pending', severity: 'high' })),
        returned: 30, limit: 200, total: 61, has_more: false, next_cursor: null,
      },
    })
    const scope = elements.get('alertsScope')
    assert.equal(scope.hidden, false, 'the scope line stays hidden if nothing rendered into it')
    assert.match(scope.textContent, /61 alerts/, 'the count must name the envelope total')
  })
})

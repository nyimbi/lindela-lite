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
 * be claimed. The pure arithmetic is tested in `test/paging.test.js`; this file
 * guards the wiring, because a correct function nothing calls is the defect
 * again with better tests.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, describe, it } from 'node:test'

import { installBrowserEnv } from './browser-env.mjs'
import { listScope } from '../public/shared/paging.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_ROOT = new URL('../public/', import.meta.url)
const APP = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const INDEX = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const REPORTS = readFileSync(path.join(ROOT, 'public', 'panels', 'reports.js'), 'utf8')

/**
 * Source with comments stripped.
 *
 * The prose in this repo quotes the very strings a scan must not match — the
 * comment above `renderPagerScope` names `next_cursor` and the alerts call site
 * explains the old `filtered.length` — so a scan that reads comments tests the
 * documentation rather than the program.
 */
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const APP_CODE = codeOf(APP)
const REPORTS_CODE = codeOf(REPORTS)

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

/* ------------------------------------------------------------------ tests */

describe('ARC-06 — the pager total comes from the envelope, not the fetched page', () => {
  it('the alerts pager is given the scope total', () => {
    // The call site is the fix. `filtered.length` there is the defect verbatim.
    assert.match(
      APP_CODE,
      /renderPager\(\$\('alertsPager'\),\s*'alerts',\s*scope\.total/,
      'the alerts pager must count the envelope total; `filtered.length` renders "of 30" over a set of 61',
    )
    assert.ok(
      !/renderPager\(\$\('alertsPager'\),\s*'alerts',\s*filtered\.length/.test(APP_CODE),
      'the pager still counts the fetched page',
    )
  })

  it('the reports pager is given the scope total too', () => {
    // `/api/v1/reports?limit=20` against a store holding 40 is the same defect
    // on a second surface, which is why this is checked on both.
    assert.match(REPORTS_CODE, /renderPager\(\$\('reportsPager'\),\s*'reports',\s*scope\.total/)
    assert.ok(
      !/renderPager\(\$\('reportsPager'\),\s*'reports',\s*reports\.length/.test(REPORTS_CODE),
      'the reports pager still counts the fetched page',
    )
  })

  it('the panels that page receive listScope', () => {
    // A panel destructuring it from an absent key gets `undefined` and throws on
    // first render, so the console passes it in explicitly at both sites.
    for (const panel of ['panels/equity.js', 'panels/reports.js']) {
      const match = APP_CODE.match(new RegExp(`lazy\\('/${panel.replace('.', '\\.')}'\\)`))
      assert.ok(match, `${panel} is no longer lazily loaded; update this test`)
    }
    assert.match(APP_CODE, /\$,\s*state,\s*escapeHtml,\s*truncate,\s*pageWindow,\s*renderPager,\s*listScope,/)
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
  it('the alerts scope line exists in the markup', () => {
    // Written to by `renderPagerScope` and hidden until then. Without the node
    // the function is a no-op and the count silently never appears.
    assert.match(INDEX, /id="alertsScope"/, 'index.html must carry the alerts scope line')
    assert.match(INDEX, /id="alertsScope"[^>]*role="status"/, 'it is a status region, not decoration')
  })

  it('the call site writes into it', () => {
    assert.match(APP_CODE, /renderPagerScope\(\$\('alertsScope'\)/)
  })
})

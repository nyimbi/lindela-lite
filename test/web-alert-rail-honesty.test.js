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
import { before, describe, it } from 'node:test'
import { installBrowserEnv } from './browser-env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_ROOT = new URL('../public/', import.meta.url)
const EN = JSON.parse(readFileSync(path.join(ROOT, 'public', 'i18n', 'en.json'), 'utf8'))

/* ------------------------------------------------------------ sandbox */

let alertListOutcome

before(async () => {
  // `alertListOutcome` is a pure export, but it lives in a module that boots
  // the whole console at import time — element lookups, a fetch loop, a poll.
  // The console is imported with the shared environment from
  // `test/browser-env.mjs` — which also installs module resolution, so the
  // browser-absolute `/shared/…` specifiers inside app.js resolve to disk.
  // This file used to carry its own copy of both; see R-74.
  installBrowserEnv()

  const mod = await import(new URL('app.js', PUBLIC_ROOT).href)
  alertListOutcome = mod.alertListOutcome
})

/**
 * Boot the console against a store the caller describes, and hand back the rail.
 *
 * QUA-02. The three tests below used to read `app.js` as text and assert on the
 * *shape* of the code — `assert.match(code, /renderAlertsBadge\(\[\], \{ checked:
 * false \}\)/)`, ordering by `indexOf` on source substrings. Every one of those
 * passes when the branch exists and is dead, and fails on a rename that changes
 * nothing. The failure branch is reachable through the real boot, so what is
 * asserted now is the markup the rail actually renders and the badge it actually
 * sets when the alerts endpoint is dead.
 *
 * A fresh specifier per call: ESM caches by URL, and two scenarios sharing one
 * `app.js` URL would run the second against the first's module state. The
 * English catalogue is served so the reassuring string and the error state
 * render as words rather than as key names.
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
let boots = 0
async function boot({ alertsRespond } = {}) {
  boots += 1
  const elements = new Map()
  installBrowserEnv({
    elements,
    respond: (url) => {
      if (url.includes('/i18n/en.json')) return { body: EN }
      if (url.includes('/api/v1/alert-events')) return alertsRespond
      return undefined
    },
  })
  await import(new URL(`app.js?rail=${boots}`, PUBLIC_ROOT).href)
  // `hydrateProtocolOutcomes` and the outcome-coverage line are not awaited by
  // the refresh; let their own promises drain before reading the rail.
  await new Promise((r) => realSetTimeout(r, 5))
  return {
    rail: elements.get('alertsList')?.innerHTML || '',
    badge: elements.get('alertsBadge'),
  }
}

/** A dead alerts endpoint: a 503, which `apiFetch` throws on. */
const deadAlerts = () => ({ ok: false, status: 503, body: { success: false } })

/** The endpoint answered, with no rows. */
const emptyAlerts = () => ({ body: { success: true, data: [], returned: 0, limit: 200, total: 0, has_more: false, next_cursor: null } })



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
  it('a dead alerts endpoint renders the failure state, not the reassurance', async () => {
    // The headline defect, driven through the real boot: `/api/v1/alert-events`
    // answers 503, and the rail must say so rather than print the reassuring
    // "No alerts. All rules quiet." The old branch was `if (!filtered.length)`
    // with nothing before it.
    const { rail } = await boot({ alertsRespond: deadAlerts() })
    assert.doesNotMatch(rail, /No alerts\. All rules quiet\./,
      'a dead endpoint must not render the reassuring empty-state string')
    assert.match(rail, /empty-state-error/,
      'the rail must render the error variant, not the plain empty state')
    assert.match(rail, /Could not reach the server/,
      'the rail must describe its own error state with the shared vocabulary')
  })

  it('an endpoint that answered with no alerts still renders the reassurance', async () => {
    // The other half of the distinction: a server that *did* answer and has no
    // alerts is genuinely empty, and the reassuring string is correct there. A
    // failure state that swallowed this case would be as wrong as the reverse.
    const { rail } = await boot({ alertsRespond: emptyAlerts() })
    assert.match(rail, /No alerts\. All rules quiet\./,
      'a checked, quiet queue must still say so')
    assert.doesNotMatch(rail, /empty-state-error/,
      'a checked, quiet queue is not an error')
  })

  it('the tab badge shows unchecked on a dead endpoint, since the count is a claim too', async () => {
    // The badge took an array and nothing else, so every upstream failure
    // arrived as [] and it hid itself — indistinguishable from a quiet queue.
    // An operator scanning the tab strip saw no badge on a dead console. The
    // unchecked state is a visible dash, not a hidden badge.
    const { badge } = await boot({ alertsRespond: deadAlerts() })
    assert.ok(badge, 'the badge host exists')
    assert.equal(badge.hidden, false, 'an unchecked badge must be visible, not hidden like a quiet one')
    assert.equal(badge.textContent, '—', 'the unchecked badge must render the dash, not a count')
    assert.match(String(badge.title ?? badge.getAttribute?.('title') ?? ''), /not checked/i,
      'the badge must say why it has no number')
  })

  it('the rail uses the shipped vocabulary rather than inventing its own wording', async () => {
    // shared/states.js is the shared contract, adopted by three surfaces
    // already. A fourth copy of "could not reach the server" is a fourth
    // wording to keep in sync. Observed rather than grepped: the sentence the
    // rail renders is the one `describeState(ERROR, …)` returns.
    const { rail } = await boot({ alertsRespond: deadAlerts() })
    assert.match(rail, /Could not reach the server/,
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
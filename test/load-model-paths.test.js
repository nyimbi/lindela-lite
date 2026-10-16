import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { CONSOLE_ENDPOINT_PATHS } from '../src/load-model.js'

/**
 * `CONSOLE_ENDPOINT_PATHS` is a model of what the console fetches, and nothing
 * compared it against the console.
 *
 * `src/load-model.js` states the model's whole guarantee: a model of "a console
 * polling every thirty seconds" and a console that polls every fifteen read
 * identically in a report, and only the second is a measurement. `test/load-model.test.js`
 * holds every *cadence* to that standard — `POLL_BASE_MS`, the tab sets and the
 * per-tick counts are all asserted against `public/app.js`'s own exports. The
 * paths were not: the only case touching them asserted `CONSOLE_ENDPOINT_PATHS[name]`
 * is **truthy**, which a path the console no longer requests satisfies perfectly.
 *
 * The gap was live and this is what found it. Reverting `public/app.js`'s climate
 * load to `?limit=200` while the model said `?view=verification` — a change that
 * makes the model measure a 200-row page while the browser reads a 2000-row view —
 * left the whole suite at 17 pass / 0 fail. The panel's own regression test could
 * not see it either, because that test drives the server rather than the console.
 *
 * So this compares the two sets directly. Sixteen of the eighteen paths appear in
 * `public/app.js` as exact string literals in a `load(name, path)` call. The other
 * two are built rather than written, and are **driven** here instead of exempted:
 *
 *   - `events` is two requests (`localEventQuery()` and `globalEventQuery()`), and
 *     the model records the global one, which is `?limit=50`;
 *   - `alerts` is walked by `fetchAllPages`, whose first request is
 *     `${path}?limit=${limit}`.
 *
 * Both builders import cleanly under Node, so there is no exemption list to go
 * stale and no fuzzy match to swallow a real difference — which is the failure
 * mode the `events` half would otherwise invite, since `/api/v1/events?limit=50`
 * appears in `public/shared/map-frame.js` only inside a comment explaining what
 * the map *used* to fetch.
 *
 * Scoped to `public/app.js` by name. `public/portal/app.js` has its own `load()`
 * calls that reuse four of these names (`assets`, `alerts`, `risk`, `hazards`)
 * with different paths, so a walk of all of `public/` would compare the model
 * against the wrong console.
 */

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const APP = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')

/**
 * Every path the console's `refresh()` fetches, keyed by the endpoint name the
 * model uses.
 *
 * Two shapes, and both are real in `public/app.js`. Most endpoints go through
 * `load('<name>', '<path>')`, which names the key explicitly. A few are fetched
 * inline in the same `Promise.all` and take their key from the object they
 * return — `iotObservations` is `{ iotObservations: await fetchJson('/api/v1/iot-observations?map=1') }`.
 * A reader that knew only the first shape reported `iotObservations` as a path
 * the console never fetches, which is the failure this file's `cells()`-style
 * note describes: the model was right and the reader recognised one of the two
 * ways to write the thing it was reading.
 */
function consoleLoadPaths(source) {
  const out = new Map()
  for (const m of source.matchAll(/\bload\(\s*'([A-Za-z_$][\w$]*)'\s*,\s*'([^']+)'/g)) {
    out.set(m[1], m[2])
  }
  for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*await\s+fetchJson\(\s*'([^']+)'/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2])
  }
  return out
}

/**
 * The paths the console builds rather than writes, resolved by calling the
 * console's own builders. Keyed by the endpoint name in the model.
 */
async function builtPaths() {
  const { globalEventQuery } = await import('../public/shared/map-frame.js')
  const { fetchAllPages } = await import('../public/shared/paging.js')

  // The alerts walk's first request, captured rather than predicted: the query
  // string is `fetchAllPages`'s, and re-deriving it here would be a second copy
  // of the thing under test.
  let alertsFirst = null
  await fetchAllPages(
    async (url) => { if (!alertsFirst) alertsFirst = url; return { data: [], next_cursor: null, total: 0 } },
    { path: '/api/v1/alert-events', limit: 200, maxPages: 1 },
  )

  return { events: globalEventQuery(), alerts: alertsFirst }
}

describe('the load model names the paths the console actually fetches', () => {
  const declared = consoleLoadPaths(APP)

  it('reads the console it claims to model', () => {
    // A reader that found nothing would pass every comparison below by having
    // nothing to compare.
    assert.ok(declared.size >= 14,
      `read only ${declared.size} load() calls from public/app.js — the reader or the console is wrong`)
    assert.ok(declared.has('climate') && declared.has('seasonal'),
      'public/app.js has no climate/seasonal load() calls — this is not the console file')
  })

  it('every modelled path is the path the console fetches', async () => {
    const built = await builtPaths()
    const drift = []
    for (const [name, modelled] of Object.entries(CONSOLE_ENDPOINT_PATHS)) {
      const actual = declared.get(name) ?? built[name]
      if (actual === undefined) {
        drift.push(`${name}: the model names ${modelled}, and public/app.js never fetches it under that name`)
      } else if (actual !== modelled) {
        drift.push(`${name}: the model says ${modelled}, the console fetches ${actual}`)
      }
    }
    assert.deepEqual(drift, [],
      `the load model and the console disagree about what a tick costs:\n  ${drift.join('\n  ')}\n`
      + 'The model exists to measure the browser\'s real load; a path it invented or let rot measures a request nobody makes.')
  })

  it('the console fetches nothing the model leaves unmodelled', () => {
    // The converse, and the one that matters for a load *ceiling*: a request the
    // console makes and the model does not know about is load the report omits.
    // Two shapes are legitimately outside the tick — a panel handler that fetches
    // on demand, and a summary route a specific panel reads — so this asserts the
    // *set*, not a blocklist, and names what is out of jurisdiction.
    const ON_DEMAND = {
      '/api/v1/food-security/summary': 'read by the food-security panel handler, not the poll loop',
      '/api/v1/disease-observations/summary': 'read by the disease panel handler, not the poll loop',
      '/api/v1/flood-probability/models': 'read by the flood-probability panel handler, not the poll loop',
      '/api/v1/protocol-executions': 'read by the workflow panel handler, not the poll loop',
    }

    const modelled = new Set(Object.values(CONSOLE_ENDPOINT_PATHS))
    const unmodelled = [...declared.entries()]
      .filter(([, p]) => !modelled.has(p))
      .filter(([, p]) => !Object.hasOwn(ON_DEMAND, p))
    assert.deepEqual(unmodelled, [],
      `public/app.js fetches paths the load model does not know about: `
      + `${unmodelled.map(([n, p]) => `${n} → ${p}`).join(', ')}. `
      + 'Either model them, or add them to ON_DEMAND with the reason they are outside the tick.')

    // And every declared on-demand route is still fetched, so the exemption
    // cannot outlive the route it excuses.
    const direct = new Set([...APP.matchAll(/fetchJson\(\s*'([^']+)'/g)].map((m) => m[1]))
    for (const route of Object.keys(ON_DEMAND)) {
      assert.ok(direct.has(route),
        `${route} is declared on-demand but public/app.js no longer fetches it — remove the stale exemption`)
    }
  })
})

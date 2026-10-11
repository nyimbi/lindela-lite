import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CHW_DRAIN_BATCH_LIMIT,
  CHW_FORM_PATH,
  CHW_REPORT_PATH,
  CONSOLE_ALL_ENDPOINTS,
  CONSOLE_AMBIENT_ENDPOINTS,
  CONSOLE_ENDPOINT_PATHS,
  CONSOLE_POLL_BASE_MS,
  CONSOLE_TAB_ENDPOINTS,
  LOAD_MODEL_DEFAULTS,
  PARTNER_ENDPOINT_PATHS,
  buildTimeline,
  consoleTickEndpoints,
} from '../src/load-model.js'
import { importFrontEnd } from './browser-env.mjs'

/**
 * The console module, loaded under the browser stubs so this suite can compare
 * the model against the thing it claims to model.
 *
 * This is the load model's whole guarantee. A model of "a console polling every
 * thirty seconds" and a console that polls every fifteen read identically in a
 * report, and only the second is a measurement. Every console parameter in
 * `src/load-model.js` is asserted here against `public/app.js`'s own export, so a
 * change to the console's cadence or endpoint set that the model does not follow
 * fails a test rather than quietly understating the load.
 */
let app

describe('ENH-77 — the synthetic-population load model', () => {
  describe('the console parameters are read out of the console, not invented', () => {
    it('models the poll cadence the console actually schedules from', async () => {
      app = await importFrontEnd('app.js')
      // The console schedules from `pollDelayMs`, not from the constant, so both
      // are asserted: a base that matched the constant while the function moved
      // would be a model of a console nobody runs.
      assert.equal(CONSOLE_POLL_BASE_MS, app.POLL_BASE_MS)
      assert.equal(CONSOLE_POLL_BASE_MS, app.pollDelayMs({ failures: 0 }))
    })

    it('models the same endpoint set the console fetches', () => {
      // Order and content both: the model dedupes in insertion order, as the
      // console's own `Set` does, so a reordering is a real difference.
      assert.deepEqual([...CONSOLE_ALL_ENDPOINTS], [...app.ALL_ENDPOINTS])
      assert.deepEqual([...CONSOLE_AMBIENT_ENDPOINTS], [...app.AMBIENT_ENDPOINTS])
      // The tab sets are compared through `endpointsForTab` rather than against
      // the console's raw `TAB_ENDPOINTS`, because the console hands out a union
      // with the ambient set: `equity` names `climate`, which is already
      // ambient, and the union is what a tick fetches.
      for (const tab of Object.keys(CONSOLE_TAB_ENDPOINTS)) {
        assert.deepEqual(
          consoleTickEndpoints(tab).map((e) => e.endpoint),
          [...app.endpointsForTab(tab, {})],
          `the ${tab} tab's tick differs from the console's own`,
        )
      }
    })

    it('models a tick as exactly the set the console would fetch', () => {
      // A steady tick on the alerts tab: the ambient set plus the tab's own.
      const modelled = consoleTickEndpoints('alerts').map((e) => e.endpoint)
      assert.deepEqual(modelled, [...app.endpointsForTab('alerts', {})])

      // The boot tick pays for everything once.
      const boot = consoleTickEndpoints('alerts', { first: true }).map((e) => e.endpoint)
      assert.deepEqual(boot, [...app.endpointsForTab('alerts', { first: true })])
    })

    it('counts the two calls the console makes for events, and dedupes a tab that names an ambient endpoint', () => {
      // `refresh()` asks for the local region and recent global events, two
      // requests, because one page of global events pushed the local flood out.
      const tick = consoleTickEndpoints('alerts')
      assert.equal(tick.find((e) => e.endpoint === 'events').count, 2)
      // `equity` lists `climate`, which is already ambient. Counting it twice
      // would report a request the browser never makes.
      const equity = consoleTickEndpoints('equity').map((e) => e.endpoint)
      assert.equal(equity.filter((name) => name === 'climate').length, 1)
    })

    it('has a path for every endpoint the console can fetch', () => {
      for (const name of CONSOLE_ALL_ENDPOINTS) {
        assert.ok(CONSOLE_ENDPOINT_PATHS[name], `no path modelled for ${name}`)
      }
    })
  })

  describe('the timeline is a deterministic function of its seed', () => {
    const options = { seed: 1234, windowMs: 120_000, console: { count: 1 }, chw: { count: 4, shiftStaggerMs: 5_000 }, partner: { count: 2, pullStaggerMs: 30_000 } }

    it('reproduces byte for byte from the same seed', () => {
      const a = buildTimeline(options)
      const b = buildTimeline(options)
      assert.deepEqual(a.requests, b.requests)
      assert.deepEqual(a.totals, b.totals)
    })

    it('draws a different population from a different seed', () => {
      // The backlogs and the staggers are the seeded draws. If a seed change did
      // not move them, the model would be deterministic in name only and a
      // ceiling could not be reproduced by anyone but the run that found it.
      const a = buildTimeline(options)
      const b = buildTimeline({ ...options, seed: 4321 })
      assert.notDeepEqual(a.actors, b.actors)
    })

    it('returns a timeline sorted by arrival', () => {
      const { requests } = buildTimeline(options)
      for (let i = 1; i < requests.length; i += 1) {
        assert.ok(requests[i].at >= requests[i - 1].at, `request ${i} arrives before its predecessor`)
      }
    })
  })

  describe('the arrival process', () => {
    it('counts one console tick exactly', () => {
      // One minute, one console on the alerts tab, nobody else. Boot pays for
      // all eighteen endpoints (events twice, so nineteen requests); the tick at
      // thirty seconds pays for the twelve ambient plus the tab's three
      // (fifteen names, sixteen requests). 35.
      const { requests, totals } = buildTimeline({
        windowMs: 60_000, console: { count: 1, tab: 'alerts' }, chw: { count: 0 }, partner: { count: 0 },
      })
      assert.equal(totals.requests, 35)
      assert.equal(totals.byKind.console, 35)
      assert.equal(requests[0].at, 0)
      assert.equal(requests.at(-1).at, 30_000)
      // And every one of them is a read of the console's own paths.
      for (const request of requests) {
        assert.equal(request.method, 'GET')
        assert.ok(CONSOLE_ENDPOINT_PATHS[request.endpoint], `${request.endpoint} is not a console endpoint`)
      }
    })

    it('issues nothing for a console that never opens', () => {
      const { requests } = buildTimeline({ windowMs: 60_000, console: { count: 0 }, chw: { count: 0 }, partner: { count: 0 } })
      assert.equal(requests.length, 0)
    })

    it('sends a drain as a burst of writes, capped at the queue batch size', () => {
      // A device that opens its shift with a full backlog, and no reports filed
      // inside the window, drains once — and drains at most what `claimBatch`
      // hands it, with the remainder carried rather than dropped. The backlog is
      // drawn, not chosen, so it is read off the actor the model built.
      const { requests, actors } = buildTimeline({
        windowMs: 60_000, console: { count: 0 }, chw: { count: 1, backlogMean: 60 }, partner: { count: 0 },
      })
      const backlog = actors[0].queuedAtStart
      assert.ok(backlog > CHW_DRAIN_BATCH_LIMIT, 'the fixture must exceed the batch cap for this to mean anything')
      const writes = requests.filter((r) => r.path === CHW_REPORT_PATH)
      assert.equal(writes.every((r) => r.method === 'POST'), true)
      assert.equal(requests.filter((r) => r.path === CHW_FORM_PATH).length, 1)
      // Every drain is capped at what `claimBatch` hands it — the remainder is
      // carried to the next flush rather than sent in one unbounded burst.
      const perInstant = new Map()
      for (const write of writes) perInstant.set(write.at, (perInstant.get(write.at) || 0) + 1)
      for (const [at, count] of perInstant) {
        assert.ok(count <= CHW_DRAIN_BATCH_LIMIT, `${count} writes at ${at}ms is past the ${CHW_DRAIN_BATCH_LIMIT}-record batch`)
      }
      assert.equal(writes.length, Math.min(backlog, CHW_DRAIN_BATCH_LIMIT * perInstant.size))
      // Everything in one drain arrives at one instant, which is the shape the
      // inbound limiter's write budget exists for.
      assert.equal(perInstant.size, 2, 'a sixty-second window holds the opening flush and the one at thirty seconds')
    })

    it('issues nothing for a device with an empty queue and no reports to file', () => {
      // Idle is one request, not a poll: the phone has no timer for its queue.
      const { requests } = buildTimeline({
        windowMs: 60_000, console: { count: 0 }, chw: { count: 1, backlogMean: 0, reportsPerHour: 0 }, partner: { count: 0 },
      })
      assert.equal(requests.length, 1)
      assert.equal(requests[0].path, CHW_FORM_PATH)
    })

    it('pulls every partner collection on the partner cadence', () => {
      const { requests } = buildTimeline({
        windowMs: 300_000, console: { count: 0 }, chw: { count: 0 },
        partner: { count: 1, pullIntervalMs: 300_000, pullStaggerMs: 0 },
      })
      assert.equal(requests.length, PARTNER_ENDPOINT_PATHS.length)
      assert.deepEqual(requests.map((r) => r.path), [...PARTNER_ENDPOINT_PATHS])
      assert.equal(new Set(requests.map((r) => r.at)).size, 1)
    })

    it('refuses a timeline larger than it was told to model', () => {
      // Truncating would report a clean run over a fraction of the load, which
      // is the one failure a load model may not have.
      assert.throws(
        () => buildTimeline({ windowMs: 3_600_000, console: { count: 50 }, chw: { count: 0 }, partner: { count: 0 }, maxRequests: 1000 }),
        /refusing rather than measuring a truncated timeline/,
      )
    })

    it('refuses a tab the console does not have', () => {
      assert.throws(() => buildTimeline({ console: { tab: 'weather' } }), /console\.tab must be one of/)
    })
  })

  describe('a degenerate population', () => {
    it('models an empty deployment as no load, rather than throwing', () => {
      const timeline = buildTimeline({ console: { count: 0 }, chw: { count: 0 }, partner: { count: 0 } })
      assert.deepEqual(timeline.requests, [])
      assert.deepEqual(timeline.actors, [])
      assert.equal(timeline.totals.requests, 0)
      assert.equal(timeline.totals.requestsPerSecond, 0)
      assert.deepEqual(timeline.totals.byKind, { console: 0, chw: 0, partner: 0 })
    })

    it('defaults to the population the model documents', () => {
      const timeline = buildTimeline()
      assert.equal(timeline.seed, LOAD_MODEL_DEFAULTS.seed)
      assert.equal(timeline.windowMs, LOAD_MODEL_DEFAULTS.windowMs)
      assert.equal(timeline.actors.filter((a) => a.kind === 'chw').length, LOAD_MODEL_DEFAULTS.chw.count)
      assert.ok(timeline.totals.requests > 0)
    })
  })
})

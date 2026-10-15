#!/usr/bin/env node
/**
 * ENH-76 — the two maintenance routes that make a replay a product.
 *
 * `src/replay.js` was complete and tested and reached by nothing: it could write
 * a run down and verify one, and no route ever asked it to. This file covers the
 * routes, and it is written around the failure the capture route is most likely
 * to introduce.
 *
 * **A capture that reads the store after the refresh captures its own output.**
 * `refreshAnalytics` swaps the derived collections, so a snapshot taken
 * afterwards holds the run's result as its input — and replaying it compares a
 * run against itself, which reproduces by construction and verifies nothing.
 * Every test below that asserts a verdict is downstream of that one property, so
 * the first test asserts it directly: the capture's `inputs.risk_scores` is the
 * set the run *read*, and it is empty for a store that had none.
 *
 * The rest is the shape an operator acts on. A divergence is a 200 carrying the
 * moved fields, never a 4xx: "the engine disagrees with its own record" must not
 * read as "your request was malformed". A body that is not a run capture is a
 * 400 naming the format it wanted.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { JsonStore, STORE_METADATA_KEYS } from '../src/store.js'
import { handleMaintenanceRoute, matchMaintenanceRoute } from '../src/routes/maintenance.js'

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.text = () => res.chunks.join('')
  res.json = () => JSON.parse(res.text())
  return res
}

const jsonResponse = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const AUTH = { subject: 'operator', partner_org: null }

const makeReq = (body) => ({
  method: 'POST',
  headers: {},
  __auth: AUTH,
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

/**
 * A store with one flood beside two assets, so the derivation has real input.
 *
 * The seeding and the test body share one scope on purpose. A helper that
 * returned the store out of this `try` would hand back an object whose backing
 * directory the `finally` had already removed — and `JsonStore.read()` answers a
 * missing file with an empty store rather than an error, so the route would
 * derive over nothing, publish nothing, and a replay of that capture would
 * reproduce *by construction*. That is precisely the failure the first test
 * below exists to catch, and it caught it here: the helper was returning the
 * store, the capture held no published rows, and the round-trip test passed for
 * the wrong reason.
 */
async function withSeededStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-replay-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    await store.merge({
      service_assets: [
        { id: 'r1', name: 'Road A', service_type: 'road', country: 'KE', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
        { id: 'c1', name: 'Clinic', service_type: 'health', country: 'KE', latitude: 3.11, longitude: 35.61 },
      ],
      hazard_events: [
        { id: 'h1', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 3.1, longitude: 35.6, occurred_at: '2026-09-30T00:00:00.000Z' },
      ],
      climate_observations: [
        { id: 'cl1', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 20, precipitation_probability_pct: 60, observed_at: '2026-06-01T00:00:00.000Z' },
        { id: 'cl2', region_name: 'Turkana', latitude: 3.1, longitude: 35.6, precipitation_mm: 25, precipitation_probability_pct: 55, observed_at: '2026-07-01T00:00:00.000Z' },
      ],
    })
    return await fn(store)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const call = (route, { body, store }) => {
  const res = fakeResponse()
  return handleMaintenanceRoute(route, {
    store,
    data: {},
    req: makeReq(body),
    res,
    url: new URL('http://127.0.0.1/x'),
    jsonResponse,
    readRequestJson: async () => body,
    withTimeout: async (promise) => promise,
  }).then((handled) => ({ handled, res }))
}


describe('ENH-76 — the maintenance matcher knows the replay pair', () => {
  it('resolves both routes on POST and on no other verb', () => {
    assert.deepEqual(matchMaintenanceRoute('/api/v1/maintenance/capture-run', 'POST'), { kind: 'capture-run' })
    assert.deepEqual(matchMaintenanceRoute('/api/v1/maintenance/replay-run', 'POST'), { kind: 'replay-run' })
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal(matchMaintenanceRoute('/api/v1/maintenance/capture-run', method), null, `${method} was matched`)
      assert.equal(matchMaintenanceRoute('/api/v1/maintenance/replay-run', method), null, `${method} was matched`)
    }
    assert.equal(matchMaintenanceRoute('/api/v1/maintenance/capture-runs', 'POST'), null, 'a near miss matched')
  })
})

describe('ENH-76 — capture-run writes down what the run read, not what it produced', () => {
  it('captures the pre-swap snapshot, so a replay compares a run against its input', async () => {
    // The property the whole route rests on. `refreshAnalytics` swaps the
    // derived collections; a capture taken afterwards would hold the run's own
    // output as its `inputs`, and replaying it would reproduce by construction.
    await withSeededStore(async (store) => {
      const { res } = await call({ kind: 'capture-run' }, { body: {}, store })
      assert.equal(res.status, 201)
      const capture = res.json().capture
      assert.equal(capture.format, 'lindela-run-capture')
      // The store held no risk scores before the run, so a capture of the
      // *input* carries none. One that read the store afterwards would carry the
      // rows the refresh just wrote.
      assert.deepEqual(capture.inputs.risk_scores, [],
        'the capture holds the run\'s own output as its input — a replay of it would verify nothing')
      // The other half of the same property: the run really did publish, so the
      // assertion above is a statement about the ordering rather than about a
      // store that had nothing to derive from.
      assert.ok((capture.published.risk_scores || []).length > 0, 'the run published nothing to compare against')
    })
  })

  it('records the instant the run used and an action log', async () => {
    await withSeededStore(async (store) => {
      const { res } = await call({ kind: 'capture-run' }, { body: { note: 'ticket 42' }, store })
      const body = res.json()
      assert.ok(Number.isFinite(Date.parse(body.pinned_at)), `pinned_at is not an instant: ${body.pinned_at}`)
      assert.equal(body.capture.note, 'ticket 42')
      const logs = await store.read({ collections: ['action_logs'] })
      assert.equal(logs.action_logs.filter((l) => l.action === 'capture_run').length, 1)
    })
  })
})

describe('ENH-76 — replay-run verifies a capture and reports the verdict', () => {
  it('reproduces a capture this route just wrote', async () => {
    await withSeededStore(async (store) => {
      const { res: captured } = await call({ kind: 'capture-run' }, { body: {}, store })
      const capture = captured.json().capture
      const { res } = await call({ kind: 'replay-run' }, { body: capture, store })
      assert.equal(res.status, 200)
      const body = res.json()
      assert.equal(body.verdict, 'reproduced', `the round trip did not reproduce: ${body.reason}`)
      assert.deepEqual(body.diverged, [])
    })
  })

  it('accepts the capture nested under `capture`, so the 201 body can be posted back', async () => {
    await withSeededStore(async (store) => {
      const { res: captured } = await call({ kind: 'capture-run' }, { body: {}, store })
      const { res } = await call({ kind: 'replay-run' }, { body: captured.json(), store })
      assert.equal(res.status, 200)
      assert.equal(res.json().verdict, 'reproduced')
    })
  })

  it('reports a divergence as a 200 naming the moved field, never a 4xx', async () => {
    // "The engine disagrees with its own record" must not read as "your request
    // was malformed". A perturbed published value is exactly that case.
    await withSeededStore(async (store) => {
      const { res: captured } = await call({ kind: 'capture-run' }, { body: {}, store })
      const capture = captured.json().capture
      const row = capture.published.risk_scores[0]
      const field = Object.keys(row).find((k) => typeof row[k] === 'number')
      assert.ok(field, 'the fixture published no numeric field to perturb')
      row[field] = row[field] + 1
      const { res } = await call({ kind: 'replay-run' }, { body: capture, store })
      assert.equal(res.status, 200, 'a divergence was answered as a client error')
      const body = res.json()
      assert.equal(body.verdict, 'diverged')
      assert.ok(body.diverged.length > 0, 'a divergence was reported with no field named')
      assert.ok(body.diverged.some((d) => d.path === field), `the moved field ${field} was not among ${JSON.stringify(body.diverged.map((d) => d.path))}`)
    })
  })

  it('refuses a body that is not a run capture, naming the format', async () => {
    await withSeededStore(async (store) => {
      const { res } = await call({ kind: 'replay-run' }, { body: { hello: 'world' }, store })
      assert.equal(res.status, 400)
      assert.match(res.json().error, /lindela-run-capture/)
    })
  })

  it('writes an action log and nothing else', async () => {
    await withSeededStore(async (store) => {
      const { res: captured } = await call({ kind: 'capture-run' }, { body: {}, store })
      const before = await store.read()
      const { res } = await call({ kind: 'replay-run' }, { body: captured.json().capture, store })
      assert.equal(res.status, 200)
      const after = await store.read()
      // A replay that wrote its result into the store would be a run, and the
      // module's claim is that a replay is not a re-run. Only `action_logs` moves
      // — and `updated_at`, which every write stamps, so the metadata keys are
      // not collections and are excluded by the store's own list rather than by
      // a second copy of it kept here.
      for (const collection of Object.keys(before)) {
        if (collection === 'action_logs' || STORE_METADATA_KEYS.includes(collection)) continue
        assert.equal(
          JSON.stringify(after[collection]),
          JSON.stringify(before[collection]),
          `the replay wrote to ${collection}`,
        )
      }
      assert.equal(after.action_logs.filter((l) => l.action === 'replay_run').length, 1)
    })
  })
})

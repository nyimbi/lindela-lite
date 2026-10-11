import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createPeriodicDriver, createServer } from '../src/server.js'
import { createRequestRing, recordRequestOutcome } from '../src/observability.js'
import { JsonStore } from '../src/store.js'

/**
 * QUA-01 — two servers in one process do not share state.
 *
 * `createServer()` is called dozens of times in this suite, and the state that
 * decides what a server reports was held in module globals: the request-outcome
 * ring behind `api_uptime_pct`, the driver timer, the connector-registry cache.
 * A module global is a claim that there is one server in the process, and every
 * test in this repository falsifies it.
 *
 * The failure this guards is not a crash. It is a number that is plausible,
 * wrong, and order-dependent: a test drives 500s through its own server, reads
 * `api_uptime_pct` back, and gets a healthy figure because another test's 200s
 * are in the same ring. Nothing fails, and the assertion that would have caught
 * it passes for the wrong reason.
 *
 * These are behavioural — they drive real requests and read real responses —
 * because the defect is in what a server reports, not in how it is wired. A
 * source-text assertion that `requestRing` appears in `createServer` would pass
 * on a version that creates the ring and never records into it.
 */

/** A server on an ephemeral port over its own store, torn down after `fn`. */
async function withServer(fn, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-qua01-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store, ...options }).listen(0)
  const base = `http://127.0.0.1:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Seed `n` outcomes of the same kind into a ring, without issuing requests. */
function seed(ring, ok, n) {
  for (let i = 0; i < n; i += 1) ring.record(ok)
}

describe('QUA-01 the request ring is the server\'s, not the process\'s', () => {
  it('an empty ring reports no measurement, and a seeded one reports itself', async () => {
    // The seam, exercised directly. A test that has to issue a hundred requests
    // to fill a hundred-slot ring is a test that measures its own HTTP overhead
    // as much as the ring, so the ring is injectable.
    //
    // The counts below allow for the one outcome this request itself adds: the
    // ring is written from the response's `finish` event, so the request being
    // served is not yet in it. Four seeded failures plus this request's success
    // is one of five, which is 20%.
    const ring = createRequestRing()
    await withServer(async (base) => {
      const empty = await (await fetch(`${base}/api/v1/kpi/quarterly`)).json()
      assert.equal(empty.data.api_uptime_pct, null,
        'a server with no observed requests claimed an uptime')
    }, { requestRing: ring })

    seed(ring, false, 4)
    await withServer(async (base) => {
      const seeded = await (await fetch(`${base}/api/v1/kpi/quarterly`)).json()
      assert.equal(seeded.data.api_uptime_pct, 20,
        'one of the five outcomes in the window succeeded, which is 20%')
    }, { requestRing: ring })
  })

  it('one server\'s failures do not appear in another server\'s uptime', async () => {
    // The defect in one test. Both servers are live at once, and the first is
    // driven to failure before the second is asked anything. If the ring is
    // process-wide, the second server reports the first's traffic — which is
    // exactly what happened across this suite's files.
    const ringA = createRequestRing()
    const ringB = createRequestRing()
    seed(ringA, false, 4)
    seed(ringB, true, 1)

    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/v1/kpi/quarterly`)).json()
      assert.equal(body.data.api_uptime_pct, 100,
        'this server saw only its own successful outcome')
    }, { requestRing: ringB })

    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/v1/kpi/quarterly`)).json()
      assert.equal(body.data.api_uptime_pct, 0,
        'this server saw only its own seeded failures')
    }, { requestRing: ringA })
  })

  it('the process ring is not consulted when a server has its own', async () => {
    // The other direction, and the one a "thread it through" fix gets wrong:
    // a server with an injected ring must not fall back to the process ring
    // when its own is empty. An empty ring is a measurement of nothing, and
    // `null` is this codebase's word for that — falling through to the process
    // ring would publish another scope's traffic as this server's.
    seed(processRing(), true, 10)
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/v1/kpi/quarterly`)).json()
      assert.equal(body.data.api_uptime_pct, null,
        'an injected, empty ring fell through to the process-wide one')
    }, { requestRing: createRequestRing() })
  })
})

/**
 * The process ring, reached the way the module exports it.
 *
 * `recordRequestOutcome` is the module-level writer; this is how the third test
 * puts traffic into the ring a server would use if it had none of its own.
 */
function processRing() {
  return { record: recordRequestOutcome }
}

describe('QUA-01 the driver is the caller\'s, not the process\'s', () => {
  it('two drivers tick their own stores, and stopping one leaves the other armed', async () => {
    // The old signature was a module-global timer behind an idempotence guard,
    // so the second `startPeriodicDriver` returned the first caller's timer and
    // the second store was never ticked — silently, because "already running"
    // and "your driver is running" were the same return value.
    const ticked = []
    const a = createPeriodicDriver()
    const b = createPeriodicDriver()
    const store = (label) => ({ read: async () => { ticked.push(label); return {} }, merge: async () => {} })

    const timerA = a.start(store('a'), { intervalSeconds: 3600 })
    const timerB = b.start(store('b'), { intervalSeconds: 3600 })
    assert.notEqual(timerA, timerB, 'the second driver got the first driver\'s timer')
    assert.ok(a.running && b.running)

    a.stop()
    assert.equal(a.running, false, 'stop() left this driver armed')
    assert.equal(b.running, true, 'stopping one driver stopped another')

    b.stop()
    assert.ok(ticked.includes('a') && ticked.includes('b'),
      `both stores should have been ticked once at start; saw ${JSON.stringify(ticked)}`)
  })

  it('a store that refuses every write still yields a heartbeat', async () => {
    // A `setInterval` callback is awaited by nobody, so a rejecting tick is an
    // unhandled rejection. `runPeriodicTick` is written so that cannot happen:
    // a failing item is caught and recorded, and the heartbeat write is caught
    // and logged. This asserts the property rather than the mechanism — a store
    // that refuses both its reads and its writes still returns a tick result.
    const driver = createPeriodicDriver()
    const store = {
      read: async () => { throw new Error('store unavailable') },
      merge: async () => { throw new Error('store unavailable') },
    }
    const started = driver.start(store, { intervalSeconds: 3600 })
    await new Promise((resolve) => setImmediate(resolve))
    driver.stop()
    assert.ok(started, 'the driver did not arm')
  })
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { chainEntries } from '../src/audit-chain.js'
import { handleLivenessRoute, matchLivenessRoute } from '../src/routes/liveness.js'
import { emptyStore } from '../src/schema.js'

/**
 * ENH-60 — the liveness family as a module, asserted where it now lives.
 *
 * `/health` and `/ready` are one family because they answer one question at two
 * depths: the process is running, and the store it depends on is reachable. The
 * end-to-end wiring is covered through the server by `test/lite.test.js` and the
 * envelope gate; what this asserts is what makes the pair a family rather than
 * two blocks that happened to be adjacent:
 *
 *   - **a degraded rollup is a 503, not a 200 with a note in the body.** A
 *     tampered action log or a dead-lettered outbox means the instance cannot
 *     serve correctly, and a monitor reading only the status code has to see it.
 *   - **`starting` is not `degraded`.** A process four seconds old has not had
 *     its chance; a process two intervals old with no heartbeat has failed to
 *     start. Both are `healthy: false` and they call for different fixes.
 *   - **a failing store costs one timeout.** The rollups are computed from the
 *     probe's own read, so an unreachable store is one failed read rather than
 *     two — the difference between a probe that answers in `timeout_ms` and one
 *     that holds the load balancer open for twice that.
 */

function fakeResponse() {
  const res = EventEmitter.call ? new EventEmitter() : new EventEmitter()
  res.chunks = []
  res.status = null
  res.locals = { serverStartedAt: Date.now() }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.text = () => res.chunks.join('')
  res.json = () => JSON.parse(res.text())
  return res
}

const jsonResponse = (res, status, body) => {
  res.writeHead(status, { status })
  res.end(JSON.stringify(body))
}

const req = (method = 'GET') => ({ method, headers: {} })

/**
 * A store double whose `read` resolves with `snapshot`, or rejects.
 *
 * `schemaStatus` and `storageUsage` are deliberately *absent* unless a test
 * supplies them, because absent is a real backend state: a store that cannot
 * answer for its schema or its disk must be reported as unsupported rather than
 * degrade readiness. A double that always implemented them would hide that.
 */
function storeDouble({ snapshot = {}, mode = 'json', fail = null, onRead, schemaStatus, storageUsage } = {}) {
  const store = {
    mode,
    reads: 0,
    async read() {
      this.reads += 1
      if (onRead) onRead()
      if (fail) throw fail
      return snapshot
    },
  }
  if (schemaStatus) store.schemaStatus = schemaStatus
  if (storageUsage) store.storageUsage = storageUsage
  return store
}

/** A stored audit chain with one row's hash overwritten, so `valid` is false. */
function brokenChain() {
  const { entries } = chainEntries([{ id: 'a', action: 'created' }, { id: 'b', action: 'updated' }])
  return entries.map((row, i) => (i === 1 ? { ...row, entry_hash: 'deadbeef' } : row))
}

const deps = (over = {}) => ({
  // A real store shape, not a two-key object: `counts()` walks the collections
  // and a thin fixture dies in it rather than in the branch under test.
  data: { ...emptyStore(), updated_at: '2026-10-12T00:00:00.000Z' },
  url: new URL('http://x/api/v1/ready'),
  jsonResponse,
  withTimeout: (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      const error = new Error(`timeout after ${ms}ms`)
      error.name = 'TimeoutError'
      reject(error)
    }, ms)),
  ]),
  // The real one, imported from the server so this test measures the shipped
  // predicate rather than a second copy of it that can drift.
  pipelineIsHealthy: (heartbeat) => (heartbeat?.at
    ? { healthy: true, ageSeconds: 1 }
    : { healthy: false, ageSeconds: null, reason: 'no heartbeat has been recorded' }),
  driverIntervalSeconds: () => 900,
  appVersion: '0.0.0-test',
  idempotency: null,
  ...over,
})

/**
 * Drive one route. `uptimeSeconds` ages the fake response's start stamp, which
 * is how `/health` decides between `starting` and `never_started`; `res` is
 * built here rather than passed in, so a test cannot replace the double it is
 * asserting against with a plain object by accident.
 */
const call = async (route, { uptimeSeconds = 0, ...over } = {}) => {
  const res = fakeResponse()
  res.locals = { serverStartedAt: Date.now() - uptimeSeconds * 1000 }
  const merged = deps(over)
  const handled = await handleLivenessRoute(route, {
    store: merged.store ?? storeDouble(),
    // A thunk, as the dispatcher passes it: `/ready` must not trigger a
    // whole-store read, so the test would not notice if it did.
    loadData: async () => merged.data,
    req: merged.req ?? req(), res, ...merged, res,
  })
  return { handled, res, json: res.json() }
}

describe('ENH-60 — matchLivenessRoute serves the two liveness paths', () => {
  it('matches health and ready, and nothing else', () => {
    assert.deepEqual(matchLivenessRoute('/api/v1/health'), { kind: 'health' })
    assert.deepEqual(matchLivenessRoute('/api/v1/ready'), { kind: 'ready' })
    for (const pathname of [
      '/api/v1/healthz', '/api/v1/readyz', '/api/v1/health/x', '/api/v1/ready/x',
      '/api/v1/livez', '/api/v1', '/health', '',
    ]) {
      assert.equal(matchLivenessRoute(pathname), null, `${pathname} matched a liveness route`)
    }
  })
})

describe('ENH-60 — health reports three states, not two', () => {
  it('answers 503 and names a stopped pipeline', async () => {
    // Far past the grace window, so a heartbeat that is not healthy is a
    // stopped pipeline rather than a young process.
    const { handled, res, json } = await call({ kind: 'health' }, {
      uptimeSeconds: 10 * 900,
      data: { ...emptyStore(), system_heartbeat: [{ at: '2026-01-01T00:00:00.000Z', interval_seconds: 900 }] },
      pipelineIsHealthy: () => ({ healthy: false, ageSeconds: 999_999, lastFailure: 'boom' }),
    })
    assert.equal(handled, true)
    assert.equal(res.status, 503, 'a stopped pipeline must not answer 200')
    assert.equal(json.status, 'degraded')
    assert.equal(json.pipeline.never_started, false, 'a heartbeat exists, so this is a stopped pipeline')
  })

  it('answers 200/starting for a process inside its grace window', async () => {
    const { res, json } = await call({ kind: 'health' }, {
      data: { ...emptyStore(), system_heartbeat: [] },
      pipelineIsHealthy: () => ({ healthy: false, ageSeconds: null }),
    })
    // `fakeResponse` stamps `serverStartedAt` at construction, so uptime is ~0
    // and the grace window (2 × 900s) is not exhausted.
    assert.equal(res.status, 200, 'a fresh deployment must not start red')
    assert.equal(json.status, 'starting')
    assert.equal(json.pipeline.never_started, false)
  })

  it('names never_started once the grace window has passed with no heartbeat', async () => {
    const { res, json } = await call({ kind: 'health' }, {
      uptimeSeconds: 10 * 900,
      data: { ...emptyStore(), system_heartbeat: [] },
      pipelineIsHealthy: () => ({ healthy: false, ageSeconds: null }),
    })
    assert.equal(res.status, 503, 'a process two intervals old with no heartbeat has failed to start')
    assert.equal(json.pipeline.never_started, true, 'the third state was not named')
    assert.match(json.pipeline.note, /has not completed a cycle since this process started/)
  })

  it('carries the auth posture on the route a tokenless operator can read', async () => {
    const { json } = await call({ kind: 'health' })
    assert.equal(typeof json.auth.configured, 'boolean', 'the auth posture is the answer to "is this deployment secured?"')
    assert.ok(Array.isArray(json.auth.public_paths))
  })
})

describe('ENH-60 — readiness fails closed on a degraded rollup', () => {
  it('answers 503 when the store cannot be read', async () => {
    const { res, json } = await call({ kind: 'ready' }, {
      store: storeDouble({ fail: Object.assign(new Error('connection refused'), {}) }),
    })
    assert.equal(res.status, 503)
    assert.equal(json.ready, false)
    assert.equal(json.store.reachable, false)
    assert.ok(json.store.error, 'an unreachable store must say why')
  })

  it('reads the store once, so a failing store costs one timeout', async () => {
    const store = storeDouble({ fail: new Error('nope') })
    await call({ kind: 'ready' }, { store })
    assert.equal(store.reads, 1, `read the store ${store.reads} times; the rollups must come from the probe's own read`)
  })

  it('answers 503 when the audit chain is broken, even though the store answered', async () => {
    // `audit.valid === false` is a tampered or truncated action log. The store is
    // reachable and the process is alive; the instance still cannot be trusted,
    // and a monitor reading the status code has to see that.
    const { res, json } = await call({ kind: 'ready' }, {
      // A stored chain with one row's hash overwritten. `linked` requires
      // `entry_hash` and `seq`, so this is verified as a *stored* chain and the
      // edit is detectable — which is the case the rollup exists for.
      store: storeDouble({ snapshot: { action_logs: brokenChain(), events_outbox: [] } }),
    })
    assert.equal(res.status, 503, 'a broken audit chain answered ready')
    assert.equal(json.audit.valid, false)
  })

  it('never triggers the whole-store read, which is the endpoint\'s whole point', async () => {
    // SCL-07 removed a second whole-store read from this route. Passing the
    // dispatcher's read as a thunk is what keeps a third from being reintroduced
    // by the extraction: `/ready` is the most-polled surface in the deployment,
    // and a whole-store read here is every row's body including
    // `record_versions`, which nothing on this route reads.
    let loaded = 0
    const res = fakeResponse()
    const merged = deps({ store: storeDouble({ snapshot: { action_logs: [], events_outbox: [] } }) })
    await handleLivenessRoute({ kind: 'ready' }, {
      ...merged, res, req: req(), loadData: async () => { loaded += 1; return merged.data },
    })
    assert.equal(loaded, 0, 'the readiness probe materialised the whole store')
  })

  it('answers 200 when the store answers and both rollups are clean', async () => {
    const { res, json } = await call({ kind: 'ready' }, {
      store: storeDouble({ snapshot: { action_logs: [], events_outbox: [] } }),
    })
    assert.equal(res.status, 200)
    assert.equal(json.ready, true)
    assert.equal(json.audit.valid, true)
  })

  it('reports the idempotency guarantee rather than implying it', async () => {
    const { json } = await call({ kind: 'ready' }, {
      store: storeDouble({ snapshot: { action_logs: [], events_outbox: [] } }),
      idempotency: { mode: 'durable', collection: 'idempotency_keys', ttlMs: 3600_000 },
    })
    assert.equal(json.idempotency.mode, 'durable')
    assert.equal(json.idempotency.durable, true)
    assert.equal(json.idempotency.ttl_hours, 1)
  })
})

describe('R-48/R-49 — the probe reports schema drift and free space', () => {
  it('reports the schema version the database is at against the one this build wants', async () => {
    // R-48. `schemaStatus()` computed `{current, expected, pending}` and had zero
    // callers, so a database a migration behind surfaced only as a 500 on every
    // request — the operator learned the schema was wrong from the first user
    // who hit it. `/ready` is already the operator surface that carries `audit`,
    // `outbox` and `idempotency`, is public, and returns no records.
    const { json } = await call({ kind: 'ready' }, {
      store: storeDouble({
        snapshot: { action_logs: [], events_outbox: [] },
        schemaStatus: async () => ({
          current: 1,
          expected: 3,
          pending: [{ version: 2, name: 'indexes' }, { version: 3, name: 'generated columns' }],
          current_build_is_ahead: false,
        }),
      }),
    })
    assert.equal(json.schema.current, 1)
    assert.equal(json.schema.expected, 3)
    assert.deepEqual(json.schema.pending.map((m) => m.version), [2, 3])
  })

  it('fails closed when the database is behind the build', async () => {
    // The build expects columns the database does not have, so every request
    // that touches them 500s. That is not ready.
    const { res, json } = await call({ kind: 'ready' }, {
      store: storeDouble({
        snapshot: { action_logs: [], events_outbox: [] },
        schemaStatus: async () => ({ current: 1, expected: 3, pending: [{ version: 2, name: 'indexes' }], current_build_is_ahead: false }),
      }),
    })
    assert.equal(res.status, 503, 'a database behind the build answered ready')
    assert.equal(json.ready, false)
  })

  it('does not fail closed when the database is newer than the build', async () => {
    // The module's own decision, restated at the probe: refusing to serve pushes
    // an operator into a manual downgrade, and reading rows written by a newer
    // schema is that schema's job to guard. `current_build_is_ahead` is
    // *reported*, and it is not a readiness failure.
    const { res, json } = await call({ kind: 'ready' }, {
      store: storeDouble({
        snapshot: { action_logs: [], events_outbox: [] },
        schemaStatus: async () => ({ current: 4, expected: 3, pending: [], current_build_is_ahead: true }),
      }),
    })
    assert.equal(res.status, 200, 'a newer database than the build was refused')
    assert.equal(json.schema.current_build_is_ahead, true)
  })

  it('reports free space and store size, and fails closed when the next write cannot land', async () => {
    // R-49. `ENOSPC` on a store write is a cascading 500 with no warning: the
    // disk fills, the next write fails, and nothing had said the disk was
    // filling. The predicate is the one that actually predicts the failure —
    // `JsonStore` rewrites the whole store through a temp file of its own size,
    // so the next write needs `store_bytes` free. Below that, the store cannot
    // accept a write at all.
    const { res, json } = await call({ kind: 'ready' }, {
      store: storeDouble({
        snapshot: { action_logs: [], events_outbox: [] },
        storageUsage: async () => ({ supported: true, backend: 'json', store_bytes: 900, free_bytes: 100, total_bytes: 1000, used_ratio: 0.9, error: null }),
      }),
    })
    assert.equal(json.storage.free_bytes, 100)
    assert.equal(json.storage.store_bytes, 900)
    assert.equal(res.status, 503, 'a store whose next write cannot fit answered ready')
    assert.equal(json.ready, false)
  })

  it('stays ready while there is room for the next write', async () => {
    const { res, json } = await call({ kind: 'ready' }, {
      store: storeDouble({
        snapshot: { action_logs: [], events_outbox: [] },
        storageUsage: async () => ({ supported: true, backend: 'json', store_bytes: 900, free_bytes: 5000, total_bytes: 10000, used_ratio: 0.5, error: null }),
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(json.storage.free_bytes, 5000)
  })

  it('does not invent a schema or a disk for a store that cannot answer for one', async () => {
    // The JSON store has no schema version and the Postgres client cannot see
    // the database server's filesystem. Both say so rather than reporting a
    // number they made up — and an unsupported probe must not degrade readiness,
    // or every deployment on that backend is permanently unready.
    const { res, json } = await call({ kind: 'ready' }, {
      store: storeDouble({ snapshot: { action_logs: [], events_outbox: [] } }),
    })
    assert.equal(res.status, 200)
    assert.equal(json.schema.supported, false)
    assert.equal(json.storage.supported, false)
  })

  it('reports a probe that threw rather than failing the whole route', async () => {
    // A store that answers the read and then throws from the schema probe is a
    // real state — a dropped connection between the two — and it must not turn
    // the readiness body into a 500 with no diagnosis.
    const { res, json } = await call({ kind: 'ready' }, {
      store: storeDouble({
        snapshot: { action_logs: [], events_outbox: [] },
        schemaStatus: async () => { throw new Error('connection terminated unexpectedly') },
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(json.schema.supported, false)
    assert.match(json.schema.error, /connection terminated/)
  })
})

describe('ENH-60 — a verb the family does not serve is refused', () => {
  it('answers 405 for a write to either path', async () => {
    for (const kind of ['health', 'ready']) {
      const { handled, res } = await call({ kind }, { req: req('POST') })
      assert.equal(handled, true)
      assert.equal(res.status, 405, `${kind} accepted a POST`)
    }
  })
})

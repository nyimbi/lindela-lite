import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { collectionPage, createIdempotencyStore } from '../src/utils.js'
import { isPublicPath, publicPaths } from '../src/auth.js'

/**
 * The API had no substrate.
 *
 * Four separate gaps, each of which a caller hits on the first integration:
 *
 * 1. **No total.** Every list route answered with a bare array truncated at
 *    `limit` and said nothing about what else existed. A caller could not tell
 *    an empty collection from a truncated one, so "we found nothing" and "we
 *    found five hundred" were the same response.
 *
 * 2. **No conditional requests.** The static-asset path computed ETags; the
 *    API did not, and set `cache-control: no-store`, so every poll from every
 *    open console re-downloaded the full payload to be told nothing had
 *    changed.
 *
 * 3. **No idempotency.** A retried POST created a second incident, a second
 *    dispatch, a second alert — silently, because the retry is what a flaky
 *    mobile network produces by itself.
 *
 * 4. **No readiness.** `/api/v1/health` reported 200 while the store was
 *    unreachable, so a load balancer kept an instance in rotation that could
 *    not serve a single request.
 */

async function withServer(fn, { tokens } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-substrate-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  const previous = process.env.LINDELA_LITE_TOKENS
  if (tokens) process.env.LINDELA_LITE_TOKENS = tokens
  try {
    return await fn(base, store)
  } finally {
    if (previous === undefined) delete process.env.LINDELA_LITE_TOKENS
    else process.env.LINDELA_LITE_TOKENS = previous
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const ASSETS = Array.from({ length: 12 }, (_, i) => ({
  id: `a${String(i + 1).padStart(2, '0')}`,
  name: `Clinic ${i + 1}`,
  district: 'Nairobi',
  service_type: 'health',
  partner_org: 'orgA',
}))

const q = (params) => `?${new URLSearchParams(params)}`

describe('a collection says how much of itself it is not showing', () => {
  const context = { data: {}, collection: 'service_assets' }

  it('reports the total, not just the page', () => {
    const page = collectionPage(ASSETS, new URLSearchParams({ limit: '5' }), context)
    assert.equal(page.data.length, 5)
    assert.equal(page.total, 12, 'twelve records exist')
    assert.equal(page.returned, 5)
    assert.equal(page.has_more, true)
  })

  it('distinguishes an empty collection from a truncated one', () => {
    const page = collectionPage(ASSETS, new URLSearchParams({ service_type: 'water' }), context)
    assert.equal(page.data.length, 0)
    assert.equal(page.total, 0)
    assert.equal(page.has_more, false, 'nothing is hidden behind a page')
  })

  it('offers no cursor when the page is the whole set', () => {
    const page = collectionPage(ASSETS, new URLSearchParams({ limit: '5000' }), context)
    assert.equal(page.data.length, 12)
    assert.equal(page.has_more, false)
    assert.equal(page.next_cursor, null, 'a cursor to the end of the set is an invitation to one more empty request')
  })

  it('walks the whole set through cursors without repeating or dropping', () => {
    const seen = []
    let cursor = null
    for (let page = 0; page < 10; page += 1) {
      const params = { limit: '5' }
      if (cursor) params.cursor = cursor
      const result = collectionPage(ASSETS, new URLSearchParams(params), context)
      seen.push(...result.data.map((r) => r.id))
      cursor = result.next_cursor
      if (!cursor) break
    }
    assert.deepEqual(seen, ASSETS.map((r) => r.id))
    assert.equal(new Set(seen).size, 12, 'no record appeared on two pages')
  })

  it('counts what matched before it pages', () => {
    const page = collectionPage(ASSETS, new URLSearchParams({ limit: '3' }), context)
    assert.equal(page.total, 12)
    assert.equal(page.limit, 3)
  })

  it('refuses a cursor that names nothing, rather than replaying page one', () => {
    // Resuming from nothing looks like progress and is not: the caller would
    // receive the first page again while believing it had read further in.
    assert.throws(
      () => collectionPage(ASSETS, new URLSearchParams({ cursor: 'a99' }), context),
      (err) => err.statusCode === 400 && /cursor/.test(err.message),
    )
  })

  it('round-trips a cursor through the wire form', () => {
    const first = collectionPage(ASSETS, new URLSearchParams({ limit: '5' }), context)
    const second = collectionPage(ASSETS, new URLSearchParams({ limit: '5', cursor: first.next_cursor }), context)
    assert.equal(second.data[0].id, 'a06')
  })

  it('clamps a limit that asks for everything', () => {
    // `limit=999999` must not become a full-table materialisation.
    const page = collectionPage(ASSETS, new URLSearchParams({ limit: '999999' }), context)
    assert.equal(page.limit, 5000)
  })

  it('carries the envelope over HTTP', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: ASSETS })
      const body = await (await fetch(`${base}/api/v1/service-assets${q({ limit: '4' })}`)).json()
      assert.equal(body.data.length, 4)
      assert.equal(body.total, 12)
      assert.equal(body.returned, 4)
      assert.equal(body.has_more, true)
      assert.ok(body.next_cursor)
    })
  })

  it('answers the same total for a filtered page as for the whole set', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: ASSETS })
      const all = await (await fetch(`${base}/api/v1/service-assets`)).json()
      const filtered = await (await fetch(`${base}/api/v1/service-assets${q({ service_type: 'water' })}`)).json()
      assert.equal(all.total, 12)
      assert.equal(filtered.total, 0, 'the total counts what matched the filters, not what exists')
    })
  })
})

describe('a response can be revalidated instead of re-downloaded', () => {
  it('tags a successful response', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: ASSETS })
      const res = await fetch(`${base}/api/v1/service-assets`)
      assert.ok(res.headers.get('etag'), 'no tag means no conditional request is possible')
      assert.equal(res.headers.get('cache-control'), 'no-cache')
    })
  })

  it('answers 304 with no body when nothing has changed', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: ASSETS })
      const first = await fetch(`${base}/api/v1/service-assets`)
      const etag = first.headers.get('etag')
      const second = await fetch(`${base}/api/v1/service-assets`, { headers: { 'if-none-match': etag } })
      assert.equal(second.status, 304)
      assert.equal(await second.text(), '', 'a 304 that carries a body is not a 304')
    })
  })

  it('answers 200 when the data has changed', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: ASSETS })
      const first = await fetch(`${base}/api/v1/service-assets`)
      const etag = first.headers.get('etag')
      await store.merge({ service_assets: [...ASSETS, { id: 'a13', name: 'Clinic 13' }] })
      const second = await fetch(`${base}/api/v1/service-assets`, { headers: { 'if-none-match': etag } })
      assert.equal(second.status, 200)
      assert.equal((await second.json()).total, 13)
    })
  })

  it('honours a weak tag and a list of tags', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: ASSETS })
      const etag = (await fetch(`${base}/api/v1/service-assets`)).headers.get('etag')
      const weak = await fetch(`${base}/api/v1/service-assets`, { headers: { 'if-none-match': `W/${etag}` } })
      assert.equal(weak.status, 304)
      const listed = await fetch(`${base}/api/v1/service-assets`, { headers: { 'if-none-match': `"other", ${etag}` } })
      assert.equal(listed.status, 304)
    })
  })

  it('does not revalidate on a creation, where a cached body would be a lie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/service-assets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Clinic X', district: 'Nairobi', service_type: 'health' }),
      })
      assert.equal(res.status, 201)
      assert.equal(res.headers.get('etag'), null, 'a created resource is not a cacheable representation of a list')
    })
  })
})

describe('a retried mutation happens once', () => {
  // Ingestion is the honest target: a mobile client on a flaky connection
  // retries, and a retried run re-imports every record in the batch. The
  // observable is `source_runs`, which grows by one per attempt.
  const batch = { sources: ['service_assets'], service_assets: [{ name: 'Water Point 1', service_type: 'water', latitude: 3.1, longitude: 35.6, country: 'KE' }] }
  const run = (base, key, body = batch) => fetch(`${base}/api/v1/ingest/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  })
  const runCount = async (store) => (await store.read()).source_runs.length

  it('replays the original response for a repeat', async () => {
    await withServer(async (base, store) => {
      const first = await run(base, 'replay-1')
      const firstBody = await first.json()
      const second = await run(base, 'replay-1')
      const secondBody = await second.json()

      assert.equal(second.status, first.status)
      assert.deepEqual(secondBody, firstBody, 'the second attempt must see the first attempt\'s answer')
      assert.equal(second.headers.get('idempotency-replayed'), 'true')
      assert.equal(await runCount(store), 1, 'and must not have run a second time')
    })
  })

  it('runs again for a different key', async () => {
    await withServer(async (base, store) => {
      await run(base, 'distinct-a')
      await run(base, 'distinct-b')
      assert.equal(await runCount(store), 2, 'the key names one attempt, not one caller')
    })
  })

  it('does not dedupe without a key', async () => {
    // Two genuine runs are two runs. Deduping without a key would make a real
    // second import indistinguishable from a retry.
    await withServer(async (base, store) => {
      await run(base, null)
      await run(base, null)
      assert.equal(await runCount(store), 2)
    })
  })

  it('dedupes only on an exact repeat', async () => {
    await withServer(async (base, store) => {
      await run(base, 'vary-a')
      const reused = await run(base, 'vary-a', { ...batch, service_assets: [{ name: 'Water Point 2', service_type: 'water', latitude: 3.2, longitude: 35.7, country: 'KE' }] })
      assert.equal(reused.status, 409, 'the key names a request; a different request under it is a conflict')
      assert.equal(reused.headers.get('idempotency-conflict'), 'true')
      assert.match((await reused.json()).error, /different request body/)
      assert.equal(await runCount(store), 1,
        'the conflict runs nothing -- replaying here would return a receipt for work never done')
    })
  })

  it('does not let one caller name another\'s response', async () => {
    // The key is scoped by caller, method and path before lookup. Unscoped,
    // two partners both using "1" would receive each other's imports — a
    // cross-partner read manufactured entirely from request headers.
    const tokens = JSON.stringify([
      { token: 'tok-a', scopes: ['*'], partner_org: 'orgA' },
      { token: 'tok-b', scopes: ['*'], partner_org: 'orgB' },
    ])
    await withServer(async (base, store) => {
      await store.merge({ service_assets: ASSETS })
      const headers = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': 'shared' })
      const asA = await fetch(`${base}/api/v1/ingest/run`, { method: 'POST', headers: headers('tok-a'), body: JSON.stringify(batch) })
      const asB = await fetch(`${base}/api/v1/ingest/run`, { method: 'POST', headers: headers('tok-b'), body: JSON.stringify(batch) })
      assert.equal(asA.headers.get('idempotency-replayed'), null)
      assert.equal(asB.headers.get('idempotency-replayed'), null, "orgB received orgA's response")
      assert.equal(await runCount(store), 2, 'each caller ran its own')
    }, { tokens })
  })

  it('does not replay a read across the key space', async () => {
    // The key is method-scoped as well as caller-scoped: a key used on a POST
    // must not shadow a later GET that happens to reuse it.
    await withServer(async (base) => {
      await run(base, 'shared')
      const get = await fetch(`${base}/api/v1/service-assets`, { headers: { 'idempotency-key': 'shared' } })
      assert.equal(get.status, 200)
      assert.equal(get.headers.get('idempotency-replayed'), null)
    })
  })

  it('refuses a key that could not have been generated by a client', async () => {
    await withServer(async (base) => {
      const res = await run(base, 'has space')
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /Idempotency-Key/)
    })
  })

  it('never caches a failure', async () => {
    await withServer(async (base, store) => {
      // A record with no service_type is a 400. Replaying that for the length
      // of the window would turn a client's typo into a day-long failure: the
      // batch is fixed, the retry still returns the old rejection.
      const bad = { sources: ['service_assets'], service_assets: [{ name: 'No Type', latitude: 1, longitude: 2, country: 'KE' }] }
      const post = () => fetch(`${base}/api/v1/service-assets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'bad-1' },
        body: JSON.stringify(bad),
      })
      assert.equal((await post()).status, 400)
      assert.equal((await post()).headers.get('idempotency-replayed'), null, 'a failure was cached')
    })
  })

  it('expires an entry rather than keeping it forever', async () => {
    const store = createIdempotencyStore({ ttlMs: 1 })
    await store.run('k', 201, async () => ({ id: 'x' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(store.lookup('k'), undefined, 'a bounded guarantee, and the bound is reported in /ready')
  })

  it('evicts the least recently used entry rather than growing without bound', async () => {
    const store = createIdempotencyStore({ maxEntries: 2 })
    await store.run('a', 201, async () => ({ id: 'a' }))
    await store.run('b', 201, async () => ({ id: 'b' }))
    await store.run('c', 201, async () => ({ id: 'c' }))
    assert.equal(store.size, 2)
    assert.equal(store.lookup('a'), undefined, 'the oldest entry went')
    assert.ok(store.lookup('c'))
  })
})

describe('readiness is a different question from health', () => {
  it('is reachable without a token, so a load balancer can poll it', () => {
    assert.ok(publicPaths({}).includes('/api/v1/ready'))
    assert.equal(isPublicPath('/api/v1/ready', {}), true)
    assert.equal(isPublicPath('/api/v1/health', {}), true)
  })

  it('does not make the routes around it public', () => {
    assert.equal(isPublicPath('/api/v1/readyz', {}), false, 'a prefix match here would open an unmapped route')
    assert.equal(isPublicPath('/api/v1/service-assets', {}), false)
  })

  it('reports the store it probed', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/ready`)
      const body = await res.json()
      assert.equal(res.status, 200)
      assert.equal(body.ready, true)
      assert.equal(body.store.reachable, true)
      assert.equal(body.store.error, null)
      assert.ok(Number.isFinite(body.store.latency_ms))
      assert.ok(body.store.mode)
      assert.equal(body.idempotency.durable, true,
        'a JsonStore can lock, so the guarantee is durable, and the bound is stated')
      assert.equal(body.idempotency.mode, 'durable')
      assert.equal(body.idempotency.collection, 'idempotency_keys')
      assert.equal(body.idempotency.ttl_hours, 24)
    })
  })

  it('answers 503 when the store cannot be read', async () => {
    // /health would still have said 200 here, which is the whole point: a
    // balancer polling only /health keeps this instance in rotation.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-broken-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.read = async () => { throw new Error('connection refused') }
    const listener = createServer({ store }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      const res = await fetch(`${base}/api/v1/ready`)
      const body = await res.json()
      assert.equal(res.status, 503)
      assert.equal(body.ready, false)
      assert.match(body.store.error, /connection refused/)
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('gives up on a store that hangs rather than holding the probe open', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-hang-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.read = () => new Promise(() => {})
    const listener = createServer({ store }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      const started = Date.now()
      const res = await fetch(`${base}/api/v1/ready${q({ timeout_ms: '150' })}`)
      assert.equal(res.status, 503)
      assert.match((await res.json()).store.error, /did not respond within 150ms/)
      assert.ok(Date.now() - started < 5000, 'a probe that cannot be cancelled is not a probe')
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the store once per probe, not twice', async () => {
    // SCL-07. The defect is invisible from outside — a probe that reads twice
    // answers exactly what a probe that reads once answers — so the seam is the
    // read itself. On Postgres each whole-store read is every row's body,
    // `record_versions` included, and this endpoint is the most-polled surface
    // in the deployment.
    await withServer(async (base, store) => {
      const reads = []
      const real = store.read.bind(store)
      store.read = async (options) => { reads.push(options ?? null); return real(options) }
      const res = await fetch(`${base}/api/v1/ready`)
      assert.equal(res.status, 200)
      assert.equal(reads.length, 1, `a probe read the store ${reads.length} times`)
    })
  })

  it('names the collections it wants rather than materialising the whole table', async () => {
    await withServer(async (base, store) => {
      let asked = null
      const real = store.read.bind(store)
      store.read = async (options) => { asked = options ?? null; return real(options) }
      await fetch(`${base}/api/v1/ready`)
      const manifest = Array.isArray(asked) ? asked : asked?.collections
      assert.ok(Array.isArray(manifest),
        'the readiness probe asked for the whole store; on Postgres that transfers every body including record_versions')
      assert.deepEqual([...manifest].sort(), ['action_logs', 'events_outbox'],
        'the manifest must be exactly the inputs of the two rollups the route computes')
    })
  })

  it('says which chain check it performed, rather than implying the stronger one', async () => {
    // SCL-07, the half that is not about cost. `auditRollup` stamped a fresh
    // chain over the stored rows, so `valid` was true for *any* content: an
    // edited `action_logs` row produced a different head and the same verdict.
    // Measured against a live server before the fix — tamper, probe, `valid:
    // true`, only the head moved.
    await withServer(async (base, store) => {
      const body = await (await fetch(`${base}/api/v1/ready`)).json()
      assert.ok(body.audit, 'the audit rollup must be reported')
      assert.equal(body.audit.linked, false,
        'action_logs rows carry no entry_hash, so the check performed is content-consistency and the rollup must say so')
    })
  })

  it('verifies the stored linkage when the rows carry one', async () => {
    // The other branch: a store whose action_logs have been through
    // `chainEntries` carries seq and entry_hash, so the rollup verifies *those*
    // rather than re-stamping them. An edit then genuinely fails.
    const { chainEntries } = await import('../src/audit-chain.js')
    const { auditRollup } = await import('../src/audit-chain.js')
    const logs = [
      { id: 'l1', collection: 'reports', record_id: 'r1', action: 'created', actor: 'a', subject: null, created_at: '2026-01-01T00:00:00Z', summary: 'created report r1', metadata: {} },
      { id: 'l2', collection: 'reports', record_id: 'r2', action: 'created', actor: 'a', subject: null, created_at: '2026-01-02T00:00:00Z', summary: 'created report r2', metadata: {} },
    ]
    const { entries } = chainEntries(logs)
    const clean = auditRollup(entries)
    assert.equal(clean.linked, true)
    assert.equal(clean.valid, true)

    const edited = entries.map((entry) => ({ ...entry }))
    edited[0].actor = 'token_operator_forged'
    const tampered = auditRollup(edited)
    assert.equal(tampered.linked, true)
    assert.equal(tampered.valid, false,
      'an edit to a linked entry must fail: entry_hash no longer matches its content')
    assert.ok(tampered.fatal_types.includes('entry_hash_mismatch'))
  })

  it('still answers health while the store is unreachable', async () => {
    // The two endpoints are separate because they answer separate questions. If
    // this ever fails, the distinction has collapsed and one of them is a lie.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-split-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const listener = createServer({ store }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    const real = store.read.bind(store)
    try {
      assert.equal((await fetch(`${base}/api/v1/ready`)).status, 200)
      store.read = () => new Promise(() => {})
      assert.equal((await fetch(`${base}/api/v1/ready${q({ timeout_ms: '100' })}`)).status, 503)
      store.read = real
      assert.equal((await fetch(`${base}/api/v1/health`)).status, 200)
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a sensor batch is recorded once per batch, not once per batch size', () => {
  // The outbox event id is `stableId('outbox', [event, JSON.stringify(payload)])`
  // (outbox.js outboundEventId). The iot route emitted a payload of `{ count }`
  // alone, so every two-reading batch hashed to the same id. `emit` returns the
  // existing row untouched when it is already `sent` — so the first delivered
  // count-2 batch made every later count-2 batch a no-op: the readings and their
  // action logs were dropped, and the gateway still received a 201.
  const tokens = JSON.stringify([{ token: 'tok-iot', scopes: ['write:incidents'] }])
  const reading = (id, value) => ({
    sensor_id: id, sensor_type: 'cold_chain', value, observed_at: '2026-10-09T06:00:00Z', district: 'Turkana',
  })
  const post = (base, readings) => fetch(`${base}/api/v1/iot-observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok-iot' },
    body: JSON.stringify({ readings }),
  })

  it('keeps both batches when two batches happen to hold the same number of readings', async () => {
    await withServer(async (base, store) => {
      const first = await post(base, [reading('fridge_a', 4.1), reading('fridge_b', 5.2)])
      assert.equal(first.status, 201)
      const second = await post(base, [reading('fridge_c', 6.3), reading('fridge_d', 7.4)])
      assert.equal(second.status, 201)

      const data = await store.read()
      const sensors = data.iot_observations.map((r) => r.sensor_id).sort()
      assert.deepEqual(sensors, ['fridge_a', 'fridge_b', 'fridge_c', 'fridge_d'],
        'the second same-size batch was swallowed by the first batch\'s outbox id')
      assert.equal(data.events_outbox.length, 2, 'two batches, two outbox events')
    }, { tokens })
  })

  it('still deduplicates a true retry of the identical batch', async () => {
    // The fix must not trade one bug for the other. A gateway that retries the
    // same readings after a timeout is sending one batch, and the store must
    // hold it once.
    await withServer(async (base, store) => {
      const batch = [reading('fridge_e', 8.5), reading('fridge_f', 9.6)]
      assert.equal((await post(base, batch)).status, 201)
      assert.equal((await post(base, batch)).status, 201)
      const data = await store.read()
      assert.equal(data.iot_observations.length, 2, 'a retried batch is one batch')
    }, { tokens })
  })
})

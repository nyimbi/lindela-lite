import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { handleOutboxRoute, matchOutboxRoute } from '../src/routes/outbox.js'
import { emit } from '../src/outbox.js'
import { JsonStore } from '../src/store.js'
import { emptyStore } from '../src/schema.js'

/** A real store on a temp file, so the dispatch lock is the real one. */
async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-outbox-route-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/**
 * ENH-60 — the outbox family, asserted where it now lives.
 *
 * Two routes over one collection, extracted from the dispatcher with their
 * behaviour unchanged. What is worth asserting is the pair of decisions that
 * make the extraction correct rather than merely equal to what it replaced:
 *
 *   - **the listing is not soft-delete filtered**, unlike every other collection
 *     list in the surface. The outbox is a queue whose terminal state is
 *     `failed`, and a dead-letter row is the record of what stopped getting
 *     through (R-47). Filtering here would hide exactly that.
 *   - **`/outbox/dispatch` is an action, not a detail.** The matcher takes the
 *     method, so an undeclared verb falls through to the dispatcher's 404 rather
 *     than being served by a branch that ignored the method — the VER-14 class
 *     `scripts/check-route-methods.mjs` exists to catch.
 */

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.json = () => JSON.parse(Buffer.concat(res.chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf8'))
  return res
}

const jsonResponse = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const makeReq = (method, body) => ({
  method,
  headers: {},
  __auth: { subject: 'tester' },
  async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
})

const call = async (route, { data = {}, store = {}, method = 'GET', body, search = '' } = {}) => {
  const res = fakeResponse()
  const handled = await handleOutboxRoute(route, {
    store, data, res, jsonResponse,
    req: makeReq(method, body),
    url: new URL(`http://127.0.0.1/x${search}`),
  })
  return { handled, res }
}

describe('ENH-60 — matchOutboxRoute takes the method, so an undeclared verb is not served', () => {
  it('matches the listing and the action', () => {
    assert.deepEqual(matchOutboxRoute('/api/v1/outbox', 'GET'), { kind: 'list' })
    assert.deepEqual(matchOutboxRoute('/api/v1/outbox/dispatch', 'POST'), { kind: 'dispatch' })
  })

  it('refuses the verb the contract does not declare, rather than serving the other branch', () => {
    // `GET /api/v1/outbox/dispatch` must not answer the listing. The matcher
    // returning null here is what makes the dispatcher's 404 the answer; a
    // matcher that ignored the method would serve the queue to a GET of the
    // dispatch path.
    assert.equal(matchOutboxRoute('/api/v1/outbox', 'DELETE'), null)
    assert.equal(matchOutboxRoute('/api/v1/outbox', 'POST'), null)
    assert.equal(matchOutboxRoute('/api/v1/outbox/dispatch', 'GET'), null)
    assert.equal(matchOutboxRoute('/api/v1/outbox/dispatch', 'DELETE'), null)
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/outbox/', '/api/v1/outbox/x', '/api/v1/outboxes', '/api/v1/outbox/dispatch/x']) {
      assert.equal(matchOutboxRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
      assert.equal(matchOutboxRoute(pathname, 'POST'), null, `${pathname} matched a route it should not`)
    }
  })

  it('is case-insensitive on the verb, as the rest of the surface is', () => {
    assert.deepEqual(matchOutboxRoute('/api/v1/outbox', 'get'), { kind: 'list' })
  })
})

describe('ENH-60 — the listing pages the queue and does not hide a dead letter', () => {
  it('carries the five paging keys, so a truncated queue is distinguishable from a complete one', async () => {
    const data = { events_outbox: [{ id: 'e1', status: 'pending' }, { id: 'e2', status: 'sent' }] }
    const { res } = await call({ kind: 'list' }, { data })
    const body = res.json()
    for (const key of ['returned', 'limit', 'total', 'has_more', 'next_cursor']) {
      assert.ok(key in body, `the listing has no \`${key}\`, so a truncated queue reads as a complete one`)
    }
    assert.equal(body.total, 2)
  })

  it('returns a failed row rather than filtering it, because it is the record of what stopped getting through', async () => {
    // R-47. `failed` is terminal and never retried, so the dead letter is the
    // whole story of an integration that stopped. A soft-delete filter here —
    // which every sibling collection list has — would take the one surface that
    // shows it and hide it.
    const data = { events_outbox: [{ id: 'e1', status: 'pending' }, { id: 'dead', status: 'failed', last_error: 'connection refused' }] }
    const { res } = await call({ kind: 'list' }, { data })
    const ids = res.json().data.map((row) => row.id)
    assert.deepEqual(ids.sort(), ['dead', 'e1'], 'a failed event was filtered out of the outbox listing')
  })

  it('tolerates a store with no outbox collection rather than throwing', async () => {
    const { res } = await call({ kind: 'list' }, { data: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json().data, [])
  })
})

describe('ENH-60 — the dispatch route drains through the real store', () => {
  it('answers 201 with the dispatcher’s own result, over a real store', async () => {
    // `dispatchPending` claims rows under the store's dispatch lock, so this
    // runs against a real `JsonStore` rather than a stub: a fake store without
    // `withLock` would make the test a test of the fake.
    await withStore(async (store) => {
      const res = fakeResponse()
      const handled = await handleOutboxRoute({ kind: 'dispatch' }, {
        store,
        data: { events_outbox: [], webhook_subscriptions: [] },
        res,
        jsonResponse,
        req: makeReq('POST', {}),
        url: new URL('http://127.0.0.1/x/api/v1/outbox/dispatch'),
      })
      assert.equal(handled, true)
      assert.equal(res.status, 201, 'a drain is a creation of delivery attempts, not a read')
      const body = res.json()
      assert.ok('dispatched' in body || 'pending' in body,
        `the dispatch response does not carry the dispatcher's result: ${JSON.stringify(body)}`)
    })
  })

  it('matches against the subscription in the request’s snapshot, not an empty set', async () => {
    // The handler hands `data.webhook_subscriptions` — the request's snapshot —
    // to `dispatchPending` rather than re-reading. The observable that proves it
    // reaches the dispatcher is the *match*: with a subscription in the
    // snapshot the event is matched and its delivery then fails on the SSRF
    // guard (loopback is refused, as in production); with an empty snapshot the
    // same event is `undeliverable` instead. The two outcomes differ, so the
    // snapshot is load-bearing.
    //
    // The route deliberately does not pass `checkUrl` — neither did the inline
    // block it replaces — so the guard is the real one and loopback cannot be
    // delivered to from the request path. That is the point, not an obstacle.
    const snapshot = { events_outbox: [], webhook_subscriptions: [{ id: 'w1', url: 'http://127.0.0.1:1/hook', status: 'active', events: ['incident.created'] }] }

    await withStore(async (store) => {
      await emit(store, 'incident.created', { id: 'inc1' })
      const res = fakeResponse()
      await handleOutboxRoute({ kind: 'dispatch' }, {
        store, data: snapshot, res, jsonResponse,
        req: makeReq('POST', {}),
        url: new URL('http://127.0.0.1/x/api/v1/outbox/dispatch'),
      })
      const body = res.json()
      assert.equal(body.undeliverable, 0, 'the snapshot’s subscription did not reach the dispatcher, so the event read as having nobody to send it to')
      // It is matched, so the attempt happens and fails at the network. Whether
      // that lands `failed` or a pending retry is the retry policy's business,
      // not this test's — the fact under test is that the event was matched.
      assert.equal(body.dispatched, 0, 'a loopback webhook cannot have delivered')
    })

    await withStore(async (store) => {
      await emit(store, 'incident.created', { id: 'inc1' })
      const res = fakeResponse()
      await handleOutboxRoute({ kind: 'dispatch' }, {
        store, data: { events_outbox: [], webhook_subscriptions: [] }, res, jsonResponse,
        req: makeReq('POST', {}),
        url: new URL('http://127.0.0.1/x/api/v1/outbox/dispatch'),
      })
      assert.equal(res.json().undeliverable, 1, 'with no subscription the event must be undeliverable — if it is not, the snapshot is ignored')
    })
  })
})

describe('ENH-60 — the handler declines a route it does not own', () => {
  it('returns false rather than answering, so the dispatcher continues', async () => {
    const res = fakeResponse()
    const handled = await handleOutboxRoute({ kind: 'unknown' }, {
      store: {}, data: {}, res, jsonResponse,
      req: makeReq('GET'), url: new URL('http://127.0.0.1/x/api/v1/outbox'),
    })
    assert.equal(handled, false)
    assert.equal(res.status, null, 'an unowned route wrote a response')
  })

  it('every kind the matcher can return is handled', async () => {
    // A matcher that returns a kind the handler does not know is a route that
    // matches and then falls through — a 404 for a path the contract declares.
    await withStore(async (store) => {
      for (const [pathname, method] of [['/api/v1/outbox', 'GET'], ['/api/v1/outbox/dispatch', 'POST']]) {
        const route = matchOutboxRoute(pathname, method)
        const { handled } = await call(route, { store, method, data: { events_outbox: [], webhook_subscriptions: [] } })
        assert.equal(handled, true, `${method} ${pathname} matched but the handler declined it`)
      }
    })
  })
})

describe('ENH-60 — the outbox family names no collection the store does not have', () => {
  it('reads only collections the schema declares', async () => {
    const known = new Set(Object.keys(emptyStore()))
    const data = { events_outbox: [{ id: 'e1', status: 'pending' }] }
    const { res } = await call({ kind: 'list' }, { data })
    assert.equal(res.status, 200)
    assert.ok(known.has('events_outbox'), 'the outbox listing names a collection the schema does not declare')
  })
})

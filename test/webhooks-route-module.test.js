import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleWebhookRoute, matchWebhookRoute } from '../src/routes/webhooks.js'
import { runWithRequestContext } from '../src/utils.js'

/**
 * ARC-01 — the webhook family as a module, asserted where it now lives.
 *
 * The property that makes these routes one module is that this is the only
 * place a caller registers a destination the platform will later fetch. Two
 * consequences are asserted here:
 *
 *   - **the by-id read resolves through `findVisible`.** VUL-03 lived here: the
 *     listing was scoped and the by-id form was not, so a partner token could
 *     read another organisation's subscription — its URL and its secret — by
 *     guessing an id it saw in a listing.
 *   - **the URL is checked at registration**, so a subscriber cannot store a
 *     target that reaches the platform's own network.
 */

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

const makeReq = (method, body, auth = { subject: 'tester', partner_org: null }) => ({
  method,
  headers: {},
  __auth: auth,
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

function recordingStore() {
  const state = { webhook_subscriptions: [], action_logs: [] }
  return {
    state,
    async read() { return state },
    async merge(partial) {
      for (const [collection, records] of Object.entries(partial)) {
        state[collection] = [...(state[collection] || []), ...records]
      }
      return partial
    },
  }
}

const call = (route, { data = {}, method = 'GET', body, auth, store = recordingStore(), search = '' } = {}) => {
  const res = fakeResponse()
  // `findVisible` reads the caller from the request's async context, not from
  // `req.__auth` — the same ALS the real dispatcher establishes — so the call
  // is wrapped the way `handleApiRequest` wraps it.
  return runWithRequestContext(auth, () => handleWebhookRoute(route, {
    store, data, res, jsonResponse,
    req: makeReq(method, body, auth),
    url: new URL(`http://127.0.0.1/x${search}`),
  })).then((handled) => ({ handled, res, store }))
}

const sub = (over = {}) => ({
  id: 'sub1', url: 'https://partner.example/hook', events: ['alert.*'],
  headers: {}, secret: null, status: 'active',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  partner_org: 'org-a', ...over,
})

describe('ARC-01 — matchWebhookRoute', () => {
  it('matches the collection and its detail with one optional tail', () => {
    assert.deepEqual(matchWebhookRoute('/api/v1/webhooks'), { id: null })
    assert.deepEqual(matchWebhookRoute('/api/v1/webhooks/sub1'), { id: 'sub1' })
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/webhook', '/api/v1/webhooks/a/b', '/api/v1/webhooks/']) {
      assert.equal(matchWebhookRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — the by-id read is scoped like the listing beside it', () => {
  it('hides another organisation’s subscription from a partner-scoped token', async () => {
    const data = { webhook_subscriptions: [sub({ id: 'other', partner_org: 'org-b' })] }
    const { res } = await call({ id: 'other' }, { data, auth: { subject: 'p', partner_org: 'org-a' } })
    assert.equal(res.status, 404, 'a partner read another organisation’s subscription by id')
  })

  it('returns the caller’s own subscription', async () => {
    const data = { webhook_subscriptions: [sub({ id: 'mine', partner_org: 'org-a' })] }
    const { res } = await call({ id: 'mine' }, { data, auth: { subject: 'p', partner_org: 'org-a' } })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.id, 'mine')
  })
})

describe('ARC-01 — the URL is checked at registration', () => {
  it('refuses to store a target that reaches the platform’s own network', async () => {
    const store = recordingStore()
    const { res } = await call({ id: null }, {
      method: 'POST', body: { url: 'http://127.0.0.1:4177/api/v1/internal', events: ['alert.*'] }, store,
    })
    assert.equal(res.status, 400, 'an internal URL was accepted at registration')
    assert.equal(store.state.webhook_subscriptions.length, 0, 'an internal URL reached the store')
  })

  it('stores a well-formed public subscription', async () => {
    const store = recordingStore()
    const { res } = await call({ id: null }, {
      method: 'POST', body: { url: 'https://partner.example/hook', events: ['alert.*'] }, store,
    })
    assert.equal(res.status, 201)
    assert.equal(store.state.webhook_subscriptions.length, 1)
  })

  it('refuses a subscription with no events', async () => {
    const { res } = await call({ id: null }, { method: 'POST', body: { url: 'https://partner.example/hook' } })
    assert.equal(res.status, 400, 'a subscription with no events was accepted')
  })
})

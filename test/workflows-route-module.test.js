import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleWorkflowRoute, matchWorkflowRoute } from '../src/routes/workflows.js'

/**
 * ARC-01 — the workflow family as a module, asserted where it now lives.
 *
 * Two properties make this one family:
 *
 *   - **a transition records where the actor came from.** The handler prefers
 *     the authenticated subject and keeps the caller's own `body.actor` as a
 *     separate `claimed_actor` rather than promoting it. The old code read
 *     `req.__auth?.subject || 'anonymous'`, so on an unauthenticated deployment
 *     every transition — including who approved an anticipatory alert — was
 *     logged as "anonymous" and a supplied actor was thrown away.
 *   - **the metrics view is computed and has no `data[...]` key**, so the
 *     `route.action` guard is what carries the branch. A generic collection
 *     branch reaching it would read `undefined` and 500.
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

const makeReq = (method, body, auth = { subject: 'verified-user' }) => ({
  method,
  headers: {},
  __auth: auth,
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

/** A store `emit` can drive: `withLock` hands back a read/merge pair. */
function lockedStore() {
  const state = { workflow_instances: [], events_outbox: [], action_logs: [] }
  const locked = {
    async read() { return state },
    async merge(partial) {
      for (const [collection, records] of Object.entries(partial)) {
        state[collection] = [...(state[collection] || []), ...records]
      }
      return partial
    },
  }
  return {
    state,
    async read() { return state },
    async merge(partial) { return locked.merge(partial) },
    async withLock(fn) { return fn(locked) },
  }
}

const call = (route, { data = {}, method = 'GET', body, auth, store = lockedStore(), search = '' } = {}) => {
  const res = fakeResponse()
  return handleWorkflowRoute(route, {
    store, data, res, jsonResponse,
    req: makeReq(method, body, auth),
    url: new URL(`http://127.0.0.1/x${search}`),
  }).then((handled) => ({ handled, res, store }))
}

const instance = (over = {}) => ({
  id: 'w1', type: 'anticipatory_alert', state: 'signal_detected',
  subject_kind: 'alert_event', subject_id: 'a1', district: 'Turkana', owner: '',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  closed_at: null, transitions: [], metadata: {}, ...over,
})

describe('ARC-01 — matchWorkflowRoute', () => {
  it('matches the collection, the detail, the metrics view and the transition', () => {
    assert.deepEqual(matchWorkflowRoute('/api/v1/workflows'), { id: null })
    assert.deepEqual(matchWorkflowRoute('/api/v1/workflows/w1'), { id: 'w1' })
    assert.deepEqual(matchWorkflowRoute('/api/v1/workflows/metrics'), { action: 'metrics' })
    assert.deepEqual(matchWorkflowRoute('/api/v1/workflows/w1/transition'), { id: 'w1', action: 'transition' })
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/workflow', '/api/v1/workflows/w1/transitions', '/api/v1/workflows/w1/x']) {
      assert.equal(matchWorkflowRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — the metrics view is computed, not a data[...] key', () => {
  it('answers the roll-up rather than reading a collection that is not there', async () => {
    const data = { workflow_instances: [instance(), instance({ id: 'w2', state: 'closed' })] }
    const { handled, res } = await call({ action: 'metrics' }, { data })
    assert.equal(handled, true)
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.data.open, 1, 'the metrics view did not count the open instance')
    assert.equal(body.data.closed, 1, 'the metrics view did not count the closed instance')
  })
})

describe('ARC-01 — a transition records where the actor came from', () => {
  it('prefers the verified subject and keeps a claimed actor separate', async () => {
    const data = { workflow_instances: [instance()] }
    const { res, store } = await call({ id: 'w1', action: 'transition' }, {
      data, method: 'POST', body: { to: 'focal_point_review', actor: 'someone-claiming' },
      auth: { subject: 'verified-user' },
    })
    assert.equal(res.status, 200)
    const updated = res.json().data
    const transition = updated.transitions.at(-1)
    assert.equal(transition.actor, 'verified-user', 'the verified subject was not preferred')
    assert.equal(transition.actor_source, 'authenticated')
    assert.equal(transition.claimed_actor, 'someone-claiming', 'the claimed actor was thrown away')
    // The outbox event was written, so the transition is announced.
    assert.ok(store.state.events_outbox.length >= 1, 'no outbox event was emitted')
  })

  it('records an unattributed transition as unattributed, not as a claim', async () => {
    const data = { workflow_instances: [instance()] }
    const { res } = await call({ id: 'w1', action: 'transition' }, {
      data, method: 'POST', body: { to: 'focal_point_review' },
      auth: {}, // no verified subject, no claimed actor
    })
    const transition = res.json().data.transitions.at(-1)
    assert.equal(transition.actor_source, 'unattributed', 'an absent actor was recorded as a claim')
    assert.equal(transition.claimed_actor, null)
  })

  it('refuses a transition the state machine does not allow', async () => {
    const data = { workflow_instances: [instance()] }
    const { res } = await call({ id: 'w1', action: 'transition' }, {
      data, method: 'POST', body: { to: 'closed' }, // signal_detected → focal_point_review only
    })
    assert.equal(res.status, 409, 'an illegal transition was not refused')
    assert.equal(res.json().success, false)
  })

  it('answers 404 for a transition on a workflow that is not there', async () => {
    const { res } = await call({ id: 'missing', action: 'transition' }, {
      data: { workflow_instances: [] }, method: 'POST', body: { to: 'focal_point_review' },
    })
    assert.equal(res.status, 404)
  })
})

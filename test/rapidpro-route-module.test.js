import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleRapidProRoute, matchRapidProRoute } from '../src/routes/rapidpro.js'

/**
 * ARC-01 — the RapidPro family as a module, asserted where it now lives.
 *
 * Every route here is a view onto the SMS channel: the same dispatch/inbound
 * pair read five ways and written two. The writes share a threat model the reads
 * do not, which is what makes this one module:
 *
 *   - **the signature is verified before the body is trusted.** Both POST doors
 *     call `verifyRapidProWebhook` first. A reply that can close an SLA is
 *     attacker-controlled input, so an unsigned one is a 401 before anything is
 *     parsed.
 *   - **an uncorrelated reply is recorded, not dropped.** An unrecognised sender
 *     is what a wrong number looks like, and it is information.
 *   - **a correlated reply's writes are built by hand.** `reconcileInbound`
 *     returns a descriptor, not a collection map — handing it to `store.merge`
 *     threw "Undeclared collections: inbound, duplicate, applied" on every
 *     reply.
 *   - **a correlated `DONE` writes the inbound and the outcome in one merge.**
 *     Two writes would let the confirmation be recorded without the outcome.
 */

const SECRET = 'test-rapidpro-secret'
// `verifyRapidProWebhook` reads `process.env` directly, so the door has to be
// configured for the handler to reach its verification path rather than the
// unconfigured-secret 503. Set once, for the whole file.
process.env.RAPIDPRO_WEBHOOK_SECRET = SECRET

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

/**
 * A request whose raw body is the exact bytes of `body`, with the HMAC signature
 * header a body-signed webhook carries. Only the field-report door can use this:
 * it buffers `req.rawBody` itself. The reply door never gets a buffered body (see
 * `secretReq`).
 */
const signedReq = (method, body, { secret = SECRET, signature = true } = {}) => {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const headers = {}
  if (signature) headers['x-rapidpro-signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex')
  return { method, headers, __auth: { subject: 'rapidpro' }, __rawBody: raw, async *[Symbol.asyncIterator]() {} }
}

/**
 * The shared-secret header door. `verifyRapidProWebhook` accepts a header secret
 * when there is no signature header, and the reply door relies on it: unlike the
 * field-report door, the dispatcher never buffers `req.rawBody` for
 * `/rapidpro/reply`, so an HMAC signature there fails closed. That is the
 * pre-existing shape at HEAD, carried over unchanged.
 */
const secretReq = (method, body, { secret = SECRET, header = 'x-rapidpro-secret' } = {}) => {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const headers = secret === null ? {} : { [header]: secret }
  return { method, headers, __auth: { subject: 'rapidpro' }, __rawBody: raw, async *[Symbol.asyncIterator]() {} }
}

const plainReq = (method, body) => {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return { method, headers: {}, __auth: { subject: 'operator' }, __rawBody: raw, async *[Symbol.asyncIterator]() {} }
}

function recordingStore(initial = {}) {
  const state = {
    rapidpro_dispatches: [], rapidpro_inbound_messages: [], alert_events: [],
    field_outcomes: [], incidents: [], field_reports: [], action_logs: [], ...initial,
  }
  const merges = []
  return {
    state,
    merges,
    async read() { return state },
    async merge(partial) {
      merges.push(partial)
      for (const [collection, records] of Object.entries(partial)) {
        state[collection] = [...(state[collection] || []), ...records]
      }
      return partial
    },
  }
}

const call = (route, { method = 'GET', req, body, store = recordingStore(), search = '' } = {}) => {
  const res = fakeResponse()
  return handleRapidProRoute(route, {
    store, data: store.state, res, jsonResponse,
    req: req || plainReq(method, body),
    url: new URL(`http://127.0.0.1/x${search}`),
  }).then((handled) => ({ handled, res, store }))
}

const dispatch = (over = {}) => ({
  id: 'd1', provider: 'rapidpro', alert_event_id: 'alert_1', severity: 'high', status: 'sent',
  recipients: { urns: ['tel:+254700000001'], contacts: [], groups: [] },
  created_at: new Date().toISOString(),
  ...over,
})

describe('ARC-01 — matchRapidProRoute', () => {
  it('matches the eight literals and the send path', () => {
    assert.deepEqual(matchRapidProRoute('/api/v1/rapidpro/status'), { kind: 'status' })
    assert.deepEqual(matchRapidProRoute('/api/v1/rapidpro/reply'), { kind: 'rapidpro-reply' })
    assert.deepEqual(matchRapidProRoute('/api/v1/rapidpro/alert-events/ae1/send'), { kind: 'send-alert', id: 'ae1' })
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/rapidpro', '/api/v1/rapidpro/alert-events/ae1/sent', '/api/v1/rapidpro/statuses']) {
      assert.equal(matchRapidProRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — the signature is verified before the body is trusted', () => {
  it('refuses an unsigned field report', async () => {
    const store = recordingStore()
    const { res } = await call({ kind: 'field-report' }, {
      method: 'POST', req: signedReq('POST', { text: 'flood' }, { signature: false }), store,
    })
    assert.equal(res.status, 401, 'an unsigned field report was accepted')
    assert.equal(store.state.rapidpro_inbound_messages.length, 0, 'an unsigned report reached the store')
  })

  it('refuses a reply with the wrong shared secret', async () => {
    const { res } = await call({ kind: 'rapidpro-reply' }, {
      method: 'POST', req: secretReq('POST', { from: '+254700000001', text: 'ACK' }, { secret: 'wrong' }),
    })
    assert.equal(res.status, 401, 'a badly authenticated reply was accepted')
  })

  it('refuses an unsigned reply', async () => {
    const { res } = await call({ kind: 'rapidpro-reply' }, {
      method: 'POST', req: plainReq('POST', { from: '+254700000001', text: 'ACK' }),
    })
    assert.equal(res.status, 401)
  })
})

describe('ARC-01 — a reply is correlated by sender, not by a payload field', () => {
  it('records an uncorrelated reply rather than dropping it', async () => {
    const store = recordingStore()
    const { res } = await call({ kind: 'rapidpro-reply' }, {
      method: 'POST', req: secretReq('POST', { from: '+254799999999', text: 'ACK' }), store,
    })
    assert.equal(res.status, 202, 'an uncorrelated reply was not answered with 202')
    assert.equal(res.json().correlated, false)
    const recorded = store.state.rapidpro_inbound_messages
    assert.equal(recorded.length, 1, 'an unrecognised sender was dropped')
    assert.equal(recorded[0].event_type, 'reply_unmatched')
  })

  it('correlates a reply from a dispatch recipient by sender', async () => {
    const store = recordingStore({ rapidpro_dispatches: [dispatch()] })
    const { res } = await call({ kind: 'rapidpro-reply' }, {
      method: 'POST', req: secretReq('POST', { from: 'tel:+254700000001', text: 'ACK' }), store,
    })
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.correlated, true)
    assert.equal(body.dispatch_id, 'd1', 'the reply was not correlated to the dispatch by sender')
    assert.equal(body.alert_event_id, 'alert_1')
    // The descriptor's keys never became collection names — the writes are
    // built by hand, so no `inbound`/`duplicate`/`applied` collection exists.
    for (const key of Object.keys(store.merges.at(-1))) {
      assert.ok(store.state[key] !== undefined, `merge wrote an undeclared collection: ${key}`)
    }
  })

  it('resolves the most recent dispatch to that sender when the payload names none', async () => {
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const store = recordingStore({
      rapidpro_dispatches: [
        dispatch({ id: 'd1', alert_event_id: 'alert_1', created_at: older }),
        dispatch({ id: 'd2', alert_event_id: 'alert_2' }),
      ],
    })
    const { res } = await call({ kind: 'rapidpro-reply' }, {
      method: 'POST',
      req: secretReq('POST', { from: 'tel:+254700000001', text: 'ACK' }),
      store,
    })
    const body = res.json()
    assert.equal(body.dispatch_id, 'd2', 'correlation did not pick the most recent dispatch to this sender')
    assert.equal(body.alert_event_id, 'alert_2')
  })
})

describe('ARC-01 — a correlated DONE writes the inbound and the outcome in one merge', () => {
  it('records the field outcome beside the inbound, in the same merge', async () => {
    const store = recordingStore({
      rapidpro_dispatches: [dispatch()],
      alert_events: [{ id: 'alert_1', status: 'open', metadata: {} }],
    })
    const { res } = await call({ kind: 'rapidpro-reply' }, {
      method: 'POST',
      req: secretReq('POST', { from: 'tel:+254700000001', text: 'DONE supplies_arrived reached 40 households' }),
      store,
    })
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.verb, 'DONE')
    assert.ok(body.field_outcome_id, 'a correlated DONE did not record a field outcome')
    assert.equal(store.state.field_outcomes.length, 1)
    // The inbound and the outcome were handed over in one merge, so a
    // confirmation cannot be recorded without the outcome it claims.
    const last = store.merges.at(-1)
    assert.ok(last.rapidpro_inbound_messages?.length >= 1,
      'the DONE reply was written without its inbound')
    assert.ok(last.field_outcomes?.length === 1,
      'the field outcome was written in a merge of its own, not with the inbound')
  })

  it('keeps the inbound but refuses an outcome for a DONE with no recognised code', async () => {
    const store = recordingStore({
      rapidpro_dispatches: [dispatch()],
      alert_events: [{ id: 'alert_1', status: 'open', metadata: {} }],
    })
    const { res } = await call({ kind: 'rapidpro-reply' }, {
      method: 'POST', req: secretReq('POST', { from: 'tel:+254700000001', text: 'DONE' }), store,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().field_outcome_id, null)
    assert.match(res.json().field_outcome, /refused/)
    assert.equal(store.state.field_outcomes.length, 0, 'an invented outcome code was recorded')
    assert.equal(store.state.rapidpro_inbound_messages.length, 1, 'the reply itself was lost')
  })
})

describe('ARC-01 — the send action gates on approval', () => {
  it('refuses to send an alert that is not approved', async () => {
    const store = recordingStore({ alert_events: [{ id: 'ae1', approval: { state: 'proposed' } }] })
    const { res } = await call({ kind: 'send-alert', id: 'ae1' }, { method: 'POST', body: {}, store })
    assert.equal(res.status, 409, 'an unapproved alert was sent')
    assert.equal(res.json().current_state, 'proposed')
  })

  it('answers 404 for an alert that is not there', async () => {
    const { res } = await call({ kind: 'send-alert', id: 'missing' }, {
      method: 'POST', body: {}, store: recordingStore({ alert_events: [] }),
    })
    assert.equal(res.status, 404)
  })
})

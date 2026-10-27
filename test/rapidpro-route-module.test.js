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

  it('writes one row when a retried webhook from an unrecognised sender arrives twice', async () => {
    // DATA-12, on the branch ALERT-06's own tests did not reach. The orphan id
    // keyed on `Date.now()` under the prefix `inbound`, so two deliveries of one
    // message wrote two rows — and neither could dedupe against a correlated
    // reply, which is keyed `rapidpro_inbound`.
    const store = recordingStore()
    const body = { from: '+254799999999', text: 'ACK', received_on: '2026-10-18T09:00:00.000Z' }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await call({ kind: 'rapidpro-reply' }, { method: 'POST', req: secretReq('POST', body), store })
    }
    const rows = store.state.rapidpro_inbound_messages
    assert.equal(rows.length, 2, 'the two deliveries were not both merged into the recording store')
    assert.equal(new Set(rows.map((r) => r.id)).size, 1,
      'a retried webhook from an unrecognised sender minted a second inbound id — the store keeps both rows')
    assert.ok(rows[0].id.startsWith('rapidpro_inbound_'),
      `the orphan id carries the prefix ${rows[0].id.split('_').slice(0, 2).join('_')}, which the correlated path never uses, so the two can never dedupe against each other`)
  })

  it('gives a genuinely different message from the same sender its own row', async () => {
    // The control: a constant id would satisfy the case above and collapse every
    // wrong number into one row.
    const store = recordingStore()
    for (const text of ['ACK', 'DONE']) {
      await call({ kind: 'rapidpro-reply' }, {
        method: 'POST', req: secretReq('POST', { from: '+254799999999', text, received_on: '2026-10-18T09:00:00.000Z' }), store,
      })
    }
    const ids = new Set(store.state.rapidpro_inbound_messages.map((r) => r.id))
    assert.equal(ids.size, 2, 'two different messages from one sender shared an id')
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

  it('applies the reply window the operator configured, not the 24 h default', async () => {
    // `RAPIDPRO_REPLY_WINDOW_MINUTES` was read as `Number(x || 1440)` and then
    // handed to a function that never looked at the option, so the setting had
    // no effect at all. The route now passes the raw value, which is what makes
    // an absent variable fall through to `RAPIDPRO_REPLY_CORRELATION_HOURS`
    // instead of being replaced by a 1440-minute window that silently overrides
    // the hours setting an operator configured.
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const store = recordingStore({ rapidpro_dispatches: [dispatch({ created_at: older })] })
    const saved = {
      window: process.env.RAPIDPRO_REPLY_WINDOW_MINUTES,
      hours: process.env.RAPIDPRO_REPLY_CORRELATION_HOURS,
    }
    delete process.env.RAPIDPRO_REPLY_WINDOW_MINUTES
    // Six minutes. An hour-old dispatch is outside it, inside the 24 h default.
    process.env.RAPIDPRO_REPLY_CORRELATION_HOURS = '0.1'
    try {
      const { res } = await call({ kind: 'rapidpro-reply' }, {
        method: 'POST', req: secretReq('POST', { from: 'tel:+254700000001', text: 'ACK' }), store,
      })
      assert.equal(res.json().correlated, false,
        'an hour-old dispatch still correlated with the hours setting narrowed to six minutes')
    } finally {
      if (saved.window === undefined) delete process.env.RAPIDPRO_REPLY_WINDOW_MINUTES
      else process.env.RAPIDPRO_REPLY_WINDOW_MINUTES = saved.window
      if (saved.hours === undefined) delete process.env.RAPIDPRO_REPLY_CORRELATION_HOURS
      else process.env.RAPIDPRO_REPLY_CORRELATION_HOURS = saved.hours
    }
  })

  it('refuses a reply window it cannot read rather than widening it to a day', async () => {
    // `Number('0') || 1440` turned a zero into 24 hours: the one value an
    // operator would set to close the window immediately was the one that
    // opened it widest, and nothing said so.
    const store = recordingStore({ rapidpro_dispatches: [dispatch()] })
    const saved = process.env.RAPIDPRO_REPLY_WINDOW_MINUTES
    try {
      for (const bad of ['0', '-5', 'abc']) {
        process.env.RAPIDPRO_REPLY_WINDOW_MINUTES = bad
        await assert.rejects(
          call({ kind: 'rapidpro-reply' }, {
            method: 'POST', req: secretReq('POST', { from: 'tel:+254700000001', text: 'ACK' }), store,
          }),
          /correlationWindowMinutes must be a positive number/,
          `accepted ${JSON.stringify(bad)}`,
        )
      }
    } finally {
      if (saved === undefined) delete process.env.RAPIDPRO_REPLY_WINDOW_MINUTES
      else process.env.RAPIDPRO_REPLY_WINDOW_MINUTES = saved
    }
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

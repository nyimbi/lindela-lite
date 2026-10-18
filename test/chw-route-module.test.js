import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it, mock } from 'node:test'

import { handleChwRoute, matchChwRoute } from '../src/routes/chw.js'

/**
 * ARC-01 — the CHW family as a module, asserted where it now lives.
 *
 * The end-to-end behaviour is covered through the server by
 * `test/privacy-chw-report.test.js` and the offline suites; what those cannot
 * see is what makes these two routes one module:
 *
 *   - **an absent fix is not a point at Null Island.** Location was
 *     `body.location?.latitude || 0`, which turned a missing fix, an explicit
 *     null and a real zero alike into 0/0. A field report is a disease signal,
 *     and a signal at a fixed ocean coordinate looks located.
 *   - **the category is a taxonomy value, not the form name.** The route writes
 *     `field_reports` directly, so the registry has to be called here too; a
 *     value the taxonomy does not know is a 400, not a stored record.
 *   - **the redactor sees the object it stores.** The inbound is redacted, so a
 *     reporter's name and number do not survive into the export.
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

/** A request whose body is already buffered, so `readRequestJson` reads it. */
const makeReq = (method, body) => ({
  method,
  headers: {},
  __auth: { subject: 'chw-tester' },
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

/** A store that records what was merged, so the writes are inspectable. */
function recordingStore(initial = {}) {
  const merged = []
  const state = { field_reports: [], rapidpro_inbound_messages: [], action_logs: [], ...initial }
  return {
    merged,
    state,
    async read() { return state },
    async merge(partial) {
      merged.push(partial)
      for (const [collection, records] of Object.entries(partial)) {
        state[collection] = [...(state[collection] || []), ...records]
      }
      return partial
    },
  }
}

const call = (route, { data = {}, method = 'POST', body, store = recordingStore() } = {}) => {
  const res = fakeResponse()
  return handleChwRoute(route, {
    store, data, res, jsonResponse, req: makeReq(method, body),
  }).then((handled) => ({ handled, res, store }))
}

describe('ARC-01 — matchChwRoute', () => {
  it('matches the two CHW paths and nothing else', () => {
    assert.deepEqual(matchChwRoute('/api/v1/chw/report'), { kind: 'report' })
    assert.deepEqual(matchChwRoute('/api/v1/chw/reply'), { kind: 'reply' })
    for (const pathname of ['/api/v1/chw', '/api/v1/chw/report/1', '/api/v1/chw/reports', '/api/v1/chw/reply/']) {
      assert.equal(matchChwRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — an absent fix is null, never Null Island', () => {
  it('stores null coordinates and location_source unknown when no fix is sent', async () => {
    const { res, store } = await call({ kind: 'report' }, { body: { description: 'flooding at the market' } })
    assert.equal(res.status, 201)
    const record = store.state.field_reports[0]
    assert.equal(record.latitude, null, 'a missing fix became a coordinate')
    assert.equal(record.longitude, null, 'a missing fix became a coordinate')
    assert.equal(record.location_source, 'unknown', 'a missing fix did not say so')
  })

  it('treats an explicit 0/0 as no fix rather than a real point', async () => {
    const { store } = await call({ kind: 'report' }, {
      body: { description: 'no gps lock', location: { latitude: 0, longitude: 0, source: 'gps' } },
    })
    const record = store.state.field_reports[0]
    assert.equal(record.latitude, null, '0/0 was stored as a real location — Null Island')
    assert.equal(record.longitude, null)
  })

  it('keeps a real fix, and marks its source', async () => {
    const { store } = await call({ kind: 'report' }, {
      body: { description: 'clinic reports cases', location: { latitude: 3.12, longitude: 35.6, source: 'gps', accuracy_m: 8 } },
    })
    const record = store.state.field_reports[0]
    // The coordinate is kept but coarsened to an H3 cell (the request policy
    // sets `coarsenGeoToH3Cell: 3`), so the assertion is that it is a real point
    // near the reported one — not that it is untouched. An absent fix, by
    // contrast, is `null`, which is what the tests above pin.
    assert.ok(Number.isFinite(record.latitude), 'a real fix did not survive')
    assert.ok(Math.abs(record.latitude - 3.12) < 1, 'the fix moved to a different place')
    assert.ok(Math.abs(record.longitude - 35.6) < 1)
    assert.equal(record.location_source, 'gps')
  })
})

describe('ARC-01 — the category is a taxonomy value, not the form name', () => {
  it('refuses a category the taxonomy does not know, rather than storing it', async () => {
    // `assertCategory` throws a 400; the handler does not catch it, so the call
    // rejects — which is the refusal, and the store is never written.
    const store = recordingStore()
    await assert.rejects(
      () => call({ kind: 'report' }, { body: { description: 'x', category: 'not-a-real-category' }, store }),
      (err) => err.statusCode === 400,
    )
    assert.equal(store.state.field_reports.length, 0, 'an unknown category reached the store')
  })

  it('stores a known category', async () => {
    // `healthcare` is a taxonomy category; the exact code set is the taxonomy's
    // to own, so the assertion is that a known value round-trips rather than
    // that it is rewritten to something else.
    const { store } = await call({ kind: 'report' }, { body: { description: 'x', category: 'healthcare' } })
    assert.equal(store.state.field_reports.length, 1)
    assert.equal(typeof store.state.field_reports[0].category, 'string')
  })
})

describe('ARC-01 — the reporter is redacted on the inbound', () => {
  it('does not store the reporter name or phone in the clear when names are redacted', async () => {
    const { store } = await call({ kind: 'report' }, {
      body: { description: 'case', anonymous: true, reporter_name: 'Amina Yusuf', reporter_phone: '+254700000000' },
    })
    const inbound = store.state.rapidpro_inbound_messages[0]
    assert.ok(inbound, 'no inbound was written')
    assert.ok(!JSON.stringify(inbound).includes('Amina Yusuf'), 'the reporter name survived into the inbound')
    assert.ok(!JSON.stringify(inbound).includes('+254700000000'), 'the reporter phone survived into the inbound')
  })

  it('answers 405 for a verb it does not serve', async () => {
    const { handled, res } = await call({ kind: 'report' }, { method: 'GET', body: undefined })
    assert.equal(handled, true)
    assert.equal(res.status, 405)
  })
})

describe('DATA-12 — a retried submission is one row, not one row per clock tick', () => {
  /**
   * The defect the register states as "record ids mix the current timestamp into
   * the hash, so re-submitting identical content produces a different id and
   * defeats dedup" was partly stale: the field report itself has been
   * submission-keyed since ENH-39, and a whole-request replay is caught by
   * `Idempotency-Key`. What survived was the *companion* rows — the inbound
   * message and the action log both hashed `new Date().toISOString()`, so one
   * report delivered twice wrote one report, two inbounds and two logs. Probed
   * against a live server before the fix: `field_reports 1, inbound 2,
   * action_logs 2`.
   *
   * The clock is mocked rather than the ids compared across two `await`s that
   * happen to land in the same millisecond: a test that passes because the
   * machine was fast is not testing the key.
   */
  const callAt = async (iso, store, body, kind = 'report') => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) })
    try {
      return await call({ kind }, { store, body })
    } finally {
      mock.timers.reset()
    }
  }

  it('mints the same inbound and action-log ids for a retry, though the clock moved', async () => {
    const body = { submission_id: 'sub-1', description: 'flooding at the market', category: 'healthcare' }
    const first = await callAt('2026-10-18T09:00:00.000Z', recordingStore(), body)
    const second = await callAt('2026-10-18T09:04:30.000Z', recordingStore(), body)

    assert.equal(
      first.store.state.field_reports[0].id,
      second.store.state.field_reports[0].id,
      'the field report id moved with the clock',
    )
    assert.equal(
      first.store.state.rapidpro_inbound_messages[0].id,
      second.store.state.rapidpro_inbound_messages[0].id,
      'the inbound id moved with the clock, so one report acquired a second row',
    )
    assert.equal(
      first.store.state.action_logs[0].id,
      second.store.state.action_logs[0].id,
      'the action-log id moved with the clock, so the operator log showed the write twice',
    )
  })

  it('still mints distinct ids for two genuinely different reports', async () => {
    // The control. A constant id would satisfy the test above and collapse every
    // report in the deployment into one row, which is the opposite failure.
    const first = await callAt('2026-10-18T09:00:00.000Z', recordingStore(), {
      submission_id: 'sub-1', description: 'flooding at the market', category: 'healthcare',
    })
    const second = await callAt('2026-10-18T09:00:00.000Z', recordingStore(), {
      submission_id: 'sub-2', description: 'flooding at the market', category: 'healthcare',
    })
    const ids = [first, second].map((r) => r.store.state.field_reports[0].id)
    assert.notEqual(ids[0], ids[1], 'two submissions got one id')
    assert.notEqual(
      first.store.state.action_logs[0].id,
      second.store.state.action_logs[0].id,
      'two reports got one action-log row',
    )
  })

  it('keys a reply on its content, so a retried reply is one row', async () => {
    const body = { alert_event_id: 'alert-9', message: 'clinic confirms three cases' }
    const first = await callAt('2026-10-18T09:00:00.000Z', recordingStore(), body, 'reply')
    const second = await callAt('2026-10-18T09:07:00.000Z', recordingStore(), body, 'reply')
    const ids = [first, second].map((r) => r.store.state.rapidpro_inbound_messages[0].id)
    assert.equal(ids[0], ids[1], 'a retried reply wrote a second inbound row')
  })
})

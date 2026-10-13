#!/usr/bin/env node
/**
 * R-40 — a request that writes three rows leaves one token across all three.
 *
 * ENH-64 gave the platform a correlation id and put it on every *log line* and
 * every response. It did not put it on a *row*. `currentRequestId()` had exactly
 * one caller — the logger — so the id joined the lines one request produced and
 * nothing else, and the audit's own example stayed unanswerable: one focal-point
 * approval produces a workflow row, an outbox row and an `action_log` row in
 * three non-atomic writes, and an operator holding any one of them could not
 * find the other two.
 *
 * The seam is the store's merge, not the three constructors. Stamping in
 * `actionLog()` and `emit()` would cover two of the three rows and miss the
 * workflow row, and would cover none of the other forty-odd merge call sites —
 * a gate at the sites somebody remembered. The store is the one funnel every
 * write passes through, and the question it asks is ambient: `currentRequestId()`
 * is null outside a request, so a driver tick, a migration and a script stamp
 * nothing.
 *
 * Asserted here rather than through the HTTP surface because the property is
 * about the *rows*, and a server test that reads the response body cannot see
 * what landed in the store.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { emit } from '../src/outbox.js'
import { runWithRequestId } from '../src/observability.js'
import { handleOperationalRoute, matchOperationalRoute } from '../src/routes/operational.js'
import { JsonStore } from '../src/store.js'
import { runWithRequestContext } from '../src/utils.js'

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-corr-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.json = () => JSON.parse(res.chunks.join(''))
  return res
}

const jsonResponse = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Drive one operational POST the way the dispatcher does, inside a request id. */
async function post(store, pathname, body, requestId) {
  const route = matchOperationalRoute(pathname)
  assert.ok(route, `no operational route matched ${pathname}`)
  const data = await store.read()
  const res = fakeResponse()
  const req = {
    method: 'POST',
    __auth: { subject: 'tester', partner_org: null },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
  const run = () => runWithRequestContext(req.__auth, () => handleOperationalRoute(route, {
    data, res, req, store, url: new URL(`http://127.0.0.1${pathname}`), jsonResponse,
  }))
  await (requestId ? runWithRequestId(requestId, run) : run())
  return res
}

describe('R-40 — the request that wrote a row is recorded on the row', () => {
  it('stamps every row one request writes, so the rows of one action share a token', async () => {
    await withStore(async (store) => {
      const res = await post(store, '/api/v1/incidents', { title: 'Flood at the crossing' }, 'corr-approval-1')
      assert.equal(res.status, 201, res.chunks.join(''))

      const data = await store.read()
      const incident = data.incidents.find((row) => row.title === 'Flood at the crossing')
      assert.ok(incident, 'the incident was not written')
      // The row and its audit entry are one action in two collections. They are
      // written by one `merge`, and the whole point of the token is that the
      // pair can be rejoined from either side.
      assert.equal(incident._request_id, 'corr-approval-1',
        'the incident row does not carry the request that wrote it')
      const log = data.action_logs.find((row) => row.record_id === incident.id)
      assert.ok(log, 'no action_log row was written for the incident')
      assert.equal(log._request_id, 'corr-approval-1',
        'the action_log row and its record do not share the request token, so one cannot be traced to the other')
    })
  })

  it('stamps an outbox row written during a request — the third row of the audit’s example', async () => {
    await withStore(async (store) => {
      // `emit` is the outbox's own entry point, reached from a route that is
      // already inside a request. It must not need to be told the id.
      await runWithRequestId('corr-approval-2', () => emit(store, 'incident.created', { incident_id: 'i-1' }))
      const data = await store.read()
      const row = data.events_outbox[0]
      assert.ok(row, 'the outbox row was not written')
      assert.equal(row._request_id, 'corr-approval-2',
        'the outbox row does not carry the request that emitted it')
    })
  })

  it('stamps nothing outside a request, rather than a null the reader must interpret', async () => {
    await withStore(async (store) => {
      // A driver tick, a migration and a one-off script all write through the
      // same store and none of them belongs to a request. `_request_id: null`
      // would say "this row belongs to a request we did not record", which is a
      // different and false claim — the same reason the logger omits the field
      // rather than writing it as null.
      await post(store, '/api/v1/incidents', { title: 'No request here' }, null)
      const data = await store.read()
      const incident = data.incidents.find((row) => row.title === 'No request here')
      assert.ok(incident, 'the incident was not written')
      assert.ok(!('_request_id' in incident),
        `a row written outside a request carries _request_id=${JSON.stringify(incident._request_id)}`)
    })
  })

  it('does not disturb the audit chain — the stamp is not a chained field', async () => {
    await withStore(async (store) => {
      await post(store, '/api/v1/incidents', { title: 'Chained' }, 'corr-chain-1')
      const data = await store.read()
      const log = data.action_logs[0]
      assert.ok(log, 'no action_log row was written')
      // `CHAINED_FIELDS` is an allowlist, so a new field on the row cannot move
      // the digest. Asserted rather than assumed: a stamp that entered the
      // preimage would rewrite the hash of every entry it touched and invalidate
      // every chain written before this change.
      const { computeEntryHash } = await import('../src/audit-chain.js')
      const { GENESIS_HASH } = await import('../public/shared/audit-chain-core.js')
      const before = { ...log }
      delete before._request_id
      assert.equal(
        computeEntryHash(log, GENESIS_HASH),
        computeEntryHash(before, GENESIS_HASH),
        'the request stamp changed the audit-chain digest, so existing chains no longer verify',
      )
    })
  })
})

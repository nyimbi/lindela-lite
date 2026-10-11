import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleProvenanceRoute, matchProvenanceRoute } from '../src/routes/provenance.js'

/**
 * ARC-01 — the provenance family, extracted.
 *
 * These four routes answer a question about records rather than serving
 * records, and that is the whole reason they are one family and the reason they
 * need a test of their own: a handler that answers a question has no natural
 * method check, so a `DELETE /api/v1/watermarks` returning 200 looks exactly
 * like a `GET` returning 200. VER-14 found that shape four times in another
 * family; the sweep after it found it again here. The property below is that
 * the matcher refuses every verb a route does not declare, for all four, so a
 * new route in this family cannot arrive verb-agnostic.
 *
 * `history` is the deliberate exception and it is asserted as one: a POST is a
 * caller who believes they can write the history, so it answers 405 with a
 * code rather than a 404 that reads as "wrong address".
 */

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.headers = null
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

const call = (route, { data = {}, search = '', method = 'GET' } = {}) => {
  const res = fakeResponse()
  const req = { method, __auth: { subject: 'tester', partner_org: null } }
  return handleProvenanceRoute(route, {
    data, res, req, url: new URL(`http://127.0.0.1/x${search}`), jsonResponse,
  }).then((handled) => ({ handled, res }))
}

describe('ARC-01 — matchProvenanceRoute refuses the verbs a route does not declare', () => {
  const READS = [
    '/api/v1/explain/r1',
    '/api/v1/audit/verify',
    '/api/v1/audit/head',
    '/api/v1/watermarks',
  ]

  it('matches every one of them on GET', () => {
    for (const pathname of READS) {
      assert.notEqual(matchProvenanceRoute(pathname, 'GET'), null, `${pathname} did not match on GET`)
    }
    assert.deepEqual(matchProvenanceRoute('/api/v1/explain/r1', 'GET'), { kind: 'explain', id: 'r1' })
    assert.deepEqual(matchProvenanceRoute('/api/v1/audit/verify', 'GET'), { kind: 'audit', action: 'verify' })
    assert.deepEqual(matchProvenanceRoute('/api/v1/audit/head', 'GET'), { kind: 'audit', action: 'head' })
    assert.deepEqual(matchProvenanceRoute('/api/v1/watermarks', 'GET'), { kind: 'watermarks' })
  })

  it('refuses every write verb on the routes that answer a question', () => {
    // The VER-14 class. `DELETE /api/v1/watermarks` returned the whole high-water
    // mark table before the sweep; this asserts the refusal is in the matcher for
    // the family, not in one handler that happened to remember.
    for (const pathname of READS) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal(matchProvenanceRoute(pathname, method), null, `${method} ${pathname} matched a read-only route`)
      }
    }
  })

  it('matches history on any verb so the handler can refuse it in words', () => {
    // Not a route that does not exist — a caller who believes they can write the
    // history. It reaches the handler and answers 405 with `read_only`, which a
    // 404 would not say.
    assert.deepEqual(matchProvenanceRoute('/api/v1/history/hazard_events', 'POST'), {
      kind: 'history', collection: 'hazard_events', record: false,
    })
    assert.deepEqual(matchProvenanceRoute('/api/v1/history/hazard_events/record', 'DELETE'), {
      kind: 'history', collection: 'hazard_events', record: true,
    })
  })

  it('does not match a near miss', () => {
    for (const pathname of [
      '/api/v1/explain', '/api/v1/explain/a/b', '/api/v1/audit', '/api/v1/audit/verification',
      '/api/v1/watermark', '/api/v1/history', '/api/v1/history/a/b/c', '/api/v1/histories/x', '', '/',
    ]) {
      assert.equal(matchProvenanceRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
  })

  it('decodes an id that was percent-encoded into the path', () => {
    assert.equal(matchProvenanceRoute('/api/v1/explain/a%20b', 'GET').id, 'a b')
    assert.equal(matchProvenanceRoute('/api/v1/history/a%2Fb', 'GET').collection, 'a/b')
  })
})

describe('ARC-01 — explain resolves a record to what the store knows about it', () => {
  const data = {
    risk_scores: [
      { id: 'r1', score: 0.4, _source_run_id: 'run1', limits: { note: 'district-level' } },
      { id: 'r2', score: 0.9 },
    ],
    source_runs: [{ id: 'run1', source: 'open-meteo' }],
    data_lineage: [{ source_run_id: 'run1', collection: 'risk_scores' }],
  }

  it('answers the record with its source run and lineage', async () => {
    const { res } = await call({ kind: 'explain', id: 'r1' }, { data })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.record.id, 'r1')
    assert.equal(body.provenance.source_run.source, 'open-meteo')
    assert.equal(body.provenance.lineage.length, 1)
    assert.equal(body.provenance.known, true)
    assert.equal(body.limits.note, 'district-level')
  })

  it('answers a record with no source run, and says the origin is unknown', async () => {
    // Absence of provenance is a fact about the record, not a reason to withhold
    // it. `known: false` with a note, rather than a 404 or a bare null that reads
    // as "we did not look".
    const { res } = await call({ kind: 'explain', id: 'r2' }, { data })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.provenance.known, false)
    assert.match(body.provenance.note, /no source run/)
  })

  it('answers 404 for a record that is not there', async () => {
    const { res } = await call({ kind: 'explain', id: 'nope' }, { data })
    assert.equal(res.status, 404)
  })

  it('reads the kind from the query, defaulting to risk_scores', async () => {
    const { res } = await call({ kind: 'explain', id: 'a1' }, {
      data: { service_assets: [{ id: 'a1', name: 'Borehole' }] }, search: '?kind=service_assets',
    })
    assert.equal(res.json().kind, 'service_assets')
  })
})

describe('ARC-01 — audit verifies the chain, and says when it is unanchored', () => {
  it('answers the head and the proof for an empty chain', async () => {
    const { res } = await call({ kind: 'audit', action: 'verify' }, { data: { action_logs: [] } })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.entries, 0)
    assert.equal(body.head, null)
    assert.equal(body.unanchored, true)
    assert.ok(body.proof, 'the human-readable proof did not travel with the machine one')
  })

  it('carries `unanchored` when no published head was supplied', async () => {
    // A chain nobody anchored is internally consistent and still not proof. The
    // field is present rather than left for a reader to infer from a missing one.
    const { res } = await call({ kind: 'audit', action: 'head' }, { data: { action_logs: [] } })
    assert.equal(res.json().unanchored, true)
  })

  it('reports `verified` as a boolean on a real chain — VER-16', async () => {
    // The field the route exists to answer was `proof.ok`, which is not what
    // `verifyChain` returns, so `verified` was undefined and JSON dropped the
    // key. A caller's truthiness check read it as false — "the chain is broken"
    // for a chain that recomputes cleanly. Nothing asserted it, so it passed for
    // as long as the route existed.
    const { chainEntries } = await import('../src/audit-chain.js')
    const { entries } = chainEntries([{
      id: 'log_1', collection: 'hazard_events', record_id: 'hazard_1', action: 'create',
      actor: 'user:alice', subject: null, summary: 's', created_at: '2026-01-01T00:00:00.000Z', metadata: {},
    }])
    const { res } = await call({ kind: 'audit', action: 'verify' }, {
      data: { action_logs: entries },
      search: `?head=${entries[0].entry_hash}`,
    })
    const body = res.json()
    assert.equal(typeof body.verified, 'boolean', 'verified must be present and boolean, not undefined')
    assert.equal(body.verified, true)
    assert.equal(body.unanchored, false)
    // The browser re-walks these; without them the client verifier has nothing.
    assert.equal(body.entries_data.length, 1)
    assert.equal(body.entries_data[0].entry_hash, entries[0].entry_hash)
  })

  it('files the unanchored advisory outside the fatal defects — VER-16', async () => {
    // The advisory sat in `defects` beside real breaks, so a reader filtering by
    // presence rather than severity read "cannot rule out a rewrite" as a break.
    const { res } = await call({ kind: 'audit', action: 'verify' }, { data: { action_logs: [] } })
    const body = res.json()
    assert.deepEqual(body.defects, [], 'an unanchored chain has no fatal defect')
    assert.ok(body.advisories.some((d) => d.type === 'unanchored'))
  })
})

describe('ARC-01 — history answers a series, a record, and refuses a write', () => {
  const data = {
    hazard_events: [
      { id: 'h1', district: 'Turkana', observed_at: '2024-03-01T00:00:00Z', event_type: 'flood' },
      { id: 'h2', district: 'Turkana', observed_at: '2024-03-05T00:00:00Z', event_type: 'flood' },
    ],
  }

  it('answers a series for a collection', async () => {
    const { res } = await call({ kind: 'history', collection: 'hazard_events', record: false }, { data })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.data.collection, 'hazard_events')
    assert.equal(body.data.projectable, true, 'a bitemporal collection was reported as having no history')
    assert.ok(Array.isArray(body.data.points), 'the series carried no points array')
    assert.ok(Array.isArray(body.projectable_collections), 'the projectable list did not travel with the series')
  })

  it('says why a collection that is not bitemporal has no history', async () => {
    // An event collection has no observation history to project, and an empty
    // `points` alone would read as "nothing changed" rather than "this is not a
    // state the platform ever held and revised".
    const { res } = await call({ kind: 'history', collection: 'incidents', record: false }, { data })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.data.projectable, false)
    assert.match(body.data.reason, /not a bitemporal collection/)
  })

  it('requires an id for the per-record form rather than answering the series', async () => {
    const { res } = await call({ kind: 'history', collection: 'hazard_events', record: true }, { data })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /id is required/)
  })

  it('refuses a write with 405 and a code, not a 404', async () => {
    // The route exists; the verb does not. A 404 would read as "wrong address"
    // and the caller would keep looking for the right one.
    const { res } = await call({ kind: 'history', collection: 'hazard_events', record: false }, { data, method: 'POST' })
    assert.equal(res.status, 405)
    assert.equal(res.json().code, 'read_only')
  })
})

describe('ARC-01 — watermarks report the state, not the raw rows', () => {
  it('describes an absent watermark as unknown rather than current', async () => {
    const { res } = await call({ kind: 'watermarks' }, { data: {} })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.ok(body.data, 'no state was described')
  })

  it('describes a source the store has a watermark for', async () => {
    const { res } = await call({ kind: 'watermarks' }, {
      data: { watermark_state: [{ source: 'open-meteo-archive', state: { last_success: '2026-01-01T00:00:00Z' } }] },
    })
    assert.equal(res.status, 200)
    assert.ok(res.json().data)
  })
})

describe('ARC-01 — the module answers, or declines, without inventing a response', () => {
  it('returns false for a kind it does not own', async () => {
    const { handled, res } = await call({ kind: 'not-a-provenance-route' }, {})
    assert.equal(handled, false)
    assert.equal(res.status, null, 'an unowned kind wrote a response')
  })
})

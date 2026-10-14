import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { handleAnnotationRoute, matchAnnotationRoute } from '../src/routes/annotations.js'
import { JsonStore } from '../src/store.js'
import { emptyStore } from '../src/schema.js'

/**
 * ENH-74 — the annotation routes, asserted where they live.
 *
 * `src/annotations.js` was complete, tested, and reached by nothing; this file
 * covers the layer that made it reachable, and the four claims that layer makes:
 *
 *   - **the identity is the token's, never the body's.** `buildAnnotation` takes
 *     an author and refuses without one, and a client that could name itself
 *     could attribute its words to somebody else. The test sends both and
 *     asserts the token won.
 *   - **one merge per write.** R-22: an outbox event that announces a record
 *     that was never written is worse than a lost event, because subscribers act
 *     on it. An edit is two records in one merge, and the test asserts both
 *     landed rather than only the one the response names.
 *   - **the thread is computed over the matched set, not the page.** The failure
 *     `/disease-observations` had already taken once: a summary over
 *     `filterRecords`' page reads as a count of the conversation and is a count
 *     of the first fifty.
 *   - **the refusals are the module's own.** A missing parent is a 404 and a
 *     second retraction a 409 because `src/annotations.js` says so; a second copy
 *     of the rule here would be a copy that drifts from the one its tests
 *     exercise.
 */

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-annotations-route-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store, dir)
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
  res.json = () => JSON.parse(Buffer.concat(res.chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8'))
  return res
}

const jsonResponse = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const makeReq = (method, body, auth = { subject: 'token_abc', partner_org: null }) => ({
  method,
  headers: {},
  __auth: auth,
  async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
})

const call = async (route, { data = {}, store = {}, method = 'GET', body, search = '', auth } = {}) => {
  const res = fakeResponse()
  const handled = await handleAnnotationRoute(route, {
    store, data, res, jsonResponse,
    req: makeReq(method, body, auth),
    url: new URL(`http://127.0.0.1/x${search}`),
  })
  return { handled, res, body: res.json() }
}

/** A stored annotation, shaped the way `buildAnnotation` shapes one. */
const stored = (over = {}) => ({
  id: 'ann-1',
  record_id: 'incident-1',
  record_collection: 'incidents',
  parent_id: null,
  body: 'Access road washed out at the bridge.',
  author: 'token_abc',
  created_at: '2026-10-12T08:00:00.000Z',
  valid_from: '2026-10-12T08:00:00.000Z',
  valid_to: null,
  supersedes: null,
  superseded_by: null,
  retracted_at: null,
  retracted_by: null,
  client_annotation_id: null,
  metadata: {},
  ...over,
})

describe('ENH-74 — matchAnnotationRoute is method-aware and path-exact', () => {
  it('matches every route the family serves, by verb', () => {
    const expected = [
      ['/api/v1/annotations', 'GET', { kind: 'list' }],
      ['/api/v1/annotations', 'POST', { kind: 'create' }],
      ['/api/v1/annotations/ann-1/versions', 'GET', { kind: 'versions', id: 'ann-1' }],
      ['/api/v1/annotations/record/incident-1', 'GET', { kind: 'record-thread', record_id: 'incident-1' }],
      ['/api/v1/annotations/ann-1', 'PATCH', { kind: 'edit', id: 'ann-1' }],
      ['/api/v1/annotations/ann-1', 'DELETE', { kind: 'retract', id: 'ann-1' }],
    ]
    for (const [pathname, method, kind] of expected) {
      assert.deepEqual(matchAnnotationRoute(pathname, method), kind, `${method} ${pathname}`)
    }
  })

  it('routes a shared path by verb, not by path alone', () => {
    // `/api/v1/annotations` serves a GET and a POST that are different handlers,
    // and `/api/v1/annotations/{id}` a PATCH and a DELETE. A matcher that
    // ignored the verb would answer a read for a write, which is the
    // silent-ignore class in its worst form: the caller believes the annotation
    // was stored.
    const list = matchAnnotationRoute('/api/v1/annotations', 'GET')
    const create = matchAnnotationRoute('/api/v1/annotations', 'POST')
    assert.notEqual(list.kind, create.kind)
    const edit = matchAnnotationRoute('/api/v1/annotations/ann-1', 'PATCH')
    const retract = matchAnnotationRoute('/api/v1/annotations/ann-1', 'DELETE')
    assert.notEqual(edit.kind, retract.kind)
  })

  it('does not match a near miss or an unsupported verb', () => {
    for (const pathname of [
      '/api/v1/annotations/',
      '/api/v1/annotation',
      '/api/v1/annotations/ann-1/version',
      '/api/v1/annotations/record',
      '/api/v1/annotations/record/incident-1/extra',
      '',
    ]) {
      assert.equal(matchAnnotationRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
    assert.equal(matchAnnotationRoute('/api/v1/annotations', 'PUT'), null, 'an undeclared verb was matched')
    assert.equal(matchAnnotationRoute('/api/v1/annotations/ann-1', 'GET'), null,
      'the by-id path serves PATCH and DELETE; a GET is the collection route or nothing')
  })
})

describe('ENH-74 — the identity is the token\'s, never the body\'s', () => {
  it('attributes the annotation to the token subject when the body names another', async () => {
    await withStore(async (store) => {
      const { res, body } = await call({ kind: 'create' }, {
        store,
        method: 'POST',
        body: { record_id: 'incident-1', body: 'Clinic stock figure looks wrong.', author: 'somebody-else' },
      })
      assert.equal(res.status, 201)
      assert.equal(body.data.author, 'token_abc',
        'the body named its own author and the platform believed it — that is the unattributed claim provenance exists to prevent')
      assert.equal(body.data.provenance.connector_id, 'token_abc')
    })
  })

  it('falls back to the body only when the request carries no token subject', async () => {
    // The fallback is deliberate: an unauthenticated deployment that configures
    // no API key still has to be able to record who typed something. It is the
    // *order* that matters, and this is the other half of it.
    await withStore(async (store) => {
      const { res, body } = await call({ kind: 'create' }, {
        store,
        method: 'POST',
        auth: { subject: null, partner_org: null },
        body: { record_id: 'incident-1', body: 'Borehole at Kilima is dry.', actor: 'chw_nairobi' },
      })
      assert.equal(res.status, 201)
      assert.equal(body.data.author, 'chw_nairobi')
    })
  })

  it('refuses an annotation with no author at all rather than inventing one', async () => {
    await withStore(async (store) => {
      const { res, body } = await call({ kind: 'create' }, {
        store,
        method: 'POST',
        auth: { subject: null, partner_org: null },
        body: { record_id: 'incident-1', body: 'No name on this one.' },
      })
      assert.equal(res.status, 400, 'an unattributed annotation was stored')
      assert.equal(body.success, false)
      assert.match(body.error, /author/)
    })
  })
})

describe('ENH-74 — one merge per write, so the event cannot outlive the record', () => {
  it('stores the annotation and the outbox event in one commit', async () => {
    await withStore(async (store) => {
      const { res, body } = await call({ kind: 'create' }, {
        store,
        method: 'POST',
        body: { record_id: 'incident-1', body: 'Bridge at Lodwar is passable again.' },
      })
      assert.equal(res.status, 201)
      const after = await store.read()
      assert.equal(after.annotations.length, 1, 'the record did not land')
      assert.ok(after.events_outbox.some((row) => row.id === body.outbox_event),
        'the response named an outbox event the store does not hold')
      assert.ok(after.action_logs.some((row) => row.collection === 'annotations'),
        'the write carries an action log, which is the audit trail the module exists for')
    })
  })

  it('lands both halves of an edit in one merge, not just the version it names', async () => {
    // An edit is two records: the closed version and the opened one. A reader
    // that saw the new text without the old row closed would read the chain with
    // a hole in it — two live versions of one annotation.
    await withStore(async (store) => {
      await store.merge({ annotations: [stored()] })
      const data = await store.read()
      const { res, body } = await call({ kind: 'edit', id: 'ann-1' }, {
        store, data,
        method: 'PATCH',
        body: { body: 'Access road washed out at the second bridge, not the first.' },
      })
      assert.equal(res.status, 200)
      const after = await store.read()
      assert.equal(after.annotations.length, 2, 'the closed version did not land with the opened one')
      const closed = after.annotations.find((a) => a.id === 'ann-1')
      assert.ok(closed.valid_to, 'the superseded version is still open, so the thread has two live rows')
      assert.equal(closed.superseded_by, body.data.id)
      assert.equal(body.superseded.id, 'ann-1')
      // The prior text survives verbatim: "what did this say last week" is the
      // whole reason an edit is a version rather than an overwrite.
      assert.equal(closed.body, 'Access road washed out at the bridge.')
    })
  })
})

describe('ENH-74 — the thread is computed over the matched set, not the page', () => {
  it('reports a summary over every annotation, not over the page it returned', async () => {
    // The failure `/disease-observations` took: a roll-up over `filterRecords`'
    // page reads as a count of the conversation and is a count of the first
    // fifty. Six annotations and a `limit=2` is the smallest case that shows it.
    const all = Array.from({ length: 6 }, (_, i) => stored({
      id: `ann-${i}`,
      body: `note ${i}`,
      created_at: `2026-10-12T08:0${i}:00.000Z`,
    }))
    const { res, body } = await call({ kind: 'list' }, { data: { annotations: all }, search: '?limit=2' })
    assert.equal(res.status, 200)
    assert.equal(body.data.length, 2, 'the page was not limited')
    assert.equal(body.returned, 2)
    assert.equal(body.total, 6)
    assert.equal(body.summary.live, 6, 'the summary described the page, not the matched set')
    assert.equal(body.thread.length, 6, 'the thread walk described the page, not the matched set')
  })

  it('scopes the read to one record with ?record_id=', async () => {
    const data = {
      annotations: [
        stored({ id: 'a1', record_id: 'incident-1' }),
        stored({ id: 'a2', record_id: 'incident-2' }),
        stored({ id: 'a3', record_id: 'incident-1' }),
      ],
    }
    const { body } = await call({ kind: 'list' }, { data, search: '?record_id=incident-1' })
    assert.deepEqual(body.data.map((a) => a.id).sort(), ['a1', 'a3'])
    assert.equal(body.total, 2)
    assert.equal(body.record_id, 'incident-1')
  })

  it('returns a record\'s whole thread with no limit applied', async () => {
    // `check-route-envelopes` names this route in `ARRAY_IS_COMPLETE` with the
    // reason "a record's whole conversation, with no limit applied". That reason
    // is asserted here rather than trusted: more rows than the list route's
    // default page, and every one comes back.
    const all = Array.from({ length: 520 }, (_, i) => stored({
      id: `ann-${String(i).padStart(4, '0')}`,
      body: `note ${i}`,
      created_at: `2026-10-12T08:00:00.${String(i).padStart(3, '0')}Z`,
    }))
    const { res, body } = await call({ kind: 'record-thread', record_id: 'incident-1' }, { data: { annotations: all } })
    assert.equal(res.status, 200)
    assert.equal(body.data.length, 520, 'the thread was truncated, so the read is not the whole conversation')
    assert.equal(body.summary.live, 520)
    assert.equal(body.thread.length, 520)
  })

  it('nests replies under their parent rather than returning a flat feed', async () => {
    const data = {
      annotations: [
        stored({ id: 'a1', created_at: '2026-10-12T08:00:00.000Z' }),
        stored({ id: 'a2', parent_id: 'a1', created_at: '2026-10-12T08:01:00.000Z' }),
        stored({ id: 'a3', parent_id: 'a2', created_at: '2026-10-12T08:02:00.000Z' }),
      ],
    }
    const { body } = await call({ kind: 'record-thread', record_id: 'incident-1' }, { data })
    assert.equal(body.thread.length, 1, 'the reply was not nested under its parent')
    assert.equal(body.thread[0].replies[0].replies[0].id, 'a3')
    assert.equal(body.summary.roots, 1)
    assert.equal(body.summary.replies, 2)
  })

  it('returns the version chain oldest first', async () => {
    const data = {
      annotations: [
        stored({ id: 'v1', superseded_by: 'v2' }),
        stored({ id: 'v2', supersedes: 'v1', body: 'corrected', superseded_by: 'v3' }),
        stored({ id: 'v3', supersedes: 'v2', body: 'corrected again' }),
      ],
    }
    const { body } = await call({ kind: 'versions', id: 'v3' }, { data })
    assert.deepEqual(body.data.map((a) => a.id), ['v1', 'v2', 'v3'])
    assert.equal(body.count, 3)
  })
})

describe('ENH-74 — the refusals are the module\'s own', () => {
  it('answers 404 for a parent that does not exist rather than inventing a root', async () => {
    await withStore(async (store) => {
      const { res, body } = await call({ kind: 'create' }, {
        store,
        method: 'POST',
        body: { record_id: 'incident-1', parent_id: 'ghost', body: 'replying to nothing' },
      })
      assert.equal(res.status, 404, 'an orphan reply was stored as a root')
      assert.equal(body.code, 'not_found')
      const after = await store.read()
      assert.equal(after.annotations.length, 0)
    })
  })

  it('answers 404 for a version chain that does not exist', async () => {
    const { res } = await call({ kind: 'versions', id: 'ghost' }, { data: { annotations: [] } })
    assert.equal(res.status, 404)
  })

  it('answers 409 for a second retraction, not a silent success', async () => {
    // A retracted annotation has left the live set; retracting it again is not a
    // conflict to retry but a caller that must be told to stop.
    const data = { annotations: [stored({ retracted_at: '2026-10-12T09:00:00.000Z', retracted_by: 'token_abc' })] }
    const { res, body } = await call({ kind: 'retract', id: 'ann-1' }, { data, method: 'DELETE' })
    assert.equal(res.status, 409)
    assert.equal(body.code, 'record_deleted')
  })

  it('keeps the body when an annotation is retracted', async () => {
    // ADR-007's soft delete: the row stays so the thread's structure and the
    // audit trail stay resolvable, and a reply does not point at a row that is
    // gone.
    await withStore(async (store) => {
      await store.merge({ annotations: [stored()] })
      const data = await store.read()
      const { res, body } = await call({ kind: 'retract', id: 'ann-1' }, { store, data, method: 'DELETE' })
      assert.equal(res.status, 200)
      assert.equal(body.data.retracted_by, 'token_abc')
      const after = await store.read()
      assert.equal(after.annotations.length, 1, 'the row was deleted rather than stamped')
      assert.equal(after.annotations[0].body, 'Access road washed out at the bridge.')
    })
  })

  it('refuses an edit that would make an annotation its own ancestor', async () => {
    // The one that bites: `parent_id` is a plain field, nothing in a store stops
    // it being set to a value that makes the tree a graph with no root, and at
    // that point every read of the thread recurses forever.
    const data = {
      annotations: [
        stored({ id: 'a1' }),
        stored({ id: 'a2', parent_id: 'a1', created_at: '2026-10-12T08:01:00.000Z' }),
      ],
    }
    const { res, body } = await call({ kind: 'edit', id: 'a1' }, {
      data, method: 'PATCH', body: { body: 'now a reply to my own reply', parent_id: 'a2' },
    })
    assert.equal(res.status, 400)
    assert.equal(body.success, false)
    assert.match(body.error, /ancestor|cycle|descendant/i)
  })
})

describe('ENH-74 — the collection the module asked for is declared, both halves', () => {
  it('is a key in the empty store, so a fresh file reads it rather than throwing', async () => {
    // `read()` spreads `emptyStore()`'s default under a parsed file. A SCHEMA
    // entry with no `annotations: []` means the first `store.annotations` access
    // on a fresh file throws — which is the direction that breaks a deployment,
    // not the one that looks wrong in a diff.
    const empty = emptyStore()
    assert.deepEqual(empty.annotations, [], 'emptyStore() has no annotations key')
  })

  it('survives a write and a read on a store that never held one', async () => {
    await withStore(async (store) => {
      const { res } = await call({ kind: 'create' }, {
        store, method: 'POST', body: { record_id: 'incident-1', body: 'first annotation on a fresh store' },
      })
      assert.equal(res.status, 201)
      const after = await store.read()
      assert.equal(after.annotations.length, 1)
    })
  })
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { LICENCES, MAX_SNAPSHOT_RECORDS, buildSnapshot, licenceTerms, mintHandle, validateSnapshotRequest } from '../src/snapshots.js'
import { handleSnapshotRoute, matchSnapshotRoute } from '../src/routes/snapshots.js'
import { contentHash, vintageOf } from '../src/vintage.js'

/**
 * ENH-34 — a citable handle over a frozen read.
 *
 * CAP-04 gave an export a vintage and stopped there on purpose: the store keeps
 * no copy, so `?vintage=` is refused and a report naming a vintage names
 * something nobody can fetch. This is the other half — the copy — and the
 * properties below are the ones that make the handle *citable* rather than just
 * stored:
 *
 *   - the licence travels with its own obligation. `CC-BY-4.0` tells a consumer
 *     to attribute but not to whom, and an export whose attribution is implied
 *     is one a partner cannot comply with. A licence requiring attribution and
 *     given none is refused, not stored with a null.
 *   - a snapshot that cannot be taken says so. Truncating one is worse than
 *     refusing it: a truncated snapshot carries a handle, and a handle reads as
 *     the record of truth.
 *   - the handle is not the vintage. The vintage is a hash of content, so two
 *     snapshots of unchanged data share one — minting on it would collide and
 *     return the older licence stamp for a newer read.
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

const store = () => {
  const merges = []
  return { merges, merge: async (patch) => { merges.push(patch) } }
}

const call = (route, { data = {}, search = '', method = 'GET', body = null } = {}) => {
  const res = fakeResponse()
  const s = store()
  const req = {
    method,
    __auth: { subject: 'tester', partner_org: null },
    async *[Symbol.asyncIterator]() { if (body !== null) yield Buffer.from(JSON.stringify(body)) },
  }
  return handleSnapshotRoute(route, {
    data, res, req, store: s,
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res, store: s }))
}

const events = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, event_type: 'flood', ...extra }))

describe('ENH-34 — matchSnapshotRoute takes the method, per route', () => {
  it('matches the collection on GET and POST and one handle on GET', () => {
    assert.deepEqual(matchSnapshotRoute('/api/v1/dataset-snapshots', 'GET'), { kind: 'list' })
    assert.deepEqual(matchSnapshotRoute('/api/v1/dataset-snapshots', 'POST'), { kind: 'create' })
    assert.deepEqual(matchSnapshotRoute('/api/v1/dataset-snapshots/lds_abc_def', 'GET'), { kind: 'retrieve', handle: 'lds_abc_def' })
  })

  it('refuses the verbs a route does not declare, in both directions', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      assert.equal(matchSnapshotRoute('/api/v1/dataset-snapshots', method), null, `${method} matched the snapshot collection`)
      assert.equal(matchSnapshotRoute('/api/v1/dataset-snapshots/lds_a_b', method), null, `${method} matched a handle read`)
    }
    assert.equal(matchSnapshotRoute('/api/v1/dataset-snapshots/lds_a_b', 'POST'), null, 'a handle is read, never written')
  })

  it('does not match a near miss', () => {
    for (const pathname of [
      '/api/v1/dataset-snapshot', '/api/v1/dataset-snapshots/', '/api/v1/dataset-snapshots/a/b',
      '/api/v1/datasets', '', '/',
    ]) {
      assert.equal(matchSnapshotRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ENH-34 — the licence travels with its own obligation', () => {
  it('names what each licence obliges, not only its SPDX string', () => {
    for (const [code, terms] of Object.entries(LICENCES)) {
      assert.equal(licenceTerms(code).code, code)
      assert.equal(typeof terms.note, 'string')
      assert.ok(terms.note.length > 0, `${code} carries no obligation in words`)
    }
    assert.equal(licenceTerms('CC-BY-4.0').attribution_required, true)
    assert.equal(licenceTerms('CC0-1.0').attribution_required, false)
    assert.equal(licenceTerms('CC-BY-SA-4.0').share_alike, true)
  })

  it('refuses a licence it does not know rather than storing an uninterpretable string', () => {
    const problem = validateSnapshotRequest({ licence: 'WTFPL', records: [] })
    assert.match(problem, /unknown licence/)
  })

  it('refuses a licence that requires attribution given none', () => {
    // The property. A consumer cannot comply with an obligation it cannot see,
    // so a CC-BY snapshot with a null attribution is a licence tag that lies
    // about what a partner may do with the data.
    const problem = validateSnapshotRequest({ licence: 'CC-BY-4.0', records: [] })
    assert.match(problem, /requires attribution/)
    assert.equal(validateSnapshotRequest({ licence: 'CC-BY-4.0', attribution: 'IPC TWG, 2026', records: [] }), null)
  })

  it('does not demand attribution for a licence that does not require it', () => {
    assert.equal(validateSnapshotRequest({ licence: 'CC0-1.0', records: [] }), null)
    assert.equal(validateSnapshotRequest({ licence: 'internal-only', records: [] }), null)
  })

  it('refuses a snapshot past the record limit rather than storing a truncated one', () => {
    // Truncation is the failure this whole repository keeps removing: a
    // truncated snapshot carries a handle, and a handle reads as the record.
    const problem = validateSnapshotRequest({ licence: 'CC0-1.0', records: new Array(MAX_SNAPSHOT_RECORDS + 1).fill({}) })
    assert.match(problem, /narrow it with a query filter/)
    assert.equal(validateSnapshotRequest({ licence: 'CC0-1.0', records: new Array(MAX_SNAPSHOT_RECORDS).fill({}) }), null)
  })

  it('refuses a snapshot with no licence at all', () => {
    assert.match(validateSnapshotRequest({ records: [] }), /licence is required/)
  })
})

describe('ENH-34 — the handle is not the vintage', () => {
  it('mints a handle per artifact, not per content hash', () => {
    // The vintage is a hash of content: two snapshots of unchanged data share
    // one. Minting the handle from it would make the second snapshot collide
    // with the first and silently return the older licence stamp.
    const a = mintHandle('abc123def456789')
    const b = mintHandle('abc123def456789')
    assert.notEqual(a, b, 'two snapshots of the same data were given the same handle')
    assert.match(a, /^lds_[0-9a-f]{12}_[0-9a-f]{12}$/)
  })

  it('carries the vintage so a consumer can still compare datasets', () => {
    const vintage = vintageOf(events(3))
    const snapshot = buildSnapshot(events(3), { vintage: vintage.vintage, handle: mintHandle(vintage.vintage), licence: 'CC0-1.0' })
    assert.equal(snapshot.vintage, vintage.vintage)
    assert.equal(snapshot.record_count, 3)
  })

  it('keeps the vintage stable across two reads of the same data', () => {
    // The reason a content hash is the right identifier, restated at this
    // surface: `generated_at` must not enter the hash or two reads of identical
    // data disagree and the vintage is worthless as a comparison.
    assert.equal(vintageOf(events(3)).vintage, vintageOf(events(3)).vintage)
    assert.notEqual(vintageOf(events(3)).vintage, vintageOf(events(4)).vintage)
  })
})

describe('ENH-34 — the routes', () => {
  const snapshotOf = (records, extra = {}) => ({
    id: 'lds_a_b', handle: 'lds_a_b', vintage: contentHash('x'), label: 'Flood risk',
    licence: 'CC-BY-4.0', licence_terms: licenceTerms('CC-BY-4.0'), attribution: 'IPC TWG',
    record_count: records.length, records, ...extra,
  })

  it('lists handles and provenance without the records', async () => {
    // A page of handles that each carried their rows would be the export route
    // under a second name, and would blow the response budget it exists to bound.
    const { res } = await call({ kind: 'list' }, { data: { dataset_snapshots: [snapshotOf(events(5))] } })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.data.length, 1)
    assert.equal(body.data[0].handle, 'lds_a_b')
    assert.equal(body.data[0].records, undefined, 'the listing carried the records it exists to index')
    assert.equal(body.data[0].records_withheld, 5)
  })

  it('resolves a handle to its records', async () => {
    const { res } = await call({ kind: 'retrieve', handle: 'lds_a_b' }, { data: { dataset_snapshots: [snapshotOf(events(5))] } })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.records.length, 5)
  })

  it('answers provenance alone when the caller asks for it', async () => {
    // A consumer checking a citation should not have to pull the dataset to do it.
    const { res } = await call({ kind: 'retrieve', handle: 'lds_a_b' }, {
      data: { dataset_snapshots: [snapshotOf(events(5))] }, search: '?records=false',
    })
    const body = res.json()
    assert.equal(body.data.records, undefined)
    assert.equal(body.data.records_withheld, 5)
    assert.equal(body.data.licence, 'CC-BY-4.0')
  })

  it('answers 404 with a code for a handle it does not hold', async () => {
    const { res } = await call({ kind: 'retrieve', handle: 'lds_nope' }, { data: { dataset_snapshots: [] } })
    assert.equal(res.status, 404)
    assert.equal(res.json().code, 'not_found')
  })

  it('stores a snapshot and answers the handle rather than echoing the records', async () => {
    const data = { hazard_events: events(4), conflict_events: [] }
    const { res, store: s } = await call({ kind: 'create' }, {
      data, method: 'POST', body: { licence: 'CC-BY-4.0', attribution: 'IPC TWG', label: 'Flood risk' },
    })
    const body = res.json()
    assert.equal(res.status, 201)
    assert.equal(body.data.records, undefined, 'the create echoed back the set the caller just sent')
    assert.equal(body.data.records_withheld, 4)
    assert.match(body.data.handle, /^lds_/)
    assert.equal(s.merges.length, 1)
    assert.equal(s.merges[0].dataset_snapshots.length, 1)
    assert.equal(s.merges[0].dataset_snapshots[0].records.length, 4, 'the stored snapshot lost its records')
  })

  it('defaults to internal-only rather than to a permissive licence', async () => {
    // The default that cannot be wrong if the caller forgot: `internal-only`
    // forbids the redistribution a wrong permissive tag would allow.
    const { res, store: s } = await call({ kind: 'create' }, { data: { hazard_events: events(2) }, method: 'POST' })
    assert.equal(res.status, 201)
    assert.equal(s.merges[0].dataset_snapshots[0].licence, 'internal-only')
  })

  it('refuses a licence requiring attribution given none, rather than storing it', async () => {
    const { res, store: s } = await call({ kind: 'create' }, {
      data: { hazard_events: events(2) }, method: 'POST', body: { licence: 'CC-BY-4.0' },
    })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /requires attribution/)
    assert.equal(s.merges.length, 0, 'an unlicensed snapshot was stored anyway')
  })

  it('refuses a collection it does not have, instead of snapshotting nothing', async () => {
    const { res, store: s } = await call({ kind: 'create' }, {
      data: { hazard_events: events(2) }, method: 'POST', body: { licence: 'CC0-1.0', collections: ['hazard_events', 'nope'] },
    })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /Unknown collection/)
    assert.equal(s.merges.length, 0)
  })

  it('covers the same set a vintage covers when no collection is named', async () => {
    // The handle and the `x-lindela-vintage` header on an export have to
    // describe the same set, or a consumer comparing them is comparing two
    // different things.
    const data = { hazard_events: events(3), conflict_events: events(2), field_reports: events(1) }
    const { store: s } = await call({ kind: 'create' }, { data, method: 'POST', body: { licence: 'CC0-1.0' } })
    const stored = s.merges[0].dataset_snapshots[0]
    assert.equal(stored.record_count, 6, 'the snapshot did not span the export collections')
    assert.equal(stored.vintage, vintageOf([...data.hazard_events, ...data.conflict_events, ...data.field_reports]).vintage)
  })

  it('narrows the set with a query filter rather than storing everything', async () => {
    const data = { hazard_events: [{ id: 'h1', event_type: 'flood' }, { id: 'h2', event_type: 'drought' }] }
    const { store: s } = await call({ kind: 'create' }, {
      data, method: 'POST', search: '?event_type=flood', body: { licence: 'CC0-1.0' },
    })
    assert.equal(s.merges[0].dataset_snapshots[0].record_count, 1, 'the query filter did not narrow the snapshot')
  })

  it('refuses a body that is not JSON with a 400 carrying a code', async () => {
    const res = fakeResponse()
    const req = {
      method: 'POST',
      __auth: { subject: 't' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{not json') },
    }
    await assert.rejects(
      () => handleSnapshotRoute({ kind: 'create' }, {
        data: {}, res, req, store: store(), url: new URL('http://127.0.0.1/x'), jsonResponse,
      }),
      (err) => { assert.equal(err.statusCode, 400); return true },
    )
  })
})

describe('ENH-34 — the module answers, or declines, without inventing a response', () => {
  it('returns false for a kind it does not own', async () => {
    const { handled, res } = await call({ kind: 'not-a-snapshot-route' }, {})
    assert.equal(handled, false)
    assert.equal(res.status, null, 'an unowned kind wrote a response')
  })

  it('answers an absent collection as an empty one', async () => {
    const { handled, res } = await call({ kind: 'list' }, { data: {} })
    assert.equal(handled, true)
    assert.equal(res.status, 200)
    assert.deepEqual(res.json().data, [])
  })
})

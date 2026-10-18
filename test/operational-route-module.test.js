import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleOperationalRoute, matchOperationalRoute } from '../src/routes/operational.js'
import { WRITABLE_COLLECTIONS, buildCreate } from '../src/operations.js'
import { redactPii } from '../src/pii.js'
import { RETENTION_COLLECTIONS } from '../src/routes/maintenance.js'
import { runWithRequestContext } from '../src/utils.js'

/**
 * ARC-01 — the operational CRUD family as a module, asserted where it now lives.
 *
 * Seven collections across four verbs, and every one of them is already covered
 * end-to-end through the server. What the HTTP tests cannot see is the pair of
 * asymmetries this file exists to hold, because both are decisions that look
 * like inconsistencies and read as bugs to anyone tidying the code:
 *
 *   - `include_deleted` is honoured on the reads and *ignored* on the writes. A
 *     PATCH must see the soft-deleted record to answer 409 rather than 404 —
 *     "it exists and you may not change it" is a different answer from "it is
 *     not there". A write branch that quietly honoured the flag would report
 *     404 for a record the console is displaying.
 *   - `action_logs` is served like a collection but is read-only, on all three
 *     write verbs. It is the system's own audit trail.
 *
 * And VUL-03 at the point of extraction: the by-id read carries the same
 * partner-organisation predicate as the list form. Asserted here because the
 * two forms disagreeing is the exact defect, and a server test that runs as an
 * unscoped caller cannot tell the difference.
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

/** A store that records merges instead of persisting them. */
function fakeStore() {
  const merges = []
  return { merges, merge: async (patch) => { merges.push(patch) } }
}

const call = (route, {
  data = {}, search = '', method = 'GET', body = null, auth = { subject: 'tester', partner_org: null },
} = {}) => {
  const res = fakeResponse()
  const store = fakeStore()
  const req = {
    method,
    __auth: auth,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {})) },
  }
  return runWithRequestContext(auth, () => handleOperationalRoute(route, {
    data, res, req, store,
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  })).then((handled) => ({ handled, res, store }))
}

describe('ARC-01 — matchOperationalRoute names the URL segment and the collection', () => {
  it('translates the four segments whose name differs from the collection', () => {
    // The map is the only place this translation is stated, so a reader of the
    // store schema and a reader of the URL cannot both be right without it.
    const expected = {
      incidents: 'incidents',
      interventions: 'interventions',
      tasks: 'intervention_tasks',
      'field-reports': 'field_reports',
      'response-resources': 'response_resources',
      'action-logs': 'action_logs',
      'service-assets': 'service_assets',
    }
    for (const [segment, collection] of Object.entries(expected)) {
      assert.deepEqual(
        matchOperationalRoute(`/api/v1/${segment}`),
        { collection, id: null },
        `${segment} did not resolve to ${collection}`,
      )
      assert.deepEqual(
        matchOperationalRoute(`/api/v1/${segment}/abc`),
        { collection, id: 'abc' },
        `${segment}/abc did not resolve with an id`,
      )
    }
  })

  it('decodes an id rather than passing the raw segment through', () => {
    // An id with a character that is not URL-safe arrives percent-encoded. The
    // lookup is by exact id, so a matcher that skipped the decode would 404 on
    // a record that is plainly there.
    assert.deepEqual(matchOperationalRoute('/api/v1/incidents/a%2Fb'), { collection: 'incidents', id: 'a/b' })
  })

  it('does not match a collection it does not serve, or a deeper path', () => {
    for (const pathname of [
      '/api/v1/nope', '/api/v1/incidents/a/b', '/api/v1/incidents/', '/api/v1',
      '/api/v1/Incidents', '', '/',
    ]) {
      assert.equal(matchOperationalRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — include_deleted is honoured on the reads and ignored on the writes', () => {
  const deleted = { id: 'i1', status: 'open', deleted_at: '2026-01-01T00:00:00.000Z' }
  const live = { id: 'i2', status: 'open', title: 'Flood at Lodwar', incident_type: 'flood' }
  // `normalizeIncident` resolves linked events, so the builders read three
  // collections beyond the one being written. `store.read()` guarantees them.
  const links = { hazard_events: [], conflict_events: [], risk_scores: [] }

  it('hides a soft-deleted record from a by-id read unless asked', async () => {
    const data = { incidents: [deleted, live] }
    const hidden = await call({ collection: 'incidents', id: 'i1' }, { data })
    assert.equal(hidden.res.status, 404, 'a deleted record was served to a caller that did not ask for it')

    const asked = await call({ collection: 'incidents', id: 'i1' }, { data, search: '?include_deleted=true' })
    assert.equal(asked.res.status, 200)
    assert.equal(asked.res.json().data.id, 'i1')
  })

  it('filters the listing by the same switch', async () => {
    const data = { incidents: [deleted, live] }
    const hidden = await call({ collection: 'incidents', id: null }, { data })
    assert.equal(hidden.res.json().data.length, 1, 'the listing did not hide the deleted record')
    const asked = await call({ collection: 'incidents', id: null }, { data, search: '?include_deleted=true' })
    assert.equal(asked.res.json().data.length, 2)
  })

  it('answers 409, not 404, for a write to a soft-deleted record', async () => {
    // The asymmetry, asserted. A PATCH that honoured `include_deleted` the way
    // the read does would answer 404 — telling the caller the record is gone
    // while the console is displaying it, and hiding the real reason, which is
    // that it may not be changed.
    const data = { incidents: [deleted, live], ...links }
    const { res } = await call(
      { collection: 'incidents', id: 'i1' },
      { data, method: 'PATCH', body: { status: 'closed' } },
    )
    assert.equal(res.status, 409, 'a write to a deleted record did not report the conflict')
    assert.equal(res.json().code, 'record_deleted')
  })

  it('deletes a live record and merges an action log beside it', async () => {
    const data = { incidents: [live], ...links }
    const { res, store } = await call(
      { collection: 'incidents', id: 'i2' },
      { data, method: 'DELETE', body: { actor: 'operator' } },
    )
    assert.equal(res.status, 200)
    assert.equal(res.json().data.id, 'i2')
    assert.ok(res.json().data.deleted_at, 'a soft delete did not stamp deleted_at')
    assert.equal(store.merges.length, 1)
    assert.equal(store.merges[0].action_logs.length, 1, 'the delete was not recorded in the audit trail')
  })
})

describe('ARC-01 — service_assets is readable by id but refuses every write', () => {
  it('refuses PATCH and DELETE with METHOD_NOT_ALLOWED, not a 500', async () => {
    // The defect this guards: the matcher serves `service_assets` because
    // `GET /api/v1/service-assets/<id>` had no other way to resolve a record,
    // but the three builders know five collections. A by-id PATCH or DELETE fell
    // through to `buildUpdate` / `buildSoftDelete` and threw a bare
    // `Unsupported operational collection` — so a path OpenAPI documents as
    // GET-only answered 500 to a verb it never claimed, and the client read
    // "this deployment is broken" where the answer is "this verb is not offered".
    const data = { service_assets: [{ id: 'sa-1', name: 'Clinic A' }] }
    for (const method of ['PATCH', 'DELETE']) {
      const { res } = await call({ collection: 'service_assets', id: 'sa-1' }, { data, method, body: {} })
      assert.equal(res.status, 405, `${method} service_assets/<id> was not refused`)
      assert.equal(res.json().code, 'method_not_allowed')
    }
  })

  it('still resolves one asset by id', async () => {
    // The reason the entry is in the matcher at all. A refusal that also closed
    // the read would undo the fix the entry was added for.
    const data = { service_assets: [{ id: 'sa-1', name: 'Clinic A' }] }
    const { res } = await call({ collection: 'service_assets', id: 'sa-1' }, { data })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.id, 'sa-1')
  })

  it('refuses the write before it reads a body, as action_logs does', async () => {
    // Same ordering property as the audit trail: a malformed body must not
    // surface as a 400 from the reader before the 405.
    const req = {
      method: 'PATCH',
      __auth: { subject: 't', partner_org: null },
      async *[Symbol.asyncIterator]() { throw new Error('body must not be read') },
    }
    const res = fakeResponse()
    const handled = await handleOperationalRoute({ collection: 'service_assets', id: 'sa-1' }, {
      data: { service_assets: [{ id: 'sa-1' }] }, res, req, store: fakeStore(),
      url: new URL('http://127.0.0.1/x'), jsonResponse,
    })
    assert.equal(handled, true)
    assert.equal(res.status, 405)
  })

  it('leaves action_logs answering READ_ONLY, not METHOD_NOT_ALLOWED', async () => {
    // The order of the two refusals is load-bearing: `action_logs` is not in
    // `WRITABLE_COLLECTIONS` either, so a guard that tested writability first
    // would reclassify the audit trail's refusal and break a client that keys
    // on `read_only`.
    const { res } = await call({ collection: 'action_logs', id: null }, {
      data: { action_logs: [] }, method: 'POST', body: {},
    })
    assert.equal(res.status, 405)
    assert.equal(res.json().code, 'read_only')
  })
})

describe('ARC-01 — action_logs is served like a collection and refuses every write', () => {
  it('refuses POST, PATCH and DELETE with READ_ONLY', async () => {
    // It is the system's own audit trail. It is reachable as a collection, so a
    // write arrives at the same branches as any other and has to be turned away
    // there rather than by the matcher — the reads still work.
    const data = { action_logs: [{ id: 'l1', action: 'created' }] }
    const read = await call({ collection: 'action_logs', id: null }, { data })
    assert.equal(read.res.status, 200, 'the audit trail stopped being readable')

    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const id = method === 'POST' ? null : 'l1'
      const { res } = await call({ collection: 'action_logs', id }, { data, method, body: {} })
      assert.equal(res.status, 405, `${method} action_logs was not refused`)
      assert.equal(res.json().code, 'read_only')
    }
  })

  it('refuses a write before it reads a body', async () => {
    // Ordering, and it is observable: a malformed body would otherwise surface
    // as a 400 from the body reader before the 405. A refusal must not depend
    // on the request being well-formed.
    const req = { method: 'POST', __auth: { subject: 't', partner_org: null }, async *[Symbol.asyncIterator]() { throw new Error('body must not be read') } }
    const res = fakeResponse()
    const handled = await handleOperationalRoute({ collection: 'action_logs', id: null }, {
      data: { action_logs: [] }, res, req, store: fakeStore(),
      url: new URL('http://127.0.0.1/x'), jsonResponse,
    })
    assert.equal(handled, true)
    assert.equal(res.status, 405)
  })
})

describe('ARC-01 — VUL-03 holds at the point of extraction', () => {
  const mine = { id: 'i1', partner_org: 'org-a', status: 'open' }
  const theirs = { id: 'i2', partner_org: 'org-b', status: 'open' }

  it('scopes the by-id read the same way the listing is scoped', async () => {
    // The defect verbatim: the listing was scoped and the by-id form was a bare
    // `find` with no predicate, so an id read out of the listing fetched another
    // organisation's record. An id is not a secret — it is in every link.
    const data = { incidents: [mine, theirs] }
    const auth = { subject: 'partner-a', partner_org: 'org-a' }

    const listing = await call({ collection: 'incidents', id: null }, { data, auth })
    const visibleIds = listing.res.json().data.map((r) => r.id)
    assert.deepEqual(visibleIds, ['i1'], 'the listing did not scope to the caller organisation')

    const foreign = await call({ collection: 'incidents', id: 'i2' }, { data, auth })
    assert.equal(foreign.res.status, 404, 'the by-id read served another organisation the record its listing hid')

    const own = await call({ collection: 'incidents', id: 'i1' }, { data, auth })
    assert.equal(own.res.status, 200)
  })
})

describe('ARC-01 — the module answers, or declines, without inventing a response', () => {
  it('refuses a method it does not serve with 405, not a 404', async () => {
    // The matcher matched, so the path exists. PUT is not one of its four verbs.
    const { res } = await call({ collection: 'incidents', id: null }, { data: { incidents: [] }, method: 'PUT' })
    assert.equal(res.status, 405)
  })
})

describe('PRIV — the operational write door redacts, like the other two', () => {
  // `src/routes/rapidpro.js` and `src/routes/chw.js` both call `redactPii` on
  // what they store. This path built a record with `buildCreate` and stored it
  // untouched, so `POST /api/v1/field-reports` with `reported_by: "Amina Nakuru"`
  // wrote that name in cleartext where `redactPii` hashes exactly that field.
  // `src/operations.js:323` already makes this argument for the quality verdict
  // — "a gate at one of two doors is not a gate" — and it holds for PII too.
  const PSEUDONYM = /^sha256:[0-9a-f]+:[0-9a-f]+$/

  it('pseudonymises a caller-supplied reported_by rather than storing it', async () => {
    const { store } = await call({ kind: 'collection', collection: 'field_reports' }, {
      method: 'POST',
      body: { summary: 'Water rising at the clinic', incident_id: 'inc-1', reported_by: 'Amina Nakuru' },
      data: { incidents: [{ id: 'inc-1', title: 'Flood', status: 'open' }] },
    })
    const written = store.merges.flatMap((m) => m.field_reports || [])[0]
    assert.ok(written, 'nothing was written')
    assert.doesNotMatch(written.reported_by, /Amina/, 'the reporter name reached the store in cleartext')
    assert.match(written.reported_by, PSEUDONYM, 'reported_by was not pseudonymised')
  })

  it('gives the default and a supplied name the same shape', async () => {
    // Redacting the *built* record rather than the input is what makes this
    // true: `normalizeFieldReport` defaults `reported_by` to the literal
    // `'operator'`, and a redactor that ran before the build would hash the
    // caller's name and leave the system label in cleartext — two shapes in one
    // column, decided by whether the field was sent.
    const data = { incidents: [{ id: 'inc-1', title: 'Flood', status: 'open' }] }
    const named = await call({ kind: 'collection', collection: 'field_reports' }, {
      method: 'POST', body: { summary: 'a', incident_id: 'inc-1', reported_by: 'Amina Nakuru' }, data,
    })
    const bare = await call({ kind: 'collection', collection: 'field_reports' }, {
      method: 'POST', body: { summary: 'b', incident_id: 'inc-1' }, data,
    })
    const a = named.store.merges.flatMap((m) => m.field_reports || [])[0].reported_by
    const b = bare.store.merges.flatMap((m) => m.field_reports || [])[0].reported_by
    assert.match(a, PSEUDONYM)
    assert.match(b, PSEUDONYM, 'the default reporter was left as the literal "operator"')
    assert.notEqual(a, b, 'two different reporters hashed to one value, so the distinct-reporter count collapsed')
  })

  it('leaves a resource name alone — it is a thing, not a person', async () => {
    // The redactor must not reach a field it was never about. `name` is a
    // person's name in a provider payload and a piece of equipment here, which
    // is why the top level matches `reporter_name`/`contact_name` only.
    const { store } = await call({ kind: 'collection', collection: 'response_resources' }, {
      method: 'POST',
      body: { name: 'Water treatment kits', resource_type: 'supply', location_name: 'Lodwar' },
    })
    const written = store.merges.flatMap((m) => m.response_resources || [])[0]
    assert.equal(written.name, 'Water treatment kits', 'the redactor hashed a resource name')
    assert.equal(written.location_name, 'Lodwar', 'the redactor hashed a place name')
  })

  it('pseudonymises a reported_by sent by PATCH, not just by POST', async () => {
    // PRIV-03. The two write branches reach the same builder over the same
    // collection, and only POST called the redactor — so the gate held at one
    // of two doors. A PATCH naming a reporter stored the name in cleartext
    // where the POST beside it stored a pseudonym, and nothing failed.
    const data = { field_reports: [{
      id: 'fr-1', summary: 'Water rising', incident_id: 'inc-1',
      reported_by: 'operator', observed_at: '2026-10-01T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z',
    }], incidents: [{ id: 'inc-1', title: 'Flood', status: 'open' }] }
    const { store } = await call({ kind: 'collection', collection: 'field_reports', id: 'fr-1' }, {
      method: 'PATCH', body: { reported_by: 'Amina Nakuru' }, data,
    })
    const written = store.merges.flatMap((m) => m.field_reports || [])[0]
    assert.ok(written, 'nothing was written')
    assert.doesNotMatch(written.reported_by, /Amina/, 'a PATCH put the reporter name in the store in cleartext')
    assert.match(written.reported_by, PSEUDONYM)
  })

  it('keeps the pseudonym a second door already wrote, rather than hashing it again', async () => {
    // The reason the PATCH fix does not corrupt anything: a record that already
    // carries a pseudonym must keep it. `redactPii` used to hash whatever string
    // it found, its own output included, so two doors meant two pseudonyms for
    // one person and `src/kpi.js` counted them as two reporters. Asserted
    // against a value the redactor wrote, so the control is real rather than a
    // literal this test happens to know.
    const data = { field_reports: [{
      id: 'fr-1', summary: 'Water rising', incident_id: 'inc-1',
      reported_by: 'operator', observed_at: '2026-10-01T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z',
    }], incidents: [{ id: 'inc-1', title: 'Flood', status: 'open' }] }
    const created = await call({ kind: 'collection', collection: 'field_reports' }, {
      method: 'POST', body: { summary: 'Water rising', incident_id: 'inc-1', reported_by: 'Amina Nakuru' }, data,
    })
    const pseudonym = created.store.merges.flatMap((m) => m.field_reports || [])[0].reported_by
    assert.match(pseudonym, PSEUDONYM)

    const patched = await call({ kind: 'collection', collection: 'field_reports', id: 'fr-1' }, {
      method: 'PATCH', body: { summary: 'Water rising at the clinic' },
      data: { ...data, field_reports: [{ ...data.field_reports[0], reported_by: pseudonym }] },
    })
    const rewritten = patched.store.merges.flatMap((m) => m.field_reports || [])[0].reported_by
    assert.equal(rewritten, pseudonym, 'a second pass through the redactor split one reporter into two pseudonyms')
  })
})

describe('PRIV-03 — a soft-deletable collection that redacts must also expire', () => {
  it('names every operational collection whose records the redactor changes in the retention set', () => {
    // The structural gap, not a live leak. `apply-retention` expires the
    // collections in `RETENTION_COLLECTIONS`, and the operational family can
    // soft-delete five more — so a collection that redacts personal data and
    // is *not* in the retention set keeps it forever, because a soft delete
    // never reclaims storage (ADR-007). `retentionWindowFor` answers a window
    // for any collection name, so the omission is invisible: nothing reads the
    // two lists together, and `incidents` looks configured while never being
    // enumerated.
    //
    // Derived from the builders rather than listed, so a sixth operational
    // collection carrying a redactable field fails here instead of arriving in
    // a store that keeps it forever. Today exactly one does — `field_reports`,
    // through `reported_by` — and it is in the set.
    const data = {
      hazard_events: [], conflict_events: [], risk_scores: [],
      incidents: [{ id: 'inc-1', title: 'Flood', status: 'open' }],
      interventions: [{ id: 'int-1', incident_id: 'inc-1', title: 'Supply' }],
      service_assets: [],
    }
    const seeded = {
      reported_by: 'Amina Nakuru', reporter_name: 'Amina Nakuru', contact_name: 'Amina Nakuru',
      phone: '+254700000001', urn: 'tel:+254700000001', contact_urn: 'tel:+254700000001',
      from: '+254700000001', payload: { contact: { name: 'Amina Nakuru', urn: 'tel:+254700000001' } },
      summary: 'Water rising', title: 'Flood', description: 'Water rising', name: 'Water treatment kits',
      incident_id: 'inc-1', intervention_id: 'int-1', submission_id: 's1',
      latitude: 3.1, longitude: 35.6,
    }
    const redactedCollections = []
    for (const collection of WRITABLE_COLLECTIONS) {
      const built = buildCreate(collection, { ...seeded }, data)
      const redacted = redactPii(built, { redactNames: true, redactPhone: true })
      const changed = Object.keys(redacted).filter((k) => JSON.stringify(redacted[k]) !== JSON.stringify(built[k]))
      if (changed.length) redactedCollections.push(collection)
    }
    assert.deepEqual(redactedCollections.sort(), ['field_reports'],
      'the set of operational collections that redact changed; check whether the new one has a retention window')

    const uncovered = redactedCollections.filter((c) => !RETENTION_COLLECTIONS.includes(c))
    assert.deepEqual(uncovered, [],
      `these collections hold redacted personal data with no retention window, so a soft delete keeps it forever: ${uncovered.join(', ')}`)
  })
})

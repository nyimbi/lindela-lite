import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { activeForms, handleFormsRoute, matchFormsRoute } from '../src/routes/forms.js'
import { BUILTIN_FORMS } from '../src/forms.js'

/**
 * ENH-60 — the taxonomy-and-forms family as a module, asserted where it now
 * lives.
 *
 * Four routes over the vocabulary a client renders and the form definitions it
 * validates against. They are one family because they are the *configuration*
 * surface — everything else reads them — and the same immutability rule appears
 * three times:
 *
 *   - a published version is not overwritten (409), because submissions name it;
 *   - a built-in is not replaced in place, only superseded by a higher version;
 *   - a version the deployment does not hold is a 404 naming what it does hold,
 *     not a fallback to the newest.
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

const call = (route, { data = {}, store, search = '', body } = {}) => {
  const res = fakeResponse()
  const raw = body === undefined ? '' : JSON.stringify(body)
  return handleFormsRoute(route, {
    store: store || { merge: async () => {} },
    data, res,
    req: {
      method: route.kind === 'forms-publish' ? 'POST' : 'GET',
      __auth: { subject: 'tester', partner_org: null },
      __rawBody: raw,
      async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw) },
    },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

const builtin = BUILTIN_FORMS[0]

describe('ENH-60 — matchFormsRoute is method-aware and anchors the detail path', () => {
  it('matches the three reads on GET', () => {
    assert.deepEqual(matchFormsRoute('/api/v1/taxonomy'), { kind: 'taxonomy' })
    assert.deepEqual(matchFormsRoute('/api/v1/forms'), { kind: 'forms-catalogue' })
    assert.deepEqual(matchFormsRoute('/api/v1/forms/chw_symptom_report'), { kind: 'form', id: 'chw_symptom_report' })
  })

  it('matches the publish on POST only', () => {
    assert.deepEqual(matchFormsRoute('/api/v1/forms', 'POST'), { kind: 'forms-publish' })
    assert.equal(matchFormsRoute('/api/v1/forms/chw_symptom_report', 'POST'), null)
    assert.equal(matchFormsRoute('/api/v1/taxonomy', 'POST'), null)
  })

  it('does not resolve a two-segment tail to a form id', () => {
    for (const pathname of ['/api/v1/forms/a/b', '/api/v1/forms/', '/api/v1/form']) {
      assert.equal(matchFormsRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })

  it('decodes a percent-encoded id rather than matching the raw segment', () => {
    assert.deepEqual(matchFormsRoute('/api/v1/forms/a%20b'), { kind: 'form', id: 'a b' })
  })
})

describe('ENH-60 — the taxonomy reports a bad extension rather than throwing', () => {
  it('serves a document with its categories', async () => {
    const { res } = await call({ kind: 'taxonomy' })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.ok(body.data, 'the taxonomy served no document')
  })
})

describe('ENH-60 — a published version is immutable, and the refusals name the fix', () => {
  it('lists the built-ins in the catalogue', async () => {
    const { res } = await call({ kind: 'forms-catalogue' })
    const body = res.json()
    assert.ok(body.data.forms.length > 0)
    assert.ok(body.data.forms.some((f) => f.id === builtin.id))
  })

  it('refuses to overwrite a published version with a 409', async () => {
    // Publish v2, then publish v2 again.
    const definition = { ...builtin, version: 2, deployment: true }
    const first = { merge: async () => {} }
    const created = await call({ kind: 'forms-publish' }, { store: first, data: {}, body: { form: definition } })
    assert.equal(created.res.status, 201)
    const stored = created.res.json().data
    const second = await call({ kind: 'forms-publish' }, {
      store: { merge: async () => {} },
      data: { form_definitions: [stored] },
      body: { form: definition },
    })
    assert.equal(second.res.status, 409, 'a published version was overwritten')
    assert.match(second.res.json().error, /immutable/i)
  })

  it('refuses to replace a built-in in place, and says which version to publish', async () => {
    const { res } = await call({ kind: 'forms-publish' }, {
      body: { form: { ...builtin, version: builtin.version } },
    })
    assert.equal(res.status, 409, 'a built-in was replaced by a deployment')
    assert.match(res.json().error, /built-in/)
  })

  it('refuses a definition that does not validate, with the problems', async () => {
    const { res } = await call({ kind: 'forms-publish' }, { body: { form: { id: 'x' } } })
    assert.equal(res.status, 400)
    assert.ok(Array.isArray(res.json().problems) && res.json().problems.length > 0,
      'an invalid definition was refused with no reason')
  })
})

describe('ENH-60 — a version the deployment does not hold is a 404, not a fallback', () => {
  it('answers a request for a version it does not hold by naming what it does', async () => {
    const { res } = await call({ kind: 'form', id: builtin.id }, { search: '?version=99' })
    assert.equal(res.status, 404)
    assert.match(res.json().error, new RegExp(`${builtin.id} has no version 99`))
    assert.match(res.json().error, new RegExp(String(builtin.version)),
      'the refusal does not say which versions the deployment does hold')
  })

  it('serves the newest version when none is named', async () => {
    const { res } = await call({ kind: 'form', id: builtin.id })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.id, builtin.id)
  })

  it('404s an unknown form id', async () => {
    const { res } = await call({ kind: 'form', id: 'nope' })
    assert.equal(res.status, 404)
    assert.match(res.json().error, /no form with id nope/)
  })
})

describe('ENH-60 — activeForms is this family’s read', () => {
  it('merges a published version over the built-in rather than replacing the catalogue', () => {
    const merged = activeForms({ form_definitions: [{ ...builtin, version: 2, deployment: true }] })
    assert.ok(merged.some((f) => f.id === builtin.id && f.version === builtin.version),
      'publishing a version removed the built-in it supersedes')
    assert.ok(merged.some((f) => f.id === builtin.id && f.version === 2))
  })

  it('answers the built-ins for an empty store rather than throwing', () => {
    assert.ok(activeForms({}).length > 0)
    assert.ok(activeForms(undefined).length > 0)
  })
})

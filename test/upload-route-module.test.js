import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleUploadRoute, matchUploadRoute } from '../src/routes/upload.js'

/**
 * ENH-60 — the upload family as a module, asserted where it now lives.
 *
 * Two routes and one contract, and the property that makes them a family: an
 * upload route is where a partial write is most tempting and most damaging, so
 * the three rules that prevent one live together:
 *
 *   - a batch that fails validation writes nothing;
 *   - a dry run writes no rows but still logs what it would have done;
 *   - a malformed multipart body is a 400, not a 500.
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

const call = (route, { data = {}, store, search = '', headers = {}, body } = {}) => {
  const res = fakeResponse()
  const raw = body === undefined ? '' : JSON.stringify(body)
  return handleUploadRoute(route, {
    store: store || { merge: async () => {} },
    data, res,
    req: {
      method: route.kind === 'upload-ingest' ? 'POST' : 'GET',
      headers,
      __auth: { subject: 'tester', partner_org: null },
      __rawBody: raw,
      async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw) },
    },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

// A valid service_assets row. `validateUpload` requires the columns its schema
// names, so the header row has to carry them.
const VALID_CSV = [
  'id,name,type,latitude,longitude,status',
  'sa-1,Test borehole,borehole,3.1,35.6,operational',
].join('\n')

describe('ENH-60 — matchUploadRoute is method-aware on one path', () => {
  it('separates the contract from the ingest by verb', () => {
    assert.deepEqual(matchUploadRoute('/api/v1/upload', 'GET'), { kind: 'upload-contract' })
    assert.deepEqual(matchUploadRoute('/api/v1/upload', 'POST'), { kind: 'upload-ingest' })
  })

  it('does not serve an ingest on a read verb, or a contract on a write', () => {
    // A blanket match on the path would have made the contract POST-able and the
    // ingest GET-able; the two are one path and opposite intents.
    assert.equal(matchUploadRoute('/api/v1/upload', 'DELETE'), null)
    assert.equal(matchUploadRoute('/api/v1/upload', 'PUT'), null)
    assert.equal(matchUploadRoute('/api/v1/uploads', 'GET'), null)
  })
})

describe('ENH-60 — the contract lists the columns before the client sends anything', () => {
  it('serves every collection with its required and optional columns', async () => {
    const { res } = await call({ kind: 'upload-contract' })
    const body = res.json()
    assert.ok(body.collections.length > 0)
    for (const collection of body.collections) {
      assert.ok(collection.id, 'a collection is listed with no id')
      assert.ok(Array.isArray(collection.required_columns),
        `${collection.id} has no required-column list, so a client must guess and guess wrong`)
    }
  })

  it('names the three content types it accepts', async () => {
    const { res } = await call({ kind: 'upload-contract' })
    const accepts = res.json().accepts.join(' ')
    assert.match(accepts, /multipart/)
    assert.match(accepts, /text\/csv/)
    assert.match(accepts, /json/)
  })
})

describe('ENH-60 — a failed batch writes nothing', () => {
  it('refuses a body whose rows do not validate, with a 422 and the errors', async () => {
    let merged = null
    const store = { merge: async (partial) => { merged = partial; return partial } }
    const csv = 'id,name,type\nsa-1,,borehole' // `name` is required and empty
    const { res } = await call({ kind: 'upload-ingest' }, { store, body: { csv, collection: 'service_assets' } })
    assert.equal(res.status, 422)
    assert.equal(res.json().success, false)
    // The action log is written; the records are not.
    assert.ok(merged.action_logs, 'the attempt was not logged')
    assert.equal(merged.service_assets, undefined,
      'a batch that failed validation wrote rows, so a partial import landed')
  })

  it('imports a valid batch and reports how many rows landed', async () => {
    const merges = []
    const store = { merge: async (partial) => { merges.push(partial); return partial } }
    const { res } = await call({ kind: 'upload-ingest' }, { store, body: { csv: VALID_CSV, collection: 'service_assets' } })
    assert.equal(res.status, 201)
    assert.equal(res.json().imported, 1)
    assert.equal(merges.at(-1).service_assets.length, 1)
  })

  it('gives two posts of the same bytes the same batch id', async () => {
    // The route merges twice: the log first, then the records. Only the log
    // carries a batch id, so the double has to read the key rather than assume
    // the shape.
    const ids = []
    const store = {
      merge: async (partial) => {
        if (partial.action_logs) ids.push(partial.action_logs[0].metadata.batch_id)
        return partial
      },
    }
    await call({ kind: 'upload-ingest' }, { store, body: { csv: VALID_CSV, collection: 'service_assets' } })
    await call({ kind: 'upload-ingest' }, { store, body: { csv: VALID_CSV, collection: 'service_assets' } })
    assert.equal(ids.length, 2, 'one of the two posts did not reach the log')
    assert.equal(ids[0], ids[1],
      'the batch id is not a fingerprint of the bytes, so an operator cannot tell a repeat import from a new one')
  })
})

describe('ENH-60 — a dry run writes no rows and says what it would have done', () => {
  it('writes no records, logs the attempt, and reports the errors', async () => {
    const merges = []
    const store = { merge: async (partial) => { merges.push(partial); return partial } }
    const csv = 'id,name,type\nsa-1,,borehole'
    const { res } = await call({ kind: 'upload-ingest' }, { store, body: { csv, collection: 'service_assets', dry_run: true } })
    const body = res.json()
    assert.equal(res.status, 200, 'a dry run of an invalid batch answered with the write path status')
    assert.equal(body.dry_run, true)
    assert.ok(Array.isArray(body.errors), 'the dry run reported no errors on an invalid batch')
    assert.equal(merges[0].action_logs[0].metadata.dry_run, true, 'the dry run was logged as a real import')
    assert.equal(merges.length, 1, 'a dry run merged records into the store')
  })

  it('truncates a large error list rather than shipping it', async () => {
    // A four-thousand-error body is a denial of service against the reader. The
    // rows carry a non-numeric latitude so each produces its *own* error — a
    // missing column is one error for the whole file, which never reaches the
    // twenty-row cut.
    const rows = Array.from({ length: 60 }, (_, i) => `sa-${i},Borehole ${i},borehole,not-a-number,35.6,operational`)
    const csv = ['id,name,type,latitude,longitude,status', ...rows].join('\n')
    const { res } = await call({ kind: 'upload-ingest' }, { body: { csv, collection: 'service_assets', dry_run: true } })
    const body = res.json()
    assert.equal(body.errors.length, 20)
    assert.equal(body.errors_truncated, true, 'the error list was cut without saying so')
  })
})

describe('ENH-60 — the three doors converge on one validator', () => {
  it('reads text/csv from the raw body', async () => {
    const { res } = await call({ kind: 'upload-ingest' }, {
      headers: { 'content-type': 'text/csv' },
      search: '?collection=service_assets',
      body: undefined,
    })
    // The raw body is empty here, so this asserts the branch was taken and
    // reached the validator rather than the JSON path: an empty CSV is a
    // validation refusal, not a 500.
    assert.ok([422, 400].includes(res.status), `text/csv did not reach the validator (status ${res.status})`)
  })

  it('reads the CSV out of a JSON body', async () => {
    const { res } = await call({ kind: 'upload-ingest' }, { body: { csv: VALID_CSV, collection: 'service_assets' } })
    assert.equal(res.status, 201)
    assert.equal(res.json().collection, 'service_assets')
  })

  it('refuses a multipart body with no file part as a 400, not a 500', async () => {
    const boundary = '----testboundary'
    const raw = `--${boundary}\r\nContent-Disposition: form-data; name="collection"\r\n\r\nservice_assets\r\n--${boundary}--\r\n`
    const { res } = await call({ kind: 'upload-ingest' }, {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: raw,
    })
    assert.equal(res.status, 400, 'a client body with no file part read as a server fault')
    assert.match(res.json().error, /file/i)
  })

  it('honours parseMultipart’s own status on malformed framing', async () => {
    const { res } = await call({ kind: 'upload-ingest' }, {
      headers: { 'content-type': 'multipart/form-data' }, // no boundary
      body: 'garbage',
    })
    assert.ok(res.status >= 400 && res.status < 500,
      `malformed multipart framing answered ${res.status}, so a client fault read as a server fault`)
  })
})

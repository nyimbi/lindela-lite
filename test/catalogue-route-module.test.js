import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleCatalogueRoute, matchCatalogueRoute } from '../src/routes/catalogue.js'

/**
 * ENH-60 — the source-catalogue family as a module, asserted where it now lives.
 *
 * Three reads that join a static catalogue against `source_runs`. The property
 * they share is not a subject but a failure mode: a catalogue is never empty, so
 * a route that joins one against an empty history answers 200 with a
 * full-looking list. The answer to be afraid of is not an error — it is a row
 * that reads healthy because nothing was ever recorded.
 *
 * So the assertions are mostly about absence, and about the two asymmetries this
 * file exists to hold because both read as bugs to anyone tidying the code:
 *
 *   - a connector with no env gate is `enabled: true` with `gate: null`, not
 *     gated off with an invented variable name;
 *   - the "last run" is the most recent run *for that connector*, never the
 *     newest run overall.
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
  return handleCatalogueRoute(route, {
    data, res,
    req: { method, __auth: { subject: 'tester', partner_org: null } },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

describe('ENH-60 — matchCatalogueRoute takes the method, so a wrong verb is not this family\'s refusal', () => {
  it('matches the three reads on GET', () => {
    assert.deepEqual(matchCatalogueRoute('/api/v1/sources', 'GET'), { kind: 'sources' })
    assert.deepEqual(matchCatalogueRoute('/api/v1/connectors', 'GET'), { kind: 'connectors' })
    assert.deepEqual(matchCatalogueRoute('/api/v1/connectors/status', 'GET'), { kind: 'connectors-status' })
  })

  it('matches nothing on a write verb, so the surface answers it as it answers any other', () => {
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      assert.equal(matchCatalogueRoute('/api/v1/sources', method), null)
      assert.equal(matchCatalogueRoute('/api/v1/connectors', method), null)
      assert.equal(matchCatalogueRoute('/api/v1/connectors/status', method), null)
    }
  })

  it('matches nothing it does not serve', () => {
    for (const pathname of ['/api/v1/sources/extra', '/api/v1/connector', '/api/v1/sources-status']) {
      assert.equal(matchCatalogueRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ENH-60 — a source that never ran reports unknown, not healthy', () => {
  it('answers every catalogue entry even with an empty run history', async () => {
    const { handled, res } = await call({ kind: 'sources' }, { data: { source_runs: [] } })
    assert.equal(handled, true)
    assert.equal(res.status, 200)
    const rows = res.json().data
    assert.ok(rows.length > 0, 'the source catalogue came back empty')
    // The whole point: no run means no health, and the answer must be a state
    // an operator can act on. `never_run` is that state — a default of `fresh`
    // is the one answer they cannot act on, because it reads as working.
    for (const row of rows) {
      assert.equal(row.health, 'never_run', `${row.id} reported health ${row.health} with no run recorded`)
      assert.equal(row.last_run, null)
    }
  })

  it('publishes the last run and its health once one exists', async () => {
    const { res } = await call({ kind: 'sources' }, {
      data: { source_runs: [{ id: 'r1', source: 'open_meteo', status: 'ok', completed_at: '2026-10-12T00:00:00Z' }] },
    })
    const row = res.json().data.find((entry) => entry.id === 'open_meteo')
    assert.ok(row, 'open_meteo was not in the catalogue')
    assert.equal(row.last_run.id, 'r1')
  })

  it('excludes a blocked source from the catalogue it publishes', async () => {
    const { res } = await call({ kind: 'sources' }, { data: { source_runs: [] } })
    const ids = res.json().data.map((row) => row.id)
    assert.ok(!ids.includes('gdelt'), 'a blocked source was published in the catalogue')
  })
})

describe('ENH-60 — the last run is per connector, never the newest run overall', () => {
  it('does not attribute one connector\'s failure to another', async () => {
    // The defect this guards: the newest run overall belongs to the weather
    // source, and a working DHIS2 must not be reported broken because of it.
    const { res } = await call({ kind: 'connectors' }, {
      data: {
        source_runs: [
          { id: 'r-dhis', source: 'dhis2', status: 'ok', completed_at: '2026-10-11T00:00:00Z' },
          { id: 'r-weather', source: 'open_meteo_forecast', status: 'error', completed_at: '2026-10-12T00:00:00Z' },
        ],
      },
    })
    const dhis = res.json().data.find((c) => c.id === 'dhis2')
    assert.ok(dhis, 'dhis2 was not in the registry')
    assert.equal(dhis.last_run.id, 'r-dhis', 'the newest run overall was attributed to the wrong connector')
    assert.equal(dhis.status, 'ok')
  })

  it('orders an in-flight run by started_at rather than dropping it to NaN', async () => {
    // `new Date(undefined).getTime()` is NaN, and NaN compares equal to
    // everything — so a run with no `completed_at` sorted unpredictably and
    // could land ahead of a finished one.
    const { res } = await call({ kind: 'connectors' }, {
      data: {
        source_runs: [
          { id: 'r-old', source: 'dhis2', status: 'ok', completed_at: '2026-10-01T00:00:00Z' },
          { id: 'r-flight', source: 'dhis2', status: 'running', started_at: '2026-10-12T00:00:00Z' },
        ],
      },
    })
    const dhis = res.json().data.find((c) => c.id === 'dhis2')
    assert.equal(dhis.last_run.id, 'r-flight', 'a run still in flight was not the most recent')
  })
})

describe('ENH-60 — a connector with no gate is always-on, not gated', () => {
  it('reports gate null and enabled true for an ungated connector', async () => {
    const { res } = await call({ kind: 'connectors-status' }, { data: { source_runs: [] } })
    const body = res.json()
    const ungated = body.data.filter((row) => row.gate === null)
    assert.ok(ungated.length > 0, 'every connector reported a gate, which would mean an invented flag name')
    for (const row of ungated) {
      assert.equal(row.enabled, true, `${row.id} was reported off with no gate to switch it on`)
      assert.equal(row.reason, null)
    }
  })

  it('names the variable to set for a gated-off connector', async () => {
    // A gated-off connector is a deliberate choice, so it says what to set
    // rather than just reporting false.
    const { res } = await call({ kind: 'connectors-status' }, { data: { source_runs: [] } })
    for (const row of res.json().data.filter((r) => !r.enabled)) {
      assert.ok(row.gate, `${row.id} was reported off with no gate named`)
      assert.match(row.reason, new RegExp(`${row.gate}=on`), 'the reason did not name the variable to set')
    }
  })

  it('counts rather than paginates, because the registry is a fixed catalogue', async () => {
    const { res } = await call({ kind: 'connectors-status' }, { data: { source_runs: [] } })
    const body = res.json()
    assert.equal(body.count, body.data.length)
    assert.equal(body.total, undefined,
      'a `total` without returned/limit/has_more is a paging envelope missing four of its five keys')
  })

  it('reports unknown for a connector that has never run', async () => {
    const { res } = await call({ kind: 'connectors' }, { data: { source_runs: [] } })
    for (const row of res.json().data) {
      assert.equal(row.status, 'unknown', `${row.id} reported status ${row.status} with no run recorded`)
    }
  })
})

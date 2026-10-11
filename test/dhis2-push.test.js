#!/usr/bin/env node
/**
 * DHIS2 push tests — no network, global fetch stubbed and restored.
 *
 * The pins, each mapping to a refusal the module states:
 *  - a record with no dataElement mapping is refused, not sent under a guess;
 *  - a record with no orgUnit mapping is refused;
 *  - an absent value is refused rather than written as 0 — the push's version
 *    of VER-02, and the one that would land a fabricated zero in a national
 *    database;
 *  - `dry_run` defaults to true, so the default answer to "should this leave
 *    the building" is no;
 *  - a 200 with `status: 'ERROR'` is a rejected import, not a success.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { dataValueSetFrom, periodForDate, pushDataValueSet } from '../src/connectors/dhis2-push.js'

const ENABLED = { LINDELA_LITE_DHIS2_ENABLED: 'on' }

function withEnv(overrides, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

// Two spellings of one mapping, because two call conventions meet here:
// `dataValueSetFrom` is a plain function over camelCase arguments, and
// `pushDataValueSet` takes a connector request, whose convention is snake_case
// (`request.org_units`, `request.base_url`) — the same shape the pull in
// `src/connectors/dhis2.js` reads. Passing the wrong one silently refuses every
// record, which is what this fixture got wrong first.
const ORG_UNITS = { turkana: 'OU-TURKANA' }
const DATA_ELEMENTS = { rainfall_mm: 'DE-RAIN' }
const MAPPINGS = { orgUnits: ORG_UNITS, dataElements: DATA_ELEMENTS }
const PUSH = { org_units: ORG_UNITS, data_elements: DATA_ELEMENTS }

const RECORD = {
  id: 'r1',
  indicator: 'rainfall_mm',
  district: 'turkana',
  value: 42.5,
  observed_at: '2026-10-11T00:00:00Z',
}

describe('DHIS2 push (CAP-02)', () => {
  it('derives a monthly period from an observation date', () => {
    assert.equal(periodForDate('2026-10-11T00:00:00Z'), '202610')
    assert.equal(periodForDate('2026-01-31T12:00:00Z'), '202601')
    assert.equal(periodForDate('not a date'), null)
    assert.equal(periodForDate(null), null)
  })

  it('builds a dataValueSet from a mapped record', () => {
    const { dataValues, refused } = dataValueSetFrom([RECORD], MAPPINGS)
    assert.equal(refused.length, 0)
    assert.deepEqual(dataValues, [{ dataElement: 'DE-RAIN', period: '202610', orgUnit: 'OU-TURKANA', value: '42.5' }])
  })

  it('refuses a record with no dataElement mapping rather than guessing a UID', () => {
    const { dataValues, refused } = dataValueSetFrom([{ ...RECORD, indicator: 'unmapped_thing' }], MAPPINGS)
    assert.equal(dataValues.length, 0)
    assert.equal(refused.length, 1)
    assert.equal(refused[0].reason, 'no dataElement mapping')
    assert.equal(refused[0].indicator, 'unmapped_thing')
  })

  it('refuses a record with no orgUnit mapping rather than sending a blank org unit', () => {
    const { dataValues, refused } = dataValueSetFrom([{ ...RECORD, district: 'nowhere' }], MAPPINGS)
    assert.equal(dataValues.length, 0)
    assert.equal(refused[0].reason, 'no orgUnit mapping')
    assert.equal(refused[0].district, 'nowhere')
  })

  it('refuses an absent value instead of filing it as a measured zero', () => {
    // `Number(null)` is 0 and `Number('')` is 0, so a truthiness or Number()
    // check writes a fabricated zero into a national database for every record
    // where nobody reported. VER-02's class, on the way out.
    for (const value of [null, undefined, '', '   ', 'not a number', NaN]) {
      const { dataValues, refused } = dataValueSetFrom([{ ...RECORD, value }], MAPPINGS)
      assert.equal(dataValues.length, 0, `value ${JSON.stringify(value)} was sent`)
      assert.match(refused[0].reason, /absent reading is not a zero/)
    }
  })

  it('accepts a numeric string, which is what a CSV round-trip produces', () => {
    const { dataValues } = dataValueSetFrom([{ ...RECORD, value: '42.5' }], MAPPINGS)
    assert.equal(dataValues[0].value, '42.5')
  })

  it('refuses a record with no parseable date, so it has no period to file under', () => {
    const { dataValues, refused } = dataValueSetFrom([{ ...RECORD, observed_at: null, created_at: null }], MAPPINGS)
    assert.equal(dataValues.length, 0)
    assert.match(refused[0].reason, /no parseable observation date/)
  })

  it('defaults to a dry run, so nothing leaves the building unless asked', async () => {
    const stub = stubFetch(() => { throw new Error('fetch must not be called on the default path') })
    try {
      const result = await pushDataValueSet({ ...PUSH, records: [RECORD], base_url: 'https://hmis.example' })
      assert.equal(result.dry_run, true)
      assert.equal(result.outcome, 'dry_run')
      assert.equal(result.dataValues, 1)
      assert.equal(result.data_value_set.dataValues[0].orgUnit, 'OU-TURKANA')
      assert.equal(stub.calls.length, 0, 'a dry run made a network call')
    } finally {
      stub.restore()
    }
  })

  it('refuses to push when the connector is gated off', async () => {
    const stub = stubFetch(() => { throw new Error('fetch must not be called while gated off') })
    try {
      const result = await pushDataValueSet({ ...PUSH, records: [RECORD], base_url: 'https://hmis.example', dry_run: false })
      assert.equal(result.outcome, 'refused')
      assert.match(result.error, /LINDELA_LITE_DHIS2_ENABLED/)
      assert.equal(stub.calls.length, 0)
    } finally {
      stub.restore()
    }
  })

  it('refuses a push in which every record was refused', async () => {
    await withEnv(ENABLED, async () => {
      const stub = stubFetch(() => { throw new Error('fetch must not be called when there is nothing to send') })
      try {
        const result = await pushDataValueSet({ ...PUSH, records: [{ ...RECORD, value: null }], base_url: 'https://hmis.example', dry_run: false })
        assert.equal(result.outcome, 'refused')
        assert.match(result.error, /push would write nothing/)
        assert.equal(result.dataValues, 0)
        assert.equal(result.refused, 1)
        assert.equal(stub.calls.length, 0)
      } finally {
        stub.restore()
      }
    })
  })

  it('reports a 200 with status ERROR as a rejected import, not a success', async () => {
    // DHIS2 answers 200 for a dataValueSet whose values were all rejected. The
    // HTTP status is not the outcome; `status` in the body is.
    await withEnv(ENABLED, async () => {
      const stub = stubFetch(() => new Response(JSON.stringify({
        status: 'ERROR',
        importCount: { imported: 0, updated: 0, ignored: 1 },
        conflicts: [{ object: 'DE-RAIN', value: 'org unit not found' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      try {
        const result = await pushDataValueSet({ ...PUSH, records: [RECORD], base_url: 'https://hmis.example', dry_run: false })
        assert.equal(result.status, 200)
        assert.equal(result.outcome, 'rejected')
        assert.equal(result.import_status, 'ERROR')
        assert.equal(result.imported, 0)
        assert.match(result.error, /rejected the import/)
        assert.equal(result.conflicts.length, 1)
      } finally {
        stub.restore()
      }
    })
  })

  it('reports a 200 with status OK as pushed, carrying the import counts', async () => {
    await withEnv(ENABLED, async () => {
      const stub = stubFetch((url, init) => {
        const body = JSON.parse(init.body)
        assert.equal(url, 'https://hmis.example/api/dataValueSets')
        assert.equal(body.dataValues[0].value, '42.5')
        return new Response(JSON.stringify({ status: 'OK', importCount: { imported: 1, updated: 0, ignored: 0 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      })
      try {
        const result = await pushDataValueSet({ ...PUSH, records: [RECORD], base_url: 'https://hmis.example', dry_run: false })
        assert.equal(result.outcome, 'pushed')
        assert.equal(result.imported, 1)
        assert.equal(result.dataValues, 1)
      } finally {
        stub.restore()
      }
    })
  })

  it('reports a non-JSON body as an error rather than reading a summary out of it', async () => {
    await withEnv(ENABLED, async () => {
      const stub = stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
      try {
        const result = await pushDataValueSet({ ...PUSH, records: [RECORD], base_url: 'https://hmis.example', dry_run: false })
        assert.equal(result.outcome, 'error')
        assert.equal(result.status, 502)
        assert.match(result.error, /not JSON/)
      } finally {
        stub.restore()
      }
    })
  })
})

describe('CAP-02 — the push is reachable, not merely defined', () => {
  it('serves POST /api/v1/export/dhis2 and defaults to a dry run', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const { createServer } = await import('../src/server.js')
    const { JsonStore } = await import('../src/store.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-d2push-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const listener = createServer({ store }).listen(0)
    const base = `http://127.0.0.1:${listener.address().port}`
    try {
      // A registered route that the dispatcher does not match is the gap
      // QUA-02 names; the only evidence is a request through the front door.
      const res = await fetch(`${base}/api/v1/export/dhis2`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          records: [{ id: 'r1', indicator: 'rainfall_mm', district: 'turkana', value: 42.5, observed_at: '2026-10-11T00:00:00Z' }],
          org_units: { turkana: 'OU-TURKANA' },
          data_elements: { rainfall_mm: 'DE-RAIN' },
        }),
      })
      assert.equal(res.status, 200, 'the route is not served')
      const body = await res.json()
      assert.equal(body.dry_run, true)
      assert.equal(body.dataValues, 1)
      assert.equal(body.data_value_set.dataValues[0].orgUnit, 'OU-TURKANA')
    } finally {
      await new Promise((resolve) => listener.close(resolve))
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

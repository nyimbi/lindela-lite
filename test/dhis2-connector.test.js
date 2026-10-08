#!/usr/bin/env node
/**
 * DHIS2 connector tests — no network, global fetch stubbed and restored.
 *
 * The behavioural pins, each mapping to an honesty constraint in the module:
 *  - gated off, it refuses in errors and returns nothing (and the message
 *    names base_url, which the ingest-run wiring test in lite.test.js greps);
 *  - an enrolled+present pair becomes ONE normalized attendance record with
 *    the quarter-end date derived from the period;
 *  - a mapping naming only one UID is a refused invention, recorded, and no
 *    attendance record exists;
 *  - a climate element maps to climate_observations with the mapping's
 *    indicator, unit and district;
 *  - a 401 and a malformed body are recorded as errors, not thrown.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { spec as dhis2Spec, dhis2Connector, periodToDate } from '../src/connectors/dhis2.js'
import { validateConnector } from '../src/connectors/spec.js'

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

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

const DATA_VALUES = {
  dataValues: [
    { dataElement: 'DE_ENROLLED', orgUnit: 'OU_SCHOOL1', period: '2026Q3', value: '400' },
    { dataElement: 'DE_PRESENT', orgUnit: 'OU_SCHOOL1', period: '2026Q3', value: '300' },
    { dataElement: 'DE_RAINFALL', orgUnit: 'OU_DIST1', period: '2026Q3', value: '182.5' },
  ],
}

describe('dhis2 connector', () => {
  it('spec validates and keeps its id', () => {
    assert.deepEqual(validateConnector(dhis2Spec), [])
    assert.equal(dhis2Connector.id, 'dhis2')
  })

  it('gated off: refuses in errors and returns empty collections', async () => {
    const stub = stubFetch(() => { throw new Error('fetch must not be called when gated off') })
    try {
      await withEnv({}, async () => {
        const out = await dhis2Connector.ingest({ base_url: 'https://hmis.example.org' })
        assert.deepEqual(out.climate_observations, [])
        assert.deepEqual(out.school_attendance_observations, [])
        assert.equal(out.errors.length, 1)
        assert.match(out.errors[0], /not enabled/)
        assert.match(out.errors[0], /base_url/)
      })
      await withEnv(ENABLED, async () => {
        const out = await dhis2Connector.ingest({})
        assert.match(out.errors[0], /not enabled/)
        assert.deepEqual(out.climate_observations, [])
      })
    } finally {
      stub.restore()
    }
  })

  it('maps an enrolled+present pair into one normalized attendance record with a derived quarter-end date', async () => {
    const stub = stubFetch(() => jsonResponse(DATA_VALUES))
    try {
      await withEnv(ENABLED, async () => {
        const out = await dhis2Connector.ingest({
          base_url: 'https://hmis.example.org/',
          period: '2026Q3',
          org_units: ['OU_SCHOOL1'],
          data_elements: ['DE_ENROLLED', 'DE_PRESENT', 'DE_RAINFALL'],
          mappings: {
            DE_ENROLLED: { kind: 'school_attendance', enrolled_from: 'DE_ENROLLED', present_from: 'DE_PRESENT', school_id: 'school_lodwar_01', school_name: 'Lodwar Primary', district: 'turkana' },
            DE_PRESENT: { kind: 'school_attendance', enrolled_from: 'DE_ENROLLED', present_from: 'DE_PRESENT', school_id: 'school_lodwar_01', school_name: 'Lodwar Primary', district: 'turkana' },
            DE_RAINFALL: { kind: 'climate', indicator: 'rainfall_mm', unit: 'mm', district: 'turkana' },
          },
        })
        assert.equal(out.school_attendance_observations.length, 1, JSON.stringify(out.errors))
        const record = out.school_attendance_observations[0]
        assert.equal(record.school_id, 'school_lodwar_01')
        assert.equal(record.district, 'turkana')
        assert.equal(record.date, '2026-09-30', 'quarter period anchors to the quarter last day')
        assert.equal(record.enrolled, 400)
        assert.equal(record.present, 300)
        assert.equal(record.absent, 100, 'absent derived as enrolled - present, the register arithmetic')
        assert.equal(record.attendance_rate, 75)
        assert.equal(record.source, 'dhis2')
        // Two mapping entries pointing at the same pair must not double-count:
        // the record id is stable, so the second write merges over the first.
        const outSingle = await dhis2Connector.ingest({
          base_url: 'https://hmis.example.org/',
          period: '2026Q3',
          mappings: {
            DE_ENROLLED: { kind: 'school_attendance', enrolled_from: 'DE_ENROLLED', present_from: 'DE_PRESENT', school_id: 'school_lodwar_01' },
          },
        })
        assert.equal(outSingle.school_attendance_observations.length, 1, JSON.stringify(outSingle.errors))
      })
    } finally {
      stub.restore()
    }
  })

  it('requests the dataValueSet with org units, elements, period and children=true', async () => {
    const stub = stubFetch(() => jsonResponse({ dataValues: [] }))
    try {
      await withEnv(ENABLED, async () => {
        await dhis2Connector.ingest({
          base_url: 'https://hmis.example.org',
          org_units: ['OU_A', 'OU_B'],
          data_elements: ['DE_X'],
          period: '2026Q3',
        })
        assert.equal(stub.calls.length, 1)
        const url = new URL(stub.calls[0].url)
        assert.equal(url.pathname, '/api/dataValueSets')
        assert.deepEqual(url.searchParams.getAll('orgUnit'), ['OU_A', 'OU_B'])
        assert.deepEqual(url.searchParams.getAll('dataElement'), ['DE_X'])
        assert.equal(url.searchParams.get('period'), '2026Q3')
        assert.equal(url.searchParams.get('children'), 'true')
      })
    } finally {
      stub.restore()
    }
  })

  it('refuses a single-element attendance mapping with an error and no record', async () => {
    const stub = stubFetch(() => jsonResponse({
      dataValues: [{ dataElement: 'DE_HEADCOUNT', orgUnit: 'OU_SCHOOL1', period: '2026Q3', value: '412' }],
    }))
    try {
      await withEnv(ENABLED, async () => {
        const out = await dhis2Connector.ingest({
          base_url: 'https://hmis.example.org',
          period: '2026Q3',
          mappings: {
            DE_HEADCOUNT: { kind: 'school_attendance', school_id: 'school_lodwar_01', district: 'turkana' },
          },
        })
        assert.equal(out.school_attendance_observations.length, 0)
        assert.ok(out.errors.some((e) => /enrolled_from/.test(e) && /present_from/.test(e) && /refus/.test(e)),
          `expected the refusal to name both UIDs and the refusal, got: ${out.errors.join('; ')}`)
      })
    } finally {
      stub.restore()
    }
  })

  it('maps a climate element to climate_observations with indicator, unit and district', async () => {
    const stub = stubFetch(() => jsonResponse({
      dataValues: [{ dataElement: 'DE_RAINFALL', orgUnit: 'OU_DIST1', period: '202610', value: '88.4' }],
    }))
    try {
      await withEnv(ENABLED, async () => {
        const out = await dhis2Connector.ingest({
          base_url: 'https://hmis.example.org',
          period: '202610',
          mappings: { DE_RAINFALL: { kind: 'climate', indicator: 'rainfall_mm', unit: 'mm', district: 'turkana' } },
        })
        assert.equal(out.school_attendance_observations.length, 0)
        assert.equal(out.climate_observations.length, 1)
        const record = out.climate_observations[0]
        assert.equal(record.source, 'dhis2')
        assert.equal(record.indicator, 'rainfall_mm')
        assert.equal(record.value, 88.4)
        assert.equal(record.unit, 'mm')
        assert.equal(record.district, 'turkana')
        assert.equal(record.observed_at, '2026-10-01', 'monthly period anchors to the month first day')
        assert.equal(record.latitude, null)
        assert.equal(record.longitude, null)
      })
    } finally {
      stub.restore()
    }
  })

  it('uses ApiToken auth when api_token is set and Basic otherwise', async () => {
    const stub = stubFetch(() => jsonResponse({ dataValues: [] }))
    try {
      await withEnv(ENABLED, async () => {
        await dhis2Connector.ingest({ base_url: 'https://hmis.example.org', api_token: 'token123' })
        assert.equal(stub.calls[0].init.headers.authorization, 'ApiToken token123')
        await dhis2Connector.ingest({ base_url: 'https://hmis.example.org', username: 'admin', password: 's3cret' })
        assert.equal(stub.calls[1].init.headers.authorization, `Basic ${Buffer.from('admin:s3cret').toString('base64')}`)
        await dhis2Connector.ingest({ base_url: 'https://hmis.example.org' })
        assert.equal(stub.calls[2].init.headers.authorization, undefined, 'no credentials: no header, the 401 is recorded')
      })
    } finally {
      stub.restore()
    }
  })

  it('records HTTP 401 as an error and returns no records', async () => {
    const stub = stubFetch(() => jsonResponse({ message: 'Unauthorized' }, { status: 401 }))
    try {
      await withEnv(ENABLED, async () => {
        const out = await dhis2Connector.ingest({ base_url: 'https://hmis.example.org' })
        assert.deepEqual(out.climate_observations, [])
        assert.deepEqual(out.school_attendance_observations, [])
        assert.ok(out.errors.some((e) => /401/.test(e)), `expected the 401 to be recorded, got: ${out.errors.join('; ')}`)
      })
    } finally {
      stub.restore()
    }
  })

  it('records malformed JSON as an error', async () => {
    const stub = stubFetch(() => jsonResponse('<html>Gateway timeout</html>'))
    try {
      await withEnv(ENABLED, async () => {
        const out = await dhis2Connector.ingest({ base_url: 'https://hmis.example.org' })
        assert.ok(out.errors.some((e) => /not valid JSON/.test(e)), `expected the parse failure to be recorded, got: ${out.errors.join('; ')}`)
      })
    } finally {
      stub.restore()
    }
  })

  it('refuses yearly attendance periods as too coarse and contradicting pairs as errors', async () => {
    const stub = stubFetch(() => jsonResponse({
      dataValues: [
        { dataElement: 'DE_ENROLLED', orgUnit: 'OU_SCHOOL1', period: '2026', value: '400' },
        { dataElement: 'DE_PRESENT', orgUnit: 'OU_SCHOOL1', period: '2026', value: '300' },
        { dataElement: 'DE_ENROLLED', orgUnit: 'OU_SCHOOL2', period: '2026Q3', value: '100' },
        { dataElement: 'DE_PRESENT', orgUnit: 'OU_SCHOOL2', period: '2026Q3', value: '130' },
      ],
    }))
    try {
      await withEnv(ENABLED, async () => {
        const out = await dhis2Connector.ingest({
          base_url: 'https://hmis.example.org',
          mappings: {
            pair: { kind: 'school_attendance', enrolled_from: 'DE_ENROLLED', present_from: 'DE_PRESENT', school_id: 'school_x' },
          },
        })
        assert.equal(out.school_attendance_observations.length, 0)
        assert.ok(out.errors.some((e) => /granularity too coarse/.test(e)), `yearly refusal expected, got: ${out.errors.join('; ')}`)
        assert.ok(out.errors.some((e) => /contradictory/.test(e)), 'present > enrolled must be refused, not clamped')
      })
    } finally {
      stub.restore()
    }
  })

  it('periodToDate derives the documented anchors', () => {
    assert.equal(periodToDate('20261008'), '2026-10-08')
    assert.equal(periodToDate('2026Q3'), '2026-09-30')
    assert.equal(periodToDate('202610'), '2026-10-01')
    assert.equal(periodToDate('2026'), null)
    assert.equal(periodToDate('nonsense'), null)
  })
})

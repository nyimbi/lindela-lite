#!/usr/bin/env node
/**
 * KoboToolbox connector tests — no network, global fetch stubbed and restored.
 *
 * Pins:
 *  - gated off (env, or any of base_url/asset_uid/api_token missing) refuses
 *    in errors and returns nothing;
 *  - each submission becomes a field_report keyed by its Kobo _id, with the
 *    raw submission as body and reporter_urn_hash null (a Kobo account name
 *    is not a hashable URN — null is the honest value);
 *  - a school_attendance field_mapping normalizes submissions into school
 *    attendance records, using a supplied absent field when the form has one;
 *  - a submission missing required attendance fields lands in errors and
 *    yields no attendance record, while its field_report still returns.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { spec as koboSpec, koboConnector } from '../src/connectors/kobo.js'
import { validateConnector } from '../src/connectors/spec.js'

const ENABLED = { LINDELA_LITE_KOBO_ENABLED: 'on' }
const REQUEST = {
  base_url: 'https://kf.kobotoolbox.org',
  asset_uid: 'aBcDeFgHijKlMnOp',
  api_token: 'kobo-token-123',
}

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

const SUBMISSIONS = {
  results: [
    {
      _id: 48151,
      _submission_time: '2026-10-07T09:14:00Z',
      district: 'turkana',
      school_id: 'school_lodwar_01',
      report_date: '2026-10-07',
      enrolled: 400,
      present: 310,
      absent: 65,
      note: 'Pipe burst near the gate, classes moved to the shade.',
    },
    {
      _id: 48152,
      _submission_time: '2026-10-07T10:02:00Z',
      district: 'turkana',
      school_id: 'school_kakuma_02',
      report_date: '2026-10-07',
      enrolled: 250,
      present: 240,
      // no absent: the derived path (enrolled - present) is exercised here
    },
  ],
}

const ATTENDANCE_MAPPING = {
  attendance: {
    kind: 'school_attendance',
    school_id: 'school_id',
    school_name: null,
    date: 'report_date',
    enrolled: 'enrolled',
    present: 'present',
    absent: 'absent',
    district: 'district',
  },
}

describe('kobo connector', () => {
  it('spec validates and keeps its id', () => {
    assert.deepEqual(validateConnector(koboSpec), [])
    assert.equal(koboConnector.id, 'kobo')
  })

  it('gated off: refuses in errors and returns nothing', async () => {
    const stub = stubFetch(() => { throw new Error('fetch must not be called when gated off') })
    try {
      await withEnv({}, async () => {
        const out = await koboConnector.ingest(REQUEST)
        assert.deepEqual(out.field_reports, [])
        assert.deepEqual(out.school_attendance_observations, [])
        assert.match(out.errors[0], /not enabled/)
        assert.match(out.errors[0], /LINDELA_LITE_KOBO_ENABLED/)
      })
      await withEnv(ENABLED, async () => {
        const out = await koboConnector.ingest({ base_url: 'https://kf.kobotoolbox.org', asset_uid: 'abc' })
        assert.match(out.errors[0], /api_token/)
        assert.deepEqual(out.field_reports, [])
      })
    } finally {
      stub.restore()
    }
  })

  it('maps submissions to field_reports keyed by _id with the raw submission as body', async () => {
    const stub = stubFetch(() => jsonResponse(SUBMISSIONS))
    try {
      await withEnv(ENABLED, async () => {
        const out = await koboConnector.ingest(REQUEST)
        assert.equal(out.field_reports.length, 2, JSON.stringify(out.errors))
        const first = out.field_reports[0]
        assert.equal(first.external_id, '48151')
        assert.equal(first.form_id, 'aBcDeFgHijKlMnOp')
        assert.equal(first.submitted_at, '2026-10-07T09:14:00Z')
        assert.equal(first.district, 'turkana')
        assert.equal(first.source, 'kobotoolbox')
        assert.equal(first.reporter_urn_hash, null)
        const body = JSON.parse(first.body)
        assert.equal(body.note, 'Pipe burst near the gate, classes moved to the shade.')
        assert.equal(out.field_reports[1].external_id, '48152')
        assert.equal(out.errors.length, 0, JSON.stringify(out.errors))
      })
    } finally {
      stub.restore()
    }
  })

  it('requests the asset data endpoint with Token auth', async () => {
    const stub = stubFetch(() => jsonResponse({ results: [] }))
    try {
      await withEnv(ENABLED, async () => {
        const out = await koboConnector.ingest(REQUEST)
        assert.equal(out.errors.length, 0)
        assert.equal(stub.calls.length, 1)
        assert.equal(stub.calls[0].url, 'https://kf.kobotoolbox.org/api/v2/assets/aBcDeFgHijKlMnOp/data.json')
        assert.equal(stub.calls[0].init.headers.authorization, 'Token kobo-token-123')
      })
    } finally {
      stub.restore()
    }
  })

  it('normalizes attendance-mapped submissions, preferring a supplied absent field', async () => {
    const stub = stubFetch(() => jsonResponse(SUBMISSIONS))
    try {
      await withEnv(ENABLED, async () => {
        const out = await koboConnector.ingest({ ...REQUEST, field_mapping: ATTENDANCE_MAPPING })
        assert.equal(out.school_attendance_observations.length, 2, JSON.stringify(out.errors))
        const [first, second] = out.school_attendance_observations
        assert.equal(first.school_id, 'school_lodwar_01')
        assert.equal(first.date, '2026-10-07')
        assert.equal(first.enrolled, 400)
        assert.equal(first.present, 310)
        assert.equal(first.absent, 65, 'the form supplied absent; it is used as supplied, not derived')
        assert.equal(first.attendance_rate, 77.5)
        assert.equal(first.source, 'kobotoolbox')
        assert.equal(second.school_id, 'school_kakuma_02')
        assert.equal(second.absent, 10, 'absent derived as enrolled - present when the form carries no absent field')
      })
    } finally {
      stub.restore()
    }
  })

  it('records a submission missing required attendance fields in errors and still returns its field_report', async () => {
    const stub = stubFetch(() => jsonResponse({
      results: [
        { _id: 9, _submission_time: '2026-10-07T11:00:00Z', school_id: 'school_x', enrolled: 100 },
      ],
    }))
    try {
      await withEnv(ENABLED, async () => {
        const out = await koboConnector.ingest({ ...REQUEST, field_mapping: ATTENDANCE_MAPPING })
        assert.equal(out.field_reports.length, 1, 'the field_report is a separate claim and still returns')
        assert.equal(out.school_attendance_observations.length, 0)
        assert.ok(
          out.errors.some((e) => /missing required attendance fields/.test(e) && /date/.test(e) && /present/.test(e)),
          `expected the missing-fields refusal, got: ${out.errors.join('; ')}`,
        )
      })
    } finally {
      stub.restore()
    }
  })

  it('records HTTP errors and malformed JSON honestly', async () => {
    const failing = stubFetch(() => jsonResponse({ detail: 'Invalid token' }, { status: 403 }))
    try {
      await withEnv(ENABLED, async () => {
        const out = await koboConnector.ingest(REQUEST)
        assert.ok(out.errors.some((e) => /403/.test(e)), `expected the 403 to be recorded, got: ${out.errors.join('; ')}`)
        assert.deepEqual(out.field_reports, [])
      })
    } finally {
      failing.restore()
    }
    const malformed = stubFetch(() => jsonResponse('<html>502</html>'))
    try {
      await withEnv(ENABLED, async () => {
        const out = await koboConnector.ingest(REQUEST)
        assert.ok(out.errors.some((e) => /not valid JSON/.test(e)), `expected the parse failure, got: ${out.errors.join('; ')}`)
      })
    } finally {
      malformed.restore()
    }
  })
})

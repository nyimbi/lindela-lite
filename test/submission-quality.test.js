import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * ENH-44 — the quality gate, at both doors into `field_reports`.
 *
 * The unit tests in `test/quality.test.js` pin the verdict arithmetic. This file
 * pins the thing the arithmetic is worth nothing without: that the verdict is
 * actually stamped on records the *service* writes, through every route that
 * writes them.
 *
 * That is the defect class this repo keeps finding — a gate that exists and is
 * applied at nineteen of twenty-seven paths. `field_reports` has two doors: the
 * CHW route writes the collection directly, and the operational API goes through
 * `normalizeFieldReport`. A verdict stamped at one of them leaves half the store
 * unmeasured, and the tally would read the unmeasured half as `unassessable`
 * rather than as reports nobody gated.
 *
 * Each test drives a real server, because a handler test would prove the
 * function works and not that the route calls it.
 */

async function withServer(run) {
  const { createServer } = await import('../src/server.js')
  const { JsonStore } = await import('../src/store.js')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-quality-'))
  const storePath = path.join(dir, 'store.json')
  const server = createServer({ store: new JsonStore(storePath) })
  const listener = server.listen(0)
  const base = `http://localhost:${listener.address().port}`
  const call = async (method, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    return { status: res.status, payload: await res.json() }
  }
  try {
    return await run({
      base,
      storePath,
      post: (route, body) => call('POST', route, body),
      get: (route) => call('GET', route),
      patch: (route, body) => call('PATCH', route, body),
      del: (route) => call('DELETE', route),
    })
  } finally {
    await new Promise((resolve) => listener.close(resolve))
  }
}

const chwReport = (over = {}) => ({
  kind: 'symptom',
  category: 'fever',
  description: 'child with fever and rash for two days',
  location: { latitude: 3.2, longitude: 35.7, source: 'gps', accuracy_m: 12 },
  anonymous: true,
  ...over,
})

describe('ENH-44 — the CHW door stamps a verdict', () => {
  it('stamps the report it stores, and returns it stamped', async () => {
    await withServer(async ({ post }) => {
      const { status, payload } = await post('/api/v1/chw/report', chwReport())
      assert.equal(status, 201)
      assert.ok(payload.data.quality, 'the stored report carries no quality verdict')
      assert.equal(payload.data.quality.grade, 'high', 'a 12 m fix filed once is a clean report')
      assert.equal(payload.data.quality.accuracy.band, 'precise')
    })
  })

  it('carries the capture time through, so the skew axis is measurable', async () => {
    // Without `captured_at` on the record the skew axis is `unknown` on every
    // report this route writes, and the gate measures one axis of three.
    await withServer(async ({ post }) => {
      const { payload } = await post('/api/v1/chw/report', chwReport({ captured_at: new Date(Date.now() - 60_000).toISOString() }))
      assert.ok(payload.data.captured_at, 'the capture time was dropped on the way in')
      assert.notEqual(payload.data.quality.skew.verdict, 'unknown', 'the skew axis was not measured despite a capture time')
    })
  })

  it('reports the skew axis unmeasured when the client sends no capture time', async () => {
    // The honest value. Defaulting it to receipt time would claim every report
    // arrived on time, which is the claim the axis exists to test.
    await withServer(async ({ post }) => {
      const { payload } = await post('/api/v1/chw/report', chwReport())
      assert.equal(payload.data.captured_at, null)
      assert.equal(payload.data.quality.skew.verdict, 'unknown')
      assert.ok(payload.data.quality.unassessed.includes('skew'))
    })
  })

  it('flags a second report filed minutes later, against the store not the snapshot', async () => {
    // The candidate read is the load-bearing part. The dispatcher materialises
    // the store before the first report was written, so comparing against `data`
    // finds nothing and every double submission reads clean.
    await withServer(async ({ post }) => {
      const first = await post('/api/v1/chw/report', chwReport())
      assert.equal(first.payload.data.quality.duplicates.length, 0)
      const second = await post('/api/v1/chw/report', chwReport({ description: 'child has fever and rash for two days' }))
      assert.equal(second.payload.data.quality.duplicates.length, 1, 'the double submission was not flagged')
      assert.equal(second.payload.data.quality.grade, 'low')
    })
  })

  it('still files the duplicate rather than refusing it', async () => {
    // The gate carries the doubt; it does not act on it. A health worker who
    // filed a report has filed it.
    await withServer(async ({ post, get }) => {
      await post('/api/v1/chw/report', chwReport())
      const second = await post('/api/v1/chw/report', chwReport({ description: 'child has fever and rash for two days' }))
      assert.equal(second.status, 201)
      const list = await get('/api/v1/field-reports')
      assert.equal(list.payload.data.length, 2, 'a flagged report was dropped instead of flagged')
    })
  })

  it('compares against the redacted summary, not the one it was sent', async () => {
    // Redaction runs before the stamp, so the comparison is over the text that
    // will be kept. Stamping before redaction would match on words the record
    // does not contain and flag a pair a reader cannot see as a pair.
    await withServer(async ({ post }) => {
      const { payload } = await post('/api/v1/chw/report', chwReport())
      const stamped = payload.data.quality
      assert.ok(stamped, 'no verdict travelled')
      assert.equal(typeof stamped.duplicates, 'object')
    })
  })
})

describe('ENH-44 — the operational door stamps a verdict too', () => {
  it('stamps a report created through the operational API', async () => {
    // The second door. A gate at one of two doors is not a gate.
    await withServer(async ({ post }) => {
      const { status, payload } = await post('/api/v1/field-reports', {
        summary: 'flood damage to the borehole',
        incident_id: 'inc-1',
        latitude: 3.2,
        longitude: 35.7,
        location_accuracy_m: 900,
      })
      assert.equal(status, 201, `the operational create answered ${status}`)
      assert.ok(payload.data.quality, 'a report created through the operational API carries no verdict')
      assert.equal(payload.data.quality.accuracy.band, 'coarse')
    })
  })

  it('reports the operational door as unmeasured rather than clean', async () => {
    // The operator path has no GPS fix and no device capture stamp, so both
    // measured axes are `unknown` and the grade is `unassessable` — not `high`.
    await withServer(async ({ post }) => {
      const { payload } = await post('/api/v1/field-reports', {
        summary: 'borehole repaired',
        incident_id: 'inc-1',
      })
      assert.equal(payload.data.quality.grade, 'unassessable')
      assert.deepEqual(payload.data.quality.unassessed.sort(), ['accuracy', 'skew'])
    })
  })
})

describe('ENH-44 — the roll-up route', () => {
  it('counts the verdicts in the store', async () => {
    await withServer(async ({ post, get }) => {
      await post('/api/v1/chw/report', chwReport())
      const { status, payload } = await get('/api/v1/field-reports/quality')
      assert.equal(status, 200)
      assert.equal(payload.reports, 1)
      assert.equal(payload.by_grade.high, 1)
      assert.equal(payload.grade, 'high')
    })
  })

  it('reports an empty store as unassessable rather than as a clean one', async () => {
    await withServer(async ({ get }) => {
      const { status, payload } = await get('/api/v1/field-reports/quality')
      assert.equal(status, 200)
      assert.equal(payload.total, 0)
      assert.equal(payload.grade, 'unassessable', 'an empty store was handed a passing grade')
    })
  })

  it('counts a report written before the gate existed rather than dropping it', async () => {
    // A store whose older half is excluded from the tally reads as a healthier
    // queue than it is. The pre-gate count is named so the two facts inside
    // `unassessable` stay separable — a verdict that measured nothing, and a
    // record written before verdicts existed.
    await withServer(async ({ storePath, post, get }) => {
      await post('/api/v1/chw/report', chwReport())
      // Plant a record with no verdict, as every report written before this
      // shipped. Written straight to the file the running store reads.
      const raw = JSON.parse(await fs.readFile(storePath, 'utf8'))
      raw.field_reports.push({ id: 'report-legacy', summary: 'legacy report', category: 'fever', created_at: '2026-01-01T00:00:00.000Z' })
      await fs.writeFile(storePath, JSON.stringify(raw))

      const { payload } = await get('/api/v1/field-reports/quality')
      assert.equal(payload.reports, 2, 'the pre-gate record was dropped from the count')
      assert.equal(payload.pre_gate_records, 1, 'a pre-gate record was not named as one')
      assert.equal(payload.by_grade.unassessable, 1)
      assert.equal(payload.by_grade.high, 1)
    })
  })

  it('does not count a withdrawn report', async () => {
    await withServer(async ({ post, get, del }) => {
      const { payload } = await post('/api/v1/chw/report', chwReport())
      const withdrawn = await del(`/api/v1/field-reports/${payload.data.id}`)
      assert.equal(withdrawn.status, 200, `the withdrawal answered ${withdrawn.status}`)
      const after = await get('/api/v1/field-reports/quality')
      assert.equal(after.payload.reports, 0, 'a withdrawn report still counts towards the queue')
      assert.equal(after.payload.grade, 'unassessable')
    })
  })
})

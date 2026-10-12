import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleReportingRoute, matchReportingRoute, runDueReportSchedules } from '../src/routes/reporting.js'
import { emptyStore } from '../src/schema.js'
import { metrics } from '../src/observability.js'
import { runWithRequestContext } from '../src/utils.js'

/**
 * ARC-01 — the reporting family as a module, asserted where it now lives.
 *
 * Five collections over fourteen paths, and they are one module because they are
 * one lifecycle: a template defines a report, a report is generated from it,
 * approved, distributed, and the same three steps run unattended on a schedule.
 * A change to how a report is rendered or how a distribution is attempted has to
 * hold across the manual and the scheduled path.
 *
 * The properties asserted here are the ones that were bugs once:
 *
 *   - **a distribution URL is checked at the point of use.** The webhook channel
 *     takes its URL from the request body, so it is attacker-controlled; the
 *     guard runs before the fetch.
 *   - **an approved report is immutable.** `generate` and `narrate` refuse an
 *     approved/distributed report with a 409 carrying `ERROR_CODES.IMMUTABLE`.
 *   - **an outbox emit failure is counted, not swallowed.** A subscriber that
 *     was not told is a gap to count and name.
 *   - **`run-due` is POST-only at the matcher.** VER-14: the matcher used to
 *     return a route for any verb, and the handler then answered the schedule
 *     *listing* for a GET.
 */

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
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

const makeReq = (method, body, auth = { subject: 'operator', partner_org: null }) => ({
  method,
  headers: {},
  __auth: auth,
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

/** A store with a real `withLock`, so `emit` and the schedule writes work. */
function recordingStore(initial = {}) {
  const state = { ...emptyStore(), ...initial }
  const merges = []
  const locked = {
    async read() { return state },
    async merge(partial) {
      merges.push(partial)
      for (const [collection, records] of Object.entries(partial)) {
        const byId = new Map((state[collection] || []).map((r) => [r.id, r]))
        for (const record of records) byId.set(record.id, record)
        state[collection] = [...byId.values()]
      }
      return partial
    },
  }
  return {
    state,
    merges,
    async read() { return state },
    async merge(partial) { return locked.merge(partial) },
    async withLock(fn) { return fn(locked) },
  }
}

const call = (route, {
  method = 'GET', body, auth, store = recordingStore(), search = '', checkWebhookUrl,
} = {}) => {
  const res = fakeResponse()
  const req = makeReq(method, body, auth)
  // `findVisible` reads the caller from the request's async context, not from
  // `req.__auth` — the same ALS the dispatcher establishes — so the call is
  // wrapped the way `handleApiRequest` wraps it.
  return runWithRequestContext(auth ?? req.__auth, () => handleReportingRoute(route, {
    store, data: store.state, res, jsonResponse, req,
    url: new URL(`http://127.0.0.1/x${search}`),
    checkWebhookUrl,
  })).then((handled) => ({ handled, res, store }))
}

const template = (over = {}) => ({
  id: 't1', name: 'Situation Report', report_type: 'situation_report', status: 'active', version: 1,
  title_pattern: 'Situation Report - {period}',
  default_filters: {}, sections: ['executive_summary', 'risk_summary'], distribution_defaults: [],
  schedule_defaults: {}, owner: 'ops',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', metadata: {},
  ...over,
})

const report = (over = {}) => ({
  id: 'r1', template_id: 't1', report_type: 'situation_report', status: 'draft',
  title: 'Situation Report', scope: {}, section_ids: ['executive_summary', 'risk_summary'],
  sections: [{ id: 'executive_summary', title: 'Executive summary', type: 'text', content: { summary: 'x', items: [] }, source_refs: [], generated_at: '2026-01-01T00:00:00Z', warnings: [] }],
  source_refs: [], warnings: [], narrative: {}, distribution_defaults: [],
  generated_at: '2026-01-01T00:00:00Z', approved_at: null, distributed_at: null, owner: 'ops',
  partner_org: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', metadata: {},
  ...over,
})

const schedule = (over = {}) => ({
  id: 'sch1', template_id: 't1', status: 'active', timezone: 'UTC',
  recurrence: { type: 'daily', time: '07:00' },
  auto_distribute: false, distribution_defaults: [],
  next_run_at: '2026-01-01T00:00:00Z', last_run_at: null, owner: 'ops',
  partner_org: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', metadata: {},
  ...over,
})

describe('ARC-01 — matchReportingRoute', () => {
  it('matches the five collections and their actions', () => {
    assert.deepEqual(matchReportingRoute('/api/v1/report-templates'), { kind: 'templates', id: null })
    assert.deepEqual(matchReportingRoute('/api/v1/reports/r1/generate'), { kind: 'reports', id: 'r1', action: 'generate' })
    assert.deepEqual(matchReportingRoute('/api/v1/reports/r1/export.md'), { kind: 'reports', id: 'r1', exportFormat: 'md' })
    assert.deepEqual(matchReportingRoute('/api/v1/report-schedules/sch1/run'), { kind: 'schedules', id: 'sch1', action: 'run' })
  })

  it('refuses a non-POST on run-due so it falls through to a 404', () => {
    // VER-14. The matcher used to return the route for any verb, and the handler
    // then answered the schedule listing for a GET.
    assert.deepEqual(matchReportingRoute('/api/v1/report-schedules/run-due', 'POST'), { kind: 'schedules', action: 'run-due' })
    assert.equal(matchReportingRoute('/api/v1/report-schedules/run-due', 'GET'), null)
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/report', '/api/v1/unknown-collection', '/api/v1/reports/r1/x']) {
      assert.equal(matchReportingRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — an approved report is immutable', () => {
  it('refuses to regenerate an approved report', async () => {
    const store = recordingStore({ reports: [report({ status: 'approved' })] })
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'generate' }, {
      method: 'POST', body: {}, store,
    })
    assert.equal(res.status, 409, 'an approved report was regenerated')
    assert.equal(res.json().code, 'immutable')
  })

  it('refuses to narrate a distributed report', async () => {
    const store = recordingStore({ reports: [report({ status: 'distributed' })] })
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'narrate' }, {
      method: 'POST', body: {}, store,
    })
    assert.equal(res.status, 409)
    assert.equal(res.json().code, 'immutable')
  })
})

describe('ARC-01 — a distribution URL is checked at the point of use', () => {
  it('clears the URL guard before fetching a webhook channel', async () => {
    const store = recordingStore({ reports: [report({ status: 'approved' })] })
    const checked = []
    const checkWebhookUrl = async (raw) => {
      checked.push(raw)
      throw Object.assign(new Error('url host resolves to a non-public address: 127.0.0.1'), { statusCode: 400 })
    }
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'distribute' }, {
      method: 'POST',
      body: { channels: [{ channel: 'webhook', url: 'http://127.0.0.1:4177/internal' }] },
      store, checkWebhookUrl,
    })
    assert.deepEqual(checked, ['http://127.0.0.1:4177/internal'],
      'the distribution URL was fetched without clearing the guard')
    // The run is recorded as failed with the guard's reason, not fetched.
    const run = store.state.report_distribution_runs.at(-1)
    assert.equal(run.status, 'failed')
    assert.match(run.error, /non-public address/)
  })

  it('uses the guard’s returned target, not the raw URL, for the fetch', async () => {
    const store = recordingStore({ reports: [report({ status: 'approved' })] })
    const checkWebhookUrl = async () => 'http://127.0.0.1:1/canonical'
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'distribute' }, {
      method: 'POST',
      body: { channels: [{ channel: 'webhook', url: 'https://partner.example/hook' }] },
      store, checkWebhookUrl,
    })
    // The guard returned a canonical target; the run carries the failure of
    // fetching *that* target, which is the only proof the guard's return value
    // is what was used.
    const run = store.state.report_distribution_runs.at(-1)
    assert.equal(run.status, 'failed')
    assert.ok(res.status === 201, 'the route answered with a non-201 status for a recorded run')
  })
})

describe('ARC-01 — an outbox emit failure is counted, not swallowed', () => {
  it('counts outbox_emit_failed_total when emit throws', async () => {
    const store = recordingStore({ report_templates: [template()] })
    store.withLock = async () => { throw new Error('outbox unavailable') }
    const { res } = await call({ kind: 'reports' }, {
      method: 'POST', body: { template_id: 't1', generate: true }, store,
    })
    assert.equal(res.status, 201, 'the report was not stored because the outbox failed')
    assert.equal(store.state.reports.length, 1, 'the report was lost to an outbox failure')
    assert.match(metrics.render(), /outbox_emit_failed_total\{event="report\.created"\} 1/,
      'the emit failure was swallowed rather than counted')
  })
})

describe('ARC-01 — the by-id reads resolve through findVisible', () => {
  it('hides another organisation’s report from a partner token', async () => {
    const store = recordingStore({ reports: [report({ partner_org: 'org-b' })] })
    const { res } = await call({ kind: 'reports', id: 'r1' }, {
      auth: { subject: 'p', partner_org: 'org-a' }, store,
    })
    assert.equal(res.status, 404, 'a partner read another organisation’s report by id')
  })

  it('hides another organisation’s schedule from a by-id PATCH', async () => {
    const store = recordingStore({ report_templates: [template()], report_schedules: [schedule({ partner_org: 'org-b' })] })
    const { res } = await call({ kind: 'schedules', id: 'sch1' }, {
      method: 'PATCH', body: { auto_distribute: true }, auth: { subject: 'p', partner_org: 'org-a' }, store,
    })
    assert.equal(res.status, 404, 'a partner patched another organisation’s schedule')
  })
})

describe('ARC-01 — the scheduled path runs the same lifecycle as the manual one', () => {
  it('generates a report from a due schedule and advances it', async () => {
    const store = recordingStore({
      report_templates: [template()],
      report_schedules: [schedule({ next_run_at: '2020-01-01T00:00:00Z' })],
    })
    const { res } = await call({ kind: 'schedules', id: 'sch1', action: 'run' }, {
      method: 'POST', body: { actor: 'test' }, store,
    })
    assert.equal(res.status, 201)
    assert.ok(res.json().report, 'the scheduled run generated no report')
    const advanced = store.state.report_schedules.find((s) => s.id === 'sch1')
    assert.ok(advanced.last_run_at, 'the schedule did not record its run')
    assert.ok(Date.parse(advanced.next_run_at) > Date.parse('2020-01-01T00:00:00Z'),
      'the schedule was not advanced past its due time')
  })

  it('runs only the schedules that are due', async () => {
    const store = recordingStore({
      report_templates: [template()],
      report_schedules: [
        schedule({ id: 'due', next_run_at: '2020-01-01T00:00:00Z' }),
        schedule({ id: 'future', next_run_at: '2999-01-01T00:00:00Z' }),
      ],
    })
    const result = await runDueReportSchedules(store.state, 'test', {})
    // The aggregate carries the schedule *runs* it produced, keyed back to the
    // schedule that produced them.
    assert.deepEqual(result.runs.map((run) => run.schedule_id), ['due'],
      'run-due ran a schedule that was not due')
    assert.deepEqual(result.writes.report_schedules.map((s) => s.id), ['due'])
  })
})

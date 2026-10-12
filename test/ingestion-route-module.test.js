import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { handleIngestionRoute, matchIngestionRoute } from '../src/routes/ingestion.js'
import { emptyStore } from '../src/schema.js'
import { JsonStore } from '../src/store.js'
import { runWithRequestContext } from '../src/utils.js'

/**
 * ARC-01 — the ingestion family as a module, asserted where it now lives.
 *
 * Nine routes over six paths, and they are one module because they are the
 * platform's clock: this is the only family whose writes *produce* the data
 * every other family reads. The end-to-end wiring is covered through the server
 * by `test/lite.test.js`; what this asserts is what makes the family one:
 *
 *   - **a run and the schedule it advanced are written together.** `run-one`
 *     runs the source, then writes the schedule's new `last_run_at`/`next_run_at`
 *     in the same merge as the run's own log. Advancing one without the other is
 *     a schedule that re-runs forever or one that never runs again.
 *   - **`run-due` closes the loop**: it reads sources, refreshes analytics, and
 *     asks whether anything crossed an alert threshold — evaluating against
 *     `store.read()` rather than the request's stale `data`, because ingestion
 *     and `refreshAnalytics` have both written since the snapshot was taken.
 *   - **a schedule resolves through `findVisible`.** VUL-03 lived in the by-id
 *     branches: a partner token could read another organisation's schedule by
 *     guessing an id it saw in a listing.
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

const makeReq = (method, body, auth = { subject: 'ops', partner_org: null }) => ({
  method,
  headers: {},
  __auth: auth,
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

/** A store whose merge batches are recorded, so "one write" is assertable. */
function recordingStore(initial = {}) {
  const state = { ...emptyStore(), ...initial }
  const merges = []
  return {
    state,
    merges,
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
    async write(next) { Object.assign(state, next); return next },
    async withLock(fn) { return fn(this) },
  }
}

/**
 * A real `JsonStore` on a scratch file. The `run-due` and `run-one` routes call
 * `refreshAnalytics`, which needs the store's own adapter surface
 * (`replaceAnalytics`, `replaceCollection`, the derived cache) — a merge-only
 * stub is not a store those routes can run against, so the tests that reach the
 * refresh use the real one. No mocks: this is the production store.
 */
async function scratchStore(initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-ing-route-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await store.write({ ...emptyStore(), ...initial })
  return store
}

/**
 * The alert evaluation the dispatcher injects. It records the snapshot it was
 * handed, so a test can assert it was the store's live state rather than the
 * request's stale `data`.
 */
function alertRecorder() {
  const seen = []
  return {
    seen,
    async evaluateAndPersistAlerts(store, snapshot) {
      seen.push(snapshot)
      return { raised: [{ id: 'ae1' }], updated: [] }
    },
  }
}

const call = async (route, {
  method = 'GET', body, auth, store, alerts = alertRecorder(), search = '',
} = {}) => {
  const backing = store || recordingStore()
  // The dispatcher passes the snapshot it read before the handler ran. For a
  // real store that is `read()`; the recording stub holds its own state.
  const data = backing.state || await backing.read()
  const res = fakeResponse()
  const req = makeReq(method, body, auth)
  const handled = await runWithRequestContext(auth ?? req.__auth, () => handleIngestionRoute(route, {
    store: backing, data, res, jsonResponse, req,
    url: new URL(`http://127.0.0.1/x${search}`),
    evaluateAndPersistAlerts: alerts.evaluateAndPersistAlerts,
  }))
  return { handled, res, store: backing, data, alerts }
}

/**
 * Record the merge batches a real store is handed, delegating to the store
 * itself. A spy on the production object, not a stand-in for it.
 */
function observeMerges(store) {
  const merges = []
  const original = store.merge.bind(store)
  store.merge = (partial) => { merges.push(partial); return original(partial) }
  return merges
}

/** A `conflict_csv` schedule whose default options carry a one-row CSV. */
const schedule = (over = {}) => ({
  id: 's1',
  name: 'conflict_csv regular ingestion',
  source: 'conflict_csv',
  status: 'active',
  interval_minutes: 60,
  timeout_ms: 5000,
  retries: 0,
  stale_after_minutes: null,
  next_run_at: '2026-01-01T00:00:00.000Z',
  last_run_at: null,
  default_options: {
    conflict_csv: 'event_date,event_type,latitude,longitude,country,fatalities,title\n2026-01-02,scheduled_ingest,3.12,35.62,KE,0,Scheduled ingestion event\n',
  },
  owner: 'ops',
  partner_org: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  metadata: {},
  ...over,
})

describe('ARC-01 — matchIngestionRoute', () => {
  it('matches the seven paths', () => {
    assert.deepEqual(matchIngestionRoute('/api/v1/ingest/status'), { kind: 'status' })
    assert.deepEqual(matchIngestionRoute('/api/v1/ingest/run'), { kind: 'run' })
    assert.deepEqual(matchIngestionRoute('/api/v1/ingest/run-due'), { kind: 'run-due' })
    assert.deepEqual(matchIngestionRoute('/api/v1/ingest/schedules/defaults'), { kind: 'defaults' })
    assert.deepEqual(matchIngestionRoute('/api/v1/ingest/schedules'), { kind: 'schedules', id: null })
    assert.deepEqual(matchIngestionRoute('/api/v1/ingest/schedules/s1'), { kind: 'schedules', id: 's1' })
    assert.deepEqual(matchIngestionRoute('/api/v1/ingest/schedules/s1/run'), { kind: 'run-one', id: 's1' })
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/ingest', '/api/v1/ingest/run-now', '/api/v1/ingest/schedules/s1/x', '/api/v1/ingest/statuses']) {
      assert.equal(matchIngestionRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — a run and the schedule it advanced are written together', () => {
  it('advances last_run_at and next_run_at in the same merge as the run log', async () => {
    const store = await scratchStore({ ingestion_schedules: [schedule()] })
    const merges = observeMerges(store)
    const { res } = await call({ kind: 'run-one', id: 's1' }, {
      method: 'POST', body: { actor: 'test' }, store,
    })
    assert.equal(res.status, 201)
    const run = res.json().data[0]
    assert.equal(run.schedule_id, 's1')
    assert.equal(run.run_type, 'scheduled')

    // The schedule advanced to the run that just finished, and its next run is
    // no earlier than that run — never rewound behind it.
    const after = await store.read()
    const advanced = after.ingestion_schedules.find((s) => s.id === 's1')
    assert.equal(advanced.last_run_at, run.completed_at,
      'the schedule did not record the run that just happened')
    assert.ok(Date.parse(advanced.next_run_at) >= Date.parse(run.started_at),
      'the next run precedes the run that just finished')

    // One merge carried both the schedule's advance and the action logs — the
    // property that makes "the run and the schedule it advanced" atomic.
    const mergeWithSchedule = merges.find((m) => m.ingestion_schedules)
    assert.ok(mergeWithSchedule, 'the schedule advance was not merged')
    assert.ok(mergeWithSchedule.action_logs?.length >= 1,
      'the run was written without its log, or the log without the run')
  })

  it('refuses a run on a schedule that is not there', async () => {
    const { res } = await call({ kind: 'run-one', id: 'missing' }, {
      method: 'POST', body: {}, store: recordingStore({ ingestion_schedules: [] }),
    })
    assert.equal(res.status, 404)
  })
})

describe('ARC-01 — run-due closes the loop', () => {
  it('evaluates alerts against the store’s live state, not the request snapshot', async () => {
    const store = await scratchStore({ ingestion_schedules: [schedule()] })
    const before = await store.read()
    const alerts = alertRecorder()
    const { res } = await call({ kind: 'run-due' }, { method: 'POST', body: { actor: 'test' }, store, alerts })
    assert.equal(res.status, 201)
    assert.equal(alerts.seen.length, 1, 'run-due did not evaluate alerts at all')
    // The snapshot handed to the evaluator is what the store holds *after* the
    // run wrote — not the snapshot the dispatcher took before it. Evaluating
    // against the stale one is how a threshold crossing is missed.
    const evaluated = alerts.seen[0]
    assert.notEqual(evaluated, before,
      'alerts were evaluated against the dispatcher’s pre-run snapshot')
    assert.equal(evaluated.source_runs.length, 1,
      'the run that just happened was not visible to the alert evaluation')
    assert.deepEqual(res.json().alerts, { raised: 1, updated: 0 })
  })

  it('runs only the schedules that are due', async () => {
    const future = schedule({ id: 's-future', next_run_at: '2999-01-01T00:00:00.000Z' })
    const store = await scratchStore({ ingestion_schedules: [schedule(), future] })
    const { res } = await call({ kind: 'run-due' }, { method: 'POST', body: {}, store })
    assert.equal(res.status, 201)
    const ranIds = res.json().schedules.map((s) => s.id)
    assert.deepEqual(ranIds, ['s1'], 'run-due ran a schedule that was not due')
  })
})

describe('ARC-01 — a caller-triggered run', () => {
  const CSV = 'event_date,event_type,latitude,longitude,country,fatalities,title\n2026-01-02,manual_run,3.12,35.62,KE,0,Manual run event\n'

  it('runs the sources the body names, and answers 200 rather than 201', async () => {
    // `run-due` answers 201 because it creates schedule state. This route
    // creates nothing — it reports what the sources returned — so 201 would be
    // a claim it does not make. The status is the assertion because it is the
    // one observable that distinguishes the two siblings.
    //
    // `sources` is named explicitly, and that is not incidental: an absent
    // `sources` resolves to `PUBLIC_INGESTION_SOURCES` — nine live connectors
    // (`src/ingestion.js:160`). A test that omitted it would reach the network
    // and hang rather than fail, which is what this test did on first write.
    const store = await scratchStore()
    const merges = observeMerges(store)
    const { handled, res } = await call({ kind: 'run' }, {
      method: 'POST', body: { sources: ['conflict_csv'], conflict_csv: CSV, actor: 'test' }, store,
    })
    assert.equal(handled, true)
    assert.equal(res.status, 200, 'a caller-triggered run must not answer 201')
    const body = res.json()
    assert.equal(body.success, true)
    assert.equal(body.source_runs.length, 1)
    assert.equal(body.source_runs[0].source, 'conflict_csv')
    assert.equal(body.counts.conflict_events, 1, 'the body’s CSV was not the thing ingested')
    assert.ok(body.analytics, 'the run did not refresh analytics')
    // The log is reported even when the merge is skipped for being empty, so
    // the response shape does not depend on whether anything was written.
    assert.equal(body.action_logs.length, 1)
    assert.ok(merges.some((batch) => batch.action_logs?.length), 'the action log was never written')
  })

  it('reports a failed source as a run rather than throwing', async () => {
    // A connector that throws is a run with `status: 'failed'`, not a 500 —
    // the same contract `run-due` holds, because both answer "what did the
    // sources do" and a source that errored did something. The CSV here is
    // malformed so the connector itself succeeds and the *parse* is what fails,
    // which is the path a caller actually hits.
    const store = await scratchStore()
    const { res } = await call({ kind: 'run' }, {
      method: 'POST',
      body: { sources: ['conflict_csv'], conflict_csv: 'not,a,valid,header\n1,2\n', actor: 'test' },
      store,
    })
    assert.equal(res.status, 200, 'a source that could not be parsed is a run, not a 500')
    const body = res.json()
    assert.equal(body.source_runs.length, 1)
    assert.equal(body.counts.conflict_events, 0)
    assert.ok(body.action_logs.length >= 1, 'a failed run was not logged')
  })

  it('answers 405 for a verb it does not serve', async () => {
    // The matcher is pathname-only, so the verb is refused inside the handler —
    // the family's contract, the same one the `run-due` case asserts. A GET
    // must not be handled as a silent no-op, which would let the dispatcher
    // fall through to a 404 and report the route as missing.
    const store = await scratchStore()
    const { handled, res } = await call({ kind: 'run' }, { method: 'GET', store })
    assert.equal(handled, true)
    assert.equal(res.status, 405)
  })
})

describe('ARC-01 — a schedule resolves through findVisible', () => {
  it('hides another organisation’s schedule from a partner-scoped token', async () => {
    const store = recordingStore({ ingestion_schedules: [schedule({ partner_org: 'org-b' })] })
    const { res } = await call({ kind: 'schedules', id: 's1' }, {
      auth: { subject: 'p', partner_org: 'org-a' }, store,
    })
    assert.equal(res.status, 404, 'a partner read another organisation’s schedule by id')
  })

  it('hides another organisation’s schedule from a by-id PATCH', async () => {
    const store = recordingStore({ ingestion_schedules: [schedule({ partner_org: 'org-b' })] })
    const { res } = await call({ kind: 'schedules', id: 's1' }, {
      method: 'PATCH', body: { interval_minutes: 30 }, auth: { subject: 'p', partner_org: 'org-a' }, store,
    })
    assert.equal(res.status, 404, 'a partner patched another organisation’s schedule')
    assert.equal(store.state.ingestion_schedules[0].interval_minutes, 60, 'the schedule was mutated')
  })

  it('returns the caller’s own schedule', async () => {
    const store = recordingStore({ ingestion_schedules: [schedule({ partner_org: 'org-a' })] })
    const { res } = await call({ kind: 'schedules', id: 's1' }, {
      auth: { subject: 'p', partner_org: 'org-a' }, store,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.id, 's1')
  })
})

describe('ARC-01 — defaults and status answer their own shapes', () => {
  it('answers the status roll-up', async () => {
    const { res } = await call({ kind: 'status' }, { store: recordingStore() })
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.json().data), 'the status route did not answer a per-source array')
  })

  it('creates the default schedules for sources that have none', async () => {
    const { res, store } = await call({ kind: 'defaults' }, {
      method: 'POST', body: { next_run_at: '2999-01-01T00:00:00.000Z', actor: 'test' },
    })
    assert.equal(res.status, 201)
    assert.ok(res.json().created >= 5)
    assert.ok(store.state.ingestion_schedules.length >= 5)
  })

  it('answers 405 for a verb a route does not serve', async () => {
    const { handled, res } = await call({ kind: 'run-due' }, { method: 'GET' })
    assert.equal(handled, true)
    assert.equal(res.status, 405)
  })
})

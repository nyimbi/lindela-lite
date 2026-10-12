/**
 * ARC-01 — the ingestion routes, out of the god function.
 *
 * The stored descriptions of a source read, and the two ways one is triggered.
 * Nine routes over six paths (`status`, `run-due`, `schedules` list/detail/patch,
 * `schedules/defaults`, `schedules/:id/run`), and they are a family because they
 * are the platform's clock: this is the only group whose writes *produce* the
 * data every other family reads.
 *
 * The properties this module exists to hold:
 *
 *   - **a run and the schedule it advanced are written together.** `run-one`
 *     runs the source, then writes the schedule's new `last_run_at`/`next_run_at`
 *     in the same merge as the run's own log. Advancing the schedule without
 *     recording the run, or the reverse, is either a schedule that re-runs
 *     forever or one that never runs again — so the two are one write.
 *   - **`run-due` closes the loop.** It is the only route that reads sources,
 *     refreshes analytics, and then asks whether anything crossed an alert
 *     threshold — in one request. The alert evaluation reads `store.read()`
 *     rather than the request's `data`, because ingestion and `refreshAnalytics`
 *     have both written since the snapshot was taken; evaluating against the
 *     stale snapshot is how a threshold crossing is missed.
 *   - **a schedule resolves through `findVisible`.** VUL-03 lived in the by-id
 *     branches — a partner token could read another organisation's schedule by
 *     guessing an id — and both the detail read and the two by-id writes carry
 *     the one resolver now.
 *
 * `evaluateAndPersistAlerts` is injected rather than imported: it is the driver's
 * own entry point and lives in `server.js`, and importing it here would make this
 * module and `server.js` import each other. The dispatcher, which has it in
 * scope, passes it in.
 */

import { defaultIngestionSchedules, ingestionStatus, normalizeIngestionSchedule, runDueIngestionSchedules, runIngestion } from '../ingestion.js'
import { refreshAnalytics } from '../analytics.js'
import { actionLog } from '../operations.js'
import { collectionPage, readRequestJson } from '../utils.js'
import { findVisible } from '../visibility.js'

/**
 * Which ingestion route a request is, or null.
 *
 * Pathname only; each route tests its own verb. The literals and the two
 * `.match(/…/)` patterns are what `check-openapi.mjs` reads to compare the
 * served surface against the spec.
 */
export function matchIngestionRoute(pathname) {
  if (pathname === '/api/v1/ingest/status') return { kind: 'status' }
  if (pathname === '/api/v1/ingest/run-due') return { kind: 'run-due' }
  if (pathname === '/api/v1/ingest/schedules/defaults') return { kind: 'defaults' }
  const runOne = pathname.match(/^\/api\/v1\/ingest\/schedules\/([^/]+)\/run$/)
  if (runOne) return { kind: 'run-one', id: decodeURIComponent(runOne[1]) }
  const schedule = pathname.match(/^\/api\/v1\/ingest\/schedules(?:\/([^/]+))?$/)
  if (schedule) return { kind: 'schedules', id: schedule[1] ? decodeURIComponent(schedule[1]) : null }
  return null
}

/**
 * Handle one ingestion route. Returns true when it handled the request.
 */
export async function handleIngestionRoute(route, { store, data, req, res, url, jsonResponse, evaluateAndPersistAlerts }) {
  if (req.method === 'GET' && route.kind === 'status') {
    jsonResponse(res, 200, { success: true, data: ingestionStatus(data) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'schedules' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.ingestion_schedules, url.searchParams, { auth: req.__auth, data, collection: 'ingestion_schedules' }) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'schedules' && route.id) {
    const record = findVisible(data.ingestion_schedules, route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Ingestion schedule not found' })
      return true
    }
    jsonResponse(res, 200, { success: true, data: record })
    return true
  }

  if (req.method === 'POST' && route.kind === 'defaults') {
    const body = await readRequestJson(req)
    const schedules = defaultIngestionSchedules(data, body)
    const logs = schedules.map((schedule) => actionLog('ingestion_schedules', 'created', schedule, body.actor, req.__auth?.subject))
    if (schedules.length) await store.merge({ ingestion_schedules: schedules, action_logs: logs })
    jsonResponse(res, 201, { success: true, created: schedules.length, data: schedules, action_logs: logs })
    return true
  }

  if (req.method === 'POST' && route.kind === 'schedules' && !route.id) {
    const body = await readRequestJson(req)
    const record = normalizeIngestionSchedule(body)
    const log = actionLog('ingestion_schedules', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ ingestion_schedules: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return true
  }

  if (req.method === 'PATCH' && route.kind === 'schedules' && route.id) {
    const body = await readRequestJson(req)
    const existing = findVisible(data.ingestion_schedules, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Ingestion schedule not found' })
      return true
    }
    const record = normalizeIngestionSchedule({ ...body, id: route.id }, existing)
    const log = actionLog('ingestion_schedules', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ ingestion_schedules: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return true
  }

  if (req.method === 'POST' && route.kind === 'run-due') {
    const body = await readRequestJson(req)
    const result = await runDueIngestionSchedules(store, data, body)
    const analytics = await refreshAnalytics(store)
    // The cycle the scheduler drives now ends by asking whether anything crossed
    // a threshold. This is the one line the deployed product was missing: a risk
    // score is a measurement, and an alert is what anyone does about it.
    //
    // `store.read()` rather than the request's `data`, because ingestion and
    // `refreshAnalytics` have both written since it was taken.
    const alerts = await evaluateAndPersistAlerts(store, await store.read(), {
      actor: body.actor || 'scheduled-ingest',
      subject: req.__auth?.subject,
    })
    const logs = [
      ...result.source_runs.map((run) => actionLog('source_runs', run.status, run, body.actor, req.__auth?.subject)),
      ...result.schedules.map((schedule) => actionLog('ingestion_schedules', 'ran', schedule, body.actor, req.__auth?.subject)),
    ]
    if (logs.length) await store.merge({ action_logs: logs })
    jsonResponse(res, 201, {
      success: true,
      data: result.source_runs,
      schedules: result.schedules,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
        data_quality: analytics.data_quality.length,
      },
      alerts: { raised: alerts.raised.length, updated: alerts.updated.length },
      action_logs: logs,
    })
    return true
  }

  if (req.method === 'POST' && route.kind === 'run-one' && route.id) {
    const body = await readRequestJson(req)
    const schedule = findVisible(data.ingestion_schedules, route.id)
    if (!schedule) {
      jsonResponse(res, 404, { success: false, error: 'Ingestion schedule not found' })
      return true
    }
    const ingestion = await runIngestion(store, {
      ...(schedule.default_options || {}),
      sources: [schedule.source],
      timeout_ms: schedule.timeout_ms,
      retries: schedule.retries,
      interval_minutes: schedule.interval_minutes,
      stale_after_minutes: schedule.stale_after_minutes,
      schedule_id: schedule.id,
      run_type: 'scheduled',
      ...body,
    })
    const completedAt = ingestion.source_runs[0]?.completed_at || new Date().toISOString()
    const nextSchedule = {
      ...schedule,
      last_run_at: completedAt,
      next_run_at: schedule.interval_minutes ? new Date(Date.parse(completedAt) + schedule.interval_minutes * 60 * 1000).toISOString() : schedule.next_run_at,
      updated_at: new Date().toISOString(),
    }
    const analytics = await refreshAnalytics(store)
    const logs = [
      ...ingestion.source_runs.map((run) => actionLog('source_runs', run.status, run, body.actor, req.__auth?.subject)),
      actionLog('ingestion_schedules', 'ran', nextSchedule, body.actor, req.__auth?.subject),
    ]
    await store.merge({ ingestion_schedules: [nextSchedule], action_logs: logs })
    jsonResponse(res, 201, {
      success: true,
      data: ingestion.source_runs,
      schedule: nextSchedule,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
        data_quality: analytics.data_quality.length,
      },
      action_logs: logs,
    })
    return true
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  return true
}

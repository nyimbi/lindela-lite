/**
 * ARC-01 — the reporting routes, out of the god function.
 *
 * The report lifecycle: templates, reports, their distribution runs, and the
 * schedules that generate and send them. Five collections over fourteen paths,
 * and they are a family because they are one lifecycle — a template defines a
 * report, a report is generated from it, approved, distributed, and the same
 * three steps run unattended on a schedule. A change to how a report is rendered
 * or how a distribution is attempted has to hold across the manual and the
 * scheduled path, so the two live together.
 *
 * The properties this module exists to hold, each of which was a bug once:
 *
 *   - **a distribution URL is checked at the point of use.** The webhook channel
 *     takes its URL from the request body, so it is attacker-controlled; it
 *     clears `checkWebhookUrl` before the fetch — shape, scheme, credentials and
 *     a DNS re-resolution — because a host that resolved publicly at
 *     registration can resolve to 127.0.0.1 minutes later. Without it the
 *     distribution path is an SSRF one token from the cloud metadata endpoint.
 *   - **an approved report is immutable.** `generate` and `narrate` refuse an
 *     `approved`/`distributed` report with a 409 carrying
 *     `ERROR_CODES.IMMUTABLE` — the lifecycle only moves forward, and a
 *     regeneration that silently rewrote an approved report would break the
 *     approval's meaning.
 *   - **a narration that invents a figure is refused.** `narrateReport` checks
 *     every number against the report's own facts and returns `refused` when one
 *     does not match; the refusal is stored on the record and logged, so a
 *     reader can tell computed words from model words.
 *   - **an outbox emit failure is counted, not swallowed.** A subscriber that
 *     was not told is a gap to count and name — the bare `catch {}` that used to
 *     be here made the gap invisible in both the log and the metric, which is
 *     the one thing an outbox exists to prevent.
 *   - **the `run-due` action is POST-only at the matcher.** VER-14: the matcher
 *     used to return a route for any verb, and the handler's next branch then
 *     answered the *schedule listing* for a `GET`. Requiring the verb lets a
 *     non-POST fall through to the id lookup and 404.
 *
 * VUL-03 is the resolver: every by-id read and write goes through `findVisible`,
 * so a partner token cannot reach another organisation's report or schedule.
 */

import { ERROR_CODES } from '../errors.js'
import { metrics, logger } from '../observability.js'
import { narrateReport, NARRATOR_BASIS } from '../narrator.js'
import { actionLog } from '../operations.js'
import { emit } from '../outbox.js'
import { assertSafeWebhookUrl } from '../webhooks.js'
import { collectionPage, readRequestJson, toCsv, toGeoJson } from '../utils.js'
import { findVisible } from '../visibility.js'
import {
  approveReport,
  computeNextRunAt,
  formatReportSmsSummary,
  generateReportSections,
  markReportDistributed,
  normalizeDistributionRun,
  normalizeReport,
  normalizeReportSchedule,
  normalizeReportTemplate,
  normalizeScheduleRun,
  recordsForReportSources,
  renderReportMarkdown,
  scheduleIsDue,
  updateReport,
} from '../reports.js'
import { sendRapidProReportSummary } from '../rapidpro.js'

/**
 * Which reporting route a request is, or null.
 *
 * `method` is a parameter because of VER-14: `run-due` is an action, and the
 * spec declares it `post:` alone, so the matcher refuses every other verb rather
 * than answering the schedule listing.
 */
export function matchReportingRoute(pathname, method = 'GET') {
  // VER-14, the class. `run-due` is an action, and the spec declares it `post:`
  // alone. The matcher returned `{ kind: 'schedules', action: 'run-due' }` for
  // any verb, and the handler's next branch — `GET && !route.id` — then answered
  // the *schedule listing* with a 200. So an undocumented `GET
  // /api/v1/report-schedules/run-due` returned every schedule, which is a
  // plausible-looking answer to a question nobody asked, and an operator
  // checking "has the run happened" read a list instead of a run. Requiring the
  // verb here lets a non-POST fall through to the id lookup below, which finds
  // no schedule called `run-due` and answers 404.
  if (pathname === '/api/v1/report-schedules/run-due') {
    return method === 'POST' ? { kind: 'schedules', action: 'run-due' } : null
  }
  const scheduleRunAction = pathname.match(/^\/api\/v1\/report-schedule-runs\/([^/]+)\/(retry)$/)
  if (scheduleRunAction) return { kind: 'schedule-runs', id: decodeURIComponent(scheduleRunAction[1]), action: scheduleRunAction[2] }
  const reportExport = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/export\.(md|json|csv|geojson)$/)
  if (reportExport) return { kind: 'reports', id: decodeURIComponent(reportExport[1]), exportFormat: reportExport[2] }
  const templateAction = pathname.match(/^\/api\/v1\/report-templates\/([^/]+)\/(copy)$/)
  if (templateAction) return { kind: 'templates', id: decodeURIComponent(templateAction[1]), action: templateAction[2] }
  const reportAction = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/(generate|approve|distribute|narrate)$/)
  if (reportAction) return { kind: 'reports', id: decodeURIComponent(reportAction[1]), action: reportAction[2] }
  const distributionAction = pathname.match(/^\/api\/v1\/report-distributions\/([^/]+)\/(retry)$/)
  if (distributionAction) return { kind: 'distributions', id: decodeURIComponent(distributionAction[1]), action: distributionAction[2] }
  const scheduleAction = pathname.match(/^\/api\/v1\/report-schedules\/([^/]+)\/(run)$/)
  if (scheduleAction) return { kind: 'schedules', id: decodeURIComponent(scheduleAction[1]), action: scheduleAction[2] }
  const routes = {
    'report-templates': 'templates',
    reports: 'reports',
    'report-distributions': 'distributions',
    'report-schedules': 'schedules',
    'report-schedule-runs': 'schedule-runs',
  }
  const match = pathname.match(/^\/api\/v1\/([^/]+)(?:\/([^/]+))?$/)
  if (!match || !routes[match[1]]) return null
  return { kind: routes[match[1]], id: match[2] ? decodeURIComponent(match[2]) : null }
}

/**
 * Handle one reporting route. Returns true when it handled the request.
 */
export async function handleReportingRoute(route, { store, data, req, res, url, jsonResponse, checkWebhookUrl }) {
  if (route.kind === 'templates') {
    await handleReportTemplateRoute(store, data, req, res, url, route, jsonResponse)
    return true
  }
  if (route.kind === 'reports') {
    await handleReportRoute(store, data, req, res, url, route, { checkWebhookUrl, jsonResponse })
    return true
  }
  if (route.kind === 'distributions') {
    await handleReportDistributionRoute(store, data, req, res, url, route, { checkWebhookUrl, jsonResponse })
    return true
  }
  if (route.kind === 'schedules') {
    await handleReportScheduleRoute(store, data, req, res, url, route, { checkWebhookUrl, jsonResponse })
    return true
  }
  if (route.kind === 'schedule-runs') {
    await handleReportScheduleRunRoute(store, data, req, res, url, route, { checkWebhookUrl, jsonResponse })
    return true
  }
  jsonResponse(res, 404, { success: false, error: 'Not found' })
  return true
}

async function handleReportTemplateRoute(store, data, req, res, url, route, jsonResponse) {
  if (req.method === 'POST' && route.action === 'copy') {
    const body = await readRequestJson(req)
    const existing = findVisible(data.report_templates, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report template not found' })
      return
    }
    const record = normalizeReportTemplate({
      ...existing,
      id: body.id,
      name: body.name || `${existing.name} Copy`,
      version: 1,
      created_at: undefined,
      updated_at: undefined,
    })
    const log = actionLog('report_templates', 'copied', record, body.actor, req.__auth?.subject)
    await store.merge({ report_templates: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.report_templates, url.searchParams, { auth: req.__auth, data, collection: 'report_templates' }) })
    return
  }
  if (req.method === 'GET' && route.id) {
    const record = findVisible(data.report_templates, route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Report template not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }
  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    const record = normalizeReportTemplate(body)
    const log = actionLog('report_templates', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ report_templates: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'PATCH' && route.id) {
    const body = await readRequestJson(req)
    const existing = findVisible(data.report_templates, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report template not found' })
      return
    }
    const record = normalizeReportTemplate({ ...body, id: route.id }, existing)
    const log = actionLog('report_templates', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ report_templates: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportRoute(store, data, req, res, url, route, { checkWebhookUrl, jsonResponse }) {
  if (req.method === 'GET' && route.exportFormat) {
    const report = findVisible(data.reports, route.id)
    if (!report) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    if (route.exportFormat === 'md') {
      const locale = url.searchParams.get('locale') || 'en'
      const plain = url.searchParams.get('plain') === '1'
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${report.id}.md"`,
      })
      res.end(renderReportMarkdown(report, { locale, plain }))
      return
    }
    if (route.exportFormat === 'csv') {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${report.id}-appendix.csv"`,
      })
      res.end(toCsv(recordsForReportSources(report, data)))
      return
    }
    if (route.exportFormat === 'geojson') {
      jsonResponse(res, 200, toGeoJson(recordsForReportSources(report, data)), { 'content-type': 'application/geo+json; charset=utf-8' })
      return
    }
    jsonResponse(res, 200, { success: true, data: report })
    return
  }

  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.reports, url.searchParams, { auth: req.__auth, data, collection: 'reports' }) })
    return
  }
  if (req.method === 'GET' && route.id) {
    const record = findVisible(data.reports, route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }
  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    let record = normalizeReport(body, data)
    if (body.generate) record = generateReportSections(record, data, body)
    const log = actionLog('reports', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    // The record is stored either way; a subscriber that was not told is a gap
    // to count and name, not a reason to abandon the merge. The bare `catch {}`
    // that used to be here made the gap invisible in both the log and the
    // metric, which is the one thing an outbox exists to prevent.
    try {
      await emit(store, 'report.created', record)
    } catch (emitError) {
      metrics.counter('outbox_emit_failed_total', { event: 'report.created' })
      logger.error('outbox_emit_failed', {
        outbox_event: 'report.created',
        report_id: record.id,
        message: 'outbox emit failed; the report is stored and no subscriber was told',
        err: { message: emitError.message, stack: emitError.stack },
      })
    }
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'PATCH' && route.id && !route.action) {
    const body = await readRequestJson(req)
    const existing = findVisible(data.reports, route.id)
    const record = updateReport(existing, body, data)
    const log = actionLog('reports', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'generate') {
    const body = await readRequestJson(req)
    const existing = findVisible(data.reports, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    if (['approved', 'distributed'].includes(existing.status)) {
      jsonResponse(res, 409, { success: false, error: 'Approved or distributed reports cannot be regenerated', code: ERROR_CODES.IMMUTABLE })
      return
    }
    const record = generateReportSections(existing, data, body)
    const log = actionLog('reports', 'generated', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'narrate') {
    // ENH-narrator — generated text, audited like everything else here.
    // Commentary is a claim, so it rides the same lifecycle as every other
    // claim the report carries: stored on the record, logged as an action,
    // and refused by code when the model invents a figure it was not given.
    const body = await readRequestJson(req)
    const existing = findVisible(data.reports, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    if (['approved', 'distributed'].includes(existing.status)) {
      jsonResponse(res, 409, { success: false, error: 'Approved or distributed reports are immutable except archival', code: ERROR_CODES.IMMUTABLE })
      return
    }
    if (!(existing.sections || []).length) {
      jsonResponse(res, 400, { success: false, error: 'Generate the report first: there is nothing computed to narrate' })
      return
    }
    const narration = await narrateReport(existing, { now: new Date().toISOString() })
    let record
    let log
    if (narration.status === 'narrated') {
      const commentary = {
        id: 'model_commentary',
        title: 'Narrator commentary',
        // A second type in the sections' closed set: the panel renders it as
        // model text and marks it, because a reader must know which words
        // were computed and which were written.
        type: 'model_narrative',
        content: {
          summary: narration.text,
          metrics: { model: narration.model, figures_checked: narration.numbers_checked },
          items: [],
          source_refs: [],
          markdown: `(${narration.model}; every figure checked against the report's facts)\n\n${narration.text}`,
        },
        source_refs: [],
        generated_at: narration.generated_at,
        warnings: [],
      }
      record = normalizeReport({
        ...existing,
        sections: [...(existing.sections || []).filter((s) => s.id !== 'model_commentary'), commentary],
        narrative: { status: 'narrated', text: narration.text, model: narration.model, generated_at: narration.generated_at, basis: NARRATOR_BASIS },
      }, data, existing)
      log = actionLog('reports', 'narrated', { report_id: record.id, model: narration.model, figures_checked: narration.numbers_checked }, body.actor, req.__auth?.subject)
    } else {
      record = normalizeReport({
        ...existing,
        narrative: { status: 'refused', reason: narration.reason, generated_at: narration.generated_at },
      }, data, existing)
      const warned = [...new Set([...(record.warnings || []), `Narrator refused: ${narration.reason}`])]
      log = actionLog('reports', 'narration_refused', { report_id: record.id, reason: narration.reason }, body.actor, req.__auth?.subject)
      record = normalizeReport({ ...record, warnings: warned }, data, existing)
    }
    await store.merge({ reports: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, narration, action_log: log })
    return
  }

  if (req.method === 'POST' && route.action === 'approve') {
    const body = await readRequestJson(req)
    const existing = findVisible(data.reports, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    const record = approveReport(existing, body.actor)
    const log = actionLog('reports', 'approved', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'distribute') {
    const body = await readRequestJson(req)
    const existing = findVisible(data.reports, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    const result = await distributeReport(existing, body, body.actor, data, { checkWebhookUrl })
    const record = result.report
    const log = actionLog('reports', 'distributed', record, body.actor, req.__auth?.subject)
    await store.merge({
      reports: [record],
      report_distribution_runs: result.runs,
      rapidpro_dispatches: result.rapidproDispatches,
      action_logs: [log, ...result.runs.map((run) => actionLog('report_distribution_runs', run.status, run, body.actor, req.__auth?.subject))],
    })
    try {
      await emit(store, 'report.distributed', record)
    } catch (emitError) {
      metrics.counter('outbox_emit_failed_total', { event: 'report.distributed' })
      logger.error('outbox_emit_failed', {
        outbox_event: 'report.distributed',
        report_id: record.id,
        message: 'outbox emit failed; the distribution is stored and no subscriber was told',
        err: { message: emitError.message, stack: emitError.stack },
      })
    }
    jsonResponse(res, 201, { success: result.runs.every((run) => run.status !== 'failed'), data: result.runs, report: record, action_log: log })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportDistributionRoute(store, data, req, res, url, route, { checkWebhookUrl, jsonResponse }) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.report_distribution_runs, url.searchParams, { auth: req.__auth, data, collection: 'report_distribution_runs' }) })
    return
  }
  const run = findVisible(data.report_distribution_runs, route.id)
  if (!run) {
    jsonResponse(res, 404, { success: false, error: 'Report distribution not found' })
    return
  }
  if (req.method === 'GET' && !route.action) {
    jsonResponse(res, 200, { success: true, data: run })
    return
  }
  if (req.method === 'POST' && route.action === 'retry') {
    const body = await readRequestJson(req)
    const report = data.reports.find((item) => item.id === run.report_id)
    if (!report) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    const result = await distributeReport(report, { channels: [{ ...(run.options || {}), channel: run.channel, recipients: run.recipients }], retry_of: run.id }, body.actor, data, { checkWebhookUrl })
    await store.merge({
      reports: [result.report],
      report_distribution_runs: result.runs,
      rapidpro_dispatches: result.rapidproDispatches,
      action_logs: result.runs.map((item) => actionLog('report_distribution_runs', item.status, item, body.actor, req.__auth?.subject)),
    })
    jsonResponse(res, 201, { success: result.runs.every((item) => item.status !== 'failed'), data: result.runs })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportScheduleRoute(store, data, req, res, url, route, { checkWebhookUrl, jsonResponse }) {
  if (route.kind === 'schedule-runs') {
    await handleReportScheduleRunRoute(store, data, req, res, url, route, { checkWebhookUrl, jsonResponse })
    return
  }

  if (req.method === 'POST' && route.action === 'run-due') {
    const body = await readRequestJson(req)
    const result = await runDueReportSchedules(data, body.actor, { checkWebhookUrl })
    await store.merge(result.writes)
    jsonResponse(res, 201, { success: true, data: result.runs, reports: result.reports, distributions: result.distributions })
    return
  }
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.report_schedules, url.searchParams, { auth: req.__auth, data, collection: 'report_schedules' }) })
    return
  }
  if (req.method === 'GET' && route.id) {
    const record = findVisible(data.report_schedules, route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Report schedule not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }
  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    const record = normalizeReportSchedule(body, data)
    const log = actionLog('report_schedules', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ report_schedules: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'PATCH' && route.id) {
    const body = await readRequestJson(req)
    const existing = findVisible(data.report_schedules, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report schedule not found' })
      return
    }
    const record = normalizeReportSchedule({ ...body, id: route.id }, data, existing)
    const log = actionLog('report_schedules', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ report_schedules: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'run') {
    const body = await readRequestJson(req)
    const schedule = findVisible(data.report_schedules, route.id)
    if (!schedule) {
      jsonResponse(res, 404, { success: false, error: 'Report schedule not found' })
      return
    }
    const result = await runReportSchedule(data, schedule, body.actor, { checkWebhookUrl })
    await store.merge(result.writes)
    jsonResponse(res, 201, { success: true, data: result.scheduleRun, report: result.report, distributions: result.distributions })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportScheduleRunRoute(store, data, req, res, url, route, { checkWebhookUrl, jsonResponse }) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.report_schedule_runs, url.searchParams, { auth: req.__auth, data, collection: 'report_schedule_runs' }) })
    return
  }
  const run = findVisible(data.report_schedule_runs, route.id)
  if (!run) {
    jsonResponse(res, 404, { success: false, error: 'Report schedule run not found' })
    return
  }
  if (req.method === 'GET' && !route.action) {
    jsonResponse(res, 200, { success: true, data: run })
    return
  }
  if (req.method === 'POST' && route.action === 'retry') {
    const body = await readRequestJson(req)
    const schedule = data.report_schedules.find((item) => item.id === run.schedule_id)
    if (!schedule) {
      jsonResponse(res, 404, { success: false, error: 'Report schedule not found' })
      return
    }
    const result = await runReportSchedule(data, schedule, body.actor, { checkWebhookUrl })
    await store.merge(result.writes)
    jsonResponse(res, 201, { success: true, data: result.scheduleRun, report: result.report, distributions: result.distributions })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function distributeReport(report, body = {}, actor = 'operator', data = null, { checkWebhookUrl = assertSafeWebhookUrl } = {}) {
  if (!['ready', 'approved', 'distributed'].includes(report.status)) {
    throw Object.assign(new Error('Report must be ready or approved before distribution'), { statusCode: 400 })
  }
  const channels = normalizeDistributionChannels(body, report)
  const runs = []
  const rapidproDispatches = []
  for (const channel of channels) {
    const runInput = {
      channel: channel.channel,
      recipients: channel.recipients || recipientFields(channel),
      payload_summary: formatReportSmsSummary(report),
      options: channel,
      retry_of: body.retry_of || null,
    }
    try {
      if (['markdown_download', 'json', 'csv', 'geojson'].includes(channel.channel)) {
        const appendixRecords = data ? recordsForReportSources(report, data) : []
        const responseBody = {
          markdown_download: { bytes: renderReportMarkdown(report).length },
          json: { report_id: report.id },
          csv: { records: appendixRecords.length },
          geojson: { features: toGeoJson(appendixRecords).features.length },
        }[channel.channel]
        runs.push(normalizeDistributionRun({ ...runInput, status: 'prepared', response_body: responseBody }, report))
      } else if (channel.channel === 'webhook') {
        // The URL comes from the request body, so it is attacker-controlled and
        // must clear the same guard the outbox applies to a subscription URL:
        // shape, scheme, credentials, and a DNS re-resolution at the point of
        // use (a host that resolved publicly at registration can resolve to
        // 127.0.0.1 minutes later). Without this the distribution path is an
        // SSRF the webhook path already closed — one token away from the cloud
        // metadata endpoint and the internal network.
        const target = await checkWebhookUrl(required(channel.url, 'url'))
        const response = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(channel.headers || {}) },
          body: JSON.stringify({ report, markdown: renderReportMarkdown(report) }),
        })
        const responseBody = await readExternalResponse(response)
        runs.push(normalizeDistributionRun({
          ...runInput,
          status: response.ok ? 'sent' : 'failed',
          response_status: response.status,
          response_body: responseBody,
          error: response.ok ? null : `Webhook HTTP ${response.status}`,
        }, report))
      } else if (channel.channel === 'rapidpro_sms') {
        const summary = channel.text || formatReportSmsSummary(report)
        const dispatch = await sendRapidProReportSummary(report, summary, channel)
        rapidproDispatches.push(dispatch)
        runs.push(normalizeDistributionRun({
          ...runInput,
          status: dispatch.status === 'sent' ? 'sent' : 'failed',
          response_status: dispatch.response_status,
          response_body: dispatch.response_body,
          error: dispatch.error,
        }, report))
      } else {
        throw Object.assign(new Error('channel must be markdown_download, json, csv, geojson, webhook, or rapidpro_sms'), { statusCode: 400 })
      }
    } catch (error) {
      runs.push(normalizeDistributionRun({ ...runInput, status: 'failed', error: error.message }, report))
    }
  }
  const hasDeliveredArtifact = runs.some((run) => run.status !== 'failed')
  return { report: hasDeliveredArtifact ? markReportDistributed(report) : report, runs, rapidproDispatches, actor }
}

export async function runDueReportSchedules(data, actor = 'operator', { checkWebhookUrl } = {}) {
  const due = data.report_schedules.filter((schedule) => scheduleIsDue(schedule))
  const aggregate = emptyScheduleResult()
  for (const schedule of due) {
    const result = await runReportSchedule(data, schedule, actor, { checkWebhookUrl })
    mergeScheduleResult(aggregate, result)
    data = {
      ...data,
      reports: result.report ? [...data.reports, result.report] : data.reports,
      report_schedules: data.report_schedules.map((item) => (item.id === result.schedule.id ? result.schedule : item)),
      report_schedule_runs: [...data.report_schedule_runs, result.scheduleRun],
      report_distribution_runs: [...data.report_distribution_runs, ...result.distributions],
      rapidpro_dispatches: [...data.rapidpro_dispatches, ...result.rapidproDispatches],
    }
  }
  return aggregate
}

async function runReportSchedule(data, schedule, actor = 'operator', { checkWebhookUrl } = {}) {
  const startedAt = new Date().toISOString()
  const template = data.report_templates.find((item) => item.id === schedule.template_id)
  if (!template) {
    const completedAt = new Date().toISOString()
    const nextSchedule = {
      ...schedule,
      last_run_at: completedAt,
      next_run_at: computeNextRunAt(schedule, completedAt),
      updated_at: completedAt,
    }
    const scheduleRun = normalizeScheduleRun({ status: 'failed', started_at: startedAt, completed_at: completedAt, error: 'Template not found' }, nextSchedule)
    return {
      schedule: nextSchedule,
      scheduleRun,
      report: null,
      distributions: [],
      rapidproDispatches: [],
      writes: {
        report_schedules: [nextSchedule],
        report_schedule_runs: [scheduleRun],
        action_logs: [actionLog('report_schedule_runs', 'failed', scheduleRun, actor)],
      },
    }
  }
  let report = normalizeReport({
    template_id: template.id,
    owner: schedule.owner,
    distribution_defaults: schedule.distribution_defaults,
  }, data)
  report = generateReportSections(report, data)
  const distributions = []
  const rapidproDispatches = []
  if (schedule.auto_distribute) {
    const distribution = await distributeReport({ ...report, status: 'approved' }, { channels: schedule.distribution_defaults }, actor, data, { checkWebhookUrl })
    report = distribution.report
    distributions.push(...distribution.runs)
    rapidproDispatches.push(...distribution.rapidproDispatches)
  }
  const now = new Date().toISOString()
  const nextSchedule = {
    ...schedule,
    last_run_at: now,
    next_run_at: computeNextRunAt(schedule, now),
    updated_at: now,
  }
  const scheduleRun = normalizeScheduleRun({ status: 'completed', started_at: startedAt, completed_at: now }, schedule, report)
  return {
    schedule: nextSchedule,
    scheduleRun,
    report,
    distributions,
    rapidproDispatches,
    writes: {
      reports: [report],
      report_schedules: [nextSchedule],
      report_schedule_runs: [scheduleRun],
      report_distribution_runs: distributions,
      rapidpro_dispatches: rapidproDispatches,
      action_logs: [
        actionLog('reports', 'generated', report, actor),
        actionLog('report_schedule_runs', 'completed', scheduleRun, actor),
        ...distributions.map((run) => actionLog('report_distribution_runs', run.status, run, actor)),
      ],
    },
  }
}

function normalizeDistributionChannels(body, report) {
  const configured = body.channels || (body.channel ? [body] : report.distribution_defaults)
  const channels = Array.isArray(configured) ? configured : [configured]
  return channels.length ? channels.map((channel) => (typeof channel === 'string' ? { channel } : channel)) : [{ channel: 'markdown_download' }]
}

function recipientFields(channel) {
  return {
    urns: channel.urns || [],
    contacts: channel.contacts || [],
    groups: channel.groups || [],
    url: channel.url || null,
  }
}

function emptyScheduleResult() {
  return {
    runs: [],
    reports: [],
    distributions: [],
    rapidproDispatches: [],
    writes: {
      reports: [],
      report_schedules: [],
      report_schedule_runs: [],
      report_distribution_runs: [],
      rapidpro_dispatches: [],
      action_logs: [],
    },
  }
}

function mergeScheduleResult(target, result) {
  target.runs.push(result.scheduleRun)
  if (result.report) target.reports.push(result.report)
  target.distributions.push(...result.distributions)
  target.rapidproDispatches.push(...result.rapidproDispatches)
  for (const [collection, records] of Object.entries(result.writes)) {
    target.writes[collection].push(...records)
  }
}

async function readExternalResponse(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function required(value, field) {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error(`${field} is required`), { statusCode: 400 })
  }
  return value
}

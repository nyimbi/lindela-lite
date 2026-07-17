import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticate, requireScope, scopeForRoute } from './auth.js'
import { logger, metrics, timer } from './observability.js'
import { refreshAnalytics } from './analytics.js'
import { biasCorrectClimate } from './analytics/downscaling.js'
import { evaluateAlertRules, normalizeAlertRule, updateAlertEvent, approveAlertEvent, normalizeTriggerProtocol, backtestTriggerProtocol, evaluateInShadowMode } from './alerts.js'
import {
  defaultIngestionSchedules,
  ingestionStatus,
  normalizeIngestionSchedule,
  runDueIngestionSchedules,
  runIngestion,
} from './ingestion.js'
import { actionLog, buildCreate, buildUpdate, operationalSummary } from './operations.js'
import { parseRapidProFieldReport, rapidProStatus, responseMetrics, sendRapidProAlert, sendRapidProReportSummary, verifyRapidProWebhook } from './rapidpro.js'
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
} from './reports.js'
import { publicSourceCatalog } from './schema.js'
import { createStoreFromEnv } from './storage.js'
import { filterRecords, jsonResponse, readRequestJson, toCsv, toGeoJson } from './utils.js'
import { redactPii, applyRetention, loadPolicy } from './pii.js'
import { stacCatalog, stacCollection, stacItem, ogcFeatureCollection } from './stac.js'
import { renderCapXml } from './cap.js'
import { emit, dispatchPending } from './outbox.js'
import { normalizeWebhookSubscription } from './webhooks.js'
import { runScenario, encodeScenarioUrl, decodeScenarioUrl } from './scenarios.js'
import { normalizeWorkflowInstance, transitionWorkflow, pendingForFocalPoint, workflowMetrics, WORKFLOW_TYPES, WORKFLOW_STATES, WORKFLOW_TRANSITIONS } from './workflows.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(__dirname, '../public')
const docsDir = path.resolve(__dirname, '../docs')
const registryPath = path.resolve(__dirname, '../connectors.registry.json')
let defaultStorePromise
let connectorRegistry = null

export function createServer(options = {}) {
  const storeProvider = options.store ? Promise.resolve(options.store) : getDefaultStore()
  return http.createServer(async (req, res) => {
    const t = timer()
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const route = normalizeRoute(url.pathname)

    try {
      if (hasTraversalSegment(req.url || '')) {
        jsonResponse(res, 404, { success: false, error: 'Not found' })
        return
      }

      if (url.pathname.startsWith('/stac/') || url.pathname.startsWith('/ogc/')) {
        await handleStacRoute(await storeProvider, req, res, url)
        return
      }

      if (url.pathname === '/metrics' || url.pathname === '/api/v1/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' })
        res.end(metrics.render())
        return
      }
      if (url.pathname.startsWith('/api/v1/')) {
        await handleApi(await storeProvider, req, res, url)
        return
      }
      await handleStatic(res, url.pathname)
    } catch (error) {
      jsonResponse(res, error.statusCode || 500, {
        success: false,
        error: error.message || 'Internal server error',
      })
    } finally {
      const elapsed = t.end()
      const statusCode = res.statusCode || 500
      metrics.counter('http_requests_total', { method: req.method, route, status: String(statusCode) })
      metrics.histogram('http_request_duration_ms', elapsed, { method: req.method, route, status: String(statusCode) })
      logger.info('http_request', { method: req.method, route, status: statusCode, elapsed_ms: elapsed })
    }
  })
}

function normalizeRoute(pathname) {
  return pathname
    .replace(/\/[a-f0-9-]{36}/g, '/:id')
    .replace(/\/[a-f0-9_]{32,}/g, '/:id')
    .replace(/\/\d+/g, '/:id')
}

async function handleStacRoute(store, req, res, url) {
  const data = await store.read()
  const baseUrl = `http://${req.headers.host || 'localhost'}`

  if (req.method === 'GET' && url.pathname === '/stac/catalog.json') {
    jsonResponse(res, 200, stacCatalog(baseUrl))
    return
  }

  const collectionMatch = url.pathname.match(/^\/stac\/collections\/([^/]+)(?:\/items(?:\/([^/]+))?)?$/)
  if (collectionMatch && req.method === 'GET') {
    const collectionId = collectionMatch[1]
    const itemId = collectionMatch[2]

    let records = []
    if (collectionId === 'hazard-events') {
      records = [...data.hazard_events, ...data.conflict_events]
    } else if (collectionId === 'service-assets') {
      records = data.service_assets
    } else if (collectionId === 'risk-scores') {
      records = data.risk_scores
    } else {
      jsonResponse(res, 404, { success: false, error: 'Collection not found' })
      return
    }

    if (!itemId) {
      if (url.pathname.includes('/items')) {
        const items = records.map((r) => stacItem(r, collectionId, baseUrl))
        jsonResponse(res, 200, { type: 'FeatureCollection', features: items })
        return
      }
      jsonResponse(res, 200, stacCollection(collectionId, records, baseUrl))
      return
    }

    const record = records.find((r) => r.id === itemId)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Item not found' })
      return
    }

    jsonResponse(res, 200, stacItem(record, collectionId, baseUrl), { 'content-type': 'application/geo+json; charset=utf-8' })
    return
  }

  const ogcMatch = url.pathname.match(/^\/ogc\/collections\/([^/]+)\/items$/)
  if (ogcMatch && req.method === 'GET') {
    const collectionId = ogcMatch[1]

    let records = []
    if (collectionId === 'hazard-events') {
      records = [...data.hazard_events, ...data.conflict_events]
    } else if (collectionId === 'service-assets') {
      records = data.service_assets
    } else if (collectionId === 'risk-scores') {
      records = data.risk_scores
    } else {
      jsonResponse(res, 404, { success: false, error: 'Collection not found' })
      return
    }

    jsonResponse(res, 200, ogcFeatureCollection(records), { 'content-type': 'application/geo+json; charset=utf-8' })
    return
  }

  jsonResponse(res, 404, { success: false, error: 'Not found' })
}

async function handleApi(store, req, res, url) {
  let auth = null
  if (process.env.LINDELA_LITE_TOKENS || process.env.LINDELA_LITE_API_KEY) {
    if (url.pathname === '/api/v1/rapidpro/field-report' && req.method === 'POST') {
      if (!verifyRapidProWebhook(req, url)) {
        jsonResponse(res, 401, { success: false, error: 'Invalid RapidPro webhook' })
        return
      }
    } else if (url.pathname !== '/api/v1/health') {
      auth = authenticate(req)
      if (!auth && req.method !== 'GET') {
        jsonResponse(res, 401, { success: false, error: 'Unauthorized' })
        return
      }
      if (auth) {
        try {
          requireScope(auth, scopeForRoute(req.method, url.pathname))
        } catch (error) {
          jsonResponse(res, error.statusCode || 403, { success: false, error: error.message })
          return
        }
      }
    }
  }

  const data = await store.read()
  req.__auth = auth

  if (req.method === 'GET' && url.pathname === '/api/v1/health') {
    jsonResponse(res, 200, {
      success: true,
      status: 'ok',
      updated_at: data.updated_at,
      counts: counts(data),
      sources: publicSourceCatalog().map((source) => source.id),
      exclusions: ['gdelt'],
      storage: { mode: store.mode || 'custom' },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/sources') {
    const health = ingestionStatus(data)
    jsonResponse(res, 200, {
      success: true,
      data: publicSourceCatalog().map((source) => ({
        ...source,
        last_run: data.source_runs.find((run) => run.source === source.id) || null,
        health: health.find((item) => item.source === source.id)?.status || 'unknown',
        schedule: health.find((item) => item.source === source.id)?.schedule || null,
      })),
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/connectors') {
    const registry = await getConnectorRegistry()
    const sourceRuns = data.source_runs || []
    const withStatus = registry.map((connector) => {
      const lastRun = sourceRuns
        .filter((run) => run.source === connector.id)
        .sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())[0]
      return {
        ...connector,
        last_run: lastRun || null,
        status: lastRun?.status || 'unknown',
      }
    })
    jsonResponse(res, 200, { success: true, data: withStatus })
    return
  }

  const webhookRoute = matchWebhookRoute(url.pathname)
  if (webhookRoute) {
    await handleWebhookRoute(store, data, req, res, url, webhookRoute)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/outbox') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.events_outbox || [], url.searchParams) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/outbox/dispatch') {
    const body = await readRequestJson(req)
    const webhooks = data.webhook_subscriptions || []
    const result = await dispatchPending(store, { webhooks, maxBatch: 50, timeoutMs: 5000 })
    jsonResponse(res, 201, { success: true, ...result })
    return
  }

  const scenarioRoute = matchScenarioRoute(url.pathname)
  if (scenarioRoute) {
    if (req.method === 'POST' && scenarioRoute.kind === 'create') {
      const body = await readRequestJson(req)
      const perturbation = body.perturbation || body
      const result = runScenario(data, perturbation)
      const token = encodeScenarioUrl(perturbation)
      jsonResponse(res, 201, { success: true, ...result, token })
      return
    }
    if (req.method === 'GET' && scenarioRoute.kind === 'retrieve') {
      try {
        const perturbation = decodeScenarioUrl(scenarioRoute.token)
        const result = runScenario(data, perturbation)
        jsonResponse(res, 200, { success: true, ...result })
        return
      } catch (error) {
        jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
        return
      }
    }
  }

  const ingestionRoute = matchIngestionRoute(url.pathname)
  if (ingestionRoute) {
    await handleIngestionRoute(store, data, req, res, url, ingestionRoute)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/ingest/run') {
    const body = await readRequestJson(req)
    const ingestion = await runIngestion(store, body)
    const analytics = await refreshAnalytics(store)
    const logs = ingestion.source_runs.map((run) => actionLog('source_runs', run.status, run, body.actor, req.__auth?.subject))
    if (logs.length) await store.merge({ action_logs: logs })
    jsonResponse(res, 200, {
      success: true,
      source_runs: ingestion.source_runs,
      counts: ingestion.counts,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
        data_quality: analytics.data_quality.length,
      },
      action_logs: logs,
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/maintenance/apply-retention') {
    const policy = await loadPolicy()
    const fieldReportRetention = applyRetention(data.field_reports, policy.retentionDays)
    const inboundRetention = applyRetention(data.rapidpro_inbound_messages, policy.retentionDays)
    await store.merge({
      field_reports: fieldReportRetention.kept,
      rapidpro_inbound_messages: inboundRetention.kept,
    })
    jsonResponse(res, 200, {
      success: true,
      field_reports: {
        kept: fieldReportRetention.kept.length,
        expired: fieldReportRetention.expired.length,
      },
      rapidpro_inbound_messages: {
        kept: inboundRetention.kept.length,
        expired: inboundRetention.expired.length,
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/service-assets') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.service_assets, url.searchParams) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/service-assets') {
    const body = await readRequestJson(req)
    const ingestion = await runIngestion(store, { ...body, sources: ['service_assets'] })
    const run = ingestion.source_runs[0]
    if (run.errors.length) {
      jsonResponse(res, 400, { success: false, error: 'Invalid service asset input', errors: run.errors, accepted: ingestion.counts.service_assets })
      return
    }
    const analytics = await refreshAnalytics(store)
    jsonResponse(res, 201, {
      success: true,
      imported: ingestion.counts.service_assets,
      source_run: run,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
        data_quality: analytics.data_quality.length,
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/events') {
    const records = [...data.hazard_events, ...data.conflict_events]
    jsonResponse(res, 200, { success: true, data: filterRecords(records, url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/climate') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.climate_observations, url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/flood-risk') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.risk_scores.filter((risk) => risk.type === 'flood_risk'), url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/conflict-risk') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.risk_scores.filter((risk) => risk.type === 'climate_conflict_risk'), url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/service-impacts') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.impact_assessments, url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/impact/population-at-risk') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.population_at_risk || [], url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/impact/facilities-at-risk') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.facilities_at_risk || [], url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/data-quality') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.data_quality, url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/data-lineage') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.data_lineage || [], url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/operations/summary') {
    jsonResponse(res, 200, { success: true, data: operationalSummary(data) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/analytics/bias-correct') {
    const body = await readRequestJson(req)
    const observations = body.observations || []
    const stations = body.stations || []
    const corrected = biasCorrectClimate(observations, stations)
    jsonResponse(res, 200, { success: true, data: corrected })
    return
  }

  if (url.pathname === '/api/v1/alerts/evaluate') {
    await handleAlertEvaluation(store, data, req, res)
    return
  }

  const rapidProRoute = matchRapidProRoute(url.pathname)
  if (rapidProRoute) {
    await handleRapidProRoute(store, data, req, res, url, rapidProRoute)
    return
  }

  const reportingRoute = matchReportingRoute(url.pathname)
  if (reportingRoute) {
    await handleReportingRoute(store, data, req, res, url, reportingRoute)
    return
  }

  const alertRoute = matchAlertRoute(url.pathname)
  if (alertRoute) {
    await handleAlertRoute(store, data, req, res, url, alertRoute)
    return
  }

  const triggerRoute = matchTriggerRoute(url.pathname)
  if (triggerRoute) {
    await handleTriggerRoute(store, data, req, res, url, triggerRoute)
    return
  }

  const operationalRoute = matchOperationalRoute(url.pathname)
  if (operationalRoute) {
    await handleOperationalRoute(store, data, req, res, url, operationalRoute)
    return
  }

  const workflowRoute = matchWorkflowRoute(url.pathname)
  if (workflowRoute) {
    await handleWorkflowRoute(store, data, req, res, url, workflowRoute)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/assessments') {
    jsonResponse(res, 200, {
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        counts: counts(data),
        flood_risk: filterRecords(data.risk_scores.filter((risk) => risk.type === 'flood_risk'), url.searchParams),
        climate_conflict_risk: filterRecords(data.risk_scores.filter((risk) => risk.type === 'climate_conflict_risk'), url.searchParams),
        service_impacts: filterRecords(data.impact_assessments, url.searchParams),
        data_quality: filterRecords(data.data_quality, url.searchParams),
        operations: operationalSummary(data),
        alert_events: filterRecords(data.alert_events, url.searchParams),
        recent_events: filterRecords([...data.hazard_events, ...data.conflict_events], url.searchParams),
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/export.geojson') {
    const records = filterRecords([
      ...data.hazard_events,
      ...data.conflict_events,
      ...data.service_assets,
      ...data.risk_scores,
      ...data.impact_assessments,
      ...data.incidents,
      ...data.field_reports,
      ...data.response_resources,
      ...data.alert_events,
    ], url.searchParams)
    jsonResponse(res, 200, toGeoJson(records), { 'content-type': 'application/geo+json; charset=utf-8' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/export.csv') {
    const records = filterRecords([
      ...data.hazard_events,
      ...data.conflict_events,
      ...data.risk_scores,
      ...data.impact_assessments,
      ...data.incidents,
      ...data.interventions,
      ...data.intervention_tasks,
      ...data.field_reports,
      ...data.response_resources,
      ...data.alert_rules,
      ...data.alert_events,
      ...data.rapidpro_dispatches,
      ...data.rapidpro_inbound_messages,
    ], url.searchParams)
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="lindela-lite-export.csv"',
    })
    res.end(toCsv(records))
    return
  }

  jsonResponse(res, 404, { success: false, error: 'Not found' })
}

function isAuthorizedMutation(req, url) {
  if (req.headers['x-api-key'] === process.env.LINDELA_LITE_API_KEY) return true
  if (url.pathname === '/api/v1/rapidpro/field-report' && process.env.RAPIDPRO_WEBHOOK_SECRET) {
    return verifyRapidProWebhook(req, url)
  }
  return false
}

async function handleIngestionRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && route.kind === 'status') {
    jsonResponse(res, 200, { success: true, data: ingestionStatus(data) })
    return
  }

  if (req.method === 'GET' && route.kind === 'schedules' && !route.id) {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.ingestion_schedules, url.searchParams) })
    return
  }

  if (req.method === 'GET' && route.kind === 'schedules' && route.id) {
    const record = data.ingestion_schedules.find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Ingestion schedule not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && route.kind === 'defaults') {
    const body = await readRequestJson(req)
    const schedules = defaultIngestionSchedules(data, body)
    const logs = schedules.map((schedule) => actionLog('ingestion_schedules', 'created', schedule, body.actor, req.__auth?.subject))
    if (schedules.length) await store.merge({ ingestion_schedules: schedules, action_logs: logs })
    jsonResponse(res, 201, { success: true, created: schedules.length, data: schedules, action_logs: logs })
    return
  }

  if (req.method === 'POST' && route.kind === 'schedules' && !route.id) {
    const body = await readRequestJson(req)
    const record = normalizeIngestionSchedule(body)
    const log = actionLog('ingestion_schedules', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ ingestion_schedules: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'PATCH' && route.kind === 'schedules' && route.id) {
    const body = await readRequestJson(req)
    const existing = data.ingestion_schedules.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Ingestion schedule not found' })
      return
    }
    const record = normalizeIngestionSchedule({ ...body, id: route.id }, existing)
    const log = actionLog('ingestion_schedules', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ ingestion_schedules: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'POST' && route.kind === 'run-due') {
    const body = await readRequestJson(req)
    const result = await runDueIngestionSchedules(store, data, body)
    const analytics = await refreshAnalytics(store)
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
      action_logs: logs,
    })
    return
  }

  if (req.method === 'POST' && route.kind === 'run-one' && route.id) {
    const body = await readRequestJson(req)
    const schedule = data.ingestion_schedules.find((item) => item.id === route.id)
    if (!schedule) {
      jsonResponse(res, 404, { success: false, error: 'Ingestion schedule not found' })
      return
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
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportingRoute(store, data, req, res, url, route) {
  if (route.kind === 'templates') {
    await handleReportTemplateRoute(store, data, req, res, url, route)
    return
  }
  if (route.kind === 'reports') {
    await handleReportRoute(store, data, req, res, url, route)
    return
  }
  if (route.kind === 'distributions') {
    await handleReportDistributionRoute(store, data, req, res, url, route)
    return
  }
  if (route.kind === 'schedules') {
    await handleReportScheduleRoute(store, data, req, res, url, route)
    return
  }
  if (route.kind === 'schedule-runs') {
    await handleReportScheduleRunRoute(store, data, req, res, url, route)
    return
  }
  jsonResponse(res, 404, { success: false, error: 'Not found' })
}

async function handleReportTemplateRoute(store, data, req, res, url, route) {
  if (req.method === 'POST' && route.action === 'copy') {
    const body = await readRequestJson(req)
    const existing = data.report_templates.find((item) => item.id === route.id)
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
    jsonResponse(res, 200, { success: true, data: filterRecords(data.report_templates, url.searchParams) })
    return
  }
  if (req.method === 'GET' && route.id) {
    const record = data.report_templates.find((item) => item.id === route.id)
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
    const existing = data.report_templates.find((item) => item.id === route.id)
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

async function handleReportRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && route.exportFormat) {
    const report = data.reports.find((item) => item.id === route.id)
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
    jsonResponse(res, 200, { success: true, data: filterRecords(data.reports, url.searchParams) })
    return
  }
  if (req.method === 'GET' && route.id) {
    const record = data.reports.find((item) => item.id === route.id)
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
    try { await emit(store, 'report.created', record) } catch {}
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'PATCH' && route.id && !route.action) {
    const body = await readRequestJson(req)
    const existing = data.reports.find((item) => item.id === route.id)
    const record = updateReport(existing, body, data)
    const log = actionLog('reports', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'generate') {
    const body = await readRequestJson(req)
    const existing = data.reports.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    if (['approved', 'distributed'].includes(existing.status)) {
      jsonResponse(res, 409, { success: false, error: 'Approved or distributed reports cannot be regenerated' })
      return
    }
    const record = generateReportSections(existing, data, body)
    const log = actionLog('reports', 'generated', record, body.actor, req.__auth?.subject)
    await store.merge({ reports: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }
  if (req.method === 'POST' && route.action === 'approve') {
    const body = await readRequestJson(req)
    const existing = data.reports.find((item) => item.id === route.id)
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
    const existing = data.reports.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Report not found' })
      return
    }
    const result = await distributeReport(existing, body, body.actor, data)
    const record = result.report
    const log = actionLog('reports', 'distributed', record, body.actor, req.__auth?.subject)
    await store.merge({
      reports: [record],
      report_distribution_runs: result.runs,
      rapidpro_dispatches: result.rapidproDispatches,
      action_logs: [log, ...result.runs.map((run) => actionLog('report_distribution_runs', run.status, run, body.actor, req.__auth?.subject))],
    })
    try { await emit(store, 'report.distributed', record) } catch {}
    jsonResponse(res, 201, { success: result.runs.every((run) => run.status !== 'failed'), data: result.runs, report: record, action_log: log })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportDistributionRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.report_distribution_runs, url.searchParams) })
    return
  }
  const run = data.report_distribution_runs.find((item) => item.id === route.id)
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
    const result = await distributeReport(report, { channels: [{ ...(run.options || {}), channel: run.channel, recipients: run.recipients }], retry_of: run.id }, body.actor, data)
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

async function handleReportScheduleRoute(store, data, req, res, url, route) {
  if (route.kind === 'schedule-runs') {
    await handleReportScheduleRunRoute(store, data, req, res, url, route)
    return
  }

  if (req.method === 'POST' && route.action === 'run-due') {
    const body = await readRequestJson(req)
    const result = await runDueReportSchedules(data, body.actor)
    await store.merge(result.writes)
    jsonResponse(res, 201, { success: true, data: result.runs, reports: result.reports, distributions: result.distributions })
    return
  }
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.report_schedules, url.searchParams) })
    return
  }
  if (req.method === 'GET' && route.id) {
    const record = data.report_schedules.find((item) => item.id === route.id)
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
    const existing = data.report_schedules.find((item) => item.id === route.id)
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
    const schedule = data.report_schedules.find((item) => item.id === route.id)
    if (!schedule) {
      jsonResponse(res, 404, { success: false, error: 'Report schedule not found' })
      return
    }
    const result = await runReportSchedule(data, schedule, body.actor)
    await store.merge(result.writes)
    jsonResponse(res, 201, { success: true, data: result.scheduleRun, report: result.report, distributions: result.distributions })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleReportScheduleRunRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.report_schedule_runs, url.searchParams) })
    return
  }
  const run = data.report_schedule_runs.find((item) => item.id === route.id)
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
    const result = await runReportSchedule(data, schedule, body.actor)
    await store.merge(result.writes)
    jsonResponse(res, 201, { success: true, data: result.scheduleRun, report: result.report, distributions: result.distributions })
    return
  }
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function distributeReport(report, body = {}, actor = 'operator', data = null) {
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
        const response = await fetch(required(channel.url, 'url'), {
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

async function runDueReportSchedules(data, actor = 'operator') {
  const due = data.report_schedules.filter((schedule) => scheduleIsDue(schedule))
  const aggregate = emptyScheduleResult()
  for (const schedule of due) {
    const result = await runReportSchedule(data, schedule, actor)
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

async function runReportSchedule(data, schedule, actor = 'operator') {
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
    const distribution = await distributeReport({ ...report, status: 'approved' }, { channels: schedule.distribution_defaults }, actor, data)
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

async function handleRapidProRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && route.kind === 'status') {
    jsonResponse(res, 200, { success: true, data: rapidProStatus() })
    return
  }

  if (req.method === 'GET' && route.kind === 'response-metrics') {
    jsonResponse(res, 200, { success: true, data: responseMetrics(data) })
    return
  }

  if (req.method === 'GET' && route.kind === 'dispatches') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.rapidpro_dispatches, url.searchParams) })
    return
  }

  if (req.method === 'GET' && route.kind === 'inbound') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.rapidpro_inbound_messages, url.searchParams) })
    return
  }

  if (req.method === 'POST' && route.kind === 'send-alert') {
    const body = await readRequestJson(req)
    const alert = data.alert_events.find((item) => item.id === route.id)
    if (!alert) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return
    }
    const approvalState = alert.approval?.state || 'proposed'
    if (approvalState !== 'approved' && approvalState !== 'auto_approved') {
      jsonResponse(res, 409, { success: false, error: 'Alert not approved', current_state: approvalState })
      return
    }
    const dispatch = await sendRapidProAlert(alert, body)
    const log = actionLog('rapidpro_dispatches', dispatch.status === 'sent' ? 'sent' : 'failed', dispatch, body.actor, req.__auth?.subject)
    await store.merge({ rapidpro_dispatches: [dispatch], action_logs: [log] })
    jsonResponse(res, dispatch.status === 'sent' ? 201 : 502, { success: dispatch.status === 'sent', data: dispatch, action_log: log })
    return
  }

  if (req.method === 'POST' && route.kind === 'field-report') {
    if (!verifyRapidProWebhook(req, url)) {
      jsonResponse(res, 401, { success: false, error: 'Invalid RapidPro webhook secret' })
      return
    }
    const payload = await readRequestJson(req)
    const parsed = parseRapidProFieldReport(payload, data)
    const policy = await loadPolicy()
    let incident = parsed.report.incident_id ? data.incidents.find((item) => item.id === parsed.report.incident_id) : null
    const writes = { rapidpro_inbound_messages: [redactPii(parsed.inbound, policy)], action_logs: [] }
    if (!incident && !parsed.report.intervention_id) {
      incident = buildCreate('incidents', parsed.fallbackIncident, data)
      parsed.report.incident_id = incident.id
      writes.incidents = [incident]
      writes.action_logs.push(actionLog('incidents', 'created', incident, 'rapidpro'))
    }
    const report = buildCreate('field_reports', redactPii(parsed.report, policy), { ...data, incidents: incident ? [...data.incidents, incident] : data.incidents })
    parsed.inbound.field_report_id = report.id
    parsed.inbound.incident_id = report.incident_id
    parsed.inbound.intervention_id = report.intervention_id
    writes.field_reports = [report]
    writes.rapidpro_inbound_messages = [redactPii(parsed.inbound, policy)]
    writes.action_logs.push(actionLog('field_reports', 'created', report, 'rapidpro'))
    await store.merge(writes)
    jsonResponse(res, 201, { success: true, data: report, inbound: writes.rapidpro_inbound_messages[0], incident_created: Boolean(writes.incidents?.length) })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleAlertEvaluation(store, data, req, res) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return
  }
  const body = await readRequestJson(req)
  const context = {
    counts: counts(data),
    operations: operationalSummary(data),
    data_quality: data.data_quality,
  }
  const events = evaluateAlertRules(data, context)
  const logs = events.map((event) => actionLog('alert_events', 'created', event, body.actor, req.__auth?.subject))
  if (events.length) await store.merge({ alert_events: events, action_logs: logs })
  for (const event of events) {
    try {
      await emit(store, 'alert_event.created', event)
    } catch (emitError) {
      // Swallow emit errors
    }
  }
  jsonResponse(res, 201, { success: true, evaluated: data.alert_rules.length, created: events.length, data: events })
}

async function handleAlertRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && route.format === 'cap') {
    const record = data[route.collection].find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return
    }
    const xml = renderCapXml(record)
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
    res.end(xml)
    return
  }

  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, data: filterRecords(data[route.collection], url.searchParams) })
    return
  }

  if (req.method === 'GET' && route.id) {
    const record = data[route.collection].find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Record not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && !route.id && route.collection === 'alert_rules') {
    const body = await readRequestJson(req)
    const record = normalizeAlertRule(body)
    const log = actionLog(route.collection, 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ alert_rules: [record], action_logs: [log] })
    try {
      await emit(store, 'alert_rule.created', record)
    } catch (emitError) {
      // Swallow emit errors to not break the request
    }
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'PATCH' && route.id && !route.action) {
    const body = await readRequestJson(req)
    const existing = data[route.collection].find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Record not found' })
      return
    }
    const record = route.collection === 'alert_rules'
      ? normalizeAlertRule({ ...existing, ...body, id: route.id }, existing)
      : updateAlertEvent(existing, body)
    const log = actionLog(route.collection, 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'POST' && route.id && route.action && route.collection === 'alert_events') {
    const body = await readRequestJson(req)
    const existing = data.alert_events.find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return
    }
    const actor = body.actor || (req.__auth?.subject)
    if (!actor) {
      jsonResponse(res, 400, { success: false, error: 'actor is required' })
      return
    }
    const decision = route.action === 'approve' ? 'approved' : route.action === 'reject' ? 'rejected' : null
    if (!decision) {
      jsonResponse(res, 400, { success: false, error: 'Invalid approval action' })
      return
    }
    const record = approveAlertEvent(existing, actor, decision, body.note || '')
    const log = actionLog('alert_events', route.action, record, body.actor, req.__auth?.subject)
    await store.merge({ alert_events: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleTriggerRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.trigger_protocols || [], url.searchParams) })
    return
  }

  if (req.method === 'GET' && route.id) {
    const record = (data.trigger_protocols || []).find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && !route.id && !route.action) {
    const body = await readRequestJson(req)
    const record = normalizeTriggerProtocol(body)
    const log = actionLog('trigger_protocols', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ trigger_protocols: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'PATCH' && route.id && !route.action) {
    const body = await readRequestJson(req)
    const existing = (data.trigger_protocols || []).find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return
    }
    const record = normalizeTriggerProtocol({ ...existing, ...body, id: route.id }, existing)
    const log = actionLog('trigger_protocols', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ trigger_protocols: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'POST' && route.id && route.action === 'backtest') {
    const existing = (data.trigger_protocols || []).find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return
    }
    const result = backtestTriggerProtocol(existing, data)
    const updated = { ...existing, backtest: { ...result, last_run_at: new Date().toISOString() } }
    const log = actionLog('trigger_protocols', 'backtest_run', updated, null, req.__auth?.subject)
    await store.merge({ trigger_protocols: [updated], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: updated, backtest_result: result, action_log: log })
    return
  }

  if (req.method === 'POST' && route.id && route.action === 'shadow-run') {
    const existing = (data.trigger_protocols || []).find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return
    }
    const context = {
      counts: counts(data),
      data_quality: data.data_quality,
    }
    const result = evaluateInShadowMode(existing, context)
    jsonResponse(res, 200, { success: true, data: result })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleOperationalRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, data: filterRecords(data[route.collection], url.searchParams) })
    return
  }

  if (req.method === 'GET' && route.id) {
    const record = data[route.collection].find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Record not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && !route.id) {
    if (route.collection === 'action_logs') {
      jsonResponse(res, 405, { success: false, error: 'Action logs are read-only' })
      return
    }
    const body = await readRequestJson(req)
    const record = buildCreate(route.collection, body, data)
    const log = actionLog(route.collection, 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    if (route.collection === 'incidents') {
      try {
        await emit(store, 'incident.created', record)
      } catch (emitError) {
        // Swallow emit errors
      }
    }
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return
  }

  if (req.method === 'PATCH' && route.id) {
    if (route.collection === 'action_logs') {
      jsonResponse(res, 405, { success: false, error: 'Action logs are read-only' })
      return
    }
    const body = await readRequestJson(req)
    const existing = data[route.collection].find((item) => item.id === route.id)
    const record = buildUpdate(route.collection, existing, { ...body, id: route.id }, data)
    const log = actionLog(route.collection, 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleWebhookRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.webhook_subscriptions || [], url.searchParams) })
    return
  }

  if (req.method === 'GET' && route.id) {
    const record = (data.webhook_subscriptions || []).find((item) => item.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Webhook subscription not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    try {
      const record = normalizeWebhookSubscription(body)
      const log = actionLog('webhook_subscriptions', 'created', record, body.actor, req.__auth?.subject)
      await store.merge({ webhook_subscriptions: [record], action_logs: [log] })
      jsonResponse(res, 201, { success: true, data: record, action_log: log })
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
    }
    return
  }

  if (req.method === 'PATCH' && route.id) {
    const body = await readRequestJson(req)
    const existing = (data.webhook_subscriptions || []).find((item) => item.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Webhook subscription not found' })
      return
    }
    try {
      const record = normalizeWebhookSubscription({ ...body, id: route.id }, existing)
      const log = actionLog('webhook_subscriptions', 'updated', record, body.actor, req.__auth?.subject)
      await store.merge({ webhook_subscriptions: [record], action_logs: [log] })
      jsonResponse(res, 200, { success: true, data: record, action_log: log })
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
    }
    return
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

function matchWebhookRoute(pathname) {
  const match = pathname.match(/^\/api\/v1\/webhooks(?:\/([^/]+))?$/)
  if (!match) return null
  return { id: match[1] ? decodeURIComponent(match[1]) : null }
}

function matchScenarioRoute(pathname) {
  if (pathname === '/api/v1/scenarios') return { kind: 'create' }
  const match = pathname.match(/^\/api\/v1\/scenarios\/([^/]+)$/)
  if (match) return { kind: 'retrieve', token: decodeURIComponent(match[1]) }
  return null
}

function matchOperationalRoute(pathname) {
  const routes = {
    incidents: 'incidents',
    interventions: 'interventions',
    tasks: 'intervention_tasks',
    'field-reports': 'field_reports',
    'response-resources': 'response_resources',
    'action-logs': 'action_logs',
  }
  const match = pathname.match(/^\/api\/v1\/([^/]+)(?:\/([^/]+))?$/)
  if (!match || !routes[match[1]]) return null
  return { collection: routes[match[1]], id: match[2] ? decodeURIComponent(match[2]) : null }
}

function matchIngestionRoute(pathname) {
  if (pathname === '/api/v1/ingest/status') return { kind: 'status' }
  if (pathname === '/api/v1/ingest/run-due') return { kind: 'run-due' }
  if (pathname === '/api/v1/ingest/schedules/defaults') return { kind: 'defaults' }
  const runOne = pathname.match(/^\/api\/v1\/ingest\/schedules\/([^/]+)\/run$/)
  if (runOne) return { kind: 'run-one', id: decodeURIComponent(runOne[1]) }
  const schedule = pathname.match(/^\/api\/v1\/ingest\/schedules(?:\/([^/]+))?$/)
  if (schedule) return { kind: 'schedules', id: schedule[1] ? decodeURIComponent(schedule[1]) : null }
  return null
}

function matchReportingRoute(pathname) {
  if (pathname === '/api/v1/report-schedules/run-due') return { kind: 'schedules', action: 'run-due' }
  const scheduleRunAction = pathname.match(/^\/api\/v1\/report-schedule-runs\/([^/]+)\/(retry)$/)
  if (scheduleRunAction) return { kind: 'schedule-runs', id: decodeURIComponent(scheduleRunAction[1]), action: scheduleRunAction[2] }
  const reportExport = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/export\.(md|json|csv|geojson)$/)
  if (reportExport) return { kind: 'reports', id: decodeURIComponent(reportExport[1]), exportFormat: reportExport[2] }
  const templateAction = pathname.match(/^\/api\/v1\/report-templates\/([^/]+)\/(copy)$/)
  if (templateAction) return { kind: 'templates', id: decodeURIComponent(templateAction[1]), action: templateAction[2] }
  const reportAction = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/(generate|approve|distribute)$/)
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

function matchAlertRoute(pathname) {
  const capMatch = pathname.match(/^\/api\/v1\/alert-events\/([^/]+)\.cap$/)
  if (capMatch) return { collection: 'alert_events', id: decodeURIComponent(capMatch[1]), format: 'cap' }
  const actionMatch = pathname.match(/^\/api\/v1\/alert-events\/([^/]+)\/(approve|reject)$/)
  if (actionMatch) return { collection: 'alert_events', id: decodeURIComponent(actionMatch[1]), action: actionMatch[2] }
  const routes = {
    'alert-rules': 'alert_rules',
    'alert-events': 'alert_events',
  }
  const match = pathname.match(/^\/api\/v1\/([^/]+)(?:\/([^/]+))?$/)
  if (!match || !routes[match[1]]) return null
  return { collection: routes[match[1]], id: match[2] ? decodeURIComponent(match[2]) : null }
}

function matchTriggerRoute(pathname) {
  const backtest = pathname.match(/^\/api\/v1\/trigger-protocols\/([^/]+)\/backtest$/)
  if (backtest) return { id: decodeURIComponent(backtest[1]), action: 'backtest' }
  const shadowRun = pathname.match(/^\/api\/v1\/trigger-protocols\/([^/]+)\/shadow-run$/)
  if (shadowRun) return { id: decodeURIComponent(shadowRun[1]), action: 'shadow-run' }
  const match = pathname.match(/^\/api\/v1\/trigger-protocols(?:\/([^/]+))?$/)
  if (!match) return null
  return { id: match[1] ? decodeURIComponent(match[1]) : null }
}

function matchRapidProRoute(pathname) {
  if (pathname === '/api/v1/rapidpro/status') return { kind: 'status' }
  if (pathname === '/api/v1/rapidpro/response-metrics') return { kind: 'response-metrics' }
  if (pathname === '/api/v1/rapidpro/dispatches') return { kind: 'dispatches' }
  if (pathname === '/api/v1/rapidpro/inbound') return { kind: 'inbound' }
  if (pathname === '/api/v1/rapidpro/field-report') return { kind: 'field-report' }
  const sendAlert = pathname.match(/^\/api\/v1\/rapidpro\/alert-events\/([^/]+)\/send$/)
  if (sendAlert) return { kind: 'send-alert', id: decodeURIComponent(sendAlert[1]) }
  return null
}

function matchWorkflowRoute(pathname) {
  const transition = pathname.match(/^\/api\/v1\/workflows\/([^/]+)\/transition$/)
  if (transition) return { id: decodeURIComponent(transition[1]), action: 'transition' }
  if (pathname === '/api/v1/workflows/metrics') return { action: 'metrics' }
  const match = pathname.match(/^\/api\/v1\/workflows(?:\/([^/]+))?$/)
  if (!match) return null
  return { id: match[1] ? decodeURIComponent(match[1]) : null }
}

async function handleWorkflowRoute(store, data, req, res, url, route) {
  if (req.method === 'GET' && !route.id && !route.action) {
    const records = filterRecords(data.workflow_instances, url.searchParams)
    jsonResponse(res, 200, { success: true, data: records })
    return
  }

  if (req.method === 'GET' && route.id && !route.action) {
    const record = data.workflow_instances.find((w) => w.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Workflow not found' })
      return
    }
    jsonResponse(res, 200, { success: true, data: record })
    return
  }

  if (req.method === 'GET' && route.action === 'metrics') {
    const metrics = workflowMetrics(data.workflow_instances)
    jsonResponse(res, 200, { success: true, data: metrics })
    return
  }

  if (req.method === 'POST' && !route.id && !route.action) {
    const body = await readRequestJson(req)
    const record = normalizeWorkflowInstance(body)
    const outboxRecord = await emit(store, 'workflow.created', { workflow_id: record.id, type: record.type })
    await store.merge({ workflow_instances: [record] })
    metrics.counter('workflow_created', { type: record.type })
    jsonResponse(res, 201, { success: true, data: record, outbox_event: outboxRecord.id })
    return
  }

  if (req.method === 'POST' && route.id && route.action === 'transition') {
    const existing = data.workflow_instances.find((w) => w.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Workflow not found' })
      return
    }
    const body = await readRequestJson(req)
    try {
      const updated = transitionWorkflow(existing, {
        to: body.to,
        actor: req.__auth?.subject || 'anonymous',
        reason: body.reason || '',
        evidence: body.evidence || '',
      })
      const outboxRecord = await emit(store, 'workflow.transitioned', {
        workflow_id: updated.id,
        type: updated.type,
        from: existing.state,
        to: updated.state,
      })
      await store.merge({ workflow_instances: [updated] })
      metrics.counter('workflow_transition_total', { type: updated.type, from: existing.state, to: updated.state })
      jsonResponse(res, 200, { success: true, data: updated, outbox_event: outboxRecord.id })
      return
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
      return
    }
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
}

async function handleStatic(res, pathname) {
  if (pathname === '/docs' || pathname.startsWith('/docs/')) {
    await handleDocs(res, pathname)
    return
  }

  // Handle service worker
  if (pathname === '/sw.js') {
    try {
      const content = await fs.readFile(path.join(publicDir, 'sw.js'))
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(content)
      return
    } catch {
      jsonResponse(res, 404, { success: false, error: 'Not found' })
      return
    }
  }

  // Handle manifest
  if (pathname === '/manifest.webmanifest') {
    try {
      const content = await fs.readFile(path.join(publicDir, 'manifest.webmanifest'))
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' })
      res.end(content)
      return
    } catch {
      jsonResponse(res, 404, { success: false, error: 'Not found' })
      return
    }
  }

  // Handle icon
  if (pathname === '/icon.svg') {
    try {
      const content = await fs.readFile(path.join(publicDir, 'icon.svg'))
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      res.end(content)
      return
    } catch {
      jsonResponse(res, 404, { success: false, error: 'Not found' })
      return
    }
  }

  // Handle i18n catalogs
  if (pathname.startsWith('/i18n/') && pathname.endsWith('.json')) {
    try {
      const content = await fs.readFile(path.join(publicDir, pathname.slice(1)))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(content)
      return
    } catch {
      jsonResponse(res, 404, { success: false, error: 'Not found' })
      return
    }
  }

  const target = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const filePath = safeJoin(publicDir, target)
  try {
    const content = await fs.readFile(filePath)
    res.writeHead(200, { 'content-type': contentType(filePath) })
    res.end(content)
  } catch {
    const index = await fs.readFile(path.join(publicDir, 'index.html'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(index)
  }
}

async function handleDocs(res, pathname) {
  const target = pathname === '/docs' ? 'README.md' : pathname.replace(/^\/docs\/?/, '')
  let filePath
  try {
    filePath = safeJoin(docsDir, target)
  } catch {
    jsonResponse(res, 404, { success: false, error: 'Document not found' })
    return
  }
  try {
    const content = await fs.readFile(filePath)
    res.writeHead(200, { 'content-type': contentType(filePath) })
    res.end(content)
  } catch {
    jsonResponse(res, 404, { success: false, error: 'Document not found' })
  }
}

function safeJoin(rootDir, target) {
  const filePath = path.resolve(rootDir, target || '')
  const relative = path.relative(rootDir, filePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Path is outside document root'), { statusCode: 404 })
  }
  return filePath
}

function hasTraversalSegment(rawUrl) {
  const rawPath = rawUrl.split('?')[0]
  try {
    return decodeURIComponent(rawPath).split(/[\\/]+/).includes('..')
  } catch {
    return true
  }
}

async function getConnectorRegistry() {
  if (connectorRegistry === null) {
    try {
      const content = await fs.readFile(registryPath, 'utf8')
      connectorRegistry = JSON.parse(content)
    } catch {
      connectorRegistry = []
    }
  }
  return connectorRegistry
}

function getDefaultStore() {
  if (!defaultStorePromise) defaultStorePromise = createStoreFromEnv()
  return defaultStorePromise
}

function counts(data) {
  return {
    source_runs: data.source_runs.length,
    ingestion_schedules: data.ingestion_schedules.length,
    climate_observations: data.climate_observations.length,
    hazard_events: data.hazard_events.length,
    conflict_events: data.conflict_events.length,
    service_assets: data.service_assets.length,
    impact_assessments: data.impact_assessments.length,
    risk_scores: data.risk_scores.length,
    data_quality: data.data_quality.length,
    population_at_risk: data.population_at_risk?.length || 0,
    facilities_at_risk: data.facilities_at_risk?.length || 0,
    data_lineage: data.data_lineage?.length || 0,
    incidents: data.incidents.length,
    interventions: data.interventions.length,
    intervention_tasks: data.intervention_tasks.length,
    field_reports: data.field_reports.length,
    response_resources: data.response_resources.length,
    action_logs: data.action_logs.length,
    alert_rules: data.alert_rules.length,
    alert_events: data.alert_events.length,
    trigger_protocols: data.trigger_protocols?.length || 0,
    rapidpro_dispatches: data.rapidpro_dispatches.length,
    rapidpro_inbound_messages: data.rapidpro_inbound_messages.length,
    report_templates: data.report_templates.length,
    reports: data.reports.length,
    report_distribution_runs: data.report_distribution_runs.length,
    report_schedules: data.report_schedules.length,
    report_schedule_runs: data.report_schedule_runs.length,
  }
}

function required(value, field) {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error(`${field} is required`), { statusCode: 400 })
  }
  return value
}

function contentType(filePath) {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'text/yaml; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'text/html; charset=utf-8'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.LINDELA_LITE_PORT || 4177)
  createServer().listen(port, () => {
    console.log(`Lindela Lite listening on http://127.0.0.1:${port}`)
  })
}

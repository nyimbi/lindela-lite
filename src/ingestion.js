import { BLOCKED_SOURCE_IDS, INGESTION_SCHEDULE_STATUSES, SOURCE_IDS } from './schema.js'
import { nowIso, stableId, toNumber } from './utils.js'
import { metrics } from './observability.js'
import { openMeteoConnector } from './connectors/open-meteo.js'
import { gdacsConnector } from './connectors/gdacs.js'
import { glofasConnector } from './connectors/glofas.js'
import { chirpsConnector } from './connectors/chirps.js'
import { nasaFirmsConnector } from './connectors/nasa-firms.js'
import { acledCsvConnector, conflictCsvConnector, serviceAssetsConnector } from './connectors/uploads.js'

const CONNECTORS = Object.freeze({
  open_meteo: openMeteoConnector,
  gdacs: gdacsConnector,
  glofas: glofasConnector,
  chirps: chirpsConnector,
  nasa_firms: nasaFirmsConnector,
  service_assets: serviceAssetsConnector,
  acled_csv: acledCsvConnector,
  conflict_csv: conflictCsvConnector,
})

export const PUBLIC_INGESTION_SOURCES = Object.freeze([
  'open_meteo',
  'gdacs',
  'glofas',
  'chirps',
  'nasa_firms',
])

export const SOURCE_POLICIES = Object.freeze({
  open_meteo: { interval_minutes: 180, timeout_ms: 20000, retries: 2, stale_after_minutes: 360, minimum_records: 1, regular: true },
  gdacs: { interval_minutes: 60, timeout_ms: 20000, retries: 2, stale_after_minutes: 180, minimum_records: 0, regular: true },
  glofas: { interval_minutes: 180, timeout_ms: 20000, retries: 2, stale_after_minutes: 360, minimum_records: 0, regular: true },
  chirps: { interval_minutes: 720, timeout_ms: 20000, retries: 2, stale_after_minutes: 1440, minimum_records: 1, regular: true },
  nasa_firms: { interval_minutes: 360, timeout_ms: 30000, retries: 2, stale_after_minutes: 720, minimum_records: 0, regular: true },
  service_assets: { interval_minutes: null, timeout_ms: 5000, retries: 0, stale_after_minutes: null, minimum_records: 0, regular: false },
  acled_csv: { interval_minutes: null, timeout_ms: 5000, retries: 0, stale_after_minutes: null, minimum_records: 0, regular: false },
  conflict_csv: { interval_minutes: null, timeout_ms: 5000, retries: 0, stale_after_minutes: null, minimum_records: 0, regular: false },
})

export function getConnector(sourceId) {
  if (BLOCKED_SOURCE_IDS.includes(sourceId)) {
    throw new Error(`${sourceId} ingestion is intentionally excluded from Lindela Lite`)
  }
  const connector = CONNECTORS[sourceId]
  if (!connector) throw new Error(`Unknown source: ${sourceId}`)
  return connector
}

export async function runIngestion(store, request = {}) {
  const requestedSources = request.sources?.length ? request.sources : PUBLIC_INGESTION_SOURCES
  for (const source of requestedSources) {
    if (BLOCKED_SOURCE_IDS.includes(source)) {
      throw new Error(`${source} ingestion is intentionally excluded from Lindela Lite`)
    }
    if (!SOURCE_IDS.includes(source)) throw new Error(`Unknown source: ${source}`)
  }

  const source_runs = []
  const merged = {
    climate_observations: [],
    hazard_events: [],
    conflict_events: [],
    service_assets: [],
  }

  for (const source of requestedSources) {
    const startedAt = nowIso()
    const connector = getConnector(source)
    const policy = SOURCE_POLICIES[source] || {}
    const sourceRequest = {
      ...request,
      source,
      timeout_ms: toNumber(request.timeout_ms ?? request.timeoutMs ?? policy.timeout_ms, policy.timeout_ms || 20000),
      retries: toNumber(request.retries ?? policy.retries, policy.retries || 0),
    }
    let status = 'success'
    let errors = []
    let output = {}
    let attempts = 0
    try {
      output = await runConnectorWithRetries(connector, sourceRequest)
      attempts = output.__attempts || 1
      errors = output.errors || []
      const records = countRecords(output)
      if (errors.length || records < (policy.minimum_records || 0)) status = 'degraded'
      if (records < (policy.minimum_records || 0)) {
        errors = [...errors, `Expected at least ${policy.minimum_records} records for ${source}; received ${records}.`]
      }
    } catch (error) {
      status = 'failed'
      errors = [error.message]
      attempts = error.attempts || 1
    }

    for (const key of Object.keys(merged)) {
      merged[key].push(...(output[key] || []))
    }

    const completedAt = nowIso()
    const durationMs = Date.now() - Date.parse(startedAt)
    const recordsProcessed = countRecords(output)

    source_runs.push({
      id: stableId('run', [source, startedAt, status, errors]),
      source,
      status,
      run_type: request.run_type || (request.schedule_id ? 'scheduled' : 'manual'),
      schedule_id: request.schedule_id || null,
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: recordsProcessed,
      records_by_collection: countRecordsByCollection(output),
      errors,
      diagnostics: buildDiagnostics(output, errors, {
        attempts,
        timeout_ms: sourceRequest.timeout_ms,
        retries: sourceRequest.retries,
        interval_minutes: request.interval_minutes ?? policy.interval_minutes ?? null,
        stale_after_minutes: request.stale_after_minutes ?? policy.stale_after_minutes ?? null,
        duration_ms: durationMs,
      }),
    })

    metrics.counter('ingestion_runs_total', { source, status })
    metrics.histogram('ingestion_duration_ms', durationMs, { source })
  }

  const data = await store.merge({ ...merged, source_runs })
  return {
    source_runs,
    counts: {
      climate_observations: merged.climate_observations.length,
      hazard_events: merged.hazard_events.length,
      conflict_events: merged.conflict_events.length,
      service_assets: merged.service_assets.length,
    },
    data,
  }
}

export function normalizeIngestionSchedule(input = {}, existing = null) {
  const source = input.source || existing?.source || required(null, 'source')
  validateSources([source])
  const policy = SOURCE_POLICIES[source] || {}
  const now = nowIso()
  const interval = toNumber(input.interval_minutes ?? existing?.interval_minutes ?? policy.interval_minutes, policy.interval_minutes)
  const createdAt = existing?.created_at || input.created_at || now
  return stripUndefined({
    id: existing?.id || input.id || stableId('ingestion_schedule', [source, input.name || existing?.name || source, createdAt]),
    name: input.name || existing?.name || `${source} regular ingestion`,
    source,
    status: enumValue(input.status || existing?.status || 'active', INGESTION_SCHEDULE_STATUSES, 'status'),
    interval_minutes: interval,
    timeout_ms: toNumber(input.timeout_ms ?? existing?.timeout_ms ?? policy.timeout_ms, policy.timeout_ms),
    retries: toNumber(input.retries ?? existing?.retries ?? policy.retries, policy.retries || 0),
    stale_after_minutes: toNumber(input.stale_after_minutes ?? existing?.stale_after_minutes ?? policy.stale_after_minutes, policy.stale_after_minutes),
    next_run_at: input.next_run_at || existing?.next_run_at || computeNextIngestionRunAt({ interval_minutes: interval }, now),
    last_run_at: input.last_run_at || existing?.last_run_at || null,
    default_options: objectValue(input.default_options ?? existing?.default_options),
    owner: input.owner || existing?.owner || 'ops',
    created_at: createdAt,
    updated_at: now,
    metadata: objectValue(input.metadata ?? existing?.metadata),
  })
}

export function defaultIngestionSchedules(data = {}, options = {}) {
  const existingSources = new Set((data.ingestion_schedules || []).map((schedule) => schedule.source))
  const sources = options.sources?.length ? options.sources : PUBLIC_INGESTION_SOURCES
  return sources
    .filter((source) => !existingSources.has(source))
    .map((source) => normalizeIngestionSchedule({ source, next_run_at: options.next_run_at }))
}

export async function runDueIngestionSchedules(store, data, options = {}) {
  const due = (data.ingestion_schedules || []).filter((schedule) => ingestionScheduleIsDue(schedule, options.now))
  const runs = []
  const schedules = []
  const analytics = []
  for (const schedule of due) {
    const result = await runIngestion(store, {
      ...(schedule.default_options || {}),
      sources: [schedule.source],
      timeout_ms: schedule.timeout_ms,
      retries: schedule.retries,
      interval_minutes: schedule.interval_minutes,
      stale_after_minutes: schedule.stale_after_minutes,
      schedule_id: schedule.id,
      run_type: 'scheduled',
    })
    runs.push(...result.source_runs)
    const completedAt = result.source_runs[0]?.completed_at || nowIso()
    schedules.push({
      ...schedule,
      last_run_at: completedAt,
      next_run_at: computeNextIngestionRunAt(schedule, completedAt),
      updated_at: nowIso(),
    })
    analytics.push(result)
  }
  if (schedules.length) await store.merge({ ingestion_schedules: schedules })
  return { schedules, source_runs: runs, analytics }
}

export function ingestionScheduleIsDue(schedule, now = new Date()) {
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now)
  return schedule.status === 'active' && schedule.next_run_at && Date.parse(schedule.next_run_at) <= timestamp
}

export function computeNextIngestionRunAt(schedule, from = nowIso()) {
  const interval = toNumber(schedule.interval_minutes, null)
  if (!interval) return null
  return new Date(Date.parse(from) + interval * 60 * 1000).toISOString()
}

export function ingestionStatus(data) {
  const schedules = data.ingestion_schedules || []
  const runs = data.source_runs || []
  return SOURCE_IDS.filter((source) => !BLOCKED_SOURCE_IDS.includes(source)).map((source) => {
    const policy = SOURCE_POLICIES[source] || {}
    const sourceRuns = runs.filter((run) => run.source === source)
    const lastRun = sourceRuns[0] || null
    const lastSuccess = sourceRuns.find((run) => run.status === 'success') || null
    const schedule = schedules.find((item) => item.source === source && item.status !== 'archived') || null
    const staleAfter = schedule?.stale_after_minutes ?? policy.stale_after_minutes
    return {
      source,
      regular: Boolean(policy.regular),
      status: sourceHealth(lastRun, staleAfter),
      last_run: lastRun,
      last_success: lastSuccess,
      failure_streak: failureStreak(sourceRuns),
      schedule,
      policy,
    }
  })
}

function validateSources(sources) {
  for (const source of sources) {
    if (BLOCKED_SOURCE_IDS.includes(source)) {
      throw new Error(`${source} ingestion is intentionally excluded from Lindela Lite`)
    }
    if (!SOURCE_IDS.includes(source)) throw new Error(`Unknown source: ${source}`)
  }
}

async function runConnectorWithRetries(connector, request) {
  const sourceRetries = Math.max(toNumber(request.retries ?? request.source_retries, 0), 0)
  let lastError
  for (let attempt = 0; attempt <= sourceRetries; attempt += 1) {
    try {
      const output = await connector.ingest(request)
      return { ...output, __attempts: attempt + 1 }
    } catch (error) {
      lastError = error
      lastError.attempts = attempt + 1
      if (attempt < sourceRetries) await delay(Math.min(1000 * (2 ** attempt), 5000))
    }
  }
  throw lastError
}

function countRecords(output) {
  return ['climate_observations', 'hazard_events', 'conflict_events', 'service_assets']
    .reduce((total, key) => total + (output?.[key]?.length || 0), 0)
}


function countRecordsByCollection(output) {
  return Object.fromEntries(['climate_observations', 'hazard_events', 'conflict_events', 'service_assets']
    .map((key) => [key, output?.[key]?.length || 0]))
}

function buildDiagnostics(output, errors, metadata = {}) {
  return {
    degraded: Boolean(errors?.length),
    error_count: errors?.length || 0,
    records_by_collection: countRecordsByCollection(output),
    ...metadata,
  }
}

function sourceHealth(lastRun, staleAfterMinutes) {
  if (!lastRun) return 'never_run'
  if (lastRun.status === 'failed') return 'failed'
  const completed = Date.parse(lastRun.completed_at || lastRun.started_at || '')
  if (staleAfterMinutes && Number.isFinite(completed)) {
    const ageMinutes = (Date.now() - completed) / 60000
    if (ageMinutes > staleAfterMinutes) return 'stale'
  }
  if (lastRun.status === 'degraded') return 'degraded'
  return 'fresh'
}

function failureStreak(runs) {
  let count = 0
  for (const run of runs) {
    if (run.status !== 'failed') break
    count += 1
  }
  return count
}

function required(value, field) {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error(`${field} is required`), { statusCode: 400 })
  }
  return value
}

function enumValue(value, allowed, field) {
  const normalized = String(value || '').toLowerCase()
  if (!allowed.includes(normalized)) {
    throw Object.assign(new Error(`${field} must be one of ${allowed.join(', ')}`), { statusCode: 400 })
  }
  return normalized
}

function objectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

import { BLOCKED_SOURCE_IDS, INGESTION_SCHEDULE_STATUSES, SOURCE_IDS } from './schema.js'
import { nowIso, stableId, toNumber, canonicalHash } from './utils.js'
import { metrics } from './observability.js'
import { openMeteoConnector } from './connectors/open-meteo.js'
import { gdacsConnector } from './connectors/gdacs.js'
import { glofasConnector } from './connectors/glofas.js'
import { chirpsConnector } from './connectors/chirps.js'
import { nasaFirmsConnector } from './connectors/nasa-firms.js'
import { usgsEarthquakeConnector } from './connectors/usgs-earthquake.js'
import { noaaNinoConnector } from './connectors/noaa-enso.js'
import { ipcHdxConnector } from './connectors/ipc-hdx.js'
import { whoGhoConnector } from './connectors/who-gho.js'
import { gdacsArchiveConnector } from './connectors/gdacs-archive.js'
import { openMeteoArchiveConnector } from './connectors/open-meteo-archive.js'
import { openMeteoFloodConnector } from './connectors/open-meteo-flood.js'
import { acledCsvConnector, conflictCsvConnector, serviceAssetsConnector } from './connectors/uploads.js'
import { dhis2Connector } from './connectors/dhis2.js'
import { allowRequest, createCircuitState, outcomesFromRuns, recordOutcome, scoreConnector } from './circuit.js'
import { COMPLETENESS_VERDICTS, completenessVerdictName } from './completeness.js'
import { runAssertions, quarantineRecords, quarantineCollectionName } from './assertions.js'
import { buildProvenance, recordLineageRow } from './provenance.js'
import { explainVerdict } from './freshness.js'
import { beginFetchRecording, endFetchRecording } from './connectors/http.js'

const CONNECTORS = Object.freeze({
  open_meteo: openMeteoConnector,
  gdacs: gdacsConnector,
  glofas: glofasConnector,
  chirps: chirpsConnector,
  nasa_firms: nasaFirmsConnector,
  usgs_earthquake: usgsEarthquakeConnector,
  noaa_enso: noaaNinoConnector,
  ipc_hdx: ipcHdxConnector,
  who_gho: whoGhoConnector,
  gdacs_archive: gdacsArchiveConnector,
  open_meteo_archive: openMeteoArchiveConnector,
  open_meteo_flood: openMeteoFloodConnector,
  service_assets: serviceAssetsConnector,
  acled_csv: acledCsvConnector,
  conflict_csv: conflictCsvConnector,
  dhis2: dhis2Connector,
})

export const PUBLIC_INGESTION_SOURCES = Object.freeze([
  'open_meteo',
  'gdacs',
  'glofas',
  'chirps',
  'nasa_firms',
  'usgs_earthquake',
  'noaa_enso',
  'ipc_hdx',
  'who_gho',
  // The historical backfills are deliberately NOT here: PUBLIC sources
  // are the default run set, and a default run must not re-walk 40 years of a
  // free archive. They run on explicit request — see docs/ingestion.md.
])

export const SOURCE_POLICIES = Object.freeze({
  open_meteo: { interval_minutes: 180, timeout_ms: 20000, retries: 2, stale_after_minutes: 360, minimum_records: 1, regular: true },
  // minimum_records is 1 rather than 0 for every source that is expected to
  // return something. With 0, a connector that silently parses nothing still
  // reports status "success", which is how CHIRPS, GloFAS, and NASA FIRMS all
  // hid broken ingestion. Verified 2026-10-01 across repeated runs: gdacs
  // returns 222 and usgs_earthquake 46, so a zero result means something broke.
  gdacs: { interval_minutes: 60, timeout_ms: 20000, retries: 2, stale_after_minutes: 180, minimum_records: 1, regular: true },
  glofas: { interval_minutes: 180, timeout_ms: 20000, retries: 2, stale_after_minutes: 360, minimum_records: 1, regular: true },
  chirps: { interval_minutes: 720, timeout_ms: 20000, retries: 2, stale_after_minutes: 1440, minimum_records: 1, regular: true },
  nasa_firms: { interval_minutes: 360, timeout_ms: 30000, retries: 2, stale_after_minutes: 720, minimum_records: 1, regular: true },
  usgs_earthquake: { interval_minutes: 60, timeout_ms: 20000, retries: 2, stale_after_minutes: 180, minimum_records: 1, regular: true },
  noaa_enso: { interval_minutes: 720, timeout_ms: 20000, retries: 2, stale_after_minutes: 1440, minimum_records: 1, regular: true },
  // IPC classifications come out per analysis month and HDX scrapes them
  // promptly, so 24 h beats the feed without hammering a 3.6 MB CSV. WHO GHO
  // publishes yearly, so its staleness window is long: a national-annual
  // figure is "stale" here only when something breaks, not week to week.
  ipc_hdx: { interval_minutes: 1440, timeout_ms: 30000, retries: 2, stale_after_minutes: 2880, minimum_records: 1, regular: true },
  who_gho: { interval_minutes: 1440, timeout_ms: 20000, retries: 2, stale_after_minutes: 20160, minimum_records: 1, regular: true },
  // Historical backfills, never on the regular schedule: a full gdacs_archive
  // walk is a paginated quarter-by-quarter crawl of 40 years, and re-running
  // it hourly would be abuse of a free service. They run on demand (public
  // ingestion or the ingestion run API) to stock training data.
  gdacs_archive: { interval_minutes: 0, timeout_ms: 30000, retries: 2, stale_after_minutes: 43200, minimum_records: 1, regular: false },
  open_meteo_archive: { interval_minutes: 0, timeout_ms: 60000, retries: 2, stale_after_minutes: 43200, minimum_records: 1, regular: false },
  open_meteo_flood: { interval_minutes: 0, timeout_ms: 60000, retries: 2, stale_after_minutes: 43200, minimum_records: 1, regular: false },
  service_assets: { interval_minutes: null, timeout_ms: 5000, retries: 0, stale_after_minutes: null, minimum_records: 0, regular: false },
  acled_csv: { interval_minutes: null, timeout_ms: 5000, retries: 0, stale_after_minutes: null, minimum_records: 0, regular: false },
  conflict_csv: { interval_minutes: null, timeout_ms: 5000, retries: 0, stale_after_minutes: null, minimum_records: 0, regular: false },
  dhis2: { interval_minutes: 360, timeout_ms: 20000, retries: 1, stale_after_minutes: 720, minimum_records: 0, regular: false },
})

export function getConnector(sourceId, connectors = CONNECTORS) {
  if (BLOCKED_SOURCE_IDS.includes(sourceId)) {
    throw new Error(`${sourceId} ingestion is intentionally excluded from Lindela Lite`)
  }
  const connector = connectors[sourceId]
  if (!connector) throw new Error(`Unknown source: ${sourceId}`)
  return connector
}

/**
 * `options.connectors` overrides the built-in connector map. It exists so the
 * ingestion path can be driven end to end in tests without network access —
 * the registration guards for the silent-key-list bug class used to assert on
 * source text precisely because they could not do this.
 */
export async function runIngestion(store, request = {}, { connectors = CONNECTORS } = {}) {
  const requestedSources = request.sources?.length ? request.sources : PUBLIC_INGESTION_SOURCES
  for (const source of requestedSources) {
    if (BLOCKED_SOURCE_IDS.includes(source)) {
      throw new Error(`${source} ingestion is intentionally excluded from Lindela Lite`)
    }
    if (!SOURCE_IDS.includes(source)) throw new Error(`Unknown source: ${source}`)
  }

  const source_runs = []
  const merged = Object.fromEntries(OUTPUT_COLLECTIONS.map((key) => [key, []]))

  // Per-source fetch position, read once at the start of the run. A second read
  // mid-run would see a different snapshot from the one the sources were seeded
  // against, and the run would resume from a position it never started at.
  // A store without `read` has no watermarks, which is true rather than a
  // failure: the in-process tests pass a merge-only stub, and a connector run
  // against one simply starts from the beginning of its series.
  const existingWatermarks = typeof store.read === 'function'
    ? (await store.read()).watermark_state || []
    : []
  const watermarkBySource = new Map(existingWatermarks.map((row) => [row.source, row.state || {}]))
  // What each source returns this run, written back after every source has
  // finished — a partial write mid-run would leave the store claiming a position
  // the run never reached.
  const nextWatermarks = []
  const quarantined = Object.fromEntries(OUTPUT_COLLECTIONS.map((key) => [quarantineCollectionName(key), []]))
  const provenance_by_run = new Map()
  // ENH-10. Per-run, not per-process: the breaker exists to stop one dead
  // source being retried inside one run and eating the wall-clock budget the
  // healthy ones need. Carrying it across runs would mean persisting circuit
  // state, which is a bigger claim than this item makes.
  let circuitState = createCircuitState()

  for (const source of requestedSources) {
    const startedAt = nowIso()
    const connector = getConnector(source, connectors)
    const policy = SOURCE_POLICIES[source] || {}
    const sourceRequest = {
      ...request,
      source,
      // What this source last fetched, so it fetches only what is new.
      // The connector contract already accepted and returned this; nothing
      // supplied it, so every run started from the beginning of the series and
      // re-downloaded forty years of ERA5 to discover nothing was new.
      watermark_state: watermarkBySource.get(source) || {},
      timeout_ms: toNumber(request.timeout_ms ?? request.timeoutMs ?? policy.timeout_ms, policy.timeout_ms || 20000),
      retries: toNumber(request.retries ?? policy.retries, policy.retries || 0),
    }
    let status = 'success'
    let errors = []
    let output = {}
    let attempts = 0
    let verdict = 'ok'
    let assertionReport = null
    let provenance = []

    // ENH-10. `failure_streak` was computed by this file and acted on by
    // nothing: a dead source was retried in full on every run-due tick,
    // consuming the wall-clock budget the healthy sources need. The gate goes
    // before the fetch, and its skip is recorded as a distinct verdict — three
    // different situations that all render as "the source didn't update" are how
    // a working pipeline and a dead one come to report the same thing.
    const gate = allowRequest(circuitState, source)
    if (!gate.allowed) {
      source_runs.push({
        id: stableId('run', [source, startedAt, verdict, [gate.reason]]),
        source,
        status: 'skipped',
        verdict: gate.reason,
        run_type: request.run_type || (request.schedule_id ? 'scheduled' : 'manual'),
        schedule_id: request.schedule_id || null,
        started_at: startedAt,
        completed_at: nowIso(),
        records_processed: 0,
        records_by_collection: emptyCounts(),
        errors: [],
        diagnostics: {
          degraded: false,
          error_count: 0,
          records_by_collection: emptyCounts(),
          attempts: 0,
          skipped_reason: gate.reason,
          circuit_state: gate.state,
        },
      })
      metrics.counter('ingestion_runs_total', { source, status: gate.reason })
      continue
    }

    try {
      // ENH-15. Name the run before fetching, so every URL the connector
      // pulls through http.js is attributable to it. Without this the lineage
      // row cannot say where the data came from, because no connector exposes
      // the URLs it builds internally.
      beginFetchRecording(`${source}:${startedAt}`)
      output = await runConnectorWithRetries(connector, sourceRequest)
      // A connector that returns no state keeps the state it was given. Treating
      // the absence as a reset would lose the position on any connector that
      // has not been wired up yet.
      if (output && output.watermark_state) {
        nextWatermarks.push({
          id: `watermark_${source}`,
          type: 'watermark_state',
          source,
          state: output.watermark_state,
          updated_at: new Date().toISOString(),
        })
      }
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

    // ENH-14, captured before the assertions below can replace `output`. A
    // quarantined batch is rebuilt from `OUTPUT_COLLECTIONS` alone, so
    // `output = assertionReport.published` drops every non-collection key the
    // connector returned — `completeness` among them. Reading it after that
    // point reports null for exactly the runs worth reporting: the ones whose
    // records were held back, which is when an operator most needs to know the
    // walk was also truncated.
    const connectorsCompleteness = output?.completeness

    // ENH-10. The outcome feeds the breaker whether the fetch succeeded or not,
    // and `recordOutcome` releases the half-open probe. Recorded after the
    // attempt rather than inside the try so a thrown connector still counts —
    // a failure that does not reach the breaker is precisely the one that keeps
    // a dead source being retried in full.
    circuitState = recordOutcome(circuitState, source, {
      ok: status !== 'failed',
      latencyMs: Date.now() - Date.parse(startedAt),
      recordCount: countRecords(output),
    })

    // The run id is computed before the records are stamped, because the
    // stamp is what lets the lineage loop below attribute records to the run
    // that produced them. It used to be computed afterwards, from a status and
    // an error list that the stamping could not influence.
    const runId = stableId('run', [source, startedAt, status, errors])

    // ENH-15. Provenance per record, built before the batch is merged so the
    // `_provenance` envelope travels with the row rather than being inferred
    // afterwards from whatever survived. `transform_version` comes from the
    // hashing of the code that did the transforming, so editing a connector's
    // mapping changes the version it stamps.
    const runRecords = OUTPUT_COLLECTIONS.flatMap((key) => output[key] || [])
    const retrievalUrl = endFetchRecording(`${source}:${startedAt}`)[0]?.url || null
    provenance = buildProvenance({
      sourceRun: { id: runId, source },
      connector: { id: source },
      records: runRecords,
      retrieval: { url: retrievalUrl, retrieved_at: startedAt },
      transform: connector.transform || connector.ingest || null,
    })

    // ENH-07. Assertions run before anything is published. A batch that fails
    // them is quarantined rather than merged, and rather than reported as zero:
    // the GDACS archive silently caps at ~100 results per query, so a run
    // returning 4,000 of 40,000 parses cleanly and reports success. Nothing in
    // the codebase noticed for the life of the product.
    if (status !== 'failed') {
      assertionReport = runSourceAssertions({ source, output })
      if (assertionReport && !assertionReport.ok) {
        status = 'degraded'
        errors = [...errors, ...assertionReport.failures.map((f) => f.message)]
        output = assertionReport.published
      }
    }

    for (const key of Object.keys(merged)) {
      const records = output[key] || []
      for (const record of records) {
        if (!record.payload_hash) {
          record.payload_hash = canonicalHash(record)
        }
        if (!record.first_seen_at) {
          record.first_seen_at = nowIso()
        }
        // ENH-15. The attribution the lineage loop needs to write one row per
        // source run rather than nine rows describing all of them.
        record._source_run_id = runId
        record._source = source
      }
      merged[key].push(...records)
    }

    // Quarantined batches are stored apart from published ones, with the
    // assertion that condemned them attached. A condemned batch is a finding
    // to be read, not a zero to be averaged.
    if (assertionReport && !assertionReport.ok) {
      for (const [collection, rows] of Object.entries(assertionReport.quarantined)) {
        quarantined[collection]?.push(...rows)
      }
    }
    provenance_by_run.set(runId, provenance)

    const completedAt = nowIso()
    const durationMs = Date.now() - Date.parse(startedAt)
    const recordsProcessed = countRecords(output)

    // ENH-14. The completeness verdict used to exist only on the connector's
    // return value, which is where a direct caller in a test reads it and
    // where nobody else ever looks. The connector put it in `errors` as prose
    // and this loop counted errors into a `degraded` flag, so a walk that
    // fetched 30 of 730 files and a walk that fetched 730 with a parser warning
    // both arrived as `degraded` — the one signal an operator acts on, and it
    // could not tell them apart.
    //
    // Promoted to a field on the run record, as a name from the frozen
    // vocabulary rather than as a boolean, and `null` when the connector
    // reported no completeness at all. The null matters: `complete` would be a
    // claim that a source with no pagination was checked and found whole, and
    // half the connectors have no completeness block because they never walk a
    // page. That is "not measurable", not "measured and fine".
    const completeness = normaliseCompleteness(connectorsCompleteness)

    source_runs.push({
      id: runId,
      source,
      status,
      run_type: request.run_type || (request.schedule_id ? 'scheduled' : 'manual'),
      schedule_id: request.schedule_id || null,
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: recordsProcessed,
      records_by_collection: countRecordsByCollection(output),
      completeness,
      errors,
      diagnostics: buildDiagnostics(output, errors, {
        attempts,
        timeout_ms: sourceRequest.timeout_ms,
        retries: sourceRequest.retries,
        interval_minutes: request.interval_minutes ?? policy.interval_minutes ?? null,
        stale_after_minutes: request.stale_after_minutes ?? policy.stale_after_minutes ?? null,
        duration_ms: durationMs,
        // ENH-14, one level down. `status` is the single field existing
        // consumers read, and it is the one an operator scans. A truncated walk
        // must not be reachable only by drilling into a new field, so the
        // verdict is repeated here as `possible_incomplete` — a distinct
        // boolean rather than a second `degraded`, because the point is that
        // `degraded` cannot express it.
        possible_incomplete: completeness === 'possibly_incomplete' || completeness === 'incomplete',
        completeness_verdict: completeness,
      }),
    })

    metrics.counter('ingestion_runs_total', { source, status })
    metrics.histogram('ingestion_duration_ms', durationMs, { source })
  }

  const data_lineage = []
  // ENH-15. This loop rebuilt a *run-wide* union of every record inside the
  // per-source iteration, so a nine-source run wrote nine lineage rows that
  // each described all nine sources — the audit trail was nine copies of one
  // statement about the whole run, and no row could say which source it was
  // about. `upstream_url_or_endpoint` was hardcoded null and
  // `transform_version` was the constant '0.1.0', so even the one row had
  // nothing to say about provenance.
  //
  // One row per source run now, over that run's own records, with a transform
  // version derived from the code that transformed them.
  for (const run of source_runs) {
    if (run.status === 'skipped') continue
    const provenance = provenance_by_run.get(run.id) || []
    // Every published record is stamped with its run at line 252, so a record
    // with no stamp belongs to no run. The `|| !record._source_run_id` clause
    // that used to here matched those records for *every* run, which rebuilt
    // the union the previous fix removed — nine rows, each describing all nine
    // sources, which is the defect in the first place.
    const records = OUTPUT_COLLECTIONS.flatMap((key) => merged[key])
      .filter((record) => record._source_run_id === run.id)
    data_lineage.push(recordLineageRow({ sourceRun: run, records, provenance }))
  }

  const quarantine_counts = Object.fromEntries(
    Object.entries(quarantined).map(([key, rows]) => [key, rows.length]),
  )

  const data = await store.merge({
    ...merged,
    ...quarantined,
    source_runs,
    data_lineage,
    // Only the sources that actually reported a position. A source that was not
    // run, or that returned nothing, keeps the state it had rather than having
    // it cleared — losing a cursor because a run was interrupted is exactly how
    // a resumable backfill stops being resumable.
    ...(nextWatermarks.length ? { watermark_state: nextWatermarks } : {}),
  })
  return {
    source_runs,
    counts: Object.fromEntries(
      OUTPUT_COLLECTIONS.map((key) => [key, merged[key].length]),
    ),
    quarantined: quarantine_counts,
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
      // ENH-06. The old `status` above is one clock judging every source: a
      // two-week staleness window applied to a daily rainfall product and to an
      // annual WHO national statistic alike, so a quiet GDACS week and a dead
      // one could both report `degraded`. The verdict is cadence-aware and
      // separates them.
      //
      // Both fields are kept. `status` is what existing consumers read and the
      // openapi schema names; replacing it outright would break every caller to
      // fix a problem a second field solves. New code should read `verdict`.
      verdict: explainVerdict({
        source,
        policy,
        lastRun,
        lastSuccessRun: lastSuccess,
      }),
      last_run: lastRun,
      last_success: lastSuccess,
      // ENH-14. The same tripwire on the status route, because the status route
      // is what an operator actually opens. `null` when the last run walked no
      // pages and so had nothing to be truncated by — not `complete`, which
      // would say the walk was checked and found whole.
      completeness: lastRun?.completeness ?? null,
      failure_streak: failureStreak(sourceRuns),
      // ENH-10. `scoreConnector` had no production caller: it scored the
      // breaker's in-memory window, and `runIngestion` builds that window from
      // scratch every run and discards it. The score was therefore always null
      // outside a test — the one number this item exists to produce, produced
      // nowhere. Rebuilt from the stored run history instead, which is the same
      // evidence and survives the run.
      //
      // `score` stays null until there is enough to measure. A source with two
      // runs has a success rate and no meaningful p95, and reporting the
      // success rate alone as a 0-100 health score would be a score computed
      // from one of three signals wearing the other's label.
      health: scoreConnector({ outcomes: outcomesFromRuns(sourceRuns) }),
      schedule,
      policy,
    }
  })
}

/**
 * Runs a source's declarative assertions over everything it just returned.
 *
 * Returns `published` (what is safe to merge) and `quarantined` (keyed by
 * quarantine collection) rather than a bare verdict, because the caller has to
 * do two different things with the answer: merge one and store the other. A
 * boolean would force the caller to re-derive the split and get it subtly
 * different per source.
 *
 * `trailingRecords` is deliberately not passed. A count assertion needs the
 * source's own trailing window, which lives in the store and is read by the
 * caller that has it; wiring a plausible-looking default here would make every
 * count assertion pass vacuously, which is the failure mode ENH-07 exists to
 * catch.
 */
function runSourceAssertions({ source, output, trailingRecords = [] }) {
  const records = OUTPUT_COLLECTIONS.flatMap((key) => output?.[key] || [])
  const report = runAssertions({ source, records, trailingRecords })
  if (report.ok) {
    return { ...report, published: output, quarantined: {} }
  }
  const published = Object.fromEntries(OUTPUT_COLLECTIONS.map((key) => [key, []]))
  const quarantined = {}
  for (const key of OUTPUT_COLLECTIONS) {
    const batch = output?.[key] || []
    if (!batch.length) continue
    // Quarantine by collection so the store can hold them apart, and carry the
    // failed assertions with each row so the finding is readable without
    // cross-referencing the run.
    quarantined[quarantineCollectionName(key)] = quarantineRecords({
      source,
      records: batch,
      failures: report.failures,
      sourceRunId: null,
      collection: key,
    })
  }
  // Nothing is published from a batch that failed. Merging the survivors would
  // be worse than quarantining the whole thing: a partial GDACS page that
  // passed its count assertion by accident is indistinguishable, downstream,
  // from a complete one.
  return { ...report, published, quarantined }
}

function emptyCounts() {
  return Object.fromEntries(OUTPUT_COLLECTIONS.map((key) => [key, 0]))
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

/**
 * The collections a connector may return, in one place.
 *
 * Three consumers key off this: the merge accumulator, countRecords(), and
 * countRecordsByCollection(). They used to be three separate lists and the
 * counters named four of the six — so `ipc_hdx`, which returns only
 * food_security_records, reported "degraded — expected at least 1 records;
 * received 0" on a fully successful run. Ingestion claimed failure on exactly
 * the two newest and most operationally important sources, which is how an
 * operator learns to stop trusting the health signal that would have told them
 * data was lost.
 *
 * Export it and assert on it. A guard that greps source text for the spelling
 * of a collection name passes with this bug fully present.
 */
export const OUTPUT_COLLECTIONS = [
  'climate_observations',
  'hazard_events',
  'conflict_events',
  'service_assets',
  'food_security_records',
  'disease_observations',
]

function countRecords(output) {
  return OUTPUT_COLLECTIONS
    .reduce((total, key) => total + (output?.[key]?.length || 0), 0)
}

function countRecordsByCollection(output) {
  return Object.fromEntries(OUTPUT_COLLECTIONS
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

/**
 * A connector's completeness block as a name from the frozen vocabulary, or
 * null when it reported none.
 *
 * null is the answer for a connector that walks no pages — a single-request
 * source has nothing to be truncated by, and reporting `complete` there would
 * put a source that was never assessed into the same column as one that was
 * assessed and found whole. Those are different claims and the field has to
 * carry the difference, because the alternative is a column in which
 * `complete` means "complete or never asked", which is the falsy-zero conflation
 * in a new place.
 *
 * `output.completeness` is read rather than passed, because the connectors put
 * it there and the ingestion loop is the only thing that sees every connector's
 * return value. A connector that forgets it is `null` here, not a pass.
 */
function normaliseCompleteness(completeness) {
  if (!completeness || typeof completeness !== 'object') return null
  const name = completenessVerdictName(completeness)
  return COMPLETENESS_VERDICTS.includes(name) ? name : null
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

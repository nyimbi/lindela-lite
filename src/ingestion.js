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
import { openMeteoForecastConnector } from './connectors/open-meteo-forecast.js'
import { acledCsvConnector, conflictCsvConnector, serviceAssetsConnector } from './connectors/uploads.js'
import { dhis2Connector } from './connectors/dhis2.js'
import { reliefwebEpidemicsConnector } from './connectors/reliefweb-epidemics.js'
import { allowRequest, circuitStateFor, createCircuitState, outcomesFor, outcomesFromRuns, recordOutcome, scoreConnector } from './circuit.js'
import { COMPLETENESS_VERDICTS, completenessVerdictName } from './completeness.js'
import { runAssertions, quarantineRecords, quarantineCollectionName } from './assertions.js'
import { buildProvenance, recordLineageRow } from './provenance.js'
import { explainVerdict, freshnessReportBySource } from './freshness.js'
import { fetchRecording, resetFetchRecordings, withFetchRecording } from './connectors/http.js'
import { isDeclared } from './store.js'

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
  open_meteo_forecast: openMeteoForecastConnector,
  reliefweb_epidemics: reliefwebEpidemicsConnector,
  service_assets: serviceAssetsConnector,
  acled_csv: acledCsvConnector,
  conflict_csv: conflictCsvConnector,
  dhis2: dhis2Connector,
})

/** Process-monotonic. See `runInvocationSeq` use in `runIngestion`. */
let runInvocationSeq = 0

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
  // The map weather overlay's feed: a short-lived forecast, so it belongs on
  // the regular schedule beside open_meteo, not with the on-demand backfills.
  'open_meteo_forecast',
  // ADR-014: epidemic events for the map overlay. regular:true (an outbreak
  // can move funding this month); the record floor is the repo-wide R-41 rule,
  // and a legitimately quiet feed reads empty_response, not broken.
  'reliefweb_epidemics',
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
  // Same cadence as open_meteo: the forecast is refreshed upstream roughly
  // hourly and the overlay is only honest while the issue time is recent. The
  // staleness window is the one WEATHER_STALE_AFTER_MINUTES publishes.
  open_meteo_forecast: { interval_minutes: 180, timeout_ms: 20000, retries: 2, stale_after_minutes: 360, minimum_records: 1, regular: true },
  // The plan asked for minimum_records: 0 ("no epidemic in the window is
  // legitimate"), but every regular PUBLIC source is held to a floor by the
  // no-silent-empty-success rule (R-41 family, enforced in test/lite.test.js).
  // The honest vocabulary for legitimate emptiness already exists: two
  // consecutive zero-record runs report the freshness verdict empty_response —
  // "the source answers, but has had nothing for us" — while a FIRST empty run
  // reads degraded, which is the correct suspicion.
  reliefweb_epidemics: { interval_minutes: 360, timeout_ms: 20000, retries: 2, stale_after_minutes: 720, minimum_records: 1, regular: true },
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
/**
 * R-07. Clear any orphaned recording keys before a run starts.
 *
 * `resetFetchRecordings` existed for tests and had no production caller, which
 * is the shape of every leak in this file: the mechanism is there and nothing
 * ever asks for it. `withFetchRecording` now closes its own key in a `finally`,
 * so a throw cannot orphan one — but "cannot" is a property of the code, not an
 * observation, and a process that was killed mid-crawl, or one running a build
 * of this module from before the fix, can still hold a key. Clearing at the
 * boundary costs one `Map.clear()` per run and turns a stale list that would
 * silently accumulate every subsequent request into nothing.
 */
export async function runIngestion(store, request = {}, { connectors = CONNECTORS } = {}) {
  resetFetchRecordings()
  // The per-invocation discriminator for run ids. Two runs of the same source,
  // both succeeding, both landing inside the same millisecond, mint the same
  // `stableId` — and `mergeById` keys on id, so the second run's row silently
  // overwrites the first's. One run vanishes from `source_runs` with no error
  // anywhere, which then makes every trailing window one short and every
  // verdict one run behind reality.
  //
  // A monotonic counter rather than a clock: a clock is exactly the thing that
  // collided, and a counter cannot collide within a process however fast the
  // runs come. Combined with `started_at` the id stays stable for a given run
  // and unique across runs, which is what `mergeById` needs.
  runInvocationSeq += 1
  const invocation = runInvocationSeq
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
  const snapshot = typeof store.read === 'function' ? await store.read() : {}
  const existingWatermarks = snapshot.watermark_state || []
  const watermarkBySource = new Map(existingWatermarks.map((row) => [row.source, row.state || {}]))
  // What each source returns this run, written back after every source has
  // finished — a partial write mid-run would leave the store claiming a position
  // the run never reached.
  const nextWatermarks = []
  const quarantined = Object.fromEntries(OUTPUT_COLLECTIONS.map((key) => [quarantineCollectionName(key), []]))
  // R-42. The trailing window, read from the same snapshot the watermarks came
  // from. Every source's `min_count_vs_trailing` assertion needs the source's own
  // prior record counts, and they have been sitting in `source_runs` the whole
  // time. `runSourceAssertions` was called without them, so `median([])` was
  // null and the assertion that would catch GDACS collapsing from 40,000 to
  // 4,000 reported itself `unmeasured` on every run of the product's life.
  const runsBySource = groupRunsBySource(snapshot.source_runs || [])
  // ENH-10 / R-41. Circuit state now *persists*, which the original comment here
  // said was "a bigger claim than this item makes". It is the claim, and the
  // reason it was not made is the whole defect: state created per `runIngestion`
  // call means each source is visited exactly once per run, so
  // `consecutive_failures` can reach 1 and the threshold is 3. The breaker could
  // not trip, and `/ingest/status` reported a health score for a breaker that
  // did not exist.
  let circuitState = loadCircuitState(snapshot.connector_circuit || [])

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
    let retrieval = []

    // ENH-10. `failure_streak` was computed by this file and acted on by
    // nothing: a dead source was retried in full on every run-due tick,
    // consuming the wall-clock budget the healthy sources need. The gate goes
    // before the fetch, and its skip is recorded as a distinct verdict — three
    // different situations that all render as "the source didn't update" are how
    // a working pipeline and a dead one come to report the same thing.
    const gate = allowRequest(circuitState, source)
    if (!gate.allowed) {
      const skippedRun = {
        id: stableId('run', [source, startedAt, invocation, verdict, [gate.reason]]),
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
      }
      source_runs.push(skippedRun)
      // R-05. A skip is a run too, and it is written by the same per-source
      // commit. A source the breaker declined is exactly the source an operator
      // needs to see has been declined for a week.
      await commitSource({ store, run: skippedRun })
      metrics.counter('ingestion_runs_total', { source, status: gate.reason })
      continue
    }

    const recordingKey = `${source}:${startedAt}`
    try {
      // ENH-15 / R-10. Name the run before fetching, so every URL the connector
      // pulls through http.js is attributable to it. `withFetchRecording` owns
      // the begin *and* the end: the old `beginFetchRecording` at this point had
      // no `finally`, so a connector that threw here left its key live for the
      // life of the process and every subsequent run's URLs were appended to a
      // dead run's list — a stale `upstream_url_or_endpoint` written
      // confidently onto every row that followed.
      const recorded = await withFetchRecording(
        recordingKey,
        async () => {
          try {
            return await runConnectorWithRetries(connector, sourceRequest)
          } finally {
            // Captured before `withFetchRecording` deletes the key, so a run
            // that *failed* still names the URLs it managed to reach. A
            // timeout at hour three of an archive walk is exactly when the
            // lineage row needs to say where it got to.
            retrieval = fetchRecording(recordingKey) || []
          }
        },
      )
      output = recorded.value
      // A connector that returns no state keeps the state it was given. Treating
      // the absence as a reset would lose the position on any connector that
      // has not been wired up yet.
      if (output && output.watermark_state) {
        nextWatermarks.push({
          id: `watermark_${source}`,
          type: 'watermark_state',
          source,
          // R-17. Merged forward-only against the position this run was seeded
          // from. The connector's own `advanceWatermark` is correctly
          // forward-only; the merge that persists its answer was not, so two
          // overlapping runs — one started a minute before the other, finishing
          // in the opposite order — wrote the store's cursor *backwards*, and
          // the next incremental fetch re-requested everything in between.
          state: mergeWatermarkForward(watermarkBySource.get(source) || {}, output.watermark_state),
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
    //
    // `invocation` is in the preimage so two same-millisecond runs cannot
    // share an id — see the note where it is minted.
    const runId = stableId('run', [source, startedAt, invocation, status, errors])

    // ENH-15. Provenance per record, built before the batch is merged so the
    // `_provenance` envelope travels with the row rather than being inferred
    // afterwards from whatever survived. `transform_version` comes from the
    // hashing of the code that did the transforming, so editing a connector's
    // mapping changes the version it stamps.
    const runRecords = OUTPUT_COLLECTIONS.flatMap((key) => output[key] || [])
    const retrievalUrl = retrieval[0]?.url || null
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
      // R-42. `trailingRecords` is passed, from `source_runs` in the snapshot
      // taken before this run started. Without it `median([])` is null, the
      // count assertion reports itself `unmeasured`, and the assertion that
      // would catch GDACS collapsing from 40,000 records to 4,000 has never
      // once executed in production. Twenty-one test call sites passed it; the
      // production caller passed nothing.
      assertionReport = runSourceAssertions({
        source,
        output,
        trailingRecords: trailingCountsFor(runsBySource.get(source) || []),
      })
      if (assertionReport && !assertionReport.ok) {
        status = 'degraded'
        errors = [...errors, ...assertionReport.failures.map((f) => f.message)]
        output = assertionReport.published
      }
    }

    // R-05. Kept per source as well as in the run-wide accumulator, because the
    // commit below is per source and `merged` accumulates all nine.
    const thisSourceRecords = {}
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
      thisSourceRecords[key] = records
      merged[key].push(...records)
    }

    // Quarantined batches are stored apart from published ones, with the
    // assertion that condemned them attached. A condemned batch is a finding
    // to be read, not a zero to be averaged.
    const quarantinedThisSource = {}
    if (assertionReport && !assertionReport.ok) {
      for (const [collection, rows] of Object.entries(assertionReport.quarantined)) {
        quarantinedThisSource[collection] = rows
        quarantined[collection]?.push(...rows)
      }
    }

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
      // R-43. The report used to be computed and dropped on the floor. What
      // survived was `assertionReport.failures.map((f) => f.message)` flattened
      // into `errors` — so `stats` was gone, `unmeasured` was gone, and each
      // failure's structured `detail` was gone, leaving an operator with the
      // sentence "40 record(s) against a trailing median of 40000" and nothing
      // about which assertion, what kind, or what the comparison was.
      //
      // `null` when no assertion ran (a failed fetch), which is a different
      // statement from `ok: true` with an empty `unmeasured` list.
      assertion_report: assertionReport
        ? {
            ok: assertionReport.ok,
            assertions_evaluated: assertionReport.stats?.assertions_evaluated ?? null,
            record_count: assertionReport.stats?.record_count ?? null,
            trailing: assertionReport.stats?.trailing ?? null,
            unmeasured: assertionReport.stats?.unmeasured ?? [],
            field_coverage: assertionReport.stats?.field_coverage ?? {},
            failures: assertionReport.failures || [],
          }
        : null,
      // Read by `explainVerdict` to mark a tripped assertion as `broken` on
      // sight. Present at the top level as well as in the report so the two
      // cannot disagree about whether anything tripped.
      assertions_failed: assertionReport?.failures?.length ?? 0,
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
        assertions_failed: assertionReport?.failures?.length ?? 0,
      }),
    })

    metrics.counter('ingestion_runs_total', { source, status })
    metrics.histogram('ingestion_duration_ms', durationMs, { source })

    // R-05 / ENH-25. Commit per source, inside the loop.
    //
    // The single merge at the end meant a run's records existed only in RAM
    // until every source finished. `gdacs_archive` alone is ~166 requests and
    // up to 4.2 h worst case, so a kill at hour 3.9 lost the other eight
    // sources' work too and the next run restarted the archive from 1985 — a
    // hardcoded constant, so "restarted from 1985" was the only behaviour the
    // code had.
    //
    // Idempotent by construction, which is what makes it safe: `mergeById`
    // keys on `id` and is pure, and every record already carries `payload_hash`
    // and `_source_run_id`. Re-running a source that was already committed
    // merges the same rows to the same values. Nothing about this makes the
    // store's write path weaker; it only makes the loss window one source
    // (~10 s) instead of one run (~4 h).
    await commitSource({
      store,
      source,
      runId,
      run: source_runs[source_runs.length - 1],
      records: thisSourceRecords,
      quarantine: quarantinedThisSource,
      lineage: recordLineageRow({
        sourceRun: source_runs[source_runs.length - 1],
        records: runRecords,
        provenance,
      }),
      watermarks: nextWatermarks.filter((row) => row.source === source),
    })
  }

  // ENH-15. The lineage row for a run is written inside the loop now, by
  // `commitSource`, over that run's own records with a transform version
  // derived from the code that transformed them. The loop this replaced rebuilt
  // a run-wide union of every record per source run, so a nine-source run wrote
  // nine rows that each described all nine sources — the audit trail was nine
  // copies of one statement about the whole run.

  const quarantine_counts = Object.fromEntries(
    Object.entries(quarantined).map(([key, rows]) => [key, rows.length]),
  )

  // R-41. Write the breaker back, so the next run reads it instead of starting
  // from zero. Guarded on the collection being declared: `connector_circuit`
  // belongs in `SCHEMA` in `src/store.js`, which this change does not own, and
  // `assertDeclaredCollections` throws on an undeclared key rather than
  // dropping the rows — so writing it before the declaration lands would take
  // every ingestion run down. `circuit_persisted: false` says so out loud
  // rather than letting the breaker quietly revert to per-run.
  const circuitRows = circuitStateRows(circuitState)
  // Store-aware, so a store that names a narrower set of collections than the

  // the module default is believed. `isCircuitCollectionDeclared` existed for this

  // and had no callers: the write path read the module declaration directly, so a

  // store that could not hold the collection was told the breaker was persisted.

  // `snapshot`, not `data`: `data` is read further down, so naming it here
  // is a ReferenceError. It was masked while the left operand was always true
  // and short-circuited the right — which is exactly the undeclared-collection
  // path this test exercises, so the landmine sat under the one case that could
  // detonate it.
  // The declaration check alone.
  //
  // It used to be OR'd with "the snapshot holds connector_circuit rows", which
  // was a statement about the data rather than the schema. Now that the key is
  // in `emptyStore()` that disjunct is always true — every snapshot has the key
  // and most have it empty — so it made the verdict constant and the
  // undeclared-collection case unreachable. Whether a store *can* hold the
  // collection is the question; how many rows it happens to hold is not.
  //
  // (`data` would also have been a ReferenceError here: it is read further
  // down, and the old expression only survived because the left operand
  // short-circuited the right — putting the landmine under the one case that
  // could detonate it.)
  const circuitPersisted = isCircuitCollectionDeclared(store)
  if (circuitPersisted && circuitRows.length) {
    await store.merge({ connector_circuit: circuitRows })
  }

  const data = await store.read?.() ?? null

  return {
    source_runs,
    counts: Object.fromEntries(
      OUTPUT_COLLECTIONS.map((key) => [key, merged[key].length]),
    ),
    quarantined: quarantine_counts,
    // Named so a caller can report it. A health score for a breaker that cannot
    // trip is worse than no score, and the score is the same shape either way —
    // the reader cannot tell from `health` that the gate behind it resets.
    circuit_persisted: circuitPersisted,
    data,
  }
}

/**
 * One source's records, quarantined rows, run row, lineage row and watermark,
 * written as a single merge.
 *
 * All or nothing per source, and not across sources: a partial write *within* a
 * source would leave half an archive walk committed and half not, which is
 * worse than neither. Across sources, a partial write is the normal case and is
 * the entire point — the sources behind it are independent and none of them
 * should wait on a four-hour archive.
 */
async function commitSource({ store, run, records = {}, quarantine = {}, lineage, watermarks = [] }) {
  const payload = {
    ...records,
    ...quarantine,
    source_runs: [run],
  }
  if (lineage) payload.data_lineage = [lineage]
  if (watermarks.length) payload.watermark_state = watermarks
  await store.merge(payload)
}

export function groupRunsBySource(runs = []) {
  const bySource = new Map()
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run?.source) continue
    if (!bySource.has(run.source)) bySource.set(run.source, [])
    bySource.get(run.source).push(run)
  }
  return bySource
}

/**
 * The trailing record counts a count assertion is judged against.
 *
 * Numbers, not run objects: `trailingCounts` reads run objects fine, but the
 * window is capped here so a source with a year of runs does not hand the
 * assertion a thousand-length baseline it will only take a median of. Twelve
 * is two days at the busiest cadence in the repo, and long enough that one bad
 * afternoon does not become the baseline the next afternoon is measured
 * against.
 *
 * A failed run contributes its count too. Excluding failures would let a source
 * that has been returning zero for six runs be measured against the median of
 * the three good runs that preceded them, which is the exact window that hides
 * a collapse.
 */
const TRAILING_RUN_WINDOW = 12

function trailingCountsFor(runs) {
  return runs.slice(0, TRAILING_RUN_WINDOW).map((run) => Number(run?.records_processed ?? 0))
}

/**
 * R-17. Merge a connector's reported watermark forward over the one this run
 * was seeded with.
 *
 * `advanceWatermark` in `src/watermarks.js` is already forward-only inside the
 * connector's own state; this is the guard at the *persistence* layer, which is
 * where the last-writer-wins lived. Two overlapping runs — the second started
 * a minute after the first, the first finishing later because a backfill was
 * in flight — each wrote its own answer and the store kept whichever arrived
 * last. The run that started earlier finishes later and wins, moving the
 * cursor backwards, and the next incremental fetch re-requests everything in
 * between.
 *
 * Forward-only on `last_record_date` / `last_cursor`. Everything else is
 * last-writer-wins, because `last_success_at` and `in_progress` describe the
 * *latest* attempt and there is no reading of them in which the older one is
 * the more current one.
 */
function mergeWatermarkForward(prior, next) {
  if (!next || typeof next !== 'object') return prior
  if (!prior || typeof prior !== 'object') return next
  const merged = { ...prior, ...next }
  for (const key of ['last_record_date', 'last_cursor']) {
    const a = dayNumberOf(prior[key])
    const b = dayNumberOf(next[key])
    if (a !== null && b !== null) {
      merged[key] = a >= b ? prior[key] : next[key]
    } else if (a !== null) {
      merged[key] = prior[key]
    }
  }
  return merged
}

function dayNumberOf(value) {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * R-41. The breaker's persisted form.
 *
 * One row per source, keyed `connector_circuit_<source>`, holding the whole
 * `entryFor` object. `circuit.js` owns the state machine and the vocabulary;
 * this is only the round trip, so a change to the breaker does not require a
 * matching change here — an unknown field survives the trip and an unreadable
 * state falls back to a fresh one.
 */
export const CIRCUIT_COLLECTION = 'connector_circuit'

export function loadCircuitState(rows = []) {
  const state = createCircuitState()
  for (const row of Array.isArray(rows) ? rows : []) {
    const source = row?.source
    if (!source || !row?.state) continue
    state.sources[source] = {
      ...blankCircuitEntry(),
      ...(typeof row.state === 'object' ? row.state : {}),
      source,
    }
  }
  return state
}

function blankCircuitEntry() {
  return {
    state: 'closed',
    consecutive_failures: 0,
    opened_at: null,
    probe_in_flight: false,
    history: [],
  }
}

/** The breaker as rows. Only sources with something to say are written. */
export function circuitStateRows(state) {
  return Object.entries(state?.sources || {}).map(([source, entry]) => ({
    id: `${CIRCUIT_COLLECTION}_${source}`,
    type: CIRCUIT_COLLECTION,
    source,
    state: {
      state: entry.state,
      consecutive_failures: entry.consecutive_failures,
      opened_at: entry.opened_at ?? null,
      probe_in_flight: false,
      history: entry.history || [],
    },
    // Mirrored at the top level so a reader paging the collection can filter on
    // it without unpacking a nested object. `assertionFailures` in
    // freshness.js reads the same shape from run rows.
    circuit_state: entry.state,
    consecutive_failures: entry.consecutive_failures ?? 0,
    opened_at: entry.opened_at ?? null,
    updated_at: new Date().toISOString(),
  }))
}

/**
 * Whether this store can hold `connector_circuit`.
 *
 * `src/store.js` owns `SCHEMA` and this change does not, so this is read rather
 * than assumed: a store that cannot hold the collection must still be able to
 * run ingestion, and a store that can must actually use it. Anything that is
 * not a store with a `read` returns false, which for the merge-only test stubs
 * is the correct answer — they have no persistence to carry the breaker in.
 */
function isCircuitCollectionDeclared(store = null) {
  // Read from the store module's own declaration rather than a hard-coded
  // list, so the moment `connector_circuit` is added to `SCHEMA` this starts
  // persisting with no edit here. `isDeclared` is a pure read of the exported
  // declaration; importing it does not edit `src/store.js`.
  // A store may name its own collections — `PostgresStore` reads a table per
  // key rather than off `SCHEMA` — so a store that declares the collection
  // itself is believed over the module default.
  //
  // **Checked before the module default**, which is what its own comment said
  // and what the code did not do: `isDeclared` short-circuited, so a store that
  // explicitly narrowed its declaration was overruled by the module the moment
  // `connector_circuit` landed in `SCHEMA` — and the honest-degradation path
  // below became unreachable exactly when it stopped being a test-only state.
  const declared = store?.declaredCollections
  if (Array.isArray(declared)) return declared.includes(CIRCUIT_COLLECTION)
  return isDeclared(CIRCUIT_COLLECTION)
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
    // R-53. The slip is measured here, where both times are known, and stored
    // on the schedule — so `ingestionStatus` can report a drifting schedule
    // instead of an `ok` that means only "it ran".
    const startedAt = result.source_runs[0]?.started_at || nowIso()
    const slip = scheduleSlip({
      dueAt: schedule.next_run_at,
      startedAt,
      intervalMinutes: schedule.interval_minutes ?? SOURCE_POLICIES[schedule.source]?.interval_minutes,
    })
    schedules.push({
      ...schedule,
      last_run_at: completedAt,
      next_run_at: computeNextIngestionRunAt(schedule, completedAt, { now: startedAt }),
      last_slip_ms: slip.slip_ms,
      last_slip_at: startedAt,
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

/**
 * When this schedule next runs.
 *
 * R-53: this anchored on `completed_at`, so the interval was measured from the
 * end of a run. A source that consistently takes 50 minutes on a 30-minute
 * interval slipped 50 minutes every cycle, forever, and `ingestionStatus`
 * reported `ok` throughout — the schedule was drifting and the only symptom was
 * data that was quietly older than anyone believed.
 *
 * So the anchor is when the run was *due*, which is what "every 30 minutes" has
 * always meant, with one guard: if that time has already passed — a slow
 * source, or the process was down — the next run is now rather than in the
 * past. Fixed-rate without drift, and without a catch-up storm that fires a
 * missed hour of runs in a burst.
 */
export function computeNextIngestionRunAt(schedule, from = nowIso(), { now = from } = {}) {
  const interval = toNumber(schedule.interval_minutes, null)
  if (!interval) return null
  const dueAt = Date.parse(schedule.next_run_at || '')
  const fromMs = Date.parse(from)
  const nowMs = Date.parse(now)
  // The due time is the anchor whenever there is one. Using completion as the
  // fallback — "or the run finished, if it finished after it was due" — is the
  // drift this function existed to remove: a run that takes longer than its
  // interval is *always* later than its due time, so that branch would always
  // be taken and the fix would do nothing.
  //
  // `from` is then only the fallback for a schedule with no due time at all,
  // which is a schedule being created rather than one being rescheduled.
  const anchor = Number.isFinite(dueAt) ? dueAt : fromMs
  const next = anchor + interval * 60 * 1000
  return new Date(next > nowMs ? next : nowMs).toISOString()
}

/**
 * How late a scheduled run started, in ms, and whether that is a problem.
 *
 * A slip is not itself a failure — a provider that is slow for one cycle is a
 * provider that was slow. It becomes a problem when it is *persistent*, which
 * is why the number is recorded per run and the threshold is a multiple of the
 * interval rather than a fixed duration: a 12-hour schedule is allowed an hour
 * of lateness and a 30-minute schedule is allowed a minute.
 */
export function scheduleSlip({ dueAt, startedAt, intervalMinutes, thresholdMultiple = 1 }) {
  const due = Date.parse(dueAt || '')
  const started = Date.parse(startedAt || '')
  if (!Number.isFinite(due) || !Number.isFinite(started)) {
    return { slip_ms: null, slipping: false, reason: 'no due time recorded' }
  }
  const slipMs = Math.max(0, started - due)
  const thresholdMs = toNumber(intervalMinutes, null) * thresholdMultiple * 60 * 1000
  const threshold = Number.isFinite(thresholdMs) ? thresholdMs : null
  return {
    slip_ms: slipMs,
    threshold_ms: threshold,
    slipping: threshold === null ? false : slipMs > threshold,
  }
}

export function ingestionStatus(data) {
  const schedules = data.ingestion_schedules || []
  const runs = data.source_runs || []
  // R-41. The same breaker state the gate reads, from the same place. The score
  // below and the gate that acts on it now refer to one state object, which is
  // the whole condition: a health score computed from a different evidence
  // base than the one that decides to stop calling a source is a score that can
  // say `ok` about a breaker that is open.
  const circuitState = loadCircuitState(data.connector_circuit || [])
  // R-44. `freshnessReport` is the production caller the three-run window was
  // written for. It had none: this function called `explainVerdict` directly,
  // with no `recentRecordCounts` and no `now`, so the trailing window was dead
  // code reachable only from a test that passed the array in itself.
  const runsBySource = groupRunsBySource(runs)
  const verdicts = freshnessReportBySource({
    sourceRunsBySource: Object.fromEntries(runsBySource),
    policies: SOURCE_POLICIES,
    now: Date.now(),
  })
  // `ingestionStatus` reads a snapshot, not a store, so it cannot ask the
  // store what it declares. It answers from the data instead: if the store
  // holds `connector_circuit` rows at all, the collection exists and the
  // breaker survives. That is a statement about this deployment rather than
  // about the schema, which is the right one — a declared-but-never-written
  // collection and an undeclared one are indistinguishable from the rows, and
  // claiming either would be a guess.
  const circuitPersisted = isDeclared(CIRCUIT_COLLECTION) || Array.isArray(data.connector_circuit)
  return SOURCE_IDS.filter((source) => !BLOCKED_SOURCE_IDS.includes(source)).map((source) => {
    const policy = SOURCE_POLICIES[source] || {}
    const sourceRuns = runsBySource.get(source) || []
    const lastRun = sourceRuns[0] || null
    const lastSuccess = sourceRuns.find((run) => run.status === 'success') || null
    const schedule = schedules.find((item) => item.source === source && item.status !== 'archived') || null
    const staleAfter = schedule?.stale_after_minutes ?? policy.stale_after_minutes
    const circuit = outcomesFor(circuitState, source)
    // R-53. A schedule that is slipping is not an `ok` schedule. Reported on
    // the status route because that is the route an operator opens when a
    // source looks wrong.
    //
    // The slip is the value measured against the real due time when the run
    // started, and it is *read* here rather than recomputed. The first version
    // reconstructed the due time as "one interval before the run started" and
    // compared — which makes the slip exactly one interval by construction, so
    // the check could never fire. A measurement that has to be re-derived at
    // the far end is a measurement that will be.
    const intervalMinutes = schedule
      ? (schedule.interval_minutes ?? policy.interval_minutes ?? null)
      : null
    const slipMs = schedule?.last_slip_ms ?? null
    const slipThresholdMs = Number.isFinite(Number(intervalMinutes))
      ? Number(intervalMinutes) * 60 * 1000
      : null
    return {
      source,
      regular: Boolean(policy.regular),
      status: sourceHealth(lastRun, staleAfter),
      // `schedule` below is the raw record; this is the cadence read off it,
      // under its own name because two fields cannot both be called `schedule`
      // and the shorthand would win.
      cadence: schedule ? {
        next_run_at: schedule.next_run_at,
        last_run_at: schedule.last_run_at,
        // How late the last scheduled run started, and whether that is a
        // problem. The threshold is one interval, so a daily source is allowed
        // an hour and a 30-minute one is allowed 30 minutes.
        last_slip_ms: slipMs,
        slipping: Number.isFinite(slipMs) && slipThresholdMs !== null && slipMs > slipThresholdMs,
        slip_threshold_ms: slipThresholdMs,
      } : null,
      // ENH-06. The old `status` above is one clock judging every source: a
      // two-week staleness window applied to a daily rainfall product and to an
      // annual WHO national statistic alike, so a quiet GDACS week and a dead
      // one could both report `degraded`. The verdict is cadence-aware and
      // separates them.
      //
      // Both fields are kept. `status` is what existing consumers read and the
      // openapi schema names; replacing it outright would break every caller to
      // fix a problem a second field solves. New code should read `verdict`.
      verdict: verdicts[source] || explainVerdict({
        source,
        policy,
        lastRun,
        lastSuccessRun: lastSuccess,
        now: Date.now(),
      }),
      last_run: lastRun,
      last_success: lastSuccess,
      // ENH-14. The same tripwire on the status route, because the status route
      // is what an operator actually opens. `null` when the last run walked no
      // pages and so had nothing to be truncated by — not `complete`, which
      // would say the walk was checked and found whole.
      completeness: lastRun?.completeness ?? null,
      failure_streak: failureStreak(sourceRuns),
      // R-41. The breaker, as it is right now. `open` here means the next run
      // will not call this source — a fact the status route was previously
      // unable to state, because the breaker it scored was rebuilt per run and
      // could never open.
      circuit: {
        state: circuitStateFor(circuitState, source),
        consecutive_failures: circuitState.sources?.[source]?.consecutive_failures ?? 0,
        // `false` when `connector_circuit` is not declared in the store's
        // schema. The breaker is then real within a run and gone between them,
        // and a reader is told so rather than being shown `closed` and reading
        // it as healthy.
        persisted: circuitPersisted,
      },
      // ENH-10 / R-41. `scoreConnector` had no production caller: it scored the
      // breaker's in-memory window, and `runIngestion` built that window from
      // scratch every run and discarded it. The score was therefore always null
      // outside a test — the one number this item exists to produce, produced
      // nowhere.
      //
      // Scored over the *persisted* breaker's own retained outcomes, which are
      // the same evidence the gate acts on. Falls back to the run history only
      // when the breaker holds none, because a store that has never persisted
      // circuit state should still report a score rather than a null.
      //
      // `score` stays null until there is enough to measure. A source with two
      // runs has a success rate and no meaningful p95, and reporting the
      // success rate alone as a 0-100 health score would be a score computed
      // from one of three signals wearing the other's label.
      health: scoreConnector({ outcomes: circuit.length ? circuit : outcomesFromRuns(sourceRuns) }),
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
 * `trailingRecords` used to be deliberately not passed, on the argument that a
 * plausible-looking default would make every count assertion pass vacuously.
 * That argument was right about the default and wrong about the consequence:
 * leaving it out did not make the assertion cautious, it made it *inert*. An
 * assertion that reports `unmeasured` on every run is not caution, it is a
 * check that has never run wearing the costume of one.
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
 *
 * The last two widened with the field-signals work: the DHIS2 connector emits
 * `school_attendance_observations` and the IoT gateway emits
 * `iot_observations`, but this list was not widened with them, so runIngestion
 * accumulated neither — the connectors' outputs were dropped on the floor
 * while their store quarantine homes (and this file's own "in step, in both
 * directions" test) sat waiting for them. A quarantine home with no ingestable
 * collection is dead storage; a connector output with no quarantine home is a
 * silent hole. Both sides name all nine now.
 */
export const OUTPUT_COLLECTIONS = [
  'climate_observations',
  'hazard_events',
  'conflict_events',
  'service_assets',
  'food_security_records',
  'disease_observations',
  'weather_forecasts',
  'school_attendance_observations',
  'iot_observations',
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

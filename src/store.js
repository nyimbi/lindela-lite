import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { emptyStore } from './schema.js'
import { nowIso } from './utils.js'
import { BITEMPORAL_COLLECTIONS, isRevision, pruneVersions, versionRow } from './bitemporal.js'

/**
 * The six collections `replaceAnalytics` owns.
 *
 * Declared here rather than in the two method signatures because the signature
 * is where they drifted: `PostgresStore.replaceAnalytics` once took four
 * parameters where the caller passes six, so `population_at_risk` and
 * `facilities_at_risk` — the figures that turn hazard intensity into
 * consequence — were computed and thrown away, and nothing errored. A list this
 * method reads cannot be short by one without the test noticing, because both
 * adapters iterate the same declaration.
 */
export const DERIVED_COLLECTIONS = Object.freeze([
  'risk_scores',
  'impact_assessments',
  'data_quality',
  'population_at_risk',
  'facilities_at_risk',
  'road_access',
  // Calibration and drift are recomputed from scratch on every refresh, so
  // accumulating them would leave a region's stale trust score in place after
  // the evidence moved under it. Both replace, like the six above.
  'region_trust',
  'model_drift',
])

/**
 * The ingestable collections that get a quarantine home.
 *
 * One entry produces one `quarantine_<collection>` key, so the name of a
 * quarantine collection cannot be spelled differently from the collection it
 * shadows — the failure the six hand-written names were one typo away from.
 */
export const QUARANTINE_SOURCES = Object.freeze([
  'climate_observations',
  'hazard_events',
  'conflict_events',
  'service_assets',
  'food_security_records',
  'disease_observations',
])

/**
 * The timestamp cascade both adapters order a collection by.
 *
 * Newest first, first field present wins. Declared rather than inlined in
 * `recordTimestamp` because it is part of the contract: PostgresStore used to
 * order by an `updated_at` column it set to `now()` on write, so the two stores
 * disagreed about the order of the same records for the life of the project —
 * invisible unless you diff two stores holding the same data.
 *
 * `id` breaks ties, so the order is total. Without it two records sharing a
 * timestamp sort by whatever order the backend happened to fetch them in, which
 * is the DB's insertion order on Postgres and the file's on JSON — the same
 * records, two different lists, no error.
 */
export const SORT_FIELDS = Object.freeze([
  'updated_at',
  'completed_at',
  'generated_at',
  'observed_at',
  'occurred_at',
  'created_at',
  'started_at',
])

/** Metadata keys that live alongside collections in a write payload. */
const STORE_METADATA_KEYS = Object.freeze(['version', 'updated_at'])

/**
 * The one declaration every storage adapter is checked against.
 *
 * Three lists in this repo once described the same 39 collections: this one,
 * `emptyStore()` in schema.js, and the accumulator map in `runIngestion`. They
 * drifted independently and cost three separate incidents — a collection whose
 * records were dropped with no error, a health source that reported failure on
 * a fully successful run, and a first access to `store.record_versions` that
 * threw on a fresh file. ADR-002 calls this the single most repeated
 * structural bug in the codebase, and it is worth treating as a design smell
 * rather than three coincidences.
 *
 * So: one list, and the two adapters derive from it rather than keeping their
 * own. `write()` and `merge()` now *throw* on a key that is not declared rather
 * than ignoring it, which converts the third occurrence from a production
 * mystery into a stack trace pointing at the missing line.
 *
 * `emptyStore()` in schema.js still spells its keys out — it is a different
 * module's export and a schema.js import here would be a cycle — so
 * `test/store-schema-declaration.test.js` asserts the two agree from both
 * sides. That test is the drift alarm for the copy this file cannot replace.
 */
export const SCHEMA = Object.freeze([
  { key: 'source_runs' },
  { key: 'ingestion_schedules' },
  { key: 'climate_observations' },
  { key: 'hazard_events' },
  { key: 'conflict_events' },
  { key: 'service_assets' },
  { key: 'impact_assessments', derived: true },
  { key: 'risk_scores', derived: true },
  { key: 'data_quality', derived: true },
  { key: 'population_at_risk', derived: true },
  { key: 'facilities_at_risk', derived: true },
  { key: 'data_lineage' },
  // One row per source's fetch position. The watermark module is pure —
  // state in, state out, nothing stored — so without a home for it here a
  // 40-year archive walks the whole series on every run forever.
  { key: 'watermark_state' },
  // Per-region calibration and drift, both computed rather than ingested.
  // `derived` puts them under `replaceAnalytics`, which is what makes them
  // replace rather than accumulate.
  { key: 'region_trust', derived: true },
  { key: 'model_drift', derived: true },
  // ENH-23. A derived number that moved while its inputs did not. The
  // repository has payload_hash, data_lineage and per-record provenance — every
  // primitive for tracing one record's origin, and none for noticing that eight
  // collections were swapped at once under a moving engine.
  //
  // Not `derived: true`: this is not produced by `replaceAnalytics` and must not
  // be swept when it is, or the row recording the anomaly would replace the
  // anomaly.
  { key: 'unexpected_changes' },
  { key: 'incidents' },
  { key: 'interventions' },
  { key: 'intervention_tasks' },
  { key: 'field_reports' },
  { key: 'response_resources' },
  { key: 'action_logs' },
  { key: 'alert_rules' },
  { key: 'alert_events' },
  // ENH-19. The outcome channel. Calibration is unmeasurable without it: every
  // surface reports "not estimable" because nothing records whether a warning
  // was justified. The record is separate from the alert because one alert can
  // be determined more than once (a first determination, later corrected), and
  // because a determination is evidence somebody gathered, not a field a rule
  // evaluation can fill in.
  { key: 'alert_outcomes' },
  { key: 'trigger_protocols' },
  { key: 'rapidpro_dispatches' },
  { key: 'rapidpro_inbound_messages' },
  { key: 'report_templates' },
  { key: 'reports' },
  { key: 'report_distribution_runs' },
  { key: 'report_schedules' },
  { key: 'report_schedule_runs' },
  { key: 'events_outbox' },
  { key: 'webhook_subscriptions' },
  { key: 'workflow_instances' },
  { key: 'community_feedback' },
  { key: 'parametric_rules' },
  { key: 'parametric_disbursements' },
  { key: 'kpi_snapshots' },
  { key: 'road_access', derived: true },
  // Added after their own incidents, and listed here for the same reason each
  // time: JsonStore.merge keys strictly off COLLECTIONS, so an unlisted
  // collection's records are dropped silently — the same class of bug the
  // runIngestion merged map had, caught first by the food-security API test.
  { key: 'food_security_records' },
  { key: 'disease_observations' },
  { key: 'flood_probability_models' },
  // ENH-13. Every superseded value of a record upstream revises in place.
  // Leaving it off this list would drop every history row silently — the exact
  // silent-key-list bug the comment above warns about, one level down.
  { key: 'record_versions' },
  // R-36. `src/capture.js` documents that captures go "through the JSON store"
  // under this name, and `assertDeclaredCollections` threw on it — so the
  // documented path did not exist and the only working store was the
  // in-memory `CaptureStore`. Same class as every other entry above: a
  // collection that is not declared here is dropped, or now refused, loudly.
  //
  // The name is one string in two files, which is the drift this file exists to
  // end. `test/capture-collection-declaration.test.js` asserts it against
  // `CAPTURE_COLLECTION` from capture.js so the two cannot diverge silently.
  //
  // NOTE: `emptyStore()` in schema.js needs a `payload_captures: []` key for
  // `test/store-schema-declaration.test.js` to still agree in both directions,
  // and for `PostgresStore.read()` to have somewhere to push these rows.
  { key: 'payload_captures' },
  // One row, rewritten each tick. Not a derived collection: it is the record of
  // whether the work happened, which is the one thing nothing else can assert.
  { key: 'system_heartbeat' },
  // Circuit state that outlives the run that observed it — see the note in
  // `schema.js` for why a per-run object could never trip.
  { key: 'connector_circuit' },
  // ENH-07. Quarantine homes are declared, not hand-named: one per
  // QUARANTINE_SOURCES entry, appended below.
].map((entry) => Object.freeze({ kind: 'records', ...entry })).concat(
  QUARANTINE_SOURCES.map((source) => Object.freeze({
    key: `quarantine_${source}`,
    kind: 'quarantine',
    quarantines: source,
  })),
))

/** Every declared collection name. The only spelling either adapter reads. */
export const COLLECTIONS = Object.freeze(SCHEMA.map((entry) => entry.key))

const COLLECTION_SET = new Set(COLLECTIONS)

/** True when `collection` is one this store can hold. */
export function isDeclared(collection, declared = COLLECTIONS) {
  return declared.includes(collection)
}

/**
 * Throws if a write payload names a collection this store does not have.
 *
 * The silent version of this function is the loop it replaces, and it is the
 * single most expensive line in this file by incident count. A payload carrying
 * a key that is not in SCHEMA has exactly one cause — a collection was added
 * somewhere other than the declaration — and the cost of not noticing is that
 * the caller is told the write succeeded while its records go nowhere.
 *
 * `declared` is injectable so a test can drop a key from the declaration and
 * watch this fire. That is the only way to know the guard still guards.
 */
export function assertDeclaredCollections(payload, declared = COLLECTIONS) {
  if (!payload || typeof payload !== 'object') return
  const undeclared = Object.keys(payload)
    .filter((key) => !STORE_METADATA_KEYS.includes(key) && !declared.includes(key))
  if (!undeclared.length) return
  throw new Error(
    `Undeclared collection${undeclared.length > 1 ? 's' : ''}: ${undeclared.join(', ')}. `
    + 'Records for a collection missing from SCHEMA are dropped without error — add it there first.',
  )
}

/**
 * Throws on one undeclared collection. The `remove()` guard, which has always
 * been explicit there, kept for the same reason `remove()` kept it.
 */
export function assertDeclaredCollection(collection) {
  if (!COLLECTION_SET.has(collection)) {
    throw new Error(`Unknown collection: ${collection}`)
  }
  return collection
}

export class JsonStore {
  constructor(filePath = process.env.LINDELA_LITE_STORE || path.resolve('data/lindela-lite-store.json')) {
    this.filePath = filePath
    // Every mutation is a read-modify-write of one file. Two concurrent callers
    // would each read the same snapshot and the second write would discard the
    // first's records (20 concurrent POSTs left 6 survivors). This promise
    // chain makes the cycles run one at a time, in arrival order.
    this.tail = Promise.resolve()
    // The parsed store, and the file identity it was parsed from. See `read()`.
    this.#parsed = null
    this.#parsedStamp = null
  }

  #parsed = null
  #parsedStamp = null

  /**
   * The whole store, parsed.
   *
   * This re-read and re-parsed the file on every call, and every API request
   * calls it. With a 364 MB store that is roughly 1.8 GB of live JS objects
   * allocated per request: 120 requests took the process from 63 MB to 1.8 GB
   * and then an OOM killed the server. Not a slow path — a fatal one, and it
   * looked like a leak in code nobody had changed.
   *
   * So the parse is held and reused until the file changes. The stamp is
   * mtime + byte size: `write()` goes through `#writeFile`, which renames a
   * temp file over the target, so a write is always a new identity, and the
   * write path additionally stamps the cache directly rather than trusting the
   * filesystem to notice.
   *
   * **The returned object is shared and must not be mutated.** Every mutator
   * here — `merge`, `remove`, `write` — runs behind `#serialise` and builds its
   * own object, and `mergeById` is pure, so nothing in this module writes
   * through the value `read()` returned. A caller that mutates it corrupts the
   * cache for every later reader, which is why this is written down rather than
   * left to be discovered.
   */
  async read() {
    let stamp
    try {
      const stat = await fs.stat(this.filePath)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#parsed = emptyStore()
        this.#parsedStamp = null
        return this.#parsed
      }
      throw error
    }

    if (this.#parsed && this.#parsedStamp === stamp) return this.#parsed

    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      this.#parsed = this.#ordered({ ...emptyStore(), ...JSON.parse(raw) })
      this.#parsedStamp = stamp
      return this.#parsed
    } catch (error) {
      if (error.code === 'ENOENT') return emptyStore()
      throw error
    }
  }

  /** `mtime:size` for the current file, or null if it cannot be stat'd. */
  async #stamp() {
    try {
      const stat = await fs.stat(this.filePath)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return null
    }
  }

  /**
   * Every declared collection in the one order both adapters return.
   *
   * R-35. This is `sortRecords` applied at read time rather than at write time.
   * `mergeById` has always sorted, so a merged collection was ordered; but
   * `write()` copies its payload through untouched, so a caller that appended
   * left the file in whatever order it handed over — while `PostgresStore`
   * re-sorted on every read. Two stores holding the same records returned them
   * in different orders, and nothing errored.
   *
   * Sorting here rather than only in `#writeFile` because write time is not the
   * only thing that decides a file's order: a file written by an older build,
   * or edited by hand, arrives unsorted too. `#writeFile` runs it as well,
   * because the write path fills the cache directly and a cached value that
   * skipped this would be served past it. The cost is one sort per parse, and
   * the parse is cached — so this is paid once per change to the file rather
   * than once per request, which is the same bargain the parse cache is.
   */
  #ordered(store) {
    for (const collection of COLLECTIONS) {
      const records = store[collection]
      if (Array.isArray(records) && records.length > 1) {
        store[collection] = sortRecords(records)
      }
    }
    return store
  }

  /**
   * Runs a read-modify-write cycle behind the serialisation chain. `task` must
   * not itself call write()/merge()/remove() — it calls #writeFile() instead —
   * or it would deadlock waiting on its own tail.
   */
  #serialise(task) {
    const run = this.tail.then(task, task)
    // The chain must not absorb a failure, or one rejected write would poison
    // every later one; swallow it here and re-surface it to the caller only.
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Unserialised. Writes to a temp file and renames, so a crash mid-write
   *  leaves the previous store intact rather than a truncated JSON file. */
  async #writeFile(data) {
    const next = { ...emptyStore(), ...data, updated_at: nowIso() }
    // R-18. Keyed on the pid alone, so two stores on one path in one process
    // wrote to the same temp file and one of them renamed an empty file into
    // place — reproduced as ENOENT or, worse, a truncated store. The random
    // suffix makes the name unique per *write*, which is the unit that
    // collides; the pid is kept because two processes writing the same path is
    // a different problem and a different answer.
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    // ENH-13 / R-29. Compact, not `null, 2`. Measured at 37.8 MB: 112.6 ms
    // pretty-printed against 17.6 ms compact — indentation is 84% of merge
    // cost, for a file whose bytes are machine-read. It also inflates the file
    // ~40%, and every one of those bytes is re-parsed on a cold read.
    await fs.writeFile(tmp, `${JSON.stringify(next)}\n`)
    await fs.rename(tmp, this.filePath)
    // The cache is refreshed here rather than left to be invalidated by the next
    // `stat`. Doing it at the write means a read immediately after a write
    // cannot race the filesystem's timestamp granularity and serve the previous
    // snapshot — a mtime that has not visibly advanced yet.
    //
    // ENH-13 / R-28. The stamp is the *post-rename* identity, not null. This
    // line used to null it, which contradicted the `read()` docstring directly
    // above and cost a whole-file re-parse on the next read: 24.9 ms cold
    // against 0.2 ms warm, on the write-then-read sequence every API mutation
    // produces. The null was deliberate, to catch a write by a *different*
    // process — so the nulling is gone and the check stays. `read()` still
    // stats and still reparses when the stamp moves; stamping from the stat we
    // just took is what makes the two consistent rather than merely
    // contradictory.
    this.#parsed = this.#ordered(next)
    this.#parsedStamp = await this.#stamp()
    return next
  }

  async write(data) {
    assertDeclaredCollections(data)
    return this.#serialise(() => this.#writeFile(data))
  }

  async merge(partial) {
    assertDeclaredCollections(partial)
    return this.#serialise(async () => {
      const current = await this.read()
      const next = { ...current }
      const superseded = []
      for (const collection of COLLECTIONS) {
        const incoming = partial[collection] || []
        if (!incoming.length) continue
        next[collection] = mergeById(current[collection] || [], incoming)
        if (BITEMPORAL_COLLECTIONS.includes(collection)) {
          superseded.push(...supersededVersions(collection, current[collection] || [], incoming))
        }
      }
      if (superseded.length) {
        // Pruned on every write, not on a retention job. A version table that
        // is only bounded when someone remembers to run the job is not bounded,
        // and the failure is a heap exhaustion rather than a stale row — see
        // `pruneVersions` for the measurement.
        next.record_versions = pruneVersions(
          mergeById(current.record_versions || [], superseded),
        )
      }
      return this.#writeFile(next)
    })
  }

  /**
   * Deletes records by id — the counterpart to merge().
   *
   * Until this existed there was no path by which a record could ever leave the
   * store, which is why apply-retention reported `{success: true, expired: 1}`
   * while deleting nothing: it merged the survivors back over the top of the
   * originals and mergeById keys on id.
   *
   * Takes `{ collection: [id, ...] }`. An unrecognised collection throws rather
   * than being ignored — the same reasoning as COLLECTIONS itself.
   */
  async remove({ collection: doomedByCollection = {} } = {}) {
    return this.#serialise(async () => {
      const current = await this.read()
      const next = { ...current }
      for (const [collection, ids] of Object.entries(doomedByCollection)) {
        assertDeclaredCollection(collection)
        const doomed = new Set(ids || [])
        if (!doomed.size) continue
        next[collection] = (current[collection] || []).filter((record) => !doomed.has(record.id))
      }
      return this.#writeFile(next)
    })
  }

  /**
   * Replaces the derived collections wholesale, leaving ingested data alone.
   * A region that stops qualifying must lose its stale risk_scores row, so this
   * is a replace and not a merge — PostgresStore.replaceAnalytics did the
   * opposite for years (DAT-05).
   *
   * Which collections are replaced is read from DERIVED_COLLECTIONS, not from
   * this signature. A seventh derived collection is one entry in the
   * declaration, and neither adapter can be short one without both being short
   * the same way.
   */
  /**
   * Replaces one collection wholesale, leaving every other collection alone.
   *
   * R-25, the JSON half. The four routes in `server.js` that add one parametric
   * rule read the whole store, splice one array, and call `write()` — which
   * rewrites every collection in the file to change one of them. Here that is
   * still a full serialisation, because a JSON store has no way to rewrite a
   * slice of itself; but it stops being a *store-wide replacement*, which is
   * what made the semantics dangerous: the callers were using `write()`'s
   * "this is the whole new world" contract for what is really "this one
   * collection changed".
   */
  async replaceCollection(collection, records = []) {
    assertDeclaredCollection(collection)
    return this.#serialise(async () => {
      const current = await this.read()
      return this.#writeFile({ ...current, [collection]: sortRecords([...records]) })
    })
  }

  async replaceAnalytics(payload = {}) {
    assertDeclaredCollections(payload)
    const replacement = Object.fromEntries(
      DERIVED_COLLECTIONS.map((collection) => [collection, payload[collection] || []]),
    )
    return this.#serialise(async () => {
      const current = await this.read()
      return this.#writeFile({ ...current, ...replacement })
    })
  }
}

/**
 * The history rows a merge is about to destroy.
 *
 * Returns the *previous* values, before `mergeById` overwrites them. A record
 * that is unchanged — the same `payload_hash` arriving again, which is what a
 * healthy daily re-ingest looks like — produces nothing. Only a revision does,
 * because only a revision loses information.
 *
 * Call this before the merge, not after. After, the previous value is gone,
 * which is the entire problem this module exists to fix.
 */
export function supersededVersions(collection, existing, incoming, { sourceRunId = null, at = nowIso() } = {}) {
  const before = new Map(existing.map((item) => [item.id, item]))
  const rows = []
  for (const item of incoming) {
    const previous = before.get(item.id)
    if (!isRevision(previous, item)) continue
    try {
      rows.push(versionRow({
        collection,
        recordId: item.id,
        previous,
        next: item,
        supersededAt: at,
        sourceRunId: item.source_run_id || sourceRunId,
      }))
    } catch {
      // A record with no timestamp at all cannot open an interval, and
      // versionRow says so. Dropping the row is correct here: an unbounded
      // history entry would make valueAsOf() return a value for times it
      // cannot justify, which is the failure mode bitemporality is meant to
      // eliminate. The overwrite still happens; we decline to lie about when.
    }
  }
  return rows
}

export function mergeById(existing, incoming) {
  const map = new Map()
  const hashMap = new Map()

  for (const item of existing) {
    map.set(item.id, item)
    if (item.payload_hash) {
      if (!hashMap.has(item.payload_hash)) {
        hashMap.set(item.payload_hash, item)
      }
    }
  }

  for (const item of incoming) {
    if (item.payload_hash && hashMap.has(item.payload_hash)) {
      continue
    }
    map.set(item.id, { ...map.get(item.id), ...item })
    if (item.payload_hash) {
      hashMap.set(item.payload_hash, item)
    }
  }

  return sortRecords([...map.values()])
}

/**
 * The order both adapters return a collection in: newest first, id ascending
 * for ties.
 *
 * Exported because PostgresStore has to reach it. It used to order by an
 * `updated_at` column stamped with `now()` at write time, which meant a
 * re-ingested older record sorted above a newer one and the two stores returned
 * the same records in different orders — a divergence invisible to any test
 * that sorted before comparing.
 */
export function sortRecords(records) {
  return [...records].sort((a, b) => {
    const byTime = recordTimestamp(b).localeCompare(recordTimestamp(a))
    if (byTime !== 0) return byTime
    return String(a.id).localeCompare(String(b.id))
  })
}

function recordTimestamp(record) {
  // Presence, not truthiness. A record whose only timestamp field is 0 is a
  // record with a timestamp, and treating it as absent is the falsy-zero bug
  // this repo has already paid for twice in a different column.
  for (const field of SORT_FIELDS) {
    const value = record[field]
    if (value !== undefined && value !== null && value !== '') return String(value)
  }
  return ''
}

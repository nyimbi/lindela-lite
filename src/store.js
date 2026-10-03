import fs from 'node:fs/promises'
import path from 'node:path'
import { emptyStore } from './schema.js'
import { nowIso } from './utils.js'
import { BITEMPORAL_COLLECTIONS, isRevision, versionRow } from './bitemporal.js'

export const COLLECTIONS = [
  'source_runs',
  'ingestion_schedules',
  'climate_observations',
  'hazard_events',
  'conflict_events',
  'service_assets',
  'impact_assessments',
  'risk_scores',
  'data_quality',
  'population_at_risk',
  'facilities_at_risk',
  'data_lineage',
  'incidents',
  'interventions',
  'intervention_tasks',
  'field_reports',
  'response_resources',
  'action_logs',
  'alert_rules',
  'alert_events',
  'trigger_protocols',
  'rapidpro_dispatches',
  'rapidpro_inbound_messages',
  'report_templates',
  'reports',
  'report_distribution_runs',
  'report_schedules',
  'report_schedule_runs',
  'events_outbox',
  'webhook_subscriptions',
  'workflow_instances',
  'community_feedback',
  'parametric_rules',
  'parametric_disbursements',
  'kpi_snapshots',
  'road_access',
  // Every collection JsonStore.merge writes must be listed here: the loop
  // below keys strictly off COLLECTIONS, and an unlisted collection's records
  // are dropped silently — the same class of bug the runIngestion merged map
  // had, caught first by the food-security API test.
  'food_security_records',
  'disease_observations',
  'flood_probability_models',
  // ENH-13. Every superseded value of a record upstream revises in place. Not
  // in emptyStore()-adjacent lists by accident: it is a real collection, and
  // leaving it off this list would drop every history row silently — the exact
  // silent-key-list bug the comment above warns about, one level down.
  'record_versions',
  // ENH-07. One quarantine collection per ingestable collection, holding the
  // batches that failed their assertions together with the failures that
  // condemned them. They need their own collections rather than a flag on the
  // good records because the point is that a condemned batch is never merged:
  // quarantining in place would mean the store holds records nothing published
  // and nothing downstream can tell apart from real ones.
  //
  // Six hand-written names, and the same silent-drop failure if one is missing.
  // `test/ingestion-wiring.test.js` asserts this list covers every key
  // OUTPUT_COLLECTIONS produces, so a new collection cannot be added without
  // either its quarantine home or that failure.
  'quarantine_climate_observations',
  'quarantine_hazard_events',
  'quarantine_conflict_events',
  'quarantine_service_assets',
  'quarantine_food_security_records',
  'quarantine_disease_observations',
]

export class JsonStore {
  constructor(filePath = process.env.LINDELA_LITE_STORE || path.resolve('data/lindela-lite-store.json')) {
    this.filePath = filePath
    // Every mutation is a read-modify-write of one file. Two concurrent callers
    // would each read the same snapshot and the second write would discard the
    // first's records (20 concurrent POSTs left 6 survivors). This promise
    // chain makes the cycles run one at a time, in arrival order.
    this.tail = Promise.resolve()
  }

  async read() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return { ...emptyStore(), ...parsed }
    } catch (error) {
      if (error.code === 'ENOENT') return emptyStore()
      throw error
    }
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
    const tmp = `${this.filePath}.${process.pid}.tmp`
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`)
    await fs.rename(tmp, this.filePath)
    return next
  }

  async write(data) {
    return this.#serialise(() => this.#writeFile(data))
  }

  async merge(partial) {
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
        next.record_versions = mergeById(current.record_versions || [], superseded)
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
        if (!COLLECTIONS.includes(collection)) throw new Error(`Unknown collection: ${collection}`)
        const doomed = new Set(ids || [])
        if (!doomed.size) continue
        next[collection] = (current[collection] || []).filter((record) => !doomed.has(record.id))
      }
      return this.#writeFile(next)
    })
  }

  /**
   * Replaces the six derived collections wholesale, leaving ingested data alone.
   * A region that stops qualifying must lose its stale risk_scores row, so this
   * is a replace and not a merge — PostgresStore.replaceAnalytics did the
   * opposite for years (DAT-05).
   */
  async replaceAnalytics({ risk_scores = [], impact_assessments = [], data_quality = [], population_at_risk = [], facilities_at_risk = [], road_access = [] }) {
    return this.#serialise(async () => {
      const current = await this.read()
      return this.#writeFile({
        ...current,
        risk_scores,
        impact_assessments,
        data_quality,
        population_at_risk,
        facilities_at_risk,
        road_access,
      })
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

  return [...map.values()].sort((a, b) => recordTimestamp(b).localeCompare(recordTimestamp(a)))
}

function recordTimestamp(record) {
  return String(record.updated_at
    || record.completed_at
    || record.generated_at
    || record.observed_at
    || record.occurred_at
    || record.created_at
    || record.started_at
    || '')
}

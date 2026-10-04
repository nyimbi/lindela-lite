/**
 * Bitemporal history for records that upstream revises in place.
 *
 * GDACS, USGS, WHO and NOAA CPC all correct their own numbers after
 * publication. Nothing in this repository noticed. `mergeById` does
 * `{...existing, ...incoming}` keyed on id, so the prior value was overwritten
 * and unrecoverable — and for a tool whose product claim is auditability, a
 * silently corrected historical figure is a serious liability. A donor asking
 * what the tool said last quarter had no answer, because the tool had never
 * kept one.
 *
 * Two clocks, not one. `observed_at` is when the fact was true in the world;
 * `valid_from`/`valid_to` is when *this platform* believed it. The cholera
 * count was 1,204 on Tuesday and 1,388 today, and it was 1,204 as this tool's
 * answer for the whole of that window. Without the second pair of timestamps
 * the first is unrecoverable, because the overwrite destroyed the only record
 * that the earlier value was ever held.
 *
 * The open interval is a real state: `valid_to: null` means "still what we say",
 * which is not the same as "unknown" and must not be rendered as a zero.
 */

import { nowIso, stableId } from './utils.js'

/**
 * The collections whose records upstream revises in place.
 *
 * Exported and frozen so a consumer iterates it rather than re-typing the list.
 * This repository's signature defect is a list written once and checked
 * nowhere — the silent key list — so an unexported one here would be a repeat
 * of the mistake this module exists in part to prevent.
 *
 * Deliberately not every collection. Action logs, alert events and webhook
 * deliveries are append-only by nature and never revised; versioning them would
 * write history rows that record nothing having changed.
 */
export const BITEMPORAL_COLLECTIONS = Object.freeze([
  'hazard_events',
  'conflict_events',
  'climate_observations',
  'food_security_records',
  'disease_observations',
  'service_assets',
])

/** Fields that change on every write and so would report a revision on every merge. */
const NON_SEMANTIC_FIELDS = new Set([
  'updated_at',
  'ingested_at',
  'generated_at',
  'last_run_at',
])

/**
 * Which fields actually differ between two versions of a record.
 *
 * Returns null when nothing meaningful changed. The null is load-bearing: the
 * caller must not write a version row for a merge that carried no new
 * information, or the history table fills with rows recording nothing and the
 * real revisions become hard to find. `canonicalHash` already ignores id and the
 * timestamp keys for a related reason — see its comment in utils.js.
 *
 * A field present in one version and absent in the other is a change. An absent
 * field is not a null field, and collapsing the two would report a deletion
 * every time an optional upstream column simply stopped being sent.
 */
export function changedFields(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed = {}
  for (const key of keys) {
    if (NON_SEMANTIC_FIELDS.has(key)) continue
    const had = Object.hasOwn(before, key)
    const has = Object.hasOwn(after, key)
    if (had !== has) {
      changed[key] = { from: had ? before[key] : null, to: has ? after[key] : null, presence: had ? 'removed' : 'added' }
      continue
    }
    if (before[key] !== after[key]) {
      changed[key] = { from: before[key], to: after[key] }
    }
  }
  return Object.keys(changed).length ? changed : null
}

/**
 * The version row recording what a record used to say.
 *
 * `valid_from` is when we first held the value and `valid_to` when we stopped.
 * Both come from the record's own history rather than from `now`, so a record
 * written by a run last Tuesday and corrected today carries the Tuesday window
 * — which is the whole point. `first_seen_at` is the earliest such field the
 * record carries; `observed_at` is next because a re-observed fact is re-valid
 * from when it was observed.
 */
export function versionRow({ collection, recordId, previous, next = null, supersededAt = nowIso(), sourceRunId = null }) {
  if (!BITEMPORAL_COLLECTIONS.includes(collection)) {
    throw new Error(`Refusing to version ${collection}: it is not a bitemporal collection`)
  }
  const validFrom = previous?.first_seen_at
    || previous?.observed_at
    || previous?.created_at
    || previous?.updated_at
  if (!validFrom) {
    // Without a start we would write a version row whose interval cannot be
    // bounded at the left, and a bitemporal query against it would have to
    // guess. Guessing an interval is worse than declining to record one.
    throw new Error(`Cannot version ${collection}/${recordId}: the previous record has no timestamp to open the interval with`)
  }
  // What changed is measured against the version that replaced it. Without
  // the successor we can still record that *something* was superseded, and the
  // history row is worth writing — an unnamed revision is still a revision.
  const changes = next ? changedFields(previous, next) : null
  return Object.freeze({
    id: stableId('version', [collection, recordId, validFrom, supersededAt]),
    collection,
    record_id: recordId,
    body: previous,
    valid_from: validFrom,
    valid_to: supersededAt,
    open: false,
    changed_fields: changes,
    source_run_id: sourceRunId,
    created_at: nowIso(),
    // No payload_hash, and its absence is deliberate rather than an oversight.
    // mergeById skips an incoming record whose hash it has already seen, and
    // the body's hash *is* the predecessor's — so a version row carrying it
    // would be dropped as a duplicate upstream re-delivery the first time that
    // value came round again. The history is keyed on the interval, which is
    // what makes two rows for one record distinct.
    payload_hash: null,
  })
}

/**
 * Every version of one record, oldest first.
 *
 * `current` is the live row and is *not* synthesised here when the caller did
 * not pass it: a version table that reconstructs the present from its own
 * history is a second source of truth for the present, and the two will
 * disagree the first time a merge path is forgotten.
 *
 * There is deliberately no "open" version row written on merge. The present is
 * the live collection; a second copy of it inside the history is a second
 * truth to keep in step, and `isRevision` already has the prior value in hand
 * when it matters. `gap` below is how a missing interval gets reported instead.
 */
export function versionsFor(versions = [], { collection, recordId, current = null }) {
  const history = versions
    .filter((v) => v.collection === collection && v.record_id === recordId)
    .sort((a, b) => String(a.valid_from || '').localeCompare(String(b.valid_from || '')))
  return Object.freeze({
    collection,
    record_id: recordId,
    current: current || null,
    history: Object.freeze(history),
    // The interval the current value has held for. Null when we cannot say —
    // an unmeasurable start is not a start at the epoch.
    current_valid_from: current
      ? current.first_seen_at || current.observed_at || current.created_at || current.updated_at || null
      : null,
    revisions: history.length,
  })
}

/**
 * What the platform believed about a record at a point in time.
 *
 * This is the query that turns "the 2019 cholera count changed" from a lost
 * edit into a fact a donor can be answered on. Returns null when the platform
 * held nothing then — an absent answer, not a zero count.
 */
export function valueAsOf(versions = [], { collection, recordId, at, current = null }) {
  const atMs = Date.parse(at)
  if (!Number.isFinite(atMs)) return null
  const { history, current: live, current_valid_from: liveFrom } = versionsFor(versions, { collection, recordId, current })
  const candidates = [...history, ...(live ? [{ valid_from: liveFrom, valid_to: null, body: live }] : [])]
  const hit = candidates.find((v) => {
    const from = Date.parse(v.valid_from || '')
    const to = v.valid_to ? Date.parse(v.valid_to) : Infinity
    return Number.isFinite(from) && from <= atMs && to > atMs
  })
  return hit ? hit.body : null
}

/**
 * Whether a merge is a revision rather than a re-delivery.
 *
 * The distinction the whole module rests on. `mergeById` already skips an
 * incoming record whose `payload_hash` it has seen, so an unchanged re-fetch
 * never reaches the overwrite path. What reaches it is a record that claims the
 * same id with different content — which is the only thing a history row should
 * ever be written for. Two records that are byte-identical are not a revision,
 * and a version row saying otherwise is noise in the one table a reader will
 * trust.
 *
 * A record with no `payload_hash` is treated as a revision: the hash is what
 * makes "unchanged" knowable, and without it we cannot claim otherwise. Erring
 * toward recording is the recoverable direction — a spurious history row is
 * deletable, a lost one is not.
 */
export function isRevision(previous, incoming) {
  if (!previous) return false
  if (incoming?.payload_hash && previous.payload_hash) {
    return incoming.payload_hash !== previous.payload_hash
  }
  return changedFields(previous, incoming) !== null
}
/**
 * Versions kept per record, and versions kept in total.
 *
 * Bitemporal history without a bound is not history, it is a second copy of the
 * store that only grows. A version row's id is
 * `stableId('version', [collection, recordId, validFrom, supersededAt])` — it
 * carries the supersession time, which is correct (two runs superseding the same
 * record are two events) and also means every run adds rows rather than
 * replacing them.
 *
 * The cost is not abstract, and it is measured in the heap. Version rows embed
 * the *whole* previous record, so a row costs ~5.7 KB, not a few bytes. Left
 * unbounded the demo store reached 37,735 rows and 300 MB — 69% of the file was
 * history — and because `JsonStore.read()` parsed the whole file, the server's
 * resident set went from 63 MB to 1.8 GB over 120 requests and an OOM killed
 * it. A store that cannot be read repeatedly without exhausting the heap is not
 * bitemporal; it is a memory leak with a schema.
 *
 * The trade is real and is stated rather than hidden: history older than the
 * last `PER_RECORD` revisions of a record is dropped, and `valueAsOf` for a time
 * before that window returns "no version covering that time" instead of an
 * answer. A missing history row is a refusal; a fabricated one is a lie, and
 * this code refuses rather than lies.
 *
 * Five, not twenty. In normal operation these records are revised rarely and
 * almost nothing is ever dropped. The demo's twenty came from re-seeding, which
 * is a development action — and at five the version table is ~63 MB instead of
 * ~251 MB, which is the difference between a server that boots and one that
 * starts the process a fifth of the way to an OOM. If a deployment ever needs a
 * deeper window, this constant is the one place to change it, and the trade
 * above is the thing to re-read before changing it.
 */
export const VERSIONS_PER_RECORD = 5

/** Ceiling across all records, so a wide store cannot accumulate in aggregate. */
export const VERSIONS_TOTAL_MAX = 50_000

/**
 * Keep the most recent `perRecord` versions of each record, then the most recent
 * `total` across everything.
 *
 * Order within a record is by `valid_to` (when the revision stopped being true),
 * falling back to insertion order for rows that predate the field. Sorting on
 * `valid_to` rather than on the array position matters because the array is
 * append-ordered by run, and a later run can supersede a record whose earlier
 * revision had the later timestamp.
 *
 * Pure: takes an array, returns an array. Exported so retention is testable
 * without a store.
 */
export function pruneVersions(versions = [], { perRecord = VERSIONS_PER_RECORD, total = VERSIONS_TOTAL_MAX } = {}) {
  if (!Array.isArray(versions) || versions.length === 0) return []

  const byRecord = new Map()
  for (const version of versions) {
    // A row without a record id cannot be attributed to one, so it cannot be
    // ranked against them either. Kept: dropping history we cannot classify is
    // a different decision from bounding it.
    const key = version?.record_id ? `${version.collection}:${version.record_id}` : `\u0000unkeyed:${version?.id || ''}`
    const list = byRecord.get(key)
    if (list) list.push(version)
    else byRecord.set(key, [version])
  }

  const kept = []
  for (const list of byRecord.values()) {
    if (list.length <= perRecord) { kept.push(...list); continue }
    const ordered = [...list].sort((a, b) => String(a?.valid_to || '').localeCompare(String(b?.valid_to || '')))
    kept.push(...ordered.slice(-perRecord))
  }

  if (kept.length <= total) return kept
  const ordered = [...kept].sort((a, b) => String(a?.valid_to || '').localeCompare(String(b?.valid_to || '')))
  return ordered.slice(-total)
}

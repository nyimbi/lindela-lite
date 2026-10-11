import crypto from 'node:crypto'

/**
 * CAP-04 — an export names the vintage it read.
 *
 * `/api/v1/export.*` returned a live query with an ETag. An ETag revalidates a
 * *request*; it does not identify a *dataset*. So a report citing "the
 * flood-risk dataset" could not say which read produced its numbers, and two
 * partners who pulled an hour apart had no way to tell whether they held the
 * same thing. The ETag made that worse rather than better: it changes when any
 * byte changes, so the one identifier the route offered was not stable across
 * two reads of identical data either — a re-serialisation with a different key
 * order is a different ETag and the same dataset.
 *
 * **A vintage is a hash of content, not of bytes.** `contentHash` canonicalises
 * (sorted keys, recursively) before hashing, so two reads of the same records
 * agree on the vintage however the store ordered them. That is the property an
 * ETag lacks and the reason a content hash is the right identifier here: a
 * consumer comparing vintages is asking "is this the same data", not "is this
 * the same response".
 *
 * **What a vintage is not.** It is not a snapshot. The store keeps no copy, and
 * `?vintage=` on an export is refused rather than silently ignored — offering a
 * parameter that cannot be honoured is worse than not offering it, because a
 * report that names a vintage it did not actually read is a citation that lies.
 * `GET /api/v1/exports` lists the vintages this process has *served*, which is
 * an index of what partners hold, not a store of what they can fetch.
 */

/** The collections an export reads, and therefore the ones a vintage covers. */
export const EXPORT_COLLECTIONS = Object.freeze([
  'hazard_events', 'conflict_events', 'service_assets', 'risk_scores',
  'impact_assessments', 'incidents', 'interventions', 'intervention_tasks',
  'field_reports', 'response_resources', 'alert_rules', 'alert_events',
  'rapidpro_dispatches', 'rapidpro_inbound_messages',
])

/**
 * A stable hash over a value, independent of key order.
 *
 * The same canonicalisation `canonicalHash` applies to a record, lifted to a
 * whole payload. Numbers are stringified as JSON does, so `1` and `1.0` agree
 * and `"1"` does not — a stringified number is a different value, and an export
 * that round-tripped a numeric column through a CSV would otherwise claim a
 * vintage it did not read.
 */
export function contentHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/**
 * The vintage of a set of records read out of a store.
 *
 * `records` is a flat list — the export routes already concatenate their
 * collections — and each record is hashed on its own before the list is hashed,
 * so the vintage is over record *contents* rather than over the array's
 * formatting. `generated_at` and the other write stamps are excluded, because
 * two reads of the same data an hour apart must produce the same vintage; that
 * is the whole point of having one.
 */
export function vintageOf(records, { store = null } = {}) {
  const list = Array.isArray(records) ? records : []
  const perRecord = list.map((record) => canonicalRecordHash(record))
  perRecord.sort()
  return {
    vintage: contentHash(perRecord),
    record_count: list.length,
    // The store's own last-write stamp, carried beside the content hash rather
    // than inside it. It answers a different question — when was this store
    // written — and folding it into the vintage would make two identical reads
    // disagree, which is the failure the ETag already had.
    store_updated_at: store?.updated_at ?? null,
    generated_at: new Date().toISOString(),
    // The hash covers these fields and no others. A consumer checking a vintage
    // needs to know what it is a hash *of*, or the identifier is unverifiable.
    hashed_fields: 'every field of every record except id, payload_hash, ingested_at, generated_at, updated_at, created_at and first_seen_at, sorted by key',
  }
}

const IGNORED = ['id', 'payload_hash', 'ingested_at', 'generated_at', 'updated_at', 'created_at', 'first_seen_at']

function canonicalRecordHash(record) {
  if (record === null || typeof record !== 'object') return contentHash(record ?? null)
  const filtered = {}
  for (const key of Object.keys(record)) {
    if (IGNORED.includes(key)) continue
    filtered[key] = record[key]
  }
  return contentHash(filtered)
}

/**
 * The vintages this process has served, newest first, bounded.
 *
 * In-process and deliberately so, like the idempotency store: this deployment
 * is one process against one store, and the question the index answers — "what
 * did partners pull recently" — is about this process's responses. The bound is
 * a ring, and a caller is told when it has been reached rather than being shown
 * a truncated history as if it were complete.
 */
export function createVintageIndex({ limit = 200 } = {}) {
  const entries = []
  let dropped = 0
  return {
    record(entry) {
      if (!entry?.vintage) return null
      const existing = entries.find((e) => e.vintage === entry.vintage)
      if (existing) {
        // Initialised on first serve rather than left undefined: `undefined += 1`
        // is NaN, and a NaN count is a number a reader will try to reason about.
        existing.served_count += 1
        existing.last_served_at = entry.generated_at
        return existing
      }
      entry.served_count = 1
      entry.last_served_at = entry.generated_at
      entries.unshift(entry)
      if (entries.length > limit) {
        entries.pop()
        dropped += 1
      }
      return entry
    },
    list() {
      return {
        vintages: [...entries],
        returned: entries.length,
        dropped: dropped || undefined,
        limit,
        // Stated because a list of "every vintage served" that silently began
        // at the 201st read is the truncation this repository keeps removing.
        note: dropped
          ? `the index is a ring of ${limit}; ${dropped} older vintage(s) have been evicted and are not listed`
          : `every vintage this process has served is listed, up to the ring's ${limit}`,
      }
    },
  }
}

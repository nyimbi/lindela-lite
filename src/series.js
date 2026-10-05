import { BITEMPORAL_COLLECTIONS, valueAsOf, versionsFor } from './bitemporal.js'

/**
 * ENH-49 — "what did the platform believe about this region on that date", as a
 * query rather than a reconstruction.
 *
 * The store keeps a bitemporal history — every superseded value, with the
 * interval it was believed for — and two functions that can read it. Both had
 * zero production callers: the history existed, and nothing could reach it. So
 * every temporal question ("why does this district's 2019 count disagree with
 * the report?") was answered by scanning and re-filtering by hand, or not
 * answered.
 *
 * The projection is over the bitemporal collections because those are the ones
 * with an observation history. A field report is an event, not a state: it does
 * not have a value the platform held and later changed, and projecting it as
 * though it did would invent a history of edits nobody made.
 *
 * The honesty that matters here is the coverage statement. `pruneVersions`
 * keeps the last five revisions per record (R-26), so this answers the recent
 * past and says so — a series that quietly stops three years ago reads as "the
 * platform believed nothing then", which is the one claim this must never make.
 */

export const HISTORY_PRUNE_KEEP = 5

export function isProjectable(collection) {
  return BITEMPORAL_COLLECTIONS.includes(collection)
}

export function projectableCollections() {
  return [...BITEMPORAL_COLLECTIONS]
}

function inScope(record, district) {
  if (!district) return true
  if (record?.district) return record.district === district
  if (record?.country && String(district).includes(String(record.country))) return true
  return false
}

function stampOf(record) {
  return record?.first_seen_at || record?.observed_at || record?.created_at || record?.updated_at || null
}

/**
 * One point on the series: the value the platform held, and the interval it held
 * it for.
 *
 * `believed_from` is the start of the interval, not the moment the value was
 * written — the distinction is the whole point of a bitemporal history, and
 * collapsing them is how a retrospective edit becomes invisible.
 */
function point(record, { believedFrom, believedTo, source }) {
  return {
    record_id: record.id,
    district: record.district ?? null,
    country: record.country ?? null,
    // The value a reader cares about, named per collection where the field
    // differs, plus the whole body so nothing is lost by projecting.
    observed_at: record.observed_at ?? null,
    value: record.value ?? record.score ?? record.total ?? record.cases ?? null,
    believed_from: believedFrom,
    believed_to: believedTo,
    source,
    body: record,
  }
}

/**
 * The series for one collection, optionally one district.
 *
 * Assembled from the live rows plus the version rows, because the present is
 * the live collection and a second copy of it inside the history would be a
 * second truth to keep in step.
 */
export function observationSeries(snapshot, { collection, district = null, at = null } = {}) {
  if (!isProjectable(collection)) {
    return {
      collection,
      projectable: false,
      reason: `${collection} is not a bitemporal collection: its records are events, not ` +
        'states the platform held and later changed, so it has no observation history to project',
      projectable_collections: projectableCollections(),
      points: [],
    }
  }

  const current = (snapshot[collection] || []).filter((r) => inScope(r, district))
  const versions = (snapshot.record_versions || []).filter((v) => v.collection === collection)

  const atMs = at ? Date.parse(at) : null
  if (at && !Number.isFinite(atMs)) {
    return {
      collection,
      projectable: true,
      points: [],
      error: `at="${at}" is not a date`,
      projectable_collections: projectableCollections(),
    }
  }

  const points = []
  for (const version of versions) {
    if (district && !inScope(version.body, district)) continue
    points.push(point(version.body, {
      believedFrom: version.valid_from,
      believedTo: version.valid_to,
      source: 'history',
    }))
  }
  for (const record of current) {
    points.push(point(record, {
      believedFrom: stampOf(record),
      believedTo: null,
      source: 'current',
    }))
  }

  points.sort((a, b) => String(a.believed_from || '').localeCompare(String(b.believed_from || '')))

  // `at` asks a different question, and answering it with the whole series
  // would be answering neither: what did the platform hold *then*.
  const asOf = atMs === null
    ? null
    : points.find((p) => {
      const from = Date.parse(p.believed_from || '')
      const to = p.believed_to ? Date.parse(p.believed_to) : Infinity
      return Number.isFinite(from) && from <= atMs && to > atMs
    }) || null

  const historyCount = points.filter((p) => p.source === 'history').length
  const earliest = points.find((p) => p.believed_from)?.believed_from ?? null

  return {
    collection,
    projectable: true,
    district,
    points,
    as_of: asOf,
    // On every response, not only the refusal: a client that asks for a
    // collection by the wrong name should learn the right ones from the same
    // call rather than by reading this repository.
    projectable_collections: projectableCollections(),
    coverage: {
      // The honest statement of what this can answer. Five revisions per record
      // is a cap the store applies for its own reasons, and a series that stops
      // without saying so would be read as a period of not knowing.
      earliest_believed: earliest,
      latest_believed: points.length ? points[points.length - 1].believed_from : null,
      history_points: historyCount,
      current_points: points.length - historyCount,
      revisions_kept_per_record: HISTORY_PRUNE_KEEP,
      truncated: historyCount > 0,
      note: historyCount === 0
        ? 'no superseded values are retained for this selection, so this series is current state only'
        : `superseded values are retained for the most recent ${HISTORY_PRUNE_KEEP} revisions per record; earlier history has been pruned`,
    },
  }
}

/**
 * One record at one instant, or its whole revision list.
 *
 * The two temporal questions the platform could not answer before: what was this
 * record's value on a date, and what has it been edited through.
 */
export function recordHistory(snapshot, { collection, recordId, at = null } = {}) {
  const current = (snapshot[collection] || []).find((r) => r.id === recordId) || null
  const versions = snapshot.record_versions || []
  const listed = versionsFor(versions, { collection, recordId, current })
  return {
    ...listed,
    collection,
    at: at ?? null,
    value_as_of: at ? valueAsOf(versions, { collection, recordId, at, current }) : null,
    coverage: {
      revisions_kept: listed.history.length,
      revisions_kept_per_record: HISTORY_PRUNE_KEEP,
      truncated: listed.history.length >= HISTORY_PRUNE_KEEP,
      note: listed.history.length === 0
        ? 'this record has never been revised, so there is no history to show'
        : `the most recent ${HISTORY_PRUNE_KEEP} revisions are retained; older ones have been pruned`,
    },
  }
}

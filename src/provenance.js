/**
 * ENH-15: record-level provenance, and the lineage row it was supposed to write.
 *
 * What was wrong, in the specific terms this module replaces:
 *
 * - `src/lineage.js` wrote `upstream_url_or_endpoint: null` on every row and
 *   `transform_version: '0.1.0'` — a constant typed once, in one place, that
 *   nothing in the build ever revisited. The parser could change six times a
 *   year and every row would still say 0.1.0, because the version was a claim
 *   rather than an observation. So `transformVersionFor` here derives the
 *   version from the source of the function that did the work.
 * - `src/ingestion.js` rebuilt `allRecords` as the union of every source's
 *   records and then wrote that union once per source run. A nine-source run
 *   therefore produced nine rows whose `record_count` and `payload_hashes`
 *   described the whole run, attributed to nine different sources — and
 *   `stableId(..., now)` gave each a fresh id, so the store kept all nine
 *   rather than deduplicating them. `recordLineageRow` takes the records *for
 *   its own run* and derives its id from `[source, source_run_id]` with no
 *   clock in it.
 * - IPC and WHO were excluded from lineage entirely. There is nothing in this
 *   module that knows which source it is looking at: `buildProvenance` takes a
 *   connector spec like any other, so a source that was forgotten becomes a
 *   test failure rather than a silent gap.
 *
 * WHAT THE WIRING WAVE NEEDS (nothing here is wired up yet):
 *
 *   buildProvenance({ sourceRun, connector, records, retrieval, transform })
 *     -> array of `_provenance` envelopes, one per record, in record order.
 *        Attach with `record._provenance = envelope[i]`.
 *   transformVersionFor(fn)
 *     -> `src:tf_<hash>` for a function or an array of functions. Pass the
 *        connector's `ingest` and any mapping helper it composes; do not pass a
 *        bound function (see the note on native source below).
 *   connectorVersion(spec)
 *     -> `spec.version` as a string, or `undefined`. Never `null`.
 *   payloadHashFor(record)
 *     -> the record's existing `payload_hash`, else `canonicalHash(record)`.
 *   recordLineageRow({ sourceRun, records, provenance })
 *     -> one data_lineage row for one source run.
 *   PROVENANCE_FIELDS
 *     -> the frozen field list. Iterate it in routes, exports and tests; do
 *        not re-type the names.
 */

import { canonicalHash, nowIso, stableId } from './utils.js'

/**
 * The envelope's fields, in the order they are built. Frozen so a consumer
 * cannot add a field and make the list quietly disagree with the object — the
 * silent key list is this repo's signature defect, and an exported list is the
 * only version of it that cannot rot.
 */
export const PROVENANCE_FIELDS = Object.freeze([
  'source_run_id',
  'connector_id',
  'connector_version',
  'retrieval_url',
  'retrieved_at',
  'payload_hash',
  'transform_version',
  'upstream_id',
  'upstream_id_state',
])

/**
 * Where a provider's own record identifier might live, in priority order.
 *
 * This is a search list, not a projection: nothing is dropped for not being on
 * it, because a key that is not here is reported as `unknown` rather than as
 * absent — see `upstreamIdFor`. `source_id` is what all three connectors
 * actually write today (gdacs, ipc_hdx, who_gho); the rest are the spellings a
 * fourth connector is likely to reach for.
 */
export const UPSTREAM_ID_KEYS = Object.freeze([
  'source_id',
  'upstream_id',
  'external_id',
  'provider_id',
  'guid',
])

/**
 * Per-record retrieval URL fallbacks, in priority order, used only when the
 * caller passed no `retrieval.url`. WHO fetches eight different indicator URLs
 * inside one source run and GDACS one feed, so the URL cannot be a per-run
 * constant — which is why `retrieval.url` may also be a function of the record.
 */
const RETRIEVAL_URL_PATHS = Object.freeze([
  (record) => record?.source_url,
  (record) => record?.retrieval_url,
  (record) => record?.metadata?.feed,
  (record) => record?.metadata?.dataset,
  (record) => record?.metadata?.dataset_url,
])

/**
 * A version derived from the code that actually produced the row.
 *
 * This is a proxy for change detection, not a semver. It answers one question —
 * "is this the same transform that wrote last month's data?" — by hashing the
 * function's own source, and it is deliberately coarse: it changes on *any*
 * edit, including a comment or a rename, and it carries no information about
 * whether the change altered the output. That is the trade. A hand-typed
 * '0.1.0' is finer-looking and worthless: nobody bumps it, so it says 0.1.0
 * forever and the question it appears to answer is never actually answered. A
 * hash over-calls; a constant under-calls. Over-calling wastes a re-run.
 *
 * The hash covers only the function passed in. A connector that composes
 * `parseGdacsItem` from a helper must pass both, or the helper's changes will
 * not move the version.
 */
export function transformVersionFor(fn) {
  const sources = (Array.isArray(fn) ? fn : [fn])
    .filter((candidate) => typeof candidate === 'function')
    .map((candidate) => sourceTextFor(candidate))
  if (!sources.length) return undefined
  // The `src:` prefix is load-bearing. A reader meeting `src:tf_3f9a…` in a
  // column next to semver-looking values elsewhere should not have to open this
  // file to learn that the two are not comparable.
  return `src:${stableId('tf', sources.join('\n\n'))}`
}

/**
 * `fn.toString()`, or a stand-in when there is nothing to read.
 *
 * `Function.prototype.bind` stringifies as `function () { [native code] }`, so
 * hashing it as written would give every bound transform the same fingerprint
 * and the guarantee would evaporate quietly. So would a function from another
 * realm. The stand-in keeps the function's name in the hash, so two bound
 * transforms of differently-named functions stay apart — but two versions of
 * the same function collide, which is the residual cost and the reason the
 * caller has to pass the underlying function. It is not self-announcing: the
 * result is an ordinary-looking `src:tf_…`, and nothing at the call site says
 * the source was unreadable.
 */
function sourceTextFor(fn) {
  const text = fn.toString()
  return text.includes('[native code]') ? `[native code] ${fn.name || 'anonymous'}` : text
}

/**
 * The connector's declared version, or `undefined`.
 *
 * `undefined` is the point. `defineConnector` in `src/connectors/spec.js`
 * freezes exactly `{id, description, schema, defaults, ingest}`, so a `version`
 * key on a spec is dropped today and this returns `undefined` for every
 * connector in the repo. That is the current fact, not an error to paper over.
 *
 * It must not become `null` on its way into the envelope: a column of strings
 * holding one `null` says "somebody set the version to null", which is a
 * different claim from "nobody declared one". Consumers can test for `null`;
 * they cannot tell that apart from a real value.
 */
export function connectorVersion(spec) {
  if (!spec || typeof spec !== 'object') return undefined
  const declared = spec.version ?? spec.schema?.version
  return typeof declared === 'string' && declared.trim() ? declared.trim() : undefined
}

/**
 * The record's payload hash: its own if it has one, otherwise a fresh one.
 *
 * `canonicalHash` in `src/utils.js` drops `id`, `payload_hash`,
 * `ingested_at`, `generated_at`, `updated_at`, `created_at` and
 * `first_seen_at` before hashing, and sorts keys at every depth. That is
 * exactly why this is stable across a re-ingest: the same upstream row hashes
 * the same whether it is brand new or three months old, so `mergeById` can
 * tell "unchanged" from "corrected" by hash alone. Two limits worth knowing:
 * the drop-list is applied at the *top level only* — a nested `metadata.id` is
 * hashed — and `_provenance` is not on the drop-list, which is why it is
 * stripped here rather than left to change the hash of its own record.
 */
export function payloadHashFor(record) {
  if (!record || typeof record !== 'object') return canonicalHash({})
  // Presence, not truthiness: a stored hash is a hex string, and the one value
  // that would be lost to a truthiness test is `''`, which is no hash at all.
  if (record.payload_hash !== null && record.payload_hash !== undefined && record.payload_hash !== '') {
    return record.payload_hash
  }
  const { _provenance, ...payload } = record
  return canonicalHash(payload)
}

/**
 * One envelope per record, in record order.
 *
 * @param {object} options
 * @param {object} options.sourceRun the source run, `{id, source, started_at}`
 * @param {object} [options.connector] a connector spec; `id` and `version` are read from it
 * @param {Array<object>} options.records the records this run produced
 * @param {object} [options.retrieval] `{url, retrieved_at}`; `url` may be a
 *   function of the record, which is what WHO and IPC need — a single run
 *   fetches several endpoints
 * @param {Function|Function[]} [options.transform] the code that transformed
 *   the rows, for `transformVersionFor`
 * @returns {Array<object>} envelopes, aligned index-for-index with `records`
 */
export function buildProvenance({ sourceRun, connector, records = [], retrieval = {}, transform = null } = {}) {
  if (!Array.isArray(records)) throw new TypeError('buildProvenance requires records to be an array')

  const retrievedAt = retrieval.retrieved_at || sourceRun?.started_at || nowIso()
  const connectorId = connector?.id ?? sourceRun?.source ?? undefined
  const connectorVersionValue = connectorVersion(connector)
  const transformVersion = transformVersionFor(transform)

  return records.map((record) => {
    const upstream = upstreamIdFor(record)
    return {
      source_run_id: sourceRun?.id,
      connector_id: connectorId,
      connector_version: connectorVersionValue,
      retrieval_url: retrievalUrlFor(record, retrieval),
      retrieved_at: retrievedAt,
      payload_hash: payloadHashFor(record),
      transform_version: transformVersion,
      upstream_id: upstream.upstream_id,
      upstream_id_state: upstream.upstream_id_state,
    }
  })
}

/**
 * One data_lineage row for one source run.
 *
 * Every value here is derived from this run's own records. That is the whole
 * fix: the old loop passed the union of every source's records to a function
 * called once per source run, so `record_count` and `payload_hashes` on all nine
 * rows described all nine sources, and `stableId` — which had `now` mixed into
 * its key material — gave each a distinct id, so nothing deduplicated them.
 *
 * The id here is `stableId('lineage', [source, source_run_id])` with no clock
 * in it, so deriving this row twice from the same run produces the same row.
 *
 * @param {object} options
 * @param {object} options.sourceRun the source run these records came from
 * @param {Array<object>} options.records *this run's* records, not the run-wide union
 * @param {Array<object>} [options.provenance] envelopes from `buildProvenance`
 */
export function recordLineageRow({ sourceRun, records = [], provenance = [] } = {}) {
  if (!sourceRun?.id) throw new TypeError('recordLineageRow requires a sourceRun with an id')
  if (!Array.isArray(records)) throw new TypeError('recordLineageRow requires records to be an array')

  const payloadHashes = records.map((record) => payloadHashFor(record))
  const upstreamChecksum = canonicalHash({ hashes: payloadHashes })

  return {
    id: stableId('lineage', [sourceRun.source, sourceRun.id]),
    source: sourceRun.source,
    source_run_id: sourceRun.id,
    retrieval_time: sourceRun.started_at,
    // Not a constant null. A row that cannot name where its data came from
    // cannot answer the question lineage exists to answer, and the retrieval
    // URL was sitting in `retrieval.url` the whole time.
    upstream_url_or_endpoint: firstRetrievalUrl(provenance),
    transform_version: summariseTransformVersions(provenance),
    record_count: records.length,
    payload_hashes: payloadHashes,
    upstream_checksum: upstreamChecksum,
    created_at: nowIso(),
  }
}

/**
 * The provider's own record id, or a stated reason there isn't one.
 *
 * Three states, because two of them used to be one `null` and the difference
 * is the whole question:
 *
 *   'present' — a value was found.
 *   'absent'  — the record *has* one of the identifier fields and the value in
 *               it is empty. The provider gave us nothing, and we know that.
 *   'unknown' — the record has no identifier field at all, so we do not know
 *               whether the provider has one.
 *
 * Collapsing the last two into `null` is how a connector quietly stops carrying
 * upstream ids: the rows still look complete, every consumer filters out the
 * nulls, and the regression only surfaces when someone tries to reconcile
 * against the provider and finds nothing to reconcile. 'absent' is a fact about
 * the world. 'unknown' is a fact about us, and the two call for different
 * follow-up.
 */
function upstreamIdFor(record) {
  if (!record || typeof record !== 'object') return { upstream_id: null, upstream_id_state: 'unknown' }
  let sawEmptyField = false
  for (const key of UPSTREAM_ID_KEYS) {
    if (!Object.hasOwn(record, key)) continue
    const value = record[key]
    if (isAbsentValue(value)) {
      sawEmptyField = true
      continue
    }
    return { upstream_id: value, upstream_id_state: 'present' }
  }
  return sawEmptyField
    ? { upstream_id: null, upstream_id_state: 'absent' }
    : { upstream_id: null, upstream_id_state: 'unknown' }
}

/**
 * Absence is null, undefined, or an empty string. Nothing else.
 *
 * `0` and `'0'` are values, and they are the falsy-zero trap this codebase has
 * already paid for twice: a truthiness test over a nullable field turns a real
 * zero into an absence, and an identifier of `0` is a real identifier. A
 * country code, an HTTP status, an episode number — all of them can be zero.
 */
function isAbsentValue(value) {
  if (value === null || value === undefined) return true
  return typeof value === 'string' && value.trim() === ''
}

function retrievalUrlFor(record, retrieval) {
  const declared = typeof retrieval?.url === 'function' ? retrieval.url(record) : retrieval?.url
  if (isAbsentValue(declared)) {
    for (const read of RETRIEVAL_URL_PATHS) {
      const candidate = read(record)
      if (!isAbsentValue(candidate)) return String(candidate)
    }
    return null
  }
  return String(declared)
}

function firstRetrievalUrl(provenance) {
  for (const envelope of provenance) {
    if (!isAbsentValue(envelope?.retrieval_url)) return envelope.retrieval_url
  }
  return null
}

/**
 * One version when the run had one; every version when it did not.
 *
 * A run whose records were transformed by two different versions of the
 * connector is a real state, and reporting one of the two would be a lie in
 * the direction that matters — the version would name a transform that did not
 * produce every row. Both are named, so the row can be split and the runs
 * compared.
 */
function summariseTransformVersions(provenance) {
  const versions = [...new Set(provenance.map((envelope) => envelope?.transform_version).filter((version) => version))]
  if (!versions.length) return null
  return versions.length === 1 ? versions[0] : `mixed:${versions.sort().join('+')}`
}

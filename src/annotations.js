/**
 * ENH-74 — collaborative annotation threads on a record.
 *
 * A coordination platform's users need to talk to each other on a record:
 * "this access road is washed out", "the clinic's stock figure looks wrong",
 * "who confirmed the second shelter is open". Those are annotations — a person's
 * words attached to a record — and threaded, because a question and its answer
 * are one conversation and a flat feed loses the reply's parent the moment a
 * second thread is opened.
 *
 * ## Why this is not a comment table
 *
 * The product's claim is auditability, so an annotation carries the same
 * provenance discipline as the record it annotates. "The record says X" is
 * answerable only if every claim attached to it can be attributed: who wrote it,
 * when, and from what. An annotation that cannot name its author is exactly the
 * unattributed claim `src/audit-chain.js` refuses to write, and it is refused
 * here for the same reason.
 *
 * ## Provenance
 *
 * Each annotation carries a `provenance` object built by
 * `buildProvenance` in `src/provenance.js`, so it has that module's exact shape
 * rather than a parallel one — the fields are `PROVENANCE_FIELDS`, and this
 * module re-exports that list so a consumer iterates it instead of re-typing the
 * names. Two of the nine fields are re-read for a human author because a
 * connector's meanings do not transfer cleanly:
 *
 *   - `connector_id` is the author. For an ingested record it names the source
 *     connector; for an annotation the source is a person, so the caller passes
 *     the identity the platform already trusts — the token fingerprint
 *     `actorFor` in `src/audit-chain.js` derives (`token_<hash>`) — rather than
 *     a body-supplied string. This module does not re-derive it: a second
 *     implementation of identity beside the first is how two answers to "who
 *     acted" appear.
 *   - `upstream_id` is the `client_annotation_id` the client minted, with
 *     `upstream_id_state` saying whether it was present or absent — the
 *     distinction provenance.js insists on, kept here because a re-sent
 *     annotation must deduplicate and a missing one must not.
 *
 * The remaining fields keep their record meaning: `retrieval_url` is the route
 * the annotation was posted to, `retrieved_at` when the server received it,
 * `payload_hash` over the annotation's own content, `transform_version` derived
 * from the code that built it. `source_run_id` and `connector_version` are
 * `undefined`, which is the honest value: an annotation has no ingest run and no
 * connector version, and `null` there would claim somebody set it to null.
 *
 * ## Bitemporal, and why
 *
 * `src/bitemporal.js` versions the collections upstream revises in place and
 * deliberately excludes append-only ones ("versioning them would write history
 * rows that record nothing having changed"). An annotation is neither: it is
 * append-only in that it is never deleted, and revised in that its author edits
 * it. An edit is a correction of the same claim, so it belongs on the
 * transaction-time axis the way a revised cholera count does.
 *
 * So an annotation is bitemporal in the shape of that module: `created_at` is
 * when the annotation entered the store, `valid_from`/`valid_to` is the window
 * during which *this platform held this text as the annotation*. An edit closes
 * the current version at `supersededAt` and opens a new one, and the prior text
 * is preserved verbatim — the bitemporal model says an edited annotation is a new
 * version, not an overwrite, and this module is built so it cannot be one:
 * `editAnnotation` returns a NEW annotation object and never mutates the one it
 * was handed. A caller holding the old object still holds the old text.
 *
 * The record is versioned rather than split into a separate history array on
 * purpose. `versionRow` in bitemporal.js exists for records that are *merged* —
 * one live row plus a version table — but an annotation is read as a
 * conversation, and a thread whose edits live in a side table is a thread a
 * reader has to join before they can read it. So each version is a first-class
 * annotation with its own id, `supersedes` naming the version it replaced and
 * `superseded_by` naming its successor once there is one; a read filters to the
 * live versions (`valid_to === null`) and `versionsOf` returns the chain.
 *
 * ## Retraction does not destroy history
 *
 * `retractAnnotation` sets `retracted_at`/`retracted_by` and closes the valid
 * interval. The body is kept. This is ADR-007's soft delete applied to a
 * person's words: the row stays so the thread's structure and the audit trail
 * stay resolvable, but it is stamped so a read can present it as withdrawn
 * rather than as a live claim. Deleting the row would leave a reply pointing at
 * nothing, which is the orphan this module otherwise refuses to create.
 *
 * ## What is refused
 *
 * The cases that cannot be grounded, each with an explicit check rather than a
 * silent repair:
 *
 *   - a reply whose parent does not exist — an orphan is a conversation with a
 *     hole in it, and inventing a root for it would misattribute the reply;
 *   - an annotation with no author — an unattributed claim is what provenance
 *     exists to prevent;
 *   - an empty body — there is nothing to attribute;
 *   - a cycle introduced by an edit, an annotation moved under its own
 *     descendant. This is the one that bites: `parent_id` is a plain field and
 *     nothing in a store stops it being set to a value that makes the tree a
 *     graph with no root, at which point `flattenThread` recurses forever and
 *     every read of the thread hangs. So an edit that changes `parent_id` walks
 *     the prospective parent's ancestor chain and refuses if it meets the
 *     annotation being moved.
 *
 * ## What a `src/schema.js` entry would need
 *
 * This module owns its record shape and exports it; it does not edit the
 * registry. Wiring it in needs a matching pair of entries, because the repo's
 * signature defect is a collection named in one list and not the other:
 *
 *   - `emptyStore()` in `src/schema.js` needs `annotations: []`, and
 *   - `COLLECTIONS` in `src/store.js` needs `annotations`, since `JsonStore.merge`
 *     keys strictly off `COLLECTIONS` and drops an unlisted collection silently.
 *
 * The two must be added together. A field report carries a `record_id` and a
 * `record_collection` naming what it is attached to, so the same record can be
 * annotated from more than one surface without the annotation knowing which.
 *
 * ## PII
 *
 * An annotation body is free text a person typed about a place and a hazard, so
 * it may carry a name, a phone number or a precise location, and — unlike a
 * structured record — it is not field-mapped, so `redactPii` in `src/pii.js`
 * cannot reach inside it. Two consequences the caller must honour, stated here
 * rather than left to be discovered:
 *
 *   1. The module stores the body verbatim; redaction is a store/export concern
 *      and belongs on the read path, where the policy is loaded once.
 *   2. `src/pii.js` gives `community_feedback` its own retention window
 *      (`communityFeedbackDays`) because a person's own words are not an
 *      operational record. An annotation is the same kind of object, so a
 *      deployment that wires this collection should extend `retentionWindowFor`
 *      with an `annotations` case rather than fall through to the general window
 *      — a person exercising the right to be heard on a record is not a hazard
 *      reading, and should not be kept as long as one by default.
 */

import { canonicalHash, nowIso, stableId } from './utils.js'
import { PROVENANCE_FIELDS, buildProvenance } from './provenance.js'
import { ERROR_CODES } from './errors.js'

/**
 * The provenance field list, re-exported so a consumer iterates one list.
 *
 * A copy here that could drift from `src/provenance.js` would be the silent key
 * list this repo keeps paying for. There is no copy: this is the same frozen
 * array, re-exported under the name a reader of this module will reach for.
 */
export const ANNOTATION_PROVENANCE_FIELDS = PROVENANCE_FIELDS

/**
 * The route an annotation posted over HTTP is recorded against.
 *
 * `retrieval_url` on an ingested record names where the payload came from. For
 * an annotation the only such address is the endpoint it was posted to, so this
 * is the default the caller may override with the request's own path.
 */
export const ANNOTATION_RETRIEVAL_URL = '/api/v1/annotations'

/** A refusal the transport layer turns into a status. */
function refuse(message, statusCode = 400, code = ERROR_CODES.UNPROCESSABLE_ENTITY) {
  return Object.assign(new Error(message), { statusCode, code })
}

/**
 * Absence is null, undefined, or a blank string — the definition
 * `src/provenance.js` uses, kept identical so the two modules cannot disagree
 * about what "no author" means.
 *
 * `0` and `'0'` are values, not absences. The falsy-zero trap is real here too:
 * a record id of `0` is a real record.
 */
function isAbsent(value) {
  if (value === null || value === undefined) return true
  return typeof value === 'string' && value.trim() === ''
}

/** The client-minted id an annotation carries, or null when it carried none. */
function clientIdOf(annotation) {
  return isAbsent(annotation?.client_annotation_id) ? null : String(annotation.client_annotation_id)
}

/** The id of the live version of an annotation: the successor if it has one, else itself. */
export function liveVersionOf(annotations, id) {
  let current = annotations.find((a) => a.id === id) || null
  let guard = 0
  while (current?.superseded_by && guard < annotations.length + 1) {
    const next = annotations.find((a) => a.id === current.superseded_by)
    if (!next) break
    current = next
    guard += 1
  }
  return current
}

/** The whole chain of versions ending at `id`, oldest first. */
export function versionsOf(annotations, id) {
  let current = annotations.find((a) => a.id === id) || null
  const chain = current ? [current] : []
  let guard = 0
  while (current?.supersedes && guard < annotations.length + 1) {
    const previous = annotations.find((a) => a.id === current.supersedes)
    if (!previous) break
    chain.unshift(previous)
    current = previous
    guard += 1
  }
  return chain
}

/**
 * The author's own string, or `undefined` when the caller gave none.
 *
 * `connectorVersion` in provenance.js returns `undefined` rather than `null` for
 * the same reason: an absent author and an author set to null are different
 * claims, and a consumer can test for one and not the other.
 */
function authorOf(input) {
  const actor = input?.actor ?? input?.author ?? null
  return isAbsent(actor) ? undefined : String(actor)
}

/**
 * Build one annotation, or refuse.
 *
 * Pure: takes the whole annotation set and returns a new annotation object
 * without touching it. The set is needed only to ground the parent — a reply to
 * a parent that is not in the set is refused here, before the annotation exists.
 *
 * @param {object} input
 * @param {string} input.record_id the record this thread is attached to
 * @param {string} [input.record_collection] what kind of record that is
 * @param {string} [input.parent_id] the annotation being replied to, or absent for a root
 * @param {string} input.body the person's words
 * @param {string|object} input.actor the author; a token subject is preferred
 * @param {Array<object>} [options.annotations] the set to ground the parent against
 * @param {string} [options.now] an ISO timestamp, for a deterministic test
 * @param {string} [options.retrievalUrl] the route it was posted to
 * @returns {object} the annotation
 */
export function buildAnnotation(input = {}, { annotations = [], now = nowIso(), retrievalUrl = ANNOTATION_RETRIEVAL_URL } = {}) {
  if (!Array.isArray(annotations)) throw new TypeError('buildAnnotation requires annotations to be an array')

  const recordId = input.record_id ?? input.recordId ?? null
  if (isAbsent(recordId)) throw refuse('an annotation must name the record it is attached to')

  const author = authorOf(input)
  if (author === undefined) {
    // Not "anonymous". An unattributed annotation is the claim provenance.js
    // exists to make impossible, and defaulting the author would put a name on
    // words nobody signed.
    throw refuse('an annotation must have an author', 400, ERROR_CODES.BAD_REQUEST)
  }

  if (isAbsent(input.body)) throw refuse('an annotation body cannot be empty')

  const parentId = isAbsent(input.parent_id) ? null : String(input.parent_id)
  if (parentId !== null && !annotations.some((a) => a.id === parentId)) {
    // A reply to a parent that does not exist is an orphan. Inventing a root for
    // it would silently misattribute the reply to whatever the caller meant by
    // the missing id.
    throw refuse(`parent annotation ${parentId} does not exist`, 404, ERROR_CODES.NOT_FOUND)
  }

  const clientAnnotationId = clientIdOf(input)

  // Dedupe on the client's own id before minting anything. A retried POST must
  // not fork the thread; the second send returns the first annotation.
  if (clientAnnotationId !== null) {
    const existing = annotations.find(
      (a) => a.record_id === recordId && clientIdOf(a) === clientAnnotationId,
    )
    if (existing) return existing
  }

  const annotation = {
    id: stableId('annotation', [recordId, author, input.body, clientAnnotationId, now]),
    record_id: String(recordId),
    record_collection: isAbsent(input.record_collection) ? null : String(input.record_collection),
    parent_id: parentId,
    body: String(input.body),
    author,
    created_at: now,
    // The valid interval. A new annotation is the value held from now on, so
    // `valid_to: null` is the open interval bitemporal.js calls a real state.
    valid_from: now,
    valid_to: null,
    // The version chain. A first version supersedes nothing and is superseded by
    // nothing; both fields exist on every version so a reader never has to test
    // for their presence.
    supersedes: null,
    superseded_by: null,
    // Retraction stamps, in the shape ADR-007 gives an operational record.
    retracted_at: null,
    retracted_by: null,
    client_annotation_id: clientAnnotationId,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  }

  // Provenance last, because it hashes the annotation's own content and must see
  // the final body.
  return attachProvenance(annotation, { author, retrievalUrl, now, transform: buildAnnotation })
}

/**
 * Attach the shared provenance envelope to one annotation.
 *
 * `buildProvenance` wants records, so the envelope is read back off the
 * single-element array it returns. Two of its nine fields are then restated,
 * and the reason is that the shared module discovers a provider's identifier by
 * searching `UPSTREAM_ID_KEYS` — a list written for connectors, where
 * `source_id` is what the three in-repo sources actually write. An annotation's
 * identifier comes from the client under a name of its own, so the value and its
 * state are set here: `present` when the client sent one, `absent` when it did
 * not. `unknown` would be the wrong claim — the field is on every annotation and
 * its emptiness is known, which is precisely the distinction provenance.js draws.
 */
function attachProvenance(annotation, { author, retrievalUrl, now, transform }) {
  const clientAnnotationId = clientIdOf(annotation)
  const [provenance] = buildProvenance({
    sourceRun: { id: undefined, source: undefined },
    connector: { id: author },
    records: [annotation],
    retrieval: { url: retrievalUrl, retrieved_at: now },
    transform,
  })
  provenance.upstream_id = clientAnnotationId
  provenance.upstream_id_state = clientAnnotationId === null ? 'absent' : 'present'
  annotation.provenance = provenance
  return annotation
}

/**
 * An edit is a new version, not an overwrite.
 *
 * Returns a NEW annotation object and never mutates `previous`. The prior
 * version is closed (`valid_to` set, `superseded_by` set) and the new one opens
 * at `supersededAt`, carrying `supersedes` back to it. The prior text survives in
 * the caller's array unchanged, so "what did this say last week" is answerable —
 * which is the whole reason the bitemporal model exists.
 *
 * An edit may move an annotation to a different parent, which is how a
 * mis-threaded reply is corrected. That is also the one edit that can create a
 * cycle, so `assertNoCycle` runs before anything is built.
 *
 * @param {object} previous the live annotation being edited
 * @param {object} patch the fields to change; only `body`, `parent_id` and
 *   `metadata` are honoured, because the rest are provenance and history
 * @param {object} options
 * @param {Array<object>} options.annotations the set, for parent and cycle checks
 * @returns {{ previous: object, current: object }} the closed and the opened version
 */
export function editAnnotation(previous, patch = {}, { annotations = [], now = nowIso() } = {}) {
  if (!previous || isAbsent(previous.id)) throw refuse('editAnnotation requires the annotation being edited')
  if (previous.retracted_at) {
    // Editing a withdrawn annotation would put words back into the thread under
    // a stamp that says they were taken out. The author writes a new annotation.
    throw refuse('a retracted annotation cannot be edited', 409, ERROR_CODES.CONFLICT)
  }
  if (isAbsent(patch.body)) throw refuse('an edited annotation needs a body')

  const nextParentId = Object.hasOwn(patch, 'parent_id')
    ? (isAbsent(patch.parent_id) ? null : String(patch.parent_id))
    : previous.parent_id

  if (nextParentId !== null && !annotations.some((a) => a.id === nextParentId)) {
    throw refuse(`parent annotation ${nextParentId} does not exist`, 404, ERROR_CODES.NOT_FOUND)
  }

  // The cycle check, and the reason this function exists in this shape. Moving an
  // annotation under one of its own descendants makes the tree a cycle: no root,
  // and a recursive read of the thread never terminates. It is refused rather
  // than repaired because there is no correct repair — the caller's intent is
  // ambiguous and picking a parent for them would be a guess written into the
  // conversation.
  assertNoCycle(annotations, previous.id, nextParentId)

  const current = {
    ...previous,
    id: stableId('annotation', [previous.id, patch.body, nextParentId, now]),
    body: String(patch.body),
    parent_id: nextParentId,
    metadata: patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : previous.metadata,
    created_at: now,
    valid_from: now,
    valid_to: null,
    supersedes: previous.id,
    superseded_by: null,
    retracted_at: null,
    retracted_by: null,
  }

  attachProvenance(current, {
    author: previous.author,
    retrievalUrl: previous.provenance?.retrieval_url || ANNOTATION_RETRIEVAL_URL,
    now,
    transform: editAnnotation,
  })

  const closed = {
    ...previous,
    valid_to: now,
    superseded_by: current.id,
    // The prior version's own provenance is re-read so its payload_hash covers
    // the text as it stood, not the text that replaced it.
    provenance: { ...previous.provenance, payload_hash: canonicalHash({ body: previous.body }) },
  }

  return { previous: closed, current }
}

/**
 * Refuse an edit that would make `id` its own ancestor.
 *
 * Walks the prospective parent's ancestor chain. If `id` is on it, the move
 * closes a loop. The walk is bounded by the set's length so a cycle that already
 * exists in the data cannot hang the check that exists to prevent cycles — a
 * guard that can itself be hung by the condition it guards is not a guard.
 */
export function assertNoCycle(annotations, id, nextParentId) {
  if (nextParentId === null) return
  if (nextParentId === id) {
    throw refuse('an annotation cannot be its own parent', 400, ERROR_CODES.INVALID_STATE)
  }
  const byId = new Map(annotations.map((a) => [a.id, a]))
  let cursor = byId.get(nextParentId) || null
  let steps = 0
  while (cursor && steps <= annotations.length) {
    if (cursor.id === id) {
      throw refuse('an annotation cannot become its own ancestor', 400, ERROR_CODES.INVALID_STATE)
    }
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) || null : null
    steps += 1
  }
}

/**
 * Withdraw an annotation without destroying it.
 *
 * The body stays. `retracted_at`/`retracted_by` are stamped and the valid
 * interval is closed, so a read presents it as withdrawn and the thread's
 * structure — replies that point at it — stays resolvable. Removing the row
 * would create exactly the orphan `buildAnnotation` refuses to create.
 */
export function retractAnnotation(annotation, { by = null, now = nowIso() } = {}) {
  if (!annotation || isAbsent(annotation.id)) throw refuse('retractAnnotation requires the annotation being retracted')
  if (annotation.retracted_at) {
    // A second retraction is not a conflict to retry; the caller must be told to
    // stop, as `buildSoftDelete` does for a second DELETE.
    throw refuse('annotation is already retracted', 409, ERROR_CODES.RECORD_DELETED)
  }
  return { ...annotation, retracted_at: now, retracted_by: isAbsent(by) ? null : String(by), valid_to: now }
}

/**
 * The live annotations of one record, in a stable order.
 *
 * Live means: the current version of each chain, not retracted. The current
 * version is the one with no `superseded_by`; a reader who wants the edits asks
 * `versionsOf`.
 */
export function liveAnnotations(annotations = [], { recordId } = {}) {
  if (!Array.isArray(annotations)) throw new TypeError('liveAnnotations requires annotations to be an array')
  return annotations
    .filter((a) => (recordId === undefined ? true : a.record_id === recordId))
    .filter((a) => !a.superseded_by)
    .filter((a) => !a.retracted_at)
}

/**
 * The flat ordered read: every live annotation, depth-first, with its depth.
 *
 * Deterministic order, which the repo's gates demand of anything they assert on:
 * siblings sort by `created_at` then by `id`, so two annotations written in the
 * same millisecond still have one order and not a different one per run.
 *
 * An annotation whose parent is not in the set is treated as a root rather than
 * dropped. That should not happen — a reply is grounded at write time — but a
 * read that silently loses rows when the data is damaged is the failure this
 * whole module is written to avoid, and surfacing the row at depth 0 is the
 * recoverable direction.
 */
export function flattenThread(annotations = [], { recordId } = {}) {
  if (!Array.isArray(annotations)) throw new TypeError('flattenThread requires annotations to be an array')
  const live = liveAnnotations(annotations, { recordId })
  const ids = new Set(live.map((a) => a.id))

  const childrenOf = new Map()
  for (const annotation of live) {
    const key = annotation.parent_id && ids.has(annotation.parent_id) ? annotation.parent_id : null
    const list = childrenOf.get(key)
    if (list) list.push(annotation)
    else childrenOf.set(key, [annotation])
  }

  const order = (list) => [...list].sort((a, b) => {
    const byTime = String(a.created_at || '').localeCompare(String(b.created_at || ''))
    return byTime !== 0 ? byTime : String(a.id).localeCompare(String(b.id))
  })

  const out = []
  const walk = (parentId, depth, seen) => {
    for (const annotation of order(childrenOf.get(parentId) || [])) {
      // `seen` bounds the walk. assertNoCycle keeps cycles out at write time, but
      // a set assembled by hand can still hold one, and a read that hangs on bad
      // data is worse than a read that stops.
      if (seen.has(annotation.id)) continue
      seen.add(annotation.id)
      out.push({ ...annotation, depth })
      walk(annotation.id, depth + 1, seen)
    }
  }
  walk(null, 0, new Set())
  return out
}

/**
 * The tree: roots with their replies nested under `replies`.
 *
 * The same annotations `flattenThread` returns, arranged for a renderer that
 * wants the structure rather than the walk.
 */
export function buildThread(annotations = [], { recordId } = {}) {
  if (!Array.isArray(annotations)) throw new TypeError('buildThread requires annotations to be an array')
  const flat = flattenThread(annotations, { recordId })
  const nodes = new Map(flat.map((a) => [a.id, { ...a, replies: [] }]))
  const roots = []
  for (const annotation of flat) {
    const node = nodes.get(annotation.id)
    const parent = annotation.parent_id ? nodes.get(annotation.parent_id) : null
    if (parent) parent.replies.push(node)
    else roots.push(node)
  }
  return roots
}

/**
 * Counts a thread surface shows without walking it.
 *
 * `retracted` is counted over every version, not just the live set, because a
 * retracted annotation has left the live set and a reader asking "how many were
 * withdrawn" means the ones that were, not the ones that still are.
 */
export function threadSummary(annotations = [], { recordId } = {}) {
  if (!Array.isArray(annotations)) throw new TypeError('threadSummary requires annotations to be an array')
  const scoped = annotations.filter((a) => (recordId === undefined ? true : a.record_id === recordId))
  const live = liveAnnotations(scoped)
  const authors = new Set(live.map((a) => a.author))
  return {
    record_id: recordId ?? null,
    total_versions: scoped.length,
    live: live.length,
    roots: live.filter((a) => !a.parent_id).length,
    replies: live.filter((a) => a.parent_id).length,
    edited: live.filter((a) => a.supersedes).length,
    retracted: scoped.filter((a) => a.retracted_at).length,
    authors: authors.size,
    // The latest activity, so a thread list can order by it. Null when there is
    // nothing to order — an absent answer, not the epoch.
    last_activity_at: live.reduce(
      (latest, a) => (!latest || String(a.created_at) > latest ? a.created_at : latest),
      null,
    ),
  }
}

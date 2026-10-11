#!/usr/bin/env node
/**
 * ENH-74 — collaborative annotation threads, and the four refusals that keep a
 * thread readable.
 *
 * The load-bearing claim is that an annotation carries the same provenance
 * discipline as the record it annotates, so the first suite asserts the envelope
 * against `PROVENANCE_FIELDS` rather than against a list written here — a list
 * copied into a test is the silent key list this repo keeps paying for, and it
 * would keep passing after the module stopped carrying a field.
 *
 * The rest is the shape of the tree and the cases that cannot be grounded: a
 * reply to a parent that does not exist, an annotation with no author, and an
 * edit that would make an annotation its own ancestor. The cycle is the one that
 * bites — nothing in a plain `parent_id` field stops it, and a cycle turns every
 * read of the thread into an infinite recursion — so it is asserted at two
 * depths and by hand-built data as well as through the editor.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ANNOTATION_PROVENANCE_FIELDS,
  ANNOTATION_RETRIEVAL_URL,
  assertNoCycle,
  buildAnnotation,
  buildThread,
  editAnnotation,
  flattenThread,
  liveAnnotations,
  retractAnnotation,
  threadSummary,
  versionsOf,
} from '../src/annotations.js'
import { PROVENANCE_FIELDS } from '../src/provenance.js'

const AUTHOR = 'token_9f2c1a4b7e60'
const T0 = '2026-10-12T08:00:00.000Z'

/** A root annotation on one record, with deterministic ids and clock. */
function root(overrides = {}, options = {}) {
  return buildAnnotation(
    { record_id: 'incident-1', record_collection: 'incidents', body: 'Access road washed out at the bridge.', actor: AUTHOR, ...overrides },
    { now: T0, ...options },
  )
}

describe('provenance is the record discipline, not a parallel shape', () => {
  it('carries every field PROVENANCE_FIELDS names, no more and no fewer', () => {
    const annotation = root()
    const carried = Object.keys(annotation.provenance).sort()
    assert.deepEqual(carried, [...PROVENANCE_FIELDS].sort(), 'the envelope has exactly the shared field list')
    // The re-export is the same frozen array, not a copy that could drift.
    assert.equal(ANNOTATION_PROVENANCE_FIELDS, PROVENANCE_FIELDS)
  })

  it('names the author, the route and the receipt time', () => {
    const annotation = root({ client_annotation_id: 'client-7' })
    assert.equal(annotation.provenance.connector_id, AUTHOR, 'the author is where a connector id would be')
    assert.equal(annotation.provenance.retrieval_url, ANNOTATION_RETRIEVAL_URL)
    assert.equal(annotation.provenance.retrieved_at, T0)
    assert.equal(annotation.provenance.upstream_id, 'client-7', "the client's own id is the upstream id")
    assert.equal(annotation.provenance.upstream_id_state, 'present')
    assert.match(annotation.provenance.payload_hash, /^[0-9a-f]{64}$/)
    assert.match(annotation.provenance.transform_version, /^src:tf_[0-9a-f]+$/)
  })

  it('reports an absent client id as absent, not unknown, and not null', () => {
    // The distinction provenance.js insists on: the field is there and empty
    // ('absent'), which is a different claim from the field not existing at all.
    const annotation = root()
    assert.equal(annotation.provenance.upstream_id, null)
    assert.equal(annotation.provenance.upstream_id_state, 'absent')
  })

  it('leaves the ingest fields undefined rather than null', () => {
    // An annotation has no source run and no connector version. `undefined` is
    // the honest value; `null` would claim somebody set them to null.
    const { provenance } = root()
    assert.equal(provenance.source_run_id, undefined)
    assert.equal(provenance.connector_version, undefined)
  })
})

describe('a thread is a tree and a flat ordered read', () => {
  it('nests replies under their parents and walks depth-first', () => {
    const a = root()
    const b = buildAnnotation(
      { record_id: 'incident-1', parent_id: a.id, body: 'Bridge confirmed out; using the northern track.', actor: 'token_second' },
      { annotations: [a], now: '2026-10-12T08:05:00.000Z' },
    )
    const c = buildAnnotation(
      { record_id: 'incident-1', parent_id: b.id, body: 'Northern track is passable to 4x4 only.', actor: AUTHOR },
      { annotations: [a, b], now: '2026-10-12T08:10:00.000Z' },
    )
    const set = [a, b, c]

    const flat = flattenThread(set, { recordId: 'incident-1' })
    assert.deepEqual(flat.map((x) => x.id), [a.id, b.id, c.id])
    assert.deepEqual(flat.map((x) => x.depth), [0, 1, 2])

    const tree = buildThread(set, { recordId: 'incident-1' })
    assert.equal(tree.length, 1, 'one root')
    assert.equal(tree[0].replies.length, 1)
    assert.equal(tree[0].replies[0].replies.length, 1)
  })

  it('orders siblings by time, and by id when two share a millisecond', () => {
    // Deterministic order is what lets a gate assert on a thread. Two
    // annotations written in the same millisecond must not reorder between runs.
    const first = root({ body: 'first', client_annotation_id: 'c1' })
    const second = root({ body: 'second', client_annotation_id: 'c2' })
    const later = buildAnnotation(
      { record_id: 'incident-1', body: 'later', actor: AUTHOR },
      { now: '2026-10-12T09:00:00.000Z' },
    )
    const order = flattenThread([later, second, first], { recordId: 'incident-1' }).map((x) => x.body)
    assert.deepEqual(order, ['first', 'second', 'later'])
  })

  it('scopes a read to one record', () => {
    const here = root()
    const elsewhere = buildAnnotation({ record_id: 'incident-2', body: 'other record', actor: AUTHOR }, { now: T0 })
    assert.deepEqual(liveAnnotations([here, elsewhere], { recordId: 'incident-1' }).map((a) => a.id), [here.id])
  })
})

describe('what the module refuses', () => {
  it('refuses a reply to a parent that does not exist', () => {
    assert.throws(
      () => buildAnnotation({ record_id: 'incident-1', parent_id: 'annotation_missing', body: 'reply', actor: AUTHOR }),
      (error) => error.statusCode === 404 && /does not exist/.test(error.message),
    )
  })

  it('refuses an annotation with no author', () => {
    assert.throws(
      () => buildAnnotation({ record_id: 'incident-1', body: 'unattributed claim' }),
      (error) => error.statusCode === 400 && /must have an author/.test(error.message),
    )
    // A blank author is an absent author, not an author named ''.
    assert.throws(() => root({ actor: '   ' }), /must have an author/)
  })

  it('refuses an empty body and a missing record id', () => {
    assert.throws(() => root({ body: '  ' }), /body cannot be empty/)
    assert.throws(() => buildAnnotation({ body: 'x', actor: AUTHOR }), /must name the record/)
  })

  it('refuses an edit that would make an annotation its own ancestor', () => {
    const a = root()
    const b = buildAnnotation({ record_id: 'incident-1', parent_id: a.id, body: 'reply', actor: AUTHOR }, { annotations: [a], now: '2026-10-12T08:05:00.000Z' })
    assert.throws(
      () => editAnnotation(a, { body: 'edited', parent_id: b.id }, { annotations: [a, b], now: '2026-10-12T08:20:00.000Z' }),
      (error) => error.statusCode === 400 && /own ancestor/.test(error.message),
    )
  })

  it('refuses a cycle at depth, not only one hop up', () => {
    const a = root()
    const b = buildAnnotation({ record_id: 'incident-1', parent_id: a.id, body: 'b', actor: AUTHOR }, { annotations: [a], now: '2026-10-12T08:05:00.000Z' })
    const c = buildAnnotation({ record_id: 'incident-1', parent_id: b.id, body: 'c', actor: AUTHOR }, { annotations: [a, b], now: '2026-10-12T08:10:00.000Z' })
    assert.throws(
      () => editAnnotation(a, { body: 'edited', parent_id: c.id }, { annotations: [a, b, c], now: '2026-10-12T08:20:00.000Z' }),
      /own ancestor/,
    )
    // And directly, on the guard the editor calls.
    assert.throws(() => assertNoCycle([a, b, c], a.id, c.id), /own ancestor/)
    assert.throws(() => assertNoCycle([a], a.id, a.id), /own parent/)
  })

  it('does not hang on a set that already holds a cycle', () => {
    // The guard must not be hangable by the condition it guards. A hand-built
    // pair that point at each other must not spin.
    const x = { id: 'x', parent_id: 'y' }
    const y = { id: 'y', parent_id: 'x' }
    assert.doesNotThrow(() => assertNoCycle([x, y], 'z', 'x'))
    const flat = flattenThread([{ ...x, record_id: 'r' }, { ...y, record_id: 'r' }], { recordId: 'r' })
    assert.ok(Array.isArray(flat), 'a damaged set reads rather than recursing forever')
  })

  it('refuses a second retraction rather than reporting success twice', () => {
    const once = retractAnnotation(root(), { by: AUTHOR, now: T0 })
    assert.throws(() => retractAnnotation(once, { by: AUTHOR }), (error) => error.statusCode === 409)
  })

  it('refuses to edit a retracted annotation', () => {
    const retracted = retractAnnotation(root(), { by: AUTHOR, now: T0 })
    assert.throws(
      () => editAnnotation(retracted, { body: 'back from the dead' }, { annotations: [retracted] }),
      (error) => error.statusCode === 409,
    )
  })
})

describe('an edit is a new version, never an overwrite', () => {
  it('preserves the prior text and links the two versions', () => {
    const original = root({ body: 'Three shelters open.' })
    const snapshot = original.body
    const { previous, current } = editAnnotation(
      original,
      { body: 'Three shelters open; the fourth is flooded.' },
      { annotations: [original], now: '2026-10-12T10:00:00.000Z' },
    )

    assert.equal(previous.body, snapshot, 'the prior version still carries the prior text')
    assert.equal(original.body, snapshot, 'the object handed in was not mutated')
    assert.equal(previous.valid_to, '2026-10-12T10:00:00.000Z', 'its interval is closed')
    assert.equal(previous.superseded_by, current.id)
    assert.equal(current.supersedes, original.id)
    assert.equal(current.valid_to, null, 'the new version holds the open interval')
    assert.notEqual(current.id, original.id, 'a version is a distinct annotation')
    assert.match(current.provenance.payload_hash, /^[0-9a-f]{64}$/)

    const chain = versionsOf([previous, current], current.id)
    assert.deepEqual(chain.map((v) => v.body), [snapshot, current.body], 'both versions are readable, oldest first')
  })

  it('keeps only the live version in the thread read', () => {
    const original = root({ body: 'v1' })
    const { previous, current } = editAnnotation(original, { body: 'v2' }, { annotations: [original], now: '2026-10-12T10:00:00.000Z' })
    const set = [previous, current]
    assert.deepEqual(liveAnnotations(set, { recordId: 'incident-1' }).map((a) => a.body), ['v2'])
    assert.equal(flattenThread(set, { recordId: 'incident-1' }).length, 1)
    assert.equal(threadSummary(set, { recordId: 'incident-1' }).total_versions, 2)
  })

  it('carries a reply forward when its parent is edited', () => {
    // Editing the parent must not orphan the reply: the reply still names the
    // old version's id, and the old version is still in the set with a closed
    // interval — which is why retraction and edit keep the row.
    const parent = root({ body: 'p1' })
    const reply = buildAnnotation({ record_id: 'incident-1', parent_id: parent.id, body: 'r', actor: AUTHOR }, { annotations: [parent], now: '2026-10-12T08:05:00.000Z' })
    const { previous, current } = editAnnotation(parent, { body: 'p2' }, { annotations: [parent, reply], now: '2026-10-12T08:10:00.000Z' })
    const set = [previous, current, reply]
    assert.deepEqual(versionsOf(set, current.id).map((v) => v.body), ['p1', 'p2'], 'the parent keeps both versions')
    assert.ok(set.find((a) => a.id === reply.parent_id), 'the reply still points at a version that exists')
  })
})

describe('retraction withdraws without destroying', () => {
  it('stamps the withdrawal and keeps the body', () => {
    const annotation = root({ body: 'Wrong clinic; ignore.' })
    const retracted = retractAnnotation(annotation, { by: AUTHOR, now: '2026-10-12T11:00:00.000Z' })
    assert.equal(retracted.body, 'Wrong clinic; ignore.', 'the words are kept')
    assert.equal(retracted.retracted_at, '2026-10-12T11:00:00.000Z')
    assert.equal(retracted.retracted_by, AUTHOR)
    assert.equal(retracted.valid_to, '2026-10-12T11:00:00.000Z')
    assert.equal(liveAnnotations([retracted], { recordId: 'incident-1' }).length, 0, 'withdrawn from the live read')
  })
})

describe('the client id deduplicates a retried write', () => {
  it('returns the first annotation rather than forking the thread', () => {
    const first = root({ client_annotation_id: 'client-7' })
    const retry = buildAnnotation(
      { record_id: 'incident-1', body: 'Access road washed out at the bridge.', actor: AUTHOR, client_annotation_id: 'client-7' },
      { annotations: [first], now: '2026-10-12T08:00:05.000Z' },
    )
    assert.equal(retry.id, first.id, 'the second send is the same annotation')
    // A different client id is a different annotation, not a duplicate.
    const other = buildAnnotation(
      { record_id: 'incident-1', body: 'Access road washed out at the bridge.', actor: AUTHOR, client_annotation_id: 'client-8' },
      { annotations: [first], now: '2026-10-12T08:00:05.000Z' },
    )
    assert.notEqual(other.id, first.id)
  })
})

describe('the summary a thread surface shows', () => {
  it('counts roots, replies, edits and withdrawals without walking the tree', () => {
    const a = root({ body: 'p1' })
    const { previous, current } = editAnnotation(a, { body: 'p2' }, { annotations: [a], now: '2026-10-12T08:10:00.000Z' })
    const reply = buildAnnotation({ record_id: 'incident-1', parent_id: current.id, body: 'r', actor: 'token_second' }, { annotations: [current], now: '2026-10-12T08:20:00.000Z' })
    const gone = retractAnnotation(
      buildAnnotation({ record_id: 'incident-1', body: 'oops', actor: AUTHOR }, { now: '2026-10-12T08:30:00.000Z' }),
      { by: AUTHOR, now: '2026-10-12T08:35:00.000Z' },
    )
    const summary = threadSummary([previous, current, reply, gone], { recordId: 'incident-1' })
    assert.equal(summary.total_versions, 4)
    assert.equal(summary.live, 2)
    assert.equal(summary.roots, 1)
    assert.equal(summary.replies, 1)
    assert.equal(summary.edited, 1)
    assert.equal(summary.retracted, 1)
    assert.equal(summary.authors, 2)
    assert.equal(summary.last_activity_at, '2026-10-12T08:20:00.000Z')
  })
})

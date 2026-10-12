/**
 * ENH-80 — federated multi-node deployment.
 *
 * Several Lindela nodes — a national store, regional stores, a partner's store —
 * each hold a whole store and peer-sync with one another. There is no central
 * store, so no single node is a chokepoint and none is a single point of
 * failure. The topology is the bitemporal model's, applied between nodes instead
 * of between runs: the valid-time axis is what makes a record that arrives from
 * a peer late still orderable against one written here.
 *
 * ## The store is the boundary
 *
 * There is no wire protocol in this module. An exchange reads from one store and
 * writes to another through `read` and `merge` — two of the methods
 * `test/store-conformance.test.js` exercises against every backend. A store added
 * later syncs without touching this file, because a node *is* a store and a peer
 * *is* another store. `PostgresStore` is not named here and not imported here.
 *
 * The peer's whole store is the message. That is not a shortcut: a store read
 * already returns the declared shape with every collection present
 * (`manifestShape`), already honours a row budget (SCL-01) and already excludes
 * history unless asked (ENH-08). Inventing a second envelope would be a second
 * contract to keep in step with the first, which is the defect class this
 * repository keeps paying for.
 *
 * ## The merge rule, and why two nodes converge
 *
 * For a record `r` held at both nodes after an exchange, the value kept is the
 * one with the **latest valid time**, `validTime(record)`. That is
 * `first_seen_at` when the record carries one — stamped once, on the first
 * ingest, and never rewritten (`src/ingestion.js`) — else the store's own
 * `recordTimestamp` cascade, imported rather than copied. The node's own
 * ordering and the federation's winner therefore agree by construction rather
 * than by coincidence.
 *
 * Why that converges. `validTime` is a function of the record alone, and the
 * record that wins a merge is the one with the greater `validTime`, so a node's
 * stored value for `r` after any sequence of exchanges is the *maximum* of the
 * values it has seen under `validTime`. Maximum is commutative, associative and
 * idempotent; therefore
 *
 *   - `A→B; B→A` and `B→A; A→B` leave both nodes holding the same value for
 *     every record — the two orders compute the same maximum;
 *   - re-running an exchange changes nothing — idempotence is `max(x, x) = x`.
 *
 * Both are asserted in `test/federation.test.js`, in both orders.
 *
 * **The tie is broken visibly, not silently.** Two nodes can hold different
 * bodies for one id at the same valid time, and there is no clock to appeal to.
 * The tie-break is `contentDigest` — a digest of the record's own content — so
 * the winner is a function of the two records rather than of which node ran the
 * exchange or in which order the array arrived. That matters for the same reason
 * `SORT_FIELDS` ends in `id`: without a total order, "the same records" sorted
 * two ways is two different lists and nothing errors. And because a tie is
 * information — two nodes disagreeing about the same instant is a thing that
 * happened — `exchangeWith` returns every such record in `conflicts`, naming both
 * bodies, so the divergence is legible rather than merely resolved.
 *
 * Two records at *different* valid times are not a conflict: the later one is the
 * later value of the same fact, which is what a bitemporal store is for.
 *
 * **What the rule deliberately does not carry: deletion.** A record deleted at
 * one node stays at every other. `mergeById` cannot express a removal — it keys
 * on id and only ever adds or overwrites — and there is no tombstone collection
 * to carry one, so propagating a delete would mean guessing that absence means
 * removal. Absence means removal only when the peer's read *completed*, and a
 * peer read that failed is indistinguishable from a peer that holds nothing. So
 * deletion propagation is left to the topology that can state it: a tombstone
 * collection, or an explicit `remove` driven by a caller that knows the record
 * was deleted rather than merely not seen. Guessing here would turn one node's
 * outage into a fleet-wide deletion, which is the failure this refusal avoids.
 *
 * ## A derived collection is not synced as a value
 *
 * `DERIVED_COLLECTIONS` — risk scores, impact assessments, population at risk,
 * region trust, model drift and the rest — are recomputed from their inputs on
 * every refresh, and `replaceAnalytics` *replaces* them rather than accumulating
 * (see the comment on `DERIVED_COLLECTIONS`: calibration and drift are recomputed
 * from scratch so a region's stale trust score does not outlive the evidence).
 *
 * Shipping a derived figure between nodes would ship a number that is a function
 * of a store the receiving node does not have. A peer's `risk_scores` row is the
 * output of that peer's hazard inputs, its model version and its calibration
 * window; merged here it would sit beside a locally computed row for the same
 * region and the two would be indistinguishable — and the local refresh, which
 * replaces the collection wholesale, would silently delete the peer's row on its
 * next run while the peer's refresh would delete ours. A value that is deleted by
 * an unrelated job is worse than one never sent.
 *
 * So the inputs are synced and the peer recomputes. This module refuses a derived
 * collection by name, with the reason, and it never writes one: the collections
 * it iterates come from `SYNCABLE_COLLECTIONS`, which is `COLLECTIONS` minus the
 * derived set minus history, so a derived collection is not reachable by the
 * exchange at all rather than being filtered out at the point of writing.
 *
 * ## Residency is checked before anything crosses
 *
 * A federated node must not sync data its residency policy forbids. Every record
 * moving in either direction is put through `residencyDecision` and
 * `applyResidency` — the ENH-79 contract, called the way the store layer is meant
 * to call it — against the *local* node's policy, because the policy that governs
 * what may leave is the one at the node the bytes are leaving, and the policy
 * that governs what may arrive is the one at the node they arrive at. A record
 * the policy does not permit is not moved; a record it permits only once
 * pseudonymised is moved pseudonymised, so the peer receives what the decision
 * described rather than the original. The decision is pure and reads no clock, so
 * an exchange is reproducible.
 *
 * ## A partial exchange must not read as a success
 *
 * Two mechanisms, because a transfer can fail in two places. A peer whose `read`
 * throws is recorded as a failure for that peer, the other peers still exchange,
 * and the result refuses the claim of completeness. And a read that *succeeded*
 * but did not deliver everything the peer holds is caught by the digest: a peer
 * that exposes `exchangeManifest()` states the digest of what it holds, and
 * `verifyPayload` compares that with the digest of the rows that actually
 * arrived. A transfer that dropped records and one that completed are then
 * different sentences rather than the same green summary.
 *
 * And the house rule applies to the summary itself: a node with no peers, or a
 * peer that is not a store, is a *failure* with a reason — never a clean
 * `{ peers: 0, ok: true }`, which is a measurement of nothing reported as health.
 *
 * ## Pure logic, no server
 *
 * This module imports `node:crypto`, `store.js`, `bitemporal.js` and
 * `residency.js` and nothing else. It does not import `pg` and does not touch the
 * filesystem; it uses only `store.js`'s pure exports and a store's two async
 * methods, so it runs against an in-memory store as happily as against Postgres.
 * That is what makes the peer pair in the test file two `JsonStore`s in
 * `os.tmpdir()` with no server and no mock.
 */

import { createHash } from 'node:crypto'

import {
  COLLECTIONS,
  DERIVED_COLLECTIONS,
  HISTORY_COLLECTION,
  isDeclared,
  recordTimestamp,
  sortRecords,
} from './store.js'
import { changedFields, isRevision } from './bitemporal.js'
import {
  applyResidency,
  describeDecision,
  isStorable,
  residencyDecision,
} from './residency.js'

/**
 * The collections a node may send or receive.
 *
 * `COLLECTIONS` minus the derived set minus history. History is excluded because
 * it is not a fact about the world but this node's record of when it changed its
 * mind, and the two axes would otherwise have to be merged across nodes; the peer
 * rebuilds its own history from the values it receives, through the same
 * `mergeById` path a local write takes. A caller that wants a peer's history can
 * read it explicitly — `exchangeWith` will not carry it implicitly.
 *
 * Computed from `COLLECTIONS` rather than written out, so a collection added to
 * `SCHEMA` syncs by default and the only way to keep one out is to declare it
 * derived or as history. A hand-written list here is the silent-key-list bug
 * (`ADR-002`) with a network on one side of it.
 */
export const SYNCABLE_COLLECTIONS = Object.freeze(
  COLLECTIONS.filter((collection) => !DERIVED_COLLECTIONS.includes(collection) && collection !== HISTORY_COLLECTION),
)

/**
 * The collections this node refuses to sync, and why.
 *
 * A lookup rather than a predicate, so a caller can state the reason it did not
 * send something. "Skipped" with no reason is the shape a reader cannot act on
 * and a reviewer cannot check.
 */
export const NON_SYNCABLE_REASONS = Object.freeze({
  ...Object.fromEntries(DERIVED_COLLECTIONS.map((collection) => [collection, 'derived'])),
  [HISTORY_COLLECTION]: 'history',
})

/** The reason a derived collection is not synced, stated for a human. */
export const DERIVED_NOT_SYNCED = Object.freeze(
  'derived collections are recomputed from their inputs on every refresh; sending the figure '
  + 'would send a number computed from a store the receiving node does not hold, and the '
  + 'receiving node\'s own refresh replaces the collection wholesale, so the row would be '
  + 'deleted by an unrelated job. Sync the inputs and let the peer recompute.',
)

/**
 * Why a collection does not cross the boundary, or null when it does.
 *
 * The single predicate both the send and the receive side call, so "the sender
 * did not send it" and "the receiver will not accept it" cannot drift into two
 * different answers — which would be a record that arrives at the boundary and is
 * dropped there without a word.
 */
export function nonSyncableReason(collection) {
  return NON_SYNCABLE_REASONS[collection] ?? null
}

/** True when `collection` may cross the boundary in either direction. */
export function isSyncable(collection) {
  return isDeclared(collection) && nonSyncableReason(collection) === null
}

/**
 * The valid time of a record — the clock the merge rule uses.
 *
 * `first_seen_at` first because it is stamped once, on the first ingest, and never
 * rewritten (`src/ingestion.js`), which makes it the closest thing a record
 * carries to "when this fact became true to the platform". After it, the store's
 * own `recordTimestamp` cascade — imported, not copied, so the merge's winner and
 * the node's own ordering are the same question asked once.
 *
 * The list used to be mirrored here. It was already wrong: `SORT_FIELDS` carries
 * `started_at` and the copy did not, so a record whose only timestamp was
 * `started_at` had no valid time at all and lost every conflict it entered. A
 * mirrored list is a second source of truth and this one drifted within the day
 * it was written.
 *
 * **Presence, not truthiness.** A record whose only timestamp is `0` is a record
 * with a timestamp; treating it as absent is the falsy-zero bug this repository
 * has paid for twice. An empty string is likewise a value, and a record with no
 * timestamp at all sorts first, which is the honest place for it: we cannot say
 * when it was true.
 */
export function validTime(record) {
  const firstSeen = record?.first_seen_at
  if (firstSeen !== undefined && firstSeen !== null && firstSeen !== '') return String(firstSeen)
  return recordTimestamp(record || {})
}

/**
 * A digest of the record's content, tie-breaking two values at the same valid
 * time.
 *
 * Keys sorted at every depth, so two nodes that received the same record over
 * different paths — one of which inserted a key first — hash the same. The store
 * metadata keys are left in rather than ignored: this digest decides which of two
 * *bodies* is kept, and a body differing only in a metadata key is a body that
 * differs.
 */
export function contentDigest(record) {
  return createHash('sha256').update(JSON.stringify(canonical(record || {}))).digest('hex')
}

/** Sorted keys at every depth, so a digest is a function of content and not of order. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

/**
 * Which of two records for the same id wins, and whether the choice was a tie.
 *
 * Returns `{ winner, loser, tied }`. `tied` is true when the valid times are
 * equal and the bodies differ — the case with no clock to appeal to, which the
 * caller reports rather than resolving silently. A tie whose bodies are
 * *identical* is not a tie in any meaningful sense: the two nodes already agree,
 * and reporting it would fill the conflict list with records that are not in
 * conflict.
 */
export function chooseValue(a, b) {
  const timeA = validTime(a)
  const timeB = validTime(b)
  if (timeA !== timeB) {
    return timeA > timeB ? { winner: a, loser: b, tied: false } : { winner: b, loser: a, tied: false }
  }
  const digestA = contentDigest(a)
  const digestB = contentDigest(b)
  if (digestA === digestB) return { winner: a, loser: b, tied: false }
  // The tie-break: the greater digest wins. Arbitrary, but a function of the two
  // records alone — the same answer at either node, whichever direction the
  // exchange runs and whatever order the array arrived in.
  return digestA > digestB ? { winner: a, loser: b, tied: true } : { winner: b, loser: a, tied: true }
}

/**
 * The merge of an incoming collection into a local one, by the rule above.
 *
 * Pure. Returns the converged array, the conflicts it found, and the ids that
 * moved — the last so a caller can assert that a second exchange is a no-op
 * without diffing the whole collection.
 *
 * `mergeById` is deliberately *not* called. It is last-write-wins by array
 * position (`map.set` in arrival order), so it depends on which node ran the
 * merge — the exact property the merge rule has to be free of. It stays where it
 * belongs: a local ingest is one node's own sequence of writes, and there arrival
 * order is the right answer.
 */
export function mergeCollection(existing = [], incoming = []) {
  const byId = new Map(existing.map((record) => [record.id, record]))
  const conflicts = []
  const changed = []
  const winners = []

  for (const arriving of incoming) {
    const local = byId.get(arriving.id)
    if (!local) {
      byId.set(arriving.id, arriving)
      changed.push(arriving.id)
      winners.push(arriving)
      continue
    }
    const { winner, tied } = chooseValue(local, arriving)
    if (tied) {
      conflicts.push({
        id: arriving.id,
        valid_time: validTime(arriving),
        kept: winner,
        discarded: winner === local ? arriving : local,
      })
    }
    if (winner === arriving && changedFields(local, arriving) !== null) {
      byId.set(arriving.id, arriving)
      changed.push(arriving.id)
      winners.push(arriving)
    }
  }

  return { records: sortRecords([...byId.values()]), conflicts, changed, winners }
}

/**
 * The digest of a payload, as both sides compute it.
 *
 * Digesting the same projection in one function is what makes two numbers
 * comparable: the syncable collections, in `COLLECTIONS` order, each row
 * identified by id and content. A projection written twice — once on the sender
 * and once on the receiver — is the drift this exists to prevent, because the two
 * would disagree the first time either side's list changed and the mismatch would
 * read as a short transfer.
 */
export function payloadDigest(payload = {}) {
  const hash = createHash('sha256')
  for (const collection of SYNCABLE_COLLECTIONS) {
    const rows = Array.isArray(payload[collection]) ? payload[collection] : []
    hash.update(`${collection}\u0000${rows.length}\u0000`)
    for (const row of rows) hash.update(`${row?.id}\u0000${contentDigest(row)}\u0000`)
  }
  return hash.digest('hex')
}

/**
 * What a node hands a peer: the syncable collections, their digest, and what it
 * refused to send.
 *
 * `skipped` is not decoration. A manifest carrying only the collections it sent
 * would make "this node has no derived rows" and "this node declined to send its
 * derived rows" the same document, and the receiver would have no way to tell a
 * deliberate refusal from an empty set.
 *
 * A peer that implements this method states its digest, and `exchangeWith` uses
 * it to detect a read that succeeded but did not deliver everything held. A plain
 * store does not implement it, and the exchange then reports `verified: false`
 * rather than claiming a check it did not run.
 */
export function exchangeManifest(storeRead, { node = null } = {}) {
  const payload = {}
  for (const collection of SYNCABLE_COLLECTIONS) {
    payload[collection] = Array.isArray(storeRead?.[collection]) ? storeRead[collection] : []
  }
  return {
    node,
    collections: SYNCABLE_COLLECTIONS,
    digest: payloadDigest(payload),
    skipped: Object.entries(NON_SYNCABLE_REASONS).map(([collection, reason]) => ({ collection, reason })),
    payload,
  }
}

/**
 * What a node read, against what the peer said it held.
 *
 * They differ when a read succeeded but did not deliver everything the peer
 * holds — a paging bug, a row budget refusing part of a collection, a serialiser
 * dropping a key. The failure mode that matters is that being reported as
 * success, so `short` names the difference rather than leaving it to a caller to
 * notice.
 */
export function verifyPayload(expectedDigest, payload) {
  const actual = payloadDigest(payload)
  const ok = expectedDigest === actual
  return {
    ok,
    expected: expectedDigest,
    actual,
    ...(ok ? {} : { short: `the peer reported digest ${String(expectedDigest).slice(0, 12)}… but the rows that arrived digest to ${actual.slice(0, 12)}…; the read did not deliver everything the peer holds.` }),
  }
}

/**
 * Whether a peer is one this module can exchange with.
 *
 * A peer is a store, so it must answer the methods the exchange uses. A peer that
 * answers some of them fails at the next, mid-exchange, after a collection has
 * already been written — a partial write the caller then has to reason about.
 * Refusing up front is the same decision as the residency gate's: fail before the
 * write, not during it.
 */
export function assertPeer(peer, name = 'peer') {
  const missing = ['read', 'merge']
    .filter((method) => typeof peer?.[method] !== 'function')
  if (missing.length) {
    throw new Error(
      `${name} is not a store: it does not implement ${missing.join(', ')}. `
      + 'A peer is another store, reached through the same methods the conformance '
      + 'suite exercises — a peer that is not one is not a peer.',
    )
  }
  return peer
}

/**
 * The residency gate for one record moving in one direction.
 *
 * Returns `{ record, action, reason }`. `record` is null when nothing may cross.
 * The decision is made against `policy` and `applyResidency` produces the record
 * that is actually moved, so a `pseudonymise_then_store` decision moves the
 * pseudonymised record rather than the original and the caller never re-derives
 * which fields were PII.
 *
 * `route` is treated as a refusal. A route names a jurisdiction the bytes belong
 * in, and this exchange is not going there: sending a record the policy says
 * belongs elsewhere to whichever peer happens to be configured is precisely the
 * cross-border move the policy exists to prevent. A routed record waits for the
 * topology ENH-79's comment anticipates — the decision carries `route_to`, and a
 * router built on this module reads it rather than moving the record here.
 */
export function permittedRecord(record, policy) {
  const decision = residencyDecision(record, policy)
  if (decision.action === 'route') {
    return {
      record: null,
      action: 'route',
      reason: `${describeDecision(decision)} Not moved by this exchange: it is destined for ${decision.route_to}, and this peer is not that destination.`,
    }
  }
  if (!isStorable(decision)) {
    return { record: null, action: decision.action, reason: describeDecision(decision) }
  }
  const applied = applyResidency(record, decision)
  return { record: applied.record, action: applied.action, reason: describeDecision(decision) }
}

/**
 * The syncable records of a store read that the policy permits moving.
 *
 * Returns `{ payload, withheld }` where `withheld` is one entry per record the
 * residency policy stopped, with the reason — so an exchange that moves three of
 * forty records says why the other thirty-seven stayed, rather than reporting a
 * clean transfer of three.
 */
export function permittedPayload(storeRead, policy) {
  const payload = {}
  const withheld = []
  for (const collection of SYNCABLE_COLLECTIONS) {
    payload[collection] = []
    for (const record of storeRead?.[collection] || []) {
      const { record: permitted, action, reason } = permittedRecord(record, policy)
      if (!permitted) {
        withheld.push({ collection, id: record?.id ?? null, action, reason })
        continue
      }
      payload[collection].push(permitted)
    }
  }
  return { payload, withheld }
}

/**
 * Exchange one node's store with one peer's store, in the directions asked for.
 *
 * `direction` is the direction of *travel*, read from this node's point of view:
 * `'out'` moves this node's records to the peer, `'in'` moves the peer's records
 * here, `'both'` does out then in. One `'both'` call converges the pair for every
 * record either side holds; run it twice and the second call applies nothing,
 * which the tests assert rather than assume.
 *
 * `readStore` and `writeStore` are separated so a caller can route them
 * differently — a node that reads through `ReadReplicaStore` (ENH-67) and writes
 * to the primary passes the two, and this function does not have to know that
 * topology exists. The `direction` split is what makes the order-independence
 * test meaningful: `A→B→A` and `B→A→B` are sequences of one-way exchanges, not
 * two calls of one bidirectional function.
 */
export async function exchangeWith(peer, {
  readStore,
  writeStore = readStore,
  policy,
  direction = 'both',
  peerName = 'peer',
} = {}) {
  assertPeer(peer, peerName)
  if (!['both', 'out', 'in'].includes(direction)) {
    throw new Error(`unknown exchange direction: ${JSON.stringify(direction)}`)
  }

  const failures = []
  const conflicts = []
  const withheld = []
  const applied = { out: 0, in: 0 }

  const readOrFail = async (store, side) => {
    try {
      return await store.read()
    } catch (error) {
      failures.push({ side, error: error?.message || String(error) })
      return null
    }
  }

  const localRead = await readOrFail(readStore, 'local')
  const peerRead = await readOrFail(peer, 'peer')

  // The peer's own statement of what it holds, when it can make one. Used to
  // detect a read that succeeded but did not deliver everything — the failure a
  // throw cannot catch, because nothing threw.
  let verified = null
  if (peerRead && typeof peer.exchangeManifest === 'function') {
    try {
      const manifest = await peer.exchangeManifest()
      const check = verifyPayload(manifest.digest, peerRead)
      verified = check.ok
      if (!check.ok) failures.push({ side: 'peer', error: check.short })
    } catch (error) {
      verified = false
      failures.push({ side: 'peer', error: `the peer could not state its manifest: ${error?.message || String(error)}` })
    }
  }

  // Outbound: what this node may part with, merged into the peer by the same rule.
  if (localRead && (direction === 'both' || direction === 'out')) {
    const { payload, withheld: held } = permittedPayload(localRead, policy)
    withheld.push(...held.map((entry) => ({ ...entry, direction: 'out' })))
    try {
      const result = await mergeInto(peer, peerRead || {}, payload)
      applied.out = result.applied
      conflicts.push(...result.conflicts.map((conflict) => ({ ...conflict, direction: 'out' })))
    } catch (error) {
      failures.push({ side: 'out', error: error?.message || String(error) })
    }
  }

  // Inbound: what the peer may part with, merged here by the same rule.
  if (peerRead && (direction === 'both' || direction === 'in')) {
    const { payload, withheld: held } = permittedPayload(peerRead, policy)
    withheld.push(...held.map((entry) => ({ ...entry, direction: 'in' })))
    try {
      const result = await mergeInto(writeStore, localRead || {}, payload)
      applied.in = result.applied
      conflicts.push(...result.conflicts.map((conflict) => ({ ...conflict, direction: 'in' })))
    } catch (error) {
      failures.push({ side: 'in', error: error?.message || String(error) })
    }
  }

  return {
    peer: peerName,
    direction,
    verified,
    failures,
    conflicts,
    withheld,
    applied,
    // A transfer that failed anywhere is not reported as a transfer that
    // completed. `failures.length` is the whole of that claim.
    ok: failures.length === 0,
    ...(failures.length
      ? { reason: `${failures.length} side(s) of the exchange failed: ${failures.map((f) => `${f.side}: ${f.error}`).join('; ')}` }
      : {}),
  }
}

/**
 * Merges a permitted payload into a store, collection by collection.
 *
 * The local read is passed in rather than re-taken, so the comparison is against
 * the snapshot the exchange started from: a second read would race a concurrent
 * local write and could merge the same collection twice. A collection nothing
 * changed in is not written at all, which is what makes a re-run a genuine no-op
 * rather than a rewrite of identical bytes.
 *
 * The write is `merge` carrying **only the winning records**, not
 * `replaceCollection` carrying the converged array. Two reasons, and the second
 * is the one that matters:
 *
 *   - `merge` is the write a local ingest uses, so a peer's revision opens a
 *     history row through the same `supersededVersions` path a local correction
 *     does. The bitemporal substrate is the point of the entry — a federated
 *     revision that left no history would make the audit trail depend on which
 *     node noticed the change first;
 *   - `mergeById` is last-write-wins by arrival order, so the *loser* of a
 *     valid-time comparison must never be handed to it. Sending only the winners
 *     means the merge rule decides, and `mergeById` merely performs the write it
 *     is good at.
 *
 * `replaceCollection` is not used here for a related reason: it would write the
 * whole collection, including records this node holds and the peer does not, and
 * an absent record is not a deleted one.
 */
async function mergeInto(store, snapshot, payload) {
  const conflicts = []
  let applied = 0
  for (const collection of SYNCABLE_COLLECTIONS) {
    const incoming = payload[collection] || []
    if (!incoming.length) continue
    const existing = Array.isArray(snapshot?.[collection]) ? snapshot[collection] : []
    const { conflicts: found, changed, winners } = mergeCollection(existing, incoming)
    if (!changed.length) continue
    conflicts.push(...found.map((conflict) => ({ ...conflict, collection })))
    await store.merge({ [collection]: winners })
    applied += changed.length
  }
  return { applied, conflicts }
}

/**
 * The federated exchange over a set of peers, with the summary the house rule
 * demands.
 *
 * **A node with no peers is a failure, not a clean run.** `{ peers: 0, ok: true }`
 * is a measurement of nothing reported as health, which is the shape
 * `src/reconciliation.js` and `check-coverage` both refuse. So an empty peer list
 * produces `ok: false` and a reason, and a caller that has wired its peer list
 * wrong finds out here rather than from a green summary.
 *
 * The summary counts what happened — peers reached, records sent, records applied,
 * records withheld, conflicts, failures — so an exchange that moved nothing is
 * distinguishable from one that moved everything, and both from one that failed.
 */
export async function federate(store, peers = [], { policy, readStore, node = null, direction = 'both' } = {}) {
  const list = [...(peers || [])]
  if (!list.length) {
    return {
      ok: false,
      node,
      peers: 0,
      reached: 0,
      sent: 0,
      applied: 0,
      withheld: 0,
      conflicts: 0,
      failures: [{ peer: null, side: 'peers', error: 'no peers configured' }],
      reason: 'no peers configured: an exchange with no peers measures nothing, so it is reported as a failure rather than as a clean run.',
      results: [],
    }
  }

  const results = []
  for (const [index, peer] of list.entries()) {
    const name = peer?.name || `peer-${index}`
    // A peer that is not a store is a failure for that peer, not a thrown
    // exception for the whole run: the other peers still get their exchange, and
    // the summary names which one was misconfigured.
    try {
      results.push(await exchangeWith(peer, { readStore: readStore || store, writeStore: store, policy, direction, peerName: name }))
    } catch (error) {
      results.push({
        peer: name,
        direction,
        verified: null,
        failures: [{ side: 'peers', error: error?.message || String(error) }],
        conflicts: [],
        withheld: [],
        applied: { out: 0, in: 0 },
        ok: false,
        reason: error?.message || String(error),
      })
    }
  }

  const failures = results.flatMap((result) => result.failures.map((failure) => ({ peer: result.peer, ...failure })))
  const reached = results.filter((result) => result.ok).length
  const summary = {
    ok: failures.length === 0 && reached === list.length,
    node,
    peers: list.length,
    reached,
    sent: results.reduce((sum, result) => sum + (result.applied?.out || 0), 0),
    applied: results.reduce((sum, result) => sum + (result.applied?.in || 0), 0),
    withheld: results.reduce((sum, result) => sum + (result.withheld?.length || 0), 0),
    conflicts: results.reduce((sum, result) => sum + (result.conflicts?.length || 0), 0),
    failures,
    results,
  }
  if (!summary.ok) {
    summary.reason = `${list.length - reached} of ${list.length} peer exchange(s) did not complete: ${failures.map((f) => `${f.peer}/${f.side}: ${f.error}`).join('; ')}`
  }
  return summary
}

/**
 * Whether a record arriving from a peer is one this node already holds, and
 * whether it is a revision of it.
 *
 * Exported because the two questions are the ones a caller integrating this with
 * the bitemporal history needs to ask, and asking them with `isRevision` directly
 * — which takes `(previous, incoming)` — is easy to get backwards.
 */
export function incomingIsRevision(localRead, collection, record) {
  const existing = (localRead?.[collection] || []).find((row) => row.id === record?.id)
  return { held: Boolean(existing), revision: isRevision(existing, record) }
}

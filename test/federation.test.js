#!/usr/bin/env node
/**
 * ENH-80 — federated multi-node deployment.
 *
 * The claim is that several nodes peer-sync through the store layer's own
 * conformance contract, so no single central store is a chokepoint or a single
 * point of failure. What that claim rests on is four properties, and this file is
 * the argument for each rather than an assertion that a function ran:
 *
 *   1. **Convergence, and convergence that is order-independent.** Two nodes that
 *      have both seen each other's records hold the same value for the same
 *      record. The merge rule is latest-valid-time, whose maximum is commutative
 *      and idempotent, so A→B→A and B→A→B compute the same thing — asserted both
 *      ways, with a genuine same-valid-time tie in the data so the tie-break is
 *      exercised rather than assumed.
 *   2. **A derived collection is not synced as a value.** Asserted by its reason
 *      as well as by its absence, because "it was skipped" and "it was skipped
 *      for the right reason" are different claims.
 *   3. **Residency holds at the boundary.** A record the local policy forbids does
 *      not cross, and one it permits only once pseudonymised crosses
 *      pseudonymised.
 *   4. **A partial or failed exchange is detectable, not reported as success.**
 *      The house rule: a sync that measures nothing must fail. A node with no
 *      peers is a failure with a reason, not a clean `{ peers: 0, ok: true }`.
 *
 * Two in-memory `JsonStore`s in `os.tmpdir()` are the peer pair — no server, no
 * mock, and no `pg`. The store is the boundary: a peer is another store, and the
 * exchange uses the same `read` and `merge` the conformance suite exercises.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { JsonStore, SORT_FIELDS, recordTimestamp } from '../src/store.js'
import {
  DERIVED_NOT_SYNCED,
  SYNCABLE_COLLECTIONS,
  chooseValue,
  contentDigest,
  exchangeManifest,
  exchangeWith,
  federate,
  isSyncable,
  mergeCollection,
  nonSyncableReason,
  payloadDigest,
  permittedPayload,
  validTime,
} from '../src/federation.js'

/** A policy that permits storing Kenya unchanged, so a sync test is not also a
 *  residency test. Every record below carries `country: 'KE'` for that reason. */
const OPEN = {
  home_jurisdiction: 'KE',
  default_rule: { store_here: true, retention_days: 365 },
}

/** A policy with a jurisdiction it routes away and one it permits only
 *  pseudonymised, plus no default rule — so an unknown jurisdiction refuses. */
const RESIDENCY = {
  home_jurisdiction: 'KE',
  jurisdictions: {
    KE: { store_here: true, require_pseudonym: true, retention_days: 365 },
    SO: { store_here: false, route_to: 'KE' },
  },
}

const hazard = (id, extra = {}) => ({
  id,
  event_type: 'flood',
  source: 'test',
  severity: 'moderate',
  country: 'KE',
  ...extra,
})

/** Every temp directory a node created, torn down once at the end. Each node owns
 *  its own directory rather than sharing one per suite: `node:test` runs a
 *  suite's `before` lazily, so a directory made in one suite's hook is not there
 *  for another suite's. */
const created = []

after(async () => {
  for (const home of created) await fs.rm(home, { recursive: true, force: true })
})

/** A node: a store, a name, and the directory it cleans up with. */
async function node(name) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `lindela-federation-${name}-`))
  created.push(home)
  return { name, store: new JsonStore(path.join(home, 'store.json')) }
}

/** The records of one collection, by id, so two nodes are compared by value. */
async function byId(store, collection) {
  const rows = (await store.read())[collection] || []
  return Object.fromEntries(rows.map((row) => [row.id, row]))
}

/** What both nodes hold, for an equality assertion across a pair. */
async function snapshot(...stores) {
  return Promise.all(stores.map((store) => store.read()))
}

describe('ENH-80 two nodes converge after a bidirectional exchange', () => {
  let a
  let b
  before(async () => {
    a = await node('national')
    b = await node('regional')
    await a.store.merge({ hazard_events: [hazard('hz-a', { first_seen_at: '2026-01-01T00:00:00.000Z' })] })
    await b.store.merge({ hazard_events: [hazard('hz-b', { first_seen_at: '2026-02-01T00:00:00.000Z' })] })
  })

  it('both nodes hold every record either node started with', async () => {
    const result = await exchangeWith(b.store, { readStore: a.store, writeStore: a.store, policy: OPEN, peerName: 'regional' })
    assert.equal(result.ok, true, `the exchange reported a failure: ${result.reason}`)
    assert.equal(result.applied.out, 1, 'the national node had one record to send')
    assert.equal(result.applied.in, 1, 'the regional node had one record to apply')

    const [fromA, fromB] = await snapshot(a.store, b.store)
    const idsA = fromA.hazard_events.map((h) => h.id).sort()
    const idsB = fromB.hazard_events.map((h) => h.id).sort()
    assert.deepEqual(idsA, ['hz-a', 'hz-b'])
    assert.deepEqual(idsB, ['hz-a', 'hz-b'], 'a record must reach both nodes, not only the one that received it')

    // Not just the ids — the bodies must be the same value at each node, which
    // is the whole of "converged".
    assert.deepEqual(await byId(a.store, 'hazard_events'), await byId(b.store, 'hazard_events'))
  })

  it('a later valid time wins over an earlier one, at both nodes', async () => {
    await a.store.merge({ hazard_events: [hazard('hz-shared', { first_seen_at: '2026-03-01T00:00:00.000Z', severity: 'high' })] })
    await b.store.merge({ hazard_events: [hazard('hz-shared', { first_seen_at: '2026-03-05T00:00:00.000Z', severity: 'critical' })] })
    await exchangeWith(b.store, { readStore: a.store, writeStore: a.store, policy: OPEN })

    const fromA = await byId(a.store, 'hazard_events')
    const fromB = await byId(b.store, 'hazard_events')
    assert.equal(fromA['hz-shared'].severity, 'critical', 'the later valid time must win')
    assert.equal(fromB['hz-shared'].severity, 'critical')
  })
})

describe('ENH-80 the merge is order-independent', () => {
  // The convergence claim, tested as an equivalence between two orders rather
  // than as a value one order happened to produce. Both pairs start from the same
  // two stores and differ only in which direction runs first.
  /** A fresh pair seeded identically, including a same-valid-time tie. */
  async function pair() {
    const left = await node('left')
    const right = await node('right')
    await left.store.merge({
      hazard_events: [
        hazard('hz-left', { first_seen_at: '2026-01-01T00:00:00.000Z', note: 'only left' }),
        hazard('hz-both', { first_seen_at: '2026-02-01T00:00:00.000Z', severity: 'high' }),
        // Same valid time, different body: no clock decides, so the digest does.
        hazard('hz-tie', { first_seen_at: '2026-04-01T00:00:00.000Z', severity: 'moderate' }),
      ],
    })
    await right.store.merge({
      hazard_events: [
        hazard('hz-right', { first_seen_at: '2026-03-01T00:00:00.000Z', note: 'only right' }),
        hazard('hz-both', { first_seen_at: '2026-05-01T00:00:00.000Z', severity: 'critical' }),
        hazard('hz-tie', { first_seen_at: '2026-04-01T00:00:00.000Z', severity: 'extreme' }),
      ],
    })
    return { left, right }
  }

  it('A→B then B→A leaves the same values as B→A then A→B', async () => {
    // One-way exchanges, so the order is genuinely different. A single
    // `direction: 'both'` call would compute the same maxima in the same
    // sequence whichever node was named first, and the test would pass without
    // ever having tried the other order.
    const forward = await pair()
    await exchangeWith(forward.left.store, { readStore: forward.right.store, writeStore: forward.right.store, policy: OPEN, direction: 'out' })
    await exchangeWith(forward.right.store, { readStore: forward.left.store, writeStore: forward.left.store, policy: OPEN, direction: 'out' })

    const backward = await pair()
    await exchangeWith(backward.right.store, { readStore: backward.left.store, writeStore: backward.left.store, policy: OPEN, direction: 'out' })
    await exchangeWith(backward.left.store, { readStore: backward.right.store, writeStore: backward.right.store, policy: OPEN, direction: 'out' })

    const [fLeft, fRight, bLeft, bRight] = await snapshot(forward.left.store, forward.right.store, backward.left.store, backward.right.store)
    assert.deepEqual(fLeft.hazard_events, bLeft.hazard_events, 'the left node converged to different values under the two orders')
    assert.deepEqual(fRight.hazard_events, bRight.hazard_events, 'the right node converged to different values under the two orders')
    assert.deepEqual(fLeft.hazard_events, fRight.hazard_events, 'the two nodes of one pair did not converge to the same values')
  })

  it('a same-valid-time tie is broken the same way in either order, and reported', async () => {
    const forward = await pair()
    const first = await exchangeWith(forward.right.store, { readStore: forward.left.store, writeStore: forward.left.store, policy: OPEN })
    const tie = first.conflicts.find((conflict) => conflict.id === 'hz-tie')
    assert.ok(tie, 'two bodies at one valid time must be reported as a conflict, not resolved in silence')
    assert.equal(tie.valid_time, '2026-04-01T00:00:00.000Z')

    const backward = await pair()
    const second = await exchangeWith(backward.left.store, { readStore: backward.right.store, writeStore: backward.right.store, policy: OPEN })
    const otherTie = second.conflicts.find((conflict) => conflict.id === 'hz-tie')
    assert.equal(
      contentDigest(tie.kept), contentDigest(otherTie.kept),
      'the tie-break must be a function of the two records, not of which node ran the exchange',
    )
  })

  it('the tie-break is a function of the records alone', () => {
    const one = hazard('hz', { first_seen_at: '2026-04-01T00:00:00.000Z', severity: 'moderate' })
    const two = hazard('hz', { first_seen_at: '2026-04-01T00:00:00.000Z', severity: 'extreme' })
    assert.equal(contentDigest(chooseValue(one, two).winner), contentDigest(chooseValue(two, one).winner))
    assert.equal(chooseValue(one, two).tied, true)
    // And a tie whose bodies agree is not a conflict — the two nodes already hold
    // the same value, and reporting it would fill the list with non-conflicts.
    assert.equal(chooseValue(one, { ...one }).tied, false)
  })
})

describe('ENH-80 a re-run is a no-op', () => {
  let a
  let b
  before(async () => {
    a = await node('a')
    b = await node('b')
    await a.store.merge({ hazard_events: [hazard('hz-1', { first_seen_at: '2026-01-01T00:00:00.000Z' })] })
    await b.store.merge({ hazard_events: [hazard('hz-2', { first_seen_at: '2026-02-01T00:00:00.000Z' })] })
    await exchangeWith(b.store, { readStore: a.store, writeStore: a.store, policy: OPEN })
  })

  it('the second exchange applies nothing and changes no bytes', async () => {
    const beforeA = JSON.stringify(await a.store.read({ includeHistory: true }))
    const beforeB = JSON.stringify(await b.store.read({ includeHistory: true }))

    const second = await exchangeWith(b.store, { readStore: a.store, writeStore: a.store, policy: OPEN })

    assert.equal(second.ok, true, `a re-run must succeed, and this one failed: ${second.reason}`)
    assert.equal(second.applied.out, 0, 'a re-run sent records that had not changed')
    assert.equal(second.applied.in, 0, 'a re-run applied records that had not changed')
    assert.equal(second.conflicts.length, 0, 'a re-run reported a conflict between two nodes that already agree')

    assert.equal(JSON.stringify(await a.store.read({ includeHistory: true })), beforeA, 'the re-run rewrote a store it had nothing to change')
    assert.equal(JSON.stringify(await b.store.read({ includeHistory: true })), beforeB, 'the re-run rewrote a store it had nothing to change')
  })

  it('a federated revision opens a history row, so the substrate carries the change', async () => {
    // The bitemporal model is the substrate the entry names. A revision arriving
    // from a peer must be recorded as a revision at the node that receives it,
    // through the same path a local correction takes — otherwise the audit trail
    // would depend on which node noticed the change first.
    const fresh = await node('history')
    const peer = await node('history-peer')
    await fresh.store.merge({ hazard_events: [hazard('hz-h', { first_seen_at: '2026-01-01T00:00:00.000Z', payload_hash: 'h-1', severity: 'low' })] })
    await peer.store.merge({ hazard_events: [hazard('hz-h', { first_seen_at: '2026-01-01T00:00:00.000Z', payload_hash: 'h-2', severity: 'critical' })] })

    await exchangeWith(peer.store, { readStore: fresh.store, writeStore: fresh.store, policy: OPEN })
    const withHistory = await fresh.store.read({ includeHistory: true })
    assert.equal(withHistory.record_versions.length, 1, 'a peer revision left no history row at the receiving node')
    assert.equal(withHistory.record_versions[0].record_id, 'hz-h')
  })
})

describe('ENH-80 a derived collection is not synced as a value', () => {
  let a
  let b
  before(async () => {
    a = await node('derived-a')
    b = await node('derived-b')
    await a.store.replaceAnalytics({ risk_scores: [{ id: 'rs-1', region: 'Turkana', score: 61 }] })
    await b.store.replaceAnalytics({ risk_scores: [{ id: 'rs-1', region: 'Turkana', score: 12 }] })
  })

  it('is refused by name, with the reason, rather than silently skipped', () => {
    assert.equal(nonSyncableReason('risk_scores'), 'derived')
    assert.equal(isSyncable('risk_scores'), false)
    assert.ok(!SYNCABLE_COLLECTIONS.includes('risk_scores'))
    // The reason is the load-bearing part: a derived figure is a function of a
    // store the receiving node does not hold, and its own refresh replaces the
    // collection wholesale.
    assert.match(DERIVED_NOT_SYNCED, /recomputed/)
    assert.match(DERIVED_NOT_SYNCED, /inputs/)
  })

  it('names every derived collection and history in the manifest it hands a peer', () => {
    const manifest = exchangeManifest({ risk_scores: [{ id: 'rs-1' }], hazard_events: [] })
    const reasons = Object.fromEntries(manifest.skipped.map((entry) => [entry.collection, entry.reason]))
    assert.equal(reasons.risk_scores, 'derived')
    assert.equal(reasons.model_drift, 'derived')
    assert.equal(reasons.record_versions, 'history')
    assert.ok(!manifest.collections.includes('risk_scores'))
  })

  it('a peer\'s derived figure does not overwrite the local one', async () => {
    const result = await exchangeWith(b.store, { readStore: a.store, writeStore: a.store, policy: OPEN })
    assert.equal(result.ok, true, `the exchange failed: ${result.reason}`)

    const localA = (await a.store.read()).risk_scores
    const localB = (await b.store.read()).risk_scores
    assert.equal(localA[0].score, 61, 'the local derived figure was overwritten by the peer\'s')
    assert.equal(localB[0].score, 12, 'the peer\'s derived figure was overwritten by the local one')
    // And the exchange never claimed to have moved it.
    assert.equal(result.applied.out + result.applied.in, 0)
  })
})

describe('ENH-80 residency holds at the boundary', () => {
  let a
  let b
  before(async () => {
    a = await node('residency-a')
    b = await node('residency-b')
    await a.store.merge({
      hazard_events: [
        hazard('hz-ke', {
          country: 'KE',
          reporter_name: 'Amina Wekesa',
          phone: '+254711111111',
          first_seen_at: '2026-01-01T00:00:00.000Z',
        }),
        hazard('hz-so', { country: 'SO', first_seen_at: '2026-01-02T00:00:00.000Z' }),
        // No country and no district the registry resolves: the jurisdiction is
        // undeterminable, which the policy refuses rather than guesses.
        { id: 'hz-nowhere', event_type: 'flood', source: 'test', first_seen_at: '2026-01-03T00:00:00.000Z' },
      ],
    })
  })

  it('sends the record the policy permits, pseudonymised as the decision described', async () => {
    const result = await exchangeWith(b.store, { readStore: a.store, writeStore: a.store, policy: RESIDENCY, direction: 'out' })
    assert.equal(result.ok, true, `the exchange failed: ${result.reason}`)

    const received = await byId(b.store, 'hazard_events')
    assert.ok(received['hz-ke'], 'the record the policy permits did not cross')
    assert.match(received['hz-ke'].reporter_name, /^sha256:/, 'the name crossed in the clear')
    assert.doesNotMatch(received['hz-ke'].phone, /^\+2547/, 'the phone crossed in the clear')
  })

  it('does not send a record the policy routes elsewhere, and says where it belongs', async () => {
    const received = await byId(b.store, 'hazard_events')
    assert.equal(received['hz-so'], undefined, 'a record the policy routes away crossed the boundary')

    const { withheld } = await exchangeWith(b.store, { readStore: a.store, writeStore: a.store, policy: RESIDENCY, direction: 'out' })
    const routed = withheld.find((entry) => entry.id === 'hz-so')
    assert.ok(routed, 'the withheld record must be reported, not dropped in silence')
    assert.equal(routed.action, 'route')
    assert.match(routed.reason, /destined for KE/, 'the refusal must say where the record belongs')
  })

  it('does not send a record whose jurisdiction cannot be determined', async () => {
    const received = await byId(b.store, 'hazard_events')
    assert.equal(received['hz-nowhere'], undefined, 'a record with no determinable jurisdiction crossed the boundary')

    const { withheld } = await exchangeWith(b.store, { readStore: a.store, writeStore: a.store, policy: RESIDENCY, direction: 'out' })
    const unplaced = withheld.find((entry) => entry.id === 'hz-nowhere')
    assert.ok(unplaced)
    assert.equal(unplaced.action, 'refuse')
    assert.match(unplaced.reason, /jurisdiction/)
  })

  it('an empty policy sends nothing, because silence is not permission', async () => {
    const { payload, withheld } = permittedPayload(await a.store.read(), {})
    const sent = Object.values(payload).reduce((sum, rows) => sum + rows.length, 0)
    assert.equal(sent, 0, 'an unconfigured policy let records cross the boundary')
    assert.equal(withheld.length, 3)
  })
})

describe('ENH-80 a partial or failed exchange is detectable', () => {
  let a
  before(async () => {
    a = await node('partial')
    await a.store.merge({ hazard_events: [hazard('hz-1', { first_seen_at: '2026-01-01T00:00:00.000Z' })] })
  })

  it('a peer whose read throws is a failure, not an empty peer', async () => {
    const unreachable = { name: 'unreachable', read: async () => { throw new Error('connect ECONNREFUSED') }, merge: async () => {} }
    const result = await exchangeWith(unreachable, { readStore: a.store, writeStore: a.store, policy: OPEN })
    assert.equal(result.ok, false, 'an exchange against a peer that threw reported success')
    assert.ok(result.failures.some((failure) => /ECONNREFUSED/.test(failure.error)))
    assert.match(result.reason, /failed/)
  })

  it('a read that delivered less than the peer holds is caught by the digest', async () => {
    const store = await node('lying')
    await store.store.merge({ hazard_events: [hazard('hz-x', { first_seen_at: '2026-01-01T00:00:00.000Z' }), hazard('hz-y', { first_seen_at: '2026-02-01T00:00:00.000Z' })] })
    // The peer says it holds both, but serves one — a paging bug, a row budget, a
    // serialiser dropping a key. Nothing throws.
    const partial = {
      name: 'partial',
      read: async () => {
        const read = await store.store.read()
        return { ...read, hazard_events: read.hazard_events.slice(0, 1) }
      },
      merge: (payload) => store.store.merge(payload),
      exchangeManifest: () => store.store.exchangeManifest?.() ?? exchangeManifest(store.store, { node: 'partial' }),
    }
    // `store.store` is a JsonStore, which has no manifest method; build one from a
    // full read so the digest describes both records.
    partial.exchangeManifest = async () => exchangeManifest(await store.store.read(), { node: 'partial' })

    const result = await exchangeWith(partial, { readStore: a.store, writeStore: a.store, policy: OPEN })
    assert.equal(result.verified, false, 'a short read was reported as a verified transfer')
    assert.equal(result.ok, false, 'a short read was reported as a clean exchange')
    assert.match(result.reason, /did not deliver everything/)
  })

  it('a peer that is not a store is refused before anything is written', async () => {
    await assert.rejects(
      () => exchangeWith({ name: 'not-a-store' }, { readStore: a.store, writeStore: a.store, policy: OPEN }),
      /is not a store/,
      'a peer that cannot be read or written must fail before a partial write, not during one',
    )
  })
})

describe('ENH-80 a sync that measures nothing fails', () => {
  let a
  let b
  before(async () => {
    a = await node('summary-a')
    b = await node('summary-b')
    await a.store.merge({ hazard_events: [hazard('hz-1', { first_seen_at: '2026-01-01T00:00:00.000Z' })] })
    await b.store.merge({ hazard_events: [hazard('hz-2', { first_seen_at: '2026-02-01T00:00:00.000Z' })] })
  })
  after(async () => {
  })

  it('a node with no peers is a failure with a reason, not a clean run', async () => {
    const summary = await federate(a.store, [], { policy: OPEN, node: 'national' })
    assert.equal(summary.ok, false, 'an exchange with no peers reported success')
    assert.equal(summary.peers, 0)
    assert.match(summary.reason, /measures nothing/)
  })

  it('a summary counts what moved, so a real exchange is distinguishable from an empty one', async () => {
    const summary = await federate(a.store, [b.store], { policy: OPEN, node: 'national' })
    assert.equal(summary.ok, true, `the federation failed: ${summary.reason}`)
    assert.equal(summary.peers, 1)
    assert.equal(summary.reached, 1)
    assert.equal(summary.sent, 1)
    assert.equal(summary.applied, 1)
    assert.equal(summary.withheld, 0)
  })

  it('one misconfigured peer does not stop the others, and is named', async () => {
    const summary = await federate(a.store, [b.store, { name: 'broken' }], { policy: OPEN })
    assert.equal(summary.ok, false, 'a run with a peer that is not a store reported success')
    assert.equal(summary.reached, 1, 'the healthy peer must still have exchanged')
    assert.ok(summary.failures.some((failure) => failure.peer === 'broken'))
    assert.match(summary.reason, /broken/)
  })
})

describe('ENH-80 the merge rule\'s clock, and its stated limits', () => {
  it('valid time is read by presence, not truthiness', () => {
    assert.equal(validTime({ first_seen_at: 0 }), '0', 'a zero timestamp is a timestamp')
    assert.equal(validTime({ observed_at: '2026-01-01T00:00:00.000Z' }), '2026-01-01T00:00:00.000Z')
    // first_seen_at is preferred, because it is stamped once and never rewritten.
    assert.equal(validTime({ first_seen_at: 'a', observed_at: 'b' }), 'a')
    assert.equal(validTime({}), '', 'a record with no timestamp sorts first — we cannot say when it was true')
  })

  it('valid time is the store\'s own cascade, for every field the store sorts by', () => {
    // `validTime` used to mirror `SORT_FIELDS` by hand and the copy had already
    // drifted: it was missing `started_at`, so a record whose only timestamp was
    // `started_at` had no valid time at all and lost every conflict it entered.
    // The assertion is against the store's exported list rather than a second
    // literal, so adding a field there fails here instead of silently splitting
    // the merge's clock from the node's ordering.
    for (const field of SORT_FIELDS) {
      const record = { id: 'x', [field]: '2026-06-01T00:00:00.000Z' }
      assert.equal(validTime(record), '2026-06-01T00:00:00.000Z',
        `a record whose only timestamp is ${field} has no valid time, so it loses every conflict`)
    }
    assert.equal(validTime({ id: 'x', started_at: '2026-06-01T00:00:00.000Z' }), '2026-06-01T00:00:00.000Z')
    assert.equal(validTime({ id: 'x', started_at: '2026-06-01T00:00:00.000Z' }), recordTimestamp({ started_at: '2026-06-01T00:00:00.000Z' }))
  })

  it('a merge carries only winners, never the loser of a valid-time comparison', () => {
    const existing = [hazard('hz', { first_seen_at: '2026-05-01T00:00:00.000Z', severity: 'critical' })]
    const incoming = [hazard('hz', { first_seen_at: '2026-01-01T00:00:00.000Z', severity: 'low' })]
    const { records, changed, winners } = mergeCollection(existing, incoming)
    assert.equal(records[0].severity, 'critical', 'an older value overwrote a newer one')
    assert.deepEqual(changed, [])
    assert.deepEqual(winners, [], 'the loser was handed to the write, where mergeById would apply it')
  })

  it('a deletion is not inferred from absence, and says so', async () => {
    // The documented limit: `mergeById` cannot express a removal and there is no
    // tombstone, so a record deleted at one node stays at the other. Guessing that
    // absence means deletion would turn one node's outage into a fleet-wide
    // delete, so the module declines and this asserts the refusal.
    const left = await node('delete-left')
    const right = await node('delete-right')
    await left.store.merge({ hazard_events: [hazard('hz-gone', { first_seen_at: '2026-01-01T00:00:00.000Z' })] })
    await exchangeWith(right.store, { readStore: left.store, writeStore: left.store, policy: OPEN })
    await left.store.remove({ collection: { hazard_events: ['hz-gone'] } })

    const result = await exchangeWith(right.store, { readStore: left.store, writeStore: left.store, policy: OPEN, direction: 'out' })
    assert.equal(result.ok, true)
    assert.ok((await byId(right.store, 'hazard_events'))['hz-gone'], 'a deletion was inferred from absence')
  })

  it('the digest is a function of content, not of key insertion order', () => {
    const one = { id: 'x', a: 1, b: { c: 2, d: 3 } }
    const two = { b: { d: 3, c: 2 }, a: 1, id: 'x' }
    assert.equal(contentDigest(one), contentDigest(two))
    assert.notEqual(payloadDigest({ hazard_events: [one] }), payloadDigest({ hazard_events: [two, two] }))
  })
})

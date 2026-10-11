import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  compareClocks,
  conflictsOf,
  emptyClock,
  emptyRecord,
  fieldConflict,
  fieldHeads,
  mergeClocks,
  mergeRecords,
  readField,
  tickClock,
  writeField,
} from '../public/shared/field-merge.js'

/**
 * ENH-41 — field-level two-way sync, and the convergence function underneath it.
 *
 * The load-bearing tests here are the three algebraic laws, asserted *directly*
 * over the merge function: commutative, associative, idempotent. That is the
 * strongest available evidence, and it needs no network — if `merge` obeys all
 * three then every arrival order reaches the same record, which is the entire
 * claim of the entry. A merge that is only "usually" convergent passes the
 * scenario test and fails these.
 *
 * The second load-bearing test is the one that asserts a concurrent same-field
 * write is *not* resolved: the merge keeps both values, reports both actors, and
 * picks nothing silently. A design that picks — a Lamport counter with an
 * actor-id tiebreak — would pass every convergence test in this file and fail
 * that one, which is why it is here.
 *
 * No mocks: the module is pure, so the tests call it with real records.
 */

/** A record with an id and nothing written. */
const record = (id) => ({ ...emptyRecord(), id })

/**
 * A seeded PRNG, so a randomized property test that fails fails reproducibly.
 *
 * `Math.random` would make a counterexample a thing you saw once. This is
 * mulberry32 — 32 bits of state, uniform enough for generating merge inputs, and
 * the same sequence on every machine and every Node version.
 */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A random record built by a random sequence of writes, each after the last. */
function randomRecord(next) {
  const actors = ['phone', 'console', 'district', 'chw-7']
  const fields = ['status', 'notes', 'severity', 'follow_up']
  const values = ['resolved', 'escalated', 'monitoring', 'seen', 0, 1, true, false, null]
  let rec = record('case_1')
  const steps = 1 + Math.floor(next() * 6)
  for (let i = 0; i < steps; i += 1) {
    const field = fields[Math.floor(next() * fields.length)]
    const actor = actors[Math.floor(next() * actors.length)]
    const value = values[Math.floor(next() * values.length)]
    rec = writeField(rec, field, value, actor)
  }
  return rec
}

const merged = (a, b) => mergeRecords(a, b).record

describe('ENH-41 — a vector clock, not a counter', () => {
  it('ticks only the actor\'s own component', () => {
    assert.deepEqual(tickClock({}, 'phone'), { phone: 1 })
    assert.deepEqual(tickClock({ phone: 1, console: 4 }, 'phone'), { phone: 2, console: 4 })
  })

  it('calls two writes on the same base concurrent, not ordered', () => {
    // The state a Lamport counter cannot express, and the reason this design was
    // chosen over per-field last-writer-wins with an actor-id tiebreak: a counter
    // would say one of these is older and pick it, silently.
    const phone = tickClock({}, 'phone')
    const console = tickClock({}, 'console')
    assert.equal(compareClocks(phone, console), null, 'two writes from one base must be concurrent')
    assert.equal(compareClocks(console, phone), null, 'concurrency is symmetric')
  })

  it('orders a write after every write it saw, and only those', () => {
    const base = tickClock({}, 'console')
    const later = tickClock(base, 'phone')
    assert.equal(compareClocks(later, base), 1)
    assert.equal(compareClocks(base, later), -1)
    assert.equal(compareClocks(base, { ...base }), 0)
  })

  it('joins clocks componentwise, which is commutative and associative', () => {
    const a = { phone: 2, console: 1 }
    const b = { console: 3, district: 1 }
    const c = { phone: 1, district: 4 }
    assert.deepEqual(mergeClocks(a, b), mergeClocks(b, a))
    assert.deepEqual(
      mergeClocks(mergeClocks(a, b), c),
      mergeClocks(a, mergeClocks(b, c)),
    )
    assert.deepEqual(mergeClocks(emptyClock(), a), a, 'the empty clock is the identity')
  })
})

describe('ENH-41 — merge is commutative, associative and idempotent', () => {
  it('is commutative', () => {
    const base = record('case_1')
    const a = writeField(base, 'status', 'resolved', 'phone')
    const b = writeField(base, 'status', 'escalated', 'console')
    assert.deepEqual(merged(a, b), merged(b, a))
  })

  it('is associative', () => {
    const base = record('case_1')
    const a = writeField(base, 'status', 'resolved', 'phone')
    const b = writeField(base, 'notes', 'seen by district', 'console')
    const c = writeField(base, 'severity', 'high', 'district')
    assert.deepEqual(
      merged(merged(a, b), c),
      merged(a, merged(b, c)),
      'merging left-to-right and right-to-left disagreed, so arrival order decides the record',
    )
  })

  it('is idempotent — a phone that syncs twice reaches the same record', () => {
    const base = record('case_1')
    const a = writeField(base, 'status', 'resolved', 'phone')
    const b = writeField(base, 'status', 'escalated', 'console')
    const once = merged(a, b)
    const twice = merged(merged(a, b), b)
    assert.deepEqual(twice, once, 're-delivering the same incoming version changed the record')
    // And a version merged with itself is itself, when it is already normalised.
    assert.deepEqual(merged(once, once), once)
  })

  it('holds all three laws over generated records', () => {
    // The scenario tests above are three examples. This is the law, over a few
    // hundred random triples of records built by random write sequences — which
    // is where an "usually convergent" merge that agrees on the hand-picked
    // examples falls over.
    const next = rng(0x9e3779b9)
    for (let i = 0; i < 500; i += 1) {
      const x = randomRecord(next)
      const y = randomRecord(next)
      const z = randomRecord(next)
      assert.deepEqual(merged(x, y), merged(y, x), `commutativity failed on triple ${i}`)
      assert.deepEqual(
        merged(merged(x, y), z),
        merged(x, merged(y, z)),
        `associativity failed on triple ${i}`,
      )
      assert.deepEqual(merged(x, x), x, `idempotence failed on triple ${i}`)
    }
  })

  it('converges from every arrival order of three replicas', () => {
    // The three-replica merge, every one of the six orders, must land on one
    // record. This is commutativity and associativity exercised the way a sync
    // actually delivers — one hop at a time — rather than as a law on a pair.
    const base = record('case_1')
    const a = writeField(base, 'status', 'resolved', 'phone')
    const a2 = writeField(a, 'status', 'resolved (checked)', 'phone') // dominates a
    const b = writeField(base, 'status', 'escalated', 'console') // concurrent with both
    const replicas = [a, a2, b]

    const orders = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ]
    const results = orders.map((order) => order.reduce((acc, index) => merged(acc, replicas[index]), base))
    for (const result of results) {
      assert.deepEqual(result, results[0], 'two sync orders reached different records')
    }
    // And the dominating write won: `a` is gone, `a2` and `b` are the survivors.
    assert.equal(readField(results[0], 'status'), 'resolved (checked)')
    assert.deepEqual(
      fieldHeads(results[0], 'status').map((head) => head.actor).sort(),
      ['console', 'phone'],
    )
  })
})

describe('ENH-41 — a true concurrency is surfaced, never silently resolved', () => {
  it('keeps both values and reports both actors for a concurrent same-field write', () => {
    const base = record('case_1')
    const phone = writeField(base, 'status', 'resolved', 'phone')
    const console = writeField(base, 'status', 'escalated', 'console')

    const { record: result, conflicts } = mergeRecords(phone, console)

    assert.equal(conflicts.length, 1, 'a concurrent write to one field reported no conflict')
    const [conflict] = conflicts
    assert.equal(conflict.field, 'status')
    assert.deepEqual(
      conflict.candidates.map((c) => c.value).sort(),
      ['escalated', 'resolved'],
      'a candidate value was dropped — the merge picked instead of asking',
    )
    assert.deepEqual(conflict.actors.sort(), ['console', 'phone'])
    // Both heads survive on the record, not only in the report.
    assert.equal(fieldHeads(result, 'status').length, 2, 'the losing write was discarded from the record')
  })

  it('does not report a conflict when one write saw the other', () => {
    const base = record('case_1')
    const first = writeField(base, 'status', 'monitoring', 'console')
    const second = writeField(first, 'status', 'resolved', 'phone') // saw `first`

    const { record: result, conflicts } = mergeRecords(first, second)
    assert.deepEqual(conflicts, [], 'a causally ordered pair was reported as concurrent')
    assert.equal(readField(result, 'status'), 'resolved')
    assert.equal(fieldHeads(result, 'status').length, 1, 'a superseded head was kept')
  })

  it('resolves a conflict by a person writing, with no special function', () => {
    // A resolution is an act, and an act is a write whose clock dominates what it
    // saw — which collapses the antichain back to one head. The merge needs no
    // "resolve" verb for the same reason it needs no tiebreak: causality already
    // orders a decision after the options it was made from.
    const base = record('case_1')
    const phone = writeField(base, 'status', 'resolved', 'phone')
    const console = writeField(base, 'status', 'escalated', 'console')
    const conflicted = mergeRecords(phone, console).record

    const decided = writeField(conflicted, 'status', 'escalated', 'console')
    assert.equal(fieldHeads(decided, 'status').length, 1)
    assert.equal(readField(decided, 'status'), 'escalated')
    assert.deepEqual(conflictsOf(decided), [])
  })

  it('lists every unresolved field, and only those', () => {
    const base = record('case_1')
    const phone = writeField(writeField(base, 'status', 'resolved', 'phone'), 'notes', 'seen', 'phone')
    const console = writeField(writeField(base, 'status', 'escalated', 'console'), 'severity', 'high', 'console')
    const { record: result, conflicts } = mergeRecords(phone, console)
    // `status` is concurrent; `notes` and `severity` were written by one side only.
    assert.deepEqual(conflicts.map((c) => c.field), ['status'])
    assert.deepEqual(conflictsOf(result), conflicts)
    assert.equal(fieldConflict(result, 'notes'), null)
  })
})

describe('ENH-41 — the entry\'s scenario: an offline phone and an online console', () => {
  it('converges without either edit clobbering the other', () => {
    // The record the console holds, with the console's own edit already in it.
    const shared = record('case_1')
    const consoleOnline = writeField(shared, 'follow_up', 'visit scheduled', 'console')

    // The phone went offline with the *base* record, and edited a different field.
    const phoneOffline = writeField(shared, 'notes', 'household has 3 children', 'phone')

    // The phone syncs. The console's edit is preserved, the phone's is added, and
    // because the two fields are independent there is nothing to ask about.
    const onServer = mergeRecords(consoleOnline, phoneOffline)
    assert.deepEqual(onServer.conflicts, [], 'independent fields were reported as a conflict')
    assert.equal(readField(onServer.record, 'follow_up'), 'visit scheduled')
    assert.equal(readField(onServer.record, 'notes'), 'household has 3 children')

    // The console now pulls, and reaches the same record — the merge is symmetric.
    const onConsole = mergeRecords(consoleOnline, onServer.record).record
    assert.deepEqual(onConsole, onServer.record)
  })

  it('asks when the phone and the console edited the same field offline', () => {
    // The hard case the entry is named for: both devices were offline from each
    // other and both edited `status`. Neither value is dropped; a surface is told
    // to ask.
    const shared = record('case_1')
    const phoneOffline = writeField(shared, 'status', 'resolved', 'phone')
    const consoleOnline = writeField(shared, 'status', 'escalated', 'console')

    const first = mergeRecords(phoneOffline, consoleOnline)
    const second = mergeRecords(consoleOnline, phoneOffline)

    assert.deepEqual(first.record, second.record, 'the two sync directions disagreed')
    assert.equal(first.conflicts.length, 1)
    // Both values are still reachable; the surface renders a winner but is told
    // it is a winner, not the truth.
    const values = first.conflicts[0].candidates.map((c) => c.value).sort()
    assert.deepEqual(values, ['escalated', 'resolved'])
    assert.equal(typeof readField(first.record, 'status'), 'string')
  })

  it('refuses to merge two different records rather than inventing a rule', () => {
    // Identity is ENH-39's. This module owns the field map and nothing else, so a
    // merge across two ids is a caller error, not a case to resolve.
    const a = writeField(record('case_1'), 'status', 'resolved', 'phone')
    const b = writeField(record('case_2'), 'status', 'escalated', 'console')
    assert.throws(() => mergeRecords(a, b), /different records/)
  })
})

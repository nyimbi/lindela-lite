#!/usr/bin/env node
/**
 * ENH-10: the circuit breaker and the health score, guarded.
 *
 * Two defects, one file, because they are the same mistake.
 *
 * 1. `failure_streak` was computed by `failureStreak()` and read by nothing. A
 *    provider returning 502 for six days was still retried in full on every
 *    run-due tick, spending the wall clock the healthy sources behind it needed.
 *    Nothing failed loudly: the number sat in `/api/v1/ingestion` looking like
 *    telemetry and behaving like a comment. A breaker nobody trips is the same
 *    shape as a threshold nobody checks, so the tests below pin the boundaries
 *    from both sides — two failures do not trip, three do. Asserting only the
 *    tripping side would pass against a breaker that tripped on the first
 *    failure, which is not a breaker, it is a switch.
 *
 * 2. A health score computed over nothing reads as 100. That is worse than no
 *    score: the dashboard renders it green and nobody looks at the source again.
 *    The same conflation appears one level down — payload drift over an empty
 *    baseline as `0` asserts a stable payload size, which is unknowable from no
 *    measurements. So `scoreConnector` returns `null` plus a reason, and one test
 *    here exists purely to fail if that ever becomes a number.
 *
 * The three-reason test is the one the spec exists for. "The source didn't
 * update" is one line in a health table and three entirely different
 * operational stories: it updated (`ok`), it failed (`broken`), or we declined to
 * ask (`skipped_circuit_open`). Collapsing any two of them sends the operator to
 * debug a provider that is fine, while the one that is actually dead keeps
 * consuming the run budget.
 *
 * `now` is injected throughout, so the cooldown is exercised across 30 minutes in
 * microseconds and no test sleeps.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CIRCUIT_COOLDOWN_MINUTES,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_HISTORY_WINDOW,
  CIRCUIT_LATENCY_BUDGET_MS,
  CIRCUIT_SCORE_REASONS,
  CIRCUIT_STATES,
  allowRequest,
  circuitStateFor,
  createCircuitState,
  outcomesFor,
  recordOutcome,
  scoreConnector,
} from '../src/circuit.js'

const T0 = Date.parse('2026-10-03T00:00:00.000Z')
const MINUTE = 60000

function minutes(count) {
  return T0 + count * MINUTE
}

/** Drive `count` consecutive failures through the breaker at the given time. */
function failTimes(state, source, count, at = T0) {
  for (let i = 0; i < count; i += 1) {
    recordOutcome(state, source, { ok: false, latencyMs: 1000, recordCount: 0, now: at })
  }
  return state
}

function succeed(state, source, at = T0, recordCount = 100) {
  return recordOutcome(state, source, { ok: true, latencyMs: 250, recordCount, now: at })
}

describe('circuit breaker: the trip boundary', () => {
  it('two consecutive failures do not open the circuit', () => {
    // The below-threshold side. A breaker that trips at two is not conservative,
    // it is a coin flip: half of all transient provider blips would silence a
    // source that is working.
    const state = failTimes(createCircuitState(), 'gdacs', 2)
    assert.equal(state.sources.gdacs.consecutive_failures, 2)
    assert.equal(circuitStateFor(state, 'gdacs', { now: T0 }), 'closed')
  })

  it('three consecutive failures open the circuit', () => {
    const state = failTimes(createCircuitState(), 'gdacs', CIRCUIT_FAILURE_THRESHOLD)
    assert.equal(state.sources.gdacs.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD)
    assert.equal(circuitStateFor(state, 'gdacs', { now: T0 }), 'open')
  })

  it('a success between failures resets the streak, so it never accumulates', () => {
    // Fail, fail, succeed, fail, fail: five failures, none consecutive. The
    // breaker tracks a streak and nothing else.
    const state = createCircuitState()
    failTimes(state, 'chirps', 2)
    succeed(state, 'chirps')
    failTimes(state, 'chirps', 2, minutes(1))
    assert.equal(state.sources.chirps.consecutive_failures, 2)
    assert.equal(circuitStateFor(state, 'chirps', { now: minutes(1) }), 'closed')
  })

  it('a source that has never run is closed and permitted', () => {
    const state = createCircuitState()
    assert.equal(circuitStateFor(state, 'never-seen', { now: T0 }), 'closed')
    assert.equal(allowRequest(state, 'never-seen', { now: T0 }).allowed, true)
  })
})

describe('circuit breaker: the three distinct reasons', () => {
  it('an open circuit denies the request and says skipped_circuit_open', () => {
    const state = failTimes(createCircuitState(), 'gdacs', 3)
    const gate = allowRequest(state, 'gdacs', { now: T0 })
    assert.equal(gate.allowed, false)
    assert.equal(gate.reason, 'skipped_circuit_open')
    assert.equal(gate.state, 'open')
  })

  it('ok, broken and skipped_circuit_open are three different strings', () => {
    // The spec case. If these ever collapse into one, a working pipeline and a
    // dead one report identically and the health table stops carrying information.
    const healthy = allowRequest(createCircuitState(), 'chingo', { now: T0 })
    assert.equal(healthy.reason, 'ok')

    const failing = createCircuitState()
    failTimes(failing, 'flood', 1)
    assert.equal(circuitStateFor(failing, 'flood', { now: T0 }), 'closed')
    assert.equal(allowRequest(failing, 'flood', { now: T0 }).reason, 'broken')

    const tripped = failTimes(createCircuitState(), 'flood', 3)
    const skipped = allowRequest(tripped, 'flood', { now: T0 })

    const reasons = new Set([healthy.reason, allowRequest(failing, 'flood', { now: T0 }).reason, skipped.reason])
    assert.equal(reasons.size, 3, `expected three distinct reasons, got ${[...reasons].join(', ')}`)
    assert.ok(!reasons.has('ok'), 'a skipped run must not report ok — nothing was fetched')
    assert.ok(!skipped.reason.includes('ok'), 'a skipped run must not report ok — nothing was fetched')
  })

  it('a tripped-but-below-threshold source is reported broken while still callable', () => {
    // It is permitted and it is not `ok`. Reporting `ok` here is the same error as
    // the vacuous score: a green light over a source nobody has successfully read.
    const state = failTimes(createCircuitState(), 'ipc', 2)
    const gate = allowRequest(state, 'ipc', { now: T0 })
    assert.equal(gate.allowed, true)
    assert.equal(gate.reason, 'broken')
  })
})

describe('circuit breaker: cooldown and the single probe', () => {
  it('an open circuit stays open until the cooldown has fully elapsed', () => {
    const state = failTimes(createCircuitState(), 'gdacs', 3)
    const justBefore = T0 + CIRCUIT_COOLDOWN_MINUTES * MINUTE - 1
    assert.equal(circuitStateFor(state, 'gdacs', { now: justBefore }), 'open')
    assert.equal(allowRequest(state, 'gdacs', { now: justBefore }).reason, 'skipped_circuit_open')
  })

  it('cooldown expiry puts the circuit in half_open', () => {
    const state = failTimes(createCircuitState(), 'gdacs', 3)
    const after = T0 + CIRCUIT_COOLDOWN_MINUTES * MINUTE
    assert.equal(circuitStateFor(state, 'gdacs', { now: after }), 'half_open')
  })

  it('half_open permits exactly one probe and denies the second', () => {
    // The whole point of half_open. Two probes is a closed circuit with extra
    // steps: the source is still down and we have doubled the wall-clock cost of
    // finding that out again.
    const state = failTimes(createCircuitState(), 'gdacs', 3)
    const after = T0 + CIRCUIT_COOLDOWN_MINUTES * MINUTE

    const first = allowRequest(state, 'gdacs', { now: after })
    assert.equal(first.allowed, true)
    assert.equal(first.probe, true)
    assert.equal(first.state, 'half_open')

    const second = allowRequest(state, 'gdacs', { now: after })
    assert.equal(second.allowed, false)
    assert.equal(second.probe, false)
    assert.equal(second.reason, 'skipped_circuit_probe_in_flight')
  })

  it('a probe success closes the circuit and resets the streak', () => {
    const state = failTimes(createCircuitState(), 'gdacs', 3)
    const after = T0 + CIRCUIT_COOLDOWN_MINUTES * MINUTE
    allowRequest(state, 'gdacs', { now: after })
    succeed(state, 'gdacs', after)

    assert.equal(circuitStateFor(state, 'gdacs', { now: after }), 'closed')
    assert.equal(state.sources.gdacs.consecutive_failures, 0)
    assert.equal(allowRequest(state, 'gdacs', { now: after }).reason, 'ok')
    assert.equal(state.sources.gdacs.probe_in_flight, false, 'the probe claim must be released')
  })

  it('a probe failure re-opens the circuit and restarts the cooldown', () => {
    const state = failTimes(createCircuitState(), 'gdacs', 3)
    const after = T0 + CIRCUIT_COOLDOWN_MINUTES * MINUTE
    allowRequest(state, 'gdacs', { now: after })
    recordOutcome(state, 'gdacs', { ok: false, latencyMs: 900, recordCount: 0, now: after })

    assert.equal(circuitStateFor(state, 'gdacs', { now: after }), 'open')
    const stillEarly = after + CIRCUIT_COOLDOWN_MINUTES * MINUTE - 1
    assert.equal(allowRequest(state, 'gdacs', { now: stillEarly }).allowed, false)
    assert.equal(circuitStateFor(state, 'gdacs', { now: after + CIRCUIT_COOLDOWN_MINUTES * MINUTE }), 'half_open')
  })

  it('an open circuit whose trip time was never recorded does not probe', () => {
    // A breaker that cannot say how long it has been open has no licence to start
    // calling again. Half-open on an unknown age is optimism with a socket.
    const state = createCircuitState()
    state.sources.gdacs = { state: 'open', consecutive_failures: 3, opened_at: null, probe_in_flight: false, history: [] }
    assert.equal(circuitStateFor(state, 'gdacs', { now: T0 + 999 * MINUTE }), 'open')
    assert.equal(allowRequest(state, 'gdacs', { now: T0 + 999 * MINUTE }).allowed, false)
  })

  it('one source tripping does not silence another', () => {
    // The breaker is keyed by source. A single global switch would take the
    // healthy sources offline in sympathy with the dead one — the opposite of
    // what ENH-10 is for.
    const state = failTimes(createCircuitState(), 'gdacs', 3)
    succeed(state, 'chingo', minutes(1))
    assert.equal(allowRequest(state, 'chingo', { now: minutes(1) }).allowed, true)
    assert.equal(allowRequest(state, 'gdacs', { now: minutes(1) }).allowed, false)
  })
})

describe('scoreConnector: the anti-vacuous guard', () => {
  it('an empty history scores null, not a perfect score', () => {
    // If this returns 100 — or 1.0, or 0, or any number — the guard is gone and a
    // source nobody has ever called renders green.
    const scored = scoreConnector({ outcomes: [] })
    assert.equal(scored.score, null, 'a source with no history must not be scored')
    assert.equal(scored.samples, 0)
    assert.equal(scored.success_rate, null)
    assert.equal(scored.p50_latency_ms, null)
    assert.equal(scored.p95_latency_ms, null)
    assert.equal(scored.record_drift_ratio, null)
    assert.equal(scored.reason, CIRCUIT_SCORE_REASONS.NO_OUTCOMES)
    assert.ok(Object.values(CIRCUIT_SCORE_REASONS).includes(scored.reason), 'the reason must come from the exported vocabulary')
  })

  it('an absent outcomes key is treated as empty, not as an error and not as a score', () => {
    assert.equal(scoreConnector().score, null)
    assert.equal(scoreConnector({}).samples, 0)
    assert.equal(scoreConnector({ outcomes: null }).score, null)
  })

  it('a genuinely healthy history scores high', () => {
    // Without this, "always return null" would pass every test above. A breaker
    // that never opens and a score that is never computed are the same failure:
    // nothing is being measured.
    const outcomes = Array.from({ length: CIRCUIT_HISTORY_WINDOW }, (_, i) => ({
      ok: true,
      latency_ms: 300 + i,
      record_count: 1000,
      at: T0 + i * MINUTE,
    }))
    const scored = scoreConnector({ outcomes })

    assert.equal(scored.samples, CIRCUIT_HISTORY_WINDOW)
    assert.equal(scored.reason, null, `unexplained refusal to score: ${scored.reasons.join(', ')}`)
    assert.ok(scored.score >= 90, `a healthy source must score high, got ${scored.score}`)
    assert.equal(scored.success_rate, 1)
    assert.equal(scored.record_drift_ratio, 0, 'a stable payload has zero drift — this is measurable, unlike an empty window')
  })

  it('a fully failing history scores near zero rather than null', () => {
    // The failure mode is symmetric: a score that never drops is as useless as one
    // that is always perfect.
    const outcomes = Array.from({ length: 6 }, (_, i) => ({
      ok: false,
      latency_ms: CIRCUIT_LATENCY_BUDGET_MS,
      record_count: 0,
      at: T0 + i * MINUTE,
    }))
    const scored = scoreConnector({ outcomes })
    assert.equal(scored.reason, null)
    assert.equal(scored.success_rate, 0)
    assert.ok(scored.score <= 5, `a dead source must score near zero, got ${scored.score}`)
  })

  it('only the trailing window is scored', () => {
    const old = Array.from({ length: 5 }, () => ({ ok: false, latency_ms: 100, record_count: 1, at: T0 }))
    const recent = Array.from({ length: 5 }, () => ({ ok: true, latency_ms: 200, record_count: 50, at: minutes(1) }))
    const scored = scoreConnector({ outcomes: [...old, ...recent] })
    assert.equal(scored.samples, CIRCUIT_HISTORY_WINDOW)
    assert.equal(scored.success_rate, 0.5, 'only the last window counts; a dead month must not follow a healthy one forever')
  })

  it('payload drift is measured against the preceding counts', () => {
    const outcomes = [
      { ok: true, latency_ms: 200, record_count: 1000 },
      { ok: true, latency_ms: 200, record_count: 1000 },
      { ok: true, latency_ms: 200, record_count: 500 },
    ]
    const scored = scoreConnector({ outcomes })
    assert.equal(scored.record_drift_ratio, 0.5, 'the payload halved; that is a half of baseline drift')
    assert.equal(scored.drift_samples, 3)
  })

  it('a record count of zero is a measurement, not a missing value', () => {
    // Truthiness on 0 would file a valid empty page as "no data", drop it from the
    // baseline, and quietly shrink the window the score is computed over. This is
    // the falsy-zero defect wearing different clothes.
    const outcomes = [
      { ok: true, latency_ms: 100, record_count: 0 },
      { ok: true, latency_ms: 100, record_count: 0 },
      { ok: true, latency_ms: 100, record_count: 0 },
    ]
    const scored = scoreConnector({ outcomes })
    assert.equal(scored.drift_samples, 3)
    assert.equal(scored.record_drift_ratio, null, 'zero mean has nothing to divide by; it is not zero drift')
  })
})

describe('the vocabulary is iterable and every state the breaker returns is in it', () => {
  it('CIRCUIT_STATES has exactly three entries with no duplicates', () => {
    // This list is written once and checked nowhere unless something enumerates
    // it. That is how `src/ingestion.js` ended up with three parallel collection
    // lists that disagreed about the same six names.
    assert.equal(CIRCUIT_STATES.length, 3)
    assert.equal(new Set(CIRCUIT_STATES).size, CIRCUIT_STATES.length)
    assert.deepEqual([...CIRCUIT_STATES], ['closed', 'open', 'half_open'])
    assert.ok(Object.isFrozen(CIRCUIT_STATES), 'an un-frozen export is a list another module can quietly edit')
  })

  it('every state the breaker can return is in CIRCUIT_STATES', () => {
    // Driven through the state machine rather than read off the source: this is
    // the test that would notice a fourth state invented in a code path nobody
    // read.
    const seen = new Set()
    const state = createCircuitState()

    seen.add(circuitStateFor(state, 'gdacs', { now: T0 }))
    seen.add(allowRequest(state, 'gdacs', { now: T0 }).state)

    failTimes(state, 'gdacs', 3)
    seen.add(circuitStateFor(state, 'gdacs', { now: T0 }))
    seen.add(allowRequest(state, 'gdacs', { now: T0 }).state)

    const after = T0 + CIRCUIT_COOLDOWN_MINUTES * MINUTE
    seen.add(circuitStateFor(state, 'gdacs', { now: after }))
    seen.add(allowRequest(state, 'gdacs', { now: after }).state)
    allowRequest(state, 'gdacs', { now: after })
    seen.add(allowRequest(state, 'gdacs', { now: after }).state)

    succeed(state, 'gdacs', after)
    seen.add(circuitStateFor(state, 'gdacs', { now: after }))
    seen.add(allowRequest(state, 'gdacs', { now: after }).state)

    assert.ok(seen.size >= 3, `the walk only reached ${[...seen].join(', ')} — the guard would be vacuous`)
    for (const value of seen) {
      assert.ok(CIRCUIT_STATES.includes(value), `breaker returned state "${value}", which CIRCUIT_STATES does not list`)
    }
    assert.deepEqual([...seen].sort(), [...CIRCUIT_STATES].sort())
  })

  it('the exported threshold is the one the breaker uses', () => {
    // A hard-coded 3 beside an exported 3 would let a future edit change one and
    // leave the other lying.
    const state = createCircuitState()
    for (let i = 1; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      failTimes(state, 'gdacs', 1, minutes(i))
      assert.notEqual(circuitStateFor(state, 'gdacs', { now: T0 }), 'open', `opened after ${i} failures`)
    }
    failTimes(state, 'gdacs', 1, minutes(CIRCUIT_FAILURE_THRESHOLD))
    assert.equal(circuitStateFor(state, 'gdacs', { now: T0 }), 'open')
  })

  it('every reason the breaker can return is a known string', () => {
    const known = new Set(['ok', 'broken', 'skipped_circuit_open', 'probing_half_open', 'skipped_circuit_probe_in_flight'])
    const state = createCircuitState()
    const reasons = [allowRequest(state, 'gdacs', { now: T0 }).reason]

    failTimes(state, 'gdacs', 1)
    reasons.push(allowRequest(state, 'gdacs', { now: T0 }).reason)
    failTimes(state, 'gdacs', 2, minutes(1))
    reasons.push(allowRequest(state, 'gdacs', { now: T0 }).reason)

    const after = T0 + CIRCUIT_COOLDOWN_MINUTES * MINUTE
    reasons.push(allowRequest(state, 'gdacs', { now: after }).reason)
    reasons.push(allowRequest(state, 'gdacs', { now: after }).reason)

    for (const reason of reasons) assert.ok(known.has(reason), `unknown reason string: ${reason}`)
  })

  it('every reason the scorer can return is in the exported score reasons', () => {
    const known = new Set(Object.values(CIRCUIT_SCORE_REASONS))
    const cases = [
      [],
      [{ ok: true, latency_ms: 10, record_count: 1 }],
      [{ ok: true, latency_ms: 10, record_count: 1 }, { ok: true, latency_ms: 10, record_count: 1 }],
      [{ ok: true, latency_ms: 10, record_count: 1 }, { ok: true, latency_ms: 10, record_count: 2 }],
    ]
    for (const outcomes of cases) {
      const scored = scoreConnector({ outcomes })
      if (scored.reason !== null) assert.ok(known.has(scored.reason), `unknown score reason: ${scored.reason}`)
      for (const reason of scored.reasons) assert.ok(known.has(reason), `unknown score reason: ${reason}`)
    }
  })
})

describe('recordOutcome retains the history the score is computed from', () => {
  it('keeps one entry per run with its latency and record count', () => {
    const state = createCircuitState()
    succeed(state, 'chingo', T0, 120)
    recordOutcome(state, 'chingo', { ok: false, latencyMs: 4000, recordCount: 3, now: minutes(1) })

    const outcomes = outcomesFor(state, 'chingo')
    assert.equal(outcomes.length, 2)
    assert.deepEqual(outcomes[0], { ok: true, latency_ms: 250, record_count: 120, at: T0 })
    assert.deepEqual(outcomes[1], { ok: false, latency_ms: 4000, record_count: 3, at: minutes(1) })
  })

  it('trims the history to the trailing window', () => {
    const state = createCircuitState()
    for (let i = 0; i < CIRCUIT_HISTORY_WINDOW + 7; i += 1) {
      succeed(state, 'chingo', minutes(i), 100 + i)
    }
    assert.equal(outcomesFor(state, 'chingo').length, CIRCUIT_HISTORY_WINDOW)
    assert.equal(outcomesFor(state, 'chingo')[0].record_count, 100 + 7, 'the oldest entries are the ones dropped')
  })

  it('a missing latency or record count is stored as null, not as 0', () => {
    // 0 is a latency and a record count somebody measured. Storing "not
    // measured" as 0 is how a missing measurement becomes a perfect one.
    const state = recordOutcome(createCircuitState(), 'who', { ok: true, now: T0 })
    const [outcome] = outcomesFor(state, 'who')
    assert.equal(outcome.latency_ms, null)
    assert.equal(outcome.record_count, null)
  })

  it('a non-numeric record count is refused rather than coerced to 0', () => {
    const state = recordOutcome(createCircuitState(), 'flood', { ok: true, recordCount: 'many', now: T0 })
    assert.equal(outcomesFor(state, 'flood')[0].record_count, null)
  })

  it('an unknown source reports an empty history rather than throwing', () => {
    assert.deepEqual(outcomesFor(createCircuitState(), 'nope'), [])
  })
})

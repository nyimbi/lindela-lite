/**
 * ENH-11: the declared-but-unenforced rate limits, checked against the connectors
 * that declare them.
 *
 * Seven connectors carry `defaults.rateLimit` and until this landed nothing read
 * it. That is the defect this file guards, in the same shape as
 * `test/route-scope-coverage.test.js`: the missing behaviour has no runtime
 * event, so the check has to read the declaration out of the source and demand
 * that the policy table answer for it.
 *
 * Two of the tests below exist because the quiet version of the bug is worse
 * than the loud one. A limiter that leaks its slot on a thrown error leaves the
 * source running one request at a time forever, with every test still green and
 * every run still reporting success. And a `Retry-After` parser that returns `0`
 * for a missing header converts a rate-limit response into a hot loop, which is
 * why the absent case is asserted with `notEqual(result, 0)` and not merely
 * "equal to something falsy".
 *
 * No test here sleeps. The clock and the sleep function are injected, so a
 * 60-second window is exercised in microseconds and the suite cannot flake on a
 * loaded machine.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  coerceLimit,
  createBudget,
  createRateLimiter,
  enforce,
  parseRetryAfter,
  RATE_LIMIT_POLICIES,
} from '../src/rate-limit.js'
import { DEFAULT_COUNTRIES } from '../src/connectors/ipc-hdx.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONNECTOR_DIR = path.join(ROOT, 'src', 'connectors')

const MINUTE = 60_000

/**
 * A clock the test owns. `sleep` records a wake-up instead of scheduling one, and
 * `advance` fires them in time order; `tick` drains the microtask queue between
 * wake-ups so the limiter's `.then` chain settles before the next one is judged.
 */
function fakeClock(start = 0) {
  let at = start
  const pending = []
  return {
    now: () => at,
    sleep: (ms) => new Promise((resolve) => pending.push({ at: at + ms, resolve })),
    async advance(ms) {
      const target = at + ms
      for (;;) {
        await tick()
        const due = pending.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        pending.splice(pending.indexOf(due), 1)
        at = due.at
        due.resolve()
      }
      at = target
      await tick()
    },
    pending: () => pending.length,
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

function limiter(overrides, clock = fakeClock()) {
  return {
    clock,
    limiter: createRateLimiter({ now: clock.now, sleep: clock.sleep, jitter: () => 0, ...overrides }),
  }
}

describe('token bucket', () => {
  it('permits exactly ratePerWindow acquisitions in a window, then queues', async () => {
    // Concurrency is set above the rate on purpose: with every slot held the
    // wait is on a slot, which no amount of clock time releases, and this test
    // is about the bucket.
    const { clock, limiter: lim } = limiter({ ratePerWindow: 3, windowMs: MINUTE, concurrency: 4 })

    const releases = []
    for (let i = 0; i < 3; i += 1) releases.push(await lim.acquire())

    let fourth = 'not resolved'
    const fourthPromise = lim.acquire().then((release) => {
      fourth = 'resolved'
      return release
    })
    await tick()
    assert.equal(fourth, 'not resolved', 'the fourth acquisition in a 3/minute window must wait')
    assert.equal(lim.queued(), 1)

    await clock.advance(MINUTE)
    await fourthPromise
    assert.equal(fourth, 'resolved')
    assert.equal(releases.length, 3)
  })

  it('refills continuously rather than resetting on a window boundary', async () => {
    // A fixed window would still be empty at t=999ms. The continuous bucket is
    // the difference between a declared "20/min" and a 40-request worst minute
    // either side of a reset.
    const { clock, limiter: lim } = limiter({ ratePerWindow: 2, windowMs: 1000, concurrency: 3 })

    await lim.acquire()
    await lim.acquire()

    let third = 'not resolved'
    const thirdPromise = lim.acquire().then((release) => {
      third = 'resolved'
      return release
    })
    await tick()
    assert.equal(third, 'not resolved')

    await clock.advance(500)
    await thirdPromise
    assert.equal(third, 'resolved', 'half a window must return exactly one token')

    // 400ms further buys 0.8 of a token. Rounding that to a token would make the
    // bucket a fixed window wearing a token-bucket hat.
    let fourth = 'not resolved'
    void lim.acquire().then(() => {
      fourth = 'resolved'
    })
    await tick()
    await clock.advance(400)
    assert.equal(fourth, 'not resolved', '900ms of a 1000ms window cannot return two tokens')
    assert.equal(lim.queued(), 1)
  })

  it('drains a queue in FIFO order when time advances', async () => {
    const { clock, limiter: lim } = limiter({ ratePerWindow: 1, windowMs: 1000, concurrency: 4 })

    await lim.acquire()
    const order = []
    const queued = [1, 2, 3].map((n) => lim.acquire().then(() => order.push(n)))
    await tick()
    assert.deepEqual(order, [])

    await clock.advance(1000 * 3)
    await Promise.all(queued)
    assert.deepEqual(order, [1, 2, 3], 'a dropped or reordered waiter loses a country')
  })

  it('tryAcquire reports instead of queueing', async () => {
    const { limiter: lim } = limiter({ ratePerWindow: 1, windowMs: MINUTE, concurrency: 2 })
    const first = lim.tryAcquire()
    assert.equal(first.allowed, true)
    assert.equal(first.retryAfterMs, 0)

    const second = lim.tryAcquire()
    assert.equal(second.allowed, false)
    assert.equal(second.release, null)
    assert.ok(second.retryAfterMs > 0, 'a blocked caller needs a number to back off by')
    assert.ok(second.retryAfterMs <= MINUTE)
    assert.equal(lim.queued(), 0, 'tryAcquire must not enqueue — it is for probes that must not block')
  })

  it('reports retryAfterMs null when the block is a held slot, not the clock', async () => {
    // No amount of waiting frees a slot; a fabricated interval would invite a
    // caller to poll on a deadline that does not exist.
    const { limiter: lim } = limiter({ ratePerWindow: 1000, windowMs: MINUTE, concurrency: 1 })
    await lim.acquire()
    assert.deepEqual(lim.tryAcquire(), { allowed: false, release: null, retryAfterMs: null })
  })

  it('adds jitter to the wake-up', async () => {
    const clock = fakeClock()
    const waits = []
    const lim = createRateLimiter({
      ratePerWindow: 1,
      windowMs: 1000,
      concurrency: 2,
      jitterMs: 250,
      now: clock.now,
      sleep: (ms) => {
        waits.push(ms)
        return clock.sleep(ms)
      },
      jitter: (ceiling) => ceiling,
    })
    await lim.acquire()
    void lim.acquire()
    await tick()
    assert.equal(waits.length, 1)
    assert.ok(waits[0] > 1000 && waits[0] <= 1250, `expected 1000ms plus full jitter, got ${waits[0]}`)
  })

  it('rejects a nonsensical policy rather than defaulting', () => {
    assert.throws(() => createRateLimiter({ ratePerWindow: 0 }), TypeError)
    assert.throws(() => createRateLimiter({ windowMs: -1 }), TypeError)
    assert.throws(() => createRateLimiter({ concurrency: 0 }), TypeError)
    assert.throws(() => createRateLimiter({ jitterMs: -5 }), TypeError)
  })
})

describe('concurrency cap', () => {
  it('holds at most `concurrency` requests in flight', async () => {
    // Rate is high enough that tokens are never the binding constraint, so
    // anything above the cap in flight would be the cap not working.
    const { limiter: lim } = limiter({ ratePerWindow: 1000, windowMs: MINUTE, concurrency: 2 })

    const pending = [lim.acquire(), lim.acquire(), lim.acquire(), lim.acquire()]
    await tick()
    assert.equal(lim.inFlight(), 2)
    assert.equal(lim.queued(), 2)

    const releases = await Promise.all(pending.slice(0, 2))
    await tick()
    assert.equal(lim.inFlight(), 2, 'a release admits exactly one waiter')
    assert.equal(lim.queued(), 1)

    releases.forEach((release) => release())
    assert.equal(lim.inFlight(), 0)
  })

  it('ignores a double release so the cap cannot drift above its setting', async () => {
    const { limiter: lim } = limiter({ ratePerWindow: 1000, windowMs: MINUTE, concurrency: 1 })
    const release = await lim.acquire()
    release()
    release()
    assert.equal(lim.inFlight(), 0)

    const held = await lim.acquire()
    await tick()
    assert.equal(lim.inFlight(), 1)
    assert.equal(lim.queued(), 0)
    held()
  })
})

describe('enforce', () => {
  it('releases the slot when fn throws', async () => {
    // The leak test. One connector failing once would otherwise hold its slot
    // for the rest of the process: the source quietly degrades to serial, every
    // run still reports success, and nothing raises. A leaked slot cannot be
    // observed by a test that waits on the leaked acquisition — it just hangs —
    // so this asserts the counter directly.
    const { limiter: lim } = limiter({ ratePerWindow: 1000, windowMs: MINUTE, concurrency: 1 })

    await assert.rejects(
      enforce(lim, async () => {
        throw new Error('upstream 503')
      }),
      /upstream 503/,
    )

    assert.equal(lim.inFlight(), 0, 'a thrown error left its concurrency slot behind')
    assert.equal(lim.queued(), 0)

    const release = await lim.acquire()
    assert.equal(lim.inFlight(), 1, 'a fresh acquisition could not get the slot back')
    release()
  })

  it('does not strand a concurrent caller when the other throws', async () => {
    const { limiter: lim } = limiter({ ratePerWindow: 1000, windowMs: MINUTE, concurrency: 2 })

    const results = await Promise.allSettled([
      enforce(lim, async () => 'survivor'),
      enforce(lim, async () => {
        throw new Error('boom')
      }),
    ])

    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[0].value, 'survivor')
    assert.equal(results[1].status, 'rejected')
    assert.equal(lim.inFlight(), 0)
  })

  it('returns fn\'s value and leaves an empty queue when it succeeds', async () => {
    const { limiter: lim } = limiter({ ratePerWindow: 1000, windowMs: MINUTE, concurrency: 4 })
    const seen = []
    for (let i = 0; i < 4; i += 1) seen.push(await enforce(lim, async () => i))
    assert.deepEqual(seen, [0, 1, 2, 3])
    assert.equal(lim.inFlight(), 0)
    assert.equal(lim.queued(), 0)
  })
})

describe('parseRetryAfter', () => {
  const now = () => Date.parse('2026-10-03T12:00:00.000Z')

  it('reads delta-seconds', () => {
    assert.equal(parseRetryAfter('120', { now }), 120_000)
    assert.equal(parseRetryAfter('  30  ', { now }), 30_000)
    assert.equal(parseRetryAfter(['45'], { now }), 45_000, 'a duplicated header arrives as an array')
  })

  it('reads an HTTP-date relative to the injected clock', () => {
    assert.equal(parseRetryAfter('Sat, 03 Oct 2026 12:01:00 GMT', { now }), 60_000)
  })

  it('clamps a date in the past to 1ms rather than 0', () => {
    // Server clocks are not ours. Answering a past date with 0 means one instant
    // retry per response, which is the hot loop this function exists to remove.
    assert.equal(parseRetryAfter('Sat, 03 Oct 2026 11:59:00 GMT', { now }), 1)
  })

  it('returns null for an absent header, and never 0', () => {
    // Zero here means "the provider told us nothing, so go now". That is the one
    // value that turns a 429 into a tight retry loop, and it is invisible to a
    // falsy check — which is why this asserts against 0 by name.
    for (const absent of [undefined, null, '', '   ', [], [null]]) {
      const result = parseRetryAfter(absent, { now })
      assert.equal(result, null, `expected null for ${JSON.stringify(absent)}, got ${result}`)
      assert.notEqual(result, 0)
      assert.notEqual(result, undefined, 'an undefined retry hint reads as "undefined" at the call site')
    }
  })

  it('returns null for malformed values', () => {
    for (const bad of ['soon', 'later please', '20/fortnight', '-5', '1.2.3', {}, true, Number.NaN]) {
      const result = parseRetryAfter(bad, { now })
      assert.equal(result, null, `expected null for ${String(bad)}, got ${result}`)
      assert.notEqual(result, 0)
    }
  })

  it('treats an explicit zero delta as absent', () => {
    assert.equal(parseRetryAfter('0', { now }), null)
    assert.equal(parseRetryAfter(0, { now }), null)
  })
})

describe('coerceLimit', () => {
  it('reads the shape the connectors actually declare', () => {
    assert.deepEqual(coerceLimit({ perMinute: 120 }), { ratePerWindow: 120, windowMs: 60_000 })
    assert.deepEqual(coerceLimit({ perMinute: 20 }), { ratePerWindow: 20, windowMs: 60_000 })
    assert.deepEqual(coerceLimit({ perHour: 500 }), { ratePerWindow: 500, windowMs: 3_600_000 })
  })

  it('reads the shapes a future connector might write', () => {
    assert.deepEqual(coerceLimit('20/min'), { ratePerWindow: 20, windowMs: 60_000 })
    assert.deepEqual(coerceLimit(' 120 per minute '), { ratePerWindow: 120, windowMs: 60_000 })
    assert.deepEqual(coerceLimit({ requests: 30, windowMs: 1000 }), { ratePerWindow: 30, windowMs: 1000 })
    assert.deepEqual(coerceLimit({ max: 5, windowMs: 250 }), { ratePerWindow: 5, windowMs: 250 })
    assert.deepEqual(coerceLimit({ ratePerWindow: 7, windowMs: 9000 }), { ratePerWindow: 7, windowMs: 9000 })
  })

  it('accepts its own output, so a policy can be fed back through it', () => {
    const once = coerceLimit('20/min')
    assert.deepEqual(coerceLimit(once), once)
    assert.deepEqual(coerceLimit(RATE_LIMIT_POLICIES.ipc_hdx), { ratePerWindow: 20, windowMs: 60_000 })
  })

  it('returns null rather than a permissive default', () => {
    // A default here reads downstream as "this source is limited". A null is a
    // refusal the call site has to deal with, which is the whole point.
    for (const bad of [
      undefined, null, '', 'per minute', '20/fortnight', 'twenty per minute', {}, [], 20, true,
      { perMinute: 0 }, { perMinute: -5 }, { perMinute: 1.5 }, { perMinute: '20' }, { perMinute: null },
      { perMinute: Number.NaN }, { requests: 10 }, { perMinute: 10, windowMs: 0 }, { perMinute: 10, windowMs: '60000' },
    ]) {
      assert.equal(coerceLimit(bad), null, `expected null for ${JSON.stringify(bad)}`)
    }
  })
})

describe('createBudget', () => {
  it('reports remaining time and paces the next interval', () => {
    const clock = fakeClock()
    const budget = createBudget({ totalMs: 1000, name: 'gdacs_archive', expectedRequests: 4, now: clock.now })

    assert.equal(budget.remainingMs(), 1000)
    assert.equal(budget.remaining(), 250)
    assert.equal(budget.isExhausted(), false)
    assert.deepEqual(budget.issue(), { allowed: true, waitMs: 250, reason: null })
  })

  it('exhausts on the clock and never reports a negative remainder', async () => {
    // gdacs-archive's full-range backfill reached ~4.2 hours while holding a
    // request socket. Each individual call was a healthy 30s; it was the sum
    // that ran away. An overspent budget reporting a negative interval would be
    // honoured by a caller as a sleep backwards.
    const clock = fakeClock()
    const budget = createBudget({ totalMs: 1000, name: 'gdacs_archive', now: clock.now })

    await clock.advance(600)
    assert.equal(budget.remainingMs(), 400)
    assert.equal(budget.issue().allowed, true)

    await clock.advance(400)
    assert.equal(budget.isExhausted(), true)
    assert.equal(budget.remainingMs(), 0)
    assert.equal(budget.remaining(), 0)

    const denied = budget.issue()
    assert.equal(denied.allowed, false)
    assert.equal(denied.waitMs, null)
    assert.match(denied.reason, /gdacs_archive/)

    await clock.advance(10_000)
    assert.equal(budget.remainingMs(), 0)
    assert.equal(budget.isExhausted(), true)
  })

  it('paces evenly only when the caller states how many requests are left', () => {
    const clock = fakeClock()
    const guarded = createBudget({ totalMs: 1000, name: 'gdacs_archive', now: clock.now })
    assert.equal(guarded.remaining(), 0, 'no denominator, no pacing — the budget is a guard only')

    const paced = createBudget({ totalMs: 1000, name: 'ipc_hdx', expectedRequests: 2, now: clock.now })
    assert.equal(paced.remaining(), 500)
    paced.issue()
    paced.issue()
    assert.equal(paced.issued(), 2)
    assert.equal(paced.remaining(), 500)
  })

  it('rejects a budget with no positive duration', () => {
    assert.throws(() => createBudget({ totalMs: 0 }), TypeError)
    assert.throws(() => createBudget({ totalMs: -1 }), TypeError)
    assert.throws(() => createBudget({ totalMs: 1000, expectedRequests: -1 }), TypeError)
  })
})

/**
 * The anti-vacuous guard: the declarations are read out of the connector source
 * and each one must resolve to a policy. A limiter that is built but never
 * consulted looks exactly like a limiter that is doing nothing.
 */
describe('declared limits are enforced', () => {
  const declared = collectDeclaredLimits()

  it('finds the declarations — if this ever reports zero, the regex rotted', () => {
    assert.ok(declared.length >= 7, `expected at least 7 connectors declaring a rateLimit, found ${declared.length}`)
    assert.deepEqual(
      declared.map((entry) => entry.id).sort(),
      ['gdacs', 'glofas', 'ipc_hdx', 'noaa_enso', 'open_meteo', 'usgs_earthquake', 'who_gho'],
    )
  })

  it('gives every declaring connector a policy at the rate it declared', () => {
    for (const entry of declared) {
      const policy = RATE_LIMIT_POLICIES[entry.id]
      assert.ok(policy, `${entry.id} declares ${entry.literal} but RATE_LIMIT_POLICIES has no entry for it`)

      const limit = coerceLimit(entry.value)
      assert.ok(limit, `${entry.id} declares ${entry.literal}, which coerceLimit cannot read`)
      assert.deepEqual(
        { ratePerWindow: policy.ratePerWindow, windowMs: policy.windowMs },
        limit,
        `${entry.id}'s policy has drifted from its own declaration`,
      )
      assert.ok(Number.isInteger(policy.concurrency) && policy.concurrency >= 1)
      assert.ok(Object.isFrozen(RATE_LIMIT_POLICIES) && Object.isFrozen(policy))
    }
  })

  it('carries no entry for a connector that declares nothing', () => {
    // The inverse check, so the table cannot quietly grow a policy for a source
    // whose provider budget nobody has looked up. An invented rate is the exact
    // failure the header comment warns against.
    for (const id of ['gdacs_archive', 'chirps', 'nasa_firms', 'open_meteo_archive', 'open_meteo_flood', 'dhis2']) {
      assert.equal(RATE_LIMIT_POLICIES[id], undefined, `${id} declares no rate limit and has no policy entry`)
    }
  })

  it('caps the one fan-out in the connector layer below the fan-out width', () => {
    // ipc-hdx.js:265 runs one Promise.all over every ISO code, two requests
    // each. The declared budget is 20/min and the run issues ~92 calls: the
    // policy's job is to make that take four and a half minutes instead of one.
    const policy = RATE_LIMIT_POLICIES.ipc_hdx
    const requestsPerRun = DEFAULT_COUNTRIES.length * 2
    assert.ok(requestsPerRun > policy.ratePerWindow, `fan-out of ${requestsPerRun} no longer exceeds the budget`)
    assert.ok(policy.concurrency > 1, 'a cap of 1 would serialise the country loop entirely')
    assert.ok(policy.concurrency < DEFAULT_COUNTRIES.length, 'a wide cap is the defect, not the fix')
  })
})

/** Every `rateLimit:` in `src/connectors/*.js`, paired with the spec id above it. */
function collectDeclaredLimits() {
  const found = []
  for (const file of fs.readdirSync(CONNECTOR_DIR).filter((name) => name.endsWith('.js')).sort()) {
    const source = fs.readFileSync(path.join(CONNECTOR_DIR, file), 'utf8')
    const declarations = source.matchAll(/rateLimit\s*:\s*(\{[^{}]*\}|'[^']*'|"[^"]*")/g)
    for (const match of declarations) {
      const ids = [...source.slice(0, match.index).matchAll(/\bid:\s*'([^']+)'/g)]
      if (!ids.length) continue
      found.push({
        file,
        id: ids[ids.length - 1][1],
        literal: match[1],
        value: parseLiteral(match[1]),
      })
    }
  }
  return found
}

/**
 * Turns a declaration literal into a value without `eval`, which has no place in
 * a repository that ships a CSV-injection guard and a PII guard.
 */
function parseLiteral(literal) {
  if (!literal.startsWith('{')) return literal.slice(1, -1)
  const body = literal.slice(1, -1)
  return Object.fromEntries(
    [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,]+)/g)].map((entry) => {
      const raw = entry[2].trim()
      return [entry[1], raw.startsWith("'") ? raw.slice(1, -1) : Number(raw)]
    }),
  )
}
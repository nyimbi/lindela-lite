#!/usr/bin/env node
/**
 * SCL-08 and SCL-09: two places that grew without bound under load.
 *
 * SCL-08  `pg0.runCommand` concatenated a child's stdout and stderr into
 *         growing strings with no cap, and left its abort timer live.
 * SCL-09  the outbound rate-limiter's queue was unbounded, so sustained
 *         overload accumulated a waiter per caller until memory ran out.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PG0_MAX_OUTPUT_CHARS, capChildOutput } from '../src/pg0.js'
import { RateLimitQueueFullError, createRateLimiter } from '../src/rate-limit.js'

describe('SCL-08 a child process cannot grow the parent without bound', () => {
  it('keeps the head and the tail of an over-long stream', () => {
    // `pg_restore` prints every object it restores. The head carries the
    // opening and any early failure; the tail carries the summary and the last
    // error. The middle is progress output.
    const head = 'HEAD-MARKER\n'
    const tail = '\nTAIL-MARKER'
    let out = head
    out = capChildOutput(out, Buffer.from('x'.repeat(PG0_MAX_OUTPUT_CHARS)))
    out = capChildOutput(out, Buffer.from('y'.repeat(PG0_MAX_OUTPUT_CHARS)))
    out = capChildOutput(out, Buffer.from(tail))
    assert.ok(out.length <= PG0_MAX_OUTPUT_CHARS + 200, `output grew to ${out.length} characters`)
    assert.ok(out.startsWith('HEAD-MARKER'), 'the head of the stream was dropped')
    assert.ok(out.endsWith('TAIL-MARKER'), 'the tail of the stream was dropped')
    assert.match(out, /output truncated/, 'the truncation was silent')
  })

  it('leaves a stream under the cap untouched', () => {
    let out = ''
    out = capChildOutput(out, Buffer.from('initdb: done\n'))
    out = capChildOutput(out, Buffer.from('pg_ctl: server started\n'))
    assert.equal(out, 'initdb: done\npg_ctl: server started\n')
    assert.doesNotMatch(out, /truncated/)
  })

  it('caps rather than discarding once the cap is reached', () => {
    // The failure this guards is not "output is long" but "output is long and
    // the parent keeps all of it". A cap that dropped everything past the limit
    // would lose the summary line, which is the one an operator reads.
    let out = ''
    for (let i = 0; i < 40; i += 1) out = capChildOutput(out, Buffer.from(`${'z'.repeat(50000)}\n`))
    assert.ok(out.length <= PG0_MAX_OUTPUT_CHARS + 200, `output grew to ${out.length} characters`)
    assert.ok(out.length > 0, 'the cap dropped everything')
  })
})

describe('SCL-09 the outbound queue refuses rather than growing without bound', () => {
  /**
   * A clock whose `sleep` resolves only when the test advances past the
   * deadline. An immediately-resolving sleep makes `scheduleWake` spin: the
   * wake re-drains, finds no token, and schedules another wake in the same
   * microtask turn.
   */
  const clock = (start = 0) => {
    let t = start
    const timers = []
    return {
      now: () => t,
      sleep: (ms) => new Promise((resolve) => { timers.push({ at: t + ms, resolve }) }),
      advance: (ms) => {
        t += ms
        for (let i = timers.length - 1; i >= 0; i -= 1) {
          if (timers[i].at <= t) {
            const [timer] = timers.splice(i, 1)
            timer.resolve()
          }
        }
      },
      pending: () => timers.length,
    }
  }

  it('rejects past maxQueue with a retry hint and a 503 status', async () => {
    const c = clock()
    // A plentiful bucket and one slot, so the waiters block on the *slot* and
    // no timer is involved: releasing the holder drains them in one synchronous
    // chain, which keeps the test deterministic without a fake clock advance.
    const limiter = createRateLimiter({
      ratePerWindow: 100, windowMs: 60000, concurrency: 1, maxQueue: 3,
      now: c.now, sleep: c.sleep,
    })
    const held = await limiter.acquire()
    const waiting = [limiter.acquire(), limiter.acquire(), limiter.acquire()]
    assert.equal(limiter.queued(), 3)
    // Raced against a timeout so that a missing bound fails the test rather
    // than hanging it: without the guard the fifth acquire joins the queue and
    // never settles, which is a test that reports nothing.
    const refusal = await Promise.race([
      limiter.acquire().then(() => 'resolved', (error) => error),
      new Promise((resolve) => { setTimeout(() => resolve('timed-out'), 2000).unref() }),
    ])
    assert.notEqual(refusal, 'resolved', 'the queue accepted an acquire past its bound')
    assert.notEqual(refusal, 'timed-out', 'the acquire neither resolved nor refused; there is no bound')
    assert.ok(refusal instanceof RateLimitQueueFullError, `expected a queue-full error, got ${refusal?.name}`)
    assert.equal(refusal.statusCode, 503)
    // Blocked on a held slot, so no clock time releases it and there is no
    // honest number to report.
    assert.equal(refusal.retryAfterMs, null)
    assert.equal(limiter.queued(), 3, 'the refusal must not have joined the queue')
    // One slot, so each release drains exactly the next waiter: release, await
    // the next, release, and so on. A `Promise.all` would deadlock — waiters
    // two and three are still queued while the first holds the only slot.
    let release = held
    for (let i = 0; i < 3; i += 1) {
      release()
      release = await waiting[i]
    }
    release()
    assert.equal(limiter.queued(), 0)
    assert.equal(limiter.inFlight(), 0)
  })

  it('reports its own bound', () => {
    const limiter = createRateLimiter({ ratePerWindow: 1, windowMs: 1000, maxQueue: 7 })
    assert.equal(limiter.maxQueue(), 7)
  })

  it('refuses a bound that is not a positive integer', () => {
    for (const maxQueue of [0, -1, 1.5, 'ten']) {
      assert.throws(
        () => createRateLimiter({ ratePerWindow: 1, windowMs: 1000, maxQueue }),
        /maxQueue must be a positive integer/,
        `maxQueue=${maxQueue} was accepted`,
      )
    }
  })

  it('leaves normal fan-out untouched under the default bound', async () => {
    // The bound exists for the pathological case. 46 countries is the fan-out
    // this codebase actually has, and it must not be refused.
    const c = clock()
    const limiter = createRateLimiter({
      ratePerWindow: 100, windowMs: 60000, concurrency: 100,
      now: c.now, sleep: c.sleep,
    })
    const releases = await Promise.all(Array.from({ length: 46 }, () => limiter.acquire()))
    assert.equal(releases.length, 46)
    for (const release of releases) release()
  })
})

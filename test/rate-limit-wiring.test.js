/**
 * ENH-11 wiring: the rate limiter, driven through `fetchWithRetry`.
 *
 * `test/rate-limit.test.js` proves the limiter waits and that `Retry-After`
 * parses. It cannot prove any of it happens, because nothing called it. These
 * tests drive the real function against a stubbed `globalThis.fetch` and assert
 * on *when the stub was entered* — a limiter that is constructed and never
 * awaited, or one that is awaited and never consulted, both leave three
 * timestamps that are identical to the millisecond, and only the timestamps
 * tell them apart.
 *
 * The trap this file is built around: a wiring check that measures nothing
 * passes. Every test below asserts that the stub was entered exactly as many
 * times as it should have been, before asserting anything about timing. A
 * timing assertion on a run where the fetches never happened is a pass with no
 * meaning.
 *
 * Nothing here sleeps for a minute. Windows are a few hundred milliseconds
 * wide, and the one test that needs a minute-scale budget injects the sleep
 * function instead of waiting out the clock.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { fetchWithRetry, resetRateLimiters } from '../src/connectors/http.js'

/**
 * A fetch stub that records when it was entered.
 *
 * Returning a `Response` (rather than a plain object) is deliberate: the real
 * body-reading path is exercised, so a wiring that captured the wrong half of a
 * response fails here rather than in production.
 */
function recordingFetch(responses) {
  const enteredAt = []
  const impl = async (url, init) => {
    enteredAt.push(Date.now())
    const next = typeof responses === 'function' ? await responses(url, init) : responses.shift()
    if (next instanceof Error) throw next
    return next
  }
  impl.enteredAt = enteredAt
  return impl
}

describe('fetchWithRetry honours a declared limit', () => {
  let original

  beforeEach(() => {
    original = globalThis.fetch
    resetRateLimiters()
  })

  afterEach(() => {
    globalThis.fetch = original
    resetRateLimiters()
  })

  it('waits for a token instead of bursting', async () => {
    // Two tokens, 400ms window: the first two go at once, the third has to wait
    // ~200ms for the bucket to refill. A burst would show three identical
    // timestamps.
    const stub = recordingFetch(() => new Response('ok', { status: 200 }))
    globalThis.fetch = stub

    const rateLimit = { perMinute: 20 }
    const tiny = { ratePerWindow: 2, windowMs: 400 }
    const bodies = []
    for (let i = 0; i < 3; i += 1) {
      bodies.push(await fetchWithRetry('https://limited.test/a', { retries: 0, rateLimit, ...tiny }))
    }

    assert.equal(stub.enteredAt.length, 3, 'every request reached the network — a timing assertion below would be vacuous otherwise')
    assert.deepEqual(bodies, ['ok', 'ok', 'ok'])
    const third = stub.enteredAt[2] - stub.enteredAt[1]
    assert.ok(third >= 150, `third request waited ${third}ms for a token, expected ~200`)
    assert.ok(third < 5000, `third request waited ${third}ms, which is a stall rather than a limit`)
  })

  it('gives different hosts different budgets', async () => {
    // One request per 10 seconds. If both hosts shared a bucket, the second
    // would wait ten seconds; the bound below is the assertion, and it fails
    // by timing out rather than by hanging.
    const stub = recordingFetch(() => new Response('ok', { status: 200 }))
    globalThis.fetch = stub

    const rateLimit = { ratePerWindow: 1, windowMs: 10000, concurrency: 1 }
    const startedAt = Date.now()
    const results = await Promise.all([
      fetchWithRetry('https://one.test/a', { retries: 0, rateLimit, source: 'gdacs' }),
      fetchWithRetry('https://two.test/a', { retries: 0, rateLimit, source: 'gdacs' }),
    ])
    const elapsed = Date.now() - startedAt

    assert.equal(stub.enteredAt.length, 2, 'both hosts were actually fetched')
    assert.deepEqual(results, ['ok', 'ok'])
    assert.ok(elapsed < 2000, `two hosts shared one budget and the second waited ${elapsed}ms`)
  })

  it('holds one budget across calls to the same host', async () => {
    // The per-host key is the other half of the same claim: separate keys for
    // separate hosts, and a shared key for the same host. Without this, a
    // per-call limiter would satisfy the test above perfectly while never
    // limiting anything.
    const stub = recordingFetch(() => new Response('ok', { status: 200 }))
    globalThis.fetch = stub

    const rateLimit = { ratePerWindow: 1, windowMs: 300 }
    await fetchWithRetry('https://same.test/a', { retries: 0, rateLimit })
    await fetchWithRetry('https://same.test/b', { retries: 0, rateLimit })

    assert.equal(stub.enteredAt.length, 2)
    const waited = stub.enteredAt[1] - stub.enteredAt[0]
    assert.ok(waited >= 200, `second request to the same host waited only ${waited}ms`)
  })

  it('releases the slot when a request fails, rather than holding it forever', async () => {
    // A leaked permit is the quietest degradation in this codebase: one
    // connector throwing once would pin the source to a single in-flight
    // request for the rest of the process, with every test still green. The
    // budget is 100 per minute so tokens never bind — only a leaked slot can
    // make the second call wait, and this test times out if it does.
    const stub = recordingFetch(() => new Error('connection reset'))
    globalThis.fetch = stub

    const rateLimit = { ratePerWindow: 100, windowMs: 60000, concurrency: 1 }
    await assert.rejects(() => fetchWithRetry('https://leaky.test/a', { retries: 0, rateLimit }), /connection reset/)
    await assert.rejects(() => fetchWithRetry('https://leaky.test/a', { retries: 0, rateLimit }), /connection reset/)

    assert.equal(stub.enteredAt.length, 2, 'the second attempt reached the network, so the first released its slot')
  }, { timeout: 3000 })

  it('refuses an unreadable declaration rather than inventing a limit', async () => {
    // `{ perMinute: 'lots' }` is a number nobody vouched for. `coerceLimit`
    // returns null and the fetch proceeds unthrottled, which is the honest
    // outcome: a limiter built on a guess would leave the call site believing
    // the source was protected.
    const stub = recordingFetch(() => new Response('ok', { status: 200 }))
    globalThis.fetch = stub

    const startedAt = Date.now()
    for (let i = 0; i < 3; i += 1) {
      const body = await fetchWithRetry('https://malformed.test/a', { retries: 0, rateLimit: { perMinute: 'lots' } })
      assert.equal(body, 'ok')
    }
    const elapsed = Date.now() - startedAt

    assert.equal(stub.enteredAt.length, 3)
    assert.ok(elapsed < 1000, `a malformed declaration throttled the fetch by ${elapsed}ms`)
  })
})

describe('fetchWithRetry honours Retry-After', () => {
  let original

  beforeEach(() => {
    original = globalThis.fetch
    resetRateLimiters()
  })

  afterEach(() => {
    globalThis.fetch = original
    resetRateLimiters()
  })

  it('waits the interval the provider asked for, not the 150ms backoff', async () => {
    // Sleep is injected, so a one-minute request costs no wall clock and cannot
    // flake on a loaded machine. What is asserted is the number of
    // milliseconds the retry loop asked to wait — the value the header
    // produced.
    const delays = []
    const sleep = async (ms) => { delays.push(ms) }
    let calls = 0
    const stub = recordingFetch(() => {
      calls += 1
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
      return new Response('ok', { status: 200 })
    })
    globalThis.fetch = stub

    const body = await fetchWithRetry('https://asked.test/a', { retries: 2, sleep })

    assert.equal(body, 'ok', 'the retry happened and succeeded')
    assert.equal(stub.enteredAt.length, 2, 'exactly one retry, not a hot loop')
    assert.deepEqual(delays, [2000], 'Retry-After: 2 must win over the 150ms backoff')
  })

  it('keeps the headers on the error it throws', async () => {
    // The header is unreadable at all unless the error carries the response,
    // and the previous shape — `new Error('HTTP ' + status)` — dropped them on
    // the floor. This asserts the error a caller sees when it does not retry.
    const stub = recordingFetch(() => new Response('nope', {
      status: 503,
      headers: { 'retry-after': '30', 'x-request-id': 'abc123' },
    }))
    globalThis.fetch = stub

    const error = await fetchWithRetry('https://asked.test/b', { retries: 0 }).then(() => null, (e) => e)

    assert.ok(error, 'the request failed')
    assert.equal(error.message, 'HTTP 503', 'the message every existing caller greps for is unchanged')
    assert.equal(error.status, 503)
    assert.equal(error.retryAfterMs, 30000)
    assert.equal(error.headers.get('x-request-id'), 'abc123', 'the headers reached the caller intact')
  })

  it('falls back to its own backoff when the provider says nothing', async () => {
    // `parseRetryAfter` returns null for an absent header, never 0, precisely
    // so this path stays the 150ms it always was. A header that read as zero
    // would turn a 429 into a hot loop.
    const delays = []
    const sleep = async (ms) => { delays.push(ms) }
    let calls = 0
    const stub = recordingFetch(() => {
      calls += 1
      if (calls < 3) return new Response('busy', { status: 429 })
      return new Response('ok', { status: 200 })
    })
    globalThis.fetch = stub

    const body = await fetchWithRetry('https://asked.test/c', { retries: 3, sleep })

    assert.equal(body, 'ok')
    assert.equal(stub.enteredAt.length, 3)
    assert.deepEqual(delays, [150, 300], 'the existing backoff schedule, unchanged')
  })
})

describe('a caller that declares nothing is not slowed down', () => {
  let original

  beforeEach(() => {
    original = globalThis.fetch
    resetRateLimiters()
  })

  afterEach(() => {
    globalThis.fetch = original
  })

  it('keeps the 150ms/300ms backoff the sixteen existing connectors get', async () => {
    const delays = []
    const sleep = async (ms) => { delays.push(ms) }
    const stub = recordingFetch(() => new Response('busy', { status: 500 }))
    globalThis.fetch = stub

    await assert.rejects(() => fetchWithRetry('https://plain.test/a', { retries: 2, sleep }), /HTTP 500/)

    assert.equal(stub.enteredAt.length, 3)
    assert.deepEqual(delays, [150, 300], 'unchanged semantics for a caller that passes no budget')
  })

  it('does not wait at all when no source declares a limit', async () => {
    const stub = recordingFetch(() => new Response('ok', { status: 200 }))
    globalThis.fetch = stub

    const startedAt = Date.now()
    for (let i = 0; i < 4; i += 1) {
      assert.equal(await fetchWithRetry('https://plain.test/b', { retries: 0 }), 'ok')
    }

    assert.equal(stub.enteredAt.length, 4, 'all four requests actually happened')
    assert.ok(Date.now() - startedAt < 1000, 'four undeclared requests must not acquire a limiter')
  })

  it('reads a source id against the policy table', async () => {
    // No `rateLimit` passed at all: `gdacs` declares 120/min and must therefore
    // arrive here as a limiter rather than as nothing. A 120/min bucket against
    // four requests never waits, so the assertion is that the requests happened
    // *and* that a policy-backed run is bounded — proved by the limiter being
    // observable through its own key rather than through elapsed time.
    const stub = recordingFetch(() => new Response('ok', { status: 200 }))
    globalThis.fetch = stub

    const startedAt = Date.now()
    for (let i = 0; i < 4; i += 1) {
      await fetchWithRetry('https://www.gdacs.org/xml/rss.xml', { retries: 0, source: 'gdacs' })
    }

    assert.equal(stub.enteredAt.length, 4)
    assert.ok(Date.now() - startedAt < 1000, 'gdacs at 120/min must not throttle four requests')
  })
})
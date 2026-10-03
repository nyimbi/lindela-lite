#!/usr/bin/env node
/**
 * The API cache is capped. That sentence used to be a comment.
 *
 * `pruneApiCache` had a TTL pass and then a "make up the shortfall" pass whose
 * loop bound was `remaining - API_MAX_ENTRIES`, where `remaining` was
 * `keys.length - excess` and `excess` was `keys.length - API_MAX_ENTRIES`. That
 * is zero, always, for any input — so the fallback loop had a bound of zero,
 * ran no iterations, and the cap was enforced only against entries that had
 * already expired. A cache full of fresh entries grew without limit, which is
 * the exact failure the cap was written to prevent, in the function written to
 * prevent it.
 *
 * Nobody noticed because the function was not exported and the eviction logic
 * could not be reached without a browser, a service worker, and two hundred and
 * one live cache entries. The policy is a pure function of `{id, storedAtMs}`
 * and a clock, so it is now one, and this file is what a future edit has to
 * break.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evictionPlan } from '../public/sw.js'

const NOW = Date.parse('2026-10-03T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000
const LIMITS = { now: NOW, ttlMs: DAY, maxEntries: 200 }

/**
 * `count` entries, oldest first, a minute apart and all inside the TTL — so a
 * test about the *cap* is not accidentally a test about the TTL as well. Spacing
 * by an hour instead would put the oldest of 200 entries eight days back, well
 * past `ttlMs`, and the eviction reason would change underneath the assertion.
 */
const fresh = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `https://x/api/v1/e${i}`,
    storedAtMs: NOW - (count - i) * MINUTE,
  }))

describe('a cache under the cap is left alone', () => {
	it('evicts nothing at exactly the limit', () => {
		assert.deepEqual(evictionPlan(fresh(200), LIMITS), [])
	})

	it('evicts nothing below it', () => {
		assert.deepEqual(evictionPlan(fresh(3), LIMITS), [])
	})

	it('evicts nothing from an empty cache', () => {
		assert.deepEqual(evictionPlan([], LIMITS), [])
	})
})

describe('over the cap, the cap wins', () => {
	it('evicts the oldest, not the newest', () => {
		// This is the assertion the original function would have failed: none of
		// these entries is expired, so its TTL pass deleted nothing and its
		// fallback pass had a bound of zero.
		const plan = evictionPlan(fresh(205), LIMITS)
		assert.equal(plan.length, 5)
		assert.deepEqual(plan, [
			'https://x/api/v1/e0',
			'https://x/api/v1/e1',
			'https://x/api/v1/e2',
			'https://x/api/v1/e3',
			'https://x/api/v1/e4',
		])
	})

	it('leaves the most recent entries', () => {
		// 250 entries, 200 slots: e0..e49 go and e50..e249 stay.
		const plan = new Set(evictionPlan(fresh(250), LIMITS))
		assert.equal(plan.size, 50)
		assert.ok(plan.has('https://x/api/v1/e49'), 'the fiftieth-oldest is the last to go')
		assert.ok(!plan.has('https://x/api/v1/e50'), 'and the fiftieth-newest is the first to stay')
		assert.ok(!plan.has('https://x/api/v1/e249'), 'the newest entry is never a candidate')
	})

	it('counts the oldest entry once, even when both passes reach it', () => {
		// An expired entry is by definition old, so the first pass takes it and
		// the second pass walks onto it immediately. If the second pass spends
		// its decrement re-visiting an entry already doomed, the plan comes back
		// one short — and the cache stays one entry over its own limit on every
		// run, with nothing reporting that it did.
		const entries = [...fresh(204), { id: 'undated', storedAtMs: NaN }]
		assert.equal(entries.length, 205)
		const plan = evictionPlan(entries, LIMITS)
		assert.equal(plan.length, 5, '205 entries against a cap of 200')
		assert.equal(new Set(plan).size, 5)
	})

	it('still enforces the ceiling when the whole cache is fresh', () => {
		const entries = Array.from({ length: 1000 }, (_, i) => ({ id: `e${i}`, storedAtMs: NOW - i }))
		assert.equal(evictionPlan(entries, LIMITS).length, 800)
	})
})

describe('age is preferred, and never at the expense of the ceiling', () => {
	it('drops expired entries before fresh ones', () => {
		// Over by 10. The 60 stale entries are the cheapest thing to remove, so
		// they go first even though ten of the fresh ones are older than some of
		// them.
		const entries = [
			...fresh(150),
			...Array.from({ length: 60 }, (_, i) => ({ id: `old${i}`, storedAtMs: NOW - 10 * DAY - i })),
		]
		const plan = evictionPlan(entries, LIMITS)
		assert.equal(plan.length, 10)
		assert.equal(new Set(plan).size, 10, 'the two passes must not name the same entry twice')
		assert.ok(plan.every((id) => id.startsWith('old')),
			`expected only expired entries, got ${plan.join(',')}`)
	})

	it('falls back to oldest-first when age alone does not free enough room', () => {
		// 250 entries, 50 over, and only 3 past the TTL. Three come out cheap;
		// the other 47 have to come out of the fresh set.
		const entries = [
			...fresh(247),
			...Array.from({ length: 3 }, (_, i) => ({ id: `old${i}`, storedAtMs: NOW - 10 * DAY - i })),
		]
		const plan = evictionPlan(entries, LIMITS)
		assert.equal(plan.length, 50)
		// old2 is the oldest of the three — `storedAtMs: NOW - 10*DAY - i` gets
		// older as i rises.
		assert.deepEqual(plan.slice(0, 3), ['old2', 'old1', 'old0'], 'expired entries go in the first pass')
		assert.equal(new Set(plan).size, 50, 'the fallback pass re-walks the list the first pass used')
		assert.ok(plan.includes('https://x/api/v1/e0'), 'and the ceiling is still met by dropping fresh ones')
	})

	it('treats an unstamped entry as the oldest thing in the cache', () => {
		// `NaN` from an unparseable date is not comparable, so sorting on it
		// leaves the entry wherever the engine happens to put it. An entry with
		// no date is older than every dated entry, and the sort key says so.
		const entries = [...fresh(204), { id: 'undated', storedAtMs: NaN }]
		const plan = evictionPlan(entries, LIMITS)
		assert.equal(plan[0], 'undated')
		assert.ok(plan.includes('https://x/api/v1/e0'), 'and eviction continues into the dated entries')
	})
})

describe('the boundaries', () => {
	it('keeps an entry at exactly the TTL', () => {
		// Under the cap, so age is the only thing that could evict it. An entry
		// exactly `ttlMs` old has not yet expired, and `>` rather than `>=` is
		// what says so.
		const entries = [...fresh(199), { id: 'exact', storedAtMs: NOW - DAY }]
		assert.equal(entries.length, 200)
		assert.deepEqual(evictionPlan(entries, LIMITS), [])
	})

	it('expires one millisecond past it', () => {
		// 200 fresh plus one stale, so the cache is over the cap by exactly one
		// and the only entry that can be removed on age grounds is `past`.
		const entries = [...fresh(200), { id: 'past', storedAtMs: NOW - DAY - 1 }]
		assert.deepEqual(evictionPlan(entries, LIMITS), ['past'])
	})

	it('evicts an entry at the TTL only because it is oldest, not because it expired', () => {
		// Both statements are true at once and the test has to say which one it is
		// checking: over the cap, the oldest entry goes regardless of age.
		const entries = [...fresh(200), { id: 'exact', storedAtMs: NOW - DAY }]
		assert.deepEqual(evictionPlan(entries, LIMITS), ['exact'])
	})

	it('does not evict an entry dated in the future', () => {
		// A clock that jumped backwards mid-write. It is the newest thing in the
		// cache, so oldest-first eviction will never reach it — which is the right
		// outcome without needing a special case.
		const entries = [...fresh(205), { id: 'future', storedAtMs: NOW + DAY }]
		assert.ok(!evictionPlan(entries, LIMITS).includes('future'))
	})
})
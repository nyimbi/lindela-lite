import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { directoryEntry, ENTRY_PATHS, SURFACES } from '../public/sw.js'

/**
 * R-60's neighbour, found by the browser tier's first cold-profile run.
 *
 * The service worker precaches `ENTRY_PATHS` — `/chw/index.html` — because that
 * is the file the import graph reads references out of. A browser navigates to
 * `/chw/`. The offline lookup tried the exact URL, then `ignoreSearch`, and
 * `ignoreSearch` bridges a query string and nothing else. So on a fresh install
 * with no signal, `/chw/` missed the precache entirely and `codeFirst` answered
 * with its JSON miss body — which the browser then rendered *as the document*:
 * a blank page reading `{"error":"unavailable-offline",…}` where the report
 * wizard should be. The round-trip drill reported it as "the shell rendered 291
 * chars with no wizard", and the screenshot is that JSON, rendered.
 *
 * It had passed for as long as it existed because the only machine that ran the
 * drill had a warm profile: Chrome's HTTP cache held `/chw/` from an earlier
 * online load, so the exact match hit and the precache was never consulted. A
 * first-time install is every real deployment, so the defect was live and the
 * instrument was blind to it — the same shape as every other finding in this
 * repository's register.
 *
 * The properties that matter, and the two that are easy to get wrong:
 *
 *   - **a directory navigation finds its index.** The defect, asserted at the
 *     level it lives at, with no browser.
 *   - **a module fetch does not.** Answering `/chw/app.js` with the page would
 *     turn a missing module into an HTML-as-JavaScript syntax error, reported
 *     somewhere far from the cause.
 *   - **a non-navigation does not.** `fetch('/chw/')` from a page is not a
 *     document load and must keep its own answer.
 */

/** A cache double over a plain path→body map. */
function fakeCache(entries) {
	const map = new Map(Object.entries(entries))
	const asked = []
	return {
		asked,
		async match(request, options = {}) {
			const key = typeof request === 'string' ? request : request.url
			asked.push({ key, ignoreSearch: Boolean(options.ignoreSearch) })
			if (options.ignoreSearch) {
				const path = new URL(key).pathname
				for (const [k, v] of map) if (new URL(k).pathname === path) return v
				return undefined
			}
			return map.get(key)
		},
	}
}

const navigate = (url) => ({ url, mode: 'navigate' })

describe('R-60 — a directory navigation resolves to the precached index', () => {
	it('answers /chw/ with the precached /chw/index.html', async () => {
		const cache = fakeCache({ 'https://app.test/chw/index.html': 'THE WIZARD' })
		const hit = await directoryEntry(cache, navigate('https://app.test/chw/?cold=1'))
		assert.equal(hit, 'THE WIZARD',
			'a navigation to /chw/ that finds nothing is served the JSON miss body as its document')
	})

	it('answers the console root the same way', async () => {
		// `/` is the one surface whose entry path is `/index.html` — the
		// `.replace(/^index\.html$/, '/index.html')` in `ENTRY_PATHS` — so a
		// directory fallback that appended blindly would ask for `//index.html`.
		const cache = fakeCache({ 'https://app.test/index.html': 'THE CONSOLE' })
		const hit = await directoryEntry(cache, navigate('https://app.test/'))
		assert.equal(hit, 'THE CONSOLE')
	})

	it('covers every surface the worker precaches', async () => {
		// Asserted over `SURFACES` rather than a literal, so a ninth surface
		// cannot be added to the precache and left without the offline entry.
		for (const surface of SURFACES) {
			const dir = surface === '' ? '/' : surface
			const entry = `${surface}index.html`.replace(/^index\.html$/, '/index.html')
			const cache = fakeCache({ [`https://app.test${entry}`]: `BODY ${dir}` })
			const hit = await directoryEntry(cache, navigate(`https://app.test${dir}?cold=1`))
			assert.equal(hit, `BODY ${dir}`, `${dir} must resolve to ${entry}`)
		}
		assert.deepEqual(ENTRY_PATHS.length, SURFACES.length)
	})

	it('does not answer a module fetch with the page', async () => {
		// The dangerous over-reach. `/chw/app.js` missing must stay missing: the
		// caller has an explicit miss body for a module and none for HTML.
		const cache = fakeCache({ 'https://app.test/chw/index.html': 'THE WIZARD' })
		assert.equal(await directoryEntry(cache, { url: 'https://app.test/chw/app.js', mode: 'cors' }), undefined)
		assert.equal(await directoryEntry(cache, { url: 'https://app.test/chw/', mode: 'cors' }), undefined,
			'a non-navigation is not a document load')
	})

	it('does not append index.html to a file path', async () => {
		const cache = fakeCache({ 'https://app.test/chw/app.js/index.html': 'WRONG' })
		assert.equal(await directoryEntry(cache, navigate('https://app.test/chw/app.js')), undefined)
	})

	it('returns nothing rather than throwing when the surface is not precached', async () => {
		// The caller falls through to the miss body, which is the honest answer.
		const cache = fakeCache({})
		assert.equal(await directoryEntry(cache, navigate('https://app.test/nope/')), undefined)
	})
})

/**
 * The wiring, which is the half that can silently not happen.
 *
 * The first draft of this file tested `directoryEntry` on its own, and the
 * canary — deleting the call from `codeFirst` — passed 6/6. A helper that works
 * and is never called is exactly the defect this repository keeps finding
 * ("a control that exists is not a control that is applied"), and a test that
 * exercises the helper alone cannot see it. So this drives `codeFirst` itself,
 * with the network failing, and asserts the document that comes back.
 */
describe('R-60 — codeFirst uses it, so an offline navigation gets the document', () => {
	/** Install the globals `codeFirst` reads, run the body, restore them. */
	async function withWorkerGlobals(entries, fn) {
		const cache = fakeCache(entries)
		const saved = { caches: globalThis.caches, fetch: globalThis.fetch }
		globalThis.caches = { open: async () => cache }
		globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
		try {
			return await fn(cache)
		} finally {
			globalThis.caches = saved.caches
			globalThis.fetch = saved.fetch
		}
	}

	it('serves the precached document to a navigation with no network', async () => {
		const { codeFirst } = await import('../public/sw.js')
		const request = { url: 'https://app.test/chw/?cold=1', mode: 'navigate' }
		const response = await withWorkerGlobals(
			{ 'https://app.test/chw/index.html': 'THE WIZARD' },
			() => codeFirst({ request }, new URL(request.url)),
		)
		assert.equal(response, 'THE WIZARD',
			'without the directory lookup this returns the JSON miss body, which the browser renders as the page')
	})

	it('still answers a miss with the honest JSON body, not a page', async () => {
		// The fallback must survive: a surface that was never precached is a
		// real miss and says so in a field, rather than pretending to be HTML.
		const { codeFirst } = await import('../public/sw.js')
		const request = { url: 'https://app.test/nope/?cold=1', mode: 'navigate' }
		const response = await withWorkerGlobals({}, () => codeFirst({ request }, new URL(request.url)))
		assert.equal(response.status, 503)
		assert.equal((await response.json()).kind, 'static-miss')
	})
})

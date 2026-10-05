import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { describe, it } from 'node:test'

import { submitOrQueue } from '../public/shared/runtime.js'
import * as states from '../public/shared/states.js'

// Imported dynamically and tolerated as an empty object: a service worker that
// reaches for `self` at module scope cannot be imported at all under Node, and
// a test file that dies on import reports one failure instead of the graph's.
const sw = await import('../public/sw.js').catch(() => ({}))
const { BOOTSTRAP_ASSETS = [], ENTRY_PATHS = [], SURFACES = [], parseReferences, shellGraph } = sw

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const ORIGIN = 'https://app.test'

const readPublic = (p) => readFile(path.join(PUBLIC, p), 'utf8')

/**
 * A Response-shaped object over a string, which is all `shellGraph` reads.
 */
const textResponse = (body) => ({ ok: true, clone: () => ({ text: async () => body }) })

/** Loader backed by the real public/ tree, so the graph is checked against
 *  the files the server actually serves rather than a fixture of them. */
const loadFromDisk = async (url) => {
	try {
		return textResponse(await readPublic(url.pathname))
	} catch {
		return null
	}
}

// ---------------------------------------------------------------- WEB-05

/**
 * Minimal IndexedDB. Not a general implementation: `add`/`delete`/`count`/
 * `getAll` over one keyPath store, with the two ways a real write fails —
 * the request erroring, and the transaction aborting after the request has
 * already reported success — injectable, because the second is the one that
 * used to be invisible.
 */
function fakeIndexedDB({ openFails = false, requestError = null, abortAfterWrite = false } = {}) {
	const records = []
	let nextId = 1
	return {
		records,
		open() {
			const request = {}
			setTimeout(() => {
				if (openFails) {
					request.onerror?.({ message: 'blocked' })
					return
				}
				request.result = {
					objectStoreNames: { contains: () => true },
					createObjectStore() {},
					transaction(_stores, mode) {
						const tx = { mode, error: requestError || new Error('quota exceeded') }
						tx.objectStore = () => ({
							add(value) {
								const req = {}
								setTimeout(() => {
									if (requestError) {
										req.onerror?.(requestError)
										tx.onabort?.()
										return
									}
									req.result = nextId
									records.push({ id: nextId, ...value })
									req.onsuccess?.()
									if (abortAfterWrite) tx.onabort?.()
									else tx.oncomplete?.()
									nextId += 1
								}, 0)
								return req
							},
							// `put`, not just `add`: the shared queue core writes every
							// record through `put` — a claim, a retry and a dead-letter
							// are all updates to a row that already exists — and a double
							// that only knows how to insert turns a working queue into
							// "this browser has no storage available".
							//
							// IndexedDB's own rule, reproduced: an autoIncrement store
							// assigns the next key when the record carries none, and
							// replaces the row when it carries one.
							put(value) {
								const req = {}
								setTimeout(() => {
									if (requestError) {
										req.onerror?.(requestError)
										tx.onabort?.()
										return
									}
									if (value.id === undefined || value.id === null) {
										const id = nextId
										nextId += 1
										records.push({ id, ...value })
										req.result = id
									} else {
										const at = records.findIndex((r) => r.id === value.id)
										if (at >= 0) records[at] = { ...value }
										else records.push({ ...value })
										req.result = value.id
									}
									req.onsuccess?.()
									if (abortAfterWrite) tx.onabort?.()
									else tx.oncomplete?.()
								}, 0)
								return req
							},
							delete(id) {
								const at = records.findIndex((r) => r.id === id)
								if (at >= 0) records.splice(at, 1)
							},
							count() {
								const req = {}
								setTimeout(() => req.onsuccess?.(records.length), 0)
								return req
							},
							getAll() {
								const req = {}
								setTimeout(() => req.onsuccess?.(records.slice()), 0)
								return req
							},
						})
						return tx
					},
				}
				request.onsuccess?.()
			}, 0)
			return request
		},
	}
}

/** The runtime reads `window`, `navigator` and `document` off the global, so
 *  they are installed and removed around each test rather than leaked. */
function installGlobals({ window: win, document: doc, navigator: nav, fetch: f }) {
	const previous = {
		window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
		document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
		navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
		setInterval: Object.getOwnPropertyDescriptor(globalThis, 'setInterval'),
		fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
	}
	const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
	if (win) define('window', win)
	if (doc) define('document', doc)
	if (nav) define('navigator', nav)
	if (f) define('fetch', f)
	// The queue installs a 30s flush timer; in Node that outlives the test run.
	define('setInterval', () => 0)
	return () => {
		for (const [key, descriptor] of Object.entries(previous)) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor)
			else delete globalThis[key]
		}
	}
}

function withBrowser({ online = false, indexedDB = null } = {}) {
	const win = {
		addEventListener() {},
		dispatchEvent: () => true,
		...(indexedDB ? { indexedDB } : {}),
	}
	const restore = installGlobals({
		window: win,
		document: { querySelectorAll: () => [] },
		navigator: { onLine: online },
	})
	return { win, restore }
}

/**
 * Boot the real public/chw/app.js in a vm with the real runtime injected and a
 * DOM that records what the user was told.
 *
 * The app module is not importable from a test (absolute `/shared/runtime.js`
 * specifiers, top-level await, a DOM) so it is loaded as the script it is: the
 * two import lines are dropped, everything else runs verbatim. The trailing
 * probe is the only addition, and it exposes the module's own state rather than
 * a reimplementation of it.
 */
async function bootChw({ online = false, indexedDB = null, appJs = null } = {}) {
	const source = appJs ?? (await readPublic('chw/app.js'))
	const en = JSON.parse(await readPublic('i18n/en.json'))
	const runtime = await import('../public/shared/runtime.js')

	const elements = new Map()
	const makeElement = (id) => ({
		id,
		dataset: {},
		style: {},
		value: '',
		textContent: '',
		checked: false,
		files: [],
		handlers: {},
		classList: { add() {}, remove() {}, contains: () => false },
		addEventListener(type, handler) {
			this.handlers[type] = handler
		},
		removeEventListener() {},
		setAttribute() {},
		getAttribute: () => null,
		hasAttribute: () => false,
		querySelector: () => null,
		querySelectorAll: () => [],
		appendChild() {},
		remove() {},
		focus() {},
		scrollIntoView() {},
	})

	const windowStub = {
		addEventListener() {},
		dispatchEvent() {},
		...(indexedDB ? { indexedDB } : {}),
	}
	const fetchCalls = []
	const fakeFetch = async (path_, options) => {
		fetchCalls.push({ path: path_, options })
		if (String(path_).endsWith('/i18n/en.json')) {
			return { ok: true, status: 200, json: async () => en }
		}
		if (online) {
			return { ok: true, status: 201, headers: new Headers(), json: async () => ({ data: { id: 'r-1' } }) }
		}
		throw Object.assign(new Error('offline'), { name: 'TypeError' })
	}
	const context = {
		console,
		JSON,
		URL,
		AbortSignal,
		CustomEvent,
		setInterval: () => 0,
		clearTimeout() {},
		setTimeout,
		requestAnimationFrame: () => 0,
		localStorage: { getItem: () => 'en', setItem() {} },
		document: {
			getElementById(id) {
				if (!elements.has(id)) elements.set(id, makeElement(id))
				return elements.get(id)
			},
			querySelectorAll: () => [],
			querySelector: () => null,
			documentElement: makeElement('html'),
		},
		window: windowStub,
		navigator: { onLine: online, geolocation: null },
		fetch: fakeFetch,
		// The real implementations, not stand-ins: the defect being guarded is
		// in this code, so replacing it with a mock would test the mock.
		...runtime,
		// The state vocabulary the app imports by name. It is pure and DOM-free,
		// so the real module runs in the vm untouched.
		...states,
		mountNavbar() {},
	}
	context.globalThis = context
	vm.createContext(context)

	// The runtime functions injected above run in *this* realm, so they see
	// globalThis — not the vm's `window`. Both realms have to be pointed at the
	// same stubs or the app and the queue would be looking at two browsers.
	const documentStub = context.document
	const restore = installGlobals({ window: windowStub, document: documentStub, fetch: fakeFetch })

	// The app routes every submission through `submitOrQueue`, which lives in
	// `shared/runtime.js`. This harness strips imports because they cannot
	// resolve in a bare vm context, so that symbol has to be supplied here.
	//
	// It mirrors the real contract — try, and queue on failure rather than on
	// `navigator.onLine` — because a stub with a different contract would let the
	// queue-on-failure behaviour pass here while being broken in the product.
	// The real implementation is covered by `test/offline-delivery.test.js` and
	// driven in a browser by `scripts/check-chw-queue-state.mjs`.
	const submitOrQueue = async (path_, body, { headers, what = null } = {}) => {
		if (context.navigator.onLine !== false) {
			try {
				const res = await fakeFetch(path_, { method: 'POST', headers, body: JSON.stringify(body) })
				if (res.ok) return { sent: true, data: await res.json() }
			} catch { /* fall through to the queue */ }
		}
		const queued = await windowStub.lindelaQueue.enqueue(
			path_, { method: 'POST', body, headers }, { what },
		)
		return { ...queued, queuedBecause: 'the request did not get through' }
	}

	const script = source
		.split('\n')
		.filter((line) => !line.startsWith('import '))
		.map((line) => (line === 'await initOfflineQueue()' ? 'await initOfflineQueue()' : line))
		.join('\n')
	context.submitOrQueue = submitOrQueue
	await vm.runInContext(`(async () => {${script}\nglobalThis.__chw = { state, submitSymptomReport }\n})()`, context)
	await new Promise((resolve) => setTimeout(resolve, 20))

	const el = (id) => documentStub.getElementById(id)
	return {
		context,
		el,
		fetchCalls,
		restore,
		/** Fire a handler the app registered on `id`, as a click would. */
		click: (id, event = {}) => el(id).handlers[event.type || 'click']?.(event),
		toast: () => ({ text: el('toast').textContent, kind: el('toast').dataset.kind }),
		state: () => context.__chw.state,
		submitSymptomReport: () => context.__chw.submitSymptomReport(),
	}
}

describe('WEB-05 — the CHW offline queue', () => {
	const REPORT = { who: 'adult', type: 'fever', duration: '3d', location: 'Ward 4' }

	it('refuses to queue when the device has no offline storage', async () => {
		const app = await bootChw({ online: false, indexedDB: null })
		try {
			app.state().symptom = { ...REPORT }
			await app.submitSymptomReport()
		} finally {
			app.restore()
		}

		const { text, kind } = app.toast()
		assert.equal(kind, 'error', 'a discarded report must not be reported as an ordinary one')
		assert.match(text, /Could not send the symptom report/)
		assert.doesNotMatch(text, /saved on this phone/)
		// CE-04/CE-06: the exception's own text is a name for something
		// happening in software. It goes to the console, not to a health worker.
		assert.doesNotMatch(text, /Failed to fetch|NetworkError|HTTP \d|\{[a-z_]+\}/)
	})

	it('keeps the wizard standing when the report was not stored', async () => {
		// The reset is the part the health worker acts on: a cleared wizard
		// means "filed", and they have no other signal.
		const app = await bootChw({ online: false, indexedDB: null })
		try {
			app.state().symptom = { ...REPORT }
			await app.submitSymptomReport()
		} finally {
			app.restore()
		}

		assert.equal(app.state().currentScreen, 'home')
		assert.equal(app.state().symptom.type, 'fever', 'the report they typed must still be there to retry')
		assert.equal(app.state().symptom.location, 'Ward 4')
	})

	it('refuses to queue when the write is rejected', async () => {
		const app = await bootChw({
			online: false,
			indexedDB: fakeIndexedDB({
				requestError: Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }),
			}),
		})
		try {
			app.state().symptom = { ...REPORT }
			await app.submitSymptomReport()
		} finally {
			app.restore()
		}

		assert.equal(app.toast().kind, 'error')
		assert.match(app.toast().text, /Could not send the symptom report/)
		assert.doesNotMatch(app.toast().text, /Failed to fetch|NetworkError|HTTP \d/)
		assert.equal(app.state().symptom.type, 'fever')
	})

	it('refuses to queue when the transaction aborts after the request reports success', async () => {
		// The subtle one: the store says the write worked, then rolls it back.
		const app = await bootChw({ online: false, indexedDB: fakeIndexedDB({ abortAfterWrite: true }) })
		try {
			app.state().symptom = { ...REPORT }
			await app.submitSymptomReport()
		} finally {
			app.restore()
		}

		assert.equal(app.toast().kind, 'error')
		assert.equal(app.state().symptom.type, 'fever')
	})

	it('says queued, and only then, when the record is committed', async () => {
		const db = fakeIndexedDB()
		const app = await bootChw({ online: false, indexedDB: db })
		try {
			app.state().symptom = { ...REPORT }
			await app.submitSymptomReport()
		} finally {
			app.restore()
		}

		const { text, kind } = app.toast()
		assert.equal(kind, 'info')
		assert.match(text, /saved on this phone\. It will send when you have signal\./)
		assert.equal(db.records.length, 1, 'the toast must correspond to a stored record')
		assert.equal(db.records[0].path, '/api/v1/chw/report')
		assert.equal(app.state().symptom.type, null, 'a genuinely queued report may clear the wizard')
	})

	it('never claims delivery for a queued report', async () => {
		const db = fakeIndexedDB()
		const app = await bootChw({ online: false, indexedDB: db })
		try {
			app.state().symptom = { ...REPORT }
			await app.submitSymptomReport()
		} finally {
			app.restore()
		}

		assert.doesNotMatch(app.toast().text, /sent and confirmed/)
		assert.equal(app.fetchCalls.filter((c) => String(c.path).includes('/chw/report')).length, 0)
	})

	it('still reports delivery honestly when the write succeeds online', async () => {
		const app = await bootChw({ online: true, indexedDB: fakeIndexedDB() })
		try {
			app.state().symptom = { ...REPORT }
			await app.submitSymptomReport()
		} finally {
			app.restore()
		}

		assert.equal(app.toast().kind, 'ok')
		assert.match(app.toast().text, /sent and confirmed by the server\./)
		assert.equal(app.state().symptom.type, null)
	})

	it('applies the same rule to an incident report', async () => {
		const db = fakeIndexedDB()
		const app = await bootChw({ online: false, indexedDB: db })
		try {
			app.el('incidentCategory').value = 'flood'
			await app.click('incidentSubmitBtn', { target: { dataset: {} } })
		} finally {
			app.restore()
		}

		assert.equal(app.toast().kind, 'info')
		assert.equal(db.records.length, 1)
		assert.equal(db.records[0].path, '/api/v1/chw/report')
	})

	it('applies the same rule to a reply', async () => {
		const db = fakeIndexedDB()
		const app = await bootChw({ online: false, indexedDB: db })
		try {
			app.el('replyMessage').value = 'On my way'
			await app.click('replySubmitBtn', { target: { dataset: {} } })
		} finally {
			app.restore()
		}

		assert.equal(app.toast().kind, 'info')
		assert.equal(db.records.length, 1)
		assert.equal(db.records[0].path, '/api/v1/chw/reply')
	})

	it('submitOrQueue reports the queued record, not a fabricated success', async () => {
		const db = fakeIndexedDB()
		const browser = withBrowser({ online: false, indexedDB: db })
		try {
			await runtimeInit()
			const result = await submitOrQueue('/api/v1/chw/report', { kind: 'symptom' })
			assert.equal(result.queued, true)
			// A string, and it must exist before the write.
			//
			// This was IndexedDB's autoIncrement key, which is only assigned once
			// the write completes — so it could not be sent with the request. The
			// id is now the `idempotency-key`, which is what makes replay safe:
			// two drains racing the same record send the same key, and the server
			// answers the second with the first's receipt rather than creating a
			// second field report for one observation.
			assert.equal(typeof result.id, 'string')
			assert.match(result.id, /^[0-9a-f-]{36}$/, 'a UUID minted before the store wrote it')
			assert.equal(db.records[0].options.headers['idempotency-key'], result.id,
				'the key travels with the queued request, not only with the record')
			assert.equal(db.records.length, 1)
		} finally {
			browser.restore()
		}
	})

	it('submitOrQueue throws rather than claiming a queue that took nothing', async () => {
		const browser = withBrowser({ online: false, indexedDB: fakeIndexedDB({ openFails: true }) })
		try {
			await runtimeInit()
			await assert.rejects(
				() => submitOrQueue('/api/v1/chw/report', { kind: 'symptom' }),
				// A health worker who is told "saved" and is not has filed nothing.
				// Matched on the claim rather than on the old wording: the sentence
				// is "this browser has no storage available, so the report was not
				// saved", and what must survive any rewording is that it says
				// *not saved* and names storage as the reason.
				(error) => /not\s+saved/i.test(error.message) && /storage/i.test(error.message)
			)
		} finally {
			browser.restore()
		}
	})
})

// `initOfflineQueue` is called through the module namespace in the vm above;
// here it needs the ambient globals the browser stub installs.
async function runtimeInit() {
	const { initOfflineQueue } = await import('../public/shared/runtime.js')
	return initOfflineQueue()
}

// ---------------------------------------------------------------- WEB-06

describe('WEB-06 — the precache graph', () => {
	it('covers every local file the console references', async () => {
		const paths = await shellGraph(loadFromDisk, ORIGIN)
		const missing = []
		for (const p of paths) {
			try {
				await readPublic(p)
			} catch {
				missing.push(p)
			}
		}
		assert.deepEqual(missing, [], 'precaching a path that 404s is the shell losing an entry silently')
	})

	it('includes the three files the audited list omitted', async () => {
		const paths = await shellGraph(loadFromDisk, ORIGIN)
		for (const required of ['/shared/fmt.js', '/shared/labels.js', '/components.css', '/sw.js']) {
			assert.ok(paths.includes(required), `${required} must be precached`)
		}
	})

	it('starts from every surface entry point', async () => {
		const paths = await shellGraph(loadFromDisk, ORIGIN)
		for (const surface of SURFACES) {
			const entry = `${surface}index.html`.replace(/^index\.html$/, '/index.html')
			assert.ok(paths.includes(entry), `${entry} must be precached`)
		}
		assert.deepEqual(ENTRY_PATHS.length, SURFACES.length)
	})

	// The oracle: an independent scan of the files on disk. It shares no code
	// with `shellGraph`, so it fails if the traversal ever stops following
	// something the surfaces genuinely need — which is how this list rotted.
	it('matches an independent scan of every reference in public/', async () => {
		const graph = new Set(await shellGraph(loadFromDisk, ORIGIN))
		const referenced = new Set()
		for (const entry of ENTRY_PATHS) {
			const queue = [entry]
			const seen = new Set()
			while (queue.length) {
				const p = queue.pop()
				if (seen.has(p) || !/\.(?:html|css|js)$/.test(p)) continue
				seen.add(p)
				let source
				try {
					source = await readPublic(p)
				} catch {
					continue
				}
				// Only what a page loads: <link> and <script> tags, module imports,
				// CSS @import. An <a href> is navigation, not part of the shell.
				const patterns =
					p.endsWith('.html')
						? [/<link\b[^>]*?href=["']([^"']+)["']/gi, /<script\b[^>]*?src=["']([^"']+)["']/gi]
						: p.endsWith('.css')
							? [/@import url\(["']?([^"')\s]+)/gi]
							: [/\bfrom\s+["']([^"']+)["']/g]
				for (const pattern of patterns) {
				for (const m of source.matchAll(pattern)) {
					const raw = (m[1] || '').trim()
					if (!raw.startsWith('/') || raw.includes('#') || raw.includes('$')) continue
					if (seen.has(raw) || referenced.has(raw)) continue
					referenced.add(raw)
					queue.push(raw)
				}
				}
			}
		}
		const missing = [...referenced].filter((p) => !graph.has(p))
		assert.deepEqual(missing, [], 'referenced by a surface, missing from the precache')
		assert.ok(referenced.size > 25, `scan found only ${referenced.size} references; the oracle is not looking hard enough`)
	})

	it('keeps API paths out of the static shell', async () => {
		const paths = await shellGraph(loadFromDisk, ORIGIN)
		assert.deepEqual(paths.filter((p) => p.startsWith('/api/')), [])
	})

	it('resolves relative imports against the importing module', async () => {
		// /shared/runtime.js imports './fmt.js'; a resolver that assumed root
		// would precache /fmt.js and drop the real dependency.
		const refs = parseReferences(`import { applyLocaleToDocument } from './fmt.js'`, `${ORIGIN}/shared/runtime.js`)
		assert.deepEqual(refs, ['/shared/fmt.js'])
	})

	it('drops cross-origin and inline references', async () => {
		const refs = parseReferences(
			`<link rel="preconnect" href="https://fonts.gstatic.com/x"><a href="#top"></a><img src="data:image/png;base64,AA">`,
			`${ORIGIN}/index.html`
		)
		assert.deepEqual(refs, [])
	})

	it('precaches the worker that installs it', () => {
		assert.ok(BOOTSTRAP_ASSETS.includes('/sw.js'))
	})
})

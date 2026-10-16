import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, it } from 'node:test'

import { importFrontEnd, installBrowserEnv, stubElement } from './browser-env.mjs'
import { initOfflineQueue, submitOrQueue } from '../public/shared/runtime.js'

// Imported dynamically and tolerated as an empty object: a service worker that
// reaches for `self` at module scope cannot be imported at all under Node, and
// a test file that dies on import reports one failure instead of the graph's.
const sw = await import('../public/sw.js').catch(() => ({}))
const { BOOTSTRAP_ASSETS = [], ENTRY_PATHS = [], SURFACES = [], parseReferences, shellGraph } = sw

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const ORIGIN = 'https://app.test'

/**
 * The host's own timer, captured before any environment is installed.
 *
 * `installBrowserEnv` replaces `setTimeout` with one whose handle is
 * unreferenced — the right thing for the queue's 30-second flush, which must not
 * keep the process alive, and wrong for a test awaiting a real delay: an unref'd
 * timer never holds the loop open, so `wait(20)` with nothing else pending is a
 * promise that never settles, reported as "the event loop has already resolved"
 * against every test in the file.
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis)

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
			realSetTimeout(() => {
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
								realSetTimeout(() => {
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
								realSetTimeout(() => {
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
								realSetTimeout(() => req.onsuccess?.(records.length), 0)
								return req
							},
							getAll() {
								const req = {}
								realSetTimeout(() => req.onsuccess?.(records.slice()), 0)
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

/**
 * The globals the runtime reads, installed around one test and removed after it.
 *
 * This used to be a local `installGlobals` — a second copy of what
 * `test/browser-env.mjs` provides, kept in step with it by hand (R-74). The
 * shared one is the one that knows `navigator` is a getter-only global on
 * Node 26, that the queue's 30-second flush timer must not outlive the run, and
 * that a test file which leaves its stubs in place fails as an unrelated file
 * further down the suite.
 */
function withBrowser({ online = false, indexedDB = null } = {}) {
	return installBrowserEnv({ online, indexedDB })
}

/**
 * Boot the real public/chw/app.js, with the real runtime under it, against a DOM
 * that records what the user was told.
 *
 * This used to run the file as a *script*: `vm.runInContext` over the source with
 * every `import ` line stripped out, the runtime's exports and the state and
 * form vocabularies spread onto the context by hand, and `submitOrQueue`
 * reimplemented locally — because a bare vm context has no module resolver, so
 * the symbol the app imports by name had to be supplied, and the copy that was
 * supplied was written by whoever wrote this file (R-73/R-74).
 *
 * That substitution is the reason to import instead. `submitOrQueue` decides
 * *whether a report was saved*, and this test asserts what the health worker was
 * told — so a local copy with a slightly different contract lets the product
 * break while the test stays green. It is the real function now, and it is real
 * all the way down: `apiFetch` with its timeout and its `res.ok` check, the
 * queue core's `enqueue` that throws rather than resolving on a write that took
 * nothing.
 *
 * The DOM stub is not a mock of the app either; it is a DOM. It is the app's
 * behaviour under test, and the alternative — asserting on source text — cannot
 * tell a handler that refuses from one that reads as if it refuses.
 */
async function bootChw({ online = false, indexedDB = null } = {}) {
	const en = JSON.parse(await readPublic('i18n/en.json'))
	const fetchCalls = []
	// Body-shaped, because the harness builds the response around it: `ok`,
	// `status`, `json` and `text`. A responder that returned a response-shaped
	// object would be handing it a body of `{ ok, status, json }` and every read
	// would answer `undefined` — a served catalogue that never arrives, which is
	// indistinguishable from a deployment that serves none.
	const fakeFetch = (path_, options) => {
		fetchCalls.push({ path: path_, options })
		if (String(path_).endsWith('/i18n/en.json')) return { body: en }
		// Offline, the request does not get through — which is a *thrown* fetch in
		// a browser, and is what `submitOrQueue` catches and queues on. Not a
		// status: a 503 arrives as a response, and `apiFetch` turns it into an
		// error the caller can read, which is a different path through the code
		// and a different thing to be honest about.
		if (!online) throw Object.assign(new Error('offline'), { name: 'TypeError' })
		return { status: 201, body: { data: { id: 'r-1' } } }
	}

	// A fresh module per boot, and a fresh environment under it: the app holds
	// `state`, `activeForm` and `window.lindelaQueue` at module scope, and eleven
	// boots share one file.
	const bootOptions = { online, indexedDB, respond: (url, init) => fakeFetch(url, init) }
	const env = installBrowserEnv(bootOptions)
	const mod = await importFrontEnd('chw/app.js', { env, fresh: true })
	// The module's own boot (`await init()`) settles inside the import; this is
	// for the two things it starts and does not await — the served-form read and
	// the queue's first flush. A macrotask, so both have run.
	await new Promise((resolve) => realSetTimeout(resolve, 20))

	// Elements the app reaches for by id, created on the shared map so a test
	// that sets a value on one is setting it on the element the app reads.
	for (const id of ['incidentCategory', 'incidentDescription', 'incidentPhoto', 'replyMessage',
		'incidentManualLat', 'incidentManualLon', 'alertText', 'toast', 'queueStatus']) {
		env.getElementById(id)
	}

	const el = (id) => env.getElementById(id)
	return {
		/** The wizard's own surface, exported by the module — not a probe. */
		wizard: mod.wizard,
		el,
		fetchCalls,
		restore: env.restore,
		/** Fire the handler the app registered on `id`, as a click would. */
		click: (id, event = {}) => el(id).listeners(event.type || 'click')[0]?.({ target: el(id), ...event }),
		toast: () => ({ text: el('toast').textContent, kind: el('toast').dataset.kind }),
		state: () => mod.wizard.state,
		submitSymptomReport: () => mod.wizard.submitSymptomReport(),
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

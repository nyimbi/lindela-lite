#!/usr/bin/env node
/**
 * Four audit findings on the field app, driven through the real module.
 *
 * CW-05, CW-12, CW-14 and HX-09 all have the same shape: a control on the
 * health worker's phone did something other than what it said, and nothing on
 * the screen let anyone tell. `Auto-detect` produced no output at all. `Here`
 * wrote `latitude: null` while claiming a location. `How long has it been?`
 * offered a unit with no number, so a two-day fever and a twenty-day fever were
 * the same record. `Next` blocked silently. And every step of a five-step wizard
 * was titled "Report symptom", with four dots for five screens.
 *
 * The module is imported, not executed as text. It used to be the other way:
 * every `import ` line stripped out, the remainder run in a `vm`, and a
 * hand-appended probe naming thirteen private locals (R-73/R-74). That reads
 * the file as a string, so a rename broke the test with a `ReferenceError` from
 * inside a template literal rather than a compile error, and the same surgery
 * was copy-pasted into a second test file and drifted. `public/chw/app.js`
 * exports its own surface now, and the harness in `test/browser-env.mjs`
 * supplies the DOM.
 *
 * The DOM stub is not a mock of the app; it is a DOM. It is the app's
 * behaviour that is under test, and the alternative — asserting on source text
 * — cannot tell a handler that refuses from one that merely reads as if it
 * refuses.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

import { importFrontEnd, installBrowserEnv } from './browser-env.mjs'

/**
 * Every boot installs a fresh browser environment, and a fresh module URL, so
 * no test measures the previous one's DOM or module state. The environment is
 * torn down after each test; a test that leaves the stubs in place makes the
 * next file in the suite run against them.
 */
const booted = []
afterEach(() => {
	while (booted.length) booted.pop().restore()
})

const ROOT = path.join(import.meta.dirname, '..')
/**
 * The host's own timer, captured before any environment is installed.
 *
 * `installBrowserEnv` replaces `setTimeout` with one whose handle is
 * unreferenced — the right thing for the console's self-rescheduling poll, and
 * wrong for a test that awaits a real delay: an unref'd timer never keeps the
 * loop alive, so `wait(20)` with nothing else pending is a promise that never
 * settles, reported as "the event loop has already resolved".
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
// ENH-38. The shared form vocabulary, for the cases that assert the wizard
// adopts a served definition rather than the one it was compiled with.
const forms = await import(path.join(ROOT, 'public/shared/forms.js'))
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ---------------------------------------------------------------
// A DOM small enough to read and large enough to be honest
// ---------------------------------------------------------------

function makeElement(tag = 'div', id = '') {
	const el = {
		tagName: tag.toUpperCase(),
		id,
		dataset: {},
		attrs: {},
		style: {},
		value: '',
		textContent: '',
		innerHTML: '',
		checked: false,
		files: [],
		hidden: false,
		disabled: false,
		classes: new Set(),
		children: [],
		parentNode: null,
		listeners: {},
		classList: {
			add(...c) { for (const x of c) el.classes.add(x) },
			remove(...c) { for (const x of c) el.classes.delete(x) },
			toggle(c, on) { if (on === undefined ? el.classes.has(c) : !on) el.classes.delete(c); else el.classes.add(c) },
			contains: (c) => el.classes.has(c),
		},
		setAttribute(k, v) { el.attrs[k] = String(v) },
		removeAttribute(k) { delete el.attrs[k] },
		getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
		hasAttribute: (k) => k in el.attrs,
		get firstChild() { return el.children[0] ?? null },
		get className() { return [...el.classes].join(' ') },
		set className(value) {
			el.classes.clear()
			for (const name of String(value).split(/\s+/).filter(Boolean)) el.classes.add(name)
		},
		appendChild(child) {
			if (child && child.parentNode && child.parentNode !== el) {
				const at = child.parentNode.children.indexOf(child)
				if (at !== -1) child.parentNode.children.splice(at, 1)
			}
			if (child) child.parentNode = el
			el.children.push(child)
			return child
		},
		append(...c) { for (const child of c) el.appendChild(child) },
		insertBefore(child, before) {
			const at = el.children.indexOf(before)
			if (child) child.parentNode = el
			if (at === -1) el.children.push(child)
			else el.children.splice(at, 0, child)
			return child
		},
		remove() {
			if (el.parentNode) {
				const at = el.parentNode.children.indexOf(el)
				if (at !== -1) el.parentNode.children.splice(at, 1)
			}
		},
		addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn) },
		removeEventListener() {},
		focus() {},
		scrollIntoView() {},
		querySelector: (sel) => el.querySelectorAll(sel)[0] ?? null,
		querySelectorAll(sel) { return walk(el).filter((node) => matches(node, sel)) },
		click(event = {}) { for (const fn of el.listeners.click || []) fn({ target: el, ...event }) },
	}
	return el
}

/** Every element at or beneath `el`, depth first. */
function walk(el) {
	const out = []
	const visit = (node) => {
		for (const child of node.children || []) {
			if (!child || typeof child !== 'object' || !child.children) continue
			out.push(child)
			visit(child)
		}
	}
	visit(el)
	return out
}

/**
 * A selector small enough to read and complete enough to be honest: the
 * attribute forms the renderer and the reader use (`[hook]`, `[hook="v"]`,
 * `[data-geopoint-part="latitude"]`), a class, and `#id`. The app's own
 * `document.querySelectorAll` still handles the hand-written wizard's sweeps.
 */
function matches(node, sel) {
	sel = sel.trim()
	if (sel.startsWith('#')) return node.id === sel.slice(1)
	if (sel.startsWith('.')) return node.classes.has(sel.slice(1))
	const attr = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel)
	if (attr) {
		const [, name, value] = attr
		if (!(name in node.attrs)) return false
		return value === undefined || node.attrs[name] === value
	}
	return false
}

/**
 * Boot the real module against a DOM whose buttons carry the same
 * `data-*` hooks the real index.html puts on them.
 */
async function bootChw({ geolocation = null, servedForm } = {}) {
	const en = JSON.parse(read('public/i18n/en.json'))
	const forms = await import(path.join(ROOT, 'public/shared/forms.js'))

	const HEADINGS = {
		home: 'Health Report',
		symptom: 'Who has this symptom?',
		symptomType: 'Which symptom?',
		symptomDuration: 'How long has it been?',
		symptomLocation: 'Where is the person?',
		symptomAboutWho: 'About the patient',
		incident: 'Report incident',
		reply: 'Reply to alert',
	}
	const byId = new Map()
	const screens = ['home', 'symptom', 'symptomType', 'symptomDuration', 'symptomLocation',
		'symptomAboutWho', 'incident', 'reply'].map((name) => {
		const el = makeElement('div', `${name}Screen`)
		el.classes.add('screen')
		if (name === 'home') el.classes.add('active')
		// Every screen has a heading, and showScreen both focuses it and
		// announces it — the announcement is where the step number is delivered
		// to anyone not looking at the screen.
		const heading = makeElement('h2')
		heading.textContent = HEADINGS[name]
		el.querySelector = (sel) => (sel === '.screen-title' ? heading : null)
		byId.set(el.id, el)
		return { name, el }
	})

	// ENH-38. The mount point a served definition is rendered into. The built-in
	// screens are appended to it, the same as in the real markup, so the app's
	// document-wide sweeps (`[data-symptom-who]`, `#severityChecklist …`) find
	// them.
	const wizardEl = makeElement('div', 'symptomWizard')
	for (const { el } of screens) wizardEl.appendChild(el)
	byId.set('symptomWizard', wizardEl)

	const getById = (id) => {
		if (byId.has(id)) return byId.get(id)
		// A served definition's screens and buttons are created by the renderer,
		// not by this stub, so an id the app assigned directly (`screen.id = …`)
		// is found by walking what the renderer built.
		const rendered = walk(wizardEl).find((node) => node.id === id)
		if (rendered) { byId.set(id, rendered); return rendered }
		byId.set(id, makeElement('div', id))
		return byId.get(id)
	}

	// One element per (attribute, value) pair, created once and then reused, so
	// a handler the module attached to "the hours button" is still there when
	// the test clicks it — as it is in a browser, where there is one such button.
	const BUTTONS = {
		'data-symptom-who': ['self', 'child', 'other'],
		'data-symptom-type': ['fever', 'cough', 'diarrhea', 'rash', 'other'],
		'data-symptom-duration': ['hours', 'days'],
		'data-symptom-location': ['auto', 'here'],
		'data-incident-location': ['auto', 'here'],
	}
	const buttonCache = new Map()
	// `data-symptom-who` reaches script as `dataset.symptomWho`. A plain
	// assignment of the attribute name would store a key no handler reads, and
	// every selection would silently do nothing — a stub bug that looks exactly
	// like the defect under test.
	const camel = (name) => name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
	const makeButton = (attrs) => {
		const key = JSON.stringify(attrs)
		if (buttonCache.has(key)) return buttonCache.get(key)
		const el = makeElement('button')
		for (const [attr, value] of Object.entries(attrs)) el.dataset[camel(attr)] = value
		buttonCache.set(key, el)
		return el
	}
	const byAttr = (attr, value) =>
		(BUTTONS[attr] || []).filter((v) => value === undefined || v === value).map((v) => makeButton({ [attr]: v }))

	const documentStub = {
		getElementById: getById,
		documentElement: makeElement('html'),
		head: makeElement('head'),
		body: makeElement('body'),
		createElement: (tag) => makeElement(tag),
		createElementNS: (_ns, tag) => makeElement(tag),
		createDocumentFragment: () => makeElement('#fragment'),
		createTextNode: (text) => { const node = makeElement('#text'); node.textContent = String(text); return node },
		addEventListener() {},
		removeEventListener() {},
		querySelector: (sel) => documentStub.querySelectorAll(sel)[0] ?? null,
		querySelectorAll(selector) {
			const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector)
			if (m) {
				const byAttribute = walk(wizardEl).filter((node) => matches(node, selector))
				if (byAttribute.length) return byAttribute
				return byAttr(m[1], m[2])
			}
			// The `.screen` sweep in showScreen.
			if (selector === '.screen') return walk(wizardEl).filter((node) => node.classes.has('screen'))
			// The i18n sweep in the runtime.
			if (selector === '[data-i18n]' || selector === '[data-i18n-title]') return []
			return walk(wizardEl).filter((node) => matches(node, selector))
		},
	}

	const fetchCalls = []
	// The harness's `respond` takes the payload, not a response object: it builds
	// the `ok`/`status`/`json` shape itself, so a responder that returned one
	// would be handing it a body of `{ ok, status, json }` and every read would
	// answer `undefined` — a served form that never arrives, indistinguishable
	// from a deployment that serves none.
	const fakeFetch = (path_, options) => {
		fetchCalls.push({ path: path_, options })
		if (String(path_).endsWith('/i18n/en.json')) return { body: en }
		// ENH-38. The served form definition, when a test supplies one. Absent,
		// the route answers the shape a deployment that serves only the built-in
		// would: the built-in itself.
		if (/^\/api\/v1\/forms\//.test(String(path_))) {
			if (servedForm === null) return { ok: false, status: 404, body: { success: false, error: 'no form' } }
			return { body: { success: true, data: servedForm ?? forms.CHW_SYMPTOM_FORM } }
		}
		return { status: 201, body: { data: { id: 'r-1' } } }
	}

	const navigatorStub = {
		onLine: true,
		geolocation: geolocation
			? {
				getCurrentPosition: (ok, fail) => {
					geolocation(ok, fail)
				},
			}
			: null,
	}

	// The navbar mounts into the body and appends a dialog, and the app reads
	// `window.__i18n` on a locale switch. All of it is the real module's own
	// import-time work, so the stub has to carry what it touches rather than the
	// app being told to skip it.
	const windowStub = {
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => true,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		localStorage: { getItem: () => 'en', setItem() {}, removeItem() {} },
		location: { hash: '', search: '', href: 'http://localhost/chw/', pathname: '/chw/' },
		__i18n: null,
	}
	const bootOptions = {
		document: documentStub,
		window: windowStub,
		navigator: navigatorStub,
		respond: (url, init) => fakeFetch(url, init),
	}
	const restore = installBrowserEnv(bootOptions).restore

	// A fresh URL per boot: the module holds `state` and `activeForm` at module
	// scope, and 27 boots share one file.
	const mod = await importFrontEnd('chw/app.js', { ...bootOptions, fresh: true })
	await new Promise((r) => realSetTimeout(r, 20))

	const el = (id) => getById(id)
	const clickButton = (attrs) => {
		const btn = makeButton(attrs)
		for (const fn of btn.listeners.click || []) fn({ target: btn })
		return btn
	}

	booted.push({ restore })
	return { document: documentStub, wizard: mod.wizard, el, clickButton, makeButton, screens, fetchCalls, byId, restore }
}

const wait = (ms = 10) => new Promise((r) => realSetTimeout(r, ms))

/**
 * Compare a plain object's fields, ignoring which realm its prototype came
 * from. `state` lives inside a `vm` context, so `deepStrictEqual` fails on
 * prototype identity for objects that are otherwise identical — and the fields
 * are what this test is about.
 */
const sameFields = (actual, expected, message) => {
	for (const [key, value] of Object.entries(expected)) {
		assert.equal(actual?.[key], value, message)
	}
}

/** Walk the wizard to a given step, answering the earlier steps honestly. */
async function advanceTo(app, screen) {
	if (screen === 'symptom') {
		app.el('reportSymptomBtn').click()
		await wait()
		return
	}
	await app.clickButton({ 'data-symptom-who': 'self' })
	app.el('symptomNextBtn').click()
	await wait()
	if (screen === 'symptomType') return
	app.clickButton({ 'data-symptom-type': 'fever' })
	app.el('symptomTypeNextBtn').click()
	await wait()
	if (screen === 'symptomSeverity') return
	// Severity screen: no selections required to proceed.
	app.el('severityNextBtn').click()
	await wait()
	if (screen === 'symptomExposure') return
	// Exposure screen: selects must have a value before Next will move.
	app.el('exposeContactSick').value = 'unknown'
	app.el('exposeContactDead').value = 'unknown'
	app.el('exposeVaccination').value = 'unknown'
	app.el('exposeWater').value = 'clean'
	app.el('exposureNextBtn').click()
	await wait()
	if (screen === 'symptomDuration') return
	app.el('durationValue').value = '3'
	app.clickButton({ 'data-symptom-duration': 'days' })
	app.el('symptomDurationNextBtn').click()
	await wait()
	if (screen === 'symptomLocation') return
	throw new Error(`no route to ${screen}`)
}

// ---------------------------------------------------------------

describe('CW-05 — the location step never claimed a place it did not have', () => {
	it('says what Auto-detect is doing, and what came back', async () => {
		// Reproduced over CDP with geolocation never granted: pressing
		// Auto-detect changed nothing on screen. Not one word, not one pixel.
		const app = await bootChw({
			geolocation: (_ok, fail) => realSetTimeout(() => fail({ code: 1 }), 0),
		})
		await advanceTo(app, 'symptomLocation')

		app.el('autoLocationBtn').click()
		assert.equal(app.el('locationStatus').textContent, 'Asking this phone for a location fix…',
			'a tap must produce a pending state, or the app cannot be told from a refused permission')

		await wait(30)
		assert.equal(app.el('locationStatus').dataset.state, 'error')
		assert.match(app.el('locationStatus').textContent, /permission was refused/,
			'the four geolocation failures are different facts and a caller may act on each')
		assert.equal(app.wizard.state.symptom.location, null,
			'a failed fix must store nothing that reads as a coordinate')
	})

	it('uses a real fix and prints the coordinates it got', async () => {
		const app = await bootChw({
			geolocation: (ok) => realSetTimeout(() => ok({ coords: { latitude: -1.2864, longitude: 36.8172, accuracy: 12 } }), 0),
		})
		await advanceTo(app, 'symptomLocation')
		app.el('autoLocationBtn').click()
		await wait(30)

		sameFields(app.wizard.state.symptom.location, {
			latitude: -1.2864, longitude: 36.8172, source: 'gps', accuracy_m: 12,
		}, 'a real fix must be stored whole, with the accuracy it arrived with')
		assert.equal(app.el('locationStatus').textContent,
			"This phone's location: 1.2864° S, 36.8172° E (accurate to about 12 m).",
			'a coordinate the app holds should be visible to the person who supplied it')
	})

	it('`Here` never writes a null coordinate under a source that names a place', async () => {
		// The queued payload read `{"latitude":null,"longitude":null,
		// "source":"reported_here"}` — a location field asserting a location.
		const app = await bootChw({
			geolocation: (_ok, fail) => realSetTimeout(() => fail({ code: 1 }), 0),
		})
		await advanceTo(app, 'symptomLocation')

		app.el('hereLocationBtn').click()
		await wait(30)

		// The old line wrote `{latitude: null, longitude: null, source:
		// 'reported_here'}` into state and shipped it. So the assertion is on the
		// coordinates, not merely on the absence of an object: a value that
		// carries a source naming a place must carry the place.
		const location = app.wizard.state.symptom.location
		assert.ok(location === null
			|| (location.latitude == null && location.longitude == null),
		'with no fix, `Here` has no coordinates to record')
		assert.notEqual(location?.source, 'reported_here',
			'`reported_here` asserts a place; with no coordinates the record asserts nothing')
		assert.equal(app.el('locationStatus').dataset.state, 'error')
		assert.match(app.el('symptomLocationHint').textContent, /No fix on this phone/,
			'the screen must say why nothing was recorded and where to type one instead')
	})

	it('refuses a coordinate that would put a report in the ocean', async () => {
		const app = await bootChw()
		await advanceTo(app, 'symptomLocation')

		app.el('manualLat').value = ''
		app.el('manualLon').value = ''
		app.el('useManualLocationBtn').click()
		assert.equal(app.wizard.state.symptom.location, null)
		assert.match(app.el('manualLocationHint').textContent, /both a latitude and a longitude/)

		app.el('manualLat').value = '0'
		app.el('manualLon').value = '0'
		app.el('useManualLocationBtn').click()
		assert.equal(app.wizard.state.symptom.location, null,
			'(0, 0) is in bounds and in the Gulf of Guinea; it is not a household')
		assert.match(app.el('manualLocationHint').textContent, /open ocean/)

		app.el('manualLat').value = '99'
		app.el('manualLon').value = '36.8'
		app.el('useManualLocationBtn').click()
		assert.equal(app.wizard.state.symptom.location, null)
		assert.match(app.el('manualLocationHint').textContent, /between -90 and 90/)

		app.el('manualLat').value = '-1.2864'
		app.el('manualLon').value = '36.8172'
		app.el('useManualLocationBtn').click()
		sameFields(app.wizard.state.symptom.location,
			{ latitude: -1.2864, longitude: 36.8172, source: 'manual' })
		assert.equal(app.el('locationStatus').textContent, 'Location typed in: 1.2864° S, 36.8172° E.')
	})

	it('does not ask the phone for a location until someone asks', async () => {
		let asked = 0
		await bootChw({ geolocation: () => { asked += 1 } })
		await wait(20)
		assert.equal(asked, 0,
			'init used to fire a permission dialog the moment the app opened, before any tap')
	})
})

describe('CW-12 — duration is a number and a unit, not a unit', () => {
	it('stores the count as a field, not only as prose', async () => {
		const app = await bootChw()
		await advanceTo(app, 'symptomLocation')
		app.el('symptomLocationNextBtn').click()
		await wait()
		app.el('symptomSubmitBtn').click()
		await wait(40)

		const body = JSON.parse(app.fetchCalls.find((c) => c.path === '/api/v1/chw/report').options.body)
		assert.equal(body.duration_value, 3)
		assert.equal(body.duration_unit, 'days')
		assert.equal(body.duration_days, 3)
		assert.equal(body.duration_hours, undefined,
			'a count of days must not also be filed as a count of hours')
		assert.equal(body.description, 'self with fever for 3 days')
	})

	it('files hours as hours', async () => {
		const app = await bootChw()
		await advanceTo(app, 'symptomDuration')
		app.el('durationValue').value = '12'
		app.clickButton({ 'data-symptom-duration': 'hours' })
		app.el('symptomDurationNextBtn').click()
		await wait()

		const state = app.wizard.state
		assert.equal(state.symptom.durationValue, 12)
		assert.equal(state.symptom.durationUnit, 'hours')
	})

	it('refuses an empty count and says why, rather than storing "for days"', async () => {
		const app = await bootChw()
		await advanceTo(app, 'symptomDuration')
		app.el('durationValue').value = ''
		app.el('symptomDurationNextBtn').click()
		await wait()

		assert.ok(app.el('symptomDurationScreen').classes.has('active'), 'the step must not advance')
		assert.equal(app.wizard.state.symptom.durationValue, null)
		assert.match(app.el('symptomDurationHint').textContent, /Enter how many days or hours/)
	})

	it('does not pre-fill a guess about somebody’s fever', () => {
		const html = read('public/chw/index.html')
		const input = html.match(/<input[^>]*id="durationValue"[^>]*>/)[0]
		assert.ok(!/\bvalue=/.test(input),
			'a default count is a guess about a patient that then travels downstream as a fact')
	})

	it('clears the previous report’s values before the next one starts', async () => {
		const app = await bootChw()
		await advanceTo(app, 'symptomLocation')
		app.el('manualLat').value = '-1.2864'
		app.el('manualLon').value = '36.8172'
		app.el('useManualLocationBtn').click()
		app.el('symptomLocationNextBtn').click()
		await wait()
		app.el('symptomSubmitBtn').click()
		await wait(40)

		assert.equal(app.el('durationValue').value, '',
			'the next report would otherwise inherit the last patient’s duration')
		assert.equal(app.el('manualLat').value, '',
			'and the last household’s coordinates')
	})
})

describe('CW-14 — a blocked control explains itself', () => {
	it('says what to choose when Next will not move', async () => {
		const app = await bootChw()
		await advanceTo(app, 'symptom')

		app.el('symptomNextBtn').click()
		await wait()

		assert.ok(app.el('symptomScreen').classes.has('active'), 'the step must not advance')
		assert.equal(app.el('symptomWhoHint').textContent, 'Choose who has this symptom to continue.')
	})

	it('clears the explanation once the question is answered', async () => {
		const app = await bootChw()
		await advanceTo(app, 'symptom')
		app.el('symptomNextBtn').click()
		await wait()
		assert.notEqual(app.el('symptomWhoHint').textContent, '')

		app.clickButton({ 'data-symptom-who': 'self' })
		assert.equal(app.el('symptomWhoHint').textContent, '',
			'an answer that leaves the explanation standing reads as a refusal')
	})

	it('does the same on the other gated steps', async () => {
		const app = await bootChw()
		await advanceTo(app, 'symptomType')
		app.el('symptomTypeNextBtn').click()
		await wait()
		assert.ok(app.el('symptomTypeScreen').classes.has('active'))
		assert.match(app.el('symptomTypeHint').textContent, /Choose a symptom/)
	})
})

describe('HX-09 — the wizard names the step you are on', () => {
	it('counts seven steps, and the dots agree with the count', async () => {
		const app = await bootChw()
		assert.equal(app.wizard.symptomSteps().length, 7)
		// Reproduced over CDP: the last screen drew five dots and the other four
		// drew four, so the row could not be read as a position in anything.
		const html = read('public/chw/index.html')
		for (const step of [1, 2, 3, 4, 5, 6, 7]) {
			assert.ok(html.includes(`data-step="${step}"`), `step ${step} must declare its position`)
		}
	})

	it('gives every step its own title', () => {
		// Four consecutive screens were all titled "Report symptom".
		const html = read('public/chw/index.html')
		const titles = [...html.matchAll(/data-i18n="chw\.screen-title-(\w+)"/g)].map((m) => m[1])
		assert.equal(titles.length, 0, 'per-step titles must be existing keys, not new ones')
		const wizard = html.slice(html.indexOf('id="symptomScreen"'), html.indexOf('id="incidentScreen"'))
		const headings = [...wizard.matchAll(/<h2 class="screen-title"[^>]*>([^<]+)</g)].map((m) => m[1].trim())
		assert.equal(headings.length, 7)
		assert.equal(new Set(headings).size, 7,
			`every step must say which question it asks, got ${JSON.stringify(headings)}`)
	})

	it('renders a counter and a full dot row on every step', async () => {
		const app = await bootChw()
		for (const { name, el } of app.screens) {
			if (name === 'home' || name === 'incident' || name === 'reply') continue
			const dots = makeElement('div')
			const counter = makeElement('p')
			el.querySelector = (sel) => (sel === '[data-step]' ? dots : sel === '[data-step-counter]' ? counter : null)
			app.wizard.renderStepProgress()
			assert.equal(dots.children.length, 7, `${name} must draw one dot per step`)
			assert.match(counter.textContent, /^Step \d of 7$/, `${name} must count its steps`)
		}
	})

	it('announces arrival with the step number, not only the heading', async () => {
		// The announcement used to be the heading alone, and the heading was the
		// same four words on four screens.
		const app = await bootChw()
		app.el('reportSymptomBtn').click()
		await wait()
		assert.equal(app.el('screenAnnouncer').textContent, 'Step 1 of 7. Who has this symptom?')

		app.clickButton({ 'data-symptom-who': 'self' })
		app.el('symptomNextBtn').click()
		await wait()
		assert.equal(app.el('screenAnnouncer').textContent, 'Step 2 of 7. Which symptom?')
	})
})

describe('ENH-38 — the wizard files the version the deployment serves', () => {
	it('files version 1 when the deployment serves only the built-in', async () => {
		const app = await bootChw()
		await wait(30)
		await advanceTo(app, 'symptomLocation')
		app.el('symptomLocationNextBtn').click()
		await wait()
		app.el('symptomSubmitBtn').click()
		await wait(40)

		const body = JSON.parse(app.fetchCalls.find((c) => c.path === '/api/v1/chw/report').options.body)
		assert.equal(body.form_id, 'chw_symptom_report')
		assert.equal(body.form_version, 1)
	})

	it('files the served version, not the one it was compiled with', async () => {
		// The defect: the version was a `const 1`. A district publishes v2, the
		// server serves it immutably, and the wizard goes on filing v1 forever —
		// answering the previous question and stamping a version the district has
		// moved past, with nothing failing to say so.
		const servedForm = { ...forms.CHW_SYMPTOM_FORM, version: 2 }
		const app = await bootChw({ servedForm })
		await wait(30)
		assert.equal(app.wizard.activeForm().version, 2,
			'the wizard did not adopt the served version')

		await advanceTo(app, 'symptomLocation')
		app.el('symptomLocationNextBtn').click()
		await wait()
		app.el('symptomSubmitBtn').click()
		await wait(40)

		const body = JSON.parse(app.fetchCalls.find((c) => c.path === '/api/v1/chw/report').options.body)
		assert.equal(body.form_version, 2, 'the wizard filed a version it did not render')
	})

	it('renders a served version that asks a question the built-in does not have', async () => {
		// The half ENH-38 was missing. The static screens could only draw the
		// built-in's questions, so a served v2 that added one was refused. Now the
		// wizard renders the definition: the new field gets a screen, and its
		// answer reaches the submission keyed by its own name.
		const servedForm = {
			...forms.CHW_SYMPTOM_FORM,
			version: 2,
			fields: [...forms.CHW_SYMPTOM_FORM.fields, { name: 'muac_mm', label: 'MUAC (mm)', type: 'integer' }],
		}
		const app = await bootChw({ servedForm })
		await wait(30)

		assert.equal(app.wizard.activeForm().version, 2,
			'the wizard did not adopt a served definition it can now render')
		// The extra question has a screen of its own, drawn from the definition,
		// and that screen carries an action button. Read the real DOM, not `el(id)`
		// — that helper fabricates a missing element, so it cannot tell a rendered
		// screen from an absent one.
		const dom = app.document
		const extra = dom.querySelectorAll('#muac_mmScreen')
		assert.equal(extra.length, 1, 'the served question got no screen')
		assert.ok(extra[0].querySelectorAll('.btn-primary').length >= 1,
			'the served question got no way to advance')
	})

	it('files a served definition’s answers keyed by the definition’s own names', async () => {
		// A rendered field whose answer is dropped is worse than one refused,
		// because it files silently. So the submission built from a served
		// definition must carry the new question under its own name.
		const servedForm = {
			...forms.CHW_SYMPTOM_FORM,
			version: 2,
			fields: [...forms.CHW_SYMPTOM_FORM.fields, { name: 'muac_mm', label: 'MUAC (mm)', type: 'integer' }],
		}
		const app = await bootChw({ servedForm })
		await wait(30)

		const { readAnswers } = app.wizard
		// The extra question renders as an input the reader can reach. Answer it,
		// then read: the answer must arrive keyed by the definition's own name.
		const widget = app.document.querySelectorAll('[data-field-muac-mm]')[0]
		assert.ok(widget, 'the served definition’s field was not rendered with a readable hook')
		widget.value = '125'
		// A multiselect is the field most easily dropped by a reader that handles
		// only text inputs, and a dropped answer is worse than a refused one
		// because it files silently. Tick two boxes and require both back.
		const boxes = app.document.querySelectorAll('[data-field-danger-signs]')
		assert.ok(boxes.length >= 2, 'the served definition’s multiselect was not rendered as checkboxes')
		boxes[0].checked = true
		boxes[1].checked = true
		const answers = readAnswers(app.wizard.activeForm())
		assert.equal(answers.muac_mm, '125', 'the served definition’s extra answer did not reach the answers object')
		assert.deepEqual(answers.danger_signs, [boxes[0].getAttribute('data-field-danger-signs'), boxes[1].getAttribute('data-field-danger-signs')],
			'a multiselect answer was dropped by the served-definition reader')
		// And no key the definition does not declare can appear — the loop is over
		// the definition, so the property holds by construction.
		const declared = new Set(servedForm.fields.map((f) => f.name))
		const undeclared = Object.keys(answers).filter((k) => !declared.has(k))
		assert.deepEqual(undeclared, [], 'the served definition filed an answer to a question it does not ask')
	})

	it('keys the answers identically whether the built-in or a served v1 is active', async () => {
		// The test that catches a silent drop. A served definition that asks the
		// built-in's own questions must file an answer set with exactly those keys
		// — no field invented, none lost.
		const builtin = await bootChw()
		await wait(30)
		const served = await bootChw({ servedForm: { ...forms.CHW_SYMPTOM_FORM, version: 2 } })
		await wait(30)

		const a = builtin.wizard.readAnswers(builtin.wizard.activeForm())
		const b = served.wizard.readAnswers(served.wizard.activeForm())
		assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(),
			'the answer keys differ between the built-in and a served definition that asks the same questions')
	})

	it('submits a served definition’s answers through the real submission path', async () => {
		// The readAnswers unit above proves the reader; this proves the wire. A
		// served v2 with an extra question, answered and submitted, must file the
		// extra answer under its own name — not a subset that files silently.
		const servedForm = {
			...forms.CHW_SYMPTOM_FORM,
			version: 2,
			fields: [...forms.CHW_SYMPTOM_FORM.fields, { name: 'muac_mm', label: 'MUAC (mm)', type: 'integer' }],
		}
		const app = await bootChw({ servedForm })
		await wait(30)

		const widget = app.document.querySelectorAll('[data-field-muac-mm]')[0]
		widget.value = '125'
		app.wizard.state.symptom = { ...app.wizard.state.symptom, who: 'self', type: 'fever', durationValue: 3, durationUnit: 'days' }
		await app.wizard.submitSymptomReport()
		await wait(40)

		const body = JSON.parse(app.fetchCalls.find((c) => c.path === '/api/v1/chw/report').options.body)
		assert.equal(body.form_version, 2)
		assert.equal(body.answers.muac_mm, '125', 'the served question’s answer did not reach the submission')
	})

	it('renders the built-in with no fetch at all, when the form route is unreachable', async () => {
		// The field app is offline-first. A health worker with no signal must still
		// open the wizard, and the built-in is what lets it. `servedForm: null`
		// makes the route 404; the wizard must still be usable.
		const app = await bootChw({ servedForm: null })
		await wait(30)
		assert.equal(app.wizard.activeForm().version, 1)
		// The wizard opens and advances on the built-in's own screens.
		app.el('reportSymptomBtn').click()
		await wait()
		assert.ok(app.el('symptomScreen').classes.has('active'), 'the wizard did not open offline')
		app.clickButton({ 'data-symptom-who': 'self' })
		app.el('symptomNextBtn').click()
		await wait()
		assert.ok(app.el('symptomTypeScreen').classes.has('active'),
			'the offline wizard did not advance on the built-in’s screens')
	})

	it('refuses a served version with a field type it cannot draw, naming the field', async () => {
		// The wizard now renders any field, so the refusal is narrower — but it is
		// not gone. A field whose *type* has no control (`image` renders as a text
		// box whose answer the server would reject) is refused, with the field and
		// its type named. Adopting it and drawing something wrong would file a
		// silently broken answer, which is the failure the refusal exists to avoid.
		const servedForm = {
			...forms.CHW_SYMPTOM_FORM,
			version: 2,
			fields: [...forms.CHW_SYMPTOM_FORM.fields, { name: 'lesion_photo', label: 'Photo', type: 'image' }],
		}
		const app = await bootChw({ servedForm })
		await wait(30)

		assert.equal(app.wizard.activeForm().version, 1,
			'the wizard adopted a definition whose field type it cannot draw')
		assert.match(app.wizard.state.formNotice, /lesion_photo/,
			'the refusal must name the field')
		assert.match(app.wizard.state.formNotice, /image/,
			'the refusal must name the type it cannot draw')
	})

	it('starts from the built-in when the form route cannot be reached', async () => {
		// The field app is offline-first. A health worker with no signal must
		// still open the wizard, and the built-in is what lets it.
		const app = await bootChw({ servedForm: null })
		await wait(30)
		assert.equal(app.wizard.activeForm().version, 1)
		assert.equal(app.wizard.state.formNotice, null, 'a missing route is not a notice')
	})

	it('adoptableForm accepts the built-in, a wider definition, and refuses an undrawable type', async () => {
		const app = await bootChw()
		const { adoptableForm } = app.wizard
		const { form, reason } = adoptableForm(forms.CHW_SYMPTOM_FORM)
		assert.ok(form, 'the built-in must be adoptable')
		assert.equal(reason, null)

		const bad = adoptableForm({ id: 'x', version: 0, fields: [] })
		assert.equal(bad.form, null)
		assert.match(bad.reason, /version/)

		// A field the built-in does not have is now adoptable — the renderer
		// draws it, so refusing it would be refusing the capability this item is.
		const wider = adoptableForm({
			...forms.CHW_SYMPTOM_FORM, version: 2,
			fields: [...forms.CHW_SYMPTOM_FORM.fields, { name: 'new_q', label: 'New', type: 'text' }],
		})
		assert.ok(wider.form, 'a definition with a renderable extra field was refused')

		// A type the renderer has no control for is not.
		const undrawable = adoptableForm({
			...forms.CHW_SYMPTOM_FORM, version: 2,
			fields: [...forms.CHW_SYMPTOM_FORM.fields, { name: 'shot', label: 'Photo', type: 'image' }],
		})
		assert.equal(undrawable.form, null)
		assert.match(undrawable.reason, /shot/)
		assert.match(undrawable.reason, /image/)
	})
})

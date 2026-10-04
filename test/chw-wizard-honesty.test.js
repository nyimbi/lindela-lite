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
 * `public/chw/app.js` cannot be imported from a test — absolute
 * `/shared/runtime.js` specifiers, top-level await, a real DOM — so it is run
 * as the script it is: the import lines are dropped, the module body runs
 * verbatim in a `vm` against a DOM stub, and the trailing probe exposes the
 * module's own `state` and functions rather than a reimplementation. The
 * handlers under test are the ones the buttons are wired to.
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
import vm from 'node:vm'

/**
 * Every boot replaces the host's `document`, `window`, `navigator` and `fetch`
 * so the real runtime can run. Restored after each test, or the second test in
 * a file measures the first one's stub.
 */
const booted = []
afterEach(() => {
	while (booted.length) booted.pop().restore()
})

const ROOT = path.join(import.meta.dirname, '..')
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
		listeners: {},
		classList: {
			add(...c) { for (const x of c) el.classes.add(x) },
			remove(...c) { for (const x of c) el.classes.delete(x) },
			toggle(c, on) { if (on === undefined ? el.classes.has(c) : !on) el.classes.delete(c); else el.classes.add(c) },
			contains: (c) => el.classes.has(c),
		},
		setAttribute(k, v) { el.attrs[k] = String(v) },
		getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
		hasAttribute: (k) => k in el.attrs,
		appendChild(child) { el.children.push(child); return child },
		append(...c) { el.children.push(...c) },
		addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn) },
		removeEventListener() {},
		focus() {},
		scrollIntoView() {},
		remove() {},
		querySelector: () => null,
		querySelectorAll: () => [],
		click(event = {}) { for (const fn of el.listeners.click || []) fn({ target: el, ...event }) },
	}
	return el
}

/**
 * Boot the real module against a DOM whose buttons carry the same
 * `data-*` hooks the real index.html puts on them.
 */
async function bootChw({ geolocation = null } = {}) {
	const en = JSON.parse(read('public/i18n/en.json'))
	const runtime = await import(path.join(ROOT, 'public/shared/runtime.js'))
	const states = await import(path.join(ROOT, 'public/shared/states.js'))

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

	const getById = (id) => {
		if (!byId.has(id)) byId.set(id, makeElement('div', id))
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
		createElement: (tag) => makeElement(tag),
		querySelector: () => null,
		querySelectorAll(selector) {
			const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector)
			if (m) return byAttr(m[1], m[2])
			// The `.screen` sweep in showScreen.
			if (selector === '.screen') return screens.map((s) => s.el)
			// The i18n sweep in the runtime.
			if (selector === '[data-i18n]' || selector === '[data-i18n-title]') return []
			return []
		},
	}

	const fetchCalls = []
	const fakeFetch = async (path_, options) => {
		fetchCalls.push({ path: path_, options })
		if (String(path_).endsWith('/i18n/en.json')) return { ok: true, status: 200, json: async () => en }
		return { ok: true, status: 201, headers: new Headers(), json: async () => ({ data: { id: 'r-1' } }) }
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

	const context = {
		console, JSON, URL, AbortSignal, CustomEvent, Headers,
		setInterval: () => 0,
		setTimeout,
		clearTimeout,
		requestAnimationFrame: (fn) => { fn(); return 0 },
		localStorage: { getItem: () => 'en', setItem() {} },
		document: documentStub,
		navigator: navigatorStub,
		fetch: fakeFetch,
		...runtime,
		// The state vocabulary the app imports by name. It is pure and DOM-free,
		// so the real module runs in the vm untouched.
		...states,
		mountNavbar() {},
	}
	context.window = { addEventListener() {}, dispatchEvent: () => true, __i18n: null }
	context.globalThis = context
	vm.createContext(context)

	const source = read('public/chw/app.js').split('\n').filter((l) => !l.startsWith('import ')).join('\n')
	// The runtime functions injected above are this realm's, not the vm's, so
	// they read the host's `document`. Both realms have to see the same stubs or
	// the app and the i18n catalogue would be looking at two different documents.
	const previous = {}
	const define = (key, value) => {
		previous[key] = Object.getOwnPropertyDescriptor(globalThis, key)
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
	}
	define('window', context.window)
	define('document', documentStub)
	define('navigator', navigatorStub)
	define('fetch', fakeFetch)
	// The queue installs a 30s flush timer, which outlives the test run in Node.
	define('setInterval', () => 0)

	await vm.runInContext(
		`(async () => {${source}\nglobalThis.__chw = { state, showScreen, requestUserLocation, setHint, describeLocation, submitSymptomReport, renderStepProgress, SYMPTOM_STEPS }\n})()`,
		context,
	)
	await new Promise((r) => setTimeout(r, 20))

	const restore = () => {
		for (const [key, descriptor] of Object.entries(previous)) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor)
			else delete globalThis[key]
		}
	}

	const el = (id) => getById(id)
	const clickButton = (attrs) => {
		const btn = makeButton(attrs)
		for (const fn of btn.listeners.click || []) fn({ target: btn })
		return btn
	}

	booted.push({ restore })
	return { context, el, clickButton, makeButton, screens, fetchCalls, byId, restore }
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms))

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
			geolocation: (_ok, fail) => setTimeout(() => fail({ code: 1 }), 0),
		})
		await advanceTo(app, 'symptomLocation')

		app.el('autoLocationBtn').click()
		assert.equal(app.el('locationStatus').textContent, 'Asking this phone for a location fix…',
			'a tap must produce a pending state, or the app cannot be told from a refused permission')

		await wait(30)
		assert.equal(app.el('locationStatus').dataset.state, 'error')
		assert.match(app.el('locationStatus').textContent, /permission was refused/,
			'the four geolocation failures are different facts and a caller may act on each')
		assert.equal(app.context.__chw.state.symptom.location, null,
			'a failed fix must store nothing that reads as a coordinate')
	})

	it('uses a real fix and prints the coordinates it got', async () => {
		const app = await bootChw({
			geolocation: (ok) => setTimeout(() => ok({ coords: { latitude: -1.2864, longitude: 36.8172, accuracy: 12 } }), 0),
		})
		await advanceTo(app, 'symptomLocation')
		app.el('autoLocationBtn').click()
		await wait(30)

		sameFields(app.context.__chw.state.symptom.location, {
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
			geolocation: (_ok, fail) => setTimeout(() => fail({ code: 1 }), 0),
		})
		await advanceTo(app, 'symptomLocation')

		app.el('hereLocationBtn').click()
		await wait(30)

		// The old line wrote `{latitude: null, longitude: null, source:
		// 'reported_here'}` into state and shipped it. So the assertion is on the
		// coordinates, not merely on the absence of an object: a value that
		// carries a source naming a place must carry the place.
		const location = app.context.__chw.state.symptom.location
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
		assert.equal(app.context.__chw.state.symptom.location, null)
		assert.match(app.el('manualLocationHint').textContent, /both a latitude and a longitude/)

		app.el('manualLat').value = '0'
		app.el('manualLon').value = '0'
		app.el('useManualLocationBtn').click()
		assert.equal(app.context.__chw.state.symptom.location, null,
			'(0, 0) is in bounds and in the Gulf of Guinea; it is not a household')
		assert.match(app.el('manualLocationHint').textContent, /open ocean/)

		app.el('manualLat').value = '99'
		app.el('manualLon').value = '36.8'
		app.el('useManualLocationBtn').click()
		assert.equal(app.context.__chw.state.symptom.location, null)
		assert.match(app.el('manualLocationHint').textContent, /between -90 and 90/)

		app.el('manualLat').value = '-1.2864'
		app.el('manualLon').value = '36.8172'
		app.el('useManualLocationBtn').click()
		sameFields(app.context.__chw.state.symptom.location,
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

		const { state } = app.context.__chw
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
		assert.equal(app.context.__chw.state.symptom.durationValue, null)
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
	it('counts five steps, and the dots agree with the count', async () => {
		const app = await bootChw()
		assert.equal(app.context.__chw.SYMPTOM_STEPS.length, 5)
		// Reproduced over CDP: the last screen drew five dots and the other four
		// drew four, so the row could not be read as a position in anything.
		const html = read('public/chw/index.html')
		for (const step of [1, 2, 3, 4, 5]) {
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
		assert.equal(headings.length, 5)
		assert.equal(new Set(headings).size, 5,
			`every step must say which question it asks, got ${JSON.stringify(headings)}`)
	})

	it('renders a counter and a full dot row on every step', async () => {
		const app = await bootChw()
		for (const { name, el } of app.screens) {
			if (name === 'home' || name === 'incident' || name === 'reply') continue
			const dots = makeElement('div')
			const counter = makeElement('p')
			el.querySelector = (sel) => (sel === '[data-step]' ? dots : sel === '[data-step-counter]' ? counter : null)
			app.context.__chw.renderStepProgress()
			assert.equal(dots.children.length, 5, `${name} must draw one dot per step`)
			assert.match(counter.textContent, /^Step \d of 5$/, `${name} must count its steps`)
		}
	})

	it('announces arrival with the step number, not only the heading', async () => {
		// The announcement used to be the heading alone, and the heading was the
		// same four words on four screens.
		const app = await bootChw()
		app.el('reportSymptomBtn').click()
		await wait()
		assert.equal(app.el('screenAnnouncer').textContent, 'Step 1 of 5. Who has this symptom?')

		app.clickButton({ 'data-symptom-who': 'self' })
		app.el('symptomNextBtn').click()
		await wait()
		assert.equal(app.el('screenAnnouncer').textContent, 'Step 2 of 5. Which symptom?')
	})
})

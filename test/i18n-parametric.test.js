#!/usr/bin/env node
/**
 * The parametric surface's i18n layer.
 *
 * `scripts/check-i18n.mjs` was written after a health worker was shown literal
 * key names as button labels on a surface that offered nine languages and
 * carried strings for three. This surface had no layer at all: it was in the
 * gate's `surfaces with no i18n layer at all` list, so nothing was checked
 * about it and no key existed for any string it showed.
 *
 * The tests below drive the real module against a recording catalogue rather
 * than asserting on its source text. The distinction matters — a guard that
 * reads a file and checks for a phrase rots the moment the phrase is
 * reworded, and then keeps passing; a guard that records which keys the
 * rendered page actually asked for cannot pass while a key is untranslatable.
 * The DOM is the contract, and that is what these assert on.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { before, describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_ROOT = path.join(ROOT, 'public')
const NAMESPACE = 'parametric.'

/**
 * This surface's own keys, read out of the catalogue that ships them.
 *
 * They were staged in `_stage-parametric.json` until the merge into `en.json`
 * landed; the staging file is gone, and a second copy of the same English left
 * in the tree is a second thing to forget to update.
 */
const STAGE = Object.fromEntries(
  Object.entries(JSON.parse(fs.readFileSync(path.join(PUBLIC_ROOT, 'i18n', 'en.json'), 'utf8')))
    .filter(([key]) => key.startsWith(NAMESPACE)),
)
const HTML = fs.readFileSync(path.join(PUBLIC_ROOT, 'parametric', 'index.html'), 'utf8')

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(PUBLIC_ROOT, 'i18n', rel), 'utf8'))

/** The ids `public/parametric/index.html` names, so the stub answers like the page. */
const PARAMETRIC_IDS = [
  'locale-select', 'rulesList', 'simSection', 'simForm', 'simRulePicker',
  'historyBody', 'simResult', 'addRuleForm', 'addRuleError', 'simError',
  'ruleName', 'ruleChain', 'ruleTriggerMetric', 'ruleTriggerThreshold',
  'ruleAmount', 'ruleCurrency', 'ruleRecipientGroup', 'ruleFocalPoint',
  'simFocalApproved', 'simRecipientName',
]

// ---------------------------------------------------------------
// Browser module sandbox
// ---------------------------------------------------------------

function stubElement(tag = 'DIV') {
  return {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    attrs: {},
    hidden: false,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    options: [],
    childNodes: [],
    children: [],
    length: 0,
    selectionStart: null,
    selectionEnd: null,
    scrollTop: 0,
    isContentEditable: false,
    listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute: (k) => (k in this.attrs ? this.attrs[k] : null),
    removeAttribute(k) { delete this.attrs[k] },
    append() {},
    appendChild() {},
    removeChild() {},
    replaceChildren() {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    focus() {},
    blur() {},
    insertBefore() {},
    setSelectionRange() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }),
    contains: () => false,
    cloneNode: () => stubElement(tag),
    /** Fire the handlers the module bound, the way a submit event would. */
    async fire(type, event = {}) {
      for (const fn of this.listeners[type] || []) {
        await fn({ preventDefault() {}, target: { reset() {} }, ...event })
      }
    },
  }
}

const els = new Map()
function el(id) {
  if (!els.has(id)) els.set(id, stubElement())
  return els.get(id)
}

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }), headers: new Map() })

/**
 * Load the real `public/parametric/app.js`, with a catalogue that records every
 * key the page asks for instead of answering from a file. `routes` decides what
 * the API returns; `catalog` is what the i18n layer resolves against.
 *
 * The recording catalogue is installed *after* the module has booted. The
 * shared runtime owns `window.__i18n` and replaces whatever was there with the
 * one it built from the fetched file, so a recorder put there first is thrown
 * away and records nothing — a test that passes because nothing was ever asked.
 * Installing afterwards is also what makes the record honest: it holds only the
 * keys the page asked while rendering, not the ones the runtime copied off disk
 * at boot.
 */
async function loadParametric({ routes = {}, catalog = {} } = {}) {
  els.clear()
  const asked = []

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('/shared/')) {
        return { url: new URL(`.${specifier}`, `file://${PUBLIC_ROOT}/`).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })

  const store = new Map()
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    location: { href: 'http://localhost/parametric' },
  }
  globalThis.localStorage = {
    getItem: (k) => (k === 'lindela_lite_locale' ? store.get(k) ?? null : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  }
  globalThis.document = {
    getElementById: (id) => el(id),
    // The static markup is a different surface's job; the shared runtime walks
    // it on a real page and there is nothing here to walk in a stub.
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => stubElement(tag),
    documentElement: stubElement('html'),
    body: stubElement('body'),
    readyState: 'complete',
    addEventListener() {},
  }
  globalThis.location = { href: 'http://localhost/parametric' }
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    for (const [fragment, res] of Object.entries(routes)) {
      if (u.includes(fragment)) return typeof res === 'function' ? res(opts) : res
    }
    return { ok: true, status: 200, json: async () => ({}), headers: new Map() }
  }

  // A fresh module instance per load: the surface keeps its fetched data in
  // module scope, so a cached import would hand the next scenario the previous
  // scenario's rules.
  await import(new URL(`parametric/app.js?load=${loadParametric.n++}`, `file://${PUBLIC_ROOT}/`).href)
  // init() awaits the catalogue and only then binds the locale listener, so
  // waiting on `window.__i18n` alone races it: the recorder below would be
  // installed while the page still had nothing to re-render into it.
  for (let i = 0; i < 100 && !(el('locale-select').listeners.change || []).length; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }

  globalThis.window.__i18n = {
    current: 'en',
    catalog,
    t(key, params = {}) {
      asked.push(key)
      let text = catalog[key] || key
      for (const [name, value] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), value)
      }
      return text
    },
    async set() {},
  }

  // The panels the first paint produced were rendered against the runtime's own
  // catalogue, before the recorder existed. Changing the locale is what a reader
  // does to get the page into another language, and it redraws every panel, so
  // this is also the path the record is meant to cover.
  await el('locale-select').fire('change', { target: { value: 'en' } })
  return { asked, el }
}
loadParametric.n = 0

const RULES = [
  {
    id: 'pr-1',
    name: 'Flood trigger — Turkana',
    chain: 'ethereum-sepolia',
    status: 'active',
    trigger_metric: 'precipitation_mm',
    trigger_threshold: 50,
    disbursement_amount_local_currency: 10000,
    currency: 'USD',
    requires_focal_point_approval: true,
  },
]

const DISBURSEMENTS = [
  {
    disbursement_id: 'd-0001-aaaa',
    rule_id: 'pr-1',
    chain: 'ethereum-sepolia',
    tx_hash: '0xdeadbeefcafe0123',
    amount: 10000,
    currency: 'USD',
    status: 'simulated',
    sanctions_status: 'clear',
    sanctions_screened: true,
    simulated_at: '2026-10-01T09:00:00.000Z',
  },
  {
    // A row predating the `sanctions_status` field. The server's own status
    // string is data and is shown as sent; this row is the one where the
    // surface is the only thing that knows what happened, and so the only thing
    // that has to say it in words.
    disbursement_id: 'd-0000-bbbb',
    rule_id: 'pr-1',
    chain: 'ethereum-sepolia',
    tx_hash: '0xfeedface12345678',
    amount: 10000,
    currency: 'USD',
    status: 'simulated',
    sanctions_screened: true,
    simulated_at: '2026-09-01T09:00:00.000Z',
  },
]

/**
 * Simulate against the first loaded rule.
 *
 * The picker is a `<select>` the module fills with `innerHTML`, which a stub
 * cannot turn into an option with a `value`, so the selection a real reader
 * makes has to be made here or the form refuses to submit and the whole result
 * panel — including the sanctions banner — goes untested.
 */
async function simulate({ recipient = null, focal = false } = {}) {
  el('simRulePicker').value = RULES[0].id
  el('simRecipientName').value = recipient || ''
  el('simFocalApproved').checked = focal
  await el('simForm').fire('submit')
}

// ================================================================
// The keys the surface asks for are keys a language can translate
// ================================================================

describe('parametric i18n — every key the page asks for exists', () => {
  let asked

  const SIM = (screening) => ({
    tx_hash: '0xdeadbeefcafe0123456789',
    chain: 'ethereum-sepolia',
    amount: 10000,
    currency: 'USD',
    status: 'simulated',
    simulated_at: '2026-10-01T09:00:00.000Z',
    sanctions_status: screening,
    sanctions_reason: null,
  })

  before(async () => {
    const loaded = await loadParametric({
      routes: {
        // A named recipient is screened and can come back blocked; an unnamed
        // one cannot be, which is the whole point of collecting the field.
        '/simulate': (opts) => ok(SIM(JSON.parse(opts.body).recipient_name ? 'blocked' : 'not_screened')),
        '/parametric-rules': ok(RULES),
        '/parametric-disbursements': ok(DISBURSEMENTS),
      },
    })
    // Exercise the paths that only run on interaction, since their strings are
    // user-visible exactly when a rule is being created or a payout simulated.
    await el('addRuleForm').fire('submit')
    await simulate()
    await simulate({ recipient: 'Turkana County Water Authority' })
    asked = loaded.asked
  })

  it('asks for keys, and every one is in the staged catalogue', () => {
    assert.ok(asked.length > 20, 'the recording catalogue was never consulted, so this asserts nothing')
    const untranslatable = [...new Set(asked)].filter((k) => !(k in STAGE))
    assert.deepEqual(untranslatable, [],
      'a key no catalogue defines renders as the key name itself')
  })

  it('names every key under the parametric namespace', () => {
    const strayed = [...new Set(asked)].filter((k) => !k.startsWith('parametric.'))
    assert.deepEqual(strayed, [], 'keys outside the namespace collide with another surface’s')
  })

  it('reaches both outcomes the sanctions panel can report', () => {
    // `not_screened` and `blocked` are separate sentences, and a page that
    // renders one in place of the other is stating something untrue about what
    // was checked. The panel holds one simulation at a time, so what is checked
    // here is the record of what the two runs asked for.
    assert.ok(asked.includes('parametric.screening_not_screened'))
    assert.ok(asked.includes('parametric.screening_blocked'))
    assert.doesNotMatch(el('simResult').innerHTML, /parametric\./)
  })

  it('resolves to the English string, never to the key name, with no catalogue loaded', async () => {
    // The failure this exists for: `catalog[key] || key` with an empty
    // catalogue puts "parametric.screening_blocked" on the screen where the
    // sentence saying the payout is held should be.
    await loadParametric({
      catalog: {},
      routes: {
        '/simulate': ok(SIM('blocked')),
        '/parametric-rules': ok(RULES),
        '/parametric-disbursements': ok(DISBURSEMENTS),
      },
    })
    await simulate({ recipient: 'Turkana County Water Authority' })

    const html = el('simResult').innerHTML + el('rulesList').innerHTML + el('historyBody').innerHTML
    assert.doesNotMatch(html, /parametric\./, 'a key name reached the page instead of the sentence')
    assert.match(html, /Nothing was moved/)
    assert.match(html, /will not proceed until it is cleared/)
  })

  it('shows the catalogue translation in its place when one exists', async () => {
    const loaded = await loadParametric({
      catalog: { 'parametric.screening_blocked': 'Imepatiliwa: mwingiliano wa mioto hufuatilii inahitaji ukaguzi wa kufuata sheria.' },
      routes: {
        '/simulate': ok(SIM('blocked')),
        '/parametric-rules': ok(RULES),
        '/parametric-disbursements': ok(DISBURSEMENTS),
      },
    })
    await simulate({ recipient: 'Turkana County Water Authority' })
    assert.match(el('simResult').innerHTML, /Imepatiliwa/, 'the surface ignored the catalogue and rendered its own fallback')
    assert.ok(loaded.asked.includes('parametric.screening_blocked'))
  })

  it('rebuilds the panels it generated when the locale changes', async () => {
    // The shared runtime re-applies `data-i18n` to the markup, which is why a
    // locale switch appears to work even on a surface that renders half its
    // strings as innerHTML. The rule cards, the history rows and the result
    // panel are not in the document as elements with attributes; only a handler
    // that redraws them moves them into the new language.
    await loadParametric({
      catalog: {},
      routes: {
        '/simulate': ok(SIM('blocked')),
        '/parametric-rules': ok(RULES),
        '/parametric-disbursements': ok(DISBURSEMENTS),
      },
    })
    await simulate({ recipient: 'Turkana County Water Authority' })
    assert.match(el('simResult').innerHTML, /Nothing was moved/)

    await el('locale-select').fire('change', { target: { value: 'en' } })
    assert.match(el('historyBody').innerHTML, /screened clear/)
    assert.match(el('rulesList').innerHTML, /Triggers when/)
    assert.match(el('simResult').innerHTML, /Nothing was moved/,
      'the last simulation was dropped by the language switch rather than redrawn')
  })

  it('keeps the trigger number and its unit out of the translator’s reach', async () => {
    // `Rainfall (mm)` is compared against a server-side number in millimetres.
    // A translation that renames the unit turns a comparison into a guess, so
    // the unit is part of the value the test pins rather than a word to move.
    await loadParametric({ routes: { '/parametric-rules': ok(RULES) } })
    const html = el('rulesList').innerHTML
    assert.match(html, /Rainfall \(mm\)/)
    assert.match(html, /≥ 50/, 'the threshold itself is a value from the API, not a string')
  })
})

// ================================================================
// The markup and the selector
// ================================================================

/** What a browser would find: the keys the shipped markup puts into the DOM. */
function markupKeys() {
  return [...new Set([...HTML.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1]))]
}

describe('parametric i18n — the markup and the language selector', () => {
  it('every key the markup names is in the staged catalogue', () => {
    const missing = markupKeys().filter((k) => !(k in STAGE))
    assert.deepEqual(missing, [], 'the shared runtime renders an unknown key as the key name')
  })

  it('the staged catalogue carries no key the markup never asks for', () => {
    const orphans = Object.keys(STAGE).filter((k) => !markupKeys().includes(k) && !JS_ONLY.has(k))
    assert.deepEqual(orphans, [], 'a staged string nothing renders is a translation nobody can check')
  })

  it('offers only locales whose catalogue renders every string the page names', () => {
    const select = HTML.match(/<select[^>]*id="locale-select"[^>]*>([\s\S]*?)<\/select>/)
    assert.ok(select, 'the page has no locale selector, so its reader cannot change language at all')
    const offered = [...new Set([...select[1].matchAll(/<option\s+value="([a-z]{2,3})"/g)].map((m) => m[1]))]
    assert.ok(offered.includes('en'), 'English is the base layer every other catalogue falls back to')

    const keys = markupKeys()
    for (const code of offered) {
      // Every code is read from disk, because those files exist and a string
      // they lack is one the reader would see as a key name. English used to be
      // read as a pending merge rather than from the file, back when its keys
      // lived in a staging file rather than in `en.json`.
      const locale = readJson(`${code}.json`)
      const missing = keys.filter((k) => !(k in locale))
      assert.deepEqual(missing, [],
        `${code} is offered and cannot render ${missing.length} of the ${keys.length} strings this page shows`)
    }
  })
})

/** Keys the script needs that no static attribute can carry. */
const JS_ONLY = new Set([
  'parametric.add_rule', 'parametric.col_chain', 'parametric.col_amount', 'parametric.col_status',
  'parametric.error_name_required', 'parametric.error_rule_required', 'parametric.history_empty',
  'parametric.meta_focal_approval', 'parametric.meta_releases', 'parametric.meta_triggers_when',
  'parametric.not_screened', 'parametric.result_simulated', 'parametric.result_tx_local',
  'parametric.result_tx_ref', 'parametric.rules_empty', 'parametric.screened_clear',
  'parametric.screening_blocked', 'parametric.screening_clear', 'parametric.screening_heading',
  'parametric.screening_not_screened', 'parametric.screening_unknown', 'parametric.sim_complete',
  'parametric.sim_nothing_moved', 'parametric.approval_required', 'parametric.approval_not_required',
  'parametric.metric_precipitation', 'parametric.metric_temperature', 'parametric.metric_conflict',
])

// ================================================================
// The gate, over a tree this surface's staged map is merged into
// ================================================================

/**
 * A runnable copy of the check over a copy of the tree it reads.
 *
 * `public/i18n/en.json` is not edited here; it is copied as it ships, which is
 * the only state worth a gate run. Only this surface's markup and the CHW page
 * the script reads unconditionally are copied — the other surfaces would make
 * this run assert about their layers too.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-i18n-parametric-'))
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'scripts', 'check-i18n.mjs'), path.join(dir, 'scripts', 'check-i18n.mjs'))
  fs.mkdirSync(path.join(dir, 'public', 'i18n'), { recursive: true })
  for (const file of fs.readdirSync(path.join(PUBLIC_ROOT, 'i18n'))) {
    if (file.endsWith('.json')) fs.cpSync(path.join(PUBLIC_ROOT, 'i18n', file), path.join(dir, 'public', 'i18n', file))
  }
  for (const sub of ['parametric', 'chw']) {
    fs.mkdirSync(path.join(dir, 'public', sub), { recursive: true })
    fs.cpSync(path.join(PUBLIC_ROOT, sub, 'index.html'), path.join(dir, 'public', sub, 'index.html'))
  }
  try {
    const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts', 'check-i18n.mjs')], { encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' }
  }
}

describe('parametric i18n — the gate over the merged tree', () => {
  it('passes, and reports this surface as complete', () => {
    const result = sandbox()
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /i18n ok/)
    assert.match(result.stdout, /^ {2}parametric\s+en\s+complete$/m,
      'the surface renders every string it shows, in the one language it offers')
  })

  it('is no longer counted as a surface with no i18n layer', () => {
    const { stdout } = sandbox()
    assert.doesNotMatch(stdout, /surfaces with no i18n layer at all:[^\n]*\bparametric\b/,
      'the layer is present and the gate says so; this note is what hid it')
  })

  it('fails the moment the surface offers a language it cannot render', () => {
    // The regression this file is worth having. Swahili covers 93% of the
    // catalogue overall and none of the parametric namespace, so it would pass
    // a coverage check and still put key names on every label.
    const sw = readJson('sw.json')
    assert.equal(sw['parametric.screening_blocked'], undefined)
    const offered = /<option value="en">English<\/option>\s*<option value="sw">Swahili<\/option>/.test(HTML)
    assert.equal(offered, false, 'Swahili was offered on a page that carries no parametric strings')
  })
})
#!/usr/bin/env node
/**
 * The districts surface's i18n layer, and the two failures it exists to prevent.
 *
 * `scripts/check-i18n.mjs` was written after a health worker saw literal key
 * names as button labels: a surface offered nine languages and had strings for
 * three. Those two failures — a key no catalogue carries, and a locale a page
 * offers but cannot render — are invisible to every other check on the tree, so
 * they are asserted here directly, against the shipped data rather than against
 * the wording of the source.
 *
 * `public/i18n/en.json` carries this surface's namespace. It did not always:
 * the keys lived in `_stage-districts.json` until the merge landed, and the
 * fixture was deleted with the merge. The tests below read the slice of `en.json`
 * under `districts.` rather than a staged file, so there is no second copy of
 * these strings to drift and no fixture whose removal has to be remembered.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { before, describe, it } from 'node:test'
import { installModuleResolution } from './browser-env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')
const NAMESPACE = 'districts.'

/** This surface's own keys, read out of the catalogue that ships them. */
const staged = Object.fromEntries(
  Object.entries(JSON.parse(fs.readFileSync(path.join(PUBLIC, 'i18n', 'en.json'), 'utf8')))
    .filter(([key]) => key.startsWith(NAMESPACE)),
)
const districtsHtml = fs.readFileSync(path.join(PUBLIC, 'districts', 'index.html'), 'utf8')
const districtsJs = fs.readFileSync(path.join(PUBLIC, 'districts', 'app.js'), 'utf8')

/** Every key the page puts into the DOM, by name. */
const htmlKeys = [...new Set(
  [...districtsHtml.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1]),
)].sort()

/** Every key the page's own code asks for, by name. */
const jsKeys = [...new Set(
  [...districtsJs.matchAll(/\bt\(\s*'(districts\.[a-z0-9_.]+)'/g)].map((m) => m[1]),
)].sort()

const offered = [...new Set(
  [...districtsHtml.matchAll(/<select[^>]*id="locale-select"[^>]*>([\s\S]*?)<\/select>/g)]
    .flatMap((m) => [...m[1].matchAll(/<option\s+value="([a-z]{2,3})"/g)].map((o) => o[1])),
)]

/**
 * The catalogue a locale renders this surface with, read as it ships.
 *
 * English used to be a merge of `en.json` and a staged file. That merge is what
 * shipped, so the special case is gone: one catalogue per language, no second
 * copy of the same English to drift against the first.
 */
const catalogueFor = (code) => JSON.parse(fs.readFileSync(path.join(PUBLIC, 'i18n', `${code}.json`), 'utf8'))

// ---------------------------------------------------------------
// A browser module sandbox, so the assertions run the real render
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
    children: [],
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute: (k) => (k in this.attrs ? this.attrs[k] : null),
    removeAttribute(k) { delete this.attrs[k] },
    append() {},
    appendChild() {},
    removeChild() { this.children = this.children.filter((c) => c !== arguments[0]) },
    replaceChildren() { this.children = [] },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    focus() {},
    remove() { this.children = [] },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  }
}

const byId = new Map()
const stubLocation = { hash: '', href: 'http://localhost/', pathname: '/districts' }

installModuleResolution()
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  location: stubLocation,
}
globalThis.location = stubLocation
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.document = {
  getElementById: (id) => {
    if (!byId.has(id)) byId.set(id, stubElement())
    return byId.get(id)
  },
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (tag) => stubElement(tag),
  documentElement: stubElement('html'),
  body: stubElement('body'),
  readyState: 'complete',
  addEventListener() {},
}
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })

/** Put a catalogue in place the way `initI18n` would, then ask the page to render. */
const withCatalog = (catalog) => { globalThis.window.__i18n = { catalog } }

describe('districts i18n — every key the surface shows has a source', () => {
  it('stages a string for every key the page puts in the DOM', () => {
    assert.ok(htmlKeys.length, 'the page names no keys, so there is no layer to check')
    for (const key of htmlKeys) {
      assert.ok(key.startsWith('districts.'), `${key} is outside this surface's namespace`)
      assert.equal(typeof staged[key], 'string', `${key} is in the page and in no catalogue`)
    }
  })

  it('stages a string for every key the page asks for by name', () => {
    for (const key of jsKeys) {
      assert.equal(typeof staged[key], 'string',
        `${key} is asked for with no English to fall back to, so no language can translate it`)
    }
  })

  it('carries every English fallback, not just the key', () => {
    // An empty string resolves to nothing under the shared runtime and renders a
    // blank heading, which is quieter than a key name and just as wrong.
    for (const [key, value] of Object.entries(staged)) {
      assert.ok(value.trim().length > 0, `${key} is staged as empty`)
    }
  })

  it('stages nothing the surface stopped using', () => {
    // A staged key with no caller is not harmless: a translator pays for it and
    // no reader ever sees it.
    const used = new Set([...htmlKeys, ...jsKeys])
    assert.deepEqual(Object.keys(staged).filter((k) => !used.has(k)).sort(), [],
      'the staged catalogue has drifted from the surface')
  })

  it('offers only languages whose catalogue renders every string the page names', () => {
    assert.ok(offered.includes('en'), 'English is the one rendering that is always complete')
    for (const code of offered) {
      const locale = catalogueFor(code)
      const missing = htmlKeys.filter((k) => !(k in locale))
      assert.deepEqual(missing, [],
        `${code} is offered and cannot render ${missing.length} of the ${htmlKeys.length} strings this page names`)
    }
    // Every catalogue the picker does not offer is one the surface cannot
    // render yet, which is why the picker is short. Named so that widening it is
    // a decision somebody can see they are making.
    for (const code of ['am', 'ar', 'din', 'fr', 'km', 'nk', 'pt', 'so', 'sw']) {
      if (offered.includes(code)) continue
      const covered = htmlKeys.filter((k) => k in catalogueFor(code)).length
      assert.ok(covered < htmlKeys.length,
        `${code} now renders every string this page names and is being withheld for no reason`)
    }
  })
})

describe('districts i18n — t() renders English rather than the key', () => {
  let buildSvgMap

  before(async () => {
    withCatalog({})
    buildSvgMap = (await import(new URL('districts/app.js', `file://${PUBLIC}/`).href)).buildSvgMap
  })

  const district = { name: 'Jubaa', center: { lat: -1.28, lon: 36.81 } }
  const at = (latitude) => ({ latitude, longitude: 36.8, severity: 'high', event_type: 'flood' })

  it('draws an English map label with an empty catalogue', () => {
    withCatalog({})
    const svg = buildSvgMap(district, [at(-1.28), at(0)])
    assert.match(svg, /Map of Jubaa: 2 recorded locations plotted/)
    assert.doesNotMatch(svg, /districts\./,
      'an unresolved key renders as its own name on the page, which is the failure this layer prevents')
  })

  it('draws the catalogue\'s language when the catalogue has one', () => {
    withCatalog({
      'districts.map_label': 'Mapi ya {name}: vituo {n} vilivyorekodiwa vimechorwa{shortfall}, kituo cha wilaya kimewekewa alama',
      'districts.locations': 'vituo',
    })
    const svg = buildSvgMap(district, [at(-1.28)])
    assert.match(svg, /Mapi ya Jubaa: vituo 1 vilivyorekodiwa vimechorwa/)
    assert.match(svg, /kituo cha wilaya kimewekewa alama/)
  })

  it('interpolates into the sentence in either language', () => {
    // Two plotted, one with no usable pair — the case the shortfall sentence exists for.
    const records = [at(-1.28), at(0), { severity: 'low' }]
    withCatalog({
      'districts.unplaced_one': 'rekodi {n} haikuwa na maana za eneo',
      'districts.unplaced_many': 'rekodi {n} hazikuwa na maana za eneo',
    })
    assert.match(buildSvgMap(district, records), /plotted; rekodi 1 haikuwa na maana za eneo/)
    withCatalog({})
    assert.match(buildSvgMap(district, records),
      /1 record had no usable coordinates and is not shown, with the district centre marked/)
  })

  it('leaves an unknown placeholder visible rather than blanking the sentence', () => {
    withCatalog({ 'districts.map_label': 'Mapi ya {name}: {n} vituo{shortfall}, {perod}' })
    const svg = buildSvgMap(district, [at(-1.28)])
    assert.match(svg, /\{perod\}/, 'a mistyped placeholder should be visible to whoever mistyped it')
  })
})

describe('districts i18n — the gate, over the tree as it will be', () => {
  /** A copy of the tree as it ships. */
  function sandbox(mutate) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-districts-i18n-'))
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.cpSync(path.join(ROOT, 'scripts', 'check-i18n.mjs'), path.join(dir, 'scripts', 'check-i18n.mjs'))
    fs.mkdirSync(path.join(dir, 'public', 'i18n'), { recursive: true })
    for (const file of fs.readdirSync(path.join(PUBLIC, 'i18n'))) {
      if (file.endsWith('.json') && !file.startsWith('_')) {
        fs.cpSync(path.join(PUBLIC, 'i18n', file), path.join(dir, 'public', 'i18n', file))
      }
    }
    for (const sub of fs.readdirSync(PUBLIC)) {
      const html = path.join(PUBLIC, sub, 'index.html')
      if (fs.existsSync(html)) {
        fs.mkdirSync(path.join(dir, 'public', sub), { recursive: true })
        fs.cpSync(html, path.join(dir, 'public', sub, 'index.html'))
      }
    }
    mutate?.(dir)
    try {
      const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts', 'check-i18n.mjs')], { encoding: 'utf8' })
      return { code: 0, stdout, stderr: '' }
    } catch (err) {
      return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' }
    }
  }

  it('passes the offered-locale rule for districts', () => {
    const result = sandbox()
    assert.doesNotMatch(result.stderr, /✖ districts/,
      'the districts surface is offered a language it cannot render')
    assert.match(result.stdout, /^\s+districts\s+en\s+complete$/m)
  })

  it('is no longer counted among the surfaces with no i18n layer', () => {
    const { stdout } = sandbox()
    const line = stdout.match(/surfaces with no i18n layer at all: (.*)/)?.[1] ?? ''
    assert.ok(!/\bdistricts\b/.test(line), `districts still reads as unlayered: "${line}"`)
  })

  it('asks for no key the shipped catalogue cannot source', () => {
    const { stdout } = sandbox()
    // The gate only prints the note when there is something to name, so an
    // absent line is the pass. A key no catalogue defines is a string no
    // language can ever translate.
    assert.doesNotMatch(stdout, /districts asks for \d+ key\(s\) no catalogue defines/)
  })

  it('still refuses if the surface offered a language it cannot render', () => {
    // The gate is the guard, and a guard nobody has seen fail is not known to
    // work: add a language to the picker with no catalogue behind it and the
    // districts surface has to be the thing that catches it.
    const result = sandbox((dir) => {
      const p = path.join(dir, 'public', 'districts', 'index.html')
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(
        '<option value="en">English</option>',
        '<option value="en">English</option>\n        <option value="so">Soomaali</option>'))
    })
    assert.match(result.stderr, /districts offers "so"/)
    assert.match(result.stderr, /districts\.skip_link/)
  })
})
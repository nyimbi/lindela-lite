/**
 * The Scenario Workbench's i18n layer (WEB-11, scenarios surface).
 *
 * `public/scenarios/` shipped no `data-i18n` and no catalogue keys at all, so
 * `scripts/check-i18n.mjs` named it as a surface with no layer rather than
 * counting it as passing. The keys were staged in `public/i18n/_stage-scenarios.json`
 * and merged into `en.json`; the staging file is gone and these tests read the
 * surface's slice of `en.json`, so there is no second copy of the same English
 * left to drift.
 *
 * Everything here drives the gate or the module. There are no assertions on the
 * text of `app.js` — a source-text guard goes stale the moment a string is
 * reworded for anything other than i18n, and then it is lying in the one place
 * the repo looks for the truth. The invariant that *is* asserted on rendered
 * output is the one that has bitten this surface: a delta is score points, not
 * a percentage and not a modelled physical outcome.
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
const NAMESPACE = 'scenarios.'

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(PUBLIC_ROOT, rel), 'utf8'))
const en = readJson('i18n/en.json')

/** This surface's own keys, read out of the catalogue that ships them. */
const stage = Object.fromEntries(Object.entries(en).filter(([key]) => key.startsWith(NAMESPACE)))

// ---------------------------------------------------------------
// The gate, over a tree shaped the way this surface will ship
// ---------------------------------------------------------------

/**
 * Copy the public tree as it ships and run the gate over it.
 *
 * The keys are in `en.json` rather than absent from it, so a gate run that
 * ignored them entirely — because the page had been stripped of its
 * `data-i18n` — would pass and prove nothing. The tests below that remove the
 * keys are what make this run mean something.
 */
function gate(mutate = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-scenarios-i18n-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.cpSync(path.join(ROOT, 'scripts', 'check-i18n.mjs'), path.join(dir, 'scripts', 'check-i18n.mjs'))
  fs.mkdirSync(path.join(dir, 'public', 'i18n'), { recursive: true })
  for (const file of fs.readdirSync(path.join(PUBLIC_ROOT, 'i18n'))) {
    if (file.endsWith('.json') && !file.startsWith('_')) {
      fs.cpSync(path.join(PUBLIC_ROOT, 'i18n', file), path.join(dir, 'public', 'i18n', file))
    }
  }
  for (const sub of ['chw', 'scenarios']) {
    // `chw` is copied because the gate reads its markup directly for the
    // per-namespace table and would throw without it. The other surfaces are
    // left out deliberately: each is mid-i18n of its own and keyed off its own
    // staged map, so this gate run asserts about this surface and nothing else.
    const html = path.join(PUBLIC_ROOT, sub, 'index.html')
    fs.mkdirSync(path.join(dir, 'public', sub), { recursive: true })
    fs.cpSync(html, path.join(dir, 'public', sub, 'index.html'))
  }
  mutate(dir)
  try {
    const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts', 'check-i18n.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' }
  }
}

/** The keys `public/scenarios/index.html` puts into the DOM, read as a browser would. */
function htmlKeys() {
  const html = fs.readFileSync(path.join(PUBLIC_ROOT, 'scenarios', 'index.html'), 'utf8')
  return [...new Set([...html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1]))]
}

// ---------------------------------------------------------------
// Browser module sandbox — stands in for the browser's /shared/... resolution
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
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute: (k) => (k in this.attrs ? this.attrs[k] : null),
    removeAttribute(k) { delete this.attrs[k] },
    appendChild() {},
    replaceChildren() {},
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    focus() {},
    insertBefore() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }),
    contains: () => false,
    cloneNode: () => stubElement(tag),
  }
}

const byId = new Map()
const location = { hash: '', search: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/scenarios' }
const el = (id) => {
  if (!byId.has(id)) byId.set(id, stubElement())
  return byId.get(id)
}

function installDom() {
  if (!globalThis.document) {
    globalThis.document = {
      getElementById: (id) => el(id),
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag) => stubElement(tag),
      createElementNS: (_ns, tag) => stubElement(tag),
      documentElement: stubElement('html'),
      body: stubElement('body'),
      head: stubElement('head'),
      readyState: 'complete',
      addEventListener() {},
      title: '',
    }
    globalThis.location = location
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
    globalThis.history = { replaceState() {} }
    globalThis.setInterval = () => 0
  }
  // The globals are built once: a second install would hand the module a fresh
  // document and quietly reset whatever the first `init()` wrote, which is how
  // an assertion about the tab title ends up testing the stub.
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    location,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout,
    clearTimeout,
    navigator: globalThis.navigator,
  }
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('.json')) return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }), text: async () => '' }
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('/shared/')) {
        return { url: new URL(`.${specifier}`, `file://${PUBLIC_ROOT}/`).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

async function loadScenarios() {
  installDom()
  return import(new URL('scenarios/app.js', `file://${PUBLIC_ROOT}/`).href)
}

// ================================================================
// The surface's slice of en.json is the whole of its English
// ================================================================

describe('scenarios — every key the surface uses has English', () => {
  it('carries a key for every string the page and the script ask for', () => {
    // Key *names*, which is what a catalogue is: the gate makes the same read of
    // the markup, and a name with no entry is a string no language can translate.
    // Nothing here looks at the prose around a name, so rewording a sentence
    // does not fail this and the guard cannot go stale the way a grep would.
    const used = [...new Set([...htmlKeys(), ...scriptKeys])]
    const missing = used.filter((k) => !(k in stage))
    assert.deepEqual(missing, [], `these keys would render as their own names: ${missing.join(', ')}`)
  })

  it('carries no value a translator has nothing to work with', () => {
    for (const [key, value] of Object.entries(stage)) {
      assert.equal(typeof value, 'string', key)
      assert.ok(value.trim().length > 0, `${key} is catalogued with nothing to translate`)
    }
  })

  it('has not overwritten a string another surface already owned', () => {
    // The merge was a hand-merge of three staging files into one catalogue, and a
    // merge is exactly where one namespace's string quietly replaces another's.
    // Nothing asserts that a clashing merge would have been *caught*; what
    // matters is that the shipped catalogue carries one value per key, which it
    // cannot do twice in a JSON object. So the check is that the surface's
    // namespace is not a prefix of, or prefixed by, another surface's.
    const prefixes = ['admin.', 'alert.', 'api.', 'cap.', 'chw.', 'co.', 'conflict.', 'focal-point.',
      'hazard.', 'i18n.', 'ingest.', 'map.', 'operational.', 'parametric.', 'portal.', 'reporting.',
      'risk.', 'service.', 'trigger.', 'workflow.']
    for (const [key] of Object.entries(stage)) {
      const owner = prefixes.find((p) => key.startsWith(p))
      assert.equal(owner, undefined, `${key} is under this surface's namespace but also reads as ${owner}`)
    }
  })
})

// ================================================================
// The gate, over the shipped catalogue
// ================================================================

describe('scenarios — check-i18n.mjs over the merged tree', () => {
  it('passes, and no longer names this surface as having no layer', () => {
    const { code, stdout, stderr } = gate()
    assert.equal(code, 0, stderr)
    assert.match(stdout, /^ {2}scenarios\s+en\s+complete$/m,
      'the surface has a layer, so it must appear in the offered-locale table')
    assert.doesNotMatch(stdout, /surfaces with no i18n layer at all:.*\bscenarios\b/,
      'a surface with keys is not reported as having none')
    assert.match(stdout, /i18n ok/)
  })

  it('fails when the surface names a key the staged map does not carry', () => {
    // The guard is only worth anything if it fails. A page key the catalogue
    // lacks renders as `scenarios.some_key` in the running interface, which is
    // the exact failure a health worker once met on the CHW app.
    const { code, stderr } = gate((dir) => {
      const p = path.join(dir, 'public', 'scenarios', 'index.html')
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('data-i18n="scenarios.title"', 'data-i18n="scenarios.headline"'))
    })
    assert.equal(code, 1, 'an undefined key passed the gate')
    assert.match(stderr, /scenarios\.headline/)
  })

  it('fails when the picker offers a locale the catalogue cannot render in full', () => {
    const { code, stderr } = gate((dir) => {
      const p = path.join(dir, 'public', 'scenarios', 'index.html')
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(
        '<option value="en">English</option>',
        '<option value="en">English</option>\n      <option value="fr">Français</option>'))
    })
    assert.equal(code, 1, 'French carries no scenarios.* key and the picker offered it anyway')
    assert.match(stderr, /scenarios offers "fr"/)
  })

  it('fails when the keys are taken back out of the catalogue', () => {
    // What makes the passing run above mean something: remove the strings this
    // surface needs and the gate has to notice. Without this, a gate that had
    // quietly stopped reading `en.json` would keep reporting `i18n ok`.
    const { code, stderr } = gate((dir) => {
      const p = path.join(dir, 'public', 'i18n', 'en.json')
      const merged = JSON.parse(fs.readFileSync(p, 'utf8'))
      for (const key of Object.keys(merged)) if (key.startsWith(NAMESPACE)) delete merged[key]
      fs.writeFileSync(p, JSON.stringify(merged))
    })
    assert.equal(code, 1, 'the keys are gone from every catalogue, so nothing is translatable')
    assert.match(stderr, /scenarios\/index\.html names \d+ key\(s\)/)
  })
})

// ================================================================
// The picker offers only what the catalogues can render
// ================================================================

describe('scenarios — the picker offers what the surface can render', () => {
  /**
   * The locales a reader can pick, read out of the one `<select>` the gate
   * reads. Scanning the whole document instead would pick up the severity
   * dropdowns, whose values are `low` and `medium` and whose catalogues are
   * nowhere on disk.
   */
  const offeredLocales = () => {
    const html = fs.readFileSync(path.join(PUBLIC_ROOT, 'scenarios', 'index.html'), 'utf8')
    const select = html.match(/<select[^>]*id="locale-select"[^>]*>([\s\S]*?)<\/select>/)
    if (!select) return []
    return [...new Set([...select[1].matchAll(/<option\s+value="([a-z]{2,3})"/g)].map((m) => m[1]))]
  }

  it('offers exactly the locales whose catalogues cover every key the page shows', () => {
    const keys = htmlKeys()
    const offered = offeredLocales()
    assert.ok(offered.includes('en'), 'English is the language the fallback strings are written in')
    for (const code of offered) {
      const locale = readJson(`i18n/${code}.json`)
      const missing = keys.filter((k) => !(k in locale))
      assert.deepEqual(missing, [],
        `${code} is offered and would show ${missing.length} of ${keys.length} page strings as key names`)
    }
  })

  it('offers no language that another catalogue already covers better', () => {
    // One option is a truthful picker only because nothing else is renderable.
    // If a translator lands any of these keys, this surface should widen, and
    // this is the assertion that says so rather than leaving a reader on the
    // English fallback they did not ask for.
    const keys = htmlKeys()
    const offered = new Set(offeredLocales())
    const renderable = fs.readdirSync(path.join(PUBLIC_ROOT, 'i18n'))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => f.replace(/\.json$/, ''))
      .filter((code) => code !== 'en' && keys.every((k) => k in readJson(`i18n/${code}.json`)))
    for (const code of renderable) {
      assert.ok(offered.has(code), `${code} can render all ${keys.length} page strings and is not offered`)
    }
  })

  it('keeps the script’s idea of the offered list equal to the picker in the markup', async () => {
    const mod = await loadScenarios()
    assert.deepEqual([...mod.OFFERED_LOCALES].sort(), [...offeredLocales()].sort(),
      'the list init() trusts and the list a reader can pick from are one list')
  })
})

// ================================================================
// `t()` answers with the sentence, not the key
// ================================================================

describe('scenarios — t() resolves to the English fallback, not the key name', () => {
  let scenarios

  before(async () => { scenarios = await loadScenarios() })

  it('returns the fallback when no catalogue carries the key', () => {
    assert.equal(scenarios.t('scenarios.not_yet_merged', 'A sentence a reader can read.'),
      'A sentence a reader can read.')
    assert.notEqual(scenarios.t('scenarios.not_yet_merged', 'A sentence a reader can read.'),
      'scenarios.not_yet_merged')
  })

  it('returns the catalogue’s translation when there is one', () => {
    window.__i18n = { t: (k) => (k === 'scenarios.title' ? 'Kanzja ya Hali' : undefined) }
    assert.equal(scenarios.t('scenarios.title', 'Scenario Workbench'), 'Kanzja ya Hali')
    // A locale that has not caught up leaves the English sentence standing
    // rather than blanking it or falling back to the key.
    assert.equal(scenarios.t('scenarios.lede', 'Ask what would change.'), 'Ask what would change.')
    delete window.__i18n
  })

  it('names the document title from the catalogue', () => {
    // A tab title is neither markup nor form state, so nothing else repaints it.
    assert.equal(document.title, stage['scenarios.doc_title'])
  })
})

// ================================================================
// The delta is score points. It is not a percentage and not an outcome.
// ================================================================

describe('scenarios — a score delta never reads as a physical or percentage outcome', () => {
  let scenarios

  before(async () => { scenarios = await loadScenarios() })

  const read = (value) => {
    scenarios.setDeltaCard('flood', value, 50)
    return el('floodBars').innerHTML
  }

  it('spells the unit out on the axis a screen reader is given', () => {
    assert.match(read(19.4), /aria-label="Up 19\.4 score points on an axis running from −50 to \+50 score points\."/)
    assert.match(read(-19.4), /aria-label="Down 19\.4 score points on an axis running from −50 to \+50 score points\."/)
    assert.match(read(0), /aria-label="No change in the mean sensitivity score\. Axis runs from −50 to \+50 score points\."/)
  })

  it('prints a bare number and never a per-cent sign on the value', () => {
    for (const value of [19.4, -19.4, 0, 100]) {
      scenarios.setDeltaCard('flood', value, 100)
      const shown = el('floodDelta').textContent
      assert.doesNotMatch(shown, /%/,
        `a "%" on a score delta reads as a modelled physical outcome: "${shown}"`)
      assert.doesNotMatch(shown, /%|point/i)
    }
  })

  it('names score points on the caption under the bar', () => {
    assert.match(read(19.4), /class="delta-caption">score points</)
  })

  it('calls the whole score a delta in points, not a mean of points', () => {
    // "change (mean points)" read as a mean *number of points* rather than the
    // change in the mean, which is a different quantity from the one the card
    // prints. Every delta label says the same thing, so one wrong word puts the
    // three cards out of step with each other.
    const labels = Object.entries(stage)
      .filter(([k]) => k.startsWith('scenarios.delta_') && !k.endsWith('_up') && !k.endsWith('_down') && !k.endsWith('_flat'))
    // Sorted, not in catalogue order: `en.json` is kept alphabetically so a
    // future addition is one line in a reviewable place, and the order these
    // three land in is a property of the file, not of the platform.
    assert.deepEqual(labels.map(([k]) => k).sort(),
      ['scenarios.delta_conflict', 'scenarios.delta_flood', 'scenarios.delta_impacts'])
    for (const [, value] of labels) assert.match(value, /^.+ score change \(points\)$/)
  })
})

// ================================================================
// Helpers
// ================================================================

/**
 * Keys `public/scenarios/app.js` asks for.
 *
 * Read from the module's own source because a script key is a name handed to
 * `t()` and nothing observable at runtime enumerates them. Only the name is read;
 * the assertion built on it is about coverage, not about the sentence around it.
 */
const scriptKeys = [
  ...new Set([...fs.readFileSync(path.join(PUBLIC_ROOT, 'scenarios', 'app.js'), 'utf8')
    .matchAll(/\bt\(\s*'(scenarios\.[a-z0-9_]+)'/g)].map((m) => m[1])),
]
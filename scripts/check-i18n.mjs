#!/usr/bin/env node
/**
 * i18n completeness and coverage guard.
 *
 * A surface can offer a language it cannot render. The CHW app offered nine
 * languages and had CHW strings for three, so a health worker selecting
 * Karimojong or Français was shown literal key names as button labels —
 * `chw.symptom_fever`, `chw.submit`, `chw.back` — for the whole reporting flow.
 *
 * This exists because that failure is invisible to every other check. The
 * element exists, the text content is non-empty, there are no console errors,
 * and the flow still submits correctly. Only reading the screen shows that a
 * health worker in the field cannot read the app.
 *
 * Three rules, then an honest report of what is still missing:
 *
 *  1. Every key a surface puts in the DOM exists in `en.json`. The shared
 *     runtime resolves a missing key to the key itself (`catalog[key] || key`),
 *     so a key absent from every catalogue is a key name on a page.
 *  2. A surface may only offer a locale whose catalogue renders every string
 *     that surface's markup names. Partial coverage is not localisation, and
 *     the floor is 100% of the strings the surface actually shows, not 100% of
 *     the catalogue — a surface that shows six strings is not required to have
 *     translated the other 221.
 *  3. Every locale file covers at least `COVERAGE_FLOOR` keys of `en.json`.
 *     Those numbers are measured, not targets. Coverage ran 17%–92% and nothing
 *     looked at it, so it fell and stayed fallen; a floor is what makes the next
 *     deletion of a translated string visible.
 *  4. Every key in `en.json` is reachable from some source file. A key no
 *     surface can ask for is a string every locale is measured against and no
 *     reader can ever see — and it inflates the floor in rule 3, so the coverage
 *     number counts translations of strings that do not exist. R-72: 21 such
 *     keys, four of them `nav.*` entries for a navigation the navbar stopped
 *     having.
 *
 *     The hard part is not finding them but *not* finding the ones assembled at
 *     runtime. Three keys are reached only through a template — `workflow.${type}`,
 *     `playbook.status.${status}`, `map.field_${reason.field}` — so the rule
 *     derives its prefix set from the source and filters it to prefixes that name
 *     a namespace the catalogue actually has. `token_${n}` in `src/auth.js` names
 *     no i18n key and must not excuse one. The derived prefixes are printed on
 *     every run, because a prefix is a blocklist and a new one that spans a whole
 *     namespace would silently excuse every key under it.
 *
 * What is deliberately not a failure:
 *  - A surface with no `data-i18n` at all. Three have none and cannot be wired
 *    here; they are named in the output instead of being silently counted as
 *    passing.
 *  - `KNOWN_UNTRANSLATED`, the short list of strings an offered locale genuinely
 *    lacks. Named, printed, and counted: an entry that is fixed must be deleted,
 *    and a *new* missing key fails rather than joining the list by default.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(import.meta.dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const LOCALE_DIR = path.join(PUBLIC, 'i18n')

/**
 * Keys each locale must keep covering, measured 2026-10-03. These may only go
 * up; lowering one is a deliberate act, not a side effect of a merge.
 */
const COVERAGE_FLOOR = {
  // Raised 2026-10-09 to the measured count after the alert-where and
  // playbook-status strings were translated into sw (281 keys). The floors are
  // a ratchet, not a target: coverage may only go up, and each raise is a
  // deliberate act recorded here.
  //
  // Lowered sw 281 -> 269 on 2026-10-15, and this is the one case where a
  // lowering is not a step backwards. The 281 counted the 12 keys under sw that
  // rule 4 has now deleted as unreachable, so it was a floor over strings no
  // reader can see: sw translated them, and nothing could ask for them. Its
  // coverage of the keys that *are* reachable is 269 both before and after the
  // deletion — measured, not assumed — so the ratchet is intact and the number
  // simply stopped counting dead entries. Every other floor sits below its
  // locale's live coverage and is unchanged.
  am: 38,
  ar: 54,
  din: 57,
  fr: 38,
  km: 54,
  nk: 54,
  pt: 38,
  so: 100,
  sw: 269,
}

/**
 * Strings an offered locale is known not to render. Every entry is debt with a
 * name on it; the count is printed with every run so it cannot quietly grow.
 */
const KNOWN_UNTRANSLATED = {
  chw: { so: ['footer.powered'] },
}

/** The namespace whose coverage the per-surface table reports. */
const OWN_NAMESPACE = {
  chw: 'chw',
  co: 'co',
  portal: 'portal',
  'focal-point': 'focal-point',
}

function loadLocale(code) {
  const p = path.join(LOCALE_DIR, `${code}.json`)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (error) {
    throw new Error(`public/i18n/${code}.json is not valid JSON: ${error.message}`)
  }
}

function localeFiles() {
  return fs.readdirSync(LOCALE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
}

/** Language codes offered by a surface's own selector. */
function offeredLocales(html, selectorId = 'locale-select') {
  const select = html.match(new RegExp(`<select[^>]*id="${selectorId}"[^>]*>([\\s\\S]*?)</select>`))
  if (!select) return []
  return [...new Set([...select[1].matchAll(/<option\s+value="([a-z]{2,3})"/g)].map((m) => m[1]))]
}

/** i18n keys a surface puts into the DOM. */
function usedKeys(html, prefix) {
  const all = [...html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1])
  return [...new Set(all.filter((k) => prefix ? k.startsWith(prefix) : true))].sort()
}

/**
 * Keys a surface's JavaScript asks for by name. Not a rendering failure on their
 * own — each surface's `t()` carries an English fallback — but a key no
 * catalogue carries is a string no language can ever translate, so they are
 * reported.
 */
function scriptKeys(dir) {
  const file = path.join(PUBLIC, dir, 'app.js')
  if (!fs.existsSync(file)) return []
  const js = fs.readFileSync(file, 'utf8')
  return [...new Set([...js.matchAll(/\bt\(\s*'([a-z][a-z0-9_-]*\.[a-z0-9_.]+)'/g)].map((m) => m[1]))].sort()
}

/**
 * Which keys a source file can ask for, and which none can.
 *
 * The scan is deliberately blunt: a key is reachable when its literal spelling
 * appears anywhere in `public/`, `src/` or `scripts/` bounded by non-key
 * characters. Boundary-aware rather than substring, because `_` is a word
 * character and a key is a prefix of another key's tail: `x.alpha` and
 * `x.alpha_beta` are different strings, and a substring match would call the
 * first reachable on the strength of the second. That false negative is what
 * this rule cost a hand-written scan to find, so the boundary is load-bearing.
 * This comment names no real key for the same reason — a key spelled here is a
 * key the scan below finds, and the rule would excuse what it came to report.
 *
 * Templates are the other half. A key built as `` `workflow.${type}` `` has no
 * literal to find, so the prefix is read off the source and any key under it is
 * treated as reachable. The prefix is kept only when it names a namespace the
 * catalogue actually has, so `token_${n}` in `src/auth.js` — a token id, not an
 * i18n key — excuses nothing.
 */
function keyReachability() {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(js|mjs|html)$/.test(entry.name) && !p.includes(`${path.sep}i18n${path.sep}`)) files.push(p)
    }
  }
  for (const dir of ['public', 'src', 'scripts']) {
    const p = path.join(ROOT, dir)
    if (fs.existsSync(p)) walk(p)
  }
  const sources = files
    // Not this file. A gate that reads its own prose as evidence finds whatever
    // it names — this one named a dead key while explaining the rule, and the
    // key then measured as reachable. Same failure as a canary whose mutation is
    // a superstring of the text it asserts on: the instrument is inside its own
    // sample.
    .filter((f) => f !== fileURLToPath(import.meta.url))
    .map((f) => ({ file: f, text: fs.readFileSync(f, 'utf8') }))
  return scanReachability(sources, enKeys)
}

/**
 * The rule itself, over a supplied source set.
 *
 * Separated from the tree walk so the canaries below can drive it with two
 * strings instead of a fixture tree, and so `--self-test` exercises the same
 * code the shipped run does. A gate whose canaries run a reimplementation of the
 * rule tests the reimplementation.
 */
export function scanReachability(sources, keys) {
  // Reachability is a claim about a tree, and three i18n tests run this gate
  // over a *fixture* tree — the catalogues plus two markup files, no JavaScript
  // at all. In that tree no key is reachable, because there is nothing that
  // could ask for one, and reporting all 520 as dead would be true and useless.
  // The jurisdiction marker is the runtime every surface resolves keys through:
  // if it is absent, this rule has nothing to read and says so rather than
  // inventing a verdict. A gate scoped wider than the tree it was handed fails
  // for reasons its operator cannot act on, and the fix people reach for is to
  // switch it off.
  const inJurisdiction = sources.some((s) => s.file.endsWith(path.join('shared', 'runtime.js')))
  if (!inJurisdiction) {
    return { reachable: keys, dynamic: [], dead: [], prefixes: [], suspicious: [], inJurisdiction: false }
  }

  // Template-built keys, kept only when they name a namespace the catalogue has.
  const prefixCount = new Set()
  for (const { text } of sources) {
    for (const m of text.matchAll(/`([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*[._])\$\{/g)) prefixCount.add(m[1])
  }
  const prefixes = [...prefixCount].filter((p) => keys.some((k) => k.startsWith(p)))

  const reachable = []
  const dynamic = []
  const dead = []
  for (const key of keys) {
    const boundary = new RegExp(`(?<![\\w.-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)
    if (sources.some((s) => boundary.test(s.text))) { reachable.push(key); continue }
    if (prefixes.some((p) => key.startsWith(p))) { dynamic.push(key); continue }
    dead.push(key)
  }

  // A prefix covering a whole namespace hides the very keys it was derived from,
  // so the rule reports it rather than trusting it. A quarter of the catalogue
  // under one prefix is not a template, it is a disabled check.
  const suspicious = prefixes
    .map((p) => ({ prefix: p, count: keys.filter((k) => k.startsWith(p)).length }))
    .filter(({ count }) => count > keys.length / 4)

  return { reachable, dynamic, dead, prefixes, suspicious, inJurisdiction: true }
}

const RUNTIME = path.join('shared', 'runtime.js')
const tree = (...texts) => [
  { file: RUNTIME, text: '' },
  ...texts.map((text, i) => ({ file: `s${i}.js`, text })),
]

/**
 * Each canary is a source set and the dead set the rule must report for it.
 * The expectations disagree on purpose: a scanner returning a constant would
 * pass every canary whose expectation was the same, and the two below expect
 * `0` and `1` respectively.
 */
export const CANARIES = [
  {
    name: 'a key named in a source file is reachable',
    sources: tree("const x = t('a.beta')\n"),
    keys: ['a.beta'],
    expect: [],
  },
  {
    name: 'a key no source names is dead',
    sources: tree("const x = t('a.beta')\n"),
    keys: ['a.beta', 'a.gamma'],
    expect: ['a.gamma'],
  },
  {
    name: 'a key reachable only through a template is not dead',
    sources: tree('const k = `a.${kind}`\n'),
    keys: ['a.beta'],
    expect: [],
  },
  {
    name: 'a template prefix that names no key excuses nothing',
    // `token_${n}` builds a token id, not an i18n key. Treating every template
    // prefix as a key prefix would excuse whatever namespace it happens to sit
    // next to, which is the fail-open half of this rule.
    sources: tree('const k = `token_${n}`\n'),
    keys: ['a.beta'],
    expect: ['a.beta'],
  },
  {
    name: 'a key is not reachable as the tail of a longer key',
    // `a.beta` appears inside `a.beta_gamma`. A substring match calls it
    // reachable on the strength of a different key, and that false negative is
    // the whole reason this rule uses a boundary.
    sources: tree("const x = t('a.beta_gamma')\n"),
    keys: ['a.beta', 'a.beta_gamma'],
    expect: ['a.beta'],
  },
  {
    name: 'a key is not reachable from a key with the same tail under another namespace',
    sources: tree("const x = t('b.beta')\n"),
    keys: ['a.beta'],
    expect: ['a.beta'],
  },
  {
    name: 'a prefix spanning a quarter of the catalogue is reported, not trusted',
    // `a.` covers half of these four keys, so it is reported. The two keys it
    // does not cover stay dead — the prefix excuses only what it names.
    sources: tree('const k = `a.${kind}`\n'),
    keys: ['a.beta', 'a.gamma', 'b.delta', 'c.eps'],
    expect: ['b.delta', 'c.eps'],
    expectSuspicious: 1,
  },
  {
    name: 'a tree with no shared runtime is out of jurisdiction, not all-dead',
    sources: [{ file: 'public/chw/index.html', text: '<p data-i18n="a.beta">x</p>' }],
    keys: ['a.beta'],
    expect: [],
    expectInJurisdiction: false,
  },
]

function selfTest() {
  let failed = 0
  for (const canary of CANARIES) {
    const r = scanReachability(canary.sources, canary.keys)
    const dead = [...r.dead].sort().join(',')
    const want = [...canary.expect].sort().join(',')
    const susp = canary.expectSuspicious === undefined ? null : r.suspicious.length
    const juris = canary.expectInJurisdiction === undefined ? null : r.inJurisdiction
    const ok = dead === want
      && (susp === null || susp === canary.expectSuspicious)
      && (juris === null || juris === canary.expectInJurisdiction)
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — dead [${dead}], want [${want}]`
      + (susp === null ? '' : `, suspicious ${susp}/${canary.expectSuspicious}`)
      + (juris === null ? '' : `, inJurisdiction ${juris}/${canary.expectInJurisdiction}`))
  }
  const shapes = new Set(CANARIES.map((c) => JSON.stringify(c.expect)))
  if (shapes.size < 2) {
    console.log('FAIL the canaries no longer disagree, so a constant scanner would pass them')
    failed += 1
  }
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && process.argv.includes('--self-test')) process.exit(selfTest())

let failed = false
const notes = []

const en = loadLocale('en')
if (!en) {
  console.error('✖ public/i18n/en.json does not exist — it is the catalogue every other is measured against')
  process.exit(1)
}
const enKeys = Object.keys(en)

/** Every shipped surface, whether or not it has an i18n layer. */
const surfaces = fs.readdirSync(PUBLIC)
  .filter((dir) => fs.existsSync(path.join(PUBLIC, dir, 'index.html')))
  .sort()
  .map((dir) => {
    const html = fs.readFileSync(path.join(PUBLIC, dir, 'index.html'), 'utf8')
    return { dir, html, keys: usedKeys(html), offered: offeredLocales(html), scriptKeys: scriptKeys(dir) }
  })

// --- Rule 1: a key in the DOM that no catalogue carries ---------------------

for (const surface of surfaces) {
  const missing = surface.keys.filter((k) => !(k in en))
  if (missing.length) {
    console.error(
      `✖ ${surface.dir}/index.html names ${missing.length} key(s) that public/i18n/en.json does not define:\n`
      + `    ${missing.join('\n    ')}\n`
      + '  A key missing from the base catalogue is rendered as the key name itself. Add it to\n'
      + '  en.json and to every locale this surface offers.',
    )
    failed = true
  }
  const unsourceable = surface.scriptKeys.filter((k) => !(k in en))
  if (unsourceable.length) {
    notes.push(`  ${surface.dir} asks for ${unsourceable.length} key(s) no catalogue defines: ${unsourceable.join(', ')}`)
  }
}

// --- Rule 2: a surface may only offer what it can render --------------------

console.log('Offered locales against every string a surface shows:')
for (const surface of surfaces) {
  // A surface with no keys is reported once, at the end, under the surfaces
  // that have no i18n layer. Repeating it here would read as a pass.
  if (!surface.keys.length) continue
  if (!surface.offered.length) {
    notes.push(`  ${surface.dir.padEnd(13)} translates ${surface.keys.length} strings and offers no language`)
    continue
  }
  const problems = []
  for (const code of surface.offered) {
    const locale = loadLocale(code)
    if (!locale) {
      console.error(`✖ ${surface.dir} offers "${code}" but public/i18n/${code}.json does not exist`)
      problems.push(`${code}: no catalogue`)
      failed = true
      continue
    }
    const allowed = new Set(KNOWN_UNTRANSLATED[surface.dir]?.[code] || [])
    const missing = surface.keys.filter((k) => !(k in locale) && !allowed.has(k))
    const known = surface.keys.filter((k) => !(k in locale) && allowed.has(k))
    if (known.length) {
      notes.push(`  ${surface.dir.padEnd(13)} ${code} still lacks ${known.join(', ')} (known, untranslated)`)
    }
    if (missing.length) {
      console.error(
        `✖ ${surface.dir} offers "${code}" but ${missing.length} of its ${surface.keys.length} strings are missing:\n`
        + `    ${missing.join('\n    ')}\n`
        + '  A missing key renders as the raw key name in the UI. Either translate these or\n'
        + '  remove "' + code + '" from the selector until it is complete.',
      )
      problems.push(`${code}: ${missing.length} missing`)
      failed = true
    }
  }
  if (!problems.length) console.log(`  ${surface.dir.padEnd(13)} ${surface.offered.join(', ').padEnd(28)} complete`)
}
console.log('')

// --- Rule 3: coverage may not fall below the measured floor -----------------

console.log(`Catalogue coverage against en.json (${enKeys.length} keys):`)
for (const code of localeFiles()) {
  const locale = loadLocale(code)
  const have = enKeys.filter((k) => k in locale).length
  const pct = ((have / enKeys.length) * 100).toFixed(1)
  const floor = COVERAGE_FLOOR[code]
  const verdict = floor === undefined ? 'base' : have >= floor ? 'ok' : `BELOW FLOOR ${floor}`
  if (floor !== undefined && have < floor) {
    console.error(
      `✖ ${code}.json covers ${have} of ${enKeys.length} keys, below the recorded floor of ${floor}.`
      + ' A translated string was removed or a locale file was truncated.',
    )
    failed = true
  }
  console.log(`  ${code.padEnd(4)} ${String(have).padStart(3)}/${enKeys.length}  ${String(pct).padStart(5)}%  ${verdict}`)
}
console.log('')

// --- Rule 4: a key no source can ask for ------------------------------------

const reach = keyReachability()
console.log(`Key reachability (${enKeys.length} keys in en.json):`)
if (!reach.inJurisdiction) {
  console.log('  not checked — this tree has no public/shared/runtime.js, so it has no source that')
  console.log('  could ask for a key and every key would read as dead. Rule 4 needs the shipped tree.')
  console.log('')
} else {
  console.log(`  ${reach.reachable.length} reachable, ${reach.dead.length} unreferenced`)
  if (reach.prefixes.length) {
    console.log(`  dynamic prefixes honoured: ${reach.prefixes.join(', ')}`)
    console.log(`  (${reach.dynamic.length} key(s) reachable only through one of these, so not counted dead)`)
  }
  for (const p of reach.suspicious) {
    console.error(
      `✖ the dynamic prefix "${p.prefix}" spans ${p.count} key(s) of the catalogue.\n`
      + '  A template prefix that covers a whole namespace excuses every key under it, which is\n'
      + '  the same failure as a blocklist: it hides the dead key it was written to find. Narrow\n'
      + '  the prefix or name the keys it can actually produce.',
    )
    failed = true
  }
  if (reach.dead.length) {
    console.error(
      `✖ ${reach.dead.length} key(s) in public/i18n/en.json are referenced by no source file:\n`
      + `    ${reach.dead.join('\n    ')}\n`
      + '  Every locale is measured against these keys, so they raise the coverage floor for\n'
      + '  strings no reader can reach. Delete them from every catalogue, or wire the string\n'
      + '  that was meant to use them.',
    )
    failed = true
  } else if (!reach.suspicious.length) {
    console.log('  every key is reachable from a source file')
  }
  console.log('')
}

// --- The CHW table, unchanged in shape --------------------------------------
// Kept as its own report because it is the per-namespace view: the offered-
// locale rule above reads every key the CHW page shows, this reads only chw.*.

const chwHtml = fs.readFileSync(path.join(PUBLIC, 'chw', 'index.html'), 'utf8')
const chwKeys = usedKeys(chwHtml, 'chw.')
const chwOffered = offeredLocales(chwHtml)

notes.push(`CHW i18n coverage for CHW strings:`)
for (const code of localeFiles()) {
  const locale = loadLocale(code)
  const missing = chwKeys.filter((k) => !(k in locale)).length
  const status = missing === 0 ? 'complete' : `${missing} missing`
  notes.push(`  ${code.padEnd(4)} ${String(chwKeys.length - missing).padStart(2)}/${chwKeys.length} ${status}${chwOffered.includes(code) ? ' (offered)' : ' (not offered)'}`)
}

const unlayered = surfaces.filter((s) => !s.keys.length).map((s) => s.dir)
if (unlayered.length) {
  notes.push(`  surfaces with no i18n layer at all: ${unlayered.join(', ')}`)
}

for (const n of notes) console.log(n)

if (failed) process.exit(1)
console.log('i18n ok')

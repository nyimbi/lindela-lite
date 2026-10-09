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
  am: 38,
  ar: 54,
  din: 57,
  fr: 38,
  km: 54,
  nk: 54,
  pt: 38,
  so: 100,
  sw: 281,
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

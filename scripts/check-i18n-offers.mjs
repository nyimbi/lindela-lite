#!/usr/bin/env node
/**
 * Locale-offer reconciliation.
 *
 * A language picker is a promise: every option will render in that language.
 * Three surfaces were breaking it.
 *
 *   - districts and scenarios carried a ten-language picker over pages with
 *     zero i18n attributes, so selecting Karimojong changed nothing.
 *   - co offered Arabic, French and Portuguese against a `co.*` namespace where
 *     those three are 0% translated.
 *   - focal-point offered French and Portuguese at 0%.
 *
 * This is audit defect #16 from docs/demo-audit-2026-10-02.md, which was found
 * on the CHW app, fixed there, and reintroduced twice elsewhere. The CHW page
 * carries a comment explaining that a locale should only be offered when its
 * strings are complete; this extends that rule to every surface and makes it
 * checkable rather than a convention.
 *
 * The floor is deliberately not 100%. Partial coverage degrades gracefully,
 * because English is the base layer and an untranslated key falls back to it.
 * Below the floor a reader gets mostly-English under a flag that promised
 * otherwise, which is worse than not offering the language at all.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Below this fraction of a surface's keys, do not offer the locale. */
const FLOOR = 0.25

const LABELS = {
  sw: 'Kiswahili', so: 'Soomaali', am: 'አማርኛ', fr: 'Français', pt: 'Português',
  din: 'Thuɔŋjäŋ', km: 'ភាសាខ្មែរ', nk: 'Nhgakarimojong', ar: 'العربية',
}

/** Which i18n namespaces belong to which surface. */
const SURFACES = {
  chw: ['chw'],
  co: ['co'],
  portal: ['portal'],
  'focal-point': ['focal-point'],
  // The console carries everything not claimed by a role app.
  console: ['action', 'app', 'banner', 'dispatch', 'equity', 'feedback', 'filter',
            'footer', 'label', 'nav', 'palette', 'shortcut', 'state', 'status',
            'statusbar', 'tab', 'workflow'],
}

const SURFACE_FILES = {
  chw: 'public/chw/index.html',
  co: 'public/co/index.html',
  portal: 'public/portal/index.html',
  'focal-point': 'public/focal-point/index.html',
  console: 'public/index.html',
  parametric: 'public/parametric/index.html',
  scenarios: 'public/scenarios/index.html',
  districts: 'public/districts/index.html',
}

const readJson = (p) => JSON.parse(readFileSync(path.join(root, p), 'utf8'))

const en = readJson('public/i18n/en.json')
const CANDIDATES = ['sw', 'so', 'ar', 'fr', 'pt', 'am', 'din', 'km', 'nk']
const catalogues = Object.fromEntries(
  CANDIDATES.filter((c) => existsSync(path.join(root, `public/i18n/${c}.json`)))
    .map((c) => [c, readJson(`public/i18n/${c}.json`)])
)

/** The locales a surface's picker currently offers. */
function offeredLocales(file) {
  const html = readFileSync(path.join(root, file), 'utf8')
  const select = html.match(/<select[^>]*id="locale-select"[\s\S]*?<\/select>/)
  if (!select) return null
  return [...select[0].matchAll(/value="([a-z]{2,3})"/g)].map((m) => m[1])
}

/** The locales a surface should offer, from what is actually translated. */
function shouldOffer(namespaces) {
  const keys = Object.keys(en).filter((k) => namespaces.includes(k.split('.')[0]))
  const offer = ['en']
  if (keys.length === 0) return offer
  for (const code of CANDIDATES) {
    const catalogue = catalogues[code]
    if (!catalogue) continue
    const have = keys.filter((k) => k in catalogue).length
    if (have / keys.length >= FLOOR) offer.push(code)
  }
  return offer
}

const failures = []
console.log(`Locale offer floor: ${Math.round(FLOOR * 100)}% of a surface's own keys\n`)
console.log('surface        offered          expected        verdict')

for (const [surface, file] of Object.entries(SURFACE_FILES)) {
  const offered = offeredLocales(file)
  if (!offered) {
    console.log(`${surface.padEnd(14)} (no locale picker)`)
    continue
  }
  const expected = shouldOffer(SURFACES[surface] || [])
  const missing = expected.filter((c) => !offered.includes(c))
  const extra = offered.filter((c) => c !== 'en' && !expected.includes(c))
  const ok = missing.length === 0 && extra.length === 0
  console.log(
    `${surface.padEnd(14)} ${offered.join(',').padEnd(16)} ${expected.join(',').padEnd(14)} ${ok ? 'ok' : 'MISMATCH'}`
  )
  if (extra.length) failures.push(`${surface}: offers ${extra.join(', ')} at <${Math.round(FLOOR * 100)}% coverage of its own keys`)
  if (missing.length) failures.push(`${surface}: does not offer ${missing.join(', ')} despite having the strings`)
}

// A picker option labelled "SW" or "AR" is unusable to the person it is for.
// This is not a rule about exonyms — "Swahili" and "Dinka" are how those
// languages are written in English and belong in an English-language interface.
// The defect is an abbreviation standing in for a name.
const pickerLabels = Object.entries(SURFACE_FILES).map(([surface, file]) => {
  const html = readFileSync(path.join(root, file), 'utf8')
  const select = html.match(/<select[^>]*id="locale-select"[\s\S]*?<\/select>/)
  if (!select) return []
  return [...select[0].matchAll(/value="([a-z]{2,3})"[^>]*>([^<]+)</g)].map((m) => ({ surface, code: m[1], label: m[2].trim() }))
}).flat()

for (const { surface, code, label } of pickerLabels) {
  if (code === 'en') continue
  if (label.length <= 3) {
    failures.push(`${surface}: ${code} is labelled "${label}"; that is an abbreviation, not a language name`)
  }
}

if (failures.length) {
  console.error('\n' + failures.map((f) => `  - ${f}`).join('\n'))
  console.error(
    '\nEither finish the translations with speakers of those languages, or remove the' +
    '\noption. Inventing strings is not a translation — see the note in chw/index.html.'
  )
  process.exit(1)
}
console.log('\nEvery surface offers only the languages it can actually render.')
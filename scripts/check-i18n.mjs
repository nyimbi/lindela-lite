#!/usr/bin/env node
/**
 * i18n completeness guard.
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
 * Two rules:
 *  1. Every key a surface puts in the DOM must exist in every language that
 *     surface offers. A missing key renders as the raw key.
 *  2. A surface may only offer a language whose keys for that surface are
 *     complete. Partial coverage is not localisation.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')

/** Surfaces that render their own markup and therefore own their own strings. */
const SURFACES = [
  {
    name: 'CHW app',
    html: 'public/chw/index.html',
    // Only this surface's own namespace is required; the navbar and footer are
    // shared and covered by their own surfaces.
    prefix: 'chw.',
    optionSelector: 'locale-select',
  },
]

function loadLocale(code) {
  const p = path.join(ROOT, 'public/i18n', `${code}.json`)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (error) {
    throw new Error(`public/i18n/${code}.json is not valid JSON: ${error.message}`)
  }
}

/** Language codes offered by a surface's own selector. */
function offeredLocales(html, selectorId) {
  const select = html.match(new RegExp(`<select[^>]*id="${selectorId}"[^>]*>([\\s\\S]*?)</select>`))
  if (!select) return []
  return [...select[1].matchAll(/<option\s+value="([a-z]{2,3})"/g)].map((m) => m[1])
}

/** i18n keys a surface puts into the DOM. */
function usedKeys(html, prefix) {
  const all = [...html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1])
  return [...new Set(all.filter((k) => k.startsWith(prefix)))].sort()
}

let failed = false
const notes = []

for (const surface of SURFACES) {
  const html = fs.readFileSync(path.join(ROOT, surface.html), 'utf8')
  const keys = usedKeys(html, surface.prefix)
  const offered = offeredLocales(html, surface.optionSelector)

  if (!keys.length) {
    notes.push(`${surface.name}: no ${surface.prefix} keys found in ${surface.html} — check the markup`)
    continue
  }
  if (!offered.length) {
    notes.push(`${surface.name}: no language selector found (#${surface.optionSelector})`)
    continue
  }

  for (const code of offered) {
    const locale = loadLocale(code)
    if (!locale) {
      console.error(`✖ ${surface.name} offers "${code}" but public/i18n/${code}.json does not exist`)
      failed = true
      continue
    }
    const missing = keys.filter((k) => !(k in locale))
    if (missing.length) {
      console.error(
        `✖ ${surface.name} offers "${code}" but ${missing.length} of ${keys.length} strings are missing:\n`
        + `    ${missing.join('\n    ')}\n`
        + `  A missing key renders as the raw key name in the UI. Either translate these or\n`
        + `  remove "${code}" from the selector until it is complete.`,
      )
      failed = true
    }
  }

  // Report coverage for every locale file, so an in-progress translation is
  // visible rather than silently absent.
  const localeDir = path.join(ROOT, 'public/i18n')
  for (const file of fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'))) {
    const code = file.replace(/\.json$/, '')
    const locale = loadLocale(code)
    const missing = keys.filter((k) => !(k in locale)).length
    const status = missing === 0 ? 'complete' : `${missing} missing`
    notes.push(`  ${code.padEnd(4)} ${String(keys.length - missing).padStart(2)}/${keys.length} ${status}${offered.includes(code) ? ' (offered)' : ' (not offered)'}`)
  }
}

if (notes.length) {
  console.log(`${surfaceLabel()} i18n coverage for CHW strings:`)
  for (const n of notes) console.log(n)
}

function surfaceLabel() { return 'CHW' }

if (failed) process.exit(1)
console.log('i18n ok')

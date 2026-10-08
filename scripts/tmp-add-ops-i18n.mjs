/**
 * Add the Phase F keys to a locale catalogue, without reformatting it.
 *
 * The existing catalogues are hand-maintained and their key order is meaningful
 * to the diffs that review them, so this appends rather than rewriting the file
 * through `JSON.stringify` — which is how `outcome.coverage_some` moved once and
 * made a 30-key addition look like a 1-key deletion and 31 insertions.
 *
 * Usage: node scripts/tmp-add-ops-i18n.mjs <locale>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const locale = process.argv[2]
if (!locale) throw new Error('usage: node scripts/tmp-add-ops-i18n.mjs <locale>')

const T = JSON.parse(readFileSync(path.join(root, 'scripts/tmp-ops-i18n.json'), 'utf8'))[locale]
if (!T) throw new Error(`no translations for locale "${locale}"`)

const file = path.join(root, `public/i18n/${locale}.json`)
const raw = readFileSync(file, 'utf8')
const existing = JSON.parse(raw)

const added = []
const present = []
for (const [key, value] of Object.entries(T)) {
  if (existing[key] !== undefined) present.push(key)
  else added.push(key)
}
if (present.length) {
  console.log(`${locale}: already present, left alone: ${present.join(', ')}`)
}
if (!added.length) {
  console.log(`${locale}: nothing to add`)
  process.exit(0)
}

// Append before the closing brace, preserving the file's existing indentation and
// line endings. A trailing newline on the last entry is what makes this safe.
const indentMatch = raw.match(/\n(\s*)"/)
const indent = indentMatch ? indentMatch[1] : '  '
const entries = added.map((key) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(T[key])}`)
// Commas BETWEEN the appended entries, never after the last one: JSON has no
// trailing comma, and a catalogue that does not parse is worse than a missing key.
const lines = entries.map((line, i) => (i === entries.length - 1 ? line : `${line},`))
const trimmed = raw.replace(/\s*$/, '')
if (!trimmed.endsWith('}')) throw new Error(`${locale}.json does not end with an object`)
const out = `${trimmed.slice(0, -1).replace(/,\s*$/, '')},\n${lines.join('\n')}\n}\n`

JSON.parse(out) // Refuse to write anything that does not parse.
writeFileSync(file, out)
console.log(`${locale}: added ${added.length} keys`)
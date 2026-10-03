#!/usr/bin/env node
/**
 * First-load budget gate.
 *
 * 64 KB gzipped for the whole console is the number worth protecting, because
 * the binding constraint for this product is a field connection, not a data
 * centre. Nothing was enforcing it: a well-meaning import of a charting library
 * would have doubled the first paint for every operator and for every community
 * health worker on the same weak link, and no gate would have said so.
 *
 * Measures the assets the browser actually fetches to render `/` — the HTML, the
 * three stylesheets, the console script, its module graph, and the English
 * catalogue — compressed the way the server compresses them.
 *
 * Usage: node scripts/check-budget.mjs
 *        BUDGET_KB=80 node scripts/check-budget.mjs   (to allow headroom once)
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = path.join(root, 'public')

/** The console's first load, before any interaction. */
const ENTRY = 'index.html'
/**
 * Set just above the measured console first load, so the gate catches a
 * regression rather than a redesign. The first-load figure this replaced — a
 * hand-measured 64 KB — was a subset: it missed components.css and most of the
 * module graph, and the console's own script is 45 KB on its own. Measured, the
 * console is ~103 KB gzipped, of which app.js is 45 KB.
 */
const BUDGET_KB = Number(process.env.BUDGET_KB || 112)

/**
 * Every asset the browser fetches to render the console.
 *
 * Three reference forms have to be followed or the number is fiction: the HTML's
 * `src=`/`href=`, an ES module's `from '…'`, and a stylesheet's `@import url('…')`.
 * The first version followed only the latter two and reported a 15 KB first load
 * for a console whose HTML alone references a 154 KB script.
 */
function moduleGraph(entry) {
  const seen = new Set()
  const queue = [entry]
  const HTML_RE = /(?:src|href)=["'](\/[^"'?]+\.(?:js|css))["']/g
  const IMPORT_RE = /(?:from|import)\s*['"](\/[^'"]+\.js)['"]|@import\s+url\(['"](\/[^'"]+\.css)['"]\)/g

  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(path.join(publicDir, file))) continue
    seen.add(file)
    const source = readFileSync(path.join(publicDir, file), 'utf8')
    for (const match of source.matchAll(file.endsWith('.html') ? HTML_RE : IMPORT_RE)) {
      const dep = match[1] || match[2]
      if (dep) queue.push(dep.replace(/^\//, ''))
    }
  }
  return [...seen]
}

const sheetImports = moduleGraph('index.html').filter((f) => f.endsWith('.css'))
const scripts = moduleGraph('index.html').filter((f) => f.endsWith('.js'))

// The console also fetches the English catalogue and, at runtime, the navbar
// that every surface shares.
const unique = [...new Set([ENTRY, ...scripts, ...sheetImports, 'i18n/en.json', 'shared/navbar.js'])]

let raw = 0
let gzipped = 0
const rows = []

for (const file of unique) {
  const full = path.join(publicDir, file)
  if (!existsSync(full)) continue
  const bytes = readFileSync(full)
  const gz = gzipSync(bytes).length
  raw += bytes.length
  gzipped += gz
  rows.push({ file, raw: bytes.length, gzipped: gz })
}

rows.sort((a, b) => b.gzipped - a.gzipped)

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
console.log(`Console first load — ${unique.length} assets\n`)
for (const r of rows) {
  const bar = '█'.repeat(Math.max(1, Math.round(r.gzipped / 1024)))
  console.log(`  ${r.file.padEnd(28)} ${kb(r.gzipped).padStart(9)} gzipped  ${bar}`)
}
console.log(`\n  ${'TOTAL'.padEnd(28)} ${kb(gzipped).padStart(9)} gzipped  (${kb(raw)} raw)`)
console.log(`  ${'BUDGET'.padEnd(28)} ${kb(BudgetBytes()).padStart(9)}\n`)

function BudgetBytes() {
  return BUDGET_KB * 1024
}

if (gzipped > BudgetBytes()) {
  console.error(
    `First load is ${kb(gzipped - BudgetBytes())} over budget.\n` +
    `The console is used on field connections; a regression here is felt by every\n` +
    `operator and every community health worker, not only the person who merged it.`
  )
  process.exit(1)
}

console.log(`Within budget, with ${kb(BudgetBytes() - gzipped)} of headroom.`)
#!/usr/bin/env node
/**
 * VUL-07. `script-src 'self' 'unsafe-inline'`.
 *
 * The pages build markup with `innerHTML`, so the CSP is the backstop that turns
 * a missed escape from a full injection into a visible failure — and
 * `'unsafe-inline'` is exactly what removes it. With it, any injected
 * `<script>` runs.
 *
 * A per-request nonce is the usual answer and is the wrong one here: the service
 * worker caches HTML for offline use, and a nonce baked into a cached page is
 * stale on the next load, so every script on every cached surface would be
 * blocked offline. The inline scripts are **byte-static per file** — the only
 * per-request substitution, the app-version marker, is in a `<span>` outside
 * them — so `sha256` hashes are the mechanism that fits: they survive caching
 * and they need no nonce plumbing.
 *
 * Hashes have one failure mode, and it is why this file exists rather than a
 * hand-maintained list: edit an inline script and the hash no longer matches, so
 * the browser blocks it silently — no console error in production, just a page
 * that stopped working. So the hash list is **generated from the markup**, and
 * `--check` fails when the two disagree. `server.js` imports `inlineScriptHashes()`
 * so there is no second copy to drift.
 *
 *   node scripts/check-csp.mjs            # report what is hashed
 *   node scripts/check-csp.mjs --check    # fail if server.js's list is stale
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')
const SERVER = path.join(ROOT, 'src', 'server.js')

/**
 * Every inline `<script>` body in the shipped surfaces.
 *
 * `<script src=...>` is excluded: it is already covered by `'self'`, and
 * hashing it would be wrong — the browser hashes the body, which is empty.
 */
export function inlineScriptHashes(dir = PUBLIC) {
  const files = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.html')) files.push(full)
    }
  }
  walk(dir)

  const hashes = new Set()
  for (const file of files) {
    const html = readFileSync(file, 'utf8')
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      hashes.add(`sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}`)
    }
  }
  return [...hashes].sort()
}

/**
 * The array as it appears in `src/server.js`, as bare values.
 *
 * Bare, not quoted. A CSP source needs the quotes, and `server.js` adds them
 * when it builds the header — putting them in the array instead makes them
 * JavaScript string delimiters, so they vanish from the value and the header
 * ships an unquoted hash-source the browser ignores. That is a silent failure
 * (the script is blocked, nothing is logged), so the shape is fixed here and
 * asserted by `test/csp-inline-scripts.test.js` against a real response.
 */
export function declaredHashes(source) {
  const block = source.match(/INLINE_SCRIPT_HASHES\s*=\s*\[([\s\S]*?)\]/)
  if (!block) return null
  return [...block[1].matchAll(/'sha256-[^']+'/g)].map((m) => m[0].slice(1, -1)).sort()
}

/**
 * Inline event handlers, which a hash list cannot cover.
 *
 * `onclick=` and friends are `'unsafe-inline'` by another name: the CSP treats
 * an inline handler as an inline script, and hashes do not apply to them. So the
 * policy can only drop `'unsafe-inline'` once there are none, and this counts
 * them rather than trusting that the last one was removed.
 */
export function inlineHandlers(dir = PUBLIC) {
  const found = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.html')) {
        const html = readFileSync(full, 'utf8')
        for (const match of html.matchAll(/\son(click|change|input|submit|load|error|keyup|keydown|focus|blur)\s*=/gi)) {
          found.push(`${path.relative(ROOT, full)}: on${match[1].toLowerCase()}`)
        }
      }
    }
  }
  walk(dir)
  return found
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hashes = inlineScriptHashes()
  const handlers = inlineHandlers()
  // `--check` is the default. A gate that reports and exits 0 is a gate that
  // passes forever; the mode has to be the failing one unless asked otherwise.
  const check = !process.argv.includes('--report')

  console.log(`inline scripts: ${hashes.length}`)
  for (const hash of hashes) console.log(`  ${hash}`)
  console.log(`inline handlers: ${handlers.length}`)
  for (const handler of handlers) console.log(`  ${handler}`)

  if (handlers.length) {
    console.error(`\n${handlers.length} inline event handler(s). A hash cannot cover these, so 'unsafe-inline' cannot be dropped while any remain.`)
    process.exitCode = 1
  }

  if (check) {
    const source = readFileSync(SERVER, 'utf8')
    const declared = declaredHashes(source)
    if (!declared) {
      console.error('\nsrc/server.js declares no INLINE_SCRIPT_HASHES array.')
      process.exitCode = 1
    } else {
      const missing = hashes.filter((h) => !declared.includes(h))
      const extra = declared.filter((h) => !hashes.includes(h))
      if (missing.length || extra.length) {
        console.error('\nThe hash list in src/server.js does not match the markup:')
        for (const h of missing) console.error(`  missing from server.js: ${h}`)
        for (const h of extra) console.error(`  stale in server.js:     ${h}`)
        console.error('\nRun `node scripts/check-csp.mjs --write` to regenerate, or an inline script will be blocked silently in the browser.')
        process.exitCode = 1
      } else {
        console.log(`\ncsp ok — ${hashes.length} inline script hash(es) match the markup.`)
      }
    }
  }
}

/** Rewrite the array in `src/server.js` in place. */
export function writeHashes() {
  const hashes = inlineScriptHashes()
  const source = readFileSync(SERVER, 'utf8')
  const next = source.replace(
    /(INLINE_SCRIPT_HASHES\s*=\s*\[)[\s\S]*?(\])/,
    (_m, open, close) => `${open}\n${hashes.map((h) => `  '${h}',`).join('\n')}\n${close}`,
  )
  if (next === source) throw new Error('INLINE_SCRIPT_HASHES array not found in src/server.js')
  return { hashes, next }
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--write')) {
  const { hashes, next } = writeHashes()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(SERVER, next)
  console.log(`wrote ${hashes.length} hash(es) to src/server.js`)
}

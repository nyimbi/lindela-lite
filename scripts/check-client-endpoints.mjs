#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { servedRoutePaths } from './route-surface.mjs'

/**
 * ENH-59 — the fifth table, checked.
 *
 * ARC-02 names five things that describe the routes and drift apart:
 * `src/server.js`'s literal conditions, `src/route-manifests.js`,
 * `docs/openapi.yaml`, `src/auth.js`'s scopes, and **the client's endpoints**.
 * The first three are cross-checked by `check-openapi` and
 * `test/route-manifests.test.js`; the scopes by `check-route-methods`. The
 * client's call sites had no check at all, and the one entry that *was* checked
 * — `public/sw.js`'s `NEVER_CACHED` — is a hand-written inventory of three
 * paths, not the surface.
 *
 * What that costs is a screen that fetches a route the server does not have. The
 * console swallows the failure the way a browser does: `fetch` resolves with a
 * 404, the panel renders its empty state, and the surface reads as "no data"
 * rather than "no route". It is the same silent-empty failure the
 * `?limit=abc` defect is (QUA-07), reached from the other end — there, a caller
 * got an empty page for a real route; here, a caller gets an empty panel for a
 * route that was never there.
 *
 * ## Why this is not a list
 *
 * The check reads the client's `/api/v1/…` literals out of its source and asks
 * the *same* route surface the document comparison uses
 * (`scripts/route-surface.mjs`), so a family that moves out of the dispatcher
 * does not need this file edited. A second hand-kept list would be the defect
 * restated.
 *
 * ## The scope, and the false positive that decided it
 *
 * The first draft of this gate reported exactly one finding on a clean tree:
 * `/api/v1/readyz` in `public/sw.js`. It is in a **comment**, and the comment is
 * the paragraph explaining that the entry was removed for being a route the
 * server never served. A gate whose only finding on known-good input is a
 * sentence about the gate's own subject is a gate that gets deleted, and
 * correctly — this repository has that lesson written down four times
 * (`check-absent-values`, the tone gate, the citation gate). So the scan strips
 * comments before reading literals, and the tree is verified clean as a canary
 * rather than assumed clean.
 *
 * ## What it does not model
 *
 * A path the client *builds* — `` `${base}/districts/${id}` `` — is a literal
 * prefix, not a path, and this gate reads prefixes as prefixes: a literal that
 * is a proper prefix of a served path is accepted, because the client completes
 * it at call time. `/api/v1/basemap/tiles/osm` is the live example (the client
 * appends `/{z}/{x}/{y}.png`). The check therefore refuses a literal that no
 * served path starts with, and accepts one that any served path starts with.
 * That is the conservative direction: it cannot report a built path as dead, and
 * it still catches the class it is for — a path renamed on the server and left
 * behind in the client, where nothing served begins with the old literal.
 *
 * Exit 0 when clean, 1 with the literals listed. Canaried in `--self-test`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The client surfaces. `src/` is excluded: the server is the other side of this comparison. */
const CLIENT_DIRS = ['public']

/** Vendored, generated, or a build artefact — a finding in one is not this repository's. */
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', '.git', 'worktrees'])

/** A literal API path in client source. Backtick, quote, or template head. */
const API_LITERAL = /['"`](\/api\/v1\/[A-Za-z0-9/_.-]*)/g

/**
 * A literal that has declared itself intentional.
 *
 * Same discipline as the other gates in this directory: the marker carries a
 * reason, because an exemption with no reason is a decision nobody can review.
 * This is for a path the client deliberately names and the server deliberately
 * does not serve — a probe, a deprecated alias it still falls back to.
 */
const ALLOW = /client-endpoint-ok:\s*\S/

/**
 * The lines an allow-marker may sit on: this line, and the contiguous comment
 * block immediately above it.
 *
 * One line up is not enough. A reason worth writing is usually two lines, and a
 * marker whose reason wraps is a marker a one-line reader misses — which is how
 * an allow-marker becomes a bare marker in practice, and a bare marker is the
 * thing this gate refuses. The block stops at the first non-comment line so a
 * marker cannot reach up the file and excuse a site it was never about. Same
 * rule, and the same reason, as `check-absent-values`.
 */
function allowedContext(lines, index) {
  const parts = [lines[index]]
  for (let i = index - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim()
    if (!trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) break
    parts.unshift(lines[i])
  }
  return parts.join('\n')
}

/** Recursively list scannable files under a directory. */
function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, out)
    else if (/\.(js|mjs)$/.test(entry.name) && !entry.name.includes('.min.')) out.push(full)
  }
  return out
}

/**
 * Remove comments from a source string, preserving line structure.
 *
 * Line count is load-bearing — findings are reported by line — so a removed
 * comment leaves its newlines behind rather than collapsing the block. The
 * string-aware scan is the one `check-absent-values` uses: a naive `//` search
 * truncates at `'https://…'`, and a naive `/*` search would eat the rest of the
 * file from a regex literal.
 */
export function stripComments(source) {
  let out = ''
  let quote = null
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') { out += ch + (source[i + 1] ?? ''); i += 2; continue }
      if (ch === quote) quote = null
      out += ch
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * Scan one client source string for API literals.
 *
 * Exported so the canaries drive it with text rather than with files — a canary
 * that writes files to test a scanner is a canary that can corrupt the tree it
 * is testing.
 */
export function clientLiterals(source, { file = '<memory>' } = {}) {
  const lines = stripComments(source).split('\n')
  const findings = []
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(API_LITERAL)) {
      // A literal that is exactly `/api/v1/` is the namespace, not an endpoint:
      // `pathname.startsWith('/api/v1/')` is a predicate about the API as a
      // whole. Naming it a missing route would be the gate inventing a finding.
      if (match[1] === '/api/v1/') continue
      findings.push({ file, line: i + 1, path: match[1], text: lines[i].trim() })
    }
  }
  return findings
}

/**
 * Is this literal one the server answers, directly or as a prefix?
 *
 * A served path may name its parameters (`/api/v1/districts/{id}`); the client
 * writes the concrete value or a prefix of it. So the comparison is on the
 * served path's *literal* segments: the client's literal is alive when some
 * served path starts with it, at a segment boundary.
 */
function isServed(literal, servedPaths) {
  const trimmed = literal.replace(/\/+$/, '')
  for (const served of servedPaths) {
    const servedTrimmed = served.replace(/\/+$/, '')
    if (servedTrimmed === trimmed) return true
    if (servedTrimmed.startsWith(`${trimmed}/`)) return true
    // A served path whose first segments are literal and whose literal matches:
    // `/api/v1/districts/{id}` against a client literal `/api/v1/districts`.
    const servedHead = servedTrimmed.split('/{')[0]
    if (servedHead === trimmed || servedHead.startsWith(`${trimmed}/`)) return true
  }
  return false
}

/** Scan the client tree. Returns `{ findings, checked }`. */
export function scanTree(root = ROOT) {
  const { paths: servedPaths } = servedRoutePaths(root)
  const served = [...servedPaths]
  const findings = []
  let checked = 0
  for (const dir of CLIENT_DIRS) {
    const full = path.join(root, dir)
    if (!fs.existsSync(full)) continue
    for (const file of filesUnder(full)) {
      const rel = path.relative(root, file)
      const source = fs.readFileSync(file, 'utf8')
      const lines = source.split('\n')
      for (const hit of clientLiterals(source, { file: rel })) {
        checked += 1
        if (isServed(hit.path, served)) continue
        if (ALLOW.test(allowedContext(lines, hit.line - 1))) continue
        findings.push(hit)
      }
    }
  }
  return { findings, checked, served: served.length }
}

/**
 * Canaries. The pair that matters is the last two: a gate that fires on
 * everything is deleted, and a gate that fires on nothing passes forever. Both
 * are checked against known-good and known-bad text, because "exit 0" from a
 * scanner nobody has watched fail is not evidence.
 *
 * The served set the canaries run against is a fixture rather than the real
 * tree, so a canary's expectation does not change when a route is added — a
 * canary that drifts with the tree is not pinning anything.
 */
const CANARY_SERVED = [
  '/api/v1/incidents',
  '/api/v1/incidents/{id}',
  '/api/v1/districts/{id}',
  '/api/v1/basemap/tiles/osm/{id}/{id2}/{id3}.png',
  '/api/v1/basemap/tiles/carto/{id}/{id2}/{id3}.png',
]

function canaryFindings(source) {
  const lines = source.split('\n')
  return clientLiterals(source).filter((hit) => {
    if (isServed(hit.path, CANARY_SERVED)) return false
    if (ALLOW.test(allowedContext(lines, hit.line - 1))) return false
    return true
  })
}

export const CANARIES = [
  {
    name: 'flags a literal the server does not serve',
    source: "const res = await fetch('/api/v1/readyz')",
    expect: 1,
  },
  {
    name: 'passes a literal that is a served path exactly',
    source: "const res = await fetch('/api/v1/incidents')",
    expect: 0,
  },
  {
    name: 'passes a literal prefix the client completes at call time',
    source: 'const url = `/api/v1/basemap/tiles/osm/${z}/${x}/${y}.png`',
    expect: 0,
  },
  {
    name: 'passes a path whose served sibling names a parameter',
    source: "const res = await fetch('/api/v1/districts')",
    expect: 0,
  },
  {
    name: 'does not flag a path named in a comment — the readyz case',
    source: [
      '// `/api/v1/readyz` was a fourth entry and the server has never served it',
      "export const NEVER_CACHED = ['/api/v1/incidents']",
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'still sees a real literal on the line after a comment',
    source: [
      '// the old entry was `/api/v1/gone`',
      "const res = await fetch('/api/v1/also-gone')",
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'is not fooled by // inside a string, and still sees the literal after it',
    source: [
      "const origin = 'https://example.test'",
      "const res = await fetch('/api/v1/nowhere')",
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'ignores the bare API namespace, which is a predicate not an endpoint',
    source: "if (!pathname.startsWith('/api/v1/')) return null",
    expect: 0,
  },
  {
    name: 'honours an allow-marker that gives a reason',
    source: "// client-endpoint-ok: a deprecated probe the server deliberately dropped\nconst res = await fetch('/api/v1/readyz')",
    expect: 0,
  },
  {
    name: 'does not honour a bare allow-marker with no reason',
    source: "const res = await fetch('/api/v1/readyz') // client-endpoint-ok:",
    expect: 1,
  },
]

function selfTest() {
  let failed = 0
  for (const canary of CANARIES) {
    const got = canaryFindings(canary.source).length
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  // The real tree is the strongest known-good input available, so it is checked
  // as well as the fixtures: a scanner that returns the same answer for every
  // input would pass every canary above only if the expectations were uniform,
  // and they are not — but the tree is what this gate ships against.
  const { findings, checked, served } = scanTree(ROOT)
  console.log(`${findings.length === 0 ? 'ok  ' : 'FAIL'} the client tree is clean — ${checked} literal(s) against ${served} served path(s)`)
  if (findings.length) failed += 1
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest())
  const { findings, checked, served } = scanTree(ROOT)
  if (findings.length === 0) {
    console.log(`client-endpoint check: clean — ${checked} client literal(s) against ${served} served path(s)`)
    process.exit(0)
  }
  console.error(`client-endpoint check: ${findings.length} literal(s) name a route the server does not serve\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.path}`)
    console.error(`    ${f.text}`)
  }
  console.error('\nNo served path begins with the literal above, so the fetch 404s and the surface')
  console.error('renders its empty state — which reads as "no data", not "no route". Fix the path,')
  console.error('or mark it `client-endpoint-ok: <reason>` when the server is meant not to serve it.')
  process.exit(1)
}

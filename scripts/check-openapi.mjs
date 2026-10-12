#!/usr/bin/env node
/**
 * The OpenAPI document is checked against the code, not maintained beside it.
 *
 * `docs/openapi.yaml` was hand-maintained, which is why nine live routes went
 * undocumented and `/api/v1/impact/facilities-at-risk` was missing while its
 * sibling was present (D4). The check that existed in `validate.mjs` could not
 * catch this: it tested ~30 hand-listed endpoint strings for presence in the
 * document. That is a test of the list, not of the server — adding a route and
 * forgetting to add it to the list passed, which is the defect restated.
 *
 * This inverts it: the route surface is parsed out of every file it can live in
 * (`scripts/route-surface.mjs`) and the document and the server must agree, in
 * both directions.
 *
 * **What it can and cannot see.** The route surface is written in two syntactic
 * families — literal `req.method === 'M' && url.pathname === 'P'` conditions,
 * and six `match*Route` helpers that dispatch to a handler. Both are parsed
 * below. What is *not* modelled is the fine-grained method gating inside a
 * sub-handler: a handler serving GET on the list and POST on the detail is
 * modelled as serving both methods on both paths. That over-approximation is
 * deliberate, and it is why the checks below compare **paths**, not
 * method/path pairs. A wrong method is a documentation nicety; a wrong path is
 * a client that cannot call the endpoint.
 *
 * `coverage` prints what was parsed, so the claim "the document matches the
 * server" is always backed by a number a reviewer can check.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { servedRoutePaths } from './route-surface.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const spec = fs.readFileSync(path.join(root, 'docs/openapi.yaml'), 'utf8')

// The surface is parsed once, in `scripts/route-surface.mjs`, and shared.
//
// ARC-01 moved the export family out of `src/server.js` into
// `src/routes/exports.js`, and this check — reading `server.js` alone — reported
// all five export paths as *ghosts*: documented, and served by nothing it could
// see. A gate scoped to a file rather than to the surface it audits goes blind
// the moment the surface moves, and goes blind *silently*: a family that moved
// and was documented correctly would have reported nothing. That is why the
// surface is every module under `src/routes/` plus `src/server.js`, read by
// directory rather than by a list — and why it lives in one module rather than
// in each reader, which is how two other guards went blind on 2026-10-12 when
// ENH-60 moved the liveness pair.
let servedPaths
let coverage
try {
  ({ paths: servedPaths, coverage } = servedRoutePaths(root))
} catch (error) {
  // The dispatcher scope is load-bearing: without it the inline-match family
  // silently contributes zero paths, and a check that finds nothing passes.
  console.error(error.message)
  process.exit(1)
}

// ── Compare ─────────────────────────────────────────────────────────────────
const documented = new Set([...spec.matchAll(/^ {2}(\/[^:\n]*):\s*$/gm)].map((m) => m[1]))

const undocumented = [...servedPaths].filter((route) => !documented.has(route)).sort()
const ghosts = [...documented].filter((route) => !servedPaths.has(route)).sort()

// Printed before the verdict, not after: the failure message points a reader at
// the coverage line, and a coverage line that only appears on success is not
// there when they need it.
for (const entry of coverage.parsed) {
  console.log(`  parsed ${entry.matcher} → ${entry.handler}: ${entry.paths} paths`)
}
if (coverage.unparsed.length) {
  console.log(`  NOT PARSED (no coverage claimed): ${coverage.unparsed.join(', ')}`)
}

if (undocumented.length || ghosts.length) {
  if (undocumented.length) {
    console.error(`OpenAPI is missing ${undocumented.length} served route(s):`)
    for (const route of undocumented) console.error(`  ${route}`)
    console.error('\nThese are served by src/server.js and absent from docs/openapi.yaml.')
    console.error('A client generated from this document cannot call them.')
  }
  if (ghosts.length) {
    console.error(`\nOpenAPI documents ${ghosts.length} path(s) the server does not serve:`)
    for (const route of ghosts) console.error(`  ${route}`)
    console.error('\nEither the route was removed and the document was not updated, or it')
    console.error('is routed through a matcher this check could not parse (see coverage).')
  }
  process.exit(1)
}

console.log(`openapi ok — ${documented.size} documented paths, ${servedPaths.size} served routes parsed`)

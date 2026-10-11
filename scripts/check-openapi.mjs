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
 * This inverts it: the route surface is read out of `src/server.js` and the
 * document and the server must agree, in both directions.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8')
const spec = fs.readFileSync(path.join(root, 'docs/openapi.yaml'), 'utf8')

/** `/api/v1/x/:id` → `/api/v1/x/{id}`, which is how OpenAPI spells it. */
const openapiPath = (raw) => raw.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')

const unescape = (text) => text.replace(/\\(.)/g, '$1')

/**
 * Resolve the capture groups in a regex path into literal segments or `{id}`.
 *
 * A group is not always a parameter. `(copy)` is one path segment spelled with
 * a group, and `(approve|reject)` is two. Reading either as a parameter yields
 * `/api/v1/report-templates/{id}/{id}` — a route that does not exist — and, in
 * the other direction, silently hides the two that do. So: a body containing a
 * character class or `.+` is a parameter; anything else is a literal, expanded
 * once per alternative because OpenAPI has no way to express a choice.
 */
function resolveGroups(source) {
  const variants = [source]
  // Each pass removes one group from every variant, so this terminates.
  for (let guard = 0; guard < 20; guard += 1) {
    let progressed = false
    for (let i = 0; i < variants.length; i += 1) {
      const match = variants[i].match(/\(([^()]*)\)/)
      if (!match) continue
      const body = match[1]
      if (body.includes('[') || body.includes('.+')) {
        variants[i] = variants[i].replace(match[0], '{id}')
      } else {
        const alternatives = body.split('|')
        variants.splice(i, 1, ...alternatives.map((alt) => variants[i].replace(match[0], alt)))
      }
      progressed = true
    }
    if (!progressed) return variants
  }
  return variants
}

/**
 * Turn a pathname-matching regex literal into the path shapes it serves.
 *
 * Three things make this less trivial than splitting on `/`:
 *
 * 1. **Every separator is escaped.** The source reads
 *    `/^\/api\/v1\/webhooks$/`, so a scanner that treats `\` as an opaque
 *    escape never finds a separator at all. The escapes go first.
 * 2. **An unescaped `/` is not a separator.** `([^/]+)` contains one, inside a
 *    character class. Resolving groups before splitting means that slash is
 *    gone by the time it matters.
 * 3. **An optional segment serves two paths.** `(?:\/([^/]+))?` matches the bare
 *    collection *and* the collection plus a detail segment. Documenting only
 *    one is precisely how a detail route goes missing from the spec.
 */
function patternToPaths(literal) {
  let source = literal.replace(/\\\//g, '/')
  if (source.startsWith('^')) source = source.slice(1)
  if (source.endsWith('$')) source = source.slice(0, -1)

  // Optional tails are pulled out before the general group handling, which would
  // otherwise swallow them and report only the bare collection.
  const optionals = []
  source = source.replace(/\(\?:\/(.+?)\)\?/g, (_, inner) => {
    optionals.push(inner)
    return '\u0000'
  })

  const paths = []
  for (const variant of resolveGroups(source)) {
    const base = variant
      .replace(/[()?:]/g, '')
      .replace(/\\(.)/g, '$1')
      .split('\u0000')[0]
      .trim()
    if (!base.startsWith('/')) continue
    paths.push(base)
    for (const inner of optionals) {
      const isParam = inner.includes('[') || inner.includes('.+')
      paths.push(`${base}/${isParam ? '{id}' : inner.replace(/[()?:]/g, '')}`)
    }
  }
  return paths
}

/**
 * The body of a top-level function, by brace matching.
 *
 * Two things the first version got wrong, both found by pointing this at
 * `handleApiRequestInContext` and getting a 114-character body for a 1,597-line
 * function:
 *
 *   - `indexOf('function X(')` matches the *call* `handleApiRequestInContext(…)`
 *     before the definition, because the call site is earlier in the file. The
 *     definition is anchored on `function X(` at the start of a line.
 *   - the body is not the first `{` after the name. A destructured parameter —
 *     `(store, req, …, { checkWebhookUrl, idempotency } = {})` — puts a brace
 *     pair inside the parameter list, so brace matching from there closed on the
 *     parameter object and returned the signature. The named `match*Route`
 *     matchers take plain parameters, which is why this never showed until
 *     something with a destructured argument was measured.
 *
 * So: find the matching `)` of the parameter list, and the body is the first `{`
 * after it.
 */
function functionBody(name) {
  const definition = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(src)
  if (!definition) return null
  const paramsOpen = src.indexOf('(', definition.index)
  let parens = 0
  let paramsClose = -1
  for (let i = paramsOpen; i < src.length; i += 1) {
    if (src[i] === '(') parens += 1
    else if (src[i] === ')') {
      parens -= 1
      if (parens === 0) { paramsClose = i; break }
    }
  }
  if (paramsClose < 0) return null

  const open = src.indexOf('{', paramsClose)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

/** Only real API paths; `/stac` and `/ogc` are served and documented too. */
const SERVED_PREFIX = /^\/(api|stac|ogc|docs)\//
const servedPaths = new Set()

const addPath = (route) => {
  const normalised = openapiPath(route)
  if (!normalised || normalised === '/') return
  if (!SERVED_PREFIX.test(normalised) || normalised.includes('\\')) return
  servedPaths.add(normalised)
}

// ── Family 1: literal method + path conditions ──────────────────────────────
// Every pathname literal, whether or not it sits next to a method guard. Some
// routes (`/api/v1/road-access`, `/api/v1/flood-depth`) match on the path alone
// and take whatever method arrives; a check that only read the guarded form
// would claim coverage it does not have. Both comparisons below are path-only,
// so the method genuinely does not matter here.
for (const match of src.matchAll(/(?:url\.|route\.)?pathname\s*===\s*'([^']+)'/g)) {
  addPath(match[1])
}

// ── Family 1b: inline regex matches in the dispatcher ───────────────────────
// ARC-02's residue, and the reason `/api/v1/districts/{id}` was served and
// undocumented: Family 2 reads `.match(/…/)` only inside a *named* `match*Route`
// function, so an inline match written directly in the request handler is
// invisible to this check in both directions — it is not reported as
// undocumented, and the document cannot be checked against it. `/api/v1/
// districts/{id}` is fetched by the district portal on every district page.
//
// The named-matcher pass below reads the same syntax, so this pass only adds
// paths the first did not already find; a duplicate is a Set insert and costs
// nothing, but scoping it this way keeps the coverage line honest about which
// family produced what.
// The same syntax Family 2 reads, applied to the dispatcher body rather than to
// a named matcher's body. The scope matters in both directions: run over the
// whole file, this also reads `.match()` calls that are not routing at all — a
// tokenizer's segment regex produced `/api/v1/{id}`, and the STAC and OGC
// matchers produced paths their own pass already owns and spells differently —
// and every one of those arrives as a served route the document is then accused
// of missing. A check that invents five findings on a clean tree is a check
// nobody reads.
const dispatcherBody = functionBody('handleApiRequestInContext')
if (!dispatcherBody) {
  // The scope is load-bearing, so its absence is a failure rather than a quiet
  // reduction in coverage: without the body this pass silently finds nothing,
  // and a check that finds nothing passes.
  console.error('check-openapi: handleApiRequestInContext not found; inline route matches are unchecked')
  process.exit(1)
}
for (const m of dispatcherBody.matchAll(/\.match\((\/.+?\/[gimsuy]*)\)/g)) {
  for (const route of patternToPaths(m[1].slice(1, m[1].lastIndexOf('/')))) addPath(route)
}

// ── Family 2: match*Route dispatchers ───────────────────────────────────────
// The pairing is by name (`matchFooRoute` ↔ `handleFooRoute`), so a new family
// is covered by writing the new matcher rather than by editing a list here.
const matchers = [...src.matchAll(/^function (match[A-Za-z]+Route)\(/gm)].map((m) => m[1])
const coverage = { parsed: [], unparsed: [] }

for (const matcher of matchers) {
  const handlerName = `handle${matcher.slice('match'.length)}`
  const matcherBody = functionBody(matcher)
  if (!matcherBody) {
    coverage.unparsed.push(`${matcher} (not found)`)
    continue
  }

  const paths = new Set()
  for (const m of matcherBody.matchAll(/pathname\s*===\s*'(\/[^']+)'/g)) paths.add(m[1])

  // `pathname.match(/^...$/)` — the capture is the literal with delimiters.
  // Non-greedy, and `[^)]*?` so the inner `)` of `([^/]+)` does not end it.
  // The capture must span `)` characters, because an optional trailing segment
  // is written `(?:\/([^/]+))?` — the group inside it closes before the literal
  // does. `[^)]` truncates there and the route loses its detail form.
  for (const m of matcherBody.matchAll(/\.match\((\/.+?\/[gimsuy]*)\)/g)) {
    for (const route of patternToPaths(m[1].slice(1, m[1].lastIndexOf('/')))) paths.add(route)
  }

  // A `const routes = { incidents: 'incidents', ... }` prefix family: the matcher
  // accepts an optional second segment for every key, so each key is two paths.
  // When such a map is present it is an allow-list, and the generic paths the
  // tokenizer regex implies (`/api/v1/{id}`) are matched-but-then-rejected —
  // reported as served routes, they would be a route that answers 404.
  let allowListed = false
  for (const map of matcherBody.matchAll(/const routes = \{([^}]*)\}/g)) {
    allowListed = true
    for (const key of map[1].matchAll(/'?([A-Za-z][\w-]*)'?\s*:/g)) {
      paths.add(`/api/v1/${key[1]}`)
      paths.add(`/api/v1/${key[1]}/{id}`)
    }
  }
  if (allowListed) {
    for (const route of [...paths]) if (route.startsWith('/api/v1/{')) paths.delete(route)
  }

  if (!paths.size) {
    coverage.unparsed.push(`${matcher} (no path syntax recognised)`)
    continue
  }
  coverage.parsed.push({ matcher, handler: handlerName, paths: paths.size })
  for (const route of paths) addPath(route)
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

/**
 * The route surface, parsed once, from every file it can live in.
 *
 * This exists because two readers of the surface went blind on the same day.
 * ENH-60 moved the liveness pair out of `src/server.js` into
 * `src/routes/liveness.js`, and two guards that had each derived "every path the
 * server serves" from `src/server.js` alone immediately reported `/api/v1/health`
 * as a route nothing served — one as a dead `NEVER_CACHED` entry, one as a
 * missing source string. Both were correct checks reading a surface that had
 * moved. `check-openapi.mjs` had already learned this lesson the hard way
 * (ARC-01's move made it report five export paths as ghosts) and had grown the
 * fix: read every module under `src/routes/`, not just the dispatcher.
 *
 * So the derivation lives here, once, and the readers import it. The alternative
 * — three copies of the same three-family parser, each updated when a family
 * moves — is how the third copy goes stale silently, which is the failure this
 * whole class of guard exists to prevent.
 *
 * Three syntactic families, all read:
 *
 *   1. literal `pathname === '…'` conditions, in any source file;
 *   1b. inline `.match(/…/)` inside the dispatcher body;
 *   2. named `match*Route` matchers, paired to their `handle*Route` handlers.
 *
 * What is *not* modelled is method gating: a handler serving GET on the list and
 * POST on the detail is modelled as serving both methods on both paths. Callers
 * that need methods compare paths, and the over-approximation is deliberate —
 * a wrong method is a documentation nicety, a wrong path is a client that cannot
 * call the endpoint.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Every source file the route surface can live in.
 *
 * Read by directory rather than by a list: a list is a second place to forget.
 * `src/routes/` is globbed so a family extracted tomorrow is covered without an
 * edit here.
 */
export function routeSources(root) {
  const routes = fs.readdirSync(path.join(root, 'src/routes'))
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => ({ name: `src/routes/${name}`, text: fs.readFileSync(path.join(root, 'src/routes', name), 'utf8') }))
  const server = { name: 'src/server.js', text: fs.readFileSync(path.join(root, 'src/server.js'), 'utf8') }
  return [server, ...routes]
}

/** `/api/v1/x/:id` → `/api/v1/x/{id}`, which is how OpenAPI spells it. */
export const openapiPath = (raw) => raw.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')

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
export function resolveGroups(source) {
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
export function patternToPaths(literal) {
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
export function functionBody(name, source) {
  const definition = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(source)
  if (!definition) return null
  const paramsOpen = source.indexOf('(', definition.index)
  let parens = 0
  let paramsClose = -1
  for (let i = paramsOpen; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1
    else if (source[i] === ')') {
      parens -= 1
      if (parens === 0) { paramsClose = i; break }
    }
  }
  if (paramsClose < 0) return null

  const open = source.indexOf('{', paramsClose)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

/** Only real API paths; `/stac` and `/ogc` are served and documented too. */
const SERVED_PREFIX = /^\/(api|stac|ogc|docs)\//

/**
 * Every path the server serves, and how each was found.
 *
 * Returns `{ paths, coverage }`. `coverage.parsed` names each matcher and its
 * path count; `coverage.unparsed` names a matcher this parser could not read.
 * The caller prints the coverage rather than trusting the total: a parser that
 * stopped matching reports nothing, and a check that finds nothing passes.
 *
 * Throws when the dispatcher body is absent, because the scope is load-bearing —
 * without it the inline-match family silently contributes zero paths.
 */
export function servedRoutePaths(root) {
  const sources = routeSources(root)
  const paths = new Set()
  const coverage = { parsed: [], unparsed: [] }

  const addPath = (route) => {
    const normalised = openapiPath(route)
    if (!normalised || normalised === '/') return
    if (!SERVED_PREFIX.test(normalised) || normalised.includes('\\')) return
    paths.add(normalised)
  }

  // ── Family 1: literal pathname conditions, in every source ────────────────
  // Every pathname literal, whether or not it sits next to a method guard. Some
  // routes (`/api/v1/road-access`, `/api/v1/flood-depth`) match on the path alone
  // and take whatever method arrives; a check that only read the guarded form
  // would claim coverage it does not have.
  for (const source of sources) {
    for (const match of source.text.matchAll(/(?:url\.|route\.)?pathname\s*===\s*'([^']+)'/g)) {
      addPath(match[1])
    }
  }

  // ── Family 1b: inline regex matches in the dispatcher ─────────────────────
  // Family 2 reads `.match(/…/)` only inside a *named* `match*Route` function, so
  // an inline match written directly in the request handler is invisible in both
  // directions. The scope matters: run over the whole file, this also reads
  // `.match()` calls that are not routing at all — a tokenizer's segment regex,
  // the STAC and OGC matchers — and each arrives as a served route the document
  // is then accused of missing. A check that invents five findings on a clean
  // tree is a check nobody reads.
  const server = sources.find((s) => s.name === 'src/server.js').text
  const dispatcherBody = functionBody('handleApiRequestInContext', server)
  if (!dispatcherBody) {
    throw new Error('check-openapi: handleApiRequestInContext not found; inline route matches are unchecked')
  }
  for (const m of dispatcherBody.matchAll(/\.match\((\/.+?\/[gimsuy]*)\)/g)) {
    for (const route of patternToPaths(m[1].slice(1, m[1].lastIndexOf('/')))) addPath(route)
  }

  // ── Family 2: match*Route dispatchers ─────────────────────────────────────
  // The pairing is by name (`matchFooRoute` ↔ `handleFooRoute`), so a new family
  // is covered by writing the new matcher rather than by editing a list here.
  for (const source of sources) {
    // `export function` as well as bare `function`. A route module exports its
    // matcher — it has to, or nothing can call it — and a matcher this regex does
    // not see is a family reported as *no paths*, which passes the comparison by
    // contributing nothing.
    for (const matcher of [...source.text.matchAll(/^(?:export\s+)?function (match[A-Za-z]+Route)\(/gm)].map((m) => m[1])) {
      const handlerName = `handle${matcher.slice('match'.length)}`
      const matcherBody = functionBody(matcher, source.text)
      if (!matcherBody) {
        coverage.unparsed.push(`${matcher} (not found)`)
        continue
      }

      const matcherPaths = new Set()
      for (const m of matcherBody.matchAll(/pathname\s*===\s*'(\/[^']+)'/g)) matcherPaths.add(m[1])

      // `pathname.match(/^...$/)` — the capture is the literal with delimiters.
      // Non-greedy, and the capture must span `)` characters, because an optional
      // trailing segment is written `(?:\/([^/]+))?` — the group inside it closes
      // before the literal does.
      for (const m of matcherBody.matchAll(/\.match\((\/.+?\/[gimsuy]*)\)/g)) {
        for (const route of patternToPaths(m[1].slice(1, m[1].lastIndexOf('/')))) matcherPaths.add(route)
      }

      // A `const routes = { incidents: 'incidents', ... }` prefix family: the
      // matcher accepts an optional second segment for every key, so each key is
      // two paths. When such a map is present it is an allow-list, and the
      // generic paths the tokenizer regex implies (`/api/v1/{id}`) are
      // matched-but-then-rejected — reported as served routes, they would be a
      // route that answers 404.
      let allowListed = false
      for (const map of matcherBody.matchAll(/const routes = \{([^}]*)\}/g)) {
        allowListed = true
        for (const key of map[1].matchAll(/'?([A-Za-z][\w-]*)'?\s*:/g)) {
          matcherPaths.add(`/api/v1/${key[1]}`)
          matcherPaths.add(`/api/v1/${key[1]}/{id}`)
        }
      }
      if (allowListed) {
        for (const route of [...matcherPaths]) if (route.startsWith('/api/v1/{')) matcherPaths.delete(route)
      }

      if (!matcherPaths.size) {
        coverage.unparsed.push(`${matcher} (no path syntax recognised)`)
        continue
      }
      coverage.parsed.push({ matcher, handler: handlerName, paths: matcherPaths.size })
      for (const route of matcherPaths) addPath(route)
    }
  }

  return { paths, coverage }
}

/**
 * Every pathname literal in the surface, unexpanded.
 *
 * The cheap question — "does the server name this path anywhere?" — for readers
 * that do not need the regex families expanded. Kept here beside the full
 * derivation so a reader that only needs the literal family still reads *every*
 * source, rather than reaching for `src/server.js` and going blind when a family
 * moves.
 */
export function pathLiterals(root) {
  const out = new Set()
  for (const source of routeSources(root)) {
    for (const match of source.text.matchAll(/(?:url\.|route\.)?pathname\s*===\s*'([^']+)'/g)) out.add(match[1])
  }
  return out
}

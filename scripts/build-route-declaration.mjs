#!/usr/bin/env node
/**
 * ENH-59 bootstrap. Reads the three hand-kept tables and emits
 * `src/route-declaration.js`, which becomes the single source of truth.
 *
 * Run once. After it, the declaration is edited by hand and the tables are
 * generated from it by `scripts/generate-*.mjs`; `check-route-drift.mjs` fails
 * when a committed table and its regeneration differ.
 *
 * The three sources:
 *   - `docs/openapi.yaml`     the verbatim spec body for each operation
 *   - `src/auth.js`           the scope, joined on (METHOD, path)
 *   - `src/route-manifests.js` the collections the handler reads
 *
 * It refuses to emit when any operation resolves to zero or two sources, so a
 * bootstrap that quietly drops a route cannot look like a successful run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const VERBS = ['get', 'post', 'put', 'patch', 'delete']

/** Spec paths use `{name}`; the JS tables use `:name`. */
export function toColon(specPath) {
  return specPath.replace(/\{([^}]+)\}/g, ':$1')
}

/**
 * The two spellings of a parameterised path are the same route. The spec names
 * tile captures `{z}/{x}/{y}`; the matcher names them `:id/:id2/:id3`, because
 * the regex has no way to say what a group means. This is the whole list of
 * such divergences — asserted, not assumed, by `check-route-reachability.mjs`.
 */
export const PARAM_ALIASES = [
  ['/api/v1/basemap/tiles/osm/{z}/{x}/{y}.png', 'GET /api/v1/basemap/tiles/osm/:id/:id/:id.png'],
  ['/api/v1/basemap/tiles/carto/{z}/{x}/{y}.png', 'GET /api/v1/basemap/tiles/carto/:id/:id/:id.png'],
  ['/stac/collections/{id}/items/{id2}', 'GET /stac/collections/:id/items/:id'],
]

/**
 * The `paths:` block of the spec, modelled as data.
 *
 * Returns `[{ path, pre, ops: [{ verb, body }] }]` where `body` is the
 * operation's lines with the `    verb:` line removed. `pre` holds a path-level
 * preamble (`parameters:` declared once for every verb under the path).
 *
 * A blank line is a separator only when it is not inside a block scalar, and a
 * block-scalar header carries an optional chomping indicator (`|`, `>-`, `|2+`).
 * Getting either wrong turns prose into structure.
 */
export function parseSpecPaths(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === 'paths:')
  if (start < 0) throw new Error('build-route-declaration: no `paths:` block')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z]/.test(lines[i])) { end = i; break }
  }
  const block = lines.slice(start, end)

  const SCALAR = /^(\s*)\S.*:\s*[|>][-+]?\d*\s*$/
  const inScalar = new Array(block.length).fill(false)
  {
    let open = false
    let indent = 0
    for (let i = 0; i < block.length; i += 1) {
      const l = block[i]
      if (open) {
        if (l.trim() === '') { inScalar[i] = true; continue }
        if (l.match(/^\s*/)[0].length > indent) { inScalar[i] = true; continue }
        open = false
      }
      const h = l.match(SCALAR)
      if (h) { open = true; indent = h[1].length }
    }
  }

  const paths = []
  let cur = null
  let op = null
  let pre = null
  const flushOp = () => { if (op) { cur.ops.push(op); op = null } }
  const flushPath = () => {
    flushOp()
    if (pre) { cur.pre = pre; pre = null }
    if (cur) paths.push(cur)
    cur = null
  }

  for (let i = 0; i < block.length; i += 1) {
    const l = block[i]
    // A blank inside a block scalar is prose, not a separator; outside one it
    // separates entries and carries no meaning.
    if (l === '' && !inScalar[i]) continue
    if (l !== 'paths:' && !inScalar[i]) {
      let m = l.match(/^  (\/[^:]+):\s*$/)
      if (m) { flushPath(); cur = { path: m[1], pre: null, ops: [] }; continue }
      m = l.match(/^    (get|post|put|patch|delete):\s*$/)
      if (m && cur) { flushOp(); op = { verb: m[1].toUpperCase(), body: [] }; continue }
    }
    // Everything else — including every line of a block scalar — is content of
    // whatever is currently open. Dropping these is how a spec loses its prose.
    if (op) { op.body.push(l); continue }
    if (cur) { if (pre === null) pre = []; pre.push(l); continue }
    if (l === 'paths:') continue
    throw new Error(`build-route-declaration: unmodelled line ${JSON.stringify(l)}`)
  }
  flushPath()
  return paths
}

/** A template literal's content, escaped so it round-trips. */
function asTemplate(lines) {
  const body = lines.join('\n')
  const escaped = body
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
  return `\`\n${escaped}\n\``
}

/**
 * The comment block sitting immediately above each key in a hand-kept table.
 *
 * Those 130 comment lines are the *reason* for the entry — "this reads
 * hazard_events and service_assets because the expected-loss proxy is severity
 * x exposure" — and a generator that emitted bare keys would drop every one of
 * them. The reasoning is the part a reader reuses, so it moves into the
 * declaration with the value it explains.
 */
export function extractNotes(source, { open, close }) {
  const lines = source.split('\n')
  const from = lines.findIndex((l) => l.includes(open))
  if (from < 0) throw new Error(`extractNotes: no ${open}`)
  let to = from
  while (to < lines.length && !lines[to].includes(close)) to += 1

  const notes = new Map()
  let pending = []
  for (let i = from + 1; i <= to; i += 1) {
    const l = lines[i]
    const c = l.match(/^\s*\/\/\s?(.*)$/)
    if (c) { pending.push(c[1]); continue }
    const k = l.match(/^\s*'([^']+)'/)
    if (k) {
      if (pending.length > 0) notes.set(k[1], pending)
      pending = []
    }
  }
  return notes
}

/** The `HISTORY_ROUTES` set, which is module-private. */
export function extractHistoryRoutes(source) {
  const lines = source.split('\n')
  const from = lines.findIndex((l) => l.includes('const HISTORY_ROUTES = new Set(['))
  if (from < 0) throw new Error('extractHistoryRoutes: no HISTORY_ROUTES')
  const out = new Set()
  for (let i = from + 1; i < lines.length; i += 1) {
    if (/^\s*\]\)/.test(lines[i])) break
    const m = lines[i].match(/^\s*'([^']+)'/)
    if (m) out.add(m[1])
  }
  return out
}

function main() {
  const spec = fs.readFileSync(path.join(ROOT, 'docs/openapi.yaml'), 'utf8')
  const paths = parseSpecPaths(spec)

  // The tables are imported, never regex-parsed: a literal that no longer
  // parses is a table that silently reads empty, which is the failure this
  // whole item exists to remove.
  return import(path.join(ROOT, 'src/auth.js')).then(async (auth) => {
    const manifests = await import(path.join(ROOT, 'src/route-manifests.js'))

    const readTable = auth.READ_SCOPES
    const writeTable = auth.WRITE_SCOPES
    const manifestKeys = new Map(Object.entries(manifests.ROUTE_MANIFESTS))
    const wideKeys = new Set(manifests.WIDE_ROUTES)
    const aliasTo = new Map(PARAM_ALIASES.map(([specSpelling, tableSpelling]) => [specSpelling, tableSpelling]))

    const manifestSrc = fs.readFileSync(path.join(ROOT, 'src/route-manifests.js'), 'utf8')
    const measuredNotes = extractNotes(manifestSrc, { open: 'export const ROUTE_MANIFESTS', close: '})' })
    const wideNotes = extractNotes(manifestSrc, { open: 'export const WIDE_ROUTES', close: '])' })
    const historyRoutes = extractHistoryRoutes(manifestSrc)

    // matchesPattern/firstMatch are module-private in auth.js; this is the same
    // algorithm, and `test/route-declaration.test.js` asserts the two agree on
    // every declared route rather than trusting the copy.
    const matchesPattern = (pattern, pathname) => {
      if (!pattern.includes(':')) {
        return pathname === pattern
          || pathname.startsWith(`${pattern}/`)
          || pathname.startsWith(`${pattern}.`)
      }
      const a = pattern.split('/')
      const b = pathname.split('/')
      if (a.length !== b.length) return false
      return a.every((p, i) => (p.startsWith(':') ? b[i].length > 0 : p === b[i]))
    }
    const firstMatch = (table, pathname) => {
      let hit = null
      let longest = -1
      for (const [pattern, scope] of table) {
        if (pattern.length > longest && matchesPattern(pattern, pathname)) {
          hit = scope
          longest = pattern.length
        }
      }
      return hit
    }

    const entries = []
    const unresolvedScope = []
    const unresolvedReads = []
    const bothTables = []

    for (const p of paths) {
      for (const o of p.ops) {
        const colon = toColon(p.path)
        const key = `${o.verb} ${colon}`

        const scope = firstMatch(o.verb === 'GET' || o.verb === 'HEAD' ? readTable : writeTable, colon)
        if (scope === null) unresolvedScope.push(key)

        const lookup = manifestKeys.has(key) || wideKeys.has(key) ? key : (aliasTo.get(p.path) ?? key)
        const reads = manifestKeys.get(lookup) ?? null
        const wide = wideKeys.has(lookup)
        if (reads !== null && wide) bothTables.push(key)
        if (reads === null && !wide) unresolvedReads.push(key)

        entries.push({
          method: o.verb,
          path: p.path,
          scope: scope ?? null,
          reads: reads ? [...reads] : [],
          wide: reads === null ? true : wide,
          history: historyRoutes.has(lookup),
          notes: measuredNotes.get(lookup) ?? wideNotes.get(lookup) ?? null,
          pre: p.pre,
          body: o.body,
        })
      }
    }

    // A route the join could not resolve is a route this bootstrap would have
    // guessed at. Refuse, and name it.
    if (unresolvedReads.length > 0) {
      process.stderr.write(
        `build-route-declaration: ${unresolvedReads.length} operation(s) resolve to no manifest row.\n`
        + 'Add each to ROUTE_MANIFESTS or WIDE_ROUTES before bootstrapping, or extend PARAM_ALIASES:\n'
        + unresolvedReads.map((k) => `  ${k}`).join('\n') + '\n',
      )
      process.exit(1)
    }
    if (bothTables.length > 0) {
      process.stderr.write(
        `build-route-declaration: ${bothTables.length} operation(s) appear in BOTH tables:\n`
        + bothTables.map((k) => `  ${k}`).join('\n') + '\n',
      )
      process.exit(1)
    }

    const out = []
    out.push('// GENERATED by scripts/build-route-declaration.mjs, then edited by hand.')
    out.push('//')
    out.push('// ENH-59. The single declaration of the route surface. Every table that')
    out.push('// describes a route is generated from this file:')
    out.push('//')
    out.push('//   docs/openapi.yaml         scripts/generate-openapi.mjs')
    out.push('//   ROUTE_MANIFESTS/WIDE_ROUTES  scripts/generate-route-manifests.mjs')
    out.push('//   READ_SCOPES/WRITE_SCOPES  scripts/generate-route-scopes.mjs')
    out.push('//')
    out.push('// `scripts/check-route-drift.mjs` fails when a committed table and its')
    out.push('// regeneration differ, and `scripts/check-route-reachability.mjs` fails')
    out.push('// when a declared route is served by no matcher (or the reverse). Adding a')
    out.push('// route means adding one entry here.')
    out.push('//')
    out.push('// `path` is the spec\'s spelling (`{id}`), because the spec is what a client')
    out.push('// reads. The matcher\'s spelling (`:id`) is what the reachability gate')
    out.push('// reconciles against, through an explicit alias table — never a fuzzy match.')
    out.push('')
    out.push('export const ROUTE_DECLARATION = Object.freeze([')

    for (const e of entries) {
      out.push('\tObject.freeze({')
      out.push(`\t\tmethod: '${e.method}',`)
      out.push(`\t\tpath: '${e.path}',`)
      out.push(`\t\tscope: ${e.scope === null ? 'null' : `'${e.scope}'`},`)
      if (e.wide) {
        out.push('\t\twide: true,')
      } else {
        out.push(`\t\treads: Object.freeze(${JSON.stringify(e.reads)}),`)
        out.push('\t\twide: false,')
      }
      if (e.history) out.push('\t\thistory: true,')
      if (e.notes) {
        out.push('\t\tnotes: [')
        for (const n of e.notes) out.push(`\t\t\t${JSON.stringify(n)},`)
        out.push('\t\t],')
      }
      if (e.pre) {
        out.push(`\t\tpre: ${asTemplate(e.pre)},`)
      }
      out.push(`\t\tbody: ${asTemplate(e.body)},`)
      out.push('\t}),')
    }

    out.push('])')
    out.push('')

    const target = path.join(ROOT, 'src/route-declaration.js')
    fs.writeFileSync(target, out.join('\n'))

    const wide = entries.filter((e) => e.wide).length
    process.stderr.write(
      `build-route-declaration: ${entries.length} operations `
      + `(${entries.length - wide} measured, ${wide} wide) -> src/route-declaration.js\n`
      + `  ${unresolvedScope.length} with no scope row (the public set)\n`
      + unresolvedScope.map((k) => `    ${k}`).join('\n') + '\n',
    )
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`)
    process.exit(1)
  })
}

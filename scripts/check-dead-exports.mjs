#!/usr/bin/env node
/**
 * R-95 — every export of `src/` is imported by something, or is named here.
 *
 * `check-module-coverage.mjs` works at *module* granularity: it asks whether a
 * test reaches a file. That question is answered by one import of one name, so
 * a module with twenty exports passes on the strength of one of them. The gap
 * is the jurisdiction: **reachability of a module is not reachability of its
 * exports.** `src/sanctions.js` is reached by `src/routes/parametric.js`, which
 * imports `screenNames` — and `resetSdnCache`, whose own docstring says "Used by
 * tests", is imported by nothing at all, including the test file for its own
 * module. The module gate is green and the docstring is false.
 *
 * **Why this is not a textual census.** The first version of this check counted
 * occurrences of each export name across the tree, minus the definition. That
 * is the wrong instrument, and it fails in both directions:
 *
 *   - It counts a mention in a comment or a docstring. `beginCapture` in
 *     `src/connectors/http.js` appears four times and is *called* nowhere: three
 *     of the four are the prose that explains it. A symbol whose only reader is
 *     the sentence describing it is dead, and a census that reads prose as a
 *     call site cannot see that. `check-module-coverage.mjs` carries a canary
 *     for exactly this — "does not count a mention in prose as an import" — and
 *     the textual census would have failed its own suite's canary.
 *   - It counts a member access as a use of a same-named local, and a spread
 *     (`...f(x)`) as a member access, which is how a first draft of the census
 *     reported `ensembleFieldsFor` dead while `src/connectors/open-meteo.js:239`
 *     calls it three lines below its own definition.
 *
 * So this reads **import statements**, which is the only way one JavaScript
 * module reaches another's binding. An export is live when some file names it
 * in an `import { … }`, or reaches the module through a namespace import, or
 * re-exports it from `src/index.js` — the package entry point, which is public
 * surface by definition and is the reason `createStoreFromEnv` is not a finding
 * even though the only `src/` caller is `src/server.js`.
 *
 * **The allowlist is a surface decision, not a coverage exemption.** An entry
 * says "this is reached by something other than a name import, and here is
 * what". An entry whose reason is "hard to wire" does not belong here; wire it
 * or delete it. Both directions are checked, because an exemption that outlives
 * its reason is how an allowlist becomes a place to hide.
 *
 * Usage:
 *   node scripts/check-dead-exports.mjs            # check, exit 1 on a finding
 *   node scripts/check-dead-exports.mjs --self-test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The package entry point. Every name it re-exports is public API, so it is
 * live whatever the tree does with it internally — an integrator outside this
 * repository is the consumer, and no grep can see them.
 */
export const ENTRY_POINTS = Object.freeze(['src/index.js'])

/**
 * Exports reached by something other than a name import, each with the reason.
 *
 * **This is not empty, and the note that said it would be was wrong.** It was
 * written on the expectation that every finding would be either wired or
 * deleted in the same change. Disposing of the 31 findings the gate first
 * reported showed that is not always available: some exports are a documented
 * *capability* that no caller reaches yet, and deleting one removes the claim
 * rather than a working thing — `beginCapture` and its three siblings are a
 * fixture-capture mechanism, built, tested through the pieces they compose, and
 * waiting for a test that wants to replay a recorded response. A gate that
 * cannot pass is indistinguishable from no gate, so the alternative to an
 * exemption here is a gate someone switches off.
 *
 * **The allowlist is a surface decision, not a coverage exemption.** An entry
 * names a capability the tree keeps on purpose, with the reason it is kept. The
 * rule that stops it becoming a place to hide is enforced: an entry a name
 * import now reaches is reported as `stale-exemption`, so an exemption cannot
 * outlive the reason for it — wire one of these and the gate tells you to remove
 * the line.
 *
 * Two of the ten (`recentRequestOutcomes`, `stopPeriodicDriver`) are already
 * recorded as known-dead in `docs/improvements/defects.md:874`; the other eight
 * are recorded in the QUA-09 entry in `docs/improvements/audit-2026-10/defects.md`.
 */
export const SURFACE_EXEMPT_EXPORTS = Object.freeze({
  // --- the fixture-capture family: connectors/http.js ---
  // `beginCapture`/`endCapture` bracket a capture, `captureStore` reads what it
  // kept, `isReplaying` asks whether the fetch is being served from the store.
  // Together they are the replay path described at length in the module header;
  // `createReplayStore` and `withCapture` (the two pieces a *test* uses today)
  // are imported by name from `capture.js`, and this family is the seam over
  // `fetchWithRetry` that no caller has reached for yet. Kept: it is the only
  // way to serve a recorded response through the real fetch funnel, which is
  // what a connector test that replays instead of stubbing would need.
  'src/connectors/http.js::beginCapture': 'fixture capture/replay seam over fetchWithRetry; no caller yet, kept as the documented replay path',
  'src/connectors/http.js::endCapture': 'the other half of beginCapture; kept together so the pair is not half-deleted',
  'src/connectors/http.js::captureStore': 'reads the store beginCapture filled; kept with the family',
  'src/connectors/http.js::isReplaying': 'asks whether the fetch is served from the store; kept with the family',
  // --- federation ---
  'src/federation-peers.js::localManifest': 'this node’s own manifest for its federation surface and status route; the route reads `exchangeManifest` directly today',
  'src/federation-peers.js::peersForExchange': 'the active-peer list for `federate`; `federate` is called with peers from the caller, so this adapter has no user yet',
  'src/federation.js::incomingIsRevision': 'the two questions a bitemporal integrator asks of an incoming peer record; exported for that caller, none in-tree',
  // --- ledger ---
  'src/reconciliation.js::ledgerDigest': 'a single entry’s digest for a caller that wants one without walking the chain; the chain walker is what the tree uses',
  // --- already recorded as known-dead ---
  'src/observability.js::recentRequestOutcomes': 'known-dead, recorded at docs/improvements/defects.md:874; `computeShortTermSuccessRate` is the reader the routes use',
  'src/server.js::stopPeriodicDriver': 'known-dead, recorded at docs/improvements/defects.md:874; the process exits and the timer goes with it, so nothing calls stop',
})

/** `export function f`, `export async function f`, `export const f`, … */
const NAMED_EXPORT_RE = /^[ \t]*export[ \t]+(?:async[ \t]+)?(?:function|class|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm
/** `export default …` — the binding has no name to import by, handled apart. */
const DEFAULT_EXPORT_RE = /^[ \t]*export[ \t]+default\b/m
/** `export { a, b as c }` with no `from` — a local binding, or a re-export. */
const EXPORT_BRACE_RE = /^[ \t]*export[ \t]*\{([^}]*)\}[ \t]*(?:from[ \t]*['"]([^'"]+)['"])?/gm
/** `export * from './x.js'` and `export * as ns from './x.js'`. */
const EXPORT_STAR_RE = /^[ \t]*export[ \t]*\*(?:[ \t]*as[ \t]+[A-Za-z_$][\w$]*)?[ \t]*from[ \t]*['"]([^'"]+)['"]/gm
/** `import { a, b as c } from './x.js'` */
const IMPORT_BRACE_RE = /^[ \t]*import[ \t]+(?:[A-Za-z_$][\w$]*[ \t]*,[ \t]*)?\{([^}]*)\}[ \t]*from[ \t]*['"]([^'"]+)['"]/gm
/** `import * as ns from './x.js'` — reaches every export of the target. */
const IMPORT_STAR_RE = /^[ \t]*import[ \t]*\*[ \t]*as[ \t]+[A-Za-z_$][\w$]*[ \t]*from[ \t]*['"]([^'"]+)['"]/gm
/**
 * `const { a, b } = await import('./x.js')`, and the same shape without
 * `await`. 53 test files use this form, and a parser that reads only
 * `import { a } from './x.js'` reports every name it reaches as dead —
 * `kpiCacheStats` was the first false positive the canary set caught.
 */
const DYNAMIC_DESTRUCTURE_RE = /(?:const|let|var)[ \t]*\{([^}]*)\}[ \t]*=[ \t]*(?:await[ \t]+)?import[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/gm
/** `const ns = await import('./x.js')` — a namespace, so every export is reached. */
const DYNAMIC_NAMESPACE_RE = /(?:const|let|var)[ \t]*([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:await[ \t]+)?import[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/gm
/**
 * `(await import(anything)).name` — a property read off a module namespace with
 * no binding in between.
 *
 * The specifier is *not* captured, because it need not be readable: the form
 * that matters in this tree is
 * `(await import(path.join(ROOT, entry.module))).spec`, where the path is
 * computed from `connectors.registry.json` and no regex can resolve it. That is
 * exactly why the name has to be recorded separately from the target — this
 * says "the export `spec` is reached somewhere", not "by this file", and a
 * finding for it would be a claim the operator cannot act on. The three
 * connectors this rule exists for (`gdacs`, `glofas`, `usgs-earthquake`) each
 * have a live reader in `test/connector-registry-parity.test.js`, and a gate
 * that reports them is one its operator learns to skim.
 *
 * A wrong-specifier false pass is the accepted cost, and it is small: the name
 * must still be an export of *some* module in `src/`, and it must appear
 * immediately after an `import(`. `spec` is the only name in this tree that
 * both is reached this way and was being reported, so the rule as written costs
 * three false findings removed and risks one false pass — a pass is the cheaper
 * error, because a false finding is a live export someone deletes.
 */
const DYNAMIC_INLINE_MEMBER_RE = /import[ \t]*\([^)]*\)+[ \t]*\.([A-Za-z_$][\w$]*)/g

/**
 * Resolve a relative specifier against the importing file, to a repo-relative
 * POSIX path. Returns null for a bare specifier (`node:fs`, `pg`), which is not
 * this check's jurisdiction.
 *
 * The *path*, never the basename: `routes/kpi.js` and `kpi.js` are two modules,
 * and keying on the basename is the false pass `check-module-coverage.mjs` was
 * rewritten to stop making.
 */
export function resolveSpecifier(fromPath, specifier) {
  if (!specifier.startsWith('.')) return null
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier))
}

/** Split `{ a, b as c }` into the source names it imports. */
function importedNames(clause) {
  const names = []
  for (const part of clause.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    // `a as b` imports `a`; the local alias is irrelevant to liveness.
    const source = trimmed.split(/\s+as\s+/)[0].trim()
    if (source) names.push(source)
  }
  return names
}

/**
 * Every export a `src/` file declares, and every import it makes.
 *
 * `exported` is the set of names this file makes available to an importer.
 * `imported` maps a resolved repo-relative path to the names taken from it.
 * `starImported` is the set of paths reached wholesale, through `import * as`
 * or `export * from` — every export of such a target is live, because the
 * member actually used cannot be resolved from the specifier alone.
 */
export function parseModule(filePath, source) {
  const exported = new Set()
  /** Names re-exported through a `from` clause — a second door, not a declaration. */
  const reexported = new Set()
  const imported = new Map()
  const starImported = new Set()
  // Names read off a namespace whose specifier is not resolvable. Module-level
  // rather than per-target: see DYNAMIC_INLINE_MEMBER_RE.
  const namespaceMembers = new Set()

  const take = (target, names) => {
    if (!target) return
    if (!imported.has(target)) imported.set(target, new Set())
    for (const name of names) imported.get(target).add(name)
  }

  for (const match of source.matchAll(NAMED_EXPORT_RE)) exported.add(match[1])

  for (const match of source.matchAll(EXPORT_BRACE_RE)) {
    const names = importedNames(match[1])
    // `export { a }` with no `from` re-exports a local binding under its own
    // name — `export { CHAINED_FIELDS }` in reconciliation.js is this form.
    // With a `from` it also imports those names from the target, and the door
    // it opens is a different thing from a declaration: `DEMO_SEED_BUDGET_MS`
    // is *used* in `maintenance.js` and merely *re-exported* by `server.js`,
    // so "wire it or delete it" is the wrong advice for the second one.
    const target = match[2] ? resolveSpecifier(filePath, match[2]) : null
    for (const part of match[1].split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const alias = trimmed.split(/\s+as\s+/).pop().trim()
      if (!alias) continue
      exported.add(alias)
      if (target) reexported.add(alias)
    }
    if (target) take(target, names)
  }

  for (const match of source.matchAll(EXPORT_STAR_RE)) {
    const target = resolveSpecifier(filePath, match[1])
    if (target) starImported.add(target)
  }

  for (const match of source.matchAll(IMPORT_BRACE_RE)) {
    take(resolveSpecifier(filePath, match[2]), importedNames(match[1]))
  }

  for (const match of source.matchAll(IMPORT_STAR_RE)) {
    const target = resolveSpecifier(filePath, match[1])
    if (target) starImported.add(target)
  }

  // A namespace bound from a dynamic import reaches every export of the target
  // by the same argument as `import * as ns` — the member used is not readable
  // from the specifier. Run this before the destructure pattern, which would
  // otherwise match the same text with a bogus single-name clause.
  for (const match of source.matchAll(DYNAMIC_NAMESPACE_RE)) {
    const target = resolveSpecifier(filePath, match[2])
    if (target) starImported.add(target)
  }

  // `(await import(<computed>)).name` — the specifier may be unreadable, so the
  // name is recorded globally rather than attributed to a target. See the rule.
  for (const match of source.matchAll(DYNAMIC_INLINE_MEMBER_RE)) {
    namespaceMembers.add(match[1])
  }

  for (const match of source.matchAll(DYNAMIC_DESTRUCTURE_RE)) {
    take(resolveSpecifier(filePath, match[2]), importedNames(match[1]))
  }

  return { exported, reexported, imported, starImported, namespaceMembers, hasDefault: DEFAULT_EXPORT_RE.test(source) }
}

/**
 * Blank out comments and string literals, so a name in prose is not read as a
 * use.
 *
 * Both halves are load-bearing and the second was found by a canary rather than
 * by reading. `beginCapture` is called nowhere, yet it survived the first scan
 * that reported its own sibling `endCapture` — because line 91 throws
 * `new TypeError('beginCapture: store must be a CaptureStore')`, and a name in
 * a string is no more a call than a name in a comment. Same class, one
 * delimiter over.
 *
 * Replacement is with spaces rather than deletion, so offsets and line numbers
 * survive and a name split across a stripped region cannot be joined into a
 * false match.
 *
 * A template literal keeps its `${…}` holes, because that is where a use
 * usually is — `url: \`${origin}${PEER_API_PATH}\`` is a call site, and a
 * stripper that blanked the whole literal reported `PEER_API_PATH` and
 * `APPNAME_REQUEST_URL` dead. The docstring on the first version of this
 * function claimed the approximation erred "toward reporting rather than
 * hiding", as though that were the safe direction. It is not: a false finding
 * is a live export someone deletes, so a reporting error is the expensive one
 * and the holes are kept.
 */
export function stripComments(source) {
  // Order matters, and the first draft got it wrong in a way a canary could
  // not have caught without knowing the file: `//` inside a *regex literal*
  // (`/^(text\/|application\/…)/`) was read as a line comment, blanking the
  // rest of a line that carried a real call. Strings are stripped first so
  // their `//` is already gone, and a regex literal is recognised by the
  // character that precedes its opening slash — an operator or a bracket,
  // never an identifier or a closing paren, which would make it a division.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => ' '.repeat(m.length))
    .replace(/`(?:[^`\\]|\\.)*`/g, blankTemplate)
    .replace(/(^|[=(,:[!&|?{};+\-*%<>~^])\s*(\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*)/g,
      (m, lead, re) => lead + ' '.repeat(m.length - lead.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
}

/**
 * Blank a template literal but keep its `${…}` holes, which is where a use
 * usually is: `url: \`${origin}${PEER_API_PATH}\`` is a call site, and a
 * stripper that blanked the whole literal reported `PEER_API_PATH` and
 * `APPNAME_REQUEST_URL` dead. The first version of the docstring above called
 * that approximation safe because it "errs toward reporting" — a false finding
 * is a live export someone deletes, so reporting is the expensive direction,
 * not the safe one.
 *
 * Offsets are preserved: every character outside a hole is replaced by one
 * space, and the hole is copied through unchanged.
 */
function blankTemplate(literal) {
  let out = ''
  let i = 0
  while (i < literal.length) {
    if (literal[i] === '$' && literal[i + 1] === '{') {
      // Walk to the matching brace, counting nesting.
      let depth = 0
      let j = i + 1
      for (; j < literal.length; j += 1) {
        if (literal[j] === '{') depth += 1
        else if (literal[j] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      out += literal.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += literal[i] === '\n' ? '\n' : ' '
    i += 1
  }
  return out
}

/**
 * Whether `name` appears in `source` other than in its own `export` clause.
 *
 * The member-access guard is the bug a first draft of the census made:
 * `(?<![\w$.])` excludes every `.`, which also excludes a spread — `...f(x)`
 * is a call, not a member access, and excluding it reported
 * `ensembleFieldsFor` dead while `src/connectors/open-meteo.js:239` calls it
 * three lines below its own definition. `(?<!(?<!\.)\.)` admits the spread's
 * second dot and still rejects `obj.name`.
 *
 * Comments are stripped first. This function's own docstring says prose is not
 * a use, and the first version of it counted prose anyway — its canary caught
 * the contradiction, which is the whole reason the canary is written against
 * the docstring's claim rather than against a convenient fixture.
 */
export function usedInOwnBody(source, name) {
  const body = stripComments(source)
  const escaped = name.replace(/\$/g, '\\$')
  const word = new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.)${escaped}(?![\\w$])`, 'g')
  const exportLine = new RegExp(`^[ \\t]*export[ \\t].*\\b${escaped}\\b`, 'm')
  const hits = body.match(word) ?? []
  // One occurrence is the declaration itself when the declaration names it.
  return exportLine.test(body) ? hits.length > 1 : hits.length > 0
}

/**
 * The finding list.
 *
 * Two classes, and they are not the same defect:
 *
 *   - **`unimported-export`** — no file imports the name. This is the finding,
 *     and it splits by whether the module's own body uses it. A name used only
 *     inside its own module is *not dead*: the function runs, and the only
 *     thing wrong is a wider `export` than the module needs. That is a lint,
 *     not a defect, and it is reported as a count rather than a finding — 157
 *     of them here, and a gate that fails on 157 cosmetic lines teaches its
 *     operator to bypass it. A name *nothing* reaches, inside or out, is the
 *     `resetSdnCache` shape: a capability the tree built, documented as used,
 *     and wired to nothing.
 *
 * `sources` is an array of `{ path, source }` with repo-relative POSIX paths.
 * Pure, so a canary fails only for a reason the rule names.
 */
export function deadExportFindings({
  sources,
  entryPoints = ENTRY_POINTS,
  allowlist = SURFACE_EXEMPT_EXPORTS,
}) {
  const byPath = new Map(sources.map((s) => [s.path, s]))
  const parsed = new Map(sources.map((s) => [s.path, parseModule(s.path, s.source)]))

  // Names taken from a path, by import or by a re-export that carries them.
  const takenFrom = new Map()
  const starFrom = new Set()
  for (const [filePath, module] of parsed) {
    for (const [target, names] of module.imported) {
      if (!takenFrom.has(target)) takenFrom.set(target, new Set())
      for (const name of names) takenFrom.get(target).add(name)
    }
    for (const target of module.starImported) starFrom.add(target)
  }

  // The package entry point makes everything it re-exports public surface, and
  // its own exports are surface too: `src/index.js` *is* the boundary, so a
  // name it declares is reached by an integrator no grep can see.
  const publicNames = new Set()
  for (const entry of entryPoints) {
    const module = parsed.get(entry)
    if (!module) continue
    for (const name of module.exported) publicNames.add(`${entry}::${name}`)
    for (const [target, names] of module.imported) {
      for (const name of names) publicNames.add(`${target}::${name}`)
    }
    for (const target of module.starImported) starFrom.add(target)
  }

  // Every name read off an unresolvable namespace specifier, gathered across
  // the whole scan. Deliberately global: the point of the rule is that the
  // target cannot be attributed, so attributing the *name* to a file would be
  // the same false finding one indirection out.
  const memberReached = new Set()
  for (const module of parsed.values()) {
    for (const name of module.namespaceMembers) memberReached.add(name)
  }

  const findings = []
  const overExported = []
  for (const [filePath, module] of parsed) {
    if (!filePath.startsWith('src/')) continue
    for (const name of module.exported) {
      const key = `${filePath}::${name}`
      const taken = takenFrom.get(filePath)?.has(name) ?? false
      const wholesale = starFrom.has(filePath)
      const isPublic = publicNames.has(key)
      const exempt = allowlist[key]
      // Reached by name off a namespace import whose target this parser cannot
      // resolve — `(await import(<computed>)).spec`. Global by design; the
      // alternative is a finding naming a file the operator has no fix for.
      const member = memberReached.has(name)

      if (taken || wholesale || isPublic || member) {
        // The other direction: an exemption a name import now reaches is a
        // reason that has expired, and a stale entry is an exemption nobody
        // re-reads.
        if (exempt && taken) {
          findings.push({
            rule: 'stale-exemption',
            key,
            detail: 'named in SURFACE_EXEMPT_EXPORTS, but a name import reaches it now. Remove the entry.',
          })
        }
        continue
      }
      if (exempt) continue

      const selfUsed = usedInOwnBody(byPath.get(filePath)?.source ?? '', name)
      if (selfUsed) {
        overExported.push(key)
        continue
      }
      // A re-export is a second door, and the advice differs: the binding is
      // alive in the module it came from, so this door is redundant rather
      // than unwired. `server.js` re-exports `DEMO_SEED_BUDGET_MS` that
      // `routes/maintenance.js` both declares and uses.
      const door = module.reexported.has(name) ? 'redundant-re-export' : 'unimported-export'
      findings.push({
        rule: door,
        key,
        detail: door === 'redundant-re-export'
          ? 'nothing imports this name from this file; the door is redundant, not the binding.'
          : 'nothing imports this name and the module it lives in never calls it. Wire it or delete it.',
      })
    }
  }
  return { findings: findings.sort((a, b) => a.key.localeCompare(b.key)), overExported: overExported.sort() }
}

async function walk(dir, suffixes) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.claude') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full, suffixes))
    else if (suffixes.some((s) => entry.name.endsWith(s))) out.push(full)
  }
  return out
}

async function scan() {
  // The reference surface is the whole repository, not `src/` + `test/`: a
  // browser module under `public/` importing a `src/` file is a consumer, and a
  // census scoped to `src/` would report its exports dead.
  const files = await walk(ROOT, ['.js', '.mjs'])
  const sources = await Promise.all(files.map(async (f) => ({
    path: path.relative(ROOT, f).split(path.sep).join('/'),
    source: await fs.readFile(f, 'utf8'),
  })))
  const { findings, overExported } = deadExportFindings({ sources })
  const srcExports = sources
    .filter((s) => s.path.startsWith('src/') && !s.path.endsWith('.test.js'))
    .reduce((n, s) => n + parseModule(s.path, s.source).exported.size, 0)
  return { findings, overExported, checked: srcExports, files: sources.length }
}

/**
 * Canaries. Each drives `deadExportFindings` with in-memory sources. Both
 * directions of the rule are covered — an import reaches a name and passes, an
 * import reaches a name *and* the name is exempted and is a stale exemption —
 * because a checker that tested one direction would report a clean tree for a
 * rule it never applied.
 */
export const CANARIES = [
  {
    name: 'passes an export a name import reaches',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export function live() {}\n' },
        { path: 'src/b.js', source: "import { live } from './a.js'\nlive()\n" },
      ],
    },
    expect: 0,
  },
  {
    name: 'flags an export no import reaches — the shape that hid resetSdnCache',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export function live() {}\nexport function dead() {}\n' },
        { path: 'src/b.js', source: "import { live } from './a.js'\nlive()\n" },
      ],
    },
    expect: 1,
  },
  {
    // The instrument bug that started this. A docstring naming the export is
    // not a call site, and a census that reads prose as a consumer cannot see
    // that the function is never invoked.
    name: 'does not count a mention in a docstring as reaching an export',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export function beginCapture() {}\n' },
        // No exports of its own, so the only thing the count can be is
        // `beginCapture` — a fixture with a second unimported export would
        // pass for the wrong reason.
        { path: 'src/b.js', source: '/** `beginCapture` turns capture on for the process. */\nconst note = 1\nexport default note\n' },
      ],
    },
    expect: 1,
  },
  {
    name: 'passes an export reached through a namespace import, whose member use is unresolvable',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export function maybe() {}\n' },
        { path: 'src/b.js', source: "import * as a from './a.js'\na.maybe()\n" },
      ],
    },
    expect: 0,
  },
  {
    // `(await import(<computed>)).spec` — the specifier is built from a registry
    // file, so no parser can resolve it, and the name is what is known. This is
    // the shape that made the gate report three live connector specs.
    name: 'passes an export read off a namespace whose specifier is computed',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export const spec = { id: 1 }\n' },
        { path: 'src/b.js', source: "const m = (await import(path.join(ROOT, entry.module))).spec\n" },
      ],
    },
    expect: 0,
  },
  {
    // And the rule does not swallow everything: a name read this way that no
    // module exports is not a finding either, but an export of a *different*
    // module reached by nothing stays one.
    name: 'still reports an export no namespace read and no import reaches',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export const spec = { id: 1 }\nexport function orphaned() {}\n' },
        { path: 'src/b.js', source: "const m = (await import(path.join(ROOT, entry.module))).spec\n" },
      ],
    },
    expect: 1,
  },
  {
    name: 'passes an export reached through `export * from`, which re-exports the whole module',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export function maybe() {}\n' },
        { path: 'src/b.js', source: "export * from './a.js'\n" },
      ],
    },
    expect: 0,
  },
  {
    name: 'passes package surface re-exported from the entry point, whose consumer is outside the repo',
    input: {
      sources: [
        { path: 'src/storage.js', source: 'export function createStoreFromEnv() {}\n' },
        { path: 'src/index.js', source: "export { createStoreFromEnv } from './storage.js'\n" },
      ],
    },
    expect: 0,
  },
  {
    name: 'flags a re-export whose name nothing imports, even though the target module is live',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export const used = 1\nexport const unused = 2\n' },
        { path: 'src/b.js', source: "export { used, unused } from './a.js'\n" },
        { path: 'src/c.js', source: "import { used } from './b.js'\nused\n" },
      ],
    },
    expect: 1,
  },
  {
    name: 'flags a stale exemption: allowlisted and now reached by a name import',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export function f() {}\n' },
        { path: 'src/b.js', source: "import { f } from './a.js'\nf()\n" },
      ],
      allowlist: { 'src/a.js::f': 'reached by a test harness' },
    },
    expect: 1,
  },
  {
    name: 'passes an allowlisted export no import reaches',
    input: {
      sources: [{ path: 'src/a.js', source: 'export function f() {}\n' }],
      allowlist: { 'src/a.js::f': 'reached by a test harness' },
    },
    expect: 0,
  },
  {
    name: 'resolves a specifier against the importing file, not the repo root',
    input: {
      sources: [
        { path: 'src/routes/kpi.js', source: 'export function routeKpi() {}\n' },
        { path: 'src/server.js', source: "import { routeKpi } from './routes/kpi.js'\nrouteKpi()\n" },
      ],
    },
    expect: 0,
  },
  {
    name: 'does not let a module of the same basename cover another — routes/kpi.js vs kpi.js',
    input: {
      sources: [
        { path: 'src/kpi.js', source: 'export function shared() {}\n' },
        { path: 'src/routes/kpi.js', source: 'export function shared() {}\n' },
        { path: 'src/server.js', source: "import { shared } from './kpi.js'\nshared()\n" },
      ],
    },
    expect: 1,
  },
  {
    name: 'does not count a bare specifier as reaching a src export',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export function f() {}\n' },
        { path: 'src/b.js', source: "import { readFile } from 'node:fs/promises'\nreadFile\n" },
      ],
    },
    expect: 1,
  },
  {
    name: 'ignores a specifier that points outside src/, which is not its jurisdiction',
    input: {
      sources: [
        { path: 'public/shared/x.js', source: 'export function helper() {}\n' },
        { path: 'src/a.js', source: "import { helper } from '../public/shared/x.js'\nhelper()\n" },
      ],
    },
    expect: 0,
  },
  {
    // The distinction that made the first scan of this gate 180 findings. A
    // name the module's own body calls is *live*; only its `export` is wider
    // than it needs. That is a lint, and mixing it into the finding list is how
    // a gate becomes noise its operator bypasses.
    name: 'reports an export used only inside its own module as over-exported, not as dead',
    input: {
      sources: [{ path: 'src/a.js', source: 'export function inner(v) { return v }\nfunction outer() { return inner(1) }\nexport default outer\n' }],
    },
    expect: 0,
    expectOverExported: 1,
  },
  {
    // The other half: a name nothing reaches, inside or out. This is the shape
    // that hid `resetSdnCache`.
    name: 'reports an export nothing reaches at all as dead, not as over-exported',
    input: {
      sources: [{ path: 'src/a.js', source: 'export function used() { return 1 }\nexport function unused() { return 2 }\n' }],
    },
    expect: 2,
    expectOverExported: 0,
  },
  {
    name: 'counts a spread call as a use of the export, not as a member access',
    input: {
      sources: [{ path: 'src/a.js', source: 'export function fieldsFor(d) { return d }\nfunction outer(d) { return { ...fieldsFor(d) } }\nexport default outer\n' }],
    },
    expect: 0,
    expectOverExported: 1,
  },
  {
    name: 'passes an export reached by `const { x } = await import(...)`, the form 53 test files use',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export function stats() {}\n' },
        { path: 'src/b.js', source: "const { stats } = await import('./a.js')\nstats()\n" },
      ],
    },
    expect: 0,
  },
  {
    name: 'passes every export reached by `const ns = await import(...)`, a namespace binding',
    input: {
      sources: [
        { path: 'src/a.js', source: 'export function stats() {}\n' },
        { path: 'src/b.js', source: "const ns = await import('./a.js')\nns.stats()\n" },
      ],
    },
    expect: 0,
  },
  {
    name: 'does not count a docstring mention as the module using its own export',
    input: {
      sources: [{ path: 'src/a.js', source: '/** `resetSdnCache` is used by tests. */\nexport function resetSdnCache() {}\n' }],
    },
    expect: 1,
    expectOverExported: 0,
  },
  {
    // A hole is a use. `PATH` here is exported and used only inside its own
    // module, so the right answer is over-exported — one finding class lower
    // than dead. A stripper that blanked the hole reported it dead, which is
    // the false positive that made this canary.
    name: 'counts a use inside a template literal hole as a use, not as prose',
    input: {
      sources: [{ path: 'src/a.js', source: 'export const PATH = "/x"\nfunction go(origin) { return `${origin}${PATH}` }\nexport default go\n' }],
    },
    expect: 0,
    expectOverExported: 1,
  },
  {
    // The same class one delimiter over, and the canary that found it:
    // `beginCapture` is called nowhere but throws a message naming itself, so
    // a scanner that reads strings as code calls it live while flagging its
    // sibling `endCapture`.
    name: 'does not count a name inside a thrown message as the module using its own export',
    input: {
      sources: [{ path: 'src/a.js', source: "export function beginCapture() { throw new TypeError('beginCapture: bad store') }\n" }],
    },
    expect: 1,
    expectOverExported: 0,
  },
]

async function selfTest() {
  let failed = 0
  const expectations = new Set(CANARIES.map((c) => c.expect))
  if (expectations.size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const { findings, overExported } = deadExportFindings(canary.input)
    const got = findings.length
    const ok = got === canary.expect && overExported.length === (canary.expectOverExported ?? 0)
    if (!ok) failed += 1
    const extra = canary.expectOverExported ? `, ${overExported.length} over-exported` : ''
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}${extra}, got ${got}${extra ? `, ${overExported.length} over-exported` : ''}`)
  }
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(await selfTest())
  const { findings, overExported, checked, files } = await scan()
  const summary = `${checked} export(s) across src/, ${files} file(s) searched`
  if (findings.length === 0) {
    console.log(`dead exports: clean — ${summary}`)
    console.log(`  ${overExported.length} export(s) used only inside their own module (a wider \`export\` than needed; not a finding)`)
    process.exit(0)
  }
  console.error(`dead exports: ${findings.length} finding(s) across ${summary}\n`)
  for (const f of findings) console.error(`  [${f.rule}] ${f.key}\n    ${f.detail}`)
  console.error(`\n${overExported.length} further export(s) are used only inside their own module.`)
  console.error('Those run; only the `export` keyword is unnecessary, and they are not findings.')
  console.error('\nAn export nothing reaches is a capability the tree built and did not wire.')
  console.error('Either wire it and assert the payload, or delete it — and if a docstring')
  console.error('names a caller, check the docstring is not the only thing naming it.')
  process.exit(1)
}

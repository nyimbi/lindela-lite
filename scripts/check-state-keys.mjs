#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * R-68 — every key a surface's `state` object is read or written through is
 * declared in the literal that object is built from.
 *
 * The defect this closes was one key, and it is worth stating why one key is
 * worth a gate. `public/app.js` read and wrote `state.selectedRecordId` on the
 * deep-link round trip, and the literal that defines `state` never named it. The
 * object worked, because JavaScript does not require a key to be declared — so
 * nothing failed, no test noticed, and the key was correct. What was wrong is
 * that the literal is the only place the surface's shape is written down, and a
 * reader (or a reset written as `Object.keys(state)`) trusts it. The fix for
 * `selectedRecordId` was one line. Finding the other five took a scanner,
 * because the class is invisible by construction: an undeclared key and a
 * declared one behave identically until something enumerates the object.
 *
 * **The scope is one file's own literal, and that is the whole difficulty.**
 * The naive reading is "any `state.foo` not in the literal", which is what a
 * regex gives you, and it is wrong in two directions that both produce noise:
 *
 *  - **Shadowing.** `public/app.js` has `function renderSeasonalStrip()` with
 *    `const state = readSeasonalState(observations)` and, separately,
 *    `function seasonalSummary(state)`. Both use `state.anomalyC`,
 *    `state.phase`, `state.period` and six more, none of which are the console's
 *    state. A regex scanner reports nine false positives here — and nine false
 *    positives in a gate is how the gate gets turned off.
 *  - **Not-code.** `state.js` appears in an import specifier and `state.empty_alerts`
 *    in an i18n key inside a template literal. Neither is a property access.
 *
 * So the gate does not use a regex. It parses each file with the same
 * `_js-scope.mjs`-style walker the other source gates use, and it resolves
 * `state` **lexically**: a reference counts only when the nearest binding of
 * that name is the module-level `const state = {...}` this gate is checking.
 * A function parameter or a local `const` named `state` rebinds the name, and
 * every reference inside its extent is attributed to that binding instead.
 *
 * **What it does not check.** That the initial values are right, that a declared
 * key is ever used, or anything about a surface whose state is not a single
 * module-level object literal. `public/shared/intent-console.js` builds its
 * state inside a function; the gate reports the file as out of jurisdiction
 * rather than guessing. Silence there is the correct answer, and it is printed,
 * so it cannot be mistaken for coverage.
 *
 * Exit 0 when every reference is declared, 1 with the undeclared keys listed.
 * Canaried in `--self-test`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The surfaces that hold one module-level `state` object. Listed rather than
 * discovered by `glob('**\/app.js')`: a new surface with a different state shape
 * should be a deliberate addition here, not something that silently joins a
 * check written for another shape. `public/portal`, `public/scenarios` and
 * `public/chw` are in the list because they pass today — a gate that only lists
 * the files it has already failed on is a gate that never guards anything new.
 */
const SURFACES = [
  'public/app.js',
  'public/chw/app.js',
  'public/focal-point/app.js',
  'public/portal/app.js',
  'public/scenarios/app.js',
]

/**
 * Strip comments and string/template literals, replacing each with same-length
 * whitespace so offsets and line numbers survive.
 *
 * The reason this is a scanner and not a regex: `state.empty_alerts` lives in a
 * template literal and `state.js` in an import specifier, and both are text that
 * looks exactly like a property access. Doing this first is what makes the
 * reference walk below able to treat every remaining `state.` as code.
 *
 * A regex-based stripper is a known hazard in this repository (a `/` in a
 * division is not a comment start). The state here is deliberately small: track
 * whether the previous significant token could end an expression, and only then
 * read `/` as a regex. Anything it cannot classify it leaves alone, which
 * degrades to the noise this gate exists to avoid rather than to a wrong
 * silence.
 */
function stripNonCode(src) {
  const out = src.split('')
  const blank = (from, to) => { for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ' }
  let i = 0
  let prevSignificant = ''
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i)
      const stop = end < 0 ? src.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (c === '/' && !/[)\]\w$]/.test(prevSignificant)) {
      // A regex literal, which may contain quotes and slashes.
      let j = i + 1
      let inClass = false
      for (; j < src.length; j += 1) {
        const d = src[j]
        if (d === '\\') { j += 1; continue }
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        else if (d === '\n') break
      }
      blank(i, j + 1)
      i = j + 1
      prevSignificant = ')'
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      for (; j < src.length; j += 1) {
        if (src[j] === '\\') { j += 1; continue }
        if (src[j] === c) break
      }
      blank(i, j + 1)
      i = j + 1
      prevSignificant = c
      continue
    }
    if (!/\s/.test(c)) prevSignificant = c
    i += 1
  }
  return out.join('')
}

/**
 * Find the module-level `const state = { ... }` literal and return its key set
 * with the brace span.
 *
 * "Module-level" is checked by column: the declaration must start at column 0.
 * A `const state` nested inside a function is a different object and is the
 * shadowing case, not the subject.
 */
function findStateLiteral(code) {
  const re = /^(?:const|let|var)\s+state\s*=\s*\{/gm
  const match = re.exec(code)
  if (!match) return null
  const open = code.indexOf('{', match.index)
  let depth = 0
  let close = -1
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) { close = i; break }
    }
  }
  if (close < 0) return null
  const body = code.slice(open, close)
  const keys = new Set()
  // Depth-1 keys only: `{ coldChain: false }` inside `filters` is a nested
  // object's key, not a state key.
  let d = 0
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (c === '{') d += 1
    else if (c === '}') d -= 1
    else if (d === 1 && /[A-Za-z_$]/.test(c) && (i === 0 || /[\s,{]/.test(body[i - 1]))) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i))
      if (m) { keys.add(m[1]); i += m[0].length - 1 }
    }
  }
  return { keys, start: match.index, end: close, bodyStart: open }
}

/**
 * Every span in which the identifier `state` is bound to something other than
 * the module-level object: function parameters and nested declarations.
 *
 * Returned as `[start, end]` character ranges. A reference inside one is not a
 * reference to the subject, and attributing it to the subject is the
 * nine-false-positive failure described at the top.
 */
function shadowSpans(code, literal) {
  // Every function body in the file, as `[headStart, bodyStart, bodyEnd]`.
  const bodies = []
  const headRe = /(?:^|[\s=(,:;])(?:async\s+)?function\s*[\w$]*\s*\(([^)]*)\)|(?:^|[\s=(,:;])\(([^)]*)\)\s*=>|(?:^|[\s=(,:;])([\w$]+)\s*=>/gm
  let m
  while ((m = headRe.exec(code)) !== null) {
    const params = m[1] ?? m[2] ?? m[3] ?? ''
    // An arrow with an expression body has no brace of its own; skip it, since
    // it cannot contain a `const` and its references are covered by whatever
    // encloses it.
    const bodyStart = code.indexOf('{', m.index + m[0].length)
    if (bodyStart < 0) continue
    // A `{` that belongs to a destructuring parameter or an object literal in
    // the head would fool this; the heads above have no such shapes.
    let depth = 0
    let bodyEnd = code.length
    for (let i = bodyStart; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1
      else if (code[i] === '}') {
        depth -= 1
        if (depth === 0) { bodyEnd = i; break }
      }
    }
    bodies.push({ headStart: m.index, bodyStart, bodyEnd, params })
  }

  // A body shadows the module-level `state` when it takes `state` as a
  // parameter, or declares its own `const state =` directly inside it. The
  // second case is the one a naive span gets wrong: `const state = read(obs)`
  // has no brace on its line, so an extent read as "up to the next `{`" ends at
  // the following `if` block and leaves the rest of the function attributed to
  // the console's state — which is exactly the four false positives this gate
  // reported on its first run against the tree.
  const spans = []
  for (const body of bodies) {
    const declaresOwn = /(?:^|[\n{;])\s*(?:const|let|var)\s+state\s*=/.test(
      code.slice(body.bodyStart, body.bodyEnd),
    )
    if (!/\bstate\b/.test(body.params) && !declaresOwn) continue
    spans.push([body.headStart, body.bodyEnd])
  }

  // The module-level literal itself is not a shadow, and neither is a
  // declaration at column 0 anywhere else.
  return spans.filter(([a]) => a !== literal.start)
}

/** Undeclared `state.<key>` references in one source string. */
export function scanSource(src) {
  const code = stripNonCode(src)
  const literal = findStateLiteral(code)
  if (!literal) return { outOfJurisdiction: true, undeclared: [] }
  const spans = shadowSpans(code, literal)
  const inside = (at) => spans.some(([a, b]) => at >= a && at <= b)
  const undeclared = new Map()
  const re = /\bstate\s*\.\s*([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(code)) !== null) {
    if (inside(m.index)) continue
    // A computed member (`state[key]`) is not a fixed key and is out of scope:
    // the gate cannot know it, and guessing would be worse than silence.
    if (m[1] === undefined) continue
    if (literal.keys.has(m[1])) continue
    const line = code.slice(0, m.index).split('\n').length
    const existing = undeclared.get(m[1])
    if (existing) existing.count += 1
    else undeclared.set(m[1], { key: m[1], line, count: 1 })
  }
  return {
    outOfJurisdiction: false,
    declared: literal.keys.size,
    undeclared: [...undeclared.values()].sort((a, b) => a.line - b.line),
  }
}

/** Scan every surface. */
export function scanTree(root) {
  const findings = []
  const skipped = []
  for (const rel of SURFACES) {
    const file = path.join(root, rel)
    if (!fs.existsSync(file)) { skipped.push({ file: rel, reason: 'absent' }); continue }
    const result = scanSource(fs.readFileSync(file, 'utf8'))
    if (result.outOfJurisdiction) { skipped.push({ file: rel, reason: 'no module-level state literal' }); continue }
    for (const item of result.undeclared) findings.push({ file: rel, ...item })
  }
  return { findings, skipped }
}

/**
 * Canaries. Each is a whole source string, so the scanner is exercised the way
 * it runs rather than through a helper.
 */
export const CANARIES = [
  {
    name: 'flags a key that is read but not declared',
    source: 'const state = { a: 1 }\nfunction f() { return state.b }\n',
    expect: 1,
  },
  {
    name: 'passes a key that is declared',
    source: 'const state = { a: 1, b: 2 }\nfunction f() { return state.b }\n',
    expect: 0,
  },
  {
    name: 'does not count a shadowing function parameter',
    // The exact shape in public/app.js: a helper that takes its own `state`.
    source: 'const state = { a: 1 }\nfunction summary(state) { return state.anomalyC + state.phase }\n',
    expect: 0,
  },
  {
    name: 'does not count a shadowing local const',
    source: 'const state = { a: 1 }\nfunction f(obs) { const state = read(obs); return state.anomalyC }\n',
    expect: 0,
  },
  {
    name: 'does not count a key inside a string literal',
    source: 'const state = { a: 1 }\nconst label = t("state.empty_alerts")\n',
    expect: 0,
  },
  {
    name: 'does not count a key inside a comment',
    source: 'const state = { a: 1 }\n// state.removed was deleted in 2026-09\n',
    expect: 0,
  },
  {
    name: 'does not count an import specifier that looks like an access',
    source: 'const state = { a: 1 }\nimport x from "/shared/state.js"\n',
    expect: 0,
  },
  {
    name: 'counts a nested object key as nested, not as a state key',
    source: 'const state = { filters: { coldChain: false } }\nfunction f() { return state.filters.coldChain }\n',
    expect: 0,
  },
  {
    name: 'flags two undeclared keys, not just the first',
    source: 'const state = { a: 1 }\nfunction f() { return state.b + state.c }\n',
    expect: 2,
  },
  {
    name: 'reports a file with no module-level literal as out of jurisdiction',
    source: 'function f() { const state = { a: 1 }; return state.a }\n',
    expect: 0,
  },
]

function selfTest() {
  let failed = 0
  for (const canary of CANARIES) {
    const got = scanSource(canary.source).undeclared.length
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  // The expectations must not be uniform, or a scanner returning a constant
  // would pass every canary above.
  const distinct = new Set(CANARIES.map((c) => c.expect))
  if (distinct.size < 2) {
    console.log('FAIL the canaries no longer disagree, so a constant scanner would pass them')
    failed += 1
  }
  const real = scanTree(ROOT)
  const ok = real.findings.length === 0
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} the tree is clean — ${real.findings.length} finding(s)`)
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest())
  const { findings, skipped } = scanTree(ROOT)
  if (findings.length === 0) {
    console.log(`state-key check: clean — ${SURFACES.length - skipped.length} surface(s) checked, ${skipped.length} out of jurisdiction`)
    for (const s of skipped) console.log(`  (not checked: ${s.file} — ${s.reason})`)
    process.exit(0)
  }
  console.error(`state-key check: ${findings.length} undeclared state key(s)\n`)
  for (const f of findings) console.error(`  ${f.file}:${f.line}  state.${f.key}  (${f.count} reference(s))`)
  console.error('\nA key the state literal does not declare is one nothing enumerating the object can')
  console.error('see, and one a reset written as `Object.keys(state)` silently drops. Declare it in the')
  console.error('literal with its honest initial value, or delete the reference.')
  process.exit(1)
}

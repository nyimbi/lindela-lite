#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MEASUREMENT_PERIODS,
  UNSPECIFIED_PERIOD,
  mixedPeriodFields,
} from '../public/shared/units.js'

/**
 * ENH-47 — the unit-and-dimension gate.
 *
 * The register's example was a millimetre/metre mix rendering as a plausible
 * number. A scan of the tree found **no such site**, and that finding is the
 * first thing this gate is built on: a gate written to catch the example would
 * have exited 0 forever, and an exit 0 from a gate that has never been watched
 * fail is not evidence of anything. The class is real; the instance was
 * elsewhere.
 *
 * Where it actually is: `precipitation_mm` is written into
 * `climate_observations` by `src/connectors/open-meteo.js` twice — once from the
 * API's `current` block, which the vendor documents as the **preceding 15
 * minutes**, and once from its `daily` block, which is the **whole-day total**.
 * Same dimension, same scale, same field name, so no dimension check and no
 * scale check can see the problem. `src/analytics.js` then averages the two, and
 * a 3 mm quarter-hour beside a 40 mm day publishes as "21.5 mm" — a number that
 * describes no period at all.
 *
 * So this gate checks the two things that are actually checkable:
 *
 *   **A. Every writer declares its period.** A connector that assigns a
 *   non-null value to an accumulating field must have its `source:type` pair in
 *   `MEASUREMENT_PERIODS`. This is what makes the third axis a fact on the
 *   record rather than something a reader infers from a comment.
 *
 *   **B. Every reader of a mixed-period field is period-aware.** A module that
 *   mentions a field the table declares at more than one period *and* aggregates
 *   with `reduce` must import the period-aware helper from the registry, or
 *   carry a `unit-ok:` marker saying why its aggregate is sound anyway.
 *
 * **What B cannot see, stated rather than hidden.** The scanner is file-level,
 * not site-level, and it reads the field name. `src/analytics.js` computes its
 * mean over a filtered alias (`usablePrecip`), so a scanner looking for the name
 * inside the `reduce` would miss the very site this gate exists for. Coarse and
 * firing beats precise and blind: a file that touches the field and aggregates
 * is asked to be period-aware, and the marker is one line when it already is.
 * The cost is false positives, which is the direction a gate may fail in.
 *
 * Exit 0 when clean, 1 with the sites listed. Canaried in `--self-test`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where source lives. Connectors write, modules read; both halves are checked. */
const SCAN_DIRS = ['src', 'public']
const CONNECTOR_DIR = path.join('src', 'connectors')
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', '.git'])

/** The accumulating fields the period table names — the only kind a period applies to. */
function accumulatingFields() {
  const fields = new Set()
  for (const entry of Object.values(MEASUREMENT_PERIODS)) {
    if (entry?.field) fields.add(entry.field)
  }
  return [...fields]
}

/** Fields the table declares at more than one period. Re-exported from the registry. */
export const mixedFields = mixedPeriodFields

function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, out)
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Remove a trailing line comment without being fooled by `//` inside a string. */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

/** `unit-ok: <reason>` on the line or in the paragraph above it. */
const ALLOW = /unit-ok:\s*\S/

/** The paragraph a finding sits in — the run of lines back to the previous blank. */
function allowedContext(lines, index) {
  let start = index
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1
  return lines.slice(start, index + 1).join('\n')
}

/**
 * Check A — a connector that writes an accumulating field declares its period.
 *
 * The file's `type:` literals are collected, the `source` constant is read from
 * its declaration, and each `source:type` pair must be in the table. A file that
 * writes no accumulating field, or writes only `null`, is not this check's
 * business: CHIRPS reports which rasters exist and carries `precipitation_mm:
 * null` by construction, and requiring a period for a field that is always null
 * would be a rule with no subject.
 *
 * Exported so the canaries drive it with text.
 */
export function scanWriter(source, { file = '<memory>', periods = MEASUREMENT_PERIODS } = {}) {
  const findings = []
  const lines = source.split('\n')
  const accumulating = accumulatingFields()

  const sourceConst = /const\s+SOURCE\s*=\s*'([^']+)'/.exec(source)?.[1] || null
  const types = [...source.matchAll(/\btype:\s*'([^']+)'/g)].map((m) => m[1])
  if (!types.length || !sourceConst) return findings

  // Does this file ever assign an accumulating field to something that is not
  // the literal `null`? A file that only ever writes `null` has nothing to
  // declare, which is the CHIRPS case.
  let writesRealValue = false
  for (let i = 0; i < lines.length; i += 1) {
    const code = stripComment(lines[i])
    for (const unit of accumulating) {
      const assign = new RegExp(`\\b[a-z_]*_?${unit}\\s*:\\s*(.+?)\\s*,?$`).exec(code)
      if (assign && assign[1].trim() !== 'null') { writesRealValue = true; break }
    }
    if (writesRealValue) break
  }
  if (!writesRealValue) return findings

  for (const type of types) {
    if (periods[`${sourceConst}:${type}`]) continue
    const line = lines.findIndex((l) => l.includes(`type: '${type}'`))
    findings.push({
      file,
      line: line + 1,
      kind: 'undeclared-period',
      text: `${sourceConst}:${type}`,
      message: `writes an accumulating measurement but states no period; add it to MEASUREMENT_PERIODS in public/shared/units.js`,
    })
  }
  return findings
}

/**
 * Check B — a module that aggregates a mixed-period field is period-aware.
 *
 * Statement-scoped, not file-scoped. The first draft flagged any file that
 * mentioned the field and reduced anything at all, which fired on nine innocent
 * modules and — worse — was the wrong shape to catch the site it existed for,
 * because that site reduces over an alias. This version carries the field name
 * through the local declarations that read it, so `usablePrecip.reduce(...)`
 * is recognised as an aggregate over `precipitation_mm` when `usablePrecip` was
 * built from it two statements up. The taint is one-way and name-based: a
 * declaration is tainted when its initialiser names a mixed field or another
 * tainted name, and a `reduce` is flagged when its receiver is tainted.
 *
 * **What it still cannot see, stated rather than hidden.** Taint does not cross
 * a function boundary, so a module that hands the field to a helper and reduces
 * the result is not flagged. That is the conservative direction — it under-
 * reports rather than inventing findings — and the marker discipline covers the
 * rest. A gate that cries wolf is one people disable; the aggregation-kind gate
 * already learned that a marker converts a judgement call into a line a
 * reviewer reads.
 */
export function scanReader(source, { file = '<memory>', mixed = mixedFields() } = {}) {
  const findings = []
  if (mixed.size === 0) return findings
  const lines = source.split('\n')
  const names = [...mixed]
  const mentions = (text) => names.some((f) => new RegExp(`\\b${f}\\b`).test(text))

  // Taint by declaration. A declaration's initialiser ends where the statement
  // does — bracket depth back to zero and no trailing operator — not at the
  // next `const`. Ending it at the next declaration is what made the first
  // version of this report `hazards`, `conflicts` and `contributors` as
  // precipitation-derived: their window ran on through unrelated statements
  // that did mention the field, and a false positive here is what teaches an
  // operator to disable the gate.
  const declared = []
  const CONTINUES = /[=(+\-*/%&|?:,[{]$/
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[i])
    if (!m) continue
    let depth = 0
    let end = i
    for (; end < lines.length; end += 1) {
      for (const ch of stripComment(lines[end])) {
        if ('([{'.includes(ch)) depth += 1
        else if (')]}'.includes(ch)) depth -= 1
      }
      const trimmed = stripComment(lines[end]).trimEnd()
      // A statement continues while brackets are open, while the line ends in
      // an operator, or while the *next* line begins with `.` — the last is the
      // prettier-formatted method chain, and leaving it out truncated
      // `const rainfall = climate` at its first line. That cost the gate the
      // second live instance of the defect, in the climate-conflict scorer in
      // the same module, which is exactly the pattern this repository keeps
      // finding: the class has more than one member and the second is a few
      // hundred lines down.
      const next = end + 1 < lines.length ? stripComment(lines[end + 1]).trimStart() : ''
      if (depth <= 0 && !CONTINUES.test(trimmed) && !next.startsWith('.')) break
    }
    declared.push({ name: m[1], text: lines.slice(i, end + 1).join('\n'), line: i })
    i = end
  }

  /**
   * Reduce an initialiser to the path it selects from, plus whatever its array
   * callbacks mentioned. Returns null when the initialiser is not a pure
   * selection — which is the point.
   *
   * Taint survives a *selection* of the measurement (`.map`, `.filter`,
   * `.slice` and friends: the elements are still readings of the same field)
   * and dies at any *transformation* of it. That distinction is not a nicety:
   * the first version propagated taint through arithmetic, so `score` — a risk
   * index built from the rainfall mean, not a rainfall — carried the field
   * forward into `confidence`, `contributors` and every count derived from
   * them, and the gate reported eight sites where there was one. A gate that
   * flags derived quantities is a gate that flags everything.
   */
  const SELECTORS = new Set(['map', 'filter', 'slice', 'flat', 'flatMap', 'concat', 'sort', 'toSorted', 'reverse', 'values', 'keys', 'entries'])
  const reduceToSelection = (text) => {
    let out = ''
    const removed = []
    for (let i = 0; i < text.length; i += 1) {
      const m = /^\.([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(i))
      if (m && SELECTORS.has(m[1])) {
        let depth = 0
        let j = i + m[0].length - 1
        for (; j < text.length; j += 1) {
          if (text[j] === '(') depth += 1
          else if (text[j] === ')') { depth -= 1; if (depth === 0) break }
        }
        removed.push(text.slice(i, j + 1))
        i = j
        continue
      }
      out += text[i]
    }
    const path = out.replace(/\s+/g, '')
    return /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]]*\])*$/.test(path)
      ? { path, removed }
      : null
  }

  const tainted = new Set()
  for (let pass = 0; pass <= declared.length; pass += 1) {
    let grew = false
    for (const d of declared) {
      if (tainted.has(d.name)) continue
      const selection = reduceToSelection(d.text.replace(/^[^=]*=/, ''))
      if (!selection) continue
      const root = selection.path.split(/[.[?]/)[0]
      const fromRoot = tainted.has(root) || names.includes(root)
      const fromCallback = selection.removed.some((group) => mentions(group))
      if (fromRoot || fromCallback) { tainted.add(d.name); grew = true }
    }
    if (!grew) break
  }

  const isTainted = (name) => tainted.has(name) || names.includes(name)

  /**
   * The text of a call starting at `(` on `line`, by paren matching across
   * lines. The reduce body is where the field name usually appears, and a
   * single-line regex cannot see it when the call is wrapped — which is how
   * every reduce in this tree is written.
   */
  const callText = (line, openIndex) => {
    let depth = 0
    let text = ''
    for (let l = line; l < lines.length; l += 1) {
      const start = l === line ? openIndex : 0
      for (let c = start; c < lines[l].length; c += 1) {
        const ch = lines[l][c]
        text += ch
        if (ch === '(') depth += 1
        else if (ch === ')') { depth -= 1; if (depth === 0) return text }
      }
      text += '\n'
    }
    return text
  }

  for (let i = 0; i < lines.length; i += 1) {
    const code = stripComment(lines[i])
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\.reduce\(/g)) {
      const openIndex = m.index + m[0].length - 1
      const body = callText(i, openIndex)
      // The receiver is tainted, or the reduce body names the field itself —
      // the shape `rows.reduce((sum, r) => sum + r.precipitation_mm, 0)`.
      if (!isTainted(m[1]) && !mentions(body)) continue
      // No file-level exemption for importing the helper. The first version had
      // one, and re-canarying the gate against the *fixed* file showed why it is
      // wrong: `src/analytics.js` now imports `meanMeasured`, so the exemption
      // made the whole file immune — including the very line the canary had just
      // reintroduced. A gate that a file satisfies by importing the fix once, at
      // one site, is the 19-of-27-paths failure this repository keeps finding.
      // The taint tracking needs no exemption: after the fix `usablePrecip` is
      // consumed by `meanMeasured(…)` and never reduced, so nothing matches. A
      // reduce that is genuinely period-aware for a reason the tracker cannot
      // see carries the marker below.
      if (ALLOW.test(allowedContext(lines, i))) continue
      findings.push({
        file,
        line: i + 1,
        kind: 'period-blind-aggregate',
        text: `${m[1]}.reduce(…)`,
        message: `${m[1]} was built from ${names.join('/')}, which the registry declares at more than one period, and it is reduced without regard to the period; use meanMeasured from public/shared/units.js, or mark the aggregate with \`unit-ok: <reason>\``,
      })
    }
  }
  return findings
}

/** Scan the tree, both checks. */
export function scanTree(root = ROOT) {
  const findings = []
  const mixed = mixedFields()
  for (const dir of SCAN_DIRS) {
    const full = path.join(root, dir)
    if (!fs.existsSync(full)) continue
    for (const file of filesUnder(full)) {
      const rel = path.relative(root, file)
      const source = fs.readFileSync(file, 'utf8')
      if (rel.startsWith(CONNECTOR_DIR)) findings.push(...scanWriter(source, { file: rel }))
      findings.push(...scanReader(source, { file: rel, mixed }))
    }
  }
  return findings
}

/**
 * Canaries. Each is a case this gate must get right.
 *
 * The first pair is the defect and its fix side by side — the same discipline
 * the aggregation-kind gate uses, and for the same reason: a gate whose only
 * canaries are positive has never been watched staying silent.
 */
export const CANARIES = [
  {
    name: 'A: flags a connector that writes rainfall without declaring a period',
    kind: 'writer',
    source: [
      "const SOURCE = 'new_provider'",
      'const observations = [{',
      "  source: SOURCE, type: 'rainfall_now',",
      '  precipitation_mm: readMeasurement(row.precip),',
      '}]',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'A: passes the same connector once its period is declared',
    kind: 'writer',
    source: [
      "const SOURCE = 'open_meteo'",
      'const observations = [{',
      "  source: SOURCE, type: 'precipitation_forecast',",
      '  precipitation_mm: readMeasurement(row.precip),',
      '}]',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'A: passes a connector whose accumulating field is always null',
    kind: 'writer',
    source: [
      "const SOURCE = 'chirps'",
      'const observations = [{',
      "  source: SOURCE, type: 'rainfall_dataset_available',",
      '  precipitation_mm: null,',
      '}]',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'A: does not flag a connector that writes no accumulating field at all',
    kind: 'writer',
    source: [
      "const SOURCE = 'usgs'",
      'const events = [{ source: SOURCE, type: \'earthquake\', depth_km: row.d }]',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'B: flags a module that averages a mixed-period field with a bare reduce',
    kind: 'reader',
    source: [
      'const values = rows.map((r) => r.precipitation_mm)',
      'const mean = values.reduce((sum, v) => sum + v, 0) / values.length',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'B: passes the same module once it imports the registry helper',
    kind: 'reader',
    source: [
      "import { meanMeasured } from '../public/shared/units.js'",
      'const { mean } = meanMeasured(rows, \'precipitation_mm\')',
      'const total = rows.reduce((sum, r) => sum + 1, 0)',
    ].join('\n'),
    expect: 0,
  },
  {
    // The regression that escaped the first version of this gate: a file that
    // imports the helper at one site does not thereby become period-aware at
    // every other site. The first version exempted any file importing
    // `units.js`, so reverting the fix in `src/analytics.js` — which now imports
    // `meanMeasured` — left the gate reporting "clean" on the exact defect it
    // was written for. The exemption is gone; this canary keeps it gone.
    name: 'B: still flags a bare reduce in a file that also imports the helper',
    kind: 'reader',
    source: [
      "import { meanMeasured } from '../public/shared/units.js'",
      'const values = rows.map((r) => r.precipitation_mm)',
      'const mean = values.reduce((sum, v) => sum + v, 0) / values.length',
      "const other = meanMeasured(rows, 'precipitation_mm')",
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'B: passes an aggregate the marker explains',
    kind: 'reader',
    source: [
      '// unit-ok: this sums along the time axis within one station series, where',
      '// a total is a real quantity and every day is the same whole-day period.',
      'const total = series.reduce((sum, d) => sum + d.precipitation_mm, 0)',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'B: does not honour a bare marker with no reason',
    kind: 'reader',
    source: [
      'const total = series.reduce((sum, d) => sum + d.precipitation_mm, 0) // unit-ok:',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'B: does not flag a module that only carries the field through',
    kind: 'reader',
    source: 'const mm = row.precipitation_mm\nconst label = mm === null ? null : String(mm)',
    expect: 0,
  },
  {
    name: 'B: does not flag a module that aggregates a field with only one declared period',
    kind: 'reader',
    source: 'const total = rows.reduce((sum, r) => sum + r.temperature_max_c, 0)',
    expect: 0,
  },
  {
    name: 'B: does not flag the defect class named in a comment',
    kind: 'reader',
    source: '// this used to be rows.reduce((sum, r) => sum + r.precipitation_mm, 0)\nconst mean = 1',
    expect: 0,
  },
]

function selfTest() {
  let failed = 0
  const mixed = mixedFields()
  for (const canary of CANARIES) {
    const got = (canary.kind === 'writer'
      ? scanWriter(canary.source, { mixed })
      : scanReader(canary.source, { mixed })).length
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  // The registry's own default, verified against the real table rather than
  // assumed: if `mixedFields` returned nothing, every B canary would pass by
  // returning zero and the gate would be blind while looking green.
  const expectMixed = mixed.has('precipitation_mm')
  console.log(`${expectMixed ? 'ok  ' : 'FAIL'} the registry declares precipitation_mm at more than one period — ${[...mixed].join(', ') || 'none'}`)
  if (!expectMixed) failed += 1

  const real = scanTree(ROOT)
  console.log(`${real.length === 0 ? 'ok  ' : 'FAIL'} the tree is clean — ${real.length} finding(s)`)
  if (real.length) failed += 1
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest())
  const findings = scanTree(ROOT)
  if (findings.length === 0) {
    console.log('unit-mixing check: clean')
    process.exit(0)
  }
  console.error(`unit-mixing check: ${findings.length} site(s) mix measurements the registry says do not match\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.kind}] ${f.text}`)
    console.error(`    ${f.message}`)
  }
  process.exit(1)
}

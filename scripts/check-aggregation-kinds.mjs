#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aggregationKindFor, preferredAggregate } from '../public/shared/aggregation-kinds.js'

/**
 * ENH-45 — the aggregation-kind gate.
 *
 * VER-01 summed precipitation across stations and produced a map of sensor
 * density. The fix was a mean, but the *class* is a field whose kind and whose
 * aggregate disagree, and the class has a second live instance: the
 * climate-conflict scorer summed `precipitation_mm` over the same `nearby()`
 * collection. Two instances in one module, found months apart, is the argument
 * for a check rather than a third fix.
 *
 * **What it reads.** `public/shared/aggregation-kinds.js` decides the kind from
 * the unit suffix, and this gate applies that decision to `reduce(sum)` call
 * sites in `src/`. The two halves are deliberately separate: the registry is
 * the declaration a reviewer reads, the gate is the enforcement, and a gate
 * that carried its own private copy of the rules would be the second source of
 * truth this repository keeps finding.
 *
 * **What it flags.** A `reduce` whose accumulator adds a field the registry
 * calls intensive. The pattern is the shape the defect actually takes here —
 * `.reduce((sum, item) => sum + <expr>, 0)` — and the field is the one named in
 * `<expr>`. An expression naming no field (`sum + 4 + 0.8 * x`) is left alone:
 * it is not a measurement being aggregated, it is a score being built.
 *
 * **The allow-marker.** `aggregation-ok:` with a reason, same discipline as the
 * absent-value gate's `absent-ok:`. It exists for the case that is genuinely a
 * sum: rows that partition the population, where each value is already its
 * stratum's aggregate. Requiring the reason converts a judgement call into a
 * line a reviewer reads.
 *
 * Exit 0 when clean, 1 with the sites listed. Canaried in `--self-test`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where source lives. Both halves of the tree: the browser scorer sums too. */
const SCAN_DIRS = ['src', 'public']

/** Vendored or generated trees are not this repository's to fix. */
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', '.git'])

/**
 * A `reduce` that adds a named field.
 *
 * Captures the field name out of the added expression. The shape is narrow on
 * purpose: `sum + Number(item.precipitation_mm || 0)` and `sum + item.score`
 * both match, `sum + 4` does not, and a `reduce` that builds an object or
 * concatenates is not this gate's business.
 */
const SUM_REDUCE = /\.reduce\(\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*\1\s*\+\s*([^,)]+)/g

/** The last field name in the added expression — the measurement being added. */
const FIELD_IN_EXPR = /\b([a-z][a-z0-9_]*)\b/g

/** `aggregation-ok: <reason>` on the line or in the comment block above it. */
const ALLOW = /aggregation-ok:\s*\S/

function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, out)
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * The paragraph a finding sits in — the run of lines back to the previous blank
 * line, which is the unit a reviewer reads.
 *
 * A comment block that stops at the first code line is too narrow here, and
 * the reason is a real site: `src/routing.js` marks two sums with one reason
 * because the reason is the same for both, and a rule that only reached the
 * line directly beneath the marker would force the prose to be duplicated or
 * the second sum to be exempted with no reason at all. Blank lines bound it, so
 * a marker cannot reach up the file and excuse a site it was never about.
 */
function allowedContext(lines, index) {
  let start = index
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1
  return lines.slice(start, index + 1).join('\n')
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

/**
 * Scan one source string.
 *
 * Exported so the canaries drive it with text rather than with files — a canary
 * that writes files to test a scanner can corrupt the tree it is testing.
 */
export function scanSource(source, { file = '<memory>' } = {}) {
  const findings = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const code = stripComment(lines[i])
    SUM_REDUCE.lastIndex = 0
    let match
    while ((match = SUM_REDUCE.exec(code)) !== null) {
      const expr = match[3]
      // The last identifier in the added expression is the field: in
      // `Number(item.precipitation_mm || 0)` that is `precipitation_mm`, and in
      // `item.score` it is `score`.
      const names = [...expr.matchAll(FIELD_IN_EXPR)].map((m) => m[1])
      const field = names[names.length - 1]
      if (!field) continue
      if (aggregationKindFor(field) !== 'intensive') continue
      if (ALLOW.test(allowedContext(lines, i))) continue
      findings.push({ file, line: i + 1, field, text: lines[i].trim() })
    }
  }
  return findings
}

/** Scan the tree. */
export function scanTree(root = ROOT) {
  const findings = []
  for (const dir of SCAN_DIRS) {
    const full = path.join(root, dir)
    if (!fs.existsSync(full)) continue
    for (const file of filesUnder(full)) {
      const rel = path.relative(root, file)
      findings.push(...scanSource(fs.readFileSync(file, 'utf8'), { file: rel }))
    }
  }
  return findings
}

/**
 * Canaries. Each is a case this gate must get right, run in `--self-test` and
 * in the test file.
 *
 * The first two are the real defect and its fixed form, side by side: the gate
 * has to fire on the line VER-01 removed and stay silent on the line that
 * replaced it. The rest pin the edges — a score builder is not a measurement
 * sum, an extensive field is allowed to add, and the allow-marker needs a
 * reason.
 */
export const CANARIES = [
  {
    name: 'flags the VER-01 sum: point rainfall added across stations',
    source: 'const climatePressure = Math.min(35, climate.reduce((sum, item) => sum + Number(item.precipitation_mm || 0), 0))',
    expect: 1,
  },
  {
    name: 'passes the fix that replaced it: a mean, not a reduce-sum',
    source: 'const precipitation = usablePrecip.length ? usablePrecip.reduce((sum, v) => sum + v, 0) / usablePrecip.length : null',
    expect: 0,
  },
  {
    name: 'flags a rate summed across regions',
    source: 'const total = rows.reduce((sum, row) => sum + row.dispatch_precision_pct, 0)',
    expect: 1,
  },
  {
    name: 'passes an extensive count summed',
    source: 'const events = rows.reduce((sum, row) => sum + row.hazard_events, 0)',
    expect: 0,
  },
  {
    name: 'passes a severity-weighted score built from literals',
    source: 'const pressure = hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 30, 0)',
    expect: 0,
  },
  {
    name: 'passes a duration summed when the marker gives a reason',
    source: [
      '// aggregation-ok: the strata partition the population, so each row is',
      '// already its own stratum total and the sum is the population total.',
      'const total = rows.reduce((sum, row) => sum + row.duration_hours, 0)',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'does not honour a bare marker with no reason',
    source: 'const total = rows.reduce((sum, row) => sum + row.duration_hours, 0) // aggregation-ok:',
    expect: 1,
  },
  {
    name: 'does not flag the defect class named in a comment',
    source: '// this used to be rows.reduce((sum, row) => sum + row.distance_km, 0)\nconst mean = 1',
    expect: 0,
  },
  {
    name: 'does not flag an intensive field that is only read, never summed',
    source: 'const value = item.precipitation_mm\nconst pct = row.battery_pct',
    expect: 0,
  },
  {
    name: 'lets one marker in a paragraph cover both sites it explains',
    source: [
      '// aggregation-ok: the legs partition the journey, so each total is its own.',
      'const minutes = legs.reduce((sum, l) => sum + l.total_minutes, 0)',
      'const km = legs.reduce((sum, l) => sum + l.total_distance_km, 0)',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'does not let a marker reach past a blank line to an unrelated site',
    source: [
      '// aggregation-ok: the legs partition the journey, so each total is its own.',
      'const minutes = legs.reduce((sum, l) => sum + l.total_minutes, 0)',
      '',
      'const km = legs.reduce((sum, l) => sum + l.total_distance_km, 0)',
    ].join('\n'),
    expect: 1,
  },
]

function selfTest() {
  let failed = 0
  for (const canary of CANARIES) {
    const got = scanSource(canary.source).length
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  // The tree is the strongest known-good input available, so the default is
  // verified against it too. A scanner that returned nothing for every input
  // would pass every canary above only if the expectations were uniform, and
  // the first two canaries are opposite by construction.
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
    console.log('aggregation-kind check: clean')
    process.exit(0)
  }
  console.error(`aggregation-kind check: ${findings.length} site(s) sum an intensive measurement\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.field}]`)
    console.error(`    ${f.text}`)
    console.error(`    use ${preferredAggregate(f.field)}`)
  }
  process.exit(1)
}

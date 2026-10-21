#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ENH-46 — the absent-value linter.
 *
 * `?? 0`, `|| 0` and `Number(null)` on a *nullable measurement* are this
 * repository's named defect class. It has shipped here at least four times
 * (VER-02, VER-09, VER-12, and the `maxProbability ?? 0` in the flood score),
 * each time in a different module, each time found by an audit rather than by
 * the build. The class is not "a zero literal is suspicious" — most `?? 0` in
 * this tree is correct, because a counter that starts at zero is a counter that
 * starts at zero. The class is: **a field the codebase publishes as null when
 * unmeasured, coerced to 0 at a point where the result is read as a figure.**
 *
 * So this gate is scoped to that, and the scope is the whole argument for it
 * existing. A linter that flags every `?? 0` would be turned off within a week,
 * and correctly: it would fire on `data.field_reports?.length ?? 0`, which is a
 * count of an array that is present-or-empty and has no third state.
 *
 * **How the scope is decided.** Not by a hand-written field list — a list is a
 * thing that goes stale silently, and the field that gets added next is exactly
 * the one nobody remembers to add. It is decided by the tree: a field is a
 * nullable measurement when the same module publishes a `<subject>_refusal`
 * beside it. That is this codebase's own convention for "the number is absent,
 * and here is why" (see `src/kpi.js:298-303`, `src/equity.js:104-109`,
 * `src/calibration.js:363-368`), and a module that has adopted it has stated, in
 * code, that the number can be missing. The gate reads that declaration rather
 * than restating it.
 *
 * **What it refuses.** A numeric fallback applied to such a field. The refusal
 * is per *site*, not per field, because the fallback is only wrong where the
 * result is published as a measurement — `sum += row.false_alert_rate ?? 0`
 * inside an accumulator that is then divided by a measured count is not the
 * same act as `false_alert_rate: row.false_alert_rate ?? 0` in a payload.
 * Distinguishing those two by AST is not possible without a type system, and
 * distinguishing them by regex is not possible at all, so the gate takes the
 * conservative reading: any numeric fallback on a declared-nullable field is a
 * finding, and a site that is genuinely an accumulator says so with an
 * allow-marker naming why. The marker is the point — it converts a silent
 * judgement call into a line a reviewer reads.
 *
 * Exit 0 when clean, 1 with the sites listed. Canaried in `--self-test`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where source lives. Browser modules are included: `public/app.js` has carried this class before. */
const SCAN_DIRS = ['src', 'public']
const SCAN_EXT = /\.(js|mjs)$/

/**
 * Directories under `public/` that are vendored or generated, so a finding in
 * one is not this repository's to fix. Listed rather than pattern-matched, so
 * adding a directory cannot quietly join the exemption.
 */
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', '.git'])

/**
 * A fallback applied to a field this module declares nullable.
 *
 * Three shapes, because all three shipped here:
 *   `x ?? 0`        the nullish default
 *   `x || 0`        the truthiness default — worse, because it also folds a
 *                   genuine 0 into the fallback
 *   `Number(x ?? 0)` / `Number(x || 0)`  the same act with a cast around it
 *
 * `parseFloat`, `parseInt` and `toFixed` are deliberately not included: they
 * change the value's type or rendering rather than asserting that an absence
 * was a zero, which is the specific claim this gate is about.
 */
const FALLBACK = /(\?\?|\|\|)\s*(-?0(?:\.0+)?|NaN)\b/

/**
 * The *test* shape, which is the same defect and was not covered.
 *
 * All three instances this repository paid for were written this way —
 * `record.latitude && record.longitude`, `p.lat && p.lon`,
 * `sevFilter && r.severity && r.severity !== sevFilter` — and a gate that only
 * reads fallbacks would have reported the tree clean through all three. A
 * truthiness test on a numeric field treats 0 as absent, so a coordinate on the
 * equator, a severity of 0 or a count of 0 is read as "not there".
 *
 * Matched as a leading operand rather than as a bare `&&` anywhere, because
 * `a && b` is legitimate on booleans and the defect needs a *field* being
 * tested for presence. The field has to name a subject a refusal declared, the
 * same jurisdiction the fallback rule uses.
 */
const PRESENCE_TEST = /(?:^|[^\w.$])([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*&&/

/** `foo_refusal: …` — the declaration that marks `foo` (and its siblings) nullable. */
const REFUSAL_DECL = /\b([a-z][a-z0-9_]*)_refusal\b\s*[:(]/g

/**
 * Fields a refusal declares nullable, by subject stem.
 *
 * `false_alert_refusal` declares `false_alert_rate` and `false_alert_count`
 * nullable: the refusal is about the subject, and the module publishes whichever
 * measurements of that subject it has. Matching on the stem rather than the
 * exact field name is what keeps this working when a module adds a second
 * measurement of the same subject — which `src/equity.js` does.
 */
function nullableStems(source) {
  const stems = new Set()
  for (const match of source.matchAll(REFUSAL_DECL)) stems.add(match[1])
  // A stem must be long enough to name a subject rather than a common word.
  //
  // The threshold is low on purpose. `trust` is five characters and is a real
  // stem here (`trust_refusal` guards `trust_score`), so a filter tuned to the
  // longest stems would silently stop checking the field this repository most
  // often gets wrong — a gate that quietly narrows is worse than one that never
  // fired, because the count of findings it reports still looks like coverage.
  // What actually keeps a short stem from matching half the file is the word
  // boundary in `nullableFieldOn` plus the requirement that a numeric fallback
  // be on the same line; the length floor is only a backstop against a stem
  // like `id`, which names nothing.
  return new Set([...stems].filter((s) => s.length >= 4))
}

/** Does this line mention a field whose stem a refusal declared nullable? */
function nullableFieldOn(line, stems) {
  for (const stem of stems) {
    // The stem, optionally continued by a suffix (`false_alert` → `false_alert_rate`).
    // Bounded so `trust` does not match `trusted_by`.
    const pattern = new RegExp(`\\b${stem}(_[a-z0-9]+)*\\b`)
    if (pattern.test(line)) return stem
  }
  return null
}

/**
 * A site that has declared itself intentional.
 *
 * The marker is `absent-ok:` followed by a reason, on the same line or the line
 * above. Requiring the reason is the whole value: an exemption with no reason is
 * a decision nobody can review, and the next reader cannot tell it from a
 * mistake someone silenced.
 */
const ALLOW = /absent-ok:\s*\S/

/** Recursively list scannable files under a directory. */
function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, out)
    else if (SCAN_EXT.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Scan one source string. Exported so the canaries can drive it with text
 * rather than with files — a canary that writes files to test a scanner is a
 * canary that can corrupt the tree it is testing.
 */
export function scanSource(source, { file = '<memory>' } = {}) {
  const stems = nullableStems(source)
  if (stems.size === 0) return []
  const lines = source.split('\n')
  const findings = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // A comment is not a coercion. The codebase discusses this defect class in
    // prose at several sites — `src/analytics.js:483` names `maxProbability ?? 0`
    // in a comment explaining why it was removed — and flagging the explanation
    // is the failure mode that gets a gate deleted.
    const code = stripComment(line)
    const isFallback = FALLBACK.test(code)
    // The presence test is checked on the operand that `&&` guards, and only
    // when that operand names a declared-nullable subject. `Boolean(x) && …`
    // and `x !== null && …` are the correct spellings and do not match.
    const presence = PRESENCE_TEST.exec(code)
    // `!row.x_refusal && …` tests the *declaration*, not the measurement — it is
    // how a caller asks whether a refusal exists, which is the opposite of the
    // defect. The refusal field names the stem by construction, so without this
    // exclusion every correct use of the pattern would fire.
    const isPresenceTest = Boolean(
      presence && !/_refusal\b/.test(presence[1]) && nullableFieldOn(presence[1], stems),
    )
    if (!isFallback && !isPresenceTest) continue
    const stem = nullableFieldOn(code, stems)
    if (!stem) continue
    if (ALLOW.test(allowedContext(lines, i))) continue
    findings.push({ file, line: i + 1, stem, shape: isFallback ? 'fallback' : 'presence-test', text: line.trim() })
  }
  return findings
}

/**
 * The lines an allow-marker may sit on: this line, and the contiguous comment
 * block immediately above it.
 *
 * One line up is not enough. A reason worth writing is usually two lines, and a
 * marker whose reason wraps is a marker a one-line reader misses — which is how
 * an allow-marker becomes a bare marker in practice, and a bare marker is the
 * thing this gate refuses. The block stops at the first non-comment line so a
 * marker cannot reach up the file and excuse a site it was never about.
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

/**
 * Remove a trailing line comment, without being fooled by `//` inside a string.
 *
 * A crude stripper is worse than none here: `'https://…'` contains `//`, and
 * truncating there would hide a real finding after it. So the scan tracks
 * quote state rather than looking for the first `//`.
 */
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
 * Canaries. Each one is a case this gate must get right, and each is run in
 * `--self-test` and in the test file.
 *
 * The two that matter most are the last pair. A gate that fires on everything
 * is deleted within a week; a gate that fires on nothing passes forever. Both
 * are checked here against known-good and known-bad text, because "exit 0" from
 * a scanner nobody has watched fail is not evidence.
 */
export const CANARIES = [
  {
    name: 'flags a nullish default on a declared-nullable field',
    source: [
      'const x = 1',
      'false_alert_refusal: far.refusal,',
      'false_alert_rate: row.false_alert_rate ?? 0,',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'flags a truthiness default, which also eats a genuine zero',
    source: [
      'false_alert_refusal: far.refusal,',
      'const rate = row.false_alert_rate || 0',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'flags a cast around the default',
    source: [
      'trust_refusal: trust.refusal,',
      'const s = Number(row.trust_score ?? 0)',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'passes the same field with no fallback — null is the honest answer',
    source: [
      'false_alert_refusal: far.refusal,',
      'false_alert_rate: row.false_alert_rate ?? null,',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'passes a fallback in a module that declares no nullable field',
    source: [
      'const counts = data.field_reports?.length ?? 0',
      'const other = data.alert_events?.length ?? 0',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'passes a fallback on a field the refusal did not declare',
    source: [
      'false_alert_refusal: far.refusal,',
      'const n = row.false_alert_reviewer_count ?? 0', // same stem, so this DOES fire
    ].join('\n'),
    // Recorded as firing, deliberately. The stem rule is broad on purpose: a
    // module that declares a subject nullable has said its measurements of that
    // subject can be missing, and a second measurement of the same subject is
    // not a different claim. An allow-marker is the escape hatch, and this
    // canary pins the breadth so narrowing it is a visible decision.
    expect: 1,
  },
  {
    name: 'does not flag the defect class named in a comment',
    source: [
      'false_alert_refusal: far.refusal,',
      '// this used to be `row.false_alert_rate ?? 0`, which read an outage as a clean record',
      'false_alert_rate: row.false_alert_rate ?? null,',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'is not fooled by // inside a string, and still sees the finding after it',
    source: [
      'false_alert_refusal: far.refusal,',
      "const url = 'https://example.test/x'",
      'const rate = row.false_alert_rate ?? 0',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'honours an allow-marker that gives a reason',
    source: [
      'false_alert_refusal: far.refusal,',
      '// absent-ok: accumulator; the divisor is the count of measured rows, so a',
      '// missing term contributes nothing and the absence is reported beside it',
      'total += row.false_alert_rate ?? 0',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'does not honour a bare allow-marker with no reason',
    source: [
      'false_alert_refusal: far.refusal,',
      'total += row.false_alert_rate ?? 0 // absent-ok:',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'ignores a refusal whose stem is too short to be specific',
    source: [
      'id_refusal: r.refusal,',
      'const n = row.id ?? 0',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'flags a presence test on a declared-nullable field, which reads 0 as absent',
    source: [
      'latitude_refusal: geo.refusal,',
      'if (record.latitude_value && record.longitude_value) coarsen(record)',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'passes the explicit null check that is the correct spelling',
    source: [
      'latitude_refusal: geo.refusal,',
      'if (record.latitude_value !== null && record.longitude_value !== null) coarsen(record)',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'passes a presence test on the refusal field itself, which is the correct question',
    source: [
      'warning_to_action_field_refusal: kpi.refusal,',
      'gap: !kpi.warning_to_action_field_refusal && kpi.warning_to_action_field_median_hours === null,',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'does not flag a presence test on a field no refusal declared',
    source: [
      'latitude_refusal: geo.refusal,',
      'if (user.is_admin && record.latitude_value !== null) show(user)',
    ].join('\n'),
    expect: 0,
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
  // The default is verified against the real tree too. A scanner that returns
  // the same answer for every input would pass every canary above only if the
  // expectations were uniform, and they are not — but the tree itself is the
  // strongest known-good input available, so it is checked as well.
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
    console.log('absent-value check: clean')
    process.exit(0)
  }
  console.error(`absent-value check: ${findings.length} site(s) coerce a declared-nullable field to a number\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.stem}]`)
    console.error(`    ${f.text}`)
  }
  console.error('\nA field this module publishes a `<subject>_refusal` beside is a field it has declared')
  console.error('can be absent. `?? 0` asserts the measurement was made and came out nil. Publish null,')
  console.error('or mark the site `absent-ok: <reason>` when it is an accumulator rather than a figure.')
  process.exit(1)
}

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The README's stated build inventory — the gate count and the test count — is
 * checked against the tree, not maintained by hand.
 *
 * The README said "seven repository gates (budget, OpenAPI, accessibility,
 * offline, i18n coverage, schema, license)" while `run-gates.mjs` held
 * twenty-five in two tiers. Six of the seven named gates do not exist under
 * those names, and the one count in the sentence — seven — was right only by
 * coincidence: it happened to match the browser tier. The same sentence said
 * "over two thousand automated tests" when the suite ran over four thousand.
 * A reader sizing up the build got numbers that described nothing.
 *
 * The class is the one this repository keeps re-finding: **a hand-typed count
 * beside a machine-maintained set drifts silently, and the drift is invisible
 * because the sentence still reads well.** So both counts are measured here and
 * asserted against the README, and the next gate or test file either updates
 * the README or fails this test.
 *
 * Why `--list` rather than importing `GATES`: the runner is a script with a
 * main body that executes on import — it prints a classification table and, on
 * a misclassified gate, calls `process.exit(1)`. Reading its stdout is the
 * interface it already offers and the one CI uses, so the test measures the
 * same thing the pipeline does.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The tier counts the runner reports, parsed from `--list`. */
function tierCounts() {
  const out = execFileSync(process.execPath, ['scripts/run-gates.mjs', '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const counts = {}
  for (const m of out.matchAll(/^(self-contained|needs-server|needs-browser) \((\d+)\)/gm)) {
    counts[m[1]] = Number(m[2])
  }
  return counts
}

/** The README sentence, isolated so a match cannot land in unrelated prose. */
function claimSentence() {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const line = readme.split('\n').find((l) => /repository gates in two tiers/.test(l))
  assert.ok(line, 'the README no longer states a gate inventory — update this test with the sentence')
  return line
}

/**
 * Statically declared tests across `test/*.test.js`.
 *
 * A line beginning with `it(` or `test(` is a declaration. `describe(` is not
 * counted: it groups, it does not assert. The count is a **lower bound** on
 * what `node --test` reports, because a declaration inside a loop runs more
 * than once — which is the property the README's "over N thousand" claim needs,
 * and the only one that can be measured without running the suite (a test that
 * ran the suite to count itself would not terminate).
 */
function declaredTests() {
  const dir = path.join(ROOT, 'test')
  let n = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.js')) continue
    const source = readFileSync(path.join(dir, name), 'utf8')
    for (const line of source.split('\n')) {
      if (/^\s*it\(/.test(line) || /^\s*test\(/.test(line)) n += 1
    }
  }
  return n
}

/** English for a thousands figure, the way the README spells it. */
const THOUSANDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

describe('the README gate inventory', () => {
  it('states the counts the runner actually reports', () => {
    const counts = tierCounts()
    // Canary for the parser: if the runner stops printing the table, `counts`
    // is empty and every `Number()` below is NaN — which would make the
    // assertions vacuous rather than failing. Assert the shape first.
    assert.equal(typeof counts['self-contained'], 'number',
      'no self-contained tier line in `run-gates.mjs --list` output — the parser or the runner changed')
    assert.equal(typeof counts['needs-browser'], 'number',
      'no needs-browser tier line in `run-gates.mjs --list` output')

    const total = counts['self-contained'] + counts['needs-browser'] + (counts['needs-server'] || 0)
    const sentence = claimSentence()
    const words = { 18: 'eighteen', 7: 'seven', 25: 'twenty-five' }
    const spelled = (n) => words[n] || String(n)

    assert.match(sentence, new RegExp(`\\b${spelled(total)}\\b`),
      `README says the gate total is something other than ${total} (${spelled(total)}); the runner holds ${JSON.stringify(counts)}`)
    assert.match(sentence, new RegExp(`\\b${spelled(counts['self-contained'])}\\b[^.]*self-contained`),
      `README's self-contained count is not ${counts['self-contained']}`)
    assert.match(sentence, new RegExp(`\\b${spelled(counts['needs-browser'])}\\b[^.]*browser`),
      `README's browser count is not ${counts['needs-browser']}`)
  })

  it('states a test count the declarations support', () => {
    // "Over N thousand" is true exactly when N*1000 <= declared < (N+1)*1000.
    // Both directions matter: too low understates the suite, and too high is a
    // claim the tree cannot support.
    const declared = declaredTests()
    assert.ok(declared > 3000,
      `only ${declared} test declarations found — the counter or the glob is wrong, not the suite`)

    const sentence = claimSentence()
    const m = /\bover\s+([a-z]+)\s+thousand automated tests\b/i.exec(sentence)
    assert.ok(m, 'the README no longer states a test count in the form "over <word> thousand automated tests"')
    const words = THOUSANDS.indexOf(m[1].toLowerCase())
    assert.notEqual(words, -1, `"${m[1]}" is not a thousands word this test knows`)
    const claimed = words * 1000
    assert.ok(declared >= claimed && declared < claimed + 1000,
      `README says "over ${m[1]} thousand" tests but the tree declares ${declared} — ` +
      `the true figure is "${THOUSANDS[Math.floor(declared / 1000)]} thousand"`)
  })

  it('names no gate that does not exist', () => {
    // The old sentence named "schema" and "license", which are not gates. A
    // named gate is a claim a reader can check by looking in scripts/, so the
    // names in the sentence must be real files or real gate names.
    const out = execFileSync(process.execPath, ['scripts/run-gates.mjs', '--list'], {
      cwd: ROOT, encoding: 'utf8',
    })
    const real = new Set([...out.matchAll(/^\s+\S?\s*(\S+)\s+(scripts\/\S+\.mjs)/gm)].map((m) => m[2]))
    assert.ok(real.size >= 20, `parsed only ${real.size} gate scripts from the runner — parser is wrong`)
    // Every `scripts/check-*.mjs` named in the README must be in the runner's list.
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    const named = [...readme.matchAll(/`(scripts\/[\w-]+\.mjs)`/g)].map((m) => m[1])
    for (const file of named) {
      assert.ok(real.has(file), `README names ${file}, which is not a gate in run-gates.mjs`)
    }
  })
})

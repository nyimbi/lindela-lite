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

/**
 * A gate count, spelled the way the README spells it.
 *
 * This was a hand-kept map — `{ 18: 'eighteen', 7: 'seven', 25: 'twenty-five' }` —
 * and adding a gate therefore broke the test with the message "README says the
 * gate total is something other than 27 (27)": `spelled(27)` fell through to
 * `String(27)`, the regex looked for `27`, and the README's "twenty-seven" did
 * not match. A number the map had not been told about produced a failure that
 * named the number twice and explained nothing.
 *
 * That is the "one of two spellings" class this repository has written down
 * repeatedly: a lookup enumerates the values its author thought of, and the
 * unlisted one fails in a way that misdescribes itself. A rule that covers the
 * range has no such gap. Counts above ninety-nine are not spelled out in the
 * README, so the hyphenated tens are the whole of it.
 */
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function spelled(n) {
  if (n < 20) return ONES[n]
  const tens = TENS[Math.floor(n / 10)]
  const ones = n % 10
  return ones === 0 ? tens : `${tens}-${ONES[ones]}`
}

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

  it('states a canary count the gate actually carries', async () => {
    // The same defect as the README counts above, one level in. Each `why` in
    // `run-gates.mjs` says how many canaries its gate carries, and that number
    // is hand-typed beside a machine-maintained `CANARIES` array — so it drifts
    // the moment a case is added or removed, and it drifts *downward* into
    // understating the instrument, which is the direction nobody re-reads.
    // `check-client-endpoints` said eleven against ten; the six beside it were
    // right, which is exactly how a hand-typed count survives.
    //
    // Measured, not grepped: the array is imported and its length read. The
    // number in the prose is spelled in words, so this maps the words it knows
    // and refuses an unrecognised one rather than passing it silently.
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
      'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
      'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
    const source = readFileSync(path.join(ROOT, 'scripts/run-gates.mjs'), 'utf8')
    // Each gate block is a `script:` line followed by its `why:` prose; pair
    // them so the count is read against the gate it describes.
    const claims = [...source.matchAll(/script:\s*'(scripts\/[\w-]+\.mjs)'[\s\S]{0,600}?why:\s*'((?:[^'\\]|\\.)*)'/g)]
    let checked = 0
    for (const [, file, why] of claims) {
      const m = /\b(?:[Cc]arries)\s+([a-z-]+)\s+canar(?:y|ies)\b/.exec(why)
      if (!m) continue
      const n = WORDS.indexOf(m[1].toLowerCase())
      assert.notEqual(n, -1, `${file} claims "${m[1]}" canaries, which is not a count this test knows`)
      const mod = await import(`../${file}`)
      assert.ok(Array.isArray(mod.CANARIES),
        `${file} claims ${m[1]} canaries but exports no CANARIES array to measure against`)
      assert.equal(n, mod.CANARIES.length,
        `${file} claims ${m[1]} canaries and carries ${mod.CANARIES.length}`)
      checked += 1
    }
    assert.ok(checked >= 5,
      `only ${checked} canary counts found in run-gates.mjs — the parser is wrong, not the gates`)
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

  it('spells any gate count the runner could report, not a listed few', () => {
    // The helper is the assertion's only view of the README, so its gaps are
    // silent: `spelled` falling through to `String(n)` made the failure message
    // name the same number twice. Pinned here directly, because the end-to-end
    // path only ever exercises the counts the tree happens to hold today, and
    // the branch that matters is the one the next gate will land on.
    assert.equal(spelled(20), 'twenty')
    assert.equal(spelled(27), 'twenty-seven')   // the tens-plus-ones branch
    assert.equal(spelled(30), 'thirty')         // the exact-ten branch
    assert.equal(spelled(7), 'seven')
    assert.equal(spelled(18), 'eighteen')       // the below-twenty branch
    assert.equal(spelled(19), 'nineteen')       // its last value
    assert.equal(spelled(21), 'twenty-one')
    // No two counts share a spelling, which is what makes the regex safe: if
    // they did, a README naming one would satisfy the assertion for the other.
    const range = Array.from({ length: 100 }, (_, i) => spelled(i))
    assert.equal(new Set(range).size, range.length, 'two gate counts spell the same way')
  })
})

#!/usr/bin/env node
/**
 * Coverage, measured over the tests that exist (QUA-04).
 *
 * `test:coverage` ran the whole `src/**` tree against **six** test files out of
 * 162. The thresholds were enforced, the numbers were real, and the number
 * described six files' reach: a module with no test at all still passed,
 * because no test file imported it and so it never appeared in the denominator
 * as anything but zero — and zero over zero is not a failure.
 *
 * A coverage gate scoped to a hand-picked list is a gate that measures the
 * list. This runs the whole suite, so a module nothing exercises is measured
 * as unexercised and the thresholds mean what they say.
 *
 * **Why a script and not an inline `node --test` invocation.** The thresholds
 * live here, next to the reasoning, rather than in a `package.json` string
 * where a reviewer cannot see what the number is protecting. The suite is
 * invoked with the same glob `npm test` uses, so the two cannot drift.
 *
 * **The two thresholds, and what each is for.** Line coverage says a module is
 * reached; branch coverage says its refusals are reached. The second is the
 * one that matters for this codebase, because its defects are almost all in a
 * branch that was never taken — an absent value folded in as zero, a partner
 * predicate that matched nothing, a fallback nobody ran. A line threshold alone
 * is satisfied by a module whose every `if` is entered once.
 *
 * Run with `--json` to print the parsed totals without the pass/fail verdict.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The floors. Raised only when a change earns it, never to make a build green.
 *
 * Set from the measured full-suite numbers — 95.7% lines, 81.7% branches,
 * 93.6% functions — with a few points of slack so ordinary churn does not fail
 * the build. A gate that fires on noise is a gate that gets a `|| true`
 * appended to it, and then it is not a gate.
 *
 * The floors are well above the 75/60/75 they replace, and the difference is
 * not that the code got better: it is that the old number measured six test
 * files and this one measures all of them.
 */
const FLOORS = Object.freeze({ lines: 92, branches: 76, functions: 90 })

const json = process.argv.includes('--json')

/** The suite's own glob, so `npm test` and this cannot diverge. */
function testFiles() {
  return fs.readdirSync(path.join(root, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join('test', name))
}

/**
 * Run the suite under the coverage reporter and return its totals.
 *
 * The report goes to a file rather than through a pipe: `node --test` writes
 * the coverage table to stdout *after* the test summary, and reading it from a
 * pipe that the test runner also writes to is how a summary line gets cut. The
 * file is the whole output; the parse is a regex over it.
 */
function runCoverage(files) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `lindela-coverage-${process.pid}.log`)
    const fd = fs.openSync(out, 'w')
    const child = spawn(
      process.execPath,
      ['--test', '--experimental-test-coverage', '--test-coverage-include=src/**', ...files],
      { cwd: root, stdio: ['ignore', fd, fd] },
    )
    child.on('close', (code) => {
      fs.closeSync(fd)
      const text = fs.readFileSync(out, 'utf8')
      fs.rmSync(out, { force: true })
      resolve({ code, text })
    })
  })
}

/**
 * The `all files` row of the coverage table.
 *
 * Node prints one row per file and a totals row whose first column is
 * `all files`, prefixed with `ℹ ` when the reporter is in TTY mode and bare
 * otherwise. Its columns are: lines %, branch %, functions %, then the three
 * raw counts. Anything else in the table has a path in column one.
 */
export function parseTotals(text) {
  const line = text.split('\n').find((row) => /^(?:ℹ )?all files\s/.test(row.trim()))
  if (!line) return null
  const numbers = line.match(/(\d+(?:\.\d+)?)/g)
  if (!numbers || numbers.length < 3) return null
  return { lines: Number(numbers[0]), branches: Number(numbers[1]), functions: Number(numbers[2]) }
}

const files = testFiles()
if (files.length === 0) {
  console.error('check-coverage: no test files found — the glob is wrong, and a gate with no input passes forever')
  process.exit(1)
}

/**
 * Run the gate, unless this module was imported for its `parseTotals`.
 *
 * The guard is not decoration: without it, importing the file to test the
 * parser runs the entire suite, which is how a unit test of a regex becomes a
 * four-minute build step. `import.meta.url` against `process.argv[1]` is the
 * ESM spelling of `require.main === module`.
 */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (!invokedDirectly) {
  // Imported. Export only.
} else {
  await main(files)
}

async function main(files) {
  const { code, text } = await runCoverage(files)
  const totals = parseTotals(text)

  if (!totals) {
    // A gate that cannot read its own measurement must fail, not pass. This is
    // the shape of the defect it replaces: a script that reported success while
    // measuring nothing.
    console.error('check-coverage: could not find the `all files` row in the coverage report.')
    console.error('  The suite exit code was', code, '- if non-zero, that is the failure to fix first.')
    console.error(text.split('\n').slice(-40).join('\n'))
    process.exit(1)
  }

  if (json) {
    console.log(JSON.stringify({ ...totals, floors: FLOORS, files: files.length, suiteExit: code }, null, 2))
    process.exit(0)
  }

  const failures = []
  for (const [metric, floor] of Object.entries(FLOORS)) {
    if (totals[metric] < floor) failures.push(`${metric} ${totals[metric]}% < ${floor}%`)
  }

  console.log(`coverage over ${files.length} test files: `
    + `lines ${totals.lines}% (floor ${FLOORS.lines}%), `
    + `branches ${totals.branches}% (floor ${FLOORS.branches}%), `
    + `functions ${totals.functions}% (floor ${FLOORS.functions}%)`)

  if (failures.length) {
    console.error(`check-coverage: ${failures.join('; ')}`)
    process.exit(1)
  }
  // The suite's own exit code matters too: coverage of a failing run describes
  // code that does not work.
  if (code !== 0) {
    console.error(`check-coverage: thresholds met, but the suite exited ${code}`)
    process.exit(code)
  }
  console.log('check-coverage: ok')
}

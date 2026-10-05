#!/usr/bin/env node
/**
 * Every gate, classified by what it needs to run.
 *
 * R-76/ENH-43: 7 of 17 gates never ran in CI, and the ones that never ran were
 * the accessibility and layout invariants — 842 + 432 + 214 + 207 lines written
 * to express behaviour that executes only when a human remembers and has a
 * Chrome open. That includes the `hidden`-defeating-display class, which had
 * shipped three times before anyone noticed, because the check that would have
 * caught it was one of the seven.
 *
 * The reason they never ran is not that they are hard. It is that they need a
 * server and a browser, and CI had no job that started either. So they were
 * invoked from a terminal, and a terminal invocation is not a gate — it is a
 * habit, and habits are what the 7-of-17 gap was made of.
 *
 * This file makes the distinction explicit and cheap to act on:
 *
 *   self-contained   no server, no browser. Runs anywhere, in milliseconds.
 *                    These are the ones that should gate every push, and
 *                    `check-budget` is the clearest omission: it needs nothing
 *                    at all and was the cheapest possible gate to wire.
 *   needs-server     needs the app on :4177. Cheap in CI — one background
 *                    process and a health poll.
 *   needs-browser    needs Chrome on :9222 as well. One more container
 *                    service, and the only genuinely expensive tier.
 *
 * The classification is asserted against each script's source, not trusted
 * from a hand-written table. A gate that quietly grows a `fetch(':4177')` and
 * stays in the self-contained tier is worse than an unclassified gate: it looks
 * like it runs in CI, and it fails there for a reason nobody anticipated.
 *
 * Usage:
 *   node scripts/run-gates.mjs                 # every self-contained gate
 *   node scripts/run-gates.mjs --tier self-contained
 *   node scripts/run-gates.mjs --tier needs-server
 *   node scripts/run-gates.mjs --list          # classify, run nothing
 *   node scripts/run-gates.mjs --gate check-budget
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The gate inventory.
 *
 * `tier` is the classification this file asserts. `why` is the reason it is
 * what it is, because a tier with no reason is a guess someone will second-
 * guess in six months and move to the cheap tier to make a pipeline green.
 */
const GATES = [
  // --- self-contained: nothing to start, nothing to connect to -----------
  {
    name: 'check-budget',
    script: 'scripts/check-budget.mjs',
    tier: 'self-contained',
    why: 'Measures the first-load byte cost by walking the reference graph on disk. Needs no server and no browser — which is exactly why it was never wired, and exactly why it should have been the first.',
  },
  {
    name: 'check-i18n',
    script: 'scripts/check-i18n.mjs',
    tier: 'self-contained',
    why: 'Compares the locale catalogues against each other. Pure file reads.',
  },
  {
    name: 'check-i18n-offers',
    script: 'scripts/check-i18n-offers.mjs',
    tier: 'self-contained',
    why: 'Reads surface markup and locale files. No running app.',
  },
  {
    name: 'check-no-flood-probability',
    script: 'scripts/check-no-flood-probability.mjs',
    tier: 'self-contained',
    why: 'Scans src/ for fields without an agreed model basis. Runs inside validate too.',
  },
  {
    name: 'check-doc-links',
    script: 'scripts/check-doc-links.mjs',
    tier: 'self-contained',
    why: 'Follows links in docs/. Imported by validate.mjs.',
  },
  {
    name: 'check-openapi',
    script: 'scripts/check-openapi.mjs',
    tier: 'self-contained',
    why: 'Reads the route table and the served spec out of the server module in-process. Imported by validate.mjs.',
  },
  {
    name: 'check-budget-and-surface-contract',
    script: 'test/web-hidden-display.test.js',
    tier: 'self-contained',
    why: 'Resolves the CSS cascade over eight surfaces in Node. The `[hidden]` class, closed without a browser.',
  },

  // --- needs-server: the app on :4177, no browser ------------------------
  {
    name: 'check-dashboard-browser',
    script: 'scripts/check-dashboard-browser.mjs',
    tier: 'needs-browser',
    why: 'Drives the console with element.click() over CDP and asserts on behaviour, not appearance.',
  },

  // --- needs-browser: Chrome on :9222 *and* the server ------------------
  {
    name: 'check-a11y',
    script: 'scripts/check-a11y.mjs',
    tier: 'needs-browser',
    why: 'Nine assertions per surface from getComputedStyle and real keyboard traversal. 842 lines that never ran.',
  },
  {
    name: 'check-responsive',
    script: 'scripts/check-responsive.mjs',
    tier: 'needs-browser',
    why: 'Measures overflow, clipped text and SC 2.5.8 target size at three viewports, LTR and RTL.',
  },
  {
    name: 'check-dead-server-states',
    script: 'scripts/check-dead-server-states.mjs',
    tier: 'needs-browser',
    why: 'Kills the server and asserts no surface renders an empty state instead of an error.',
  },
  {
    name: 'check-chw-queue-state',
    script: 'scripts/check-chw-queue-state.mjs',
    tier: 'needs-browser',
    why: 'Exercises the CHW offline queue against a real dead socket.',
  },
  {
    name: 'audit-a11y',
    script: 'scripts/audit-a11y.mjs',
    tier: 'needs-browser',
    why: 'An axe-core pass over every surface. Distinct from check-a11y: this one is a third party\'s opinion, which is the point of it.',
  },
]

const NEEDS_SERVER = new Set(['needs-server', 'needs-browser'])

/* ------------------------------------------------------- classification */

/**
 * Does a gate's source reach for a running server or a CDP endpoint?
 *
 * Deliberately a scan of the file rather than a declared field: this is what
 * makes the `tier` above falsifiable. If a gate starts fetching `:4177`, this
 * returns true and the classification assertion fails, which is the correct
 * time to find out — at the moment the gate changed, not the first time CI
 * goes red for an unrelated reason.
 */
function requiredResources(source) {
  const needs = new Set()
  if (/127\.0\.0\.1:4177|localhost:4177|LINDELA_LITE_BASE/.test(source)) needs.add('server')
  if (/127\.0\.0\.1:9222|LINDELA_LITE_CDP|chrome|chromium/i.test(source)) needs.add('browser')
  return needs
}

/** Classify and check each declared tier against what the source actually needs. */
function classify() {
  return GATES.map((gate) => {
    const file = path.join(ROOT, gate.script)
    if (!existsSync(file)) {
      return { ...gate, actual: null, error: `${gate.script} does not exist` }
    }
    const source = readFileSync(file, 'utf8')
    const needs = requiredResources(source)
    return {
      ...gate,
      needs: [...needs],
      actual: needs.has('browser') ? 'needs-browser' : needs.has('server') ? 'needs-server' : 'self-contained',
    }
  })
}

/* ------------------------------------------------------------- running */

function runOne(gate) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(ROOT, gate.script)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LINDELA_LITE_BASE: process.env.LINDELA_LITE_BASE || 'http://127.0.0.1:4177' },
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => {
      resolve({ gate, code, out, ms: Date.now() - started })
    })
    child.on('error', (err) => {
      resolve({ gate, code: -1, out: `${out}\n${err.message}`, ms: Date.now() - started })
    })
  })
}

/* ------------------------------------------------------------------ main */

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true)
}

const classified = classify()
const misclassified = classified.filter((g) => g.actual && g.actual !== g.tier)

const pad = (s, n) => String(s).padEnd(n)

console.log('Gate classification')
console.log('='.repeat(78))
for (const tier of ['self-contained', 'needs-server', 'needs-browser']) {
  const inTier = classified.filter((g) => g.tier === tier)
  console.log(`\n${tier} (${inTier.length})`)
  for (const g of inTier) {
    const mark = g.actual === g.tier ? ' ' : '!'
    console.log(`  ${mark} ${pad(g.name, 32)} ${pad(g.script, 44)} ${g.why}`)
  }
}

if (argv.includes('--list')) {
  process.exit(0)
}

if (misclassified.length) {
  console.error('\nClassification is wrong. A gate was declared in one tier and needs another:')
  for (const g of misclassified) {
    console.error(`  ${g.name}: declared ${g.tier}, actually needs ${g.actual} (${g.needs.join(', ')})`)
    console.error(`      ${g.script}`)
  }
  console.error('\nThis fails rather than warns on purpose. A misclassified gate that runs')
  console.error('in CI anyway is a red build someone learns to retry; one that runs in the')
  console.error('cheap tier and reaches for a server is a failure with no explanation.')
  process.exit(1)
}

const wantedTier = flag('tier')
const wantedGate = flag('gate')

let selected = classified.filter((g) => existsSync(path.join(ROOT, g.script)))
if (wantedTier && wantedTier !== true) selected = selected.filter((g) => g.tier === wantedTier)
if (wantedGate && wantedGate !== true) selected = selected.filter((g) => g.name === wantedGate)

if (!selected.length) {
  console.error(`no gate matched ${wantedTier || wantedGate}`)
  process.exit(1)
}

const needsServer = selected.some((g) => NEEDS_SERVER.has(g.tier))
if (needsServer) {
  console.error(
    `\n${selected.length} gate(s) selected need a server on :4177${
      selected.some((g) => g.tier === 'needs-browser') ? ' and Chrome on :9222' : ''}.`,
  )
  console.error('Start them first, or run this tier from the CI job that provisions them:\n')
  console.error('  LINDELA_LITE_STORE=$RUNNER_TEMP/store.json npm run demo:seed')
  console.error('  LINDELA_LITE_STORE=$RUNNER_TEMP/store.json npm start &')
  console.error('  npx --yes wait-on http://127.0.0.1:4177/api/v1/health --timeout 60000')
  console.error('  google-chrome --headless --disable-gpu --no-sandbox \\')
  console.error('    --remote-debugging-port=9222 --user-data-dir="$RUNNER_TEMP/cdp" about:blank &')
  console.error('  npx --yes wait-on http://127.0.0.1:9222/json/version --timeout 60000')
  console.error('')
}

console.log(`\nRunning ${selected.length} gate(s)\n${'='.repeat(78)}\n`)

const results = []
for (const gate of selected) {
  process.stdout.write(`${pad(gate.name, 34)}`)
  const result = await runOne(gate)
  results.push(result)
  const verdict = result.code === 0 ? 'ok  ' : 'FAIL'
  console.log(`${verdict} ${pad(`${result.ms}ms`, 8)}`)
  if (result.code !== 0) {
    console.log(`\n--- ${gate.name} ---\n${result.out.trim()}\n`)
  }
}

const failed = results.filter((r) => r.code !== 0)
console.log('='.repeat(78))
console.log(`${results.length - failed.length}/${results.length} gates ok`)

if (failed.length) {
  console.error(`failed: ${failed.map((f) => f.gate.name).join(', ')}`)
  // Exit on the failure, not on the count. A pipeline that reports zero gates
  // passing because the runner crashed is the same silent-pass class this whole
  // file exists to close.
  process.exit(1)
}
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
    why: 'Compares the locale catalogues against each other, and (R-72) each catalogue against the source that asks for its keys. Pure file reads. Rule 4 reports a key no `public/`, `src/` or `scripts/` file can ask for: every locale is measured against such a key, so it raises the coverage floor for a string no reader can reach. Honours template-built keys by deriving the prefix set from the source and keeping only prefixes that name a catalogue namespace — `token_${n}` in `src/auth.js` builds a token id, not a key, and excuses nothing — and reports a prefix covering more than a quarter of the catalogue rather than trusting it. Declares itself out of jurisdiction on a tree with no `public/shared/runtime.js`, which is how the three i18n fixture-tree tests run it. Reads files only; carries eight canaries, driven by test/i18n-reachability.test.js.',
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
    name: 'check-workflows',
    script: 'scripts/check-workflows.mjs',
    tier: 'self-contained',
    why: 'Validates .github/workflows/*.yml. Every run for the repository history failed in 0s with no jobs because two defects invalidated the file — and a workflow that fails to parse reports the same red X for every commit, so it read as "tests are broken" for months. Carries its own canaries, because a validator never watched failing is not evidence.',
  },
  {
    name: 'check-csp',
    script: 'scripts/check-csp.mjs',
    tier: 'self-contained',
    why: 'Regenerates the inline-script hashes from the shipped markup and fails when src/server.js disagrees. A stale hash does not throw — the browser blocks the script silently — so this is the check that a human-maintained list would eventually fail. Reads files only.',
  },
  {
    name: 'check-absent-values',
    script: 'scripts/check-absent-values.mjs',
    tier: 'self-contained',
    why: 'ENH-46. Flags a numeric fallback on a field the module itself declares nullable — decided by the `<subject>_refusal` convention in the tree, not by a hand-written field list that goes stale. Reads files only, and carries eleven canaries plus a self-test, because the class it checks (VER-02, VER-09, VER-12) shipped four times and was found by audit each time.',
  },
  {
    name: 'check-doc-citations',
    script: 'scripts/check-doc-citations.mjs',
    tier: 'self-contained',
    why: 'Documents cite code by `path:line`, and the line numbers rot as the tree moves — ARC-08 was rewritten on 2026-10-11 and rotted again within a day, and 29 citations across the register named a line past EOF when this gate was written, three of them in VUL-01 (CRITICAL). Fails on a citation past EOF or to a missing file; an entry that means to quote a stale number says so with `line-drift-ok:`, and a document that quotes a tree that is gone declares `citations-are-historical: <date>` in its head. Scoped to past-EOF only: an in-bounds-but-drifted line is often a correctly-stale quote in a "Fixed" entry, and a gate that fires on correct input gets turned off. Walks the whole `docs/` tree — it was `DOC_DIRS = [\'docs/improvements\']` until 2026-10-14, a hand-typed one-element list standing for a discoverable set, and `docs/architecture/` held 15 findings it could not see, two of them to a module that no longer exists. Reads `.md` and `_status-*.json`; the latter is register prose in an envelope, and for a shipped item its `detail` reaches no rendered document, so this gate is its only reader. Reads files only; carries eighteen canaries, driven by test/doc-citation-gate.test.js.',
  },
  {
    name: 'check-client-endpoints',
    script: 'scripts/check-client-endpoints.mjs',
    tier: 'self-contained',
    why: 'ENH-59. The fifth route table ARC-02 names — the client\'s call sites — had no cross-check at all, so a screen could fetch a route the server does not serve and render its empty state, which reads as "no data" rather than "no route". Reads the client\'s `/api/v1/…` literals out of `public/` and asks the same `route-surface.mjs` derivation the document check uses, so a family that moves out of the dispatcher needs no edit here. Strips comments first: the first draft\'s only finding on a clean tree was `/api/v1/readyz` inside the paragraph explaining its own removal, and a gate that fires on correct input gets deleted. Accepts a literal that is a proper prefix of a served path, because the client completes built paths at call time. Reads files only; carries ten canaries.',
  },
  {
    name: 'check-aggregation-kinds',
    script: 'scripts/check-aggregation-kinds.mjs',
    tier: 'self-contained',
    why: 'ENH-45. Applies the aggregation-kind registry to `reduce(sum)` sites and refuses a sum over an intensive measurement. It found the second live instance of VER-01 — the climate-conflict scorer summing point rainfall across stations, in the same module the flood scorer was fixed in. Reads files only, and carries eleven canaries, the first two of which are the defect and its fix side by side.',
  },
  {
    name: 'check-unit-mixing',
    script: 'scripts/check-unit-mixing.mjs',
    tier: 'self-contained',
    why: 'ENH-47. Applies the unit/dimension/period registry: a connector that writes an accumulating field without declaring its period is flagged, and so is a module that averages such a field across periods. It found two live instances in one module — `src/analytics.js` averages `precipitation_mm` in the flood and climate-conflict scorers, where the same field is the preceding 15 minutes in one record and the whole-day total in the next. Reads files only, and carries twelve canaries; the last one is the exemption bug that let a reverted fix pass, kept so it cannot return.',
  },
  {
    name: 'check-route-envelopes',
    script: 'scripts/check-route-envelopes.mjs',
    tier: 'self-contained',
    why: 'QUA-06. Drives every route the OpenAPI spec documents against a real server and asserts the envelope invariants no test enforced everywhere: a boolean `success`, a `code` on every failure, and an array `data` that is either fully paginated or a named exception. Found `/api/v1/connectors/status` reporting a bare `total` and `/api/v1/road-access` unpaged on its first run. Binds an ephemeral port on 127.0.0.1 rather than :4177, so it needs nothing started.',
  },
  {
    name: 'check-route-methods',
    script: 'scripts/check-route-methods.mjs',
    tier: 'self-contained',
    why: 'VER-14 / VER-17. `check-openapi` compares paths and says so; `check-route-envelopes` drives only GET. So no gate owned the question "is a verb the contract does not declare refused?", and the same defect class was found three times by three hand sweeps — four read routes answering DELETE with 200 (VER-14), service-assets answering PATCH and DELETE with 500 (VER-17), and seven more routes plus two undeclared GETs when the sweep was finally run across the whole surface. This drives every verb against every documented path on an ephemeral port and requires an undeclared verb to be refused. `metrics` is the one method-agnostic path, named with its reason. Scoped to the undeclared verb only: an earlier draft also flagged declared 5xx and fired on four correct routes (`/health`’s documented 503, rapidpro’s unset-secret 503, the CAP renderer’s refusal), which is how a gate gets disabled. Carries eleven canaries, two of them the negative jurisdiction boundary.',
  },
  {
    name: 'check-module-coverage',
    script: 'scripts/check-module-coverage.mjs',
    tier: 'self-contained',
    why: 'QUA-05. Reads every module under src/ and every test file, and requires each module to be reached by a test or named in SERVER_SURFACE_MODULES with the route that reaches it. Makes the coverage census re-runnable, which the hand count it replaces was not — that count missed src/demo-seed.js and reported src/lineage.js as covered. Pure file reads.',
  },
  {
    name: 'check-boundary',
    script: 'scripts/check-boundary.mjs',
    tier: 'self-contained',
    why: 'R-78. Nothing enforced the frontend/backend split, and the entry stated the invariant backwards: it said `src/` → `public/` and `public/` → `src/` were both 0 edges, but the first is **17 edges across 13 files** and is the mechanism by which the server and the browser run the same code (`public/shared/units.js`, `flood-bands.js`, `rank-explain.js`). A gate written from that entry would have failed on a clean tree and been switched off. The jurisdiction is one direction only — nothing under `public/` may import `src/`, because `src/` is not served and the failure is a 404 at runtime in a surface that passed every test. Comments are stripped before scanning, so the file that documents this rule is not reported as breaking it. Reads files only; carries nine canaries, driven by test/boundary-gate.test.js.',
  },
  {
    name: 'check-import-cycles',
    script: 'scripts/check-import-cycles.mjs',
    tier: 'self-contained',
    why: 'R-77. The entry listed three import cycles and there were five. All five are broken (each by moving a leaf out of the module that closed the loop: `src/source-policies.js`, `src/envelope.js`, `src/derived-key.js`, `src/nl-vocabulary.js`), and this is the class rather than the instances, so the sixth fails in CI instead of waiting to be found by hand — which is exactly how the fourth and fifth were found. A cycle resolves on a deferred binding until one becomes a top-level use, at which point it reads `undefined` with no error and the failure surfaces far from the import that caused it. Walks `src/` only: `public/` has no bundler and a cycle there is legal, and `scripts/` is tooling. Comments are stripped before the graph is built, because the first draft reported `freshness.js → freshness.js` from the usage example inside its own doc comment. Reads files only; carries eight canaries, driven by test/import-cycles-gate.test.js.',
  },
  {
    name: 'check-route-drift',
    script: 'scripts/check-route-drift.mjs',
    tier: 'self-contained',
    why: 'ENH-59. Five tables described the same 233 operations and each was kept by hand, so the only thing holding them together was a person remembering to edit all five — and the item exists because one of them silently lost nine live routes. `docs/openapi.yaml` and `src/route-manifests.js` are now outputs of `src/route-declaration.js`, and this asserts each committed file equals a fresh generation, naming the line that moved. Its limit is worth stating where it is read: drift proves the tables came from the declaration, not that the declaration is true, because a generator that emits from a wrong declaration is consistent and wrong at once. `check-route-reachability` is the other half. The scope tables are the deliberate exception — a scope is policy, so they stay hand-kept and `test/route-declaration.test.js` proves the agreement. Reads files only; carries six canaries, driven by test/route-drift-gate.test.js.',
  },
  {
    name: 'check-route-reachability',
    script: 'scripts/check-route-reachability.mjs',
    tier: 'self-contained',
    why: 'ENH-59. The declaration and the dispatch code must describe the same routes, and nothing checked that. The direction that matters is the one nobody watches: `/api/v1/districts/{id}` was served, fetched by the console on every page, and in no table at all — invisible to every check built on the tables, because it was absent from all of them in the same way. Derives the served set from the imperative matchers via `scripts/route-surface.mjs` (193 paths from 37 matchers) and requires set equality with the declaration. Parameter *names* are normalised, literals and segment count are not, so a route that matches a declared one only in shape is still a finding — a fuzzy match there would swallow exactly the route that is missing. Reads files only; carries eight canaries, driven by test/route-reachability-gate.test.js.',
  },
  {
    name: 'check-dead-exports',
    script: 'scripts/check-dead-exports.mjs',
    tier: 'self-contained',
    why: 'QUA-09. `check-module-coverage` asks whether a module is reached, and one import of one name answers yes for the whole file — so `src/sanctions.js` was fully covered while `resetSdnCache`, whose own docstring said "Used by tests", was reached by nothing in or out of the tree. This reads *import statements* and asks per export whether any name import, `export *`, namespace import or resolvable dynamic import reaches it, reporting 10 exports that nothing reaches and 127 that are merely exported wider than they need to be (a lint, not a finding). It found a real defect on the tree it was written for: `createReplicaFromEnv` had no caller, so a deployment that set `LINDELA_LITE_REPLICA_URL` read its primary while the register said "Wired 2026-10-12". Five instrument bugs were found by canaries rather than by reading — a mention in a docstring counted as a call, a spread call excluded by a lookbehind, `//` inside a regex literal read as a comment, `${…}` holes blanked as prose, and 53 test files’ dynamic destructuring never parsed — so the rule that resolves `(await import(<computed>)).name` records the *name* globally rather than attributing it to a file the operator cannot fix. Reads files only; carries 23 canaries, driven by test/dead-exports-gate.test.js.',
  },
  {
    name: 'check-state-keys',
    script: 'scripts/check-state-keys.mjs',
    tier: 'self-contained',
    why: 'R-68. A browser surface reads and writes its `state` object through keys the literal that defines it never names, and JavaScript does not mind — so the defect is invisible by construction: an undeclared key and a declared one behave identically until something enumerates the object, at which point a reset written as `Object.keys(state)` drops it. `public/app.js` carried six and `public/focal-point/app.js` four, including one key (`reportsScope`) that was written and never read and one (`state.pending`) read on a path where its own fetch had failed. Resolves `state` **lexically** rather than by regex, because two functions in `public/app.js` take their own `state` parameter and nine references belong to those — a regex scanner reports them as findings, and nine false positives is how a gate gets turned off. Files with no module-level literal are reported out of jurisdiction rather than guessed at. Reads files only; carries ten canaries, driven by test/state-keys-gate.test.js.',
  },
  {
    name: 'check-budget-and-surface-contract',
    script: 'test/web-hidden-display.test.js',
    tier: 'self-contained',
    why: 'Resolves the CSS cascade over eight surfaces in Node. The `[hidden]` class, closed without a browser.',
  },
  {
    name: 'check-outbound-fetch',
    script: 'scripts/check-outbound-fetch.mjs',
    tier: 'self-contained',
    why: 'ENH-78. VUL-01 was one SSRF site; the class is any URL the server fetches whose origin is the caller. This asserts what decides whether the SSRF tests could cover the next path: every `fetch(` in src/ is guarded or carries a `caller-url-ok: <reason>` marker. The connectors are the jurisdiction case — a self-hosted DHIS2 or field gateway is legitimately on the operator LAN, so those name the narrow `assertConnectorUrl` (metadata ranges refused, RFC-1918 permitted) rather than the webhook guard. Reads files only, and carries fourteen canaries; the `guarded-by-caller` marker is honoured only when the file actually calls a guard, so a marker cannot outlive the guard it describes.',
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
    why: 'Exercises the CHW offline queue and asserts the words a health worker is shown.',
  },
  {
    name: 'check-offline-roundtrip',
    script: 'scripts/check-offline-roundtrip.mjs',
    tier: 'needs-browser',
    why: 'Stops the server — rather than emulating its absence, which a service worker defeats — and walks the whole arc: cold start, file, survive a restart, deliver on return, exactly once. The half that proves a stored report is not a lost one.',
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
  // `http-get://` for the DevTools endpoint: Chrome answers a HEAD there by
  // closing the connection mid-response, so `wait-on`'s default HEAD probe times
  // out against a Chrome that is up. See the same note in `.github/workflows/ci.yml`.
  console.error('  npx --yes wait-on "http-get://127.0.0.1:9222/json/version" --timeout 60000')
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
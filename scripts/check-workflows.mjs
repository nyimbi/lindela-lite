#!/usr/bin/env node
/**
 * VUL-05. The workflow file that had never run.
 *
 * `.github/workflows/ci.yml` failed on every push for the repository's whole
 * history — 264 runs, all `failure`, all 0s, no jobs — and nothing surfaced it:
 * a workflow rejected at parse time reports the same red X for every commit, so
 * the signal was indistinguishable from "the tests are broken" and was read as
 * such. Two independent defects, each invalidating the file before any job ran:
 *
 *   1. `schedule:` / `workflow_dispatch:` at **job** level. They are top-level
 *      keys; at job level they are unexpected and the file is rejected.
 *   2. `uses: slsa-framework/slsa-github-generator@v1.10.0` inside `steps:`.
 *      That repository publishes a reusable *workflow* (and actions under
 *      `actions/`); it has no root `action.yml`, so the step is unresolvable and
 *      the file is rejected — before `if:`, so the tag gate never protected it.
 *
 * `actionlint` catches (1) and not (2), and (2) is the one that broke every run.
 * This gate covers both without needing a Go toolchain or the network, because a
 * gate that requires installing a binary is a gate that gets skipped.
 *
 * **The canaries below are the point of the file.** A validator that has never
 * been watched fail is not evidence — `npm run x` against a module with no entry
 * point exits 0 and passes forever. So this script validates two synthetic
 * workflows that contain the exact defects above and fails if either is
 * accepted. If someone "fixes" a check by deleting it, the canary notices.
 *
 *   node scripts/check-workflows.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows')

const failures = []
const fail = (file, message) => failures.push(`${file}: ${message}`)

/**
 * Keys valid at job level. Anything else is the defect in (1).
 *
 * From the GitHub Actions workflow schema. Kept as a set rather than checked
 * against a list of known-bad keys: a list of known-bad keys only catches the
 * two that were there, and the next typo is a third one.
 */
const JOB_KEYS = new Set([
  'name', 'runs-on', 'needs', 'if', 'permissions', 'environment', 'concurrency',
  'outputs', 'env', 'defaults', 'steps', 'timeout-minutes', 'continue-on-error',
  'container', 'services', 'strategy', 'uses', 'with', 'secrets', 'snapshot',
])

/**
 * A `uses:` that names a repository root without a path.
 *
 * `owner/repo@ref` resolves only if the repo has a root `action.yml`/`action.yaml`
 * — or, at job level, a `.github/workflows/<file>.yml`. A step-level reference to
 * a repo that publishes only reusable workflows is unresolvable, which is defect
 * (2). This cannot be fully decided without the network, so the gate pins the
 * known-reusable-workflow publishers and otherwise checks the shape.
 */
const REUSABLE_ONLY = new Set([
  'slsa-framework/slsa-github-generator',
])

/** Split `owner/repo/sub/path@ref` into its parts. */
function parseUses(value) {
  const at = value.lastIndexOf('@')
  if (at === -1) return null
  const target = value.slice(0, at)
  const ref = value.slice(at + 1)
  const parts = target.split('/')
  if (parts.length < 2) return null
  return { owner: parts[0], repo: parts[1], subpath: parts.slice(2).join('/'), ref, target, raw: value }
}

/**
 * Minimal YAML reader for the shapes this file uses.
 *
 * Not a general parser. Workflow files here are two levels of nesting with
 * scalar values and block sequences, and `npm`-installed YAML would be a second
 * runtime dependency for one gate. The reader reports the line number of every
 * top-level job and every job-level key, which is what the checks need.
 */
function readJobs(text) {
  const lines = text.split('\n')
  const jobs = new Map()
  let inJobs = false
  let current = null
  let currentIndent = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length

    if (indent === 0) {
      inJobs = line.trimEnd() === 'jobs:'
      current = null
      continue
    }
    if (!inJobs) continue

    // A job id is a key at indent 2.
    if (indent === 2) {
      const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
      if (match) {
        current = { id: match[1], line: i + 1, keys: [], steps: [], raw: '' }
        jobs.set(match[1], current)
        currentIndent = indent
      }
      continue
    }

    if (current && indent > currentIndent) {
      current.raw += `${line}\n`
      // A job-level key is at indent 4 and is not part of a block scalar.
      if (indent === 4) {
        const match = line.match(/^ {4}([A-Za-z0-9_-]+):/)
        if (match) current.keys.push({ key: match[1], line: i + 1 })
      }
      const usesMatch = line.match(/^\s*(?:- )?uses:\s*(\S+)/)
      if (usesMatch) current.steps.push({ uses: usesMatch[1], line: i + 1, indent })
    }
  }
  return jobs
}

function checkWorkflow(file, text) {
  const jobs = readJobs(text)
  if (jobs.size === 0) {
    fail(file, 'declares no jobs — the reader found none, which is either an empty file or a shape it cannot read')
    return
  }

  for (const job of jobs.values()) {
    for (const { key, line } of job.keys) {
      if (!JOB_KEYS.has(key)) {
        fail(file, `line ${line}: job "${job.id}" has an unexpected key "${key}" — not valid at job level, and it invalidates the whole file`)
      }
    }

    for (const step of job.steps) {
      const parsed = parseUses(step.uses)
      if (!parsed) continue
      // A job-level `uses:` (indent 4) is a reusable workflow and is fine. A
      // step-level `uses:` (indent 6+, or under `steps:`) must be an action.
      const jobLevel = step.indent === 4
      if (jobLevel) continue
      if (REUSABLE_ONLY.has(`${parsed.owner}/${parsed.repo}`) && parsed.subpath === '') {
        fail(file, `line ${step.line}: "${step.uses}" is a reusable *workflow*, not an action — it publishes no root action.yml, so a step-level reference is unresolvable and invalidates the file. Invoke it at job level with "uses:".`)
      }
    }
  }
}

/**
 * The canaries.
 *
 * Each is a workflow that must be **rejected**. If the validator accepts one,
 * the validator is broken — not the canary. This is the check that a gate has
 * been watched fail.
 */
const CANARIES = [
  {
    name: 'job-level schedule',
    expect: /unexpected key "schedule"/,
    text: `name: C\non:\n  push:\n    branches: [main]\njobs:\n  live:\n    runs-on: ubuntu-latest\n    schedule:\n      - cron: '0 0 * * *'\n    steps:\n      - run: echo hi\n`,
  },
  {
    name: 'reusable workflow referenced as a step',
    expect: /reusable \*workflow\*, not an action/,
    text: `name: C\non:\n  push:\njobs:\n  prov:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: slsa-framework/slsa-github-generator@v1.10.0\n        with:\n          upload-assets: true\n`,
  },
  {
    name: 'job-level workflow_dispatch',
    expect: /unexpected key "workflow_dispatch"/,
    text: `name: C\non:\n  push:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    workflow_dispatch:\n    steps:\n      - run: echo hi\n`,
  },
]

function runCanaries() {
  let broken = 0
  for (const canary of CANARIES) {
    // Validate in a sandbox by calling the same checks with a collecting sink.
    const caught = []
    const savedFail = failures.slice()
    failures.length = 0
    try {
      checkWorkflow(`canary:${canary.name}`, canary.text)
      const hit = failures.some((message) => canary.expect.test(message))
      if (!hit) {
        broken++
        console.error(`  CANARY NOT CAUGHT: ${canary.name}`)
        console.error(`    expected a failure matching ${canary.expect}`)
        console.error(`    got: ${failures.length ? failures.join(' | ') : 'no failure at all'}`)
      }
    } finally {
      failures.length = 0
      failures.push(...savedFail)
    }
    void caught
  }
  return broken
}

const files = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
if (files.length === 0) {
  fail('.github/workflows', 'contains no workflow files — the gate has nothing to check and would pass forever')
}

for (const name of files) {
  checkWorkflow(name, readFileSync(path.join(WORKFLOW_DIR, name), 'utf8'))
}

const brokenCanaries = runCanaries()
if (brokenCanaries) {
  console.error(`\n${brokenCanaries} canary/canaries were not caught — the validator is not checking what it claims.`)
}

if (failures.length || brokenCanaries) {
  console.error('\nWorkflow validation failed:\n')
  for (const message of failures) console.error(`  ${message}`)
  console.error(`\n${failures.length} problem(s), ${brokenCanaries} broken canary/canaries.`)
  console.error('A workflow that fails to parse reports the same red X for every commit, so this never surfaces on its own.')
  process.exitCode = 1
} else {
  console.log(`check-workflows: ${files.length} workflow file(s) valid, ${CANARIES.length} canaries caught.`)
}

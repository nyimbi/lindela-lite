#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonStore } from '../src/store.js'
import { seedAll } from '../src/demo-seed.js'
import { buildEvaluationContext } from '../src/operations.js'
import { resolveMetric } from '../src/alerts.js'

/**
 * R-95's missing half — the demo seed's own vocabulary is held to the
 * evaluation context.
 *
 * `test/evaluation-context.test.js` holds the *settings picker's* vocabulary to
 * the context: every `<option>` in `protoMetricList` and the alert form's
 * default must resolve, and they do. That is one of the two vocabularies the
 * tree ships. The other is the **seed**, and nothing checked it — so the demo
 * an operator first sees ships rules that can never fire.
 *
 * Measured 2026-10-17 against a fresh `seedAll` store: **5 of 5** alert rules,
 * **10 of 10** trigger protocols, **3 of 3** parametric rules and **10 of 10**
 * recorded alert events name a metric that resolves to nothing. Not a majority
 * — all of them. `precipitation_mm`, `temperature_max_c`,
 * `fever_case_rate_per_1000`, `conflict_events_count_7d`,
 * `dispatch_accuracy_pct`.
 *
 * **Why the fix is an allowance and not a rename.** The context carries
 * `counts.*` (45 keys, all collection row counts) and `operations.*` (4 keys).
 * A seed rule is `precipitation_mm >= 40 in Turkana` — a *per-region reading*.
 * The nearest thing the context has is `counts.climate_observations`, a global
 * row count: renaming `precipitation_mm` to it would make "Flood Watch" fire on
 * "the store holds some weather rows", permanently, in every region. There is
 * no faithful rename, and a rename that changes what the rule *means* is not a
 * fix — it is the same defect with a greener gate.
 *
 * The real gap is one layer down and is *not* fixed here: the evaluator reads
 * one global scalar per rule, while the seed's rules are scoped to regions
 * (`scope: { regions: ['Turkana', 'Bor', 'Aweil'] }`) and the evaluator reads
 * `scope.regions` nowhere — only `scope.district`, as a label for an alert that
 * already fired (`src/alerts.js:684`). So a per-region metric namespace is the
 * missing capability, and until it exists these rules are dead by construction.
 *
 * **What this gate therefore asserts**, and nothing more: the dead set is
 * *exactly* the set named here, with a reason each. A new dead metric name —
 * the next rule somebody adds with a bare field — fails, which is the class
 * R-95 was written for and the seed was outside. A *stale* entry fails too: an
 * allowlisted name that now resolves means the namespace landed and the entry
 * is hiding a working rule behind a reason that is no longer true.
 *
 * Exit 0 when the dead set matches, 1 otherwise. Canaried in `--self-test`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A metric-bearing field, derived from the rows rather than listed: the seed's
 * records spell it `metric`, `trigger_metric` or `metric_path`. Deriving it
 * means a collection added with a fourth spelling is caught by the gate
 * noticing a new collection has a metric-ish field, not by somebody
 * remembering to add it to a list here.
 */
const METRIC_FIELD = /^(metric|trigger_metric|metric_path)$/

/**
 * The dead set, with why each one is dead and what would revive it.
 *
 * This is a **surface decision, not a coverage exemption**: every entry says
 * what the name means and which namespace would have to exist for it to
 * resolve. An entry whose reason is "we have not got round to it" does not
 * belong here — that is the finding, and it should fail.
 */
export const DEAD_SEED_METRICS = Object.freeze({
  precipitation_mm: 'per-region rainfall reading; the context carries global collection row counts only, so no rename preserves the threshold',
  temperature_max_c: 'per-region maximum temperature; same missing namespace as precipitation_mm',
  fever_case_rate_per_1000: 'per-region disease rate; `disease_observations` rows carry no region_name and no rate, so the figure is not computable from the store',
  conflict_events_count_7d: 'a 7-day windowed conflict count; `counts.conflict_events` is an unwindowed global total',
  dispatch_accuracy_pct: 'a dispatch accuracy percentage; appears nowhere in the tree outside this seed, so no source computes it',
})

/**
 * Reads the seed's metric vocabulary from a freshly seeded store.
 *
 * The seed is reached only through `seedAll` — the builders are module-private
 * — so this drives the real entry point rather than re-declaring the
 * vocabulary, which would let the gate and the seed drift apart.
 */
export async function seedMetricNames() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-seed-metrics-'))
  try {
    const store = new JsonStore(path.join(dir, 'store.json'))
    await seedAll(store)
    const data = await store.read()
    const context = buildEvaluationContext(data)

    const found = []
    for (const [collection, rows] of Object.entries(data)) {
      if (!Array.isArray(rows) || rows.length === 0) continue
      if (!rows[0] || typeof rows[0] !== 'object') continue
      const field = Object.keys(rows[0]).find((k) => METRIC_FIELD.test(k))
      if (!field) continue
      for (const row of rows) {
        const metric = row?.[field]
        if (typeof metric !== 'string' || !metric) continue
        const value = resolveMetric(context, metric)
        found.push({
          collection,
          field,
          id: row.id || null,
          metric,
          resolvable: Number.isFinite(value),
          resolved: value === undefined ? 'undefined' : String(value),
        })
      }
    }
    return found
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Classifies the vocabulary into three sets. `newDead` is the finding: a name
 * the seed uses, that resolves to nothing, and that nothing has declared. It is
 * returned rather than thrown so the canaries can drive it on inputs they
 * construct, and so the caller prints the whole picture instead of the first
 * surprise.
 */
export function classifySeedMetrics(rows, allowance = DEAD_SEED_METRICS) {
  const dead = new Set()
  const live = new Set()
  for (const row of rows) {
    if (row.resolvable) live.add(row.metric)
    else dead.add(row.metric)
  }
  const newDead = [...dead].filter((name) => !(name in allowance))
  // An exemption that outlives its defect: the name resolves now, so the reason
  // beside it is false and it is hiding a working rule behind a stale excuse.
  const stale = [...live].filter((name) => name in allowance)
  return { dead: [...dead].sort(), live: [...live].sort(), newDead: newDead.sort(), stale: stale.sort() }
}

export async function scan() {
  const rows = await seedMetricNames()
  return { rows, ...classifySeedMetrics(rows) }
}

/** Canaries. Each is a hand-built input with a known answer; the expectations are not uniform. */
export const CANARIES = [
  {
    name: 'passes the seed as it stands: every dead name is declared',
    input: [
      { metric: 'precipitation_mm', resolvable: false },
      { metric: 'temperature_max_c', resolvable: false },
      { metric: 'counts.hazard_events', resolvable: true },
    ],
    expectNewDead: 0,
    expectStale: 0,
  },
  {
    name: 'flags a bare field name the seed added and nothing declared',
    input: [
      { metric: 'precipitation_mm', resolvable: false },
      { metric: 'river_level_m', resolvable: false },
    ],
    expectNewDead: 1,
    expectStale: 0,
  },
  {
    name: 'flags a stale allowance whose metric now resolves',
    input: [
      { metric: 'precipitation_mm', resolvable: true },
      { metric: 'counts.hazard_events', resolvable: true },
    ],
    expectNewDead: 0,
    expectStale: 1,
  },
  {
    name: 'is silent on a vocabulary that is entirely live',
    input: [
      { metric: 'counts.hazard_events', resolvable: true },
      { metric: 'operations.counts.open_incidents', resolvable: true },
    ],
    expectNewDead: 0,
    expectStale: 0,
  },
]

async function selfTest() {
  let failed = 0
  const expectations = new Set(CANARIES.map((c) => `${c.expectNewDead}/${c.expectStale}`))
  if (expectations.size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const { newDead, stale } = classifySeedMetrics(canary.input)
    const ok = newDead.length === canary.expectNewDead && stale.length === canary.expectStale
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expectNewDead} new dead / ${canary.expectStale} stale, got ${newDead.length} / ${stale.length}`)
  }
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(await selfTest())
  const { rows, dead, live, newDead, stale } = await scan()
  const collections = [...new Set(rows.map((r) => r.collection))].sort()
  const summary = `${rows.length} metric-bearing row(s) across ${collections.length} collection(s) (${collections.join(', ')})`

  if (newDead.length === 0 && stale.length === 0) {
    console.log(`seed metrics: clean — ${summary}`)
    console.log(`  ${live.length} metric name(s) resolve; ${dead.length} are declared dead in DEAD_SEED_METRICS`)
    process.exit(0)
  }

  console.error(`seed metrics: ${newDead.length + stale.length} finding(s) across ${summary}\n`)
  for (const name of newDead) {
    const sites = rows.filter((r) => r.metric === name)
    console.error(`  [undeclared] ${name} — resolves to nothing in ${sites.length} row(s): ${sites.map((s) => `${s.collection}.${s.id || '(no id)'}`).join(', ')}`)
  }
  for (const name of stale) {
    console.error(`  [stale exemption] ${name} — declared dead in DEAD_SEED_METRICS but now resolves; delete the entry`)
  }
  console.error('\nA rule whose metric names nothing is indistinguishable from a rule whose')
  console.error('threshold was not met: both are silent. The seed is the vocabulary an')
  console.error('operator meets first, so a dead name there teaches the wrong thing.')
  console.error('Either give it a path the context carries, or declare it above with the')
  console.error('namespace it needs — an undeclared dead name is the finding.')
  process.exit(1)
}

#!/usr/bin/env node
/**
 * ENH-77 — drive the synthetic population at a running server and report where
 * it breaks.
 *
 * **This is a manual probe, not a CI gate.** It needs a live server and it takes
 * minutes; it is not in `scripts/run-gates.mjs` and must not be added there. It
 * declares the server tier anyway — the base URL below names `127.0.0.1:4177` —
 * so that if anyone ever does wire it up, `requiredResources` classifies it
 * `needs-server` rather than leaving it in the self-contained tier to fail for a
 * reason nobody anticipated. Read that function before moving this file.
 *
 * What it does: builds a timeline from `src/load-model.js`, fires every request
 * at its modelled instant, and reports latency percentiles by route, the error
 * rate, and the peak concurrency at which the server stopped keeping up. The
 * model is deterministic from a seed, so a ceiling found here can be found again
 * by anyone who writes the seed down — which is the difference between a
 * measurement and an anecdote.
 *
 * **The probe is honest about what it did not find.** If no request failed and no
 * route's p95 crossed the ceiling, it says so in a sentence and reports the
 * largest load it *did* sustain. It never reports that load as "the ceiling":
 * the ceiling is where the server breaks, and a run that never broke the server
 * did not find one. A load tool that names its biggest successful run the
 * ceiling is the reason capacity numbers are not trusted.
 *
 * **The rate limits are exceeded on purpose, and here is why.** The model's
 * default population — one console, sixty-three devices, three partners — issues
 * roughly 35 reads a minute from the console alone, and `INBOUND_POLICIES.read`
 * is 300/min *per client*. Every actor in this probe reaches the server from one
 * address, so they all share one budget and the probe will see 429s that a real
 * deployment would not. That is not a defect in the probe: `clientKeyFor` keys on
 * the socket address unless `LINDELA_LITE_TRUST_PROXY=1`, so a deployment where
 * the whole population sits behind one NAT has exactly this problem, and the 429
 * count is the finding. The probe reports the 429s separately from real failures
 * for that reason.
 *
 * Usage:
 *   node scripts/load-probe.mjs                       # default population, 60 s
 *   node scripts/load-probe.mjs --seconds 300         # a five-minute window
 *   node scripts/load-probe.mjs --chw 200 --consoles 4
 *   node scripts/load-probe.mjs --json                # machine-readable
 *
 * Requires a server already running. Start one on loopback:
 *   LINDELA_LITE_HOST=127.0.0.1 LINDELA_LITE_PORT=4177 node src/server.js
 */

import { INBOUND_POLICIES } from '../src/inbound-rate-limit.js'
import { LOAD_MODEL_DEFAULTS, buildTimeline } from '../src/load-model.js'

/**
 * A p95 above this is a broken ceiling.
 *
 * The console's own poll floor is thirty seconds and it abandons a tick if the
 * previous one is still in flight, so a request that takes five seconds is not
 * "slow but working" — on the 2G link the field surfaces are built for, it is
 * the beginning of a console that stops updating. Stated as a constant because a
 * threshold a reader cannot find is a threshold a reader cannot argue with.
 */
export const LATENCY_CEILING_MS = 5_000

/** A request that never answers is a failure, not a slow success. */
export const REQUEST_TIMEOUT_MS = 15_000

/* ------------------------------------------------------------- arguments */

function parseArgs(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    if (i === -1) return fallback
    const next = argv[i + 1]
    return next === undefined || next.startsWith('--') ? true : next
  }
  const num = (name, fallback) => {
    const raw = flag(name, null)
    if (raw === null || raw === true) return fallback
    const value = Number(raw)
    return Number.isFinite(value) ? value : fallback
  }
  const base = String(flag('base', process.env.LINDELA_LITE_BASE || 'http://127.0.0.1:4177')).replace(/\/$/, '')
  return {
    base,
    seconds: num('seconds', LOAD_MODEL_DEFAULTS.windowMs / 1000),
    seed: num('seed', LOAD_MODEL_DEFAULTS.seed),
    consoles: num('consoles', LOAD_MODEL_DEFAULTS.console.count),
    chw: num('chw', LOAD_MODEL_DEFAULTS.chw.count),
    partners: num('partners', LOAD_MODEL_DEFAULTS.partner.count),
    token: flag('token', process.env.LINDELA_LITE_API_KEY || null),
    json: Boolean(flag('json', false)),
    dryRun: Boolean(flag('dry-run', false)),
  }
}

/* ------------------------------------------------------------- statistics */

/**
 * A percentile of a sorted list.
 *
 * Same definition as `src/circuit.js`: the nearest-rank method, and one sample
 * is not a percentile. Returning the single sample as a p95 is true of the data
 * and false about the distribution, so the sample count travels with every
 * figure the report prints.
 */
function percentile(sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
}

function latencyStats(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, p99: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  }
}

/* ----------------------------------------------------------------- driving */

/**
 * Fire the timeline at the server.
 *
 * One pass, scheduled at each request's modelled offset from a single start
 * instant. Requests overlap because their modelled instants overlap — the
 * concurrency is a property of the population, not of a ramp the probe chose, so
 * the peak in-flight count is a measurement of what the model's arrival process
 * asks the server to hold at once.
 *
 * Nothing is retried. A retried request would report the latency of the second
 * attempt and hide the failure of the first, which is the one number worth
 * having.
 */
async function drive(timeline, { base, token, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const started = Date.now()
  const results = []
  let inFlight = 0
  let peakInFlight = 0
  const inFlightByKind = { console: 0, chw: 0, partner: 0 }
  let peakInFlightKind = null
  let peakInFlightAtMs = null
  const waiters = []

  const runOne = async (request) => {
    inFlight += 1
    inFlightByKind[request.kind] = (inFlightByKind[request.kind] || 0) + 1
    if (inFlight > peakInFlight) {
      peakInFlight = inFlight
      peakInFlightAtMs = Date.now() - started
      peakInFlightKind = { ...inFlightByKind }
    }
    const route = `${request.method} ${request.path.split('?')[0]}`
    const began = Date.now()
    let status = null
    let error = null
    try {
      const response = await fetch(`${base}${request.path}`, {
        method: request.method,
        headers: {
          ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...(token ? { 'x-api-key': token } : {}),
        },
        body: request.method === 'POST' ? JSON.stringify(postBody(request)) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = response.status
      // The body is read and discarded. A fetch that is never consumed holds
      // its socket, so a probe that skipped this would measure its own
      // connection exhaustion rather than the server's capacity.
      await response.arrayBuffer().catch(() => null)
    } catch (err) {
      error = err?.name === 'TimeoutError' ? 'timeout' : (err?.message || String(err))
    } finally {
      inFlight -= 1
      inFlightByKind[request.kind] -= 1
    }
    results.push({
      route,
      kind: request.kind,
      method: request.method,
      status,
      error,
      ok: status !== null && status >= 200 && status < 400,
      rateLimited: status === 429,
      ms: Date.now() - began,
      at: Date.now() - started,
    })
    if (waiters.length) waiters.shift()()
  }

  for (const request of timeline.requests) {
    // `setTimeout` with a zero delay still yields, so a burst of same-instant
    // requests is issued across microtasks rather than one synchronous loop —
    // which is what lets them be in flight together, as they are in the model.
    //
    // The handles are deliberately *referenced*. An unref'd timer does not keep
    // the event loop alive, so a moment where every in-flight request had
    // settled would let Node exit mid-window and report a truncated run as a
    // clean one — the one failure this probe exists to avoid.
    setTimeout(() => {
      runOne(request).catch(() => {})
    }, request.at)
  }

  // Wait for the window to elapse and then for every in-flight request to settle.
  await new Promise((resolve) => { setTimeout(resolve, timeline.windowMs + 50) })
  while (inFlight > 0) {
    await new Promise((resolve) => waiters.push(resolve))
  }

  return {
    elapsedMs: Date.now() - started,
    results,
    concurrency: { peak: peakInFlight, atMs: peakInFlightAtMs, byKind: peakInFlightKind },
  }
}

/**
 * The body a CHW report carries.
 *
 * `kind` and `category` are what the route reads, and `category` must be a code
 * the taxonomy knows — a free-text category is a 400 by design (`assertCategory`),
 * and a probe that sent one would report a wall of refusals as a capacity
 * finding. `submission_id` is minted per request so the server's idempotency
 * path does not collapse the burst into one record: this measures the write
 * cost, not the deduplication.
 */
function postBody(request) {
  return {
    kind: 'symptom',
    category: 'fever',
    description: 'synthetic load-model probe',
    captured_at: new Date().toISOString(),
    submission_id: `load-probe-${request.seq}`,
  }
}

/* ------------------------------------------------------------- rate limits */

/**
 * What the modelled population asks of the inbound limiter, against what the
 * limiter grants one client.
 *
 * This is arithmetic over the model's own totals and `INBOUND_POLICIES`, not a
 * reading of the server's counters — the server does not expose per-client
 * budgets. It answers "would this population fit inside one client's budget",
 * which is the question a deployment behind one NAT has to answer, and it is
 * reported beside the observed 429s so the two can be read together.
 */
export function rateLimitVerdict(timeline) {
  const minutes = timeline.windowMs / 60_000
  const reads = (timeline.totals.byMethod.GET || 0) / minutes
  const writes = (timeline.totals.byMethod.POST || 0) / minutes
  const readBudget = INBOUND_POLICIES.read.ratePerWindow
  const writeBudget = INBOUND_POLICIES.write.ratePerWindow
  return {
    windowMinutes: minutes,
    readsPerMinute: reads,
    writesPerMinute: writes,
    readBudgetPerMinute: readBudget,
    writeBudgetPerMinute: writeBudget,
    readExceededBy: reads > readBudget ? reads / readBudget : 0,
    writeExceededBy: writes > writeBudget ? writes / writeBudget : 0,
    // One client is what the limiter sees when every actor shares an address,
    // which is the default and what this probe reproduces.
    clientsIfAddressKeyed: 1,
  }
}

/* ---------------------------------------------------------------- reporting */

function fmtMs(value) {
  return value === null ? '—' : `${Math.round(value)}ms`
}

function report({ args, timeline, run, verdict }) {
  const byRoute = new Map()
  for (const result of run.results) {
    if (!byRoute.has(result.route)) byRoute.set(result.route, [])
    byRoute.get(result.route).push(result)
  }

  const failures = run.results.filter((r) => !r.ok && !r.rateLimited)
  const rateLimited = run.results.filter((r) => r.rateLimited)
  const serverErrors = run.results.filter((r) => r.status !== null && r.status >= 500)
  // Grouped by reason, because "57 failed" does not say whether the server
  // refused or the probe ran out of sockets — and only the first is a finding
  // about the server. A transport error is attributable to neither end from
  // here: `fetch` reports `ECONNRESET` whether the server dropped the
  // connection or the client's own pool did.
  const failureReasons = {}
  for (const failure of failures) {
    const reason = failure.error || `HTTP ${failure.status}`
    failureReasons[reason] = (failureReasons[reason] || 0) + 1
  }
  const transportFailures = failures.filter((r) => r.status === null).length
  const clientStatusFailures = failures.filter((r) => r.status !== null).length
  const rows = []
  let slowestP95 = null
  for (const [route, results] of byRoute) {
    const stats = latencyStats(results.filter((r) => r.ok).map((r) => r.ms))
    if (stats.p95 !== null && (slowestP95 === null || stats.p95 > slowestP95.p95)) slowestP95 = { route, p95: stats.p95 }
    rows.push({ route, ...stats, failures: results.filter((r) => !r.ok && !r.rateLimited).length })
  }
  rows.sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1))

  const brokeOnLatency = rows.filter((r) => r.p95 !== null && r.p95 > LATENCY_CEILING_MS)
  const ceilingReached = failures.length > 0 || serverErrors.length > 0 || brokeOnLatency.length > 0

  const summary = {
    base: args.base,
    seed: timeline.seed,
    windowMs: timeline.windowMs,
    population: { consoles: args.consoles, chw: args.chw, partners: args.partners },
    issued: timeline.requests.length,
    sent: run.results.length,
    requestsPerSecond: timeline.totals.requests / (timeline.windowMs / 1000),
    byKind: timeline.totals.byKind,
    concurrency: run.concurrency,
    latencyCeilingMs: LATENCY_CEILING_MS,
    failures: failures.length,
    serverErrors: serverErrors.length,
    rateLimited: rateLimited.length,
    failureReasons,
    transportFailures,
    clientStatusFailures,
    routes: rows,
    slowestP95,
    ceilingReached,
    ceilingReason: ceilingReached
      ? (serverErrors.length ? `${serverErrors.length} server error(s)`
        : failures.length ? `${failures.length} failed request(s)`
          : `${brokeOnLatency.length} route(s) past the ${LATENCY_CEILING_MS}ms p95 ceiling`)
      : null,
    rateLimitVerdict: verdict,
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return summary
  }

  const out = []
  out.push(`ENH-77 load probe — ${args.base}`)
  out.push(`  population   ${args.consoles} console(s), ${args.chw} device(s), ${args.partners} partner(s)`)
  out.push(`  window       ${timeline.windowMs / 1000}s, seed ${timeline.seed}`)
  out.push(`  issued       ${timeline.requests.length} requests over the window (${summary.requestsPerSecond.toFixed(1)}/s)`)
  out.push(`               ${Object.entries(timeline.totals.byKind).map(([k, n]) => `${k}=${n}`).join(' ')}`)
  out.push('')
  out.push(`  latency by route (successful requests only)`)
  for (const row of rows) {
    const flags = [
      row.failures ? `${row.failures} failed` : null,
      row.p95 !== null && row.p95 > LATENCY_CEILING_MS ? 'PAST CEILING' : null,
    ].filter(Boolean).join(', ')
    out.push(`    ${fmtMs(row.p50).padStart(7)} ${fmtMs(row.p95).padStart(7)} ${fmtMs(row.p99).padStart(7)}  n=${String(row.count).padStart(5)}  ${row.route}${flags ? `  [${flags}]` : ''}`)
  }
  out.push('')
  out.push(`  peak concurrency  ${run.concurrency.peak} simultaneous request(s)${run.concurrency.atMs === null ? '' : ` at ${run.concurrency.atMs}ms`}`)
  out.push(`  failures          ${failures.length} (${serverErrors.length} server error(s), ${clientStatusFailures} refused with a 4xx, ${transportFailures} transport)`)
  for (const [reason, count] of Object.entries(failureReasons).sort((a, b) => b[1] - a[1])) {
    out.push(`                    ${String(count).padStart(4)}  ${reason}`)
  }
  out.push(`  rate-limited       ${rateLimited.length} response(s) with a 429`)
  // The failures above and the 429s are the same event seen twice: a burst of
  // simultaneous writes is refused by the write budget before it is refused by
  // anything the server is short of. Saying so is the difference between a
  // capacity finding and a rate-limit finding, and they call for different work.
  if (failures.length && rateLimited.length >= failures.length) {
    out.push('                    (a 429 burst and a refused write are the same event: the population is')
    out.push('                     over the write budget before it is over the server\'s capacity)')
  }
  out.push('')
  out.push('  rate limits (per client, from INBOUND_POLICIES)')
  out.push(`    reads  ${verdict.readsPerMinute.toFixed(0)}/min modelled against ${verdict.readBudgetPerMinute}/min granted`
    + (verdict.readExceededBy ? `  → ${verdict.readExceededBy.toFixed(1)}x over one client's budget` : '  → inside one client\'s budget'))
  out.push(`    writes ${verdict.writesPerMinute.toFixed(0)}/min modelled against ${verdict.writeBudgetPerMinute}/min granted`
    + (verdict.writeExceededBy ? `  → ${verdict.writeExceededBy.toFixed(1)}x over one client's budget` : '  → inside one client\'s budget'))
  out.push('    Every actor here reaches the server from one address, so they share one budget. Unless')
  out.push('    LINDELA_LITE_TRUST_PROXY=1 and a proxy sets x-forwarded-for, a deployment whose whole')
  out.push('    population sits behind one NAT has the same shape, and the 429s above are its finding.')
  out.push('')
  if (ceilingReached) {
    out.push(`  CEILING REACHED — ${summary.ceilingReason}.`)
    out.push(`  The population above is the one that broke it: ${summary.requestsPerSecond.toFixed(1)} req/s`)
    out.push(`  across ${timeline.totals.requests} requests, peaking at ${run.concurrency.peak} in flight.`)
    if (rateLimited.length) {
      out.push(`  ${rateLimited.length} response(s) were 429s, so this population is over the inbound budget as`)
      out.push('  well as over capacity — the two are separate findings and want separate fixes.')
    }
  } else {
    out.push('  NO CEILING FOUND.')
    out.push(`  Every request settled, none failed, and no route's p95 crossed ${LATENCY_CEILING_MS}ms.`)
    out.push(`  The largest load this run sustained is ${summary.requestsPerSecond.toFixed(1)} req/s across`)
    out.push(`  ${timeline.totals.requests} requests, peaking at ${run.concurrency.peak} in flight — and that is not a`)
    out.push('  ceiling, it is the most this run asked for. Raise --chw/--consoles/--partners and')
    out.push('  run it again to find one.')
  }
  process.stdout.write(`${out.join('\n')}\n`)
  return summary
}

/* -------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const timeline = buildTimeline({
    seed: args.seed,
    windowMs: Math.round(args.seconds * 1000),
    console: { count: args.consoles },
    chw: { count: args.chw },
    partner: { count: args.partners },
  })
  const verdict = rateLimitVerdict(timeline)

  if (args.dryRun) {
    report({ args, timeline, run: { results: [], concurrency: { peak: 0, atMs: null, byKind: null } }, verdict })
    return
  }

  // A health check first, so a probe against a dead port says so in one line
  // rather than reporting a thousand timeouts as a capacity finding.
  try {
    const health = await fetch(`${args.base}/api/v1/health`, { signal: AbortSignal.timeout(5_000) })
    if (!health.ok) throw new Error(`HTTP ${health.status}`)
  } catch (error) {
    process.stderr.write(`No server at ${args.base}/api/v1/health (${error.message}).\nStart one on loopback: LINDELA_LITE_HOST=127.0.0.1 LINDELA_LITE_PORT=4177 node src/server.js\n`)
    process.exitCode = 2
    return
  }

  const run = await drive(timeline, { base: args.base, token: args.token })
  const summary = report({ args, timeline, run, verdict })
  // Exit 1 only when the server broke under the modelled population. A run that
  // found no ceiling is a clean exit: it is an answer, not a failure.
  process.exitCode = summary.ceilingReached ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`)
    process.exitCode = 1
  })
}

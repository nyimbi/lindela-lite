/**
 * ENH-60 — the liveness family, out of the dispatcher.
 *
 * Two routes that answer one question from two sides, and the dispatcher's own
 * comments are where that was already written down: `/health` answers "is this
 * process running", `/ready` answers "can it serve a request right now". They
 * are a family because they are the same question asked at two depths — the
 * store is a separate dependency that can be unreachable while the process is
 * alive and answering `/health` with 200, so a load balancer polling only the
 * first keeps a broken instance in rotation and hands every user a 500 it could
 * have routed around.
 *
 * The properties this module exists to hold:
 *
 *   - **three states, not two.** A process that has never completed a cycle is
 *     `starting`, not broken — it may have been up for four seconds. Red is
 *     reserved for a heartbeat that exists and has gone stale, which is a
 *     pipeline that ran and stopped. `never_started` names the third case, which
 *     reads the same as a stopped pipeline in `healthy: false` and calls for a
 *     different fix.
 *   - **a degraded rollup is a 503 on `/ready`.** A tampered action log
 *     (`audit.valid === false`) or a dead-lettered outbox (`outbox.degraded`) is
 *     the instance saying it cannot serve correctly. Reporting 200 with the
 *     finding buried in the body is how a monitor stays green through it.
 *   - **a failing store costs one timeout, not two.** The probe read carries
 *     both collections the rollups need (`SCL-07`); a second read behind its own
 *     timeout made an unready instance hold the load balancer open twice as long
 *     as the timeout it was given.
 *   - **the auth posture is on the public route.** `/auth-info` needs a token to
 *     read, so the person asking "is this deployment secured?" was the one person
 *     who could not find out. `/health` carries the same booleans and nothing
 *     about who holds what.
 *
 * `withTimeout` and `pipelineIsHealthy` are injected rather than imported: both
 * live in `server.js` and importing them here would make this module and
 * `server.js` import each other. The dispatcher, which has them in scope, passes
 * them in.
 */

import { auditRollup, auditChainWarning } from '../audit-chain.js'
import { isAuthConfigured, publicPaths } from '../auth.js'
import { metricsOverflow, uptimeStats } from '../observability.js'
import { counts } from '../operations.js'
import { outboxRollup } from '../outbox.js'
import { piiSaltStatus } from '../pii.js'
import { publicSourceCatalog } from '../schema.js'

/**
 * Which liveness route a request is, or null.
 *
 * Both are GET and neither takes an id, so the pathname alone decides. Written
 * as positive `===` comparisons rather than a regex, because
 * `check-openapi.mjs` reads the positive form and a matcher it cannot parse is a
 * family it reports as serving nothing — which passes by contributing nothing.
 */
export function matchLivenessRoute(pathname) {
  if (pathname === '/api/v1/health') return { kind: 'health' }
  if (pathname === '/api/v1/ready') return { kind: 'ready' }
  return null
}

/**
 * Handle one liveness route. Returns true when it handled the request.
 */
export async function handleLivenessRoute(route, {
  store, loadData, req, res, url, jsonResponse,
  withTimeout, pipelineIsHealthy, driverIntervalSeconds, appVersion, idempotency,
}) {
  // The verb guard comes first, before any work, because an undeclared verb must
  // be refused without the request being well-formed — and because the two
  // routes below need different amounts of the store. A `POST /health` that
  // reached the read would do a whole-store read to answer 405.
  if (req.method !== 'GET') {
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return true
  }

  if (route.kind === 'health') {
    // `/health` reports on the pipeline and counts the collections, so it reads
    // the store. `/ready` does not call this: its one read is scoped and timed,
    // below, and materialising every collection on the most-polled endpoint in
    // the deployment is the amplification SCL-07 removed.
    const data = await loadData()
    // Is the thing this process exists to do actually happening?
    //
    // It asserted exactly one thing — that the store answered — and then
    // returned the literal string `ok`. It did not assert that ingestion is
    // running, that schedules are honoured, that alerts are evaluated, or that
    // the queue is draining. So a process that was up, serving 200s, and whose
    // pipeline had been dead for a week was indistinguishable from a healthy
    // one, and `Dockerfile:23-24` polls exactly this endpoint every 30 seconds.
    //
    // Two intervals before red, so a single slow tick is not an outage.
    const heartbeat = data.system_heartbeat?.[0] || null
    const pipeline = pipelineIsHealthy(heartbeat)
    // Three states, not two.
    //
    // A process that has never completed a cycle is `starting`, not broken: it
    // may have been up for four seconds. Reporting that as red would mean every
    // fresh deployment, and every restart, starts red — and a monitor that
    // starts red is a monitor that gets ignored.
    //
    // OBS-04. "Has never written a heartbeat" was `starting` forever, whatever
    // the uptime. If `startPeriodicDriver` fails — it logs and the process stays
    // up — no heartbeat is ever merged, `/health` answers 200/`starting`
    // indefinitely, and `Dockerfile`/compose poll exactly this endpoint. The
    // container is reported healthy while the pipeline never ran once. The
    // distinction is this server's own age, measured from `createServer` rather
    // than from the process: a deployment four seconds old has not had its
    // chance, one that has been serving for two intervals and still written
    // nothing has failed to start, and that is a different finding.
    const uptimeSeconds = Math.floor((Date.now() - (res.locals?.serverStartedAt ?? Date.now())) / 1000)
    const startGraceSeconds = driverIntervalSeconds() * 2
    const starting = !heartbeat && uptimeSeconds <= startGraceSeconds
    const neverStarted = !heartbeat && !starting
    jsonResponse(res, pipeline.healthy || starting ? 200 : 503, {
      success: pipeline.healthy || starting,
      status: starting ? 'starting' : pipeline.healthy ? 'ok' : 'degraded',
      pipeline: {
        healthy: pipeline.healthy,
        last_success_age_seconds: pipeline.ageSeconds,
        interval_seconds: heartbeat?.interval_seconds ?? null,
        last_failure: pipeline.lastFailure || null,
        // The two ways to be unhealthy read the same in `healthy: false` and
        // call for different fixes: one is a pipeline that stopped, the other a
        // pipeline that never began. Named here so the operator does not have to
        // infer it from a null age.
        never_started: neverStarted,
        process_uptime_seconds: uptimeSeconds,
        note: pipeline.healthy
          ? null
          : neverStarted
            ? `No heartbeat has been recorded in ${uptimeSeconds}s of uptime, more than two ${driverIntervalSeconds()}s intervals. The periodic driver has not completed a cycle since this process started.`
            : 'The pipeline has not completed a cycle recently. Nothing below has been refreshed since the last one that did.',
      },
      // One version, from package.json. The UI used to hardcode it in two HTML
      // files and one translation file and it drifted behind the package, so a
      // panel asking "which build is this?" would have been told the wrong one.
      // Read once at startup and fail loudly if it cannot be read, rather than
      // reporting a version we made up.
      version: appVersion,
      updated_at: data.updated_at,
      counts: counts(data),
      sources: publicSourceCatalog().map((source) => source.id),
      exclusions: ['gdelt'],
      storage: { mode: store.mode || 'custom' },
      // The auth posture, on the one route an operator can reach without a
      // token. It used to live only on `/api/v1/auth-info`, which needs a token
      // to read — so the person asking "is this deployment secured?" was the one
      // person who could not find out. The answer is a boolean, a public-path
      // list, and nothing about who holds what.
      auth: {
        configured: isAuthConfigured(),
        // `false` here means every route except the public list is closed to
        // everyone, which is a working deployment. It does *not* mean the
        // deployment is unsecured — that is `configured: false`.
        enforced: isAuthConfigured(),
        public_paths: publicPaths(),
      },
    })
    return true
  }

  if (route.kind === 'ready') {
    const started = Date.now()
    const timeoutMs = Number(url.searchParams.get('timeout_ms') || 2000)
    // SCL-07. One read, and it names what it wants.
    //
    // This endpoint is the most-polled surface in the deployment — a load
    // balancer asks every few seconds — and it read the whole store twice per
    // probe. On the Postgres store a whole-store read is every row's body,
    // including `record_versions`, which is 60% of the table by bytes and which
    // nothing here reads. Two of those per probe, on the endpoint designed to be
    // polled most, is amplification in the wrong direction.
    //
    // The second read also meant a *failing* store cost two timeouts, not one:
    // the probe read timed out, and then the rollup read timed out behind it. A
    // readiness check that takes 2× its own timeout to say "unready" holds the
    // load balancer open twice as long as it needs to.
    //
    // The two rollups are the only thing this route computes, so the manifest is
    // exactly their inputs. Reachability is still genuinely tested: a scoped read
    // opens the same connection and runs the same query shape.
    const READY_COLLECTIONS = ['action_logs', 'events_outbox']
    let probe = { ok: true, error: null }
    let snapshot = null
    try {
      snapshot = await withTimeout(store.read({ collections: READY_COLLECTIONS }), timeoutMs)
    } catch (error) {
      probe = { ok: false, error: error?.name === 'TimeoutError' ? `store did not respond within ${timeoutMs}ms` : String(error?.message || error) }
    }
    const latency = Date.now() - started

    // Two rollups that were computed and never read.
    //
    // `verifyChain` was called from exactly one route, so a tampered or
    // truncated `action_logs` table was detected when somebody asked for the
    // proof or not at all — which is not evidence. `outboxRollup` says how many
    // deliveries are dead-lettered, and nothing surfaced it.
    //
    // Guarded. A probe that hangs is worse than one that answers "unready": this
    // endpoint exists to be polled, and a probe that never returns holds the
    // caller open — which is how a readiness check stops being a signal and
    // becomes an outage.
    //
    // SCL-07. This used to be a second whole-store read behind its own timeout.
    // The read above now carries both collections, so the rollups are computed
    // from what it returned and there is no second round-trip to fail. A store
    // that could not answer leaves `snapshot` null and both rollups report that
    // honestly rather than by timing out twice.
    let audit = null
    let outbox = null
    if (snapshot === null) {
      const reason = probe.error || 'the store could not be read'
      audit = { valid: null, error: reason }
      outbox = { degraded: null, error: reason }
    } else {
      try {
        audit = auditRollup(snapshot.action_logs || [])
        // CON-08 / R-51. Loud once per broken head, quiet after. `auditChainWarning`
        // existed for exactly this and had no callers, so a broken chain was
        // reported on the readiness body and nowhere else — an operator watching
        // logs during an incident would not have seen it. Called with the rollup,
        // which is the shape this path has; the set it dedupes against is bounded.
        auditChainWarning('ready', audit)
        outbox = outboxRollup(snapshot)
      } catch (rollupError) {
        audit = { valid: null, error: String(rollupError?.message || rollupError) }
        outbox = { degraded: null, error: String(rollupError?.message || rollupError) }
      }
    }
    // R-48 and R-49. Two more things an operator cannot otherwise see.
    //
    // `schemaStatus()` computed `{current, expected, pending}` and had zero
    // callers, so a database a migration behind surfaced only as a 500 on every
    // request — the first person to learn the schema was wrong was a user who
    // could not use the product. And nothing anywhere reported free space, so
    // `ENOSPC` was a cascading 500 with no warning that the disk had been
    // filling: R-49's temp-file leak made that worse, and this is the other
    // half of the same row.
    //
    // Both probes are raced against the *same* timeout the store read was
    // given, not one each. SCL-07's rule holds here too: an unresponsive store
    // must cost one timeout, not four. A probe that throws or a backend that
    // cannot answer reports `supported: false` and is *not* a readiness
    // failure — a JSON store has no schema to be behind, and a Postgres client
    // cannot see the database server's disk. Only an observed defect degrades.
    let schema = { supported: false, error: null, pending: [], current: null, expected: null, current_build_is_ahead: false }
    let storage = { supported: false, error: null, store_bytes: null, free_bytes: null, total_bytes: null, used_ratio: null }
    try {
      const [schemaProbe, storageProbe] = await withTimeout(Promise.all([
        typeof store.schemaStatus === 'function' ? store.schemaStatus() : Promise.resolve(schema),
        typeof store.storageUsage === 'function' ? store.storageUsage() : Promise.resolve(storage),
      ]), timeoutMs)
      schema = schemaProbe
      storage = storageProbe
    } catch (probeError) {
      const reason = probeError?.name === 'TimeoutError'
        ? `the store's schema and disk probes did not answer within ${timeoutMs}ms`
        : String(probeError?.message || probeError)
      schema = { ...schema, error: reason }
      storage = { ...storage, error: reason }
    }

    // A database behind the build is missing columns this code writes to, so
    // every request that touches them 500s. A database *ahead* of it is not an
    // error — refusing to serve would push an operator into a manual downgrade,
    // and guarding newer rows is the newer schema's job.
    const schemaBehind = Array.isArray(schema.pending) && schema.pending.length > 0
    // The predicate is the one that predicts the failure. `#writeFile` rewrites
    // the whole store through a temp file of its own size, so the next write
    // needs `store_bytes` free — a disk at 2% is fine for a 40 KB store and
    // fatal for a 40 MB one. `free_bytes === null` is a client that cannot see
    // the disk, which is unknown, not broken.
    const diskFull = storage.supported === true
      && typeof storage.free_bytes === 'number'
      && typeof storage.store_bytes === 'number'
      && storage.free_bytes < storage.store_bytes

    const degraded = audit?.valid === false || outbox?.degraded === true || schemaBehind || diskFull

    const ready = probe.ok && !degraded
    jsonResponse(res, ready ? 200 : 503, {
      success: ready,
      ready,
      store: { mode: store.mode || 'custom', reachable: probe.ok, latency_ms: latency, error: probe.error },
      // Reported, not implied: the whole bound on the idempotency guarantee.
      //
      // `in_process` is gone rather than set to false, because it was never the
      // right question. What a caller needs to know is whether a retry survives
      // a restart, and that is `durable`. A store that cannot lock — a test
      // double — gets the in-process implementation and reports it, which is the
      // one case where the weaker guarantee is the honest answer.
      idempotency: {
        mode: idempotency?.mode || 'in-process',
        durable: idempotency?.mode === 'durable',
        collection: idempotency?.collection || null,
        ttl_hours: Math.round((idempotency?.ttlMs ?? 0) / (60 * 60 * 1000)),
      },
      // Two rollups that were computed and never read. A tampered action log
      // and a dead-lettered webhook were both invisible on the one endpoint a
      // load balancer and an operator already poll.
      audit,
      outbox,
      // OBS-05. Three more values that were computed and had no reader.
      // `metricsOverflow()` counts what the metric bounds in
      // `src/observability.js` refused — dropped label keys, folded values,
      // evicted series — and nothing surfaced it, so the cardinality guard could
      // have been discarding every second series for a month with no way to
      // know. `uptimeStats()` answers "how long has this instance been up",
      // which is the first question asked of a suspect instance and was only
      // answerable from the process table. `piiSaltStatus()` says whether
      // pseudonyms survive a restart: a generated salt means every pseudonym
      // this deployment has ever written becomes unlinkable at the next
      // restart, and nothing said so outside a startup log line.
      //
      // `/ready` rather than a new route: it is already the operator surface
      // that carries `audit`, `outbox` and `idempotency`, it is public, and it
      // already returns no records. A fourth endpoint would be a fourth thing to
      // authenticate and a fourth place to forget.
      metrics: metricsOverflow(),
      uptime: uptimeStats(),
      pii: piiSaltStatus(),
      // R-48. What the database is at against what this build expects, on the
      // endpoint that already answers "can this instance serve a request". A
      // database behind the build is `ready: false`; one ahead of it is
      // reported and served.
      schema,
      // R-49. Store bytes and free bytes, because the write that fails needs
      // both to predict. `free_bytes < store_bytes` is `ready: false` — the
      // next write cannot land, which is the state that produces the cascading
      // 500s this row is about.
      storage,
      checked_at: new Date().toISOString(),
    })
    return true
  }

  // Unreachable: the matcher serves two kinds and both are handled above, and
  // the verb guard has already refused everything that is not a GET. Kept as an
  // explicit refusal rather than a fallthrough so a third kind added to the
  // matcher without a branch here answers 405 instead of 404 from the tail.
  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  return true
}

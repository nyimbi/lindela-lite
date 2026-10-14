/**
 * ENH-60 — the source-catalogue family, out of the dispatcher.
 *
 * Three reads that join a *static* catalogue — the source list compiled into
 * `schema.js`, the connector list read from `connectors.registry.json` — against
 * the *dynamic* run history in `source_runs`:
 *
 *   - `sources` reports every public source with its last run and its health;
 *   - `connectors` reports the registry entries with their last run;
 *   - `connectors/status` reports the same registry with its env gate, whether
 *     that gate is on, and the most recent run for that connector.
 *
 * They are one family because they share a failure mode rather than a subject:
 * a catalogue is always non-empty, so a route that joins one against an empty
 * history answers 200 with a full-looking list. The dangerous answer is not an
 * error — it is a row that reads "healthy" because nothing was ever recorded.
 * Every route here therefore resolves absence to a named state (`unknown`,
 * `null`, `enabled: false` with the variable to set) rather than to a default
 * that looks like success.
 *
 * Two properties this module exists to hold:
 *
 *   - **A connector with no gate is always-on, not gated.** Only the three
 *     field-system connectors have an env gate. Inventing a flag for the rest
 *     would let an operator set a variable that nothing reads and be told a
 *     source is off when it is running — so `enabled` is `true` and `gate` is
 *     `null` for a connector the table does not name.
 *   - **The last run is per connector, never the newest run overall.**
 *     Attributing the newest `source_run` to every connector reports a working
 *     DHIS2 as broken because the weather source failed afterwards.
 *
 * `getConnectorRegistry` moved here with them: both routes that read the
 * registry are in this file, and nothing outside it does. Its cache is
 * module-level state, which is the honest place for it now that the module is
 * the only reader — the memo holds a *successful* read and never caches the
 * failure, so a transient read error is not turned into this process's answer.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONNECTORS, ingestionStatus } from '../ingestion.js'
import { logger } from '../observability.js'
import { publicSourceCatalog } from '../schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const registryPath = path.resolve(__dirname, '../../connectors.registry.json')

/**
 * Env gate per connector id, for `GET /api/v1/connectors/status`.
 *
 * Only the three field-system connectors are gated; everything else runs
 * unconditionally, and is reported as enabled rather than being given an
 * invented flag an operator could set and be ignored. A gate listed here but not
 * honoured by the connector would be worse than no gate — it would report
 * "enabled" over a source that then refuses to run — so this table is kept next
 * to the gates it mirrors rather than derived from them.
 */
const GATE_ENV = Object.freeze({
  dhis2: 'LINDELA_LITE_DHIS2_ENABLED',
  kobo: 'LINDELA_LITE_KOBO_ENABLED',
  iot: 'LINDELA_LITE_IOT_ENABLED',
})

/**
 * QUA-01. The connector registry, memoised per process.
 *
 * `connectors.registry.json` is the same file for every server in a process, so
 * the *content* is genuinely process-wide — but the cache was a module global
 * holding a promise-shaped answer, and it cached the failure too: a transient
 * read error, or a file that was not there yet during a deploy, set
 * `connectorRegistry = []` permanently and every later request was told the
 * deployment has no connectors. The catch is a fallback, not a measurement, and
 * caching it turned a one-off miss into the process's answer.
 *
 * So the memo holds only a successful read. A failure returns the empty list to
 * this caller and leaves the cache empty for the next one. `registryFile` is
 * injectable so a test can point at its own fixture without writing into the
 * repository root.
 */
export function createConnectorRegistryCache(registryFile = registryPath) {
  let cached = null
  return async function getConnectorRegistry() {
    if (cached) return cached
    try {
      cached = JSON.parse(await fs.readFile(registryFile, 'utf8'))
    } catch (error) {
      logger.warn('connector_registry_unreadable', {
        message: 'the connector registry could not be read; this request sees no connectors, and the next one retries',
        path: registryFile,
        err: { message: error?.message },
      })
      return []
    }
    return cached
  }
}

const processConnectorRegistry = createConnectorRegistryCache()

async function getConnectorRegistry() {
  return processConnectorRegistry()
}

/**
 * Which catalogue route a request is, or null.
 *
 * All three are reads, so the method is part of the match rather than left to
 * the handler: a POST to a catalogue path is not this family's refusal to make,
 * and falling through lets the surface answer it the way it answers every other
 * wrong verb.
 */
export function matchCatalogueRoute(pathname, method = 'GET') {
  if (method !== 'GET') return null
  if (pathname === '/api/v1/sources') return { kind: 'sources' }
  if (pathname === '/api/v1/connectors') return { kind: 'connectors' }
  if (pathname === '/api/v1/connectors/status') return { kind: 'connectors-status' }
  return null
}

/**
 * The most recent run for one source id, or null.
 *
 * Sorted by `completed_at` with `started_at` as the fallback, because a run that
 * is still in flight has no `completed_at` and would otherwise sort last against
 * every finished run regardless of when it began.
 */
function latestRunFor(runs, sourceId) {
  return runs
    .filter((run) => run.source === sourceId)
    .sort((a, b) => String(b.completed_at || b.started_at || '')
      .localeCompare(String(a.completed_at || a.started_at || '')))[0] || null
}

/**
 * Handle one catalogue route. Returns true when it handled the request.
 */
export async function handleCatalogueRoute(route, { data, req, res, url, jsonResponse }) {
  if (route.kind === 'sources') {
    const health = ingestionStatus(data)
    jsonResponse(res, 200, {
      success: true,
      data: publicSourceCatalog().map((source) => ({
        ...source,
        last_run: data.source_runs.find((run) => run.source === source.id) || null,
        // `unknown`, not `ok`. A source that has never run has no health, and a
        // default of healthy is the one answer an operator cannot act on.
        health: health.find((item) => item.source === source.id)?.status || 'unknown',
        schedule: health.find((item) => item.source === source.id)?.schedule || null,
      })),
    })
    return true
  }

  if (route.kind === 'connectors') {
    const registry = await getConnectorRegistry()
    const sourceRuns = data.source_runs || []
    const withStatus = registry.map((connector) => {
      const lastRun = latestRunFor(sourceRuns, connector.id)
      return {
        ...connector,
        last_run: lastRun || null,
        status: lastRun?.status || 'unknown',
      }
    })
    jsonResponse(res, 200, { success: true, data: withStatus })
    return true
  }

  if (route.kind === 'connectors-status') {
    // Which connectors this deployment can actually run, and why not.
    //
    // The vision claims the platform works from field systems — school
    // attendance, sensor readings, survey responses. An operator looking at a
    // dashboard built on those claims needs to know which of them are switched
    // on, because a panel quietly full of zeroes is indistinguishable from a
    // panel fed by nothing.
    //
    // `enabled` is decided by the gate the connector itself uses, read from the
    // registry rather than hardcoded here — a gate declared in two places is a
    // gate that will be updated in one. Where a connector has no gate it is
    // reported as always-on rather than given an invented flag name.
    const registry = await getConnectorRegistry()
    const entries = Array.isArray(registry) ? registry : []
    const runs = data.source_runs || []
    const rows = entries.map((connector) => {
      const gateVar = GATE_ENV[connector.id] || null
      // A registry entry with no connector is advertised, not runnable. `kobo`
      // and `iot` are exactly this: built, tested, registry-listed and
      // gate-flagged, and absent from `CONNECTORS`, so `getConnector` refuses
      // them as `Unknown source`. Reporting the gate flag here would tell an
      // operator to set a variable that changes nothing — the flag reads as the
      // switch and is not one. `wired: false` says what is true, and the reason
      // names the gap rather than implying a missing credential.
      const wired = Object.hasOwn(CONNECTORS, connector.id)
      const enabled = wired && (gateVar ? process.env[gateVar] === 'on' : true)
      const lastRun = latestRunFor(runs, connector.id)
      return {
        id: connector.id,
        description: connector.description || '',
        gate: gateVar,
        enabled,
        wired,
        // A gated-off connector is a deliberate choice by an operator, so it says
        // what to set rather than just reporting false. An unwired one has no
        // switch to offer, and saying "set X=on" would be a lie about the flag.
        reason: !wired
          ? 'this connector is built and tested but not registered for ingestion; its gate flag has no effect yet'
          : enabled ? null : `set ${gateVar}=on and provide its credentials to enable this source`,
        output: connector.schemas?.output || [],
        last_run: lastRun ? {
          id: lastRun.id,
          status: lastRun.status,
          completed_at: lastRun.completed_at || null,
          records: lastRun.records ?? null,
          error: lastRun.error || null,
        } : null,
      }
    })
    // `count`, not `total`: the registry is a fixed catalogue read from disk, so
    // there is no second page and no limit to report against. `total` beside an
    // array with no `returned`/`limit`/`has_more` is a paging envelope missing
    // four of its five keys, which reads as truncation. The bounded-catalogue
    // routes in this file all say `count` for the same reason.
    jsonResponse(res, 200, {
      success: true,
      count: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      data: rows,
    })
    return true
  }

  return false
}

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The connector registry and the runtime connector map must name the same set,
 * except where the difference is declared here by name.
 *
 * `connectors.registry.json` is what `GET /api/v1/connectors` serves and what
 * `/api/v1/connectors/status` reads to tell an operator which sources this
 * deployment can run and which flag would enable the rest. `CONNECTORS` in
 * `src/ingestion.js` is what `runIngestion` can actually run. They are two
 * lists of one thing, and they had drifted silently:
 *
 *   - `kobo` and `iot` are registry entries with a `GATE_ENV` flag in
 *     `src/routes/catalogue.js`, so the status route reported them as
 *     switchable and printed the variable to set. Setting it changed nothing:
 *     `getConnector('kobo')` throws `Unknown source: kobo`. A capability
 *     advertised and unreachable, served over HTTP to the person deciding what
 *     to turn on — the same defect as a module with no caller, one layer out.
 *
 * The class is this repository's most-repeated: **a set maintained in one place
 * and checked nowhere.** So the comparison is over the two live values, not a
 * grep — a grep for a missing id passes with the id missing, which is how the
 * `OUTPUT_COLLECTIONS` counters named four of six collections for as long as
 * they did.
 *
 * `UNWIRED` is not an escape hatch; it is the declaration. The repo's rule for
 * a built module with no caller is to say so where a reader will see it, and a
 * bare equality assertion would instead fail forever on a difference nobody is
 * allowed to make — a gate that cannot pass is indistinguishable from no gate.
 * So the difference is enumerated, each entry carries the reason it is off, and
 * an entry that becomes wired fails the last case as a stale exemption.
 *
 * Canary: delete `dhis2: dhis2Connector,` from `CONNECTORS` and watch the
 * first case fail naming `dhis2`.
 *
 * **It is empty, and that is the point.** `kobo` and `iot` were its two
 * entries: complete connectors with passing suites, registry-listed and
 * gate-flagged, absent from `CONNECTORS` — so `/connectors/status` offered an
 * operator a variable to set that changed nothing. Both are now registered,
 * which took a schema change rather than a map entry (`field_reports` had no
 * quarantine home and was absent from `OUTPUT_COLLECTIONS`, so a Kobo run
 * would have accumulated its reports into nothing). The map is now the whole
 * registry, and the empty declaration is kept rather than deleted because the
 * third case is what makes an entry fail the moment it stops being true.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Registry entries with no connector in `CONNECTORS`, and why.
 *
 * Empty: every registry entry is now runnable. A future entry goes here only
 * with the reason it is off, and the third case below fails it as a stale
 * exemption the moment it is wired.
 */
const UNWIRED = {}

/** The registry the catalogue route serves, read the way the route reads it. */
function registry() {
  return JSON.parse(readFileSync(path.join(ROOT, 'connectors.registry.json'), 'utf8'))
}

describe('the connector registry and the runtime map name one set', () => {
  it('runs every connector the registry advertises, or declares why not', async () => {
    const { CONNECTORS } = await import('../src/ingestion.js')
    const advertised = registry().map((entry) => entry.id)
    assert.ok(advertised.length > 15,
      `read only ${advertised.length} registry entries — the registry or this reader is wrong, not the map`)

    const unrunnable = advertised
      .filter((id) => !Object.hasOwn(CONNECTORS, id))
      .filter((id) => !Object.hasOwn(UNWIRED, id))
    assert.deepEqual(unrunnable, [],
      `the registry advertises connectors runIngestion cannot run: ${unrunnable.join(', ')}. `
      + 'GET /api/v1/connectors/status offers these as switchable, and the flag it names does nothing. '
      + 'Register the connector, or add it to UNWIRED with the reason it is off.')
  })

  it('advertises every connector the runtime map can run', async () => {
    const { CONNECTORS } = await import('../src/ingestion.js')
    const advertised = new Set(registry().map((entry) => entry.id))

    const undiscoverable = Object.keys(CONNECTORS).filter((id) => !advertised.has(id))
    assert.deepEqual(undiscoverable, [],
      `runIngestion can run connectors the registry does not list: ${undiscoverable.join(', ')}. `
      + 'No route can report their health, gate or last run.')
  })

  it('gives every declared gap a reason, and no entry that is actually wired', async () => {
    // The two ways a declaration rots: an entry with no reason reads as a
    // decision nobody made, and an entry that has since been wired reads as
    // "still off" when the answer has changed — the stale-exemption defect the
    // rate-limit coverage test pins in the same shape.
    const { CONNECTORS } = await import('../src/ingestion.js')
    for (const [id, reason] of Object.entries(UNWIRED)) {
      assert.ok(reason && reason.length > 20, `${id} is declared unwired with no reason`)
      assert.equal(Object.hasOwn(CONNECTORS, id), false,
        `${id} is declared unwired but is in CONNECTORS — remove the stale declaration`)
    }
  })

  it('names a module for every entry, and the module resolves', () => {
    // The registry's `module` field is what a reader follows to the code. A
    // path that resolves to nothing is a pointer to a file that moved, and the
    // registry is the one place a contributor is told where a connector lives.
    const missing = registry()
      .map((entry) => entry.module)
      .filter((module) => !module || !existsSync(path.join(ROOT, module)))
    assert.deepEqual(missing, [], `registry entries point at modules that do not exist: ${missing.join(', ')}`)
  })

  it('advertises the options the connector actually reads, and invents none', async () => {
    // The registry's `schemas.input` is the option surface an operator is told
    // about; the connector's own `spec.schema.requestSchema` is the one it
    // reads. Two lists of one thing, compared by nothing — so
    // `connectors.registry.json` offered `gho_top_years` while
    // `src/connectors/who-gho.js` reads `gho_min_year`, and a reader who set
    // the advertised key changed nothing. Same class as the unwired-connector
    // case above, one layer in: a configuration surface that silently does
    // nothing.
    //
    // Compared against the live `spec` export rather than a grep, for the
    // reason this file's header gives: a grep for a missing key passes with the
    // key missing.
    //
    // `INTERNAL` is not an escape hatch — it is the declaration, and it exists
    // because some request keys are injected by the runner rather than offered
    // to an operator (`now`, `on_watermark_state`, the watermark cursor). Each
    // entry is asserted to still be internal, so one that becomes a real
    // operator option fails here rather than reading as covered.
    const INTERNAL = {
      open_meteo_archive: ['archive_chunk_days', 'now', 'on_watermark_state', 'watermark_state'],
      open_meteo_flood: ['flood_chunk_days', 'now', 'on_watermark_state', 'watermark_state'],
    }

    // Connectors that predate `defineConnector` and export a plain object with
    // no `spec`, so their option surface is not machine-readable and there is
    // nothing to compare the registry against. Declared rather than skipped,
    // and each is asserted to still lack a spec, so one that gains a `spec`
    // fails here instead of reading as covered.
    const NO_SPEC = {
      chirps: 'plain object export, predates defineConnector',
      nasa_firms: 'plain object export, predates defineConnector',
      service_assets: 'upload-backed; option surface is the request body',
      acled_csv: 'upload-backed; option surface is the request body',
      conflict_csv: 'upload-backed; option surface is the request body',
    }

    const drift = []
    for (const entry of registry()) {
      const module = await import(path.join(ROOT, entry.module))
      const spec = module.spec
      if (!spec) {
        if (!Object.hasOwn(NO_SPEC, entry.id)) {
          drift.push(`${entry.id}: no spec export to compare against, and no declared reason`)
        }
        continue
      }
      if (Object.hasOwn(NO_SPEC, entry.id)) {
        drift.push(`${entry.id}: declared as having no spec, but it exports one — remove the stale declaration`)
      }

      const advertised = Object.keys(entry.schemas?.input || {})
      const declared = Object.keys(spec.schema?.requestSchema || {})
      const internal = INTERNAL[entry.id] || []
      for (const key of declared.filter((k) => !internal.includes(k))) {
        if (!advertised.includes(key)) {
          drift.push(`${entry.id}: reads "${key}", the registry does not advertise it`)
        }
      }
      for (const key of advertised) {
        if (!declared.includes(key)) {
          drift.push(`${entry.id}: advertises "${key}", the connector never reads it`)
        }
      }
    }
    assert.deepEqual(drift, [], `connector registry option drift:\n  ${drift.join('\n  ')}`)

    // And every declared-internal key is still real, so the exemption cannot
    // outlive the reason for it.
    for (const [id, keys] of Object.entries(INTERNAL)) {
      const entry = registry().find((e) => e.id === id)
      const spec = (await import(path.join(ROOT, entry.module))).spec
      const declared = Object.keys(spec.schema?.requestSchema || {})
      for (const key of keys) {
        assert.ok(declared.includes(key),
          `${id} declares "${key}" internal but the connector no longer has it — remove the stale exemption`)
      }
    }
  })
})

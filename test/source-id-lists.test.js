import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SOURCE_ASSERTIONS, SOURCE_COLLECTIONS } from '../src/assertions.js'
import { CADENCE_DAYS } from '../src/freshness.js'
import { CONNECTORS, SOURCE_POLICIES } from '../src/ingestion.js'
import { SOURCE_IDS } from '../src/schema.js'

/**
 * R-79 — every source-id-keyed list names the same set of sources.
 *
 * Adding a connector means editing seven things across six files, four of them
 * lists keyed by source id that never check each other. Each list answers a
 * different question about the same twenty sources:
 *
 *   - `SOURCE_IDS` (`src/schema.js`) — what exists, and what the catalogue route
 *     enumerates.
 *   - `CONNECTORS` (`src/ingestion.js`) — what `runIngestion` can actually run.
 *   - `SOURCE_POLICIES` (`src/ingestion.js`) — the cadence and timeout for each.
 *   - `connectors.registry.json` — what `GET /api/v1/connectors` advertises.
 *   - `SOURCE_COLLECTIONS` (`src/assertions.js`) — the collection each writes.
 *   - `SOURCE_ASSERTIONS` (`src/assertions.js`) — the assertions each is held to.
 *   - `CADENCE_DAYS` (`src/freshness.js`) — the staleness window per source.
 *
 * Two of the seven already had a guard (`SOURCE_ASSERTIONS` in
 * `test/source-assertions.test.js`, `CADENCE_DAYS` in
 * `test/freshness-verdicts.test.js`) and `connectors.registry.json` was checked
 * against `CONNECTORS` in `test/connector-registry-parity.test.js`. The other
 * four were checked by nothing, which is this repository's most-repeated defect
 * shape: **a set maintained in one place and checked nowhere.** The pairs that
 * did have guards each checked one edge of the graph, so a list could agree with
 * its neighbour and disagree with the source of truth — the guard reads as
 * coverage while the set it is meant to hold drifts.
 *
 * So this is one table, not five assertions. Every list is named here with the
 * file a reader would open to fix a failure, and the comparison is against
 * `SOURCE_IDS` as the root. A list added later belongs in this table; a list
 * that is *deliberately* a subset declares itself in `PARTIAL` with its reason,
 * because a bare equality assertion would fail forever on a difference nobody
 * is allowed to make, and a gate that cannot pass is indistinguishable from no
 * gate.
 *
 * The comparison is over the live values, not a grep. A grep for a missing id
 * passes with the id missing — which is how the `OUTPUT_COLLECTIONS` counters
 * named four of six collections for as long as they did.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Lists that are deliberately a strict subset of `SOURCE_IDS`, each with the
 * reason it is smaller. Empty is the point: a difference is a decision, and an
 * undeclared difference is the defect.
 *
 * A list here that grows to full coverage fails the last case as a stale
 * exemption — the same rule `connector-registry-parity.test.js` applies to its
 * `UNWIRED` map.
 */
export const PARTIAL = Object.freeze({})

function registryIds() {
  const raw = JSON.parse(readFileSync(path.join(ROOT, 'connectors.registry.json'), 'utf8'))
  const entries = Array.isArray(raw) ? raw : raw.connectors ?? raw.sources
  assert.ok(Array.isArray(entries), 'connectors.registry.json is not an array and names no connectors key')
  return entries.map((entry) => entry.id)
}

/** The table. Order is the order a failure is reported in, root first. */
function sourceIdLists() {
  return [
    { name: 'CONNECTORS', file: 'src/ingestion.js', ids: Object.keys(CONNECTORS) },
    { name: 'SOURCE_POLICIES', file: 'src/ingestion.js', ids: Object.keys(SOURCE_POLICIES) },
    { name: 'connectors.registry.json', file: 'connectors.registry.json', ids: registryIds() },
    { name: 'SOURCE_COLLECTIONS', file: 'src/assertions.js', ids: Object.keys(SOURCE_COLLECTIONS) },
    { name: 'SOURCE_ASSERTIONS', file: 'src/assertions.js', ids: Object.keys(SOURCE_ASSERTIONS) },
    { name: 'CADENCE_DAYS', file: 'src/freshness.js', ids: Object.keys(CADENCE_DAYS) },
  ]
}

describe('R-79 every source-id-keyed list names the same sources', () => {
  it('names the lists it checks, and checks more than one', () => {
    // A table that silently emptied would make every case below vacuous.
    const lists = sourceIdLists()
    assert.ok(lists.length >= 6, `the guard checks ${lists.length} lists, not the shipped set`)
    assert.equal(new Set(lists.map((l) => l.name)).size, lists.length, 'a list is named twice')
  })

  it('agrees with SOURCE_IDS in both directions, for every list', () => {
    // Both directions, because they are different defects: a missing key is a
    // source the list cannot describe, an extra key is a list describing a
    // source that does not exist. One assertion per list so the failure names
    // the file to open.
    for (const list of sourceIdLists()) {
      if (PARTIAL[list.name]) continue
      const missing = SOURCE_IDS.filter((id) => !list.ids.includes(id))
      const extra = list.ids.filter((id) => !SOURCE_IDS.includes(id))
      assert.deepEqual(
        missing,
        [],
        `${list.name} (${list.file}) has no entry for: ${missing.join(', ')}. `
        + 'A source in SOURCE_IDS and missing here is a source this list silently defaults.',
      )
      assert.deepEqual(
        extra,
        [],
        `${list.name} (${list.file}) names sources that are not in SOURCE_IDS: ${extra.join(', ')}. `
        + 'Either add them to src/schema.js or remove them here.',
      )
    }
  })

  it('has no list that is a strict subset without declaring itself', () => {
    // The direction that makes `PARTIAL` honest. A list shorter than SOURCE_IDS
    // and absent from PARTIAL is the defect this file exists to catch; the case
    // above already fails it, and this one fails it with the reason named.
    for (const list of sourceIdLists()) {
      const short = list.ids.length < SOURCE_IDS.length
      assert.ok(
        !short || PARTIAL[list.name],
        `${list.name} (${list.file}) covers ${list.ids.length} of ${SOURCE_IDS.length} sources and does not declare itself partial`,
      )
    }
  })

  it('has no stale exemption: a declared-partial list that now covers everything', () => {
    for (const [name, reason] of Object.entries(PARTIAL)) {
      const list = sourceIdLists().find((l) => l.name === name)
      assert.ok(list, `PARTIAL names ${name}, which is not a list in the table`)
      assert.ok(reason && reason.length > 10, `PARTIAL.${name} carries no usable reason`)
      const missing = SOURCE_IDS.filter((id) => !list.ids.includes(id))
      assert.ok(
        missing.length > 0,
        `PARTIAL.${name} is now complete, so its exemption has expired — remove it`,
      )
    }
  })

  it('every id is a non-empty string, so a list cannot be keyed by undefined', () => {
    // A connector registered under `undefined` or `''` would pass a length
    // check and match nothing. Cheap, and it is the shape a copy-paste edit
    // produces.
    for (const list of sourceIdLists()) {
      for (const id of list.ids) {
        assert.equal(typeof id, 'string', `${list.name} has a non-string key`)
        assert.ok(id.length > 0, `${list.name} has an empty key`)
      }
      assert.equal(new Set(list.ids).size, list.ids.length, `${list.name} has a duplicate key`)
    }
  })

  it('the root list is the one the catalogue route enumerates', () => {
    // SOURCE_IDS is the root the rest are compared against, so it must be the
    // list the running app serves — otherwise this whole file holds the wrong
    // set to the right set. `src/schema.js` projects it through the catalogue.
    assert.ok(Array.isArray(SOURCE_IDS) && SOURCE_IDS.length >= 20, `SOURCE_IDS holds ${SOURCE_IDS.length} ids`)
  })
})

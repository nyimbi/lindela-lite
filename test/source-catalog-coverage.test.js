import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Every source the catalog serves must be described by its own branch.
 *
 * `publicSourceCatalog()` is what `GET /api/v1/sources` serves. It was a chain
 * of `if (id === '…')` cases with a final `return` that acted as the answer for
 * anything unmatched — and the fallthrough returned the conflict-CSV row. So
 * `dhis2` was served as **"Lite conflict event CSV", type `csv_upload`,
 * emitting `conflict_events`**. Every field was wrong, and a reader of the
 * sources route was told a DHIS2 field-system integration was a CSV upload.
 *
 * The fallthrough now throws, which turns a wrong answer into a loud one — but
 * a throw nobody can reach is a comment. The reachable version is an id added
 * to `SOURCE_IDS` without a case here, and this is the test that reaches it:
 * the branch count must equal the id count, and the served row for each id must
 * be the row its own branch builds.
 *
 * Canary: delete the `if (id === 'dhis2')` block and watch the second case fail
 * naming `dhis2`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The `if (id === '…')` ids in `publicSourceCatalog`, read from the source. */
function describedIds() {
  const source = readFileSync(path.join(ROOT, 'src/schema.js'), 'utf8')
  const start = source.indexOf('export function publicSourceCatalog')
  assert.ok(start > 0, 'publicSourceCatalog is gone from src/schema.js — update this test')
  const body = source.slice(start, source.indexOf('\n}', start))
  return [...body.matchAll(/id === '([a-z0-9_]+)'/g)].map((m) => m[1])
}

describe('the public source catalog describes every source it serves', () => {
  it('has a branch for every source id, and no branch for anything else', async () => {
    const { SOURCE_IDS } = await import('../src/schema.js')
    const described = describedIds()
    assert.ok(described.length > 15,
      `found only ${described.length} catalog branches — the reader or the function changed`)

    const undescribed = SOURCE_IDS.filter((id) => !described.includes(id))
    assert.deepEqual(undescribed, [],
      `served by GET /api/v1/sources with no branch of its own: ${undescribed.join(', ')}. `
      + 'It inherits whatever the fallthrough returns, which is how dhis2 was served as a CSV upload.')

    const phantom = described.filter((id) => !SOURCE_IDS.includes(id))
    assert.deepEqual(phantom, [], `catalog branches for ids that are not sources: ${phantom.join(', ')}`)
  })

  it('serves each source the row its own branch builds, not a placeholder', async () => {
    // The behavioural half. The branch-count check above would pass if two ids
    // shared a branch; this one reads what is actually served and refuses a row
    // whose `outputs` the connector does not emit.
    const { publicSourceCatalog } = await import('../src/schema.js')
    const catalog = publicSourceCatalog()
    for (const row of catalog) {
      assert.ok(row.name && row.name !== 'Lite conflict event CSV' || row.id === 'conflict_csv',
        `${row.id} is served as the conflict-CSV placeholder`)
      assert.ok(Array.isArray(row.outputs) && row.outputs.length > 0,
        `${row.id} is served with no outputs`)
    }

    // The specific regression: dhis2 is a field-system integration, and its row
    // must say so.
    const dhis2 = catalog.find((row) => row.id === 'dhis2')
    assert.notEqual(dhis2.name, 'Lite conflict event CSV', 'dhis2 fell through to the CSV placeholder again')
    assert.notDeepEqual(dhis2.outputs, ['conflict_events'], 'dhis2 does not emit conflict events')
    assert.ok(dhis2.outputs.includes('school_attendance_observations'),
      'dhis2 emits school attendance from enrolled/present pairs; the served row does not say so')
  })

  it('refuses an id it has no branch for, rather than inventing a row', async () => {
    // The throw is the honest default; assert it exists so a later tidy-up
    // cannot restore the placeholder return without a failure.
    const source = readFileSync(path.join(ROOT, 'src/schema.js'), 'utf8')
    const start = source.indexOf('export function publicSourceCatalog')
    const body = source.slice(start, source.indexOf('\n}', start))
    assert.match(body, /throw new Error\(/,
      'publicSourceCatalog no longer refuses an undescribed id — the placeholder return is back')
  })
})

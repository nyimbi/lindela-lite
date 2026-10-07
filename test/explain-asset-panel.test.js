import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * The asset-explain panel, reviewed after an operator clicked a service-asset
 * point on the map.
 *
 * What they were shown was a refusal with a false claim: "This record type is
 * not served by /api/v1/explain." The endpoint is served for every collection
 * by name (`?kind=`), and the server's measured manifest had simply never
 * widened the read past its first two kinds. The panel had also never fetched:
 * the record the map click carries has a `source` field (`service_assets`), a
 * collection name, and the mapping ignored the field. So an asset was declared
 * untraceable in one breath and no request was made to check.
 *
 * The reworked panel derives the kind from `type` when the record has one and
 * from `source` when the source *is* a collection name — upstream ingestor ids
 * like `gdacs` are not collections and are never fetched — and the four
 * different reasons provenance can be missing each say themselves:
 *
 *   1. no kind derivable, so nothing was fetched;
 *   2. the fetch failed (network);
 *   3. the endpoint answered 404;
 *   4. the endpoint answered, and the record genuinely names no run — the
 *      server's own `known: false`, rendered as its note.
 */

const ROOT = new URL('..', import.meta.url).pathname

async function loadWireExplain() {
  // The module imports root-absolute browser specifiers (`/shared/…`), which
  // only the running dashboard resolves. Rewrite them to file paths in a
  // temporary copy; nothing else is touched.
  const source = readFileSync(new URL('../public/workflow/wire-explain.js', import.meta.url), 'utf8')
  const shared = (name) => pathToFileURL(path.join(ROOT, 'public', 'shared', name)).href
  const rewritten = source
    .replace("from '/shared/viz-explain.js'", `from '${shared('viz-explain.js')}'`)
    .replace("from '/shared/viz-uncertainty.js'", `from '${shared('viz-uncertainty.js')}'`)
    .replace("from '/shared/fmt.js'", `from '${shared('fmt.js')}'`)
  const dir = mkdtempSync(path.join(tmpdir(), 'wire-explain-'))
  const file = path.join(dir, 'wire-explain.js')
  writeFileSync(file, rewritten)
  try {
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ASSET = {
  id: 'asset_fd863cdf7be96cf0',
  source: 'service_assets',
  name: 'Bor Model Primary',
  service_type: 'school',
  status: 'operational',
}

describe('the asset-explain panel', () => {
  it('fetches /api/v1/explain for a record whose source names the collection', async () => {
    const { renderExplain } = await loadWireExplain()
    let fetched = null
    const load = async (url) => {
      fetched = url
      return {
        success: true,
        record: ASSET,
        provenance: {
          known: false, source_run: null, lineage: [],
          note: 'This record names no source run, so its origin cannot be traced from the store.',
        },
      }
    }
    const host = { innerHTML: '' }
    await renderExplain(host, ASSET, { load })

    assert.equal(fetched, `/api/v1/explain/${encodeURIComponent(ASSET.id)}?kind=service_assets`,
      'a record whose source is a collection name is fetched, not declared untraceable')
    assert.doesNotMatch(host.innerHTML, /not served by \/api\/v1\/explain/,
      'a claim the endpoint never warranted must not be rendered')
    assert.match(host.innerHTML, /names no source run/,
      "the server's own known:false note is shown rather than a refusal")
  })

  it('shows real provenance when the store has it', async () => {
    const { renderExplain } = await loadWireExplain()
    const load = async () => ({
      success: true,
      record: ASSET,
      provenance: {
        known: true,
        source_run: { id: 'run_39c6ee2af93bfcf0', source_id: 'gdacs', started_at: '2026-10-07T07:00:00Z' },
        lineage: [{ field: 'records', source: 'gdacs', recorded_at: '2026-10-07T07:00:01Z' }],
        known: true,
      },
    })
    const host = { innerHTML: '' }
    await renderExplain(host, ASSET, { load })
    assert.match(host.innerHTML, /run_39c6ee2af93bfcf0/)
    assert.match(host.innerHTML, /Lineage behind this record/)
  })

  it('does not fetch, and says so, when the source is an upstream ingestor id', async () => {
    const { renderExplain } = await loadWireExplain()
    let fetched = null
    const load = async (url) => { fetched = url; return { success: true } }
    const host = { innerHTML: '' }
    await renderExplain(host, { id: 'hz_1', source: 'gdacs', event_type: 'volcano' }, { load })
    assert.equal(fetched, null, 'a kind that is not a collection is not fetched')
    assert.match(host.innerHTML, /Nothing was fetched/)
    assert.match(host.innerHTML, /gdacs/, 'the refusal names the value it could not map')
  })

  it('says the endpoint is unreachable rather than that the type is untraceable', async () => {
    const { renderExplain } = await loadWireExplain()
    const host = { innerHTML: '' }
    await renderExplain(host, { ...ASSET }, { load: async () => { throw new Error('offline') } })
    assert.match(host.innerHTML, /could not be reached/)
  })

  it('says the endpoint missed the record rather than that the type is untraceable', async () => {
    const { renderExplain } = await loadWireExplain()
    const host = { innerHTML: '' }
    await renderExplain(host, { ...ASSET }, {
      load: async () => ({ success: false, error: 'No service_assets record with id x' }),
    })
    assert.match(host.innerHTML, /answered 404/)
  })
})
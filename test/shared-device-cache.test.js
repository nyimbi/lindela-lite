import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * R-10 — the offline cache did not vary on the token, so a shared device served
 * one organisation's data to another.
 *
 * The scenario is a district phone, which is how the hardware is actually used:
 * one handset, several health workers, no logout between them. The service
 * worker caches API responses network-first and serves them when the network
 * fails, keyed on the request — and the request's *headers* are not part of a
 * Cache API key unless the response says `Vary`. Nothing said `Vary`, so
 *
 *   worker A fetches /api/v1/records?district=Kilimanjaro with A's key
 *   → stored, keyed on the URL
 *   the phone is handed to worker B, who goes offline
 *   → B requests the same URL with B's key, the network fails
 *   → the worker serves A's cached districts, with a 7-day TTL on the detail
 *     bucket and no marker that anything is wrong
 *
 * B sees another organisation's field reports and has no way to tell. That is
 * the whole defect, and it needed one response header to close: the Cache API
 * honours `Vary` on `match()` and `put()`, so naming the credential header means
 * a cache hit requires the same credential that stored it.
 *
 * The fix is asserted over HTTP rather than by reading the source, because the
 * property that matters is what a caching intermediary does with the response —
 * and this is the only place the chain's behaviour can be observed without a
 * browser. The Cache API's own semantics of honouring Vary are the platform's
 * contract, not ours to re-test.
 */

async function withServer(fn, { tokens } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r10-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  const saved = process.env.LINDELA_LITE_TOKENS
  if (tokens) process.env.LINDELA_LITE_TOKENS = tokens
  try {
    return await fn(base)
  } finally {
    listener.close()
    if (saved === undefined) delete process.env.LINDELA_LITE_TOKENS
    else process.env.LINDELA_LITE_TOKENS = saved
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// Two tokens, two partner organisations, one shared handset. The format is the
// one `parseTokens` accepts: an array of {token, scopes, partner_org}.
const CREDS = JSON.stringify([
  { token: 'org-a-key', scopes: ['*'], partner_org: 'org-a' },
  { token: 'org-b-key', scopes: ['*'], partner_org: 'org-b' },
])

describe('R-10 — an API response varies on the credential that fetched it', () => {
  it('every JSON response names both accepted credential headers', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/incidents?limit=1`, {
        headers: { 'x-api-key': 'org-a-key' },
      })
      assert.equal(res.status, 200)
      const vary = String(res.headers.get('vary') || '')
      assert.match(vary, /authorization/i,
        `Vary is "${vary}"; without authorization a proxy between the phone and ` +
        'the server can serve one caller\'s body to another')
      assert.match(vary, /x-api-key/i,
        `Vary is "${vary}"; the console authenticates with x-api-key, so a Vary ` +
        'naming only authorization protects the path nobody uses')
    }, { tokens: CREDS })
  })

  it('the 304 that stands in for a 200 carries it too', async () => {
    // The conditional-GET branch writes its own headers and returns early. A
    // Vary added to the 200 and forgotten on the 304 leaves the leak with an
    // extra step: the cache stores the revalidation under no vary condition.
    await withServer(async (base) => {
      const first = await fetch(`${base}/api/v1/incidents?limit=1`, {
        headers: { 'x-api-key': 'org-a-key' },
      })
      await first.text()
      const etag = first.headers.get('etag')
      assert.ok(etag, 'the first response should carry an ETag for this to be meaningful')

      const second = await fetch(`${base}/api/v1/incidents?limit=1`, {
        headers: { 'x-api-key': 'org-a-key', 'if-none-match': etag },
      })
      assert.equal(second.status, 304)
      assert.match(String(second.headers.get('vary') || ''), /x-api-key/i,
        'the 304 must carry the same Vary as the 200 it stands in for')
    }, { tokens: CREDS })
  })

  it('a response nobody could cache does not claim it varies', async () => {
    // `Vary` on a `no-store` response is harmless, and naming a header that was
    // never sent is not a claim of anything: this asserts only that the header
    // is present on the paths that are cacheable, so removing it later breaks a
    // test rather than a deployment.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/incidents?limit=1`, {
        headers: { 'x-api-key': 'org-a-key' },
      })
      assert.equal(res.headers.get('cache-control'), 'no-cache',
        'this path is revalidatable, which is exactly why Vary matters on it')
    }, { tokens: CREDS })
  })
})

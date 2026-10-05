import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { publicProperties } from '../src/utils.js'
import { STAC_COLLECTIONS } from '../src/stac.js'

/**
 * R-13 — `/stac/*` and `/ogc/*` sat outside every gate, and rendered whatever
 * record they were handed.
 *
 * Two defects, and the second is the one that outlives the first.
 *
 * The first is dispatch order: the routes returned from the request handler
 * before `handleApi` and before the auth gate, so with tokens configured the
 * catalogue was still readable by anyone who could reach the port. No field
 * reports reach it today — the three collections are hazards, service assets
 * and risk scores — but the service assets *are* clinic, water-point and road
 * locations, and a catalogue of those is a map of where care is.
 *
 * The second is the renderer: `stacItem` and `toGeoJson` both spread the whole
 * record into `properties`, minus latitude and longitude. The day a
 * PII-bearing collection is added to `STAC_COLLECTIONS`, its reporter hash and
 * its free-text message go out to every catalogue client, with no test failing
 * and no field name changed. That is a defect waiting for a feature, which is
 * the kind that ships.
 */

const CREDS = JSON.stringify([
  { token: 'stac-key-a', scopes: ['*'], partner_org: 'org-a' },
  { token: 'stac-key-b', scopes: ['*'], partner_org: 'org-b' },
])

async function withServer(fn, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r13-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === '') delete process.env[k]
    else process.env[k] = v
  }
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('R-13 — the spatial catalogue answers to the same gate as the API', () => {
  for (const route of ['/stac/catalog.json', '/stac/collections/hazard-events', '/ogc/collections/hazard-events/items']) {
    it(`${route} needs a token when auth is configured`, async () => {
      await withServer(async (base) => {
        const anonymous = await fetch(`${base}${route}`)
        assert.equal(anonymous.status, 401,
          'this route dispatches before the auth gate, so clinic and water-point ' +
          'locations are readable by anyone who can reach the port')
        const authed = await fetch(`${base}${route}`, { headers: { 'x-api-key': 'stac-key-a' } })
        assert.equal(authed.status, 200,
          'a valid token must still reach the catalogue; the gate is a control, not a removal')
      }, { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' })
    })
  }

  it('an operator can still publish an open catalogue, by configuration', async () => {
    // Closing it by default is a default, not a decision. The opt-in has to work
    // or the fix is "remove the interoperability surface".
    await withServer(async (base) => {
      const res = await fetch(`${base}/stac/catalog.json`)
      assert.equal(res.status, 200,
        'LINDELA_LITE_PUBLIC_PATHS is how an operator says the catalogue is public')
    }, { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_PUBLIC_PATHS: '/stac' })
  })

  it('unauthenticated local mode is unaffected', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/stac/catalog.json`)
      assert.equal(res.status, 200)
    }, { LINDELA_LITE_TOKENS: '', LINDELA_LITE_API_KEY: '' })
  })
})

describe('R-13 — a catalogue item cannot carry a person', () => {
  it('drops the fields that identify someone or a secret', () => {
    const record = {
      id: 'asset-1',
      name: 'Kilimanjaro District Hospital',
      service_type: 'hospital',
      latitude: -3.4,
      longitude: 37.3,
      reporter_urn_hash: 'sha256:9f2c…',
      Reporter_Name: 'A. Njoroge',
      message: 'water point dry since March',
      phone: '+255700000000',
      api_key: 'live-key-should-never-be-here',
    }
    const out = publicProperties(record)
    for (const gone of ['reporter_urn_hash', 'Reporter_Name', 'message', 'phone', 'api_key',
      'latitude', 'longitude']) {
      assert.ok(!(gone in out), `${gone} survived into catalogue properties`)
    }
    // And the fields a catalogue exists to publish are still there: a redaction
    // list that ate `name` would be a different defect.
    for (const kept of ['id', 'name', 'service_type']) {
      assert.equal(out[kept], record[kept], `${kept} was redacted and should not be`)
    }
  })

  it('a served item carries no reporter field even when the record has one', async () => {
    // End to end rather than on the helper, so a future renderer that forgets to
    // use it fails here.
    await withServer(async (base, store) => {
      await store.merge({
        service_assets: [{
          id: 'asset-r13',
          type: 'service_asset',
          name: 'Kibera clinic',
          service_type: 'clinic',
          status: 'operational',
          latitude: -1.3,
          longitude: 36.8,
          reporter_urn_hash: 'sha256:deadbeef',
          message: 'clinic has no water',
        }],
      })
      const res = await fetch(`${base}/ogc/collections/service-assets/items`, {
        headers: { 'x-api-key': 'stac-key-a' },
      })
      assert.equal(res.status, 200)
      const body = await res.text()
      assert.ok(!body.includes('reporter_urn_hash') && !body.includes('sha256:deadbeef'),
        'the reporter hash reached a spatial catalogue response')
      assert.ok(!body.includes('clinic has no water'),
        'free text reached a spatial catalogue response')
      assert.ok(body.includes('Kibera clinic'), 'and the record itself must still be published')
    }, { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' })
  })

  it('every collection the catalog advertises is one the gate covers', () => {
    // The gate is on the path prefix, so a collection cannot escape it. This
    // asserts the weaker thing that actually bit: that the list is not empty and
    // each entry resolves a collection by id, so a future entry cannot be a
    // second, differently-routed path.
    assert.ok(STAC_COLLECTIONS.length > 0, 'the catalog advertises nothing, so the gate is untested in practice')
    for (const entry of STAC_COLLECTIONS) {
      assert.equal(typeof entry.resolve, 'function', `${entry.id} has no resolver`)
    }
  })
})

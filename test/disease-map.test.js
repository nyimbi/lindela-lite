import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * `?map=1` returns exactly what the map layer can draw — placeable records
 * only, honesty fields included — and the default route still pages the
 * collection the operator reads, unplaced records included.
 */
describe('disease-observations map endpoint', () => {
  async function withServer(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-disease-map-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      disease_observations: [
        {
          id: 'disease_subnational_1',
          source: 'reliefweb_epidemics',
          source_id: 'EP-2026-000233-KEN',
          disease: 'meningitis',
          country: 'KE',
          latitude: 8.767,
          longitude: 27.4,
          location_name: 'Aweil',
          granularity: 'subnational',
          cases: 300,
          deaths: null,
          observed_at: '2026-08-20T00:00:00.000Z',
          source_url: 'https://reliefweb.int/disaster/ep-2026-000233-ken',
        },
        {
          id: 'disease_national_1',
          source: 'reliefweb_epidemics',
          source_id: 'EP-2026-000214-SOM',
          disease: 'yellow fever',
          country: 'SO',
          latitude: 5.1521,
          longitude: 46.1996,
          location_name: 'Somalia',
          granularity: 'national',
          cases: null,
          deaths: null,
          observed_at: '2026-07-11T00:00:00.000Z',
          source_url: 'https://reliefweb.int/disaster/ep-2026-000214-som',
        },
        {
          // Unplaceable: present in the listing, absent from the map.
          id: 'disease_unknown_1',
          source: 'reliefweb_epidemics',
          source_id: 'EP-2026-000199-TCD',
          disease: 'plague',
          country: 'TCD',
          latitude: null,
          longitude: null,
          location_name: 'Chad',
          granularity: 'unknown',
          cases: null,
          deaths: null,
          observed_at: '2026-06-01T00:00:00.000Z',
          source_url: 'https://reliefweb.int/disaster/ep-2026-000199-tcd',
        },
        {
          // who_gho context rows (coordinates null by construction) must not
          // leak into the map either.
          id: 'disease_who_gho_1',
          source: 'who_gho',
          indicator_code: 'CHOLERA_0000000001',
          country: 'Kenya',
          latitude: null,
          longitude: null,
          observed_at: '2025-01-01T00:00:00.000Z',
          value: 101,
        },
      ],
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      return await fn(base)
    } finally {
      listener.close()
    }
  }

  it('map=1 returns only placeable records with the honesty fields', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/disease-observations?map=1`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.note, 'Subnational coordinates where available; national centroid otherwise.')
      assert.equal(body.data.length, 2, 'the unplaced and the who_gho rows are not on the map')

      const sub = body.data.find((r) => r.granularity === 'subnational')
      assert.ok(sub)
      assert.equal(sub.id, 'disease_subnational_1')
      for (const key of ['id', 'source', 'disease', 'country', 'latitude', 'longitude', 'location_name', 'granularity', 'cases', 'deaths', 'observed_at', 'source_url']) {
        assert.ok(key in sub, `map payload carries ${key}`)
      }
      assert.equal(sub.latitude, 8.767)
      assert.equal(sub.cases, 300)

      assert.ok(body.data.every((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude)))
      assert.ok(body.as_of >= '2026-08-20', `as_of is the latest observed_at, got ${body.as_of}`)
    })
  })

  it('the default route still pages the full collection, unplaced records included', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/disease-observations`)
      assert.equal(res.status, 200)
      const body = await res.json()
      // The paged route's data holds the matched records (matchedAndPage);
      // all four fixtures carry the collection's records.
      assert.equal(body.data.length, 4)
      assert.ok(body.summary, 'the series summary still rides along')
    })
  })
})
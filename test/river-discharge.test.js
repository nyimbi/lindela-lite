import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

describe('GET /api/v1/river-discharge', () => {
  let dir
  let server
  let listener
  let baseUrl

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-river-discharge-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      climate_observations: [
        {
          id: 'cd_1',
          source: 'open_meteo_flood',
          region_name: 'Turkana',
          latitude: 2.5,
          longitude: 36.0,
          daily: [
            { date: '2026-10-05', river_discharge_m3s: 30 },
            { date: '2026-10-06', river_discharge_m3s: 75 },
          ],
          metadata: { model_limit: 49.5 },
        },
        {
          id: 'cd_2',
          source: 'open_meteo_flood',
          region_name: 'Mandera',
          latitude: 3.9,
          longitude: 41.8,
          daily: [
            { date: '2026-10-06', river_discharge_m3s: 250 },
          ],
          metadata: {},
        },
        {
          id: 'cd_3',
          source: 'open_meteo_flood',
          region_name: 'Mandera',
          latitude: 3.9,
          longitude: 41.8,
          daily: [
            { date: '2026-10-06', river_discharge_m3s: 180 },
          ],
        },
        {
          id: 'cd_4',
          source: 'open_meteo_archive',
          region_name: 'Bor',
          latitude: 6.2,
          longitude: 31.5,
          daily: [{ date: '2026-10-06', river_discharge_m3s: 999 }],
        },
        {
          id: 'cd_5',
          source: 'open_meteo_flood',
          region_name: 'Aweil',
          latitude: 8.7,
          longitude: 27.3,
          daily: [
            { date: '2026-10-06', river_discharge_m3s: null },
          ],
        },
      ],
    })
    server = createServer({ store })
    listener = server.listen(0)
    baseUrl = `http://localhost:${listener.address().port}`
  })

  after(async () => {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns the latest non-null discharge per open_meteo_flood region', async () => {
    const res = await fetch(`${baseUrl}/api/v1/river-discharge`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.equal(body.data.length, 2, 'only two regions have usable open_meteo_flood values')
    const byRegion = Object.fromEntries(body.data.map((r) => [r.region_name, r]))
    assert.equal(byRegion.Turkana.river_discharge_m3s, 75)
    assert.equal(byRegion.Turkana.band, 'moderate')
    assert.equal(byRegion.Turkana.model_limit, 49.5)
    assert.equal(byRegion.Mandera.river_discharge_m3s, 250, 'the highest value for the latest date wins')
    assert.equal(byRegion.Mandera.band, 'high')
    assert.equal(body.as_of, '2026-10-06')
    assert.match(body.note, /gauged/i)
  })
})

describe('GET /api/v1/river-discharge with no data', () => {
  it('returns an explicit empty response', async () => {
    const dir_ = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-river-empty-'))
    const store = new JsonStore(path.join(dir_, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/river-discharge`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.success, true)
      assert.deepEqual(body.data, [])
      assert.equal(body.as_of, null)
      assert.match(body.note, /gauged/i)
    } finally {
      listener.close()
      await fs.rm(dir_, { recursive: true, force: true })
    }
  })
})

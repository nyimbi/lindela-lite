#!/usr/bin/env node
/**
 * IoT gateway connector tests — no network, global fetch stubbed and restored.
 *
 * Pins:
 *  - gated off refuses in errors and returns nothing;
 *  - a JSON array of readings normalizes into iot_observations with per-type
 *    unit defaults and source iot_gateway;
 *  - the bearer token is sent only when configured;
 *  - one reading with an unknown sensor_type lands in errors while the rest
 *    of the batch still returns;
 *  - non-array payloads and HTTP errors are recorded, not thrown.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { spec as iotSpec, iotConnector } from '../src/connectors/iot.js'
import { validateConnector } from '../src/connectors/spec.js'

const ENABLED = { LINDELA_LITE_IOT_ENABLED: 'on' }

function withEnv(overrides, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

const READINGS = [
  { sensor_id: 'fridge_kakuma_1', sensor_type: 'cold_chain', district: 'turkana', lat: 3.31, lon: 35.12, observed_at: '2026-10-08T06:00:00Z', value: 9.4, battery_pct: 87 },
  { sensor_id: 'gauge_nzoia_3', sensor_type: 'flood_gauge', district: 'busia', observed_at: '2026-10-08T06:05:00Z', value: 2.31 },
  { sensor_id: 'smoke_detector_9', sensor_type: 'smoke', observed_at: '2026-10-08T06:06:00Z', value: 1 },
]

describe('iot connector', () => {
  it('spec validates and keeps its id', () => {
    assert.deepEqual(validateConnector(iotSpec), [])
    assert.equal(iotConnector.id, 'iot')
  })

  it('gated off: refuses in errors and returns nothing', async () => {
    const stub = stubFetch(() => { throw new Error('fetch must not be called when gated off') })
    try {
      await withEnv({}, async () => {
        const out = await iotConnector.ingest({ base_url: 'https://gw.example.org/readings' })
        assert.deepEqual(out.iot_observations, [])
        assert.match(out.errors[0], /not enabled/)
        assert.match(out.errors[0], /base_url/)
      })
      await withEnv(ENABLED, async () => {
        const out = await iotConnector.ingest({})
        assert.match(out.errors[0], /not enabled/)
      })
    } finally {
      stub.restore()
    }
  })

  it('normalizes readings with per-type unit defaults and source iot_gateway', async () => {
    const stub = stubFetch(() => jsonResponse(READINGS.slice(0, 2)))
    try {
      await withEnv(ENABLED, async () => {
        const out = await iotConnector.ingest({ base_url: 'https://gw.example.org/readings' })
        assert.equal(out.iot_observations.length, 2, JSON.stringify(out.errors))
        assert.equal(out.errors.length, 0)
        const [fridge, gauge] = out.iot_observations
        assert.equal(fridge.sensor_id, 'fridge_kakuma_1')
        assert.equal(fridge.sensor_type, 'cold_chain')
        assert.equal(fridge.unit, '°C')
        assert.equal(fridge.value, 9.4)
        assert.equal(fridge.source, 'iot_gateway')
        assert.equal(fridge.battery_pct, 87)
        assert.equal(gauge.sensor_type, 'flood_gauge')
        assert.equal(gauge.unit, 'm')
        assert.equal(gauge.district, 'busia')
      })
    } finally {
      stub.restore()
    }
  })

  it('sends the bearer token only when configured', async () => {
    const stub = stubFetch(() => jsonResponse([]))
    try {
      await withEnv(ENABLED, async () => {
        await iotConnector.ingest({ base_url: 'https://gw.example.org/readings', api_token: 'gw-token' })
        assert.equal(stub.calls[0].init.headers.authorization, 'Bearer gw-token')
        await iotConnector.ingest({ base_url: 'https://gw.example.org/readings' })
        assert.equal(stub.calls[1].init.headers.authorization, undefined)
      })
    } finally {
      stub.restore()
    }
  })

  it('puts an invalid reading in errors and still returns the rest of the batch', async () => {
    const stub = stubFetch(() => jsonResponse(READINGS))
    try {
      await withEnv(ENABLED, async () => {
        const out = await iotConnector.ingest({ base_url: 'https://gw.example.org/readings' })
        assert.equal(out.iot_observations.length, 2, 'the two valid readings survive')
        assert.equal(out.errors.length, 1)
        assert.match(out.errors[0], /smoke_detector_9/)
        assert.match(out.errors[0], /sensor_type/)
        assert.ok(!out.iot_observations.some((r) => r.sensor_id === 'smoke_detector_9'))
      })
    } finally {
      stub.restore()
    }
  })

  it('records a non-array payload and HTTP errors honestly', async () => {
    const notArray = stubFetch(() => jsonResponse({ readings: [] }))
    try {
      await withEnv(ENABLED, async () => {
        const out = await iotConnector.ingest({ base_url: 'https://gw.example.org/readings' })
        assert.ok(out.errors.some((e) => /not a JSON array/.test(e)), `expected the shape refusal, got: ${out.errors.join('; ')}`)
        assert.deepEqual(out.iot_observations, [])
      })
    } finally {
      notArray.restore()
    }
    const failing = stubFetch(() => jsonResponse('upstream down', { status: 502 }))
    try {
      await withEnv(ENABLED, async () => {
        const out = await iotConnector.ingest({ base_url: 'https://gw.example.org/readings' })
        assert.ok(out.errors.some((e) => /502/.test(e)), `expected the 502 to be recorded, got: ${out.errors.join('; ')}`)
      })
    } finally {
      failing.restore()
    }
  })
})

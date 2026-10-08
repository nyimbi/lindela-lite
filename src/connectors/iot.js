import { normalizeIotObservation } from '../field-signals.js'
import { defineConnector } from './spec.js'

/**
 * Generic IoT sensor gateway pull.
 *
 * The gateway contract is one GET that answers a JSON array of readings:
 *
 *   { sensor_id, sensor_type, district?, lat?, lon?, observed_at, value,
 *     unit?, battery_pct? }
 *
 * Every reading passes through normalizeIotObservation, which owns the
 * discipline this connector must not re-implement: closed sensor-type enum,
 * numeric value, ISO observed_at, per-type unit defaults. A reading that
 * fails validation is recorded in errors and skipped — one dead sensor with a
 * typo in its type must not take down the other forty readings in the same
 * batch, and it must not be silently dropped either, because a flood gauge
 * that stopped reporting is exactly the kind of absence an operator needs to
 * see.
 *
 * The env gate plus base_url requirement matches the other credential-bearing
 * connectors: gated off, it says so in errors and returns nothing. The token
 * is optional because many field gateways authenticate by network location
 * or mTLS rather than a bearer header; sending none when none is configured
 * lets the server answer honestly.
 */

const DEFAULT_TIMEOUT_MS = 20000

async function fetchReadings(url, apiToken, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { accept: 'application/json' }
    if (apiToken) headers.authorization = `Bearer ${apiToken}`
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) {
      throw Object.assign(new Error(`IoT gateway HTTP ${response.status}`), { status: response.status })
    }
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error('IoT gateway response was not valid JSON')
    }
    if (!Array.isArray(payload)) {
      throw new Error('IoT gateway response was not a JSON array of readings')
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

async function iotIngest(request = {}) {
  const iot_observations = []
  const errors = []

  if (process.env.LINDELA_LITE_IOT_ENABLED !== 'on' || !request.base_url) {
    errors.push(
      'IoT gateway not enabled: set LINDELA_LITE_IOT_ENABLED=on and provide request.base_url '
      + '(the gateway endpoint returning a JSON array of readings). No records are returned while gated off.',
    )
    return { iot_observations, errors }
  }

  let readings
  try {
    readings = await fetchReadings(String(request.base_url), request.api_token || null, request.timeout_ms || DEFAULT_TIMEOUT_MS)
  } catch (error) {
    errors.push(`iot_gateway: ${error.message}`)
    return { iot_observations, errors }
  }

  for (const reading of readings) {
    const label = reading && reading.sensor_id !== undefined ? reading.sensor_id : 'unknown sensor'
    try {
      iot_observations.push(normalizeIotObservation({ ...(reading || {}), source: 'iot_gateway' }))
    } catch (error) {
      errors.push(`iot_gateway: reading from ${label} skipped: ${error.message}`)
    }
  }

  return { iot_observations, errors }
}

export const iotConnector = defineConnector({
  id: 'iot',
  description: 'Generic IoT sensor gateway pull: one GET returning a JSON array of readings (sensor_id, sensor_type, district, lat/lon, observed_at, value, unit, battery_pct). Each reading is normalized with the closed sensor-type enum and per-type unit defaults; a reading that fails validation lands in errors and the rest of the batch still returns. Runs only when LINDELA_LITE_IOT_ENABLED=on and request.base_url is set; the bearer token is sent only when configured.',
  schema: {
    requestSchema: {
      base_url: 'string — gateway endpoint returning a JSON array of readings',
      api_token: 'string — optional bearer token',
      timeout_ms: 'number (default 20000)',
    },
    outputSchema: {
      iot_observations: 'array of normalized sensor readings',
    },
  },
  // No rateLimit declaration: one request per run, and this connector uses
  // plain fetch rather than fetchWithRetry — a declared number would be a
  // limit nothing reads (the R-11 defect class test/rate-limit.test.js pins).
  defaults: {
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  ingest: iotIngest,
})

export const spec = iotConnector

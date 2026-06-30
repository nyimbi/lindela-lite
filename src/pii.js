import fs from 'node:fs/promises'
import crypto from 'node:crypto'

const DEFAULT_POLICY = {
  redactNames: false,
  redactPhone: true,
  coarsenGeoToH3Cell: null,
  retentionDays: 365,
}

export function redactPii(record, config = {}) {
  const cfg = { ...DEFAULT_POLICY, ...config }
  const result = { ...record }

  if (cfg.redactNames) {
    if (record.reporter_name) {
      result.reporter_name = hashString(record.reporter_name).slice(0, 8)
    }
    if (record.contact_name) {
      result.contact_name = hashString(record.contact_name).slice(0, 8)
    }
  }

  if (cfg.redactPhone) {
    if (record.phone) {
      result.phone = maskPhone(record.phone)
    }
    if (record.urn) {
      result.urn = maskPhone(record.urn)
    }
  }

  if (cfg.coarsenGeoToH3Cell !== null && cfg.coarsenGeoToH3Cell !== undefined) {
    if (record.latitude && record.longitude) {
      const level = cfg.coarsenGeoToH3Cell
      const precision = 1 / Math.pow(2, level)
      result.latitude = Math.round(record.latitude / precision) * precision
      result.longitude = Math.round(record.longitude / precision) * precision
      result.geo_precision_deg = precision
    }
  }

  return result
}

export function applyRetention(records, retentionDays, now = Date.now()) {
  if (!Array.isArray(records)) return { kept: [], expired: [] }
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000
  const kept = []
  const expired = []

  for (const record of records) {
    const timestamp = record.occurred_at || record.created_at
    if (!timestamp) {
      kept.push(record)
      continue
    }
    const age = now - new Date(timestamp).getTime()
    if (age > retentionMs) {
      expired.push(record)
    } else {
      kept.push(record)
    }
  }

  return { kept, expired }
}

export async function loadPolicy() {
  const envPolicy = process.env.LINDELA_LITE_PII_POLICY
  if (envPolicy) {
    try {
      return JSON.parse(envPolicy)
    } catch {
      // Fall through to file check
    }
  }

  try {
    const filePath = 'data/pii-policy.json'
    const content = await fs.readFile(filePath, 'utf8')
    return JSON.parse(content)
  } catch {
    // Return default if file doesn't exist
  }

  return DEFAULT_POLICY
}

function hashString(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`
}

function maskPhone(value) {
  if (!value) return value
  const str = String(value)
  const telPrefix = 'tel:'
  const hasPrefix = str.startsWith(telPrefix)
  const phone = hasPrefix ? str.slice(telPrefix.length) : str
  if (phone.length < 4) return str
  const lastFour = phone.slice(-4)
  return `xxxx${lastFour}`
}

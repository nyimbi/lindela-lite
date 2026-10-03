import fs from 'node:fs/promises'
import crypto from 'node:crypto'

const DEFAULT_POLICY = {
  // A privacy control that ships off is not a control; it is a function nobody
  // has to remember to call. It defaulted to false because reading a name in
  // plaintext looks harmless at the call site and is not harmless in the store
  // or the export. Flipping it on is a breaking change for anyone reading the
  // pseudonym out of a previous export — a deployment opts out with
  // `{"redactNames": false}` in data/pii-policy.json or LINDELA_LITE_PII_POLICY —
  // and the seed store carries no non-empty names, so nothing is rewritten.
  redactNames: true,
  redactPhone: true,
  coarsenGeoToH3Cell: null,
  retentionDays: 365,
}

export function redactPii(record, config = {}) {
  const cfg = mergePolicy(config)
  const result = { ...record }

  if (cfg.redactNames) {
    if (record.reporter_name) {
      result.reporter_name = hashString(record.reporter_name)
    }
    if (record.contact_name) {
      result.contact_name = hashString(record.contact_name)
    }
  }

  if (cfg.redactPhone) {
    if (record.phone) {
      result.phone = maskPhone(record.phone)
    }
    if (record.urn) {
      result.urn = maskPhone(record.urn)
    }
    // The CHW path stores the reporter phone as `contact_urn`. This file had
    // never heard of that name, so redaction ran against an object that did not
    // carry the field and the phone was stored in cleartext: the caller's field
    // list and this one had drifted apart, and the drift was silent. Registering
    // the name here is what stops the next one being silent too.
    if (record.contact_urn) {
      result.contact_urn = maskPhone(record.contact_urn)
    }
  }

  if (cfg.coarsenGeoToH3Cell !== null && cfg.coarsenGeoToH3Cell !== undefined) {
    // 0° is a place. `record.latitude && record.longitude` skipped coarsening
    // for every record on the equator or the prime meridian, so the privacy
    // control quietly did not apply to exactly the records a map draws most
    // precisely — and said nothing, because the records were still there.
    const lat = finiteNumber(record.latitude)
    const lon = finiteNumber(record.longitude)
    if (lat !== null && lon !== null) {
      const level = cfg.coarsenGeoToH3Cell
      const precision = 1 / Math.pow(2, level)
      result.latitude = Math.round(lat / precision) * precision
      result.longitude = Math.round(lon / precision) * precision
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

/**
 * A finite number, or null when the value was never determined.
 *
 * The guard has to rule absence out before it asks about the number.
 * `Number.isFinite(Number(x))` looks like it does both and does neither:
 * `Number(null)` and `Number('')` are both 0, so a null coordinate and an
 * empty one both sail through as a point on the equator. A value that is
 * present and non-finite is also absent in every sense that matters here.
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function hashString(value) {
  const salt = resolveSalt()
  const digest = crypto.createHmac('sha256', salt).update(String(value)).digest('hex')
  return `sha256:${saltId(salt)}:${digest.slice(0, DIGEST_HEX_CHARS)}`
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

// -------------------------------------------------------------------
// Salting the pseudonym
// -------------------------------------------------------------------

/**
 * The pseudonym is a deployment-scoped keyed digest, not a hash.
 *
 * Threat defended against: an adversary holding an export, a backup, or a
 * single confirmed (token, name) pair, plus a roster of the people a county
 * employs. Unsalted, every such name is one `sha256sum` away; with a
 * per-deployment salt, building that table means attacking HMAC-SHA256 instead,
 * which does not work by enumeration.
 *
 * Threat NOT defended against, and worth stating plainly: anyone who holds the
 * salt. It lives in an environment variable beside the application, so it is in
 * reach of whoever is in reach of the process. This raises the cost of a stolen
 * export; it does not make the names unrecoverable. Nor does it defeat an
 * adversary who watches outputs over time and simply counts how often each
 * pseudonym appears — frequent reporters stay frequent.
 *
 * Determinism is the point, so the salt is deployment-scoped and not per-run:
 * the RapidPro path and the HTTP path must yield the same pseudonym for the
 * same person, or linking a field report to a dispatch stops working. Set
 * `LINDELA_LITE_PII_SALT` to a stable random value and that holds across
 * restarts too. Unset, a salt is still generated — an unset salt must never mean
 * no salt — but it is ephemeral, so pseudonyms do not survive a restart, and
 * the warning says so rather than leaving it to be discovered.
 */

const SALT_ENV = 'LINDELA_LITE_PII_SALT'

// 128 bits of digest. The old scheme kept 32, and in practice kept none: it
// truncated the *prefixed* string, so every redacted name came out as the
// literal `sha256:a` — one value for the whole population, and a dictionary of
// one confirmed entry names everyone. 32 bits over a modest population is a
// birthday collision besides.
const DIGEST_HEX_CHARS = 32

let generatedSalt = null

function resolveSalt() {
  const configured = (process.env[SALT_ENV] || '').trim()
  if (configured) return configured
  if (generatedSalt === null) {
    generatedSalt = crypto.randomBytes(32).toString('hex')
    console.error(
      `[pii] ${SALT_ENV} is not set. An ephemeral salt was generated for this process. `
      + 'Name pseudonyms stay consistent within this run but change on restart, and no '
      + 'pseudonym from another deployment will match. Set it to a stable random value '
      + '(`openssl rand -hex 32`) before production.',
    )
  }
  return generatedSalt
}

/**
 * A short public fingerprint of the salt, embedded in each token so two
 * pseudonyms from different deployments are visibly different without the token
 * carrying the key that produced it.
 */
function saltId(salt) {
  return crypto.createHmac('sha256', salt).update('lindela-pii-salt-id').digest('hex').slice(0, 8)
}

/** Whether the salt is deployment-scoped or ephemeral. Never echoes the salt. */
export function piiSaltStatus() {
  const salt = resolveSalt()
  return {
    source: (process.env[SALT_ENV] || '').trim() ? 'configured' : 'generated',
    saltId: saltId(salt),
    digestBits: DIGEST_HEX_CHARS * 4,
  }
}

/**
 * Overlay the caller's policy on the default, treating an explicit `undefined`
 * as "the caller did not say".
 *
 * A plain object spread does not: it copies `undefined` over the default, so
 * `redactPii(record, { redactNames: body.anonymous })` silently disabled
 * redaction on every request that omitted the flag. For a privacy control the
 * default has to stay reachable by silence.
 */
function mergePolicy(config) {
  const cfg = { ...DEFAULT_POLICY }
  for (const [key, value] of Object.entries(config || {})) {
    if (value !== undefined) cfg[key] = value
  }
  return cfg
}

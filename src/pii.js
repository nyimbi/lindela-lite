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
    // Same drift, third field. `rapidpro_inbound_messages.from` is the sender's
    // number in E.164, taken straight off the webhook payload and stored as
    // received. Every other phone-shaped field was masked; this one was missed
    // because the masker's list was written from the CHW shape and the webhook
    // has a different one. A test asserted the cleartext value back, which made
    // the leak a specification rather than an accident — see
    // `test/privacy-rapidpro-inbound.test.js`.
    //
    // Masking, not hashing: the last four digits are what let an operator
    // recognise a reporter who has called before, and that is the whole
    // operational reason the field is there.
    if (record.from) {
      result.from = maskPhone(record.from)
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

/**
 * The effective policy, always complete.
 *
 * It returned whatever the file or the environment variable happened to parse
 * to, and every caller that read `policy.retentionDays` directly — rather than
 * handing the object to `redactPii`, which merges — got `undefined` the moment a
 * deployment set any single key. `applyRetention` then computed
 * `undefined * 86_400_000` as `NaN`, and `age > NaN` is false for every record
 * in the store. So a deployment that configured one privacy setting to opt out
 * of name redaction silently kept every field report forever, and
 * `POST /api/v1/maintenance/apply-retention` reported `{success: true, expired: 0}`
 * about it — the DAT-07 no-op, arriving by a different door and a week later.
 *
 * Merging here rather than at each call site means there is one policy shape,
 * which is the only way the fourth key is as safe as the first three.
 */
export async function loadPolicy() {
  const envPolicy = process.env.LINDELA_LITE_PII_POLICY
  if (envPolicy) {
    try {
      return mergePolicy(JSON.parse(envPolicy))
    } catch {
      // Fall through to file check
    }
  }

  try {
    const filePath = 'data/pii-policy.json'
    const content = await fs.readFile(filePath, 'utf8')
    return mergePolicy(JSON.parse(content))
  } catch {
    // Return default if file doesn't exist
  }

  return mergePolicy({})
}

/**
 * Apply the retention window to one collection.
 *
 * A window that is not a positive finite number purges nothing and says so.
 * Silently expiring everything on `NaN` would be the worse of the two failures,
 * but returning an empty `expired` without a reason is what let the `NaN` window
 * go unnoticed — a retention job that reports success forever is a retention job
 * nobody is running.
 */
export function retentionWindowDays(policy) {
  const days = policy?.retentionDays
  if (!Number.isFinite(days) || days <= 0) return null
  return days
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

/**
 * Keep the last four digits, drop the rest.
 *
 * Two things it used to get wrong, both of which made the masked value either
 * unparseable or fully reversible.
 *
 * It dropped the `tel:` scheme. `maskPhone('tel:+254711111111')` returned
 * `xxxx1111` — the same string as for a bare number, so a column that had been
 * URNs became a column of unparseable text, and two different subscribers with
 * the same last four digits became indistinguishable where before they were not.
 *
 * And it masked anything four characters or longer. `maskPhone('+254')` returned
 * `xxxx+254`: the whole input, inside the mask, with a prefix that says it was
 * redacted. Six characters is the shortest thing that could plausibly be a
 * number; below that there is nothing to redact, and the honest answer is to
 * return the input and let it be obviously not a phone number.
 */
function maskPhone(value) {
  if (!value) return value
  const str = String(value)
  const telPrefix = 'tel:'
  const hasPrefix = str.startsWith(telPrefix)
  const phone = hasPrefix ? str.slice(telPrefix.length) : str
  if (phone.length < 6) return str
  const lastFour = phone.slice(-4)
  return `${hasPrefix ? telPrefix : ''}xxxx${lastFour}`
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

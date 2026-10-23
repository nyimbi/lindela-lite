import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { numericOrNull } from './analytics/numeric.js'

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
  // Community feedback is the one collection whose retention rule was missing
  // entirely (R-12) while carrying a reporter hash and free text written by a
  // member of the public. It gets its own window rather than the general one,
  // shorter by default, because a field report is an operational record about a
  // hazard and a community comment is a person exercising the right to be heard.
  // A deployment that wants them equal sets this to the same number.
  communityFeedbackDays: 180,
  // ENH-74. An annotation is the same kind of object: free text a person typed
  // about a place and a hazard, not field-mapped, so `redactPii` cannot reach
  // inside it. `src/annotations.js` states the consequence in its own header —
  // a deployment wiring the collection should give it a window of its own rather
  // than fall through to the general one. Same default as community feedback,
  // and separately settable, because a district may want one and not the other.
  annotationDays: 180,
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

  // `reported_by` is identity-shaped by design — `src/kpi.js` counts distinct
  // reporters over it — and which shape depends on the door: a subject id on the
  // CHW route (`token_…`, already a pseudonym), the literal `'operator'` from
  // `normalizeFieldReport`, `'rapidpro'` from the webhook, a contact *name* from
  // the field-report parser (`src/rapidpro.js:197`), and the sender's *number*
  // on the SMS path ENH-43 adds. It sat outside both blocks above because it is
  // not one kind of thing.
  //
  // Both rules therefore apply, in order of specificity: a phone number is
  // masked, and anything else is pseudonymised like the other name fields.
  // Hashing `'operator'` along with a real name costs nothing — a distinct count
  // over the column is unchanged, because a constant hashed is still one value —
  // and the alternative was a hand-typed allowlist of system labels, which is
  // the defect class this repository keeps re-finding.
  if (cfg.redactPhone && phoneShaped(record.reported_by)) {
    result.reported_by = maskPhone(record.reported_by)
  } else if (cfg.redactNames && typeof record.reported_by === 'string' && record.reported_by.trim()) {
    result.reported_by = hashString(record.reported_by)
  }

  // The raw provider payload is echoed onto the record, and it is the one field
  // this function could not reach: the rules above read named keys on the record
  // itself, and a RapidPro payload nests the sender under `contact.name` and
  // `contact.urn`. So a record could be redacted field by field and still store
  // `payload.contact.name` in cleartext — which is what it did, on both webhook
  // doors, while every assertion about the top-level fields passed.
  //
  // Redacted rather than dropped: the payload is the evidence a connector defect
  // is diagnosed from, and deleting it to fix a leak trades one problem for
  // another.
  if (record.payload && typeof record.payload === 'object') {
    result.payload = redactPayload(record.payload, cfg)
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

/**
 * A value that is plausibly a phone number: an optional `+`, then digits.
 *
 * The same rule `src/residency.js` applies to `from`, kept here rather than
 * imported because the dependency runs the other way — residency reads `pii.js`.
 * Two copies of one predicate is the drift this file has already paid for once,
 * so it is written once and named here for a reader comparing the two.
 */
function phoneShaped(value) {
  if (typeof value !== 'string') return false
  const bare = value.trim().startsWith('tel:') ? value.trim().slice(4) : value.trim()
  return /^\+?\d[\d\s-]{4,}$/.test(bare)
}

/**
 * The same redaction, one level down: a provider payload's own nested keys.
 *
 * A shallow walk with an explicit depth cap, not a general recursive redactor.
 * The failure this exists for is two levels deep (`payload.contact.name`), and a
 * walker that descends without a bound is a denial-of-service on a webhook an
 * attacker controls. Keys are matched on the same vocabulary as the top level,
 * which is what makes a payload with a `from` or a `contact_urn` at its root —
 * the RapidPro field-report shape — redacted too.
 *
 * An array is walked element-wise rather than passed through: `payload.urns` is
 * an array of addresses in the real webhook, and treating it as an opaque value
 * would leave the sender in it.
 */
const PAYLOAD_MAX_DEPTH = 6
const PAYLOAD_NAME_KEYS = new Set(['reporter_name', 'contact_name', 'name'])
const PAYLOAD_PHONE_KEYS = new Set(['phone', 'urn', 'contact_urn', 'from', 'msisdn', 'tel', 'telephone', 'reported_by'])

function redactPayload(payload, cfg, depth = 0) {
  // A phone-shaped string at any position is masked, whatever the key was.
  // `payload.urns` is an array of addresses in the real webhook and its elements
  // are bare strings with no key to match on, so a key-driven walk left the
  // sender in it. This is the one rule that does not need the key: a string that
  // is a phone number is a phone number, and no provider payload carries a
  // field where that is the wrong reading. Checked before the type guard below,
  // which would otherwise return every string untouched.
  if (typeof payload === 'string') return cfg.redactPhone && phoneShaped(payload) ? maskPhone(payload) : payload
  if (depth >= PAYLOAD_MAX_DEPTH || payload === null || typeof payload !== 'object') return payload
  if (Array.isArray(payload)) return payload.map((item) => redactPayload(item, cfg, depth + 1))

  const out = {}
  for (const [key, value] of Object.entries(payload)) {
    const lower = key.toLowerCase()
    // `reported_by` carries the same two shapes one level down as it does at the
    // top: the field-report payload sets it from `contact.name`
    // (`src/rapidpro.js:197`), so a name here is the same PII a name anywhere
    // else is.
    if (lower === 'reported_by' && typeof value === 'string' && value.trim()) {
      out[key] = cfg.redactPhone && phoneShaped(value) ? maskPhone(value) : (cfg.redactNames ? hashString(value) : value)
      continue
    }
    if (cfg.redactNames && PAYLOAD_NAME_KEYS.has(lower) && typeof value === 'string' && value.trim()) {
      out[key] = hashString(value)
      continue
    }
    if (cfg.redactPhone && PAYLOAD_PHONE_KEYS.has(lower) && typeof value === 'string' && phoneShaped(value)) {
      out[key] = maskPhone(value)
      continue
    }
    out[key] = redactPayload(value, cfg, depth + 1)
  }
  return out
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
 * The window for one named collection, or null when neither it nor the general
 * window is configured.
 *
 * Named because the two are different decisions: `retentionDays` is how long an
 * operational record is kept, `communityFeedbackDays` is how long a person's
 * own words are kept, and a deployment that never thought about the second was
 * keeping it forever.
 *
 * **A table, not a ternary.** This read `collection === 'community_feedback'`
 * and nothing else, so the second collection of a person's free text — ENH-74's
 * annotations — had no way to be named here without a second ternary beside the
 * first, and the third would have been added the same way. `PERSONAL_WINDOW_KEYS`
 * is the list; adding a collection to it is one line, and the comment above each
 * key says which policy field it reads.
 */
const PERSONAL_WINDOW_KEYS = Object.freeze({
  community_feedback: 'communityFeedbackDays',
  annotations: 'annotationDays',
})

/**
 * Which policy field carries a collection's own window, or undefined.
 *
 * Exported because the refusal message names the fields it found unset, and a
 * second copy of this mapping in the route would be a copy that drifts the day a
 * third collection is added — the operator would be told about two windows when
 * three exist.
 */
export function personalWindowKey(collection) {
  return PERSONAL_WINDOW_KEYS[collection]
}

export function retentionWindowFor(policy, collection) {
  const key = PERSONAL_WINDOW_KEYS[collection]
  const specific = key ? policy?.[key] : undefined
  const days = Number.isFinite(specific) && specific > 0 ? specific : policy?.retentionDays
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
 *
 * `numericOrNull` is the same rule, written once for the whole platform, and
 * this delegates to it. The copy here was narrower than the original in the two
 * spellings that matter for a coordinate: `Number(true)` is 1 and `Number([])`
 * is 0, so a boolean or an array latitude was coarsened to a real point — a
 * privacy control applying to a value nobody measured, and reporting the point
 * it invented.
 */
function finiteNumber(value) {
  return numericOrNull(value)
}

/**
 * The shape `hashString` writes, so a value can be recognised as one of its own.
 *
 * PRIV-03. Redaction was not idempotent: `redactPii` hashed whatever string it
 * found, including a string it had hashed a moment earlier. One record passing
 * two doors — a CHW report that an operator then patches — came out with two
 * pseudonyms for one reporter, and `src/kpi.js`'s distinct-reporter count
 * counted them as two people. The damage is silent in exactly the direction a
 * privacy control must not be: the more doors a record passes, the less the
 * population is linkable, and nothing fails.
 *
 * Recognising the digest is also the honest reading. A pseudonym is not a name;
 * running it through the masker again says the masker cannot tell a name from
 * the thing it makes of one. A deployment that rotated its salt would produce a
 * second pseudonym from the first, which is the one case where re-hashing looks
 * useful — and it is still wrong, because the first pseudonym is already in the
 * store and the second would not match it.
 *
 * The check is on the *prefix and length*, not on the salt id: a pseudonym
 * written by a deployment with a different salt is still a pseudonym, and
 * hashing it again would not make it match anything.
 */
// 128 bits of digest. The old scheme kept 32, and in practice kept none: it
// truncated the *prefixed* string, so every redacted name came out as the
// literal `sha256:a` — one value for the whole population, and a dictionary of
// one confirmed entry names everyone. 32 bits over a modest population is a
// birthday collision besides.
const DIGEST_HEX_CHARS = 32

const PSEUDONYM_RE = new RegExp(`^sha256:[0-9a-f]{8}:[0-9a-f]{${DIGEST_HEX_CHARS}}$`)

function hashString(value) {
  const str = String(value)
  if (PSEUDONYM_RE.test(str)) return str
  const salt = resolveSalt()
  const digest = crypto.createHmac('sha256', salt).update(str).digest('hex')
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

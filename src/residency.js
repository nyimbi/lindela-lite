/**
 * ENH-79 — jurisdiction-aware data residency, as a policy, not a migration.
 *
 * Field data is PII-adjacent: `src/pii.js` pseudonymises a reporter's name and
 * masks a phone number, but where the record *sits* was never a decision anyone
 * made. A deployment honouring a residency requirement — Kenya's Data Protection
 * Act, South Sudan's directive, a donor's contract — had no way to say so short
 * of forking the store, and a fork is the shape where the next security fix
 * lands in one copy and not the other.
 *
 * So this module carries the decision, and the store layer calls it. It answers
 * four questions about one record and one deployment policy:
 *
 *   (a) **which jurisdiction the record belongs to** — `recordJurisdiction`,
 *       read from the record's own country or from a district resolved through
 *       the administrative registry (`src/org-units.js`), where every unit
 *       already carries a `country`. The registry *is* the jurisdiction
 *       vocabulary; a country the registry does not know is not a jurisdiction
 *       this platform can name, and naming one is exactly the guess this module
 *       refuses to make.
 *   (b) **whether the policy permits storing it here** — the per-jurisdiction
 *       rule's `store_here`, nothing inferred from silence.
 *   (c) **what must be done to make it storable** — `store`,
 *       `pseudonymise_then_store`, `route` to a named jurisdiction, `drop`, or
 *       `refuse`. `applyResidency` is the conformance contract made concrete:
 *       it returns the record the store layer would actually write.
 *   (d) **the retention limit for that jurisdiction** — `retention_days`, which
 *       a permitting rule must state, because an unstated retention is the
 *       DAT-07 no-op (`src/pii.js` shipped that bug once already: a policy that
 *       read one key and silently kept everything forever).
 *
 * ## It fails closed, and that is the whole design
 *
 * The house rule is that a reconciliation which measures nothing must fail, not
 * report success. Residency is the same shape: a policy that says nothing about
 * a jurisdiction has not permitted storage there, it has *failed to decide*.
 * Three states are therefore distinct and all three refuse:
 *
 *   - the record's jurisdiction is **unknown** — refuse, naming the record's
 *     identity, so the operator can see which record could not be placed;
 *   - the policy is **silent** about a jurisdiction the record does belong to —
 *     refuse, naming the jurisdiction, because silence is not permission;
 *   - the policy is **empty** (unset, or `{}`) — every record refuses. A
 *     deployment with no residency requirement states that explicitly, with a
 *     `default_rule`, rather than by omitting the policy; the difference between
 *     "we permit everything" and "nobody configured this" has to survive into
 *     the decision, and only an explicit default carries it.
 *
 * `DEFAULT_POLICY` names no jurisdiction and no default rule, so a process that
 * loads no policy stores nothing — the safe direction, because the alternative
 * is a deployment that believes it is compliant and is not.
 *
 * ## What this module is NOT
 *
 * It is a pure policy decision function, not a live cross-border router. It does
 * not move bytes between nodes, open a second pool, or write a partition key —
 * those are the store layer's to implement against this contract, and ENH-80
 * (federated multi-node) is the topology that would carry a `route`. What ships
 * here is the decision and the contract: `residencyDecision(record, policy)`
 * answers, and `applyResidency(record, decision)` produces the record the store
 * would write. No schema change, no migration, no second source of truth.
 *
 * The policy is data-driven and declarative — a deployment supplies it through
 * `data/residency-policy.json` or `LINDELA_LITE_RESIDENCY_POLICY`, the same two
 * doors `src/pii.js` already offers, so there is one way to configure privacy in
 * this codebase rather than two.
 */

import { redactPii } from './pii.js'
import { orgUnitFor } from './org-units.js'

/**
 * Every action a decision can carry. Frozen and exhaustive, because a store
 * layer switching on `action` must have a case for each and the compiler cannot
 * tell it when a fifth appears — the test suite asserts each member is reachable
 * from some policy, the same way `CAPTURE_KINDS` is kept honest in `capture.js`.
 */
export const RESIDENCY_ACTIONS = Object.freeze([
  'store',
  'pseudonymise_then_store',
  'route',
  'drop',
  'refuse',
])

/**
 * The fields `src/pii.js` pseudonymises by keyed digest, and the ones it masks.
 *
 * Kept in step with that file's `redactPii` by hand, and the drift is the reason
 * this list is stated rather than inferred: pii.js already paid for a drifted
 * field list once (`contact_urn` was masked nowhere and stored in cleartext),
 * so the vocabulary a residency decision reasons over is written down where a
 * reader can compare it against the masker.
 */
const PII_NAME_FIELDS = Object.freeze(['reporter_name', 'contact_name'])
const PII_PHONE_FIELDS = Object.freeze(['phone', 'urn', 'contact_urn'])

/**
 * The default policy: no jurisdiction named, no default rule.
 *
 * Everything refuses. This is not timidity — it is the only default that cannot
 * be wrong in the direction that matters. A permissive default would make an
 * unconfigured deployment store every jurisdiction's data and report success,
 * which is the failure this module exists to prevent; a refusing default makes
 * the operator supply the policy, and the refusal names what is missing.
 */
export const DEFAULT_POLICY = Object.freeze({
  // The jurisdiction the store physically sits in. Reported, not gating: the
  // gate is each rule's `store_here`, and a record whose jurisdiction differs
  // from this one is cross-border, which `cross_border` on the decision says.
  home_jurisdiction: null,
  // Per-jurisdiction rules, keyed by country code. Absent entry and absent
  // default rule both mean the policy is silent, which refuses.
  jurisdictions: Object.freeze({}),
  // The rule for a jurisdiction the map does not name. Deliberately undefined:
  // a deployment with no residency requirement writes one here, and writing it
  // is how "we permit everything" is distinguished from "nobody decided".
  default_rule: undefined,
})

/**
 * Overlay a caller's policy on the default, treating an explicit `undefined` as
 * "the caller did not say".
 *
 * A plain spread copies `undefined` over a default — the trap `mergePolicy` in
 * `src/pii.js` documents — and for a privacy control the safe default has to
 * stay reachable by silence. Exported because a test, a CLI or a route that
 * builds a policy in memory should not have to re-implement the overlay to get
 * the same shape.
 */
export function mergeResidencyPolicy(config = {}) {
  const cfg = {
    home_jurisdiction: DEFAULT_POLICY.home_jurisdiction,
    jurisdictions: DEFAULT_POLICY.jurisdictions,
    default_rule: DEFAULT_POLICY.default_rule,
  }
  for (const [key, value] of Object.entries(config || {})) {
    if (value !== undefined) cfg[key] = value
  }
  return cfg
}

/**
 * The policy the process should use: environment first, then file, then default.
 *
 * The order and the two doors mirror `loadPolicy` in `src/pii.js`, and the
 * failure mode is the same: unparseable JSON falls through rather than throwing,
 * and the end of the chain is the refusing default rather than a permissive one.
 * A residency policy that fails to load must not read as a residency policy that
 * permits everything.
 */
export async function loadResidencyPolicy() {
  const envPolicy = process.env.LINDELA_LITE_RESIDENCY_POLICY
  if (envPolicy) {
    try {
      return mergeResidencyPolicy(JSON.parse(envPolicy))
    } catch {
      // Fall through to the file check.
    }
  }

  try {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('data/residency-policy.json', 'utf8')
    return mergeResidencyPolicy(JSON.parse(content))
  } catch {
    // No file, or a file that does not parse: the refusing default.
  }

  return mergeResidencyPolicy({})
}

/**
 * Which jurisdiction a record belongs to, and how that was determined.
 *
 * Two sources, in order of authority:
 *
 *   1. an explicit `country` — the field `filterRecords` already matches, in the
 *      spellings it accepts (`country`, `scope.country`), plus `metadata.country`
 *      which connectors use;
 *   2. a `district`/`region` that resolves through the administrative registry,
 *      whose every unit carries a `country`.
 *
 * A value that resolves through neither is not a jurisdiction. The registry is
 * the vocabulary — a record naming a country the platform's own geography does
 * not contain has a jurisdiction *this deployment cannot name*, and returning a
 * code anyway would be the guess that lets a typo'd or unknown country be stored
 * permissively. `basis` records which source answered, so a decision can be
 * audited without re-reading the record.
 */
export function recordJurisdiction(record) {
  const miss = { jurisdiction: null, country: null, unit: null, basis: null }
  if (!record || typeof record !== 'object') return miss

  const named = [record.country, record.scope?.country, record.metadata?.country]
  for (const value of named) {
    const unit = unitFor(value)
    if (unit) return { jurisdiction: unit.country, country: unit.country, unit, basis: 'country' }
  }

  const labels = [record.district, record.region, record.region_name, record.admin1, record.scope?.district]
  for (const value of labels) {
    const unit = unitFor(value)
    if (unit) return { jurisdiction: unit.country, country: unit.country, unit, basis: 'district' }
  }

  return miss
}

/**
 * The retention limit for a jurisdiction, or null when the policy states none.
 *
 * The standalone form of question (d). `null` is a real answer and a distinct
 * one from a number: "the policy is silent" is not "keep it forever", and a
 * caller that cannot tell those apart is the DAT-07 no-op waiting to happen.
 */
export function retentionLimitFor(policy, jurisdiction) {
  const cfg = mergeResidencyPolicy(policy)
  const { rule } = ruleFor(cfg, jurisdiction)
  if (!rule) return null
  return Number.isFinite(rule.retention_days) && rule.retention_days > 0 ? rule.retention_days : null
}

/**
 * The residency decision for one record under one policy.
 *
 * Returns a frozen decision object. `action` is the instruction; `storable` says
 * whether this deployment may keep the record once the action is applied, which
 * is true for `store` and `pseudonymise_then_store` and false for the rest. Every
 * refusal carries a `code` and at least one reason string, and where the refusal
 * is about a record the reason names the record's identity — a refusal that does
 * not say *which* record is a refusal the operator cannot act on.
 */
export function residencyDecision(record, policy = DEFAULT_POLICY) {
  const cfg = mergeResidencyPolicy(policy)
  const identity = recordIdentity(record)
  const placed = recordJurisdiction(record)
  const { jurisdiction, country, unit, basis } = placed

  if (jurisdiction === null) {
    return decision({
      action: 'refuse',
      code: 'unknown_jurisdiction',
      record_id: recordId(record),
      reasons: [
        `${identity} has no determinable jurisdiction: it names no country and no district `
        + 'that resolves through the administrative registry, so there is no jurisdiction to '
        + 'check the policy against and none is assumed.',
      ],
    })
  }

  const { rule, declared } = ruleFor(cfg, jurisdiction)
  if (!rule) {
    return decision({
      action: 'refuse',
      code: 'policy_silent',
      jurisdiction,
      country,
      basis,
      record_id: recordId(record),
      reasons: [
        `the residency policy is silent about jurisdiction ${jurisdiction}, which ${identity} `
        + `belongs to (${basis}); silence is not permission, so the record is refused rather `
        + 'than stored on the assumption that no requirement applies.',
      ],
    })
  }

  const crossBorder = cfg.home_jurisdiction ? jurisdiction !== cfg.home_jurisdiction : null

  if (rule.store_here) {
    // A permitting rule must state how long the record is kept. The alternative
    // is a rule that permits storage and is silent on retention, which is how a
    // deployment ends up keeping a jurisdiction's data forever while believing
    // it has a policy — the failure `retentionWindowFor` in pii.js was written
    // to make impossible.
    if (!Number.isFinite(rule.retention_days) || rule.retention_days <= 0) {
      return decision({
        action: 'refuse',
        code: 'no_retention_limit',
        jurisdiction,
        country,
        basis,
        record_id: recordId(record),
        cross_border: crossBorder,
        reasons: [
          `jurisdiction ${jurisdiction} permits storing ${identity} but the policy declares no `
          + 'retention limit for it; an unstated retention is not "keep forever" and not a '
          + 'decision, so the record is refused until the limit is stated.',
        ],
      })
    }

    const piiFields = rule.require_pseudonym ? piiFieldsPresent(record) : []
    const action = piiFields.length ? 'pseudonymise_then_store' : 'store'
    return decision({
      action,
      jurisdiction,
      country,
      basis,
      record_id: recordId(record),
      cross_border: crossBorder,
      retention_days: rule.retention_days,
      pii_fields: piiFields,
      reasons: [
        piiFields.length
          ? `${identity} is storable in ${jurisdiction} once ${piiFields.join(', ')} `
            + 'are pseudonymised; kept for ${rule.retention_days} days.'
          : `${identity} is storable in ${jurisdiction} unchanged; kept for ${rule.retention_days} days.`,
      ],
    })
  }

  // Not storable here. The policy has to say where it goes — a rule that says
  // "not here" and nothing else has not decided, it has deferred, and the two
  // must not read alike.
  if (rule.drop) {
    return decision({
      action: 'drop',
      jurisdiction,
      country,
      basis,
      record_id: recordId(record),
      cross_border: crossBorder,
      reasons: [
        `jurisdiction ${jurisdiction} is not storable here and the policy drops ${identity} `
        + 'rather than routing it.',
      ],
    })
  }

  if (rule.route_to) {
    // A route names a jurisdiction the registry must know, for the same reason
    // an incoming record must: routing to a code nobody recognises moves the
    // bytes to a place the platform cannot describe, which is not a destination.
    const destination = unitFor(rule.route_to)
    if (!destination) {
      return decision({
        action: 'refuse',
        code: 'unknown_route',
        jurisdiction,
        country,
        basis,
        record_id: recordId(record),
        cross_border: crossBorder,
        reasons: [
          `the policy routes jurisdiction ${jurisdiction} to ${JSON.stringify(rule.route_to)}, `
          + 'which the administrative registry does not know; a destination that cannot be '
          + `named is not a destination, so ${identity} is refused.`,
        ],
      })
    }
    return decision({
      action: 'route',
      jurisdiction,
      country,
      basis,
      record_id: recordId(record),
      cross_border: crossBorder,
      route_to: destination.country,
      retention_days: Number.isFinite(rule.retention_days) && rule.retention_days > 0 ? rule.retention_days : null,
      reasons: [
        `${identity} is not storable in jurisdiction ${jurisdiction} here and is routed to `
        + `${destination.country} (via the rule declared ${declared}).`,
      ],
    })
  }

  return decision({
    action: 'refuse',
    code: 'not_storable',
    jurisdiction,
    country,
    basis,
    record_id: recordId(record),
    cross_border: crossBorder,
    reasons: [
      `jurisdiction ${jurisdiction} is not storable here and the policy names neither a route `
      + `nor a drop for it, so ${identity} is refused rather than stored in the hope that it `
      + 'does not matter.',
    ],
  })
}

/**
 * Whether a decision leaves the record storable in this deployment.
 *
 * The one predicate a store layer should branch on, so the five actions do not
 * each get their own `action === 'store' || action === 'pseudonymise_then_store'`
 * written out at every call site — the shape that goes wrong when a sixth action
 * appears.
 */
export function isStorable(decision) {
  return Boolean(decision) && decision.storable === true
}

/**
 * Apply a decision to a record — the conformance contract, made runnable.
 *
 * Returns `{ record, action, route_to }`. For `store` the record is returned
 * unchanged; for `pseudonymise_then_store` it is the record `redactPii` produces,
 * so the store layer writes exactly what the decision described rather than
 * re-deriving which fields are PII. For `drop` and `refuse` the record is
 * `null`: there is nothing to write, and returning the record anyway would leave
 * a caller one stray `store.merge` away from keeping what it just refused. For
 * `route` the record is returned unchanged with `route_to` set, because moving
 * bytes is the store layer's job and this module decides rather than ships.
 *
 * This is a pure function of its arguments; it reads no clock and touches no
 * store.
 */
export function applyResidency(record, decision) {
  const action = decision?.action
  if (action === 'store') {
    return { record, action, route_to: null }
  }
  if (action === 'pseudonymise_then_store') {
    return { record: redactPii(record, { redactNames: true, redactPhone: true }), action, route_to: null }
  }
  if (action === 'route') {
    return { record, action, route_to: decision.route_to ?? null }
  }
  return { record: null, action: action ?? 'refuse', route_to: null }
}

/**
 * One line stating a decision, for a log or a refusal body.
 *
 * The reasons already read as sentences; this joins them so a caller that logs
 * `residency: ${describeDecision(d)}` does not have to know the array's shape.
 */
export function describeDecision(decision) {
  const reasons = decision?.reasons ?? []
  return reasons.length ? reasons.join(' ') : `residency action ${decision?.action ?? 'unknown'}`
}

/**
 * The rule for a jurisdiction: the named one, else the default, else nothing.
 *
 * `declared` says which of the three answered, so a decision can name where its
 * rule came from — a record stored under a default rule and one stored under a
 * jurisdiction's own rule are different evidence about a deployment.
 */
function ruleFor(policy, jurisdiction) {
  const named = policy?.jurisdictions?.[jurisdiction]
  if (named) return { rule: normaliseRule(named), declared: `jurisdictions.${jurisdiction}` }
  if (policy?.default_rule) return { rule: normaliseRule(policy.default_rule), declared: 'default_rule' }
  return { rule: null, declared: null }
}

/**
 * A rule with every field defined, so the decision reads flags rather than
 * `undefined`. The defaults are all the refusing direction: a rule that names a
 * jurisdiction and says nothing else stores nothing.
 */
function normaliseRule(rule) {
  const source = rule && typeof rule === 'object' ? rule : {}
  return {
    store_here: source.store_here === true,
    require_pseudonym: source.require_pseudonym === true,
    drop: source.drop === true,
    retention_days: Number.isFinite(source.retention_days) ? source.retention_days : null,
    route_to: typeof source.route_to === 'string' && source.route_to.trim() ? source.route_to : null,
  }
}

/** The registry unit a jurisdiction value names, or null. */
function unitFor(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  return orgUnitFor(value)
}

/**
 * The PII the record still carries in the clear.
 *
 * Already-pseudonymised names (`sha256:…`) and already-masked phones
 * (`xxxx1234`, `tel:xxxx1234`) are not counted: a record re-presented to the
 * decider must not be told to pseudonymise what is already pseudonymised, or the
 * `action` would differ between a record's first and second pass for no reason a
 * caller could see. `from` is included only when it is phone-shaped — it is the
 * RapidPro sender in `src/pii.js`, but it is also a plausible source label, and
 * masking a source name would be this module inventing PII where there is none.
 */
function piiFieldsPresent(record) {
  if (!record || typeof record !== 'object') return []
  const found = []
  for (const field of PII_NAME_FIELDS) {
    const value = record[field]
    if (present(value) && !alreadyPseudonymised(value)) found.push(field)
  }
  for (const field of PII_PHONE_FIELDS) {
    const value = record[field]
    if (present(value) && !alreadyMaskedPhone(value)) found.push(field)
  }
  if (phoneShaped(record.from) && !alreadyMaskedPhone(record.from)) found.push('from')
  return found
}

function present(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function alreadyPseudonymised(value) {
  return typeof value === 'string' && value.startsWith('sha256:')
}

function alreadyMaskedPhone(value) {
  return typeof value === 'string' && /^(tel:)?x{4}\d/.test(value.trim())
}

/** A value that is plausibly a phone number: an optional `+`, then digits. */
function phoneShaped(value) {
  if (typeof value !== 'string') return false
  const bare = value.trim().startsWith('tel:') ? value.trim().slice(4) : value.trim()
  return /^\+?\d[\d\s-]{4,}$/.test(bare)
}

/**
 * A name for the record in a refusal, so the operator can find it.
 *
 * An id where the record has one, otherwise its collection — never a bare "a
 * record", which tells the operator nothing to act on. A record with neither is
 * described as such rather than given a fabricated identity.
 */
function recordIdentity(record) {
  const id = recordId(record)
  if (id) return `record ${id}`
  const collection = record?.collection ?? record?.type ?? record?.kind
  if (typeof collection === 'string' && collection.trim()) return `a ${collection} record with no id`
  return 'a record with no id'
}

function recordId(record) {
  const id = record?.id ?? record?.record_id ?? record?.submission_id
  return typeof id === 'string' && id.trim() ? id : null
}

/** Assemble the frozen decision, defaulting every field the action did not set. */
function decision(fields) {
  const action = fields.action
  return Object.freeze({
    action,
    code: fields.code ?? null,
    storable: action === 'store' || action === 'pseudonymise_then_store',
    jurisdiction: fields.jurisdiction ?? null,
    country: fields.country ?? null,
    basis: fields.basis ?? null,
    record_id: fields.record_id ?? null,
    cross_border: fields.cross_border ?? null,
    retention_days: fields.retention_days ?? null,
    route_to: fields.route_to ?? null,
    pii_fields: Object.freeze(fields.pii_fields ?? []),
    reasons: Object.freeze(fields.reasons ?? []),
  })
}

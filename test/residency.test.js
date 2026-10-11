#!/usr/bin/env node
/**
 * ENH-79 — the residency decision, and what it refuses.
 *
 * `src/residency.js` is a pure policy function, so what is worth asserting is
 * not that it computes an action but that the action it computes *fails closed*.
 * A residency gate that defaults to permissive is worse than none: it reports a
 * deployment compliant while storing every jurisdiction's data, which is the
 * shape of the DAT-07 no-op (`src/pii.js` shipped one — a retention window that
 * kept everything forever and reported `{success: true, expired: 0}`).
 *
 * So the four cases the design names each get their own test, and each asserts
 * on the refusal *reason* rather than only the code, because a refusal the
 * operator cannot act on is a refusal that gets worked around:
 *
 *   - a record whose jurisdiction is **determinable** — stored, under a stated
 *     retention limit;
 *   - a record whose jurisdiction is **not determinable** — refused, naming the
 *     record's identity rather than a jurisdiction it does not have;
 *   - a policy **silent** about a jurisdiction the record belongs to — refused,
 *     because silence is not permission;
 *   - an **empty** policy — every record refused, because the difference between
 *     "we permit everything" and "nobody configured this" must survive into the
 *     decision and only an explicit default carries it.
 *
 * The records below are real shapes from the codebase: a RapidPro inbound
 * message carrying `contact_urn` and `from`, a field report carrying
 * `reporter_name`/`phone` — the two fields `src/pii.js` masks — and a district
 * the administrative registry resolves to a country.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_POLICY,
  RESIDENCY_ACTIONS,
  applyResidency,
  describeDecision,
  isStorable,
  loadResidencyPolicy,
  mergeResidencyPolicy,
  recordJurisdiction,
  residencyDecision,
  retentionLimitFor,
} from '../src/residency.js'

/**
 * A policy that stores Kenya, pseudonymising PII, and routes Somalia.
 *
 * `home_jurisdiction` is Kenya, so a Kenyan record is not cross-border and a
 * routed Somali one is — the field a caller reads to decide whether an action
 * moves bytes off the store it is running on.
 */
const POLICY = {
  home_jurisdiction: 'KE',
  jurisdictions: {
    KE: { store_here: true, require_pseudonym: true, retention_days: 365 },
    SS: { store_here: true, require_pseudonym: false, retention_days: 180 },
    SO: { store_here: false, route_to: 'KE' },
  },
}

const KENYAN_REPORT = {
  id: 'fr-0001',
  collection: 'field_reports',
  country: 'KE',
  district: 'turkana',
  reporter_name: 'Amina Wekesa',
  phone: '+254711111111',
  occurred_at: '2026-09-01T00:00:00.000Z',
}

describe('ENH-79 recordJurisdiction', () => {
  it('reads a country off the record', () => {
    const placed = recordJurisdiction(KENYAN_REPORT)
    assert.equal(placed.jurisdiction, 'KE')
    assert.equal(placed.basis, 'country')
    assert.equal(placed.unit.code, 'KE')
  })

  it('resolves a district through the administrative registry', () => {
    // No country field: the jurisdiction comes from `turkana` resolving to its
    // parent country in `src/org-units.js`, which is where every unit already
    // carries a `country`.
    const placed = recordJurisdiction({ id: 'fr-2', district: 'turkana' })
    assert.equal(placed.jurisdiction, 'KE')
    assert.equal(placed.basis, 'district')
  })

  it('resolves a registry synonym, so a name the data uses is not a miss', () => {
    // `moroto → UG-KARAMOJA` in ORG_UNIT_SYNONYMS. A jurisdiction check that did
    // not read the synonym table would call this unknown and refuse a record the
    // rest of the platform places in Uganda.
    const placed = recordJurisdiction({ id: 'fr-3', district: 'moroto' })
    assert.equal(placed.jurisdiction, 'UG')
  })

  it('reads a country nested under scope, the spelling filterRecords accepts', () => {
    const placed = recordJurisdiction({ id: 'fr-4', scope: { country: 'SS' } })
    assert.equal(placed.jurisdiction, 'SS')
    assert.equal(placed.basis, 'country')
  })

  it('returns null rather than guessing for a country the registry does not know', () => {
    const placed = recordJurisdiction({ id: 'fr-5', country: 'Atlantis' })
    assert.equal(placed.jurisdiction, null)
    assert.equal(placed.basis, null)
  })
})

describe('ENH-79 a determinable jurisdiction is stored', () => {
  it('stores a Kenyan record under a stated retention limit', () => {
    const d = residencyDecision(KENYAN_REPORT, POLICY)
    assert.equal(d.jurisdiction, 'KE')
    assert.equal(d.retention_days, 365)
    assert.equal(d.cross_border, false)
    assert.equal(isStorable(d), true)
  })

  it('pseudonymises before storing when the rule requires it', () => {
    const d = residencyDecision(KENYAN_REPORT, POLICY)
    assert.equal(d.action, 'pseudonymise_then_store')
    // The fields named are the ones pii.js actually masks, so a rule that says
    // "pseudonymise" and a masker that covers different fields cannot drift
    // silently.
    assert.deepEqual([...d.pii_fields].sort(), ['contact_name', 'phone', 'reporter_name'].filter((f) => f in KENYAN_REPORT))
  })

  it('the applied record carries no cleartext name or phone', () => {
    const d = residencyDecision(KENYAN_REPORT, POLICY)
    const { record } = applyResidency(KENYAN_REPORT, d)
    assert.notEqual(record.reporter_name, KENYAN_REPORT.reporter_name)
    assert.match(record.reporter_name, /^sha256:/)
    assert.match(record.phone, /^xxxx/)
    // The original is untouched — a decision is a function, not a mutation.
    assert.equal(KENYAN_REPORT.reporter_name, 'Amina Wekesa')
  })

  it('stores unchanged when the rule does not require pseudonymisation', () => {
    const report = { id: 'fr-ss', country: 'SS', reporter_name: 'Deng Alier' }
    const d = residencyDecision(report, POLICY)
    assert.equal(d.action, 'store')
    assert.equal(d.retention_days, 180)
    const { record } = applyResidency(report, d)
    assert.equal(record.reporter_name, 'Deng Alier')
  })

  it('routes rather than stores where the policy says so', () => {
    const d = residencyDecision({ id: 'fr-so', country: 'SO' }, POLICY)
    assert.equal(d.action, 'route')
    assert.equal(d.route_to, 'KE')
    assert.equal(isStorable(d), false)
    assert.equal(d.cross_border, true)
  })
})

describe('ENH-79 an unknown jurisdiction is refused', () => {
  it('refuses a record whose jurisdiction cannot be determined', () => {
    const d = residencyDecision({ id: 'fr-unknown', district: 'Nowhere' }, POLICY)
    assert.equal(d.action, 'refuse')
    assert.equal(d.code, 'unknown_jurisdiction')
    assert.equal(isStorable(d), false)
    // The reason names the record's identity — an operator reading the log has
    // to be able to find the record, not merely learn that one was refused.
    assert.match(describeDecision(d), /fr-unknown/)
  })

  it('refuses a record naming a country the registry does not know', () => {
    const d = residencyDecision({ id: 'fr-atlantis', country: 'Atlantis' }, POLICY)
    assert.equal(d.code, 'unknown_jurisdiction')
    assert.match(describeDecision(d), /fr-atlantis/)
  })

  it('names the collection when the record carries no id', () => {
    const d = residencyDecision({ collection: 'rapidpro_inbound_messages' }, POLICY)
    assert.equal(d.action, 'refuse')
    assert.match(describeDecision(d), /rapidpro_inbound_messages/)
  })

  it('returns nothing to write for a refused record', () => {
    const d = residencyDecision({ id: 'fr-unknown', district: 'Nowhere' }, POLICY)
    const applied = applyResidency({ id: 'fr-unknown', district: 'Nowhere' }, d)
    assert.equal(applied.record, null)
  })
})

describe('ENH-79 a silent policy is refused', () => {
  it('refuses a jurisdiction the policy does not name', () => {
    const policy = { jurisdictions: { KE: { store_here: true, retention_days: 365 } } }
    const d = residencyDecision({ id: 'fr-ug', district: 'karamoja' }, policy)
    assert.equal(d.action, 'refuse')
    assert.equal(d.code, 'policy_silent')
    assert.equal(d.jurisdiction, 'UG')
    assert.equal(isStorable(d), false)
    assert.match(describeDecision(d), /UG/)
  })

  it('a rule that permits storage but states no retention is refused', () => {
    // The DAT-07 shape: the policy says "yes, store it" and never says how long.
    // An unstated retention is not "keep forever" and not a decision.
    const policy = { jurisdictions: { KE: { store_here: true } } }
    const d = residencyDecision({ id: 'fr-ke', country: 'KE' }, policy)
    assert.equal(d.action, 'refuse')
    assert.equal(d.code, 'no_retention_limit')
  })

  it('a rule that says "not here" with no route and no drop is refused', () => {
    const policy = { jurisdictions: { KE: { store_here: false } } }
    const d = residencyDecision({ id: 'fr-ke', country: 'KE' }, policy)
    assert.equal(d.action, 'refuse')
    assert.equal(d.code, 'not_storable')
  })

  it('a route to a destination the registry cannot name is refused', () => {
    const policy = { jurisdictions: { KE: { store_here: false, route_to: 'Atlantis' } } }
    const d = residencyDecision({ id: 'fr-ke', country: 'KE' }, policy)
    assert.equal(d.action, 'refuse')
    assert.equal(d.code, 'unknown_route')
  })

  it('retentionLimitFor answers null for a jurisdiction the policy is silent on', () => {
    assert.equal(retentionLimitFor({ jurisdictions: {} }, 'KE'), null)
    assert.equal(retentionLimitFor({ jurisdictions: { KE: { store_here: true } } }, 'KE'), null)
    assert.equal(retentionLimitFor(POLICY, 'KE'), 365)
  })
})

describe('ENH-79 an empty policy fails closed', () => {
  it('refuses every record when no policy is supplied', () => {
    const d = residencyDecision(KENYAN_REPORT)
    assert.equal(d.action, 'refuse')
    assert.equal(d.code, 'policy_silent')
    assert.equal(isStorable(d), false)
  })

  it('refuses every record when the policy is the empty object', () => {
    const d = residencyDecision(KENYAN_REPORT, {})
    assert.equal(d.action, 'refuse')
    assert.equal(isStorable(d), false)
  })

  it('the default policy names no jurisdiction and no default rule', () => {
    assert.equal(DEFAULT_POLICY.home_jurisdiction, null)
    assert.equal(DEFAULT_POLICY.default_rule, undefined)
    assert.deepEqual(Object.keys(DEFAULT_POLICY.jurisdictions), [])
  })

  it('an explicit default rule is what permits the otherwise-unnamed', () => {
    // The one way a deployment with no residency requirement says so: it writes
    // the rule. Without it, silence refuses — the difference between "we permit
    // everything" and "nobody configured this" survives into the decision.
    const policy = { default_rule: { store_here: true, retention_days: 30 } }
    const d = residencyDecision({ id: 'fr-any', country: 'UG' }, policy)
    assert.equal(d.action, 'store')
    assert.equal(d.retention_days, 30)
    assert.equal(isStorable(d), true)
  })

  it('loadResidencyPolicy with nothing configured refuses rather than permits', async () => {
    const previous = process.env.LINDELA_LITE_RESIDENCY_POLICY
    delete process.env.LINDELA_LITE_RESIDENCY_POLICY
    try {
      const policy = await loadResidencyPolicy()
      const d = residencyDecision(KENYAN_REPORT, policy)
      assert.equal(d.action, 'refuse')
      assert.equal(isStorable(d), false)
    } finally {
      if (previous !== undefined) process.env.LINDELA_LITE_RESIDENCY_POLICY = previous
    }
  })

  it('loadResidencyPolicy refuses on unparseable JSON rather than throwing', async () => {
    const previous = process.env.LINDELA_LITE_RESIDENCY_POLICY
    process.env.LINDELA_LITE_RESIDENCY_POLICY = '{ not json'
    try {
      const policy = await loadResidencyPolicy()
      assert.equal(residencyDecision(KENYAN_REPORT, policy).action, 'refuse')
    } finally {
      if (previous === undefined) delete process.env.LINDELA_LITE_RESIDENCY_POLICY
      else process.env.LINDELA_LITE_RESIDENCY_POLICY = previous
    }
  })
})

describe('ENH-79 the decision vocabulary is closed', () => {
  it('every action in RESIDENCY_ACTIONS is reachable from some policy', () => {
    const reachable = new Set([
      residencyDecision({ id: 'a', country: 'SS' }, POLICY).action, // store
      residencyDecision(KENYAN_REPORT, POLICY).action, // pseudonymise_then_store
      residencyDecision({ id: 'c', country: 'SO' }, POLICY).action, // route
      residencyDecision({ id: 'd', country: 'KE' }, { jurisdictions: { KE: { store_here: false, drop: true } } }).action, // drop
      residencyDecision({ id: 'e', country: 'KE' }, {}).action, // refuse
    ])
    assert.deepEqual([...reachable].sort(), [...RESIDENCY_ACTIONS].sort())
  })

  it('every decision carries a reason', () => {
    for (const policy of [POLICY, {}, { jurisdictions: { KE: { store_here: true } } }]) {
      const d = residencyDecision(KENYAN_REPORT, policy)
      assert.ok(d.reasons.length > 0, `no reason for action ${d.action}`)
      assert.ok(describeDecision(d).length > 0)
    }
  })

  it('mergeResidencyPolicy treats an explicit undefined as "the caller did not say"', () => {
    const merged = mergeResidencyPolicy({ home_jurisdiction: undefined, jurisdictions: POLICY.jurisdictions })
    assert.equal(merged.home_jurisdiction, null)
    assert.deepEqual(merged.jurisdictions, POLICY.jurisdictions)
  })
})

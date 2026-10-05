import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RATE_LIMIT_POLICIES, coerceLimit } from '../src/rate-limit.js'
import { SOURCE_IDS, BLOCKED_SOURCE_IDS } from '../src/schema.js'

/**
 * R-11 — the outbound limiter was declared and unreachable.
 *
 * Seven connectors declared `defaults.rateLimit`; fourteen call sites passed
 * neither `rateLimit` nor `source`, so `limiterFor` returned null and every
 * outbound request ran unthrottled. `ipc_hdx` ran a ~46-way `Promise.all` — 92
 * requests against a declared 20/min — with no `Agent` to reuse connections.
 *
 * The wiring is now in place for seven sources. This file guards the part that
 * wiring cannot: a *new* source with no policy is a source that runs
 * unthrottled, and nothing about adding one fails.
 *
 * Which is why the assertion is coverage, not a sample. A test that checks two
 * known sources pass tells you about those two sources; this one fails the day
 * a thirteenth source is added without a line here.
 */

describe('R-11 — every source the platform can run has a declared budget', () => {
  it('no source id is missing a policy, and exemptions are declared here', () => {
    // Four source ids make no repeated outbound call, and a policy for them
    // would be theatre: a rate limit on something that runs once per
    // operator-initiated import is a number nobody reads.
    //
    // They are listed here rather than inferred from the module, so the
    // exemption is a decision someone can see — and the assertion below stops
    // this list growing without that being noticed.
    const EXEMPT = {
      service_assets: 'a local file import (connectors/uploads.js); no outbound call',
      acled_csv: 'a local file import (connectors/uploads.js); no outbound call',
      conflict_csv: 'a local file import (connectors/uploads.js); no outbound call',
      dhis2: 'one push per run to a configured instance; not a crawl',
    }
    const missing = SOURCE_IDS.filter((id) => !RATE_LIMIT_POLICIES[id] && !(id in EXEMPT))
    assert.deepEqual(missing, [],
      'these sources can be run and have no declared rate limit, so their calls ' +
      'are unthrottled: ' + missing.join(', ') + '. A policy here is what makes ' +
      'the `source` a call site already passes mean something.')

    // An exemption for a source that now has a policy is a stale exemption: it
    // reads as "we decided this needs no limit" when the answer has changed.
    const stale = Object.keys(EXEMPT).filter((id) => RATE_LIMIT_POLICIES[id])
    assert.deepEqual(stale, [],
      'these sources are exempt from a rate policy and now have one: ' + stale.join(', '))
  })

  it('no policy names a source that does not exist', () => {
    // The other direction: a policy for a source that was renamed or removed is
    // configuration that reads as coverage and protects nothing.
    const orphans = Object.keys(RATE_LIMIT_POLICIES)
      .filter((id) => !SOURCE_IDS.includes(id) && !BLOCKED_SOURCE_IDS.includes(id))
    assert.deepEqual(orphans, [],
      'RATE_LIMIT_POLICIES names sources the platform cannot run: ' + orphans.join(', '))
  })

  it('every policy is readable by the limiter that has to honour it', () => {
    // `coerceLimit` returns null for a declaration it cannot read, and a null
    // is a refusal: no limiter, and the call site believing it is protected. So
    // a policy that does not survive its own parser is the inert configuration
    // this defect was made of.
    for (const [id, declared] of Object.entries(RATE_LIMIT_POLICIES)) {
      const parsed = coerceLimit(declared)
      assert.ok(parsed, `${id}: the policy cannot be read by the limiter that must apply it`)
      assert.ok(parsed.ratePerWindow > 0, `${id}: ratePerWindow must be positive`)
      assert.ok(parsed.windowMs > 0, `${id}: windowMs must be positive`)
    }
  })

  it('a blocked source has no budget, because it must never run', () => {
    // `gdelt` is in BLOCKED_SOURCE_IDS. A policy for it would read as
    // "throttled" when the truth is "not permitted".
    for (const id of BLOCKED_SOURCE_IDS) {
      assert.equal(RATE_LIMIT_POLICIES[id], undefined,
        `${id} is blocked from running; a rate policy for it implies it might`)
    }
  })
})

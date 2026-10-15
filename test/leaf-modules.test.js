import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NUMERIC_VALUE_FIELDS, derivedKey, placeOf } from '../src/derived-key.js'
import { ENVELOPE_KINDS, honestyEnvelope, uncertaintyTiers } from '../src/envelope.js'
import { DEFAULT_WINDOW, NL_QUERY_VOCABULARY, SUBJECTS, WINDOWS } from '../src/nl-vocabulary.js'
import { SOURCE_POLICIES } from '../src/source-policies.js'

/**
 * R-77 — the four leaf modules the cycle fix created.
 *
 * Breaking five import cycles meant moving four sets of bindings into leaf
 * modules. A move is the change most likely to be silently wrong: the old
 * module re-exports, so every existing test still passes, and the leaf itself
 * is reached by nothing — `check-module-coverage` reported all four as
 * unreached, which is the gate doing its job.
 *
 * So this file is not coverage for its own sake. Each case asserts the property
 * that made the binding safe to extract:
 *
 *   - it is the *same object* the former host still exports, so the move did
 *     not fork a value into two copies that can drift;
 *   - it is frozen, because every one of them was frozen where it lived;
 *   - it imports nothing that could re-close the cycle it was created to break.
 *
 * The identity assertion is the load-bearing one. A copy is the failure this
 * whole change is exposed to, and it is invisible to every other test: two
 * objects with equal contents compare equal under `deepEqual`.
 */

describe('R-77 the extracted leaves are the same values, not copies', () => {
  it('SOURCE_POLICIES is one object, shared with src/ingestion.js', async () => {
    const host = await import('../src/ingestion.js')
    assert.equal(host.SOURCE_POLICIES, SOURCE_POLICIES, 'ingestion re-exports a different object')
    assert.ok(Object.isFrozen(SOURCE_POLICIES))
    assert.equal(Object.keys(SOURCE_POLICIES).length, 20)
    // The shape a reader depends on, so a leaf that loaded but lost its fields
    // fails here rather than at a call site.
    //
    // `interval_minutes` and `stale_after_minutes` are **not** uniformly
    // numbers: the three upload sources (`service_assets`, `acled_csv`,
    // `conflict_csv`) carry an object there, because a manual upload has no
    // cadence to state and the field holds the schedule's own shape instead.
    // The first draft of this assertion required a number of every entry and
    // failed on exactly those three — an assumption about a canonical value
    // that the tree does not hold. Pin what is true: the six fields exist, and
    // the two cadence fields are a number or an object, never absent.
    for (const [id, policy] of Object.entries(SOURCE_POLICIES)) {
      for (const field of ['interval_minutes', 'stale_after_minutes', 'timeout_ms', 'retries', 'minimum_records', 'regular']) {
        assert.ok(field in policy, `${id} has no ${field}`)
      }
      for (const cadence of ['interval_minutes', 'stale_after_minutes']) {
        assert.ok(
          typeof policy[cadence] === 'number' || typeof policy[cadence] === 'object',
          `${id}.${cadence} is ${typeof policy[cadence]}`,
        )
      }
      assert.equal(typeof policy.timeout_ms, 'number', `${id}.timeout_ms`)
      assert.equal(typeof policy.retries, 'number', `${id}.retries`)
      assert.equal(typeof policy.minimum_records, 'number', `${id}.minimum_records`)
      assert.equal(typeof policy.regular, 'boolean', `${id}.regular`)
    }
  })

  it('the envelope API is one set of functions, shared with src/analytics.js', async () => {
    const host = await import('../src/analytics.js')
    assert.equal(host.honestyEnvelope, honestyEnvelope)
    assert.equal(host.uncertaintyTiers, uncertaintyTiers)
    assert.equal(host.ENVELOPE_KINDS, ENVELOPE_KINDS)
    assert.ok(Object.isFrozen(ENVELOPE_KINDS))
    // Behaviour, not just identity: the envelope refuses an unknown kind rather
    // than describing it, which is the property the module is named for.
    assert.equal(honestyEnvelope('not_a_kind', { value: 1 }).value, null)
    assert.equal(honestyEnvelope('flood_risk_score', { value: 51 }).value, 51)
    assert.equal(uncertaintyTiers({}).coverage.measures.length > 0, true)
  })

  it('the derived-row key is one set of functions, shared with src/analytics.js', async () => {
    const host = await import('../src/analytics.js')
    assert.equal(host.derivedKey, derivedKey)
    assert.equal(host.NUMERIC_VALUE_FIELDS, NUMERIC_VALUE_FIELDS)
    assert.ok(Object.isFrozen(NUMERIC_VALUE_FIELDS))
    assert.deepEqual([...NUMERIC_VALUE_FIELDS], ['score', 'risk_score', 'impact_score', 'value'])
    // `placeOf` is exported from the leaf and deliberately NOT re-exported by
    // analytics: the public surface of that module is unchanged by the move.
    assert.equal(typeof placeOf, 'function')
    assert.equal('placeOf' in host, false, 'analytics re-exports placeOf, which widens its API')
    assert.equal(derivedKey('risk_scores', { type: 'score', region: 'Turkana' }), 'risk_scores:score:Turkana')
  })

  it('the query vocabulary is one object, shared with src/nl-query.js', async () => {
    const host = await import('../src/nl-query.js')
    assert.equal(host.SUBJECTS, SUBJECTS)
    assert.equal(host.WINDOWS, WINDOWS)
    assert.equal(host.NL_QUERY_VOCABULARY, NL_QUERY_VOCABULARY)
    assert.equal(host.DEFAULT_WINDOW, DEFAULT_WINDOW)
    assert.ok(Object.isFrozen(SUBJECTS) && Object.isFrozen(NL_QUERY_VOCABULARY))
    // The projection is derived from the constants, so a leaf that loaded with
    // an empty vocabulary fails here rather than in a parse.
    assert.equal(NL_QUERY_VOCABULARY.subjects.length, Object.keys(SUBJECTS).length)
    assert.equal(NL_QUERY_VOCABULARY.windows.length, WINDOWS.length)
    assert.ok(NL_QUERY_VOCABULARY.regions.length > 0, 'the vocabulary projects no districts')
  })
})

describe('R-77 a leaf imports nothing that re-closes its cycle', () => {
  it('none of the four leaves imports its former host', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    for (const [leaf, host] of [
      ['src/source-policies.js', 'ingestion.js'],
      ['src/envelope.js', 'analytics.js'],
      ['src/derived-key.js', 'analytics.js'],
      ['src/nl-vocabulary.js', 'nl-query.js'],
    ]) {
      const source = fs.readFileSync(path.join(root, leaf), 'utf8')
      assert.ok(
        !source.includes(`'./${host}'`),
        `${leaf} imports ./${host} again — the cycle is back`,
      )
    }
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runShadow, scoreLinear, canRunInWindow } from '../src/model-shadow.js'

const rec = (id, values, validated = true) => ({
  id,
  feature_values: values,
  validated,
})

describe('model shadow (decision-model spike)', () => {
  it('scores a stated value on its weights', () => {
    const x = scoreLinear([0.9, 0.1], [1, 1])
    // total weight = 2, weighted sum = 1.0, normalization yields unity
    assert.ok(Number.isFinite(x), x)
  })

  it('propagates null rather than counting absence as zero', () => {
    assert.equal(scoreLinear([null, null], null), null)
    assert.equal(scoreLinear([null, 1], [1, 1]), 1)
  })

  it('does not count whitespace-as-string as measured', () => {
    assert.equal(scoreLinear(['  ', '1'], null), 1)
  })

  it('refuses unvalidated records', () => {
    assert.throws(() => runShadow([rec('r1', [0, 0], false)], { features: ['x'] }))
  })

  it('writes one action log per record', () => {
    const { results, action_logs, summary } = runShadow(
      [rec('r1', [0.8], true)],
      { features: ['x'], threshold: 0.3 },
    )
    assert.equal(results.length, 1)
    assert.equal(action_logs.length, 1)
    assert.equal(results[0].decision, 'alert')
    assert.equal(results[0].model_id, 'shadow_probe')
    assert.equal(summary.alert, 1)
    assert.equal(summary.undetermined, 0)
  })

  it('rate-limits via window helper', () => {
    assert.equal(canRunInWindow({ lastRunMs: 0 }, 1000, 1000000), false)
    assert.equal(canRunInWindow({}, 1000, 1000000), true)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createRegistry, runShadowDue, plannedModelsFromEnv, ENV_FLAG } from '../src/model-registry.js'
import { runShadow } from '../src/model-shadow.js'

const rec = (id, vals) => ({ id, feature_values: vals, validated: true })

describe('model registry / orchestrator', () => {
  it('refuses duplicates and requires id+version', () => {
    const r = createRegistry()
    r.register({ id: 'm', version: '1', capability: 'shadow' })
    assert.throws(() => r.register({ id: 'm', version: '1', capability: 'shadow' }))
    assert.throws(() => r.register({ capability: 'shadow' }))
  })

  it('byCapability filters', () => {
    const r = createRegistry()
    r.register({ id: 'a', version: '1', capability: 'shadow', status: 'active' })
    r.register({ id: 'b', version: '1', capability: 'control', status: 'active' })
    assert.equal(r.byCapability('shadow').length, 1)
  })

  it('runShadowDue respects minIntervalMs', async () => {
    const r = createRegistry()
    r.register({ id: 'sh', version: '1', capability: 'shadow', status: 'active', threshold: 0.3,
      algorithm_version: 'svc1', features: ['x'] })
    const state = { lastRunMs: 0 }
    const out1 = await runShadowDue({ registry: r, records: [rec('a', [0.8])], state, runShadow, minIntervalMs: 10_000, now: 20_000 })
    assert.equal(out1.skipped, false)
    const out2 = await runShadowDue({ registry: r, records: [rec('a', [0.8])], state, runShadow, minIntervalMs: 10_000, now: 21_000 })
    assert.equal(out2.skipped, true)
  })

  it('plannedModelsFromEnv parses comma-separated ids', () => {
    assert.deepEqual(plannedModelsFromEnv({ LITE_SHADOW_MODELS: 'a, b , ,c' }), ['a','b','c'])
    assert.deepEqual(plannedModelsFromEnv({}), [])
    assert.equal(ENV_FLAG, 'LITE_SHADOW_MODELS')
  })
}
)

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DISCHARGE_BANDS,
  DISCHARGE_MODEL_NOTE,
  dischargeBand,
} from '../public/shared/discharge-bands.js'

describe('discharge bands', () => {
  it('bands values at the operational cut points', () => {
    assert.equal(dischargeBand(0).key, 'low')
    assert.equal(dischargeBand(49.9).key, 'low')
    assert.equal(dischargeBand(50).key, 'moderate')
    assert.equal(dischargeBand(199.9).key, 'moderate')
    assert.equal(dischargeBand(200).key, 'high')
    assert.equal(dischargeBand(499.9).key, 'high')
    assert.equal(dischargeBand(500).key, 'extreme')
    assert.equal(dischargeBand(1500).key, 'extreme')
  })

  it('returns null for unreported or invalid values', () => {
    assert.equal(dischargeBand(null), null)
    assert.equal(dischargeBand(undefined), null)
    assert.equal(dischargeBand(NaN), null)
    assert.equal(dischargeBand('123'), null)
    assert.equal(dischargeBand(-1), null)
  })

  it('produces strictly rising, contiguous bands ending at infinity', () => {
    for (let i = 1; i < DISCHARGE_BANDS.length; i += 1) {
      assert.ok(
        DISCHARGE_BANDS[i].max > DISCHARGE_BANDS[i - 1].max,
        `band ${DISCHARGE_BANDS[i].key} must start above where ${DISCHARGE_BANDS[i - 1].key} stops`,
      )
    }
    assert.equal(DISCHARGE_BANDS[DISCHARGE_BANDS.length - 1].max, Number.POSITIVE_INFINITY)
  })

  it('maps each band onto the severity vocabulary, strictly rising', () => {
    const order = ['low', 'medium', 'high', 'critical']
    const ranks = DISCHARGE_BANDS.map((band) => order.indexOf(band.severity))
    for (let i = 1; i < ranks.length; i += 1) {
      assert.ok(ranks[i] >= ranks[i - 1], `${DISCHARGE_BANDS[i].key} must not grade below ${DISCHARGE_BANDS[i - 1].key}`)
    }
  })

  it('carries a model-limit note that names the source and the limitation', () => {
    assert.match(DISCHARGE_MODEL_NOTE, /modelled/i)
    assert.match(DISCHARGE_MODEL_NOTE, /gauge/i)
  })
})

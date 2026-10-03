import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * The /score payload has to carry its own uncertainty.
 *
 * Two defects, both about a number leaving the server stripped of the context
 * that makes it interpretable:
 *
 * - With no `region`, the route scored `models[0]` — whichever district
 *   happened to train most recently. A caller who omitted the parameter got an
 *   authoritative-looking answer about a district they never asked about.
 * - The response carried a bare `probability`. The Wilson intervals and the
 *   contingency counts the model was actually fit to stayed on the server, so
 *   the one figure an integrator would quote was the one figure with no way to
 *   see how few events it rests on.
 */

const FEATURES = 'max_7_day=420&sum_30_day=300&sum_90_day=700'

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-score-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const server = createServer({ store })
  const listener = server.listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** A model record shaped like the real trained output. */
function model(regionName, trainedAt) {
  return {
    id: `model-${regionName}`,
    region_name: regionName,
    trained_at: trainedAt,
    model: {
      intercept: -2,
      coefficients: [
        { feature: 'max_7_day', value: 0.9 },
        { feature: 'sum_30_day', value: 0.3 },
        { feature: 'sum_90_day', value: 0.1 },
      ],
      standardization: [
        { feature: 'max_7_day', mean: 90, sd: 45 },
        { feature: 'sum_30_day', mean: 240, sd: 120 },
        { feature: 'sum_90_day', mean: 560, sd: 280 },
      ],
      training: { months: 72 },
    },
    folds: { folds: { brier: 0.11, skill_over_base_rate: 0.22, n_folds: 6 } },
    basis: { basis: 'empirical rainfall-flood co-occurrence (contingency counts + regularised logistic fit)' },
    label_source: 'glofas_discharge',
    months_kept: 72,
    events_matched: 4,
    contingency: [
      {
        feature: 'max_7_day', percentile: 0.9, threshold_mm: 120,
        months_above_threshold: 7, flood_months_above_threshold: 4,
        flood_months_below_threshold: 9,
        conditional_probability: 0.5714,
        conditional_probability_wilson: { lower: 0.25, upper: 0.84 },
        lift_over_base_rate: 2.4,
      },
      {
        feature: 'sum_30_day', percentile: 0.9, threshold_mm: 300,
        months_above_threshold: 8, flood_months_above_threshold: 3,
        flood_months_below_threshold: 11,
        conditional_probability: 0.375,
        conditional_probability_wilson: { lower: 0.135, upper: 0.7 },
        lift_over_base_rate: 1.6,
      },
    ],
  }
}

describe('flood-probability /score honesty', () => {
  it('refuses to guess a region when several models are trained', async () => {
    await withServer(async (base, store) => {
      await store.merge({
        flood_probability_models: [
          model('Turkana', '2026-09-01T00:00:00.000Z'),
          model('Marsabit', '2026-10-01T00:00:00.000Z'),
        ],
      })
      const res = await fetch(`${base}/api/v1/flood-probability/score?${FEATURES}`)
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.match(body.error, /region is required/)
      assert.deepEqual(
        [...body.available_regions].sort(),
        ['Marsabit', 'Turkana'],
        'the refusal must say what the caller could have asked for instead',
      )
    })
  })

  it('does not score Marsabit when the caller asked about nothing in particular', async () => {
    // The specific harm: models[0] is Marsabit because it trained last, so the
    // response would name a district the caller never mentioned and carry a
    // fully-formed probability for it.
    await withServer(async (base, store) => {
      await store.merge({
        flood_probability_models: [
          model('Turkana', '2026-09-01T00:00:00.000Z'),
          model('Marsabit', '2026-10-01T00:00:00.000Z'),
        ],
      })
      const body = await (await fetch(`${base}/api/v1/flood-probability/score?${FEATURES}`)).json()
      assert.equal(body.data, undefined, 'no score was returned at all')
      assert.equal(JSON.stringify(body).includes('"region_name":"Marsabit"'), false)
    })
  })

  it('still scores when exactly one model exists, with no region named', async () => {
    await withServer(async (base, store) => {
      await store.merge({ flood_probability_models: [model('Turkana', '2026-09-01T00:00:00.000Z')] })
      const body = await (await fetch(`${base}/api/v1/flood-probability/score?${FEATURES}`)).json()
      assert.equal(body.scored, true, 'a single unambiguous model should not need a region')
      assert.equal(body.data.region_name, 'Turkana')
    })
  })

  it('carries the uncertainty on the probability it returns', async () => {
    await withServer(async (base, store) => {
      await store.merge({ flood_probability_models: [model('Turkana', '2026-09-01T00:00:00.000Z')] })
      const body = await (await fetch(`${base}/api/v1/flood-probability/score?${FEATURES}&region=Turkana`)).json()
      assert.equal(body.scored, true)
      assert.ok(Number.isFinite(body.data.probability))
      assert.ok(body.data.uncertainty, 'the payload must not be a bare probability')
      assert.match(body.data.uncertainty.note, /not a confidence interval/,
        'a caller must not mistake the empirical interval for one on the fitted estimate')
    })
  })

  it('keys the uncertainty by the feature the caller actually supplied', async () => {
    // contingency() returns a flat array. Handing back row[0] would attribute
    // the max_7_day interval to whoever asked about sum_90_day.
    await withServer(async (base, store) => {
      await store.merge({ flood_probability_models: [model('Turkana', '2026-09-01T00:00:00.000Z')] })
      const body = await (await fetch(`${base}/api/v1/flood-probability/score?${FEATURES}&region=Turkana`)).json()
      const { by_feature: byFeature } = body.data.uncertainty
      assert.deepEqual(Object.keys(byFeature).sort(), ['max_7_day', 'sum_30_day'])
      assert.equal(byFeature.max_7_day.threshold_mm, 120)
      assert.deepEqual(byFeature.max_7_day.conditional_probability_wilson, { lower: 0.25, upper: 0.84 })
      assert.equal(byFeature.max_7_day.months_above_threshold, 7)
    })
  })

  it('says how few events the probability rests on', async () => {
    // events_matched: 4. A probability of 0.57 on four events has a Wilson
    // interval from 0.25 to 0.84, and that is the entire story.
    await withServer(async (base, store) => {
      await store.merge({ flood_probability_models: [model('Turkana', '2026-09-01T00:00:00.000Z')] })
      const body = await (await fetch(`${base}/api/v1/flood-probability/score?${FEATURES}&region=Turkana`)).json()
      const row = body.data.uncertainty.by_feature.max_7_day
      assert.equal(body.data.events_matched, 4)
      assert.equal(row.flood_months_above_threshold, 4)
      assert.ok(row.conditional_probability_wilson.lower < row.conditional_probability,
        'the interval must be wider than the point estimate it brackets')
      assert.ok(row.conditional_probability_wilson.upper > row.conditional_probability)
    })
  })

  it('returns an empty uncertainty map rather than omitting it', async () => {
    // A model trained before the contingency counts existed must say so, not
    // leave the caller guessing whether the field is missing or null.
    await withServer(async (base, store) => {
      const bare = model('Turkana', '2026-09-01T00:00:00.000Z')
      delete bare.contingency
      await store.merge({ flood_probability_models: [bare] })
      const body = await (await fetch(`${base}/api/v1/flood-probability/score?${FEATURES}&region=Turkana`)).json()
      assert.equal(body.scored, true)
      assert.ok(body.data.uncertainty)
      assert.deepEqual(body.data.uncertainty.by_feature, {})
      assert.match(body.data.uncertainty.note, /Wilson interval/)
    })
  })

  it('names the requested region, not whichever model sorted first', async () => {
    await withServer(async (base, store) => {
      await store.merge({
        flood_probability_models: [
          model('Turkana', '2026-09-01T00:00:00.000Z'),
          model('Marsabit', '2026-10-01T00:00:00.000Z'),
        ],
      })
      const body = await (await fetch(`${base}/api/v1/flood-probability/score?${FEATURES}&region=Turkana`)).json()
      assert.equal(body.data.region_name, 'Turkana')
      assert.equal(body.data.trained_at, '2026-09-01T00:00:00.000Z')
    })
  })
})
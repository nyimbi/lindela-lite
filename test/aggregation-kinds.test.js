import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aggregationKindFor,
  preferredAggregate,
  sumField,
  meanField,
  unitOf,
  INTENSIVE_UNITS,
  EXTENSIVE_UNITS,
  ACCUMULATING_UNITS,
} from '../public/shared/aggregation-kinds.js'
import { CANARIES, scanSource, scanTree } from '../scripts/check-aggregation-kinds.mjs'

describe('aggregation-kind registry (ENH-45)', () => {
  it('classifies a point measurement as intensive and a count as extensive', () => {
    assert.equal(aggregationKindFor('precipitation_mm'), 'intensive')
    assert.equal(aggregationKindFor('temperature_max_c'), 'intensive')
    assert.equal(aggregationKindFor('battery_pct'), 'intensive')
    assert.equal(aggregationKindFor('distance_km'), 'intensive')
    assert.equal(aggregationKindFor('hazard_events'), 'extensive')
    assert.equal(aggregationKindFor('field_reports'), 'extensive')
  })

  it('turns rainfall extensive along the time axis and back along space', () => {
    // The axis is the whole reason the registry has one. 20 mm at each of five
    // stations is one storm reported five times; 20 mm on each of five days is
    // 100 mm of accumulated rain. Same field, opposite answers.
    assert.equal(aggregationKindFor('precipitation_mm', { axis: 'space' }), 'intensive')
    assert.equal(aggregationKindFor('precipitation_mm', { axis: 'time' }), 'extensive')
    assert.equal(aggregationKindFor('precipitation_mm'), 'intensive', 'space is the default axis')
    // A temperature accumulates along neither: a sum of daily maxima is not a
    // temperature.
    assert.equal(aggregationKindFor('temperature_max_c', { axis: 'time' }), 'intensive')
  })

  it('names the aggregate an intensive field wants instead of a sum', () => {
    assert.match(preferredAggregate('precipitation_mm'), /mean/)
    assert.match(preferredAggregate('warning_to_action_median_hours'), /median/)
    assert.equal(preferredAggregate('hazard_events'), null, 'an extensive field needs no substitute')
  })

  it('resolves the unit at a boundary, not mid-word', () => {
    assert.equal(unitOf('precipitation_mm'), 'mm')
    assert.equal(unitOf('bias_corrected_precipitation_mm'), 'mm')
    assert.equal(unitOf('mm'), 'mm')
    // `maximum` ends in `m`; `_mm` is not its suffix.
    assert.equal(unitOf('maximum'), null)
    assert.equal(unitOf('hazard_events'), null)
  })

  it('refuses to sum an intensive field and says why', () => {
    const rows = [{ precipitation_mm: 20 }, { precipitation_mm: 30 }]
    assert.throws(() => sumField(rows, 'precipitation_mm'), /intensive/)
    assert.throws(() => sumField(rows, 'precipitation_mm'), /mean/)
    // The escape hatch needs a reason, and the reason is what makes it a
    // decision a reviewer can read rather than a silence.
    assert.equal(sumField(rows, 'precipitation_mm', { reason: 'the rows are disjoint strata' }), 50)
  })

  it('sums an extensive field, skipping non-finite readings rather than reading them as zero', () => {
    const rows = [{ hazard_events: 2 }, { hazard_events: null }, { hazard_events: 3 }]
    assert.equal(sumField(rows, 'hazard_events'), 5)
    assert.throws(() => sumField('not an array', 'hazard_events'), TypeError)
  })

  it('returns null, not 0, for the mean of no readings', () => {
    assert.equal(meanField([{ precipitation_mm: null }], 'precipitation_mm'), null)
    assert.equal(meanField([{ precipitation_mm: 10 }, { precipitation_mm: 20 }], 'precipitation_mm'), 15)
    assert.equal(meanField([], 'precipitation_mm'), null)
  })

  it('refuses a name that states no unit rather than guessing its kind', () => {
    assert.equal(aggregationKindFor(''), null)
    assert.equal(aggregationKindFor(null), null)
    assert.equal(aggregationKindFor('Not A Field'), null)
  })

  it('every declared unit is reachable by a name', () => {
    for (const unit of [...Object.keys(INTENSIVE_UNITS), ...Object.keys(EXTENSIVE_UNITS)]) {
      assert.ok(aggregationKindFor(`x_${unit}`), `${unit} is declared but no name resolves to it`)
    }
    for (const unit of ACCUMULATING_UNITS) {
      assert.ok(unit in INTENSIVE_UNITS, `${unit} accumulates over time but is not declared intensive in space`)
    }
  })
})

describe('the aggregation-kind gate', () => {
  it('every canary holds', () => {
    for (const canary of CANARIES) {
      assert.equal(scanSource(canary.source).length, canary.expect, canary.name)
    }
  })

  it('fires on the defect and not on the fix, which is the pair that matters', () => {
    const defect = 'const p = climate.reduce((sum, item) => sum + Number(item.precipitation_mm || 0), 0)'
    const fixed = 'const p = usable.length ? usable.reduce((sum, v) => sum + v, 0) / usable.length : null'
    assert.equal(scanSource(defect).length, 1, 'the sum VER-01 removed must be flagged')
    assert.equal(scanSource(fixed).length, 0, 'the mean that replaced it must not be')
  })

  it('the tree is clean, so a new instance fails the build rather than an audit', () => {
    assert.deepEqual(scanTree(), [])
  })
})

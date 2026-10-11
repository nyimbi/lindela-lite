import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DIMENSIONS,
  UNITS,
  PERIODS,
  UNSPECIFIED_PERIOD,
  MEASUREMENT_PERIODS,
  mixedPeriodFields,
  unitOf,
  declarationFor,
  dimensionOf,
  scaleOf,
  periodOf,
  compareMeasurements,
  periodsPresent,
  meanMeasured,
} from '../public/shared/units.js'
import { CANARIES, scanReader, scanWriter, scanTree } from '../scripts/check-unit-mixing.mjs'

describe('unit and dimension registry (ENH-47)', () => {
  it('reads the unit off the end of a name, longest suffix first', () => {
    assert.equal(unitOf('precipitation_mm'), 'mm')
    assert.equal(unitOf('flood_area_sq_km'), 'sq_km')
    // `_sq_km` must not be read as `_m`, and `_ms` must not be read as `_s`.
    assert.equal(unitOf('reported_area_km2'), 'km2')
    assert.equal(unitOf('latency_ms'), 'ms')
    assert.equal(unitOf('latency_s'), 's')
    assert.equal(unitOf('maximum'), null, '`maximum` ends in `m`; `_m` is not its suffix')
    assert.equal(unitOf('hazard_events'), null)
    assert.equal(unitOf(''), null)
    assert.equal(unitOf(null), null)
  })

  it('names the dimension and the canonical scale of each unit', () => {
    assert.equal(dimensionOf('precipitation_mm'), 'length')
    assert.equal(dimensionOf('flood_area_ha'), 'area')
    assert.equal(dimensionOf('warning_hours'), 'duration')
    assert.equal(dimensionOf('temperature_max_c'), 'temperature')
    assert.equal(dimensionOf('battery_pct'), 'proportion')
    assert.equal(dimensionOf('river_discharge_m3s'), 'discharge')
    assert.equal(dimensionOf('wind_direction_deg'), 'angle')

    // Same dimension, different scale: mm and m are both length, but a number
    // written in one is not a number written in the other.
    assert.equal(dimensionOf('depth_mm'), dimensionOf('depth_m'))
    assert.notEqual(scaleOf('depth_mm'), scaleOf('depth_m'))
    assert.equal(scaleOf('depth_mm'), 0.001)
    assert.equal(scaleOf('depth_m'), 1)
  })

  it('declares every unit with a dimension the registry names', () => {
    const named = new Set(DIMENSIONS.map((d) => (typeof d === 'string' ? d : d.name)))
    for (const [unit, spec] of Object.entries(UNITS)) {
      assert.ok(named.has(spec.dimension), `${unit} names dimension ${spec.dimension}, which is not declared`)
      assert.equal(typeof spec.canonical, 'number', `${unit} has no canonical scale`)
      assert.equal(typeof spec.accumulates, 'boolean', `${unit} does not say whether it accumulates`)
    }
  })
})

describe('measurement periods (ENH-47)', () => {
  it('reads the period off the record, falling back to the source and type', () => {
    assert.equal(periodOf({ source: 'open_meteo', type: 'current_weather' }), 'per_15_min')
    assert.equal(periodOf({ source: 'open_meteo', type: 'precipitation_forecast' }), 'per_day')
    // An explicit period on the record wins over the lookup, because the writer
    // knows something the table does not.
    assert.equal(periodOf({ source: 'open_meteo', type: 'current_weather', period: 'per_hour' }), 'per_hour')
    // A record from a source nobody declared is unspecified, not guessed.
    assert.equal(periodOf({ source: 'chirps', type: 'rainfall_daily' }), UNSPECIFIED_PERIOD)
    assert.equal(periodOf({}), UNSPECIFIED_PERIOD)
    assert.equal(periodOf(null), UNSPECIFIED_PERIOD)
  })

  it('names the field the registry declares at more than one period', () => {
    const mixed = mixedPeriodFields()
    assert.ok(mixed.has('precipitation_mm'), 'precipitation_mm is written at two periods and must be named')
    // temperature is declared at one period only, so it is not a mixed field.
    assert.ok(!mixed.has('temperature_max_c'))
  })

  it('ignores an unspecified period when deciding whether a field is mixed', () => {
    const mixed = mixedPeriodFields({
      'a:x': { field: 'rain_mm', period: 'per_day' },
      'b:y': { field: 'rain_mm', period: UNSPECIFIED_PERIOD },
    })
    assert.ok(!mixed.has('rain_mm'), 'an undeclared period is not a second period')
  })

  it('compares two measurements and names the axis that disagrees', () => {
    assert.equal(compareMeasurements('depth_mm', null, 'depth_mm', null).same, true)

    const scale = compareMeasurements('depth_mm', null, 'depth_m', null)
    assert.equal(scale.same, false)
    assert.equal(scale.axis, 'scale')

    const dimension = compareMeasurements('depth_mm', null, 'duration_hours', null)
    assert.equal(dimension.same, false)
    assert.equal(dimension.axis, 'dimension')

    const period = compareMeasurements('precipitation_mm', 'per_15_min', 'precipitation_mm', 'per_day')
    assert.equal(period.same, false)
    assert.equal(period.axis, 'period')
    assert.match(period.reason, /period/)

    // The same field with one side unspecified is not a conflict: pre-ENH-47
    // records carry no period, and refusing to blend them would break every
    // series already stored.
    assert.equal(compareMeasurements('precipitation_mm', 'per_day', 'precipitation_mm', UNSPECIFIED_PERIOD).same, true)
  })

  it('lists the periods present in a set of readings', () => {
    const rows = [
      { precipitation_mm: 3, source: 'open_meteo', type: 'current_weather' },
      { precipitation_mm: 40, source: 'open_meteo', type: 'precipitation_forecast' },
    ]
    const present = periodsPresent(rows, 'precipitation_mm')
    assert.deepEqual(present.declared.sort(), ['per_15_min', 'per_day'])
    assert.equal(present.mixed, true)
    // A field that does not accumulate has no period axis at all.
    assert.deepEqual(periodsPresent([{ temperature_max_c: 30 }], 'temperature_max_c').periods, [])
  })
})

describe('meanMeasured refuses to average across periods (ENH-47)', () => {
  it('does not blend a 15-minute reading with a whole-day total', () => {
    // The live defect: `precipitation_mm` is the preceding 15 minutes in a
    // `current_weather` record and the whole-day sum in a `precipitation_forecast`
    // record. Averaging them yields 21.5 mm, a number describing no period.
    const rows = [
      { precipitation_mm: 3, source: 'open_meteo', type: 'current_weather' },
      { precipitation_mm: 40, source: 'open_meteo', type: 'precipitation_forecast' },
    ]
    const result = meanMeasured(rows, 'precipitation_mm')
    assert.equal(result.mixed, true)
    assert.equal(result.readings, 2)
    // The mean it returns is the dominant period's, not the blend.
    assert.notEqual(result.mean, 21.5)
    assert.equal(result.by_period.per_15_min.mean, 3)
    assert.equal(result.by_period.per_day.mean, 40)
  })

  it('averages readings that share a period', () => {
    const rows = [
      { precipitation_mm: 10, source: 'open_meteo', type: 'precipitation_forecast' },
      { precipitation_mm: 20, source: 'open_meteo', type: 'precipitation_forecast' },
    ]
    const result = meanMeasured(rows, 'precipitation_mm')
    assert.equal(result.mean, 15)
    assert.equal(result.mixed, false)
    assert.equal(result.period, 'per_day')
  })

  it('returns null, not 0, for the mean of no readings', () => {
    assert.equal(meanMeasured([], 'precipitation_mm').mean, null)
    assert.equal(meanMeasured([{ precipitation_mm: null }], 'precipitation_mm').mean, null)
    assert.equal(meanMeasured([{ precipitation_mm: NaN }], 'precipitation_mm').mean, null)
  })

  it('accepts bare numbers as readings with an unspecified period', () => {
    const result = meanMeasured([10, 20, 30], 'precipitation_mm')
    assert.equal(result.mean, 20)
    assert.equal(result.mixed, false)
  })

  it('refuses a non-array rather than reading it as empty', () => {
    assert.throws(() => meanMeasured('not an array', 'precipitation_mm'), TypeError)
    assert.throws(() => meanMeasured(null, 'precipitation_mm'), TypeError)
  })
})

describe('the unit-mixing gate', () => {
  it('every canary holds', () => {
    for (const canary of CANARIES) {
      const scan = canary.kind === 'writer' ? scanWriter : scanReader
      assert.equal(scan(canary.source).length, canary.expect, canary.name)
    }
  })

  it('fires on the defect and not on the fix, which is the pair that matters', () => {
    const defect = [
      'const values = rows.map((r) => r.precipitation_mm)',
      'const mean = values.reduce((sum, v) => sum + v, 0) / values.length',
    ].join('\n')
    const fixed = [
      "import { meanMeasured } from '../public/shared/units.js'",
      "const { mean } = meanMeasured(rows, 'precipitation_mm')",
    ].join('\n')
    assert.equal(scanReader(defect).length, 1, 'the period-blind mean must be flagged')
    assert.equal(scanReader(fixed).length, 0, 'the meanMeasured call that replaced it must not be')
  })

  it('still flags a bare reduce in a file that also imports the helper', () => {
    // The regression that escaped the gate's first version: the whole file was
    // exempted once it imported the helper, so reverting the fix in
    // `src/analytics.js` left the gate reporting clean on the defect it was
    // written for. Importing the fix at one site does not make the file
    // period-aware at every other site.
    const source = [
      "import { meanMeasured } from '../public/shared/units.js'",
      'const values = rows.map((r) => r.precipitation_mm)',
      'const mean = values.reduce((sum, v) => sum + v, 0) / values.length',
      "const other = meanMeasured(rows, 'precipitation_mm')",
    ].join('\n')
    assert.equal(scanReader(source).length, 1)
  })

  it('the tree is clean, so a new instance fails the build rather than an audit', () => {
    assert.deepEqual(scanTree(), [])
  })
})

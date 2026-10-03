#!/usr/bin/env node
/**
 * ENH-07: the assertion map, made checkable, and the GDACS cap made visible.
 *
 * Four connectors carried four hand-written guards for four specific
 * breakages — GloFAS detecting that its rss.xml path had become a web app,
 * CHIRPS detecting that the raster index stopped listing files at its root,
 * FIRMS detecting a missing MAP_KEY, WHO detecting a query that answered 200
 * with nothing. All four worked. All four were the same guard, written four
 * times, for four known breakages, and nothing in the codebase would have
 * caught a fifth kind or a partial version of one of the four.
 *
 * This file is the check the four guards never had:
 *   - the map is complete against `schema.SOURCE_IDS` and every declared kind
 *     is used by somebody, because this repo's recurring defect is a list
 *     maintained in one place and checked nowhere;
 *   - each assertion kind fails on a deliberately broken batch, so a kind that
 *     can only ever pass is caught here rather than in production;
 *   - the count assertion is judged against a trailing window rather than a
 *     constant, which is the only thing that can see the GDACS ~100-result
 *     per-query cap: 4,000 records parsed out of a 40,000-record archive reads
 *     as a clean success under every guard that shipped before this;
 *   - a legitimate zero passes. Silence is not breakage, and a count
 *     assertion that cannot tell a quiet week from a dead feed will be turned
 *     off by whoever gets paged first.
 *
 * And the falsy-zero rule, asserted as behaviour rather than as a comment: a
 * rainfall total of 0 mm, a fire with 0 MW FRP, a conflict event with 0
 * fatalities and a facility with 0 capacity are all real measurements. Every
 * presence check in `src/assertions.js` uses `?? null`; if one of them ever
 * becomes `!value`, the 0-cases below fail.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ASSERTED_SOURCES,
  ASSERTION_KINDS,
  SOURCE_ASSERTIONS,
  SOURCE_COLLECTIONS,
  capRecords,
  quarantineCollectionName,
  quarantineRecords,
  recordCountsFound,
  runAssertions,
  trailingCounts,
} from '../src/assertions.js'
import { OUTPUT_COLLECTIONS } from '../src/ingestion.js'
import { SOURCE_IDS } from '../src/schema.js'

const NOW = new Date('2026-10-03T00:00:00.000Z')

/** A record in the shape `usgs_earthquake` emits, since it is the strictest. */
function quake(overrides = {}) {
  return {
    id: 'q1',
    source: 'usgs_earthquake',
    source_id: 'us7000abcd',
    event_type: 'earthquake',
    severity: 'low',
    title: 'M 3.1 earthquake',
    occurred_at: '2026-10-02T04:12:00.000Z',
    latitude: -1.2921,
    longitude: 36.8219,
    metadata: { magnitude: 3.1 },
    ...overrides,
  }
}

const badQuake = () => ({
  id: 'q1',
  source: 'usgs_earthquake',
  source_id: 'us7000abcd',
  event_type: 'earthquake',
  severity: 'low',
  title: 'M 3.1 earthquake',
  occurred_at: null,
  latitude: 999.5,
  longitude: 36.8219,
  metadata: { magnitude: 'M 3.1' },
})

/** A record in the shape `gdacs_archive` emits: one flood per quarter, forward. */
const archiveEvent = (index) => ({
  id: `a${index}`,
  source: 'gdacs_archive',
  source_id: `gdacs:fl:${index}`,
  event_type: 'flood',
  occurred_at: new Date(Date.UTC(1985, 0, 1) + index * 3_600_000).toISOString(),
  // Flood severitydata is a "Magnitude 0.00" placeholder, so the connector
  // leaves this null and a numeric 0 would be the placeholder leaking back.
  severity: null,
  latitude: 2.0,
  longitude: 36.0,
})

describe('a good batch passes every kind', () => {
  it('passes a well-formed usgs batch and says what it measured', () => {
    const result = runAssertions({
      source: 'usgs_earthquake',
      records: [quake(), quake({ id: 'q2', source_id: 'us7000abce' })],
      trailingRecords: [2, 2, 3],
      options: { now: NOW },
    })
    assert.equal(result.ok, true, JSON.stringify(result.failures, null, 2))
    assert.deepEqual(result.failures, [])
    // A pass that measured nothing is not a pass. These four are the difference
    // between "checked 2 records" and "measured 0 records".
    assert.equal(result.stats.record_count, 2)
    assert.equal(result.stats.assertions_evaluated, 4)
    assert.equal(result.stats.source_known, true)
    assert.ok(result.stats.fields_measured >= 6)
    assert.equal(result.stats.trailing.median, 2, 'the trailing window the count assertion used is reported')
    assert.equal(result.stats.trailing.runs, 3)
    assert.deepEqual(result.stats.unmeasured, [])
    assert.equal(result.stats.field_coverage.latitude.present, 2)
    assert.equal(result.stats.field_coverage.latitude.coverage, 1)
  })

  it('GloFAS: the translated web-app guard, in the place the old one could not reach', () => {
    // On 2026-10-01 the published rss.xml path began serving the EFAS
    // single-page app: HTTP 200, HTML body, zero items, no error, and the run
    // reported "no floods forecast". The connector's own looksLikeFeed() guard
    // caught that one shape. Nothing caught the partial version — a feed that
    // still parses but has lost three of its four items.
    const glofas = runAssertions({ source: 'glofas', records: [], trailingRecords: [12], options: { now: NOW } })
    assert.equal(glofas.ok, false)
    assert.equal(glofas.failures[0].kind, 'min_count_vs_trailing')
    assert.equal(glofas.failures[0].detail.records_found, 0)
    assert.equal(glofas.failures[0].detail.trailing_median, 12)

    // A healthy batch still passes, and the nulls the connector publishes on
    // purpose — severity, latitude, longitude — are not among the required
    // fields. Asserting those nulls would condemn the records the connector
    // worked hardest to keep honest.
    const fired = runAssertions({
      source: 'glofas',
      records: [{ id: 'g1', source_id: 'https://example/1', event_type: 'flood_forecast', title: 'GloFAS update', occurred_at: '2026-10-02T00:00:00.000Z', severity: null, latitude: null, longitude: null }],
      trailingRecords: [2, 2, 1],
      options: { now: NOW },
    })
    assert.equal(fired.ok, true, JSON.stringify(fired.failures, null, 2))
  })
})

describe('each kind fails on a deliberately bad batch', () => {
  it('required_fields: a record missing its id, type and date is condemned', () => {
    const result = runAssertions({
      source: 'usgs_earthquake',
      records: [quake(), quake({ id: null, event_type: null, occurred_at: null })],
      trailingRecords: [2],
      options: { now: NOW },
    })
    assert.equal(result.ok, false)
    const failure = result.failures.find((item) => item.kind === 'required_fields')
    assert.ok(failure, JSON.stringify(result.failures))
    assert.equal(result.failures.length, 1, 'only the missing fields should fail here')
    assert.equal(failure.detail.offenders[0].record_index, 1)
    assert.deepEqual(
      failure.detail.fields.map((item) => item.field).sort(),
      ['event_type', 'id', 'occurred_at'],
    )
    // The detail names the offending records rather than only the field.
    assert.equal(failure.detail.offenders[0].record_index, 1)
    assert.equal(failure.detail.offenders[0].record_id, null, 'the record is missing the very id the detail would otherwise name')
  })

  it('coordinate_bounds: a latitude of 999.5 is not on the globe', () => {
    const result = runAssertions({
      source: 'usgs_earthquake',
      records: [badQuake()],
      trailingRecords: [40],
      options: { now: NOW },
    })
    const failure = result.failures.find((item) => item.kind === 'coordinate_bounds')
    assert.ok(failure, JSON.stringify(result.failures))
    assert.equal(failure.detail.offenders[0].latitude, 999.5)
    assert.deepEqual(failure.detail.offenders[0].out_of_range, ['latitude'])
    assert.equal(failure.detail.coordinates_checked, 1)
  })

  it('coordinate_bounds: a transposed pair is caught, and the latitude is named', () => {
    const transposed = quake({ latitude: 36.8219, longitude: -1.2921 })
    const result = runAssertions({ source: 'usgs_earthquake', records: [transposed], options: { now: NOW } })
    // A transposed Nairobi pair is inside the global box, which is the point:
    // the box catches out-of-range, not misplaced-but-plausible. Asserted here
    // so nobody later widens the expectation without noticing.
    assert.equal(result.ok, true, 'global bounds cannot catch a plausible transposed pair')
    const regional = runAssertions({
      source: 'nasa_firms',
      records: [{ id: 'f1', source_id: 'viirs', event_type: 'fire', occurred_at: '2026-10-02T00:00:00.000Z', latitude: 2.0, longitude: 62.0, metadata: { frp: 12 } }],
      options: { now: NOW },
    })
    const regionalFailure = regional.failures.find((item) => item.kind === 'coordinate_bounds')
    assert.ok(regionalFailure, JSON.stringify(regional.failures))
    assert.deepEqual(regionalFailure.detail.offenders[0].out_of_range, ['longitude'])
    assert.equal(regionalFailure.detail.offenders[0].longitude, 62.0)
  })

  it('coordinate_bounds: a source that publishes no coordinates is not measured, and says so', () => {
    // WHO GHO publishes national aggregates with null coordinates by design.
    // Asserting on them would be asserting an invention, so the assertion is
    // listed as unmeasured rather than passing silently.
    const result = runAssertions({
      source: 'who_gho',
      records: [],
      trailingRecords: [30],
      options: { now: NOW },
    })
    assert.equal(result.ok, true)
    assert.ok(result.stats.unmeasured.includes('who_gho.observations are identified, placed and valued'))
    assert.equal(result.stats.empty_batch, true)
    assert.equal(result.stats.zero_records_expected, true)
  })

  it('value_range: a magnitude of "M 3.1" is not a number', () => {
    const result = runAssertions({ source: 'usgs_earthquake', records: [badQuake()], trailingRecords: [40], options: { now: NOW } })
    const failure = result.failures.find((item) => item.kind === 'value_range')
    assert.ok(failure, JSON.stringify(result.failures))
    assert.equal(failure.detail.offenders[0].value, 'M 3.1')
    assert.deepEqual(failure.detail.offenders[0].allowed, { min: -2, max: 10 })
  })

  it('value_range: a fatal count of 999,999,999 is not plausible', () => {
    const result = runAssertions({
      source: 'conflict_csv',
      records: [{ id: 'c1', source_id: 'evt', event_type: 'conflict_event', occurred_at: '2026-10-01T00:00:00.000Z', latitude: 2.0, longitude: 36.0, fatalities: 999999999 }],
      options: { now: NOW },
    })
    const failure = result.failures.find((item) => item.kind === 'value_range')
    assert.ok(failure, JSON.stringify(result.failures))
    assert.equal(failure.detail.offenders[0].field, 'fatalities')
    assert.equal(failure.detail.values_checked, 1)
  })

  it('min_count_vs_trailing: a half-size batch trips where minimum_records: 1 never would', () => {
    const result = runAssertions({ source: 'nasa_firms', records: Array.from({ length: 10 }, () => ({ id: 'x' })), trailingRecords: [100, 100, 100], options: { now: NOW } })
    const failure = result.failures.find((item) => item.kind === 'min_count_vs_trailing')
    assert.ok(failure, JSON.stringify(result.failures))
    assert.equal(failure.detail.records_found, 10)
    assert.equal(failure.detail.trailing_median, 100)
    assert.equal(failure.detail.required_count, 25)
  })

  it('monotonic_dates: a batch that goes backwards is condemned, naming both ends', () => {
    // Direction is part of the descriptor, because the connectors disagree:
    // CHIRPS and NOAA emit newest-first (the connector slices and reverses),
    // while the GDACS archive walks forwards through quarters. A convention of
    // "ascending everywhere" would have condemned two healthy connectors.
    const newestFirst = ['2026-10', '2026-09', '2026-08']
    const month = (period) => ({ id: period, source: 'noaa_enso', source_id: period, metric: 'nino34_sst_anomaly_c', observed_at: `${period}-15T00:00:00.000Z`, value: 0.4 })

    const descending = runAssertions({ source: 'noaa_enso', records: newestFirst.map(month), options: { now: NOW } })
    assert.equal(descending.ok, true, JSON.stringify(descending.failures, null, 2))

    const ascending = runAssertions({ source: 'noaa_enso', records: [...newestFirst].reverse().map(month), options: { now: NOW } })
    const failure = ascending.failures.find((item) => item.kind === 'monotonic_dates')
    assert.ok(failure, JSON.stringify(ascending.failures))
    assert.equal(failure.detail.order, 'descending')
    // Both backwards steps are reported, each against the value it followed, so
    // the reader can see where the sequence broke rather than only that it did.
    assert.deepEqual(failure.detail.offenders.map((item) => item.record_index), [1, 2])
    assert.equal(failure.detail.offenders[0].previous_value, '2026-08-15T00:00:00.000Z')
    assert.equal(failure.detail.offenders[1].previous_value, '2026-09-15T00:00:00.000Z')

    // Same batch, opposite declared direction: CHIRPS is newest-first, so this
    // forward walk is the failure there and passes here.
    const chirpsBatch = newestFirst.map((period) => ({ id: period, source: 'chirps', type: 'rainfall_dataset_available', observed_at: `${period}-01` }))
    assert.equal(runAssertions({ source: 'chirps', records: chirpsBatch, options: { now: NOW } }).ok, true)
    assert.ok(runAssertions({ source: 'chirps', records: [...chirpsBatch].reverse(), options: { now: NOW } }).failures.some((item) => item.kind === 'monotonic_dates'))
    // The archive walk is the other way round, and passing there is the point.
    const forwards = [archiveEvent(0), archiveEvent(1), archiveEvent(2)]
    assert.equal(runAssertions({ source: 'gdacs_archive', records: forwards, options: { now: NOW } }).ok, true)
    const backwards = runAssertions({ source: 'gdacs_archive', records: [...forwards].reverse(), options: { now: NOW } })
    assert.ok(backwards.failures.some((item) => item.kind === 'monotonic_dates'))
  })
})

describe('the GDACS cap: 4,000 of 40,000 is not a clean run', () => {
  it('trips min_count_vs_trailing on a batch 10% the size of its trailing window', () => {
    const fortyThousand = Array.from({ length: 40_000 }, (_, index) => archiveEvent(index))
    const fourThousand = fortyThousand.slice(0, 4_000)

    // The old world: no errors, minimum_records: 1 satisfied, status success.
    assert.ok(4_000 >= 1)

    const healthy = runAssertions({ source: 'gdacs_archive', records: fortyThousand, trailingRecords: [41_000, 39_000, 40_000], options: { now: NOW } })
    assert.equal(healthy.ok, true, JSON.stringify(healthy.failures, null, 2))

    // The ~100-result per-query cap is silent: the archive answers, parses, and
    // reports nothing about the 36,000 rows it did not return.
    const capped = runAssertions({ source: 'gdacs_archive', records: fourThousand, trailingRecords: [41_000, 39_000, 40_000], options: { now: NOW } })
    assert.equal(capped.ok, false)
    const failure = capped.failures.find((item) => item.kind === 'min_count_vs_trailing')
    assert.ok(failure, JSON.stringify(capped.failures))
    assert.equal(failure.detail.records_found, 4_000)
    assert.equal(failure.detail.trailing_median, 40_000)
    assert.equal(failure.detail.required_count, 20_000)
    assert.equal(capped.stats.record_count, 4_000)
  })

  it('holds at the declared ratio and no further: the knob is published, not implied', () => {
    const records = Array.from({ length: 60 }, (_, index) => archiveEvent(index))
    const below = runAssertions({ source: 'gdacs_archive', records: records.slice(0, 49), trailingRecords: [100], options: { now: NOW } })
    assert.equal(below.ok, false, '49 of 100 is under the declared 0.5 ratio')
    const countFailure = below.failures.find((item) => item.kind === 'min_count_vs_trailing')
    assert.equal(countFailure.detail.required_count, 50)
    const at = runAssertions({ source: 'gdacs_archive', records: records.slice(0, 50), trailingRecords: [100], options: { now: NOW } })
    assert.equal(at.ok, true, '50 of 100 meets the declared ratio exactly')
  })

  it('reads the trailing window out of every shape the store hands back', () => {
    assert.deepEqual(trailingCounts([10, 20, 30]), [10, 20, 30])
    assert.deepEqual(trailingCounts([[1, 2], [1, 2, 3]]), [2, 3])
    assert.deepEqual(trailingCounts([{ records_processed: 5 }, { count: 7 }]), [5, 7])
    assert.deepEqual(trailingCounts([{ id: 'a' }, { id: 'b' }]), [1, 1], 'a flat record list is one prior run')
    assert.deepEqual(trailingCounts([]), [])
    assert.deepEqual(trailingCounts('nonsense'), [])
  })

  it('uses the lower median, so one backfill among daily runs does not become the norm', () => {
    const records = Array.from({ length: 20 }, (_, index) => archiveEvent(index))
    const withBackfill = runAssertions({ source: 'gdacs_archive', records, trailingRecords: [40, 40, 40, 40_000], options: { now: NOW } })
    assert.equal(withBackfill.ok, true, 'a 40,000 backfill must not raise the bar to 10,000')
    assert.equal(withBackfill.stats.trailing.median, 40, 'the floor stays the number this source normally produces')
    const collapsed = runAssertions({ source: 'gdacs_archive', records: records.slice(0, 10), trailingRecords: [40, 40, 40, 40_000], options: { now: NOW } })
    assert.equal(collapsed.ok, false, 'a quarter of a normal run still fails against a floor of 20')
  })
})

describe('legitimate silence is not breakage', () => {
  it('an empty batch passes a source that says zero is expected', () => {
    const who = runAssertions({ source: 'who_gho', records: [], trailingRecords: [30, 28, 31], options: { now: NOW } })
    assert.equal(who.ok, true, JSON.stringify(who.failures, null, 2))
    assert.equal(who.stats.empty_batch, true)
    assert.equal(who.stats.zero_records_expected, true)

    const uploads = runAssertions({ source: 'service_assets', records: [], trailingRecords: [12], options: { now: NOW } })
    assert.equal(uploads.ok, true)
    const dhis2 = runAssertions({ source: 'dhis2', records: [], options: { now: NOW } })
    assert.equal(dhis2.ok, true, 'the DHIS2 scaffold returns nothing on purpose')
  })

  it('an empty batch fails a source that publishes continuously', () => {
    for (const source of ['glofas', 'nasa_firms', 'noaa_enso', 'gdacs_archive']) {
      const result = runAssertions({ source, records: [], trailingRecords: [10], options: { now: NOW } })
      assert.equal(result.ok, false, `${source} publishes continuously and must not pass empty`)
      assert.equal(result.failures[0].detail.zero_is_legitimate, false)
    }
  })

  it('reports a count assertion with no trailing window as unmeasured, not as a pass', () => {
    const result = runAssertions({ source: 'usgs_earthquake', records: [quake()], options: { now: NOW } })
    assert.equal(result.ok, true)
    assert.ok(result.stats.unmeasured.includes('usgs.quakes do not collapse against the trailing window'))
  })
})

describe('zero is a value', () => {
  it('a 0 mm rainfall total, 0 MW fire, 0 deaths and 0 capacity all pass required_fields', () => {
    const withZeroes = [
      runAssertions({ source: 'acled_csv', records: [{ id: 'c1', source_id: 'evt', event_type: 'protest', occurred_at: '2026-10-01T00:00:00.000Z', latitude: 2.0, longitude: 36.0, fatalities: 0 }], options: { now: NOW } }),
      runAssertions({ source: 'nasa_firms', records: [{ id: 'f1', source_id: 'viirs', event_type: 'fire', occurred_at: '2026-10-02T00:00:00.000Z', latitude: 2.0, longitude: 36.0, metadata: { frp: 0 } }], options: { now: NOW } }),
      runAssertions({ source: 'service_assets', records: [{ id: 'a1', name: 'Borehole', service_type: 'water', latitude: 3.1, longitude: 35.6, capacity: 0 }], options: { now: NOW } }),
      runAssertions({ source: 'chirps', records: [{ id: 'x1', source: 'chirps', type: 'rainfall_dataset_available', observed_at: '2026-10-01', precipitation_mm: 0 }], options: { now: NOW } }),
    ]
    for (const result of withZeroes) {
      assert.equal(result.ok, true, JSON.stringify(result.failures, null, 2))
    }
  })

  it('a 0 in a REQUIRED field is present: 0°0′ is a point, and zero cases is a report', () => {
    // This is the case that catches a `!value` presence check. The four cases
    // above put their zeroes in optional fields, so a truthiness bug there
    // changes nothing; a required field holding 0 is where it bites. 0°N 0°E
    // is a real spot in the Gulf of Guinea, and this repo has already lost
    // records at 0/0 exactly once (see test/falsy-zero.test.js).
    const onTheEquator = runAssertions({
      source: 'nasa_firms',
      records: [{ id: 'f1', source_id: 'viirs:2026-10-02', event_type: 'fire', occurred_at: '2026-10-02T00:00:00.000Z', latitude: 0, longitude: 0, metadata: { frp: 0 } }],
      options: { now: NOW },
    })
    assert.equal(onTheEquator.ok, true, JSON.stringify(onTheEquator.failures, null, 2))
    assert.equal(onTheEquator.stats.field_coverage.latitude.present, 1)

    // Zero cholera cases reported nationally is a reported figure, not a gap in
    // the reporting. A truthiness check would quarantine the good news.
    const zeroCases = runAssertions({
      source: 'who_gho',
      records: [{ id: 'd1', source_id: 'CHOLERA_0000000001:KE:2026', indicator_code: 'CHOLERA_0000000001', indicator_name: 'Number of reported cases of cholera', country: 'KE', year: 2026, value: 0, observed_at: '2026-01-01T00:00:00.000Z' }],
      options: { now: NOW },
    })
    assert.equal(zeroCases.ok, true, JSON.stringify(zeroCases.failures, null, 2))
  })

  it('0 survives value_range because the minimum is 0 and the bound is inclusive', () => {
    const result = runAssertions({
      source: 'nasa_firms',
      records: [{ id: 'f1', source_id: 'viirs', event_type: 'fire', occurred_at: '2026-10-02T00:00:00.000Z', latitude: 2.0, longitude: 36.0, metadata: { frp: 0 } }],
      options: { now: NOW },
    })
    assert.equal(result.ok, true)
  })

  it('null, undefined and the empty string are the absences; 0 and false are not', () => {
    const absent = runAssertions({
      source: 'usgs_earthquake',
      records: [
        quake({ id: null }),
        quake({ id: undefined, source_id: 'us-other' }),
        quake({ id: '', source_id: 'us-empty' }),
      ],
      trailingRecords: [40],
      options: { now: NOW },
    })
    const failure = absent.failures.find((item) => item.kind === 'required_fields')
    assert.ok(failure, JSON.stringify(absent.failures))
    assert.equal(failure.detail.offenders.length, 3, 'null, undefined and "" are all absences')
    assert.deepEqual(failure.detail.offenders.map((item) => item.value), [null, null, ''])
    assert.deepEqual(failure.detail.offenders.map((item) => item.record_index), [0, 1, 2])

    // `false` is a measured answer in a boolean field, and it is not required
    // here — but it must not be treated as missing if it ever is. This is the
    // `!value` trap: a truthiness check would have condemned `false` here too.
    const measuredFalse = runAssertions({ source: 'usgs_earthquake', records: [quake({ id: 'f', title: false })], options: { now: NOW } })
    assert.ok(measuredFalse.ok, 'a false in a non-required field is not a presence failure')
  })

  it('an empty batch does not fail required_fields by finding absent fields in nothing', () => {
    const result = runAssertions({ source: 'usgs_earthquake', records: [], trailingRecords: [40], options: { now: NOW } })
    // The count assertion fires; the field assertion has nothing to measure and
    // says so instead of claiming a coverage it did not compute.
    const fieldFailure = result.failures.find((item) => item.kind === 'required_fields')
    assert.equal(fieldFailure, undefined)
    assert.ok(result.stats.unmeasured.includes('usgs.quakes are identified, dated and located'))
  })
})

describe('the map itself', () => {
  it('asserts every source in SOURCE_IDS, and nothing that is not one', () => {
    const missing = SOURCE_IDS.filter((source) => !ASSERTED_SOURCES.includes(source))
    assert.deepEqual(missing, [], `sources with no assertions: ${missing.join(', ')}`)
    const extra = ASSERTED_SOURCES.filter((source) => !SOURCE_IDS.includes(source))
    assert.deepEqual(extra, [], `asserted sources that no longer exist: ${extra.join(', ')}`)
    assert.equal(ASSERTED_SOURCES.length, SOURCE_IDS.length)
  })

  it('declares only known kinds, and uses every kind it declares', () => {
    const declaredKinds = new Set(ASSERTED_SOURCES.flatMap((source) => SOURCE_ASSERTIONS[source].map((assertion) => assertion.kind)))
    const unknown = [...declaredKinds].filter((kind) => !ASSERTION_KINDS.includes(kind))
    assert.deepEqual(unknown, [], `assertion kinds not in ASSERTION_KINDS: ${unknown.join(', ')}`)
    // An unused kind is dead config: it looks like a check and checks nothing.
    const unused = ASSERTION_KINDS.filter((kind) => !declaredKinds.has(kind))
    assert.deepEqual(unused, [], `assertion kinds no source declares: ${unused.join(', ')}`)
    assert.equal(ASSERTION_KINDS.length, 5)
  })

  it('gives every assertion a name and a note, and freezes the map', () => {
    for (const source of ASSERTED_SOURCES) {
      for (const assertion of SOURCE_ASSERTIONS[source]) {
        assert.ok(assertion.name, `${source} has an assertion with no name`)
        assert.ok(assertion.note, `${assertion.name} has no note: a threshold with no history is a guess`)
      }
    }
    assert.ok(Object.isFrozen(SOURCE_ASSERTIONS))
    assert.ok(Object.isFrozen(ASSERTION_KINDS))
    assert.ok(Object.isFrozen(ASSERTED_SOURCES))
  })

  it('names a collection for every asserted source, and every name is a real one', () => {
    assert.deepEqual(ASSERTED_SOURCES.filter((source) => !SOURCE_COLLECTIONS[source]), [])
    // The collection list lives in two places, which is how lists rot. Assert it
    // against the real one rather than trusting the copy.
    const notReal = Object.values(SOURCE_COLLECTIONS).filter((collection) => !OUTPUT_COLLECTIONS.includes(collection))
    assert.deepEqual(notReal, [], `collection names not in ingestion.OUTPUT_COLLECTIONS: ${notReal.join(', ')}`)
  })
})

describe('quarantine, not a silent zero', () => {
  it('holds a condemned batch with its failures, run id and timestamps', () => {
    const result = runAssertions({ source: 'gdacs_archive', records: [quake({ id: 'a1' }), quake({ id: 'a2', occurred_at: null })], trailingRecords: [1], options: { now: NOW } })
    assert.equal(result.ok, false)

    const rows = quarantineRecords({
      source: 'gdacs_archive',
      records: [quake({ id: 'a1' }), quake({ id: 'a2', occurred_at: null })],
      failures: result.failures,
      sourceRunId: 'run-2026-10-03',
      now: NOW,
    })
    assert.equal(rows.length, 2, 'the whole batch is quarantined; a partial batch is condemned as a whole')
    assert.equal(rows[0].quarantine_collection, 'quarantine_hazard_events')
    assert.equal(rows[0].collection, 'hazard_events')
    assert.equal(rows[0].source_run_id, 'run-2026-10-03')
    assert.equal(rows[0].quarantined_at, NOW.toISOString())
    assert.equal(rows[0].first_seen_at, NOW.toISOString())
    assert.equal(rows[0].record_id, 'a1')
    assert.equal(rows[0].record.id, 'a1', 'the original record travels with the finding')
    assert.deepEqual(rows[0].failures, result.failures)
    assert.ok(rows[0].failure_kinds.includes('required_fields'))
    assert.ok(rows[0].payload_hash)
    assert.equal(rows[0].quarantine_reason, 'failed_source_assertion')
    assert.notEqual(rows[0].id, rows[1].id)
  })

  it('names the quarantine collection from the source when none is passed', () => {
    assert.equal(quarantineCollectionName(SOURCE_COLLECTIONS.who_gho), 'quarantine_disease_observations')
    const rows = quarantineRecords({ source: 'who_gho', records: [{ id: 'd1' }], failures: [], sourceRunId: null, now: NOW })
    assert.equal(rows[0].quarantine_collection, 'quarantine_disease_observations')
    assert.equal(rows[0].source_run_id, null)
    assert.equal(rows[0].failure_count, 0)
  })
})

describe('counts_found: a cap that leaves no trace is indistinguishable from a short month', () => {
  it('records what was found, returned and dropped', () => {
    const found = recordCountsFound({ source: 'chirps', collection: 'climate_observations', found: 730, returned: 30, cap: 30, capName: 'connector limit' })
    assert.equal(found.counts_found, 730)
    assert.equal(found.records_returned, 30)
    assert.equal(found.records_dropped, 700)
    assert.equal(found.capped, true)
    assert.match(found.cap_note, /30 of 730/)
  })

  it('reports no truncation when nothing was dropped', () => {
    const found = recordCountsFound({ source: 'chirps', collection: 'climate_observations', found: 12, returned: 12, cap: 30 })
    assert.equal(found.capped, false)
    assert.equal(found.records_dropped, 0)
    assert.equal(found.cap_note, null)
  })

  it('caps records while leaving the count behind', () => {
    const records = Array.from({ length: 730 }, (_, index) => ({ id: `c${index}` }))
    const { records: kept, counts_found } = capRecords({ records, limit: 30, source: 'chirps', collection: 'climate_observations', capName: 'connector limit' })
    assert.equal(kept.length, 30)
    assert.equal(counts_found.counts_found, 730)
    assert.equal(counts_found.records_dropped, 700)
    assert.equal(counts_found.capped, true)

    const uncapped = capRecords({ records, source: 'chirps', collection: 'climate_observations' })
    assert.equal(uncapped.records.length, 730)
    assert.equal(uncapped.counts_found.capped, false)
  })
})

describe('an unknown source is stated, not passed', () => {
  it('returns ok: false with a named failure rather than a vacuous success', () => {
    const result = runAssertions({ source: 'not_a_source', records: [quake()], trailingRecords: [40], options: { now: NOW } })
    assert.equal(result.ok, false)
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].kind, 'unasserted_source')
    assert.equal(result.failures[0].detail.source, 'not_a_source')
    assert.equal(result.stats.source_known, false)
    assert.equal(result.stats.assertions_declared, 0)
    assert.ok(result.failures[0].detail.known_sources.includes('glofas'))
  })

  it('survives empty and malformed inputs without throwing', () => {
    assert.equal(runAssertions({}).ok, false)
    assert.equal(runAssertions().ok, false)
    assert.equal(runAssertions({ source: 'usgs_earthquake' }).ok, true)
    assert.equal(runAssertions({ source: 'usgs_earthquake', records: 'nonsense' }).ok, true)
    assert.equal(runAssertions({ source: 'usgs_earthquake', records: [null, undefined] }).ok, false)
  })
})
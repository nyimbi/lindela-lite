#!/usr/bin/env node
/**
 * ENH-56, the third hazard — flood, conflict and disease jointly.
 *
 * The entry names three hazards and the module shipped two. This file covers the
 * three-hazard entry point, and the cases it exists for are the ones where
 * adding a third input changes the answer rather than the shape.
 *
 * The difficulty is not the arithmetic — a joint over three sets is the same
 * count as a joint over two. It is that **the disease input is shaped
 * differently from the other two**, and both differences are silent if a reader
 * is careless:
 *
 *   1. Disease records carry `observed_at`; hazards and conflicts carry
 *      `occurred_at`. A reader that reads only `occurred_at` counts zero
 *      disease-months and reports the hazard *absent* — a refusal that reads
 *      like a finding about the data and is a bug in the reader.
 *   2. WHO-GHO records are national **annual** aggregates stamped `YYYY-01-01`.
 *      Counting them manufactures a January disease-month in every year of the
 *      series and inflates the joint rate with months that share only a
 *      calendar.
 *
 * Both are asserted here rather than left to the header, because both are the
 * kind of defect that produces a plausible number.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MIN_COMPOUND_MONTHS,
  compoundHazardScoreThree,
} from '../src/compound-hazard.js'

/** A hazard event in a month — the `occurred_at` shape. */
const hazard = (month, eventType = 'flood') => ({
  event_type: eventType,
  occurred_at: `${month}-15T00:00:00.000Z`,
})

const clash = (month) => ({
  event_type: 'civil_unrest',
  occurred_at: `${month}-20T00:00:00.000Z`,
})

/** An epidemic event — the `observed_at` shape, which is the point. */
const outbreak = (month) => ({
  disease: 'cholera',
  observed_at: `${month}-10T00:00:00.000Z`,
})

/** A WHO-GHO national annual aggregate, stamped to January of its year. */
const annualAggregate = (year) => ({
  disease: 'malaria',
  observed_at: `${year}-01-01T00:00:00.000Z`,
  first_seen_source_type: 'national_annual_aggregate',
})

/** Twelve months of one year, so a window is always long enough. */
const YEAR = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']
  .map((m) => `2024-${m}`)

describe('ENH-56 third hazard — the joint over three', () => {
  it('counts all three marginals and the triple over a declared window', () => {
    const result = compoundHazardScoreThree({
      hazardEvents: [hazard('2024-03'), hazard('2024-04')],
      conflictEvents: [clash('2024-04'), clash('2024-05')],
      diseaseEvents: [outbreak('2024-04'), outbreak('2024-06')],
      from: '2024-01', to: '2024-12',
    })
    const c = result.contingency
    assert.equal(c.months, 12)
    assert.equal(c.flood_months, 2)
    assert.equal(c.conflict_months, 2)
    assert.equal(c.disease_months, 2)
    // Only April carries all three.
    assert.equal(c.all_three_months, 1)
    assert.equal(c.both_flood_conflict_months, 1)
    assert.equal(c.both_flood_disease_months, 1)
    assert.equal(c.both_conflict_disease_months, 1)
  })

  it('reads `observed_at` for disease, so an outbreak is not reported as absent', () => {
    // The failure this guards: a reader that reads only `occurred_at` sees zero
    // disease-months and refuses with "no disease-month in this window" — a
    // refusal that looks like a finding about the data and is a bug in the
    // reader. Every disease record in the tree uses `observed_at`.
    const result = compoundHazardScoreThree({
      hazardEvents: YEAR.map((m) => hazard(m)),
      conflictEvents: YEAR.map((m) => clash(m)),
      diseaseEvents: [outbreak('2024-04')],
      from: '2024-01', to: '2024-12',
    })
    assert.equal(result.contingency.disease_months, 1)
    assert.notEqual(result.score, null, 'disease must not be read as absent')
  })

  it('excludes a national annual aggregate and says how many it excluded', () => {
    // A WHO-GHO row is a year stamped January. Counting it would put a
    // disease-month in every January of the series. The exclusion is returned
    // rather than silent: a dropped input is a denominator nobody can check.
    const result = compoundHazardScoreThree({
      hazardEvents: YEAR.map((m) => hazard(m)),
      conflictEvents: YEAR.map((m) => clash(m)),
      diseaseEvents: [annualAggregate(2023), annualAggregate(2024), outbreak('2024-04')],
      from: '2024-01', to: '2024-12',
    })
    assert.equal(result.contingency.excluded_annual_aggregates, 2)
    assert.equal(result.contingency.disease_months, 1, 'only the real outbreak is a disease-month')
  })

  it('gives two regions with the same marginals different scores when the triple lift differs', () => {
    // The property the two-hazard version asserts, carried to three: a joint
    // model that agrees with its marginals is a weighted sum wearing a joint
    // model's name.
    const build = (overlapMonths) => compoundHazardScoreThree({
      hazardEvents: [hazard('2024-02'), hazard('2024-03'), hazard('2024-04')],
      conflictEvents: [clash('2024-02'), clash('2024-03'), clash('2024-05')],
      diseaseEvents: overlapMonths.map((m) => outbreak(m)),
      from: '2024-01', to: '2024-12',
    })
    const overlapping = build(['2024-02', '2024-03'])
    const disjoint = build(['2024-07', '2024-08'])
    // Identical marginals: three flood, three conflict, two disease.
    assert.equal(overlapping.contingency.disease_months, disjoint.contingency.disease_months)
    assert.equal(overlapping.contingency.flood_months, disjoint.contingency.flood_months)
    assert.ok(overlapping.score > disjoint.score, 'co-occurrence must score above disjointness')
  })

  it('carries the pairwise lifts, because a planner needs to know which pair drives it', () => {
    const result = compoundHazardScoreThree({
      hazardEvents: YEAR.map((m) => hazard(m)),
      conflictEvents: YEAR.map((m) => clash(m)),
      diseaseEvents: YEAR.map((m) => outbreak(m)),
      from: '2024-01', to: '2024-12',
    })
    // Every month carries all three, so each pair co-occurs at rate 1.
    assert.equal(result.contingency.pair_lifts.flood_conflict, 1)
    assert.equal(result.contingency.pair_lifts.flood_disease, 1)
    assert.equal(result.contingency.pair_lifts.conflict_disease, 1)
    // And the triple, against the product of three marginals of 1, is 1.
    assert.equal(result.contingency.lift_all_three, 1)
  })
})

describe('ENH-56 third hazard — the refusals', () => {
  it('names which of the three hazards is absent, not just that one is', () => {
    // With three hazards the three absences have different remedies — a window
    // with no disease is a surveillance gap, one with no flood is a dry record —
    // so "no hazard-month" would not be actionable.
    const result = compoundHazardScoreThree({
      hazardEvents: YEAR.map((m) => hazard(m)),
      conflictEvents: YEAR.map((m) => clash(m)),
      diseaseEvents: [],
      from: '2024-01', to: '2024-12',
    })
    assert.equal(result.score, null)
    assert.match(result.reason, /no disease-month/)
    assert.doesNotMatch(result.reason, /flood/)
  })

  it('names every absent hazard when more than one is missing', () => {
    const result = compoundHazardScoreThree({
      hazardEvents: YEAR.map((m) => hazard(m)),
      conflictEvents: [],
      diseaseEvents: [],
      from: '2024-01', to: '2024-12',
    })
    assert.equal(result.score, null)
    assert.match(result.reason, /conflict/)
    assert.match(result.reason, /disease/)
  })

  it('refuses a window shorter than the floor rather than reporting a rate', () => {
    const short = YEAR.slice(0, MIN_COMPOUND_MONTHS - 4)
    const result = compoundHazardScoreThree({
      hazardEvents: short.map((m) => hazard(m)),
      conflictEvents: short.map((m) => clash(m)),
      diseaseEvents: short.map((m) => outbreak(m)),
      from: '2024-01', to: '2024-06',
    })
    assert.equal(result.score, null)
    assert.equal(result.level, 'unknown')
    assert.match(result.reason, /curve through noise/)
  })

  it('leaves the triple lift null rather than dividing by a zero marginal', () => {
    // `0/0` is no denominator, not "no dependence". The guard must hold on the
    // triple exactly as it does on the pair.
    const result = compoundHazardScoreThree({
      hazardEvents: YEAR.map((m) => hazard(m)),
      conflictEvents: YEAR.map((m) => clash(m)),
      diseaseEvents: [],
      from: '2024-01', to: '2024-12',
    })
    assert.equal(result.contingency.p_disease, 0)
    assert.equal(result.contingency.lift_all_three, null)
    assert.equal(result.contingency.p_all_three_if_independent, null)
  })

  it('ignores an undated disease event instead of dating it to the epoch or to now', () => {
    const result = compoundHazardScoreThree({
      hazardEvents: YEAR.map((m) => hazard(m)),
      conflictEvents: YEAR.map((m) => clash(m)),
      diseaseEvents: [{ disease: 'cholera' }, outbreak('2024-04')],
      from: '2024-01', to: '2024-12',
    })
    assert.equal(result.contingency.disease_months, 1)
    assert.equal(result.contingency.excluded_annual_aggregates, 0)
  })

  it('refuses an empty record rather than reporting a joint rate of zero', () => {
    const result = compoundHazardScoreThree({})
    assert.equal(result.score, null)
    assert.equal(result.contingency.months, 0)
    assert.notEqual(result.reason, null)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MIN_COMPOUND_MONTHS,
  compoundContingency,
  compoundHazardScore,
} from '../src/compound-hazard.js'

const at = (month, eventType = 'flood') => ({
  event_type: eventType,
  occurred_at: `${month}-15T00:00:00.000Z`,
})

const clash = (month) => ({
  event_type: 'civil_unrest',
  occurred_at: `${month}-20T00:00:00.000Z`,
})

describe('compound hazard contingency (ENH-56)', () => {
  it('counts the joint and both marginals over a declared window', () => {
    // Six months. Flood in Jan and Feb, conflict in Feb and Mar. Both: Feb.
    const c = compoundContingency({
      hazardEvents: [at('2026-01'), at('2026-02')],
      conflictEvents: [clash('2026-02'), clash('2026-03')],
      from: '2026-01',
      to: '2026-06',
    })
    assert.equal(c.months, 6)
    assert.equal(c.flood_months, 2)
    assert.equal(c.conflict_months, 2)
    assert.equal(c.both_months, 1)
    assert.equal(c.p_flood, 0.3333)
    assert.equal(c.p_conflict, 0.3333)
    assert.equal(c.p_both, 0.1667)
  })

  it('keeps the quiet months in the denominator', () => {
    // The same two events, over a window three times as long, is a third of the
    // rate. A denominator built from the months that had *something* would
    // report the same rate for both windows, which is the base-rate error.
    const short = compoundContingency({
      hazardEvents: [at('2026-01')], conflictEvents: [clash('2026-01')],
      from: '2026-01', to: '2026-02',
    })
    const long = compoundContingency({
      hazardEvents: [at('2026-01')], conflictEvents: [clash('2026-01')],
      from: '2026-01', to: '2026-06',
    })
    assert.equal(short.p_both, 0.5)
    assert.equal(long.p_both, 0.1667)
  })

  it('fills the quiet months between two events when no window is declared', () => {
    // Without `from`/`to` the window is the span the events themselves touch,
    // interior included. Otherwise two events eleven months apart would report a
    // 100% joint rate over a two-month denominator.
    const c = compoundContingency({
      hazardEvents: [at('2026-01')],
      conflictEvents: [clash('2026-12')],
    })
    assert.equal(c.months, 12)
    assert.equal(c.both_months, 0)
    assert.deepEqual(c.window, { from: '2026-01', to: '2026-12' })
  })

  it('states dependence as a lift over the product of the marginals', () => {
    // Co-occurring: both months are flood and conflict months. p_both 0.5,
    // marginals 0.5 each, independence predicts 0.25, lift 2.
    const together = compoundContingency({
      hazardEvents: [at('2026-01'), at('2026-02')],
      conflictEvents: [clash('2026-01'), clash('2026-02')],
      from: '2026-01', to: '2026-04',
    })
    assert.equal(together.p_both_if_independent, 0.25)
    assert.equal(together.lift, 2)

    // Exclusive: flood in Jan-Feb, conflict in Mar-Apr, never the same month.
    const apart = compoundContingency({
      hazardEvents: [at('2026-01'), at('2026-02')],
      conflictEvents: [clash('2026-03'), clash('2026-04')],
      from: '2026-01', to: '2026-04',
    })
    assert.equal(apart.both_months, 0)
    assert.equal(apart.lift, 0, 'a joint rate below independence is a lift below 1, reported not floored')
  })

  it('reports lift 1 for hazards that are independent over the window', () => {
    // Eight months. Flood in Jan-Feb (p .25), conflict in Feb-May (p .5). One
    // shared month, so the joint is .125 — exactly the product, so lift is 1.
    const c = compoundContingency({
      hazardEvents: [at('2026-01'), at('2026-02')],
      conflictEvents: [clash('2026-02'), clash('2026-03'), clash('2026-04'), clash('2026-05')],
      from: '2026-01', to: '2026-08',
    })
    assert.equal(c.p_flood, 0.25)
    assert.equal(c.p_conflict, 0.5)
    assert.equal(c.p_both, 0.125)
    assert.equal(c.lift, 1)
  })

  it('leaves lift null rather than dividing by a zero marginal', () => {
    const c = compoundContingency({
      hazardEvents: [at('2026-01')],
      conflictEvents: [],
      from: '2026-01', to: '2026-06',
    })
    assert.equal(c.p_conflict, 0)
    assert.equal(c.p_both, 0)
    assert.equal(c.p_both_if_independent, null)
    assert.equal(c.lift, null, '0/0 is not "no dependence", it is no denominator')
  })

  it('ignores an undated event instead of dating it to the epoch or to now', () => {
    // Either substitution puts a phantom month in the denominator and moves
    // every rate computed from it.
    const c = compoundContingency({
      hazardEvents: [at('2026-01'), { event_type: 'flood', occurred_at: null }, { event_type: 'flood' }],
      conflictEvents: [clash('2026-01')],
      from: '2026-01', to: '2026-03',
    })
    assert.equal(c.months, 3)
    assert.equal(c.flood_months, 1)
  })

  it('counts only the flood family as flood-months', () => {
    // A drought-month is the opposite of a flood-month; a fire or an earthquake
    // has no water in it. Counting them would inflate the joint rate with months
    // that share nothing with a flood but a season.
    const c = compoundContingency({
      hazardEvents: [
        at('2026-01', 'flood'), at('2026-02', 'storm'),
        at('2026-03', 'drought'), at('2026-04', 'landslide'),
        at('2026-05', 'fire'), at('2026-06', 'earthquake'), at('2026-07', 'volcano'),
      ],
      conflictEvents: [],
      from: '2026-01', to: '2026-07',
    })
    assert.equal(c.flood_months, 2, 'flood and storm are the rainfall-driven family; the other five are not')
  })

  it('refuses an empty record rather than reporting a rate of zero', () => {
    const c = compoundContingency({ hazardEvents: [], conflictEvents: [] })
    assert.equal(c.months, 0)
    assert.equal(c.p_flood, null)
    assert.equal(c.p_both, null)
    assert.equal(c.lift, null)
    assert.equal(compoundHazardScore({}).score, null)
  })
})

describe('compound hazard score (ENH-56)', () => {
  const year = (months, type = 'flood') => months.map((m) => at(m, type))
  const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
    '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']

  it('refuses a region whose record is shorter than the minimum', () => {
    const result = compoundHazardScore({
      hazardEvents: [at('2026-01')],
      conflictEvents: [clash('2026-01')],
      from: '2026-01',
      to: '2026-06',
      region: 'Mandera',
    })
    assert.equal(result.score, null)
    assert.equal(result.level, 'unknown')
    assert.match(result.reason, /6 month/)
    assert.match(result.reason, new RegExp(String(MIN_COMPOUND_MONTHS)))
  })

  it('scores the joint rate once the record is long enough', () => {
    // Twelve months, flood in three, conflict in four, both in two.
    const result = compoundHazardScore({
      hazardEvents: year(['2026-01', '2026-02', '2026-03']),
      conflictEvents: [clash('2026-02'), clash('2026-03'), clash('2026-07'), clash('2026-08')],
      from: '2026-01',
      to: '2026-12',
      region: 'Mandera',
    })
    assert.equal(result.contingency.months, 12)
    assert.equal(result.contingency.both_months, 2)
    // 2/12 = 0.1667, scaled to a 0-100 index.
    assert.equal(result.score, 17)
    assert.equal(result.level, 'medium')
    assert.equal(result.reason, null)
    assert.equal(result.basis.joint_months, 2)
    assert.equal(result.basis.of_months, 12)
    assert.ok(result.basis.lift_over_independence > 1, 'these months co-occur more than chance predicts')
  })

  it('gives two regions with the same marginals different scores when their lift differs', () => {
    // Same flood count, same conflict count. One region has them in the same
    // months, the other never. This is the information the two independent
    // scorers discard, and the reason this module exists.
    const coincident = compoundHazardScore({
      hazardEvents: year(['2026-01', '2026-02', '2026-03']),
      conflictEvents: [clash('2026-01'), clash('2026-02'), clash('2026-03')],
      from: '2026-01', to: '2026-12',
    })
    const disjoint = compoundHazardScore({
      hazardEvents: year(['2026-01', '2026-02', '2026-03']),
      conflictEvents: [clash('2026-07'), clash('2026-08'), clash('2026-09')],
      from: '2026-01', to: '2026-12',
    })
    assert.equal(coincident.contingency.p_flood, disjoint.contingency.p_flood)
    assert.equal(coincident.contingency.p_conflict, disjoint.contingency.p_conflict)
    assert.equal(coincident.score, 25)
    assert.equal(disjoint.score, 0)
    assert.ok(coincident.score > disjoint.score)
  })

  it('refuses rather than reporting zero when one hazard never occurred', () => {
    // A joint rate of zero here would read as "safe" when it means "this window
    // contains no instance of one of the two".
    const result = compoundHazardScore({
      hazardEvents: year(MONTHS),
      conflictEvents: [],
      from: '2026-01', to: '2026-12',
      region: 'Turkana',
    })
    assert.equal(result.score, null)
    assert.match(result.reason, /no conflict-month/)
    assert.match(result.reason, /undefined rather than zero/)
  })

  it('names which hazard is absent, so the refusal is actionable', () => {
    const noFlood = compoundHazardScore({
      hazardEvents: [],
      conflictEvents: MONTHS.map(clash),
      from: '2026-01', to: '2026-12',
    })
    assert.match(noFlood.reason, /no flood-month/)
  })

  it('counts a month once however many events fall in it', () => {
    // The hazards are seasonal on the same calendar, so a rate over events would
    // count one rainy season once per event in it.
    const result = compoundHazardScore({
      hazardEvents: [at('2026-01'), at('2026-01', 'storm'), at('2026-01'), at('2026-02')],
      conflictEvents: [clash('2026-01'), clash('2026-01'), clash('2026-02')],
      from: '2026-01', to: '2026-12',
    })
    assert.equal(result.contingency.flood_months, 2)
    assert.equal(result.contingency.conflict_months, 2)
    assert.equal(result.contingency.both_months, 2)
  })
})

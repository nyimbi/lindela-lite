import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EPISODE_MIN_SEASONS,
  OCEANIC_NINO_THRESHOLD_C,
  readSeasonalState,
  seasonalNarrative,
  seasonalPhaseLabel,
} from '../public/shared/seasonal.js'

const obs = (source_id, value, metadata = {}) => ({
  source: 'noaa_enso',
  source_id,
  value,
  metadata,
})

describe('seasonal context', () => {
  it('reads nothing when the connector has not run', () => {
    // "Not ingested" and "neutral" are different claims. Only one is
    // evidenced by an absent record, and it is the first.
    assert.equal(readSeasonalState([]), null)
    assert.equal(readSeasonalState(undefined), null)
    assert.equal(readSeasonalState([{ source: 'open_meteo', source_id: 'x', value: 1 }]), null)
    assert.equal(seasonalPhaseLabel(null), 'not ingested')
    assert.match(seasonalNarrative(null), /has not been ingested/)
  })

  it('ignores observations without a usable value or period', () => {
    assert.equal(readSeasonalState([obs('2026-08', null)]), null)
    assert.equal(readSeasonalState([obs('2026-08', NaN)]), null)
    assert.equal(readSeasonalState([{ source: 'noaa_enso', value: 1 }]), null)
  })

  it('picks the newest period regardless of input order', () => {
    const state = readSeasonalState([
      obs('2026-06', 1.47),
      obs('2026-08', 2.17),
      obs('2026-07', 1.78),
    ])
    assert.equal(state.period, '2026-08')
    assert.equal(state.anomalyC, 2.17)
  })

  it('applies CPC published threshold on the correct side', () => {
    assert.equal(OCEANIC_NINO_THRESHOLD_C, 0.5)
    assert.equal(readSeasonalState([obs('2026-08', 0.5)]).phase, 'el_nino_advisory')
    assert.equal(readSeasonalState([obs('2026-08', 0.49)]).phase, 'neutral')
    assert.equal(readSeasonalState([obs('2026-08', -0.5)]).phase, 'la_nina_advisory')
    assert.equal(readSeasonalState([obs('2026-08', -0.49)]).phase, 'neutral')
    assert.equal(readSeasonalState([obs('2026-08', 0)]).phase, 'neutral')
  })

  it('never labels a phase without the word advisory', () => {
    // A panel reading a bare "El Niño" would reasonably take it as a declared
    // event. That is exactly the overstatement this exists to prevent.
    for (const value of [2.17, 0.6, -1.2, 0]) {
      const label = seasonalPhaseLabel(readSeasonalState([obs('2026-08', value)]))
      assert.ok(
        label === 'Neutral' || label.endsWith('advisory'),
        `label for ${value} must be qualified: ${label}`,
      )
    }
    assert.equal(seasonalPhaseLabel(readSeasonalState([obs('2026-08', 2.17)])), 'El Niño advisory')
    assert.equal(seasonalPhaseLabel(readSeasonalState([obs('2026-08', -1.2)])), 'La Niña advisory')
    assert.equal(seasonalPhaseLabel(readSeasonalState([obs('2026-08', 0.1)])), 'Neutral')
  })

  it('counts qualifying seasons and reports the requirement', () => {
    const state = readSeasonalState([obs('2026-08', 2.17, { overlapping_seasons: 3 })])
    assert.equal(state.overlappingSeasons, 3)
    assert.equal(state.seasonsRequired, 5)
    assert.equal(EPISODE_MIN_SEASONS, 5)
    assert.equal(state.episodeDeclared, false)
  })

  it('declares an episode only at five overlapping seasons', () => {
    assert.equal(readSeasonalState([obs('2026-08', 2.17, { overlapping_seasons: 4 })]).episodeDeclared, false)
    assert.equal(readSeasonalState([obs('2026-08', 2.17, { overlapping_seasons: 5 })]).episodeDeclared, true)
    assert.equal(readSeasonalState([obs('2026-08', 2.17, { overlapping_seasons: 6 })]).episodeDeclared, true)
  })

  it('computes the episode flag rather than trusting the stored one', () => {
    // A record claiming episode_declared with two qualifying seasons must not
    // become an event. Recomputing means a bad write cannot assert one.
    const state = readSeasonalState([
      obs('2026-08', 2.17, { overlapping_seasons: 2, episode_declared: true }),
    ])
    assert.equal(state.episodeDeclared, false)
  })

  it('treats missing season metadata as zero, not as met', () => {
    const state = readSeasonalState([obs('2026-08', 2.17)])
    assert.equal(state.overlappingSeasons, 0)
    assert.equal(state.episodeDeclared, false)
    assert.match(seasonalNarrative(state), /0 of 5/)
  })

  it('narrates the qualification and the limits', () => {
    const state = readSeasonalState([
      obs('2026-08', 2.17, {
        overlapping_seasons: 3,
        index_used: 'ONI',
        index_note: 'ONI, not RONI.',
        model_limit: 'Monthly SST anomaly index; not a rainfall forecast.',
      }),
    ])
    const text = seasonalNarrative(state)
    assert.match(text, /2026-08/)
    assert.match(text, /\+2\.17 °C/)
    assert.match(text, /±0\.5 °C/)
    assert.match(text, /3 of 5/, 'must state how close it is to an episode')
    assert.match(text, /advisory, not a declared event/)
    assert.match(text, /not a rainfall forecast/)
    assert.match(text, /ONI, not RONI\./)
  })

  it('says the criterion is met when it is', () => {
    const state = readSeasonalState([obs('2026-08', 2.17, { overlapping_seasons: 5 })])
    assert.match(seasonalNarrative(state), /criterion is met/i)
  })

  it('preserves the index identity rather than relabelling it', () => {
    const state = readSeasonalState([obs('2026-08', 1.0, { index_used: 'ONI' })])
    assert.equal(state.indexUsed, 'ONI')
    assert.notEqual(state.indexUsed, 'RONI')
  })
})
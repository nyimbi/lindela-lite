#!/usr/bin/env node
/**
 * A synthetic event's coordinates must be numbers the model can place.
 *
 * The guard that exists for this tested `value === ''` and then called `Number`,
 * and `Number('  ')`, `Number([])` and `Number(false)` are all 0 — so a
 * coordinate the client left as spaces, or sent as an empty array, became the
 * point 0,0. That is a real position in the Gulf of Guinea, and the run
 * published a synthetic flood located there. `Number(true)` is 1, a place too.
 *
 * The refusal must be about an *unreadable* coordinate, not a zero one: a
 * scenario event genuinely at 0,0 is a legal input, and a guard that rejected it
 * would be the falsy-zero bug wearing the guard's clothes.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeScenarioPerturbation } from '../src/scenarios.js'

const withCoords = (latitude, longitude) => ({
  added_hazard_events: [{ event_type: 'flood', severity: 'high', latitude, longitude }],
})

const refusal = (latitude) => {
  try {
    normalizeScenarioPerturbation(withCoords(latitude, 35.6))
  } catch (error) {
    assert.equal(error.statusCode, 400, `expected a 400, got ${error.statusCode}: ${error.message}`)
    return error.message
  }
  assert.fail(`a coordinate of ${JSON.stringify(latitude)} was accepted as a position`)
}

describe('scenario event coordinates', () => {
  for (const blank of ['  ', '\t', '', null, undefined, [], [5], true, false, 'north']) {
    it(`refuses ${JSON.stringify(blank)} as a latitude rather than placing the event at 0,0`, () => {
      assert.match(refusal(blank), /latitude must be a number/)
    })
  }

  it('accepts a stated zero — 0,0 is a place when it is stated', () => {
    const out = normalizeScenarioPerturbation(withCoords(0, 0))
    assert.equal(out.added_hazard_events[0].latitude, 0)
    assert.equal(out.added_hazard_events[0].longitude, 0)
  })

  it('accepts a numeric string and keeps the number', () => {
    const out = normalizeScenarioPerturbation(withCoords('3.1', '35.6'))
    assert.equal(out.added_hazard_events[0].latitude, 3.1)
    assert.equal(out.added_hazard_events[0].longitude, 35.6)
  })

  it('still refuses a readable coordinate outside the globe', () => {
    assert.match(refusal(999), /must be between -90 and 90/)
  })
})

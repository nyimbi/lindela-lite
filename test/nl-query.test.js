import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  NL_FLOOD_THRESHOLD_SCORE,
  NL_QUERY_VOCABULARY,
  answerQuery,
  auditAnswer,
  parseQuery,
  renderAnswer,
  runQuery,
} from '../src/nl-query.js'
import { MODEL_REGISTRY, floorsMissed, refusalSentence } from '../src/model-registry.js'
import { riskLevel } from '../src/schema.js'

/**
 * ENH-68 — grounded natural-language query.
 *
 * The question this file exists to hold to account is the entry's own:
 *
 *   "Which districts crossed the flood-threshold last week and have no
 *    dispatch?"
 *
 * Two properties are load-bearing, and every test below is one of them:
 *
 *   1. an answer carries the facts it used and is audited against them, so a
 *      sentence that states a number the facts do not contain is refused;
 *   2. a question that cannot be grounded — an unknown subject, an ambiguous
 *      region, a model that refuses for the region asked about — returns the
 *      refusal naming what is missing, never a best-effort answer.
 *
 * `NOW` pins the window so "last week" is a fixed period in the fixture rather
 * than whatever day the suite runs on.
 */

const NOW = '2026-10-12T06:00:00Z'
const day = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString()

/** Two districts, one over the flood threshold with no dispatch, one under it. */
function fixture() {
  return {
    risk_scores: [
      { id: 'r1', type: 'flood_risk', region_name: 'Turkana', country: 'KE', score: 82, risk_level: 'critical', confidence: 85, generated_at: day(1) },
      { id: 'r2', type: 'flood_risk', region_name: 'Mandera', country: 'KE', score: 41, risk_level: 'medium', confidence: 90, generated_at: day(1) },
    ],
    alert_events: [
      { id: 'a1', status: 'open', severity: 'high', metric: 'flood_risk.score', value: 82, created_at: day(2), location: { name: 'Turkana' } },
    ],
    rapidpro_dispatches: [
      { id: 'd1', alert_event_id: 'a1', status: 'sent', created_at: day(2) },
    ],
  }
}

describe('grounded natural-language query (ENH-68)', () => {
  it('answers the entry\'s example question and carries the facts it used', () => {
    // Turkana is over the threshold and its alert was dispatched; Mandera is
    // under the threshold. Neither crosses *and* lacks a dispatch, so the
    // honest answer is "no match" — but it is an answer, not a refusal, and it
    // states the counts it read.
    const answer = answerQuery('Which districts crossed the flood threshold last week and have no dispatch?', fixture(), { now: NOW })
    assert.equal(answer.status, 'answered')
    assert.match(answer.text, /flood risk/)
    // The two query facts the sentence is allowed to write are present.
    const fields = new Set(answer.facts.map((f) => f.field))
    assert.ok(fields.has('matched_regions'))
    assert.ok(fields.has('records_read'))
    // Every figure the sentence wrote was audited against the facts.
    assert.equal(answer.numbers_checked > 0, true)
    const audit = auditAnswer(answer.text, answer.facts)
    assert.equal(audit.ok, true, `the answer stated an unretrieved figure: ${audit.invented.join(', ')}`)
  })

  it('returns the matching district and its own score when one qualifies', () => {
    const data = fixture()
    // A dispatch exists — for the other district — so the collection is not
    // empty and "no dispatch" is evidence about Turkana rather than a missing
    // feed. Turkana is over the threshold with nothing dispatched to it.
    data.alert_events = []
    data.rapidpro_dispatches = [{ id: 'd2', status: 'sent', created_at: day(2), location: { name: 'Mandera' } }]
    const answer = answerQuery('Which districts crossed the flood threshold and have no dispatch?', data, { now: NOW })
    assert.equal(answer.status, 'answered')
    assert.match(answer.text, /Turkana/)
    // The score it states is the score it retrieved, not a rounded or inferred one.
    const score = answer.facts.find((f) => f.subject === 'flood_risk' && f.region === 'Turkana' && f.field === 'score')
    assert.equal(score.value, 82)
    assert.match(answer.text, /82/)
  })

  it('refuses a question it cannot ground rather than answering approximately', () => {
    const answer = answerQuery('What is the sentiment of the field reports?', fixture(), { now: NOW })
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'unknown_subject')
    assert.match(answer.reason, /no subject/)
    // A refusal is not a hedged answer: there is no text.
    assert.equal(answer.text, null)
  })

  it('refuses an ambiguous region rather than picking one', () => {
    const answer = answerQuery('Which districts crossed the flood threshold in Turkana and Mandera?', fixture(), { now: NOW })
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'ambiguous_region')
    assert.match(answer.reason, /Turkana/)
    assert.match(answer.reason, /Mandera/)
  })

  it('surfaces the model\'s own refusal sentence when the region has no fit', () => {
    // Turkana has archive rainfall but no trained model — exactly the state the
    // model refuses on. The answer must be the registry's sentence, not a
    // paraphrase written here, and it must name the floor the counts miss.
    const data = {
      flood_probability_models: [],
      climate_observations: [
        { id: 'c1', source: 'open_meteo_archive', region_name: 'Turkana', country: 'KE', daily: [1, 2, 3, 4, 5].map((i) => ({ date: `2026-0${i}-15` })) },
      ],
    }
    const answer = answerQuery('What is the flood probability for Turkana?', data, { now: NOW })
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'model_refusal')
    assert.equal(answer.refusal.model, 'flood_probability')
    // The sentence is the registry's, verbatim.
    assert.equal(answer.refusal.sentence, refusalSentence('flood_probability'))
    assert.equal(answer.text, refusalSentence('flood_probability') + ' The counts miss: 5 of the required 60 months.')
    // The floor named is the registry's own, and it is the one the counts miss.
    const floors = floorsMissed('flood_probability', { months: 5, events: null, coverage: null })
    assert.deepEqual(answer.refusal.floors, floors)
    assert.equal(floors.find((f) => f.floor === 'months').required, 60)
  })

  it('answers a model query from a trained fit and cites only the fit\'s facts', () => {
    const data = {
      flood_probability_models: [{
        id: 'm1', region_name: 'Turkana', country: 'KE', model: { intercept: 0 },
        months_kept: 71, folds: { validated_months: 68, skill_over_base_rate: 0.31 },
      }],
    }
    const answer = answerQuery('What is the flood probability for Turkana?', data, { now: NOW })
    assert.equal(answer.status, 'answered')
    assert.match(answer.text, /Turkana/)
    const fields = new Set(answer.facts.map((f) => f.field))
    assert.ok(fields.has('validated_months'))
    assert.ok(fields.has('skill_over_base_rate'))
    // 0.31 and 68 are retrieved; nothing else numeric may appear in the prose.
    assert.equal(auditAnswer(answer.text, answer.facts).ok, true)
  })

  it('refuses a threshold on a subject that has no threshold to cross', () => {
    const answer = answerQuery('Which open alerts crossed the threshold?', fixture(), { now: NOW })
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'unknown_field')
    assert.match(answer.reason, /no threshold/)
  })

  it('refuses "no dispatch" when the store records no dispatches at all', () => {
    // An absent collection is not "every district is undispatched". The
    // difference between a deployment with no dispatches recorded and one with
    // dispatches that happened to miss a district is the difference the
    // refusal states.
    const answer = answerQuery('Which districts crossed the flood threshold and have no dispatch?', {
      risk_scores: fixture().risk_scores,
    }, { now: NOW })
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'unmeasured')
    assert.match(answer.reason, /cannot be told apart/)
  })

  it('refuses when the collection it would read is empty', () => {
    const answer = answerQuery('What is the flood risk in Turkana?', {}, { now: NOW })
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'no_data')
    assert.match(answer.reason, /no risk_scores records/)
  })

  it('refuses an invented figure before the sentence is returned', () => {
    // The enforcement path itself, exercised: a renderer that writes a number
    // the facts do not contain is refused, with the number named. This is the
    // property the whole entry rests on, so it is watched failing.
    const data = fixture()
    const answer = answerQuery('What is the flood risk in Turkana?', data, {
      now: NOW,
      render: (query, resolved) => `${renderAnswer(query, resolved)} Confidence was 99.`,
    })
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'invented_figure')
    assert.match(answer.reason, /99/)
  })

  it('holds the declared flood threshold to riskLevel\'s own boundary', () => {
    // The threshold is not an independent number: it is the score at which
    // `riskLevel` names a district `high`. If either moves, this fails.
    assert.equal(riskLevel(NL_FLOOD_THRESHOLD_SCORE), 'high')
    assert.equal(riskLevel(NL_FLOOD_THRESHOLD_SCORE - 1), 'medium')
    assert.equal(NL_QUERY_VOCABULARY.flood_threshold_score, NL_FLOOD_THRESHOLD_SCORE)
  })

  it('stamps the default window as assumed rather than applying it silently', () => {
    const parsed = parseQuery('What is the flood risk in Turkana?', { now: NOW })
    assert.equal(parsed.status, 'parsed')
    assert.equal(parsed.window.key, NL_QUERY_VOCABULARY.default_window)
    assert.equal(parsed.window.assumed, true)
    const explicit = parseQuery('Which districts crossed the flood threshold last 30 days?', { now: NOW })
    assert.equal(explicit.window.key, 'last_30_days')
    assert.equal(explicit.window.assumed, false)
  })

  it('refuses an empty question', () => {
    const answer = answerQuery('   ', fixture(), { now: NOW })
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'no_question')
  })

  it('collects facts only from records it read, never a value it composed', () => {
    // The other half of the invented-figure guarantee: the audit can only
    // protect a sentence if the *fact set itself* holds nothing but retrieved
    // values. Every per-region fact must trace to a field on a record in the
    // collection it names — a fact a layer composed would pass its own audit.
    const data = fixture()
    data.alert_events = []
    data.rapidpro_dispatches = [{ id: 'd2', status: 'sent', created_at: day(2), location: { name: 'Mandera' } }]
    const parsed = parseQuery('Which districts crossed the flood threshold and have no dispatch?', { now: NOW })
    const resolved = runQuery(parsed, data)
    assert.equal(resolved.status, 'resolved')
    for (const item of resolved.facts.filter((f) => f.region && f.subject === 'flood_risk')) {
      const record = data.risk_scores.find((r) => r.region_name === item.region)
      assert.ok(record, `fact ${item.id} cites ${item.region}, which is not a record that was read`)
      assert.equal(record[item.field], item.value)
    }
  })

  it('declares a registry entry for every model a subject can ask about', () => {
    // A subject that names a model must name one the registry carries, or the
    // refusal sentence would be null and the surface would render nothing.
    assert.ok(MODEL_REGISTRY.flood_probability)
    assert.equal(typeof refusalSentence('flood_probability'), 'string')
  })

  it('refuses a collection carrying a non-record instead of throwing out of the route', () => {
    // `body JSONB NOT NULL` admits the JSON value `null`, and the JSON adapter
    // asserts record shape only on the path that writes — so a collection can
    // arrive here with an entry that is not a record. Every predicate in
    // `runQuery` dereferences a record, so one such entry used to throw a
    // TypeError out of the ask route: a 500 where this module promises a 200.
    // Silently skipping it would be worse than the throw, because the answer
    // states `records_read`: a row dropped without a word turns "no match" into
    // a claim about a collection nobody fully read. So it refuses, with the
    // count, and the two spellings a store can carry (`null` and an array) are
    // both named.
    for (const [label, junk] of [['null', null], ['array', []]]) {
      const data = fixture()
      data.risk_scores = [...data.risk_scores, junk]
      const parsed = parseQuery('Which districts crossed the flood threshold?', { now: NOW })
      const resolved = runQuery(parsed, data)
      assert.equal(resolved.status, 'refused', `${label}: a non-record must not be counted or skipped`)
      assert.equal(resolved.code, 'unreadable_record')
      assert.match(resolved.reason, /1 of 3 entries/)
    }
  })

  it('refuses a model collection carrying a non-record, rather than reading the floor over it', () => {
    // `runModelQuery` reads `m.model` off each entry for the same reason, and it
    // is a separate function — the guard in `runQuery` does not reach it.
    const parsed = parseQuery('What is the flood probability for Turkana?', { now: NOW })
    assert.equal(parsed.status, 'parsed')
    const resolved = runQuery(parsed, { flood_probability_models: [null], climate_observations: [] })
    assert.equal(resolved.status, 'refused')
    assert.equal(resolved.code, 'unreadable_record')
  })
})

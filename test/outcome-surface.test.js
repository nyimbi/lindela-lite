import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  determinationFor, submitOutcome, coverageNote, reasonOptions, humanReason, fetchReasons, fetchCoverage,
} from '../public/shared/outcomes.js'

/**
 * ENH-19 — the outcome channel had no way in.
 *
 * The server records a determination, the metric registry counts it, the
 * calibration rollup reports coverage — and before this, nobody could enter one.
 * Every calibration surface stayed at "not estimable" for the reason the whole
 * feature exists to fix, because the only way to record a determination was to
 * know the collection existed.
 *
 * So the tests here are about the *decisions*, not the markup. A dialog that
 * renders is not a dialog that decides correctly, and the decisions are the ones
 * that can go quietly wrong:
 *
 *   - a reason that does not match the determination is a contradiction, not a
 *     judgement, and one filed that way poisons every rollup that counts it;
 *   - a bare verdict with no reason is uncountable, which is the state the API
 *     refuses and the form must refuse too;
 *   - "we could not ask how many have been judged" and "none have been judged"
 *     are different facts, and only one of them may be drawn on screen.
 */

const REASONS = {
  justified: ['hazard_occurred_as_warned', 'action_taken_in_time', 'confirmed_by_ground_report'],
  false: ['sensor_fault', 'threshold_mistuned', 'no_hazard_observed'],
}

describe('ENH-19 — what the dialog offers for an alert', () => {
  it('an alert with nothing recorded is offered the choice', () => {
    const decision = determinationFor({ id: 'alert-1' }, { reasons: REASONS })
    assert.equal(decision.kind, 'offered')
  })

  it('an alert already determined is offered a correction, and says what was recorded', () => {
    const decision = determinationFor({
      id: 'alert-1', false_alert: true, outcome_reason: 'sensor_fault', determined_at: '2024-03-05T00:00:00Z',
    }, { reasons: REASONS })
    assert.equal(decision.kind, 'recorded')
    assert.equal(decision.determination, 'false')
    assert.equal(decision.reason, 'sensor_fault')
    assert.equal(decision.determined_at, '2024-03-05T00:00:00Z')
  })

  it('a row with no id is offered nothing, rather than a form that cannot be sent', () => {
    const decision = determinationFor({}, { reasons: REASONS })
    assert.equal(decision.kind, 'unavailable')
    assert.match(decision.reason, /no alert id/)
  })

  it('the reasons are disjoint, so a justified reason cannot be filed against a false alert', () => {
    // The overlap is what makes the contradiction possible. Two lists that share
    // an entry are two lists that will disagree the first time somebody picks
    // the wrong one.
    const overlap = REASONS.justified.filter((r) => REASONS.false.includes(r))
    assert.deepEqual(overlap, [])
    const decision = determinationFor({ id: 'a' }, { reasons: REASONS })
    assert.equal(decision.reasons.justified.includes('sensor_fault'), false)
    assert.equal(decision.reasons.false.includes('hazard_occurred_as_warned'), false)
  })
})

describe('ENH-19 — a determination cannot be filed without a reason', () => {
  it('refuses a bare verdict', async () => {
    const result = await submitOutcome({ alertId: 'a1', determination: 'false', determinedBy: 'me' }, { post: async () => ({ success: true }) })
    assert.equal(result.ok, false)
    assert.match(result.error, /reason/)
  })

  it('refuses a determination that is neither', async () => {
    const result = await submitOutcome({ alertId: 'a1', determination: 'probably', reason: 'sensor_fault', determinedBy: 'me' }, { post: async () => ({ success: true }) })
    assert.equal(result.ok, false)
    assert.match(result.error, /justified/)
  })

  it('refuses an anonymous determination', async () => {
    const result = await submitOutcome({ alertId: 'a1', determination: 'false', reason: 'sensor_fault' }, { post: async () => ({ success: true }) })
    assert.equal(result.ok, false)
    assert.match(result.error, /who determined it/)
  })

  it('posts the determination with the reason and the owner', async () => {
    let posted = null
    const result = await submitOutcome({
      alertId: 'a1', determination: 'false', reason: 'sensor_fault', determinedBy: 'focal_point_mbeya', note: 'Reading traced to a faulty sensor',
    }, {
      post: async (path, body) => {
        posted = { path, body }
        return { success: true, data: { id: 'outcome-1' } }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(posted.path, '/api/v1/alert-events/a1/outcome')
    assert.equal(posted.body.reason, 'sensor_fault')
    assert.equal(posted.body.determined_by, 'focal_point_mbeya')
    assert.equal(posted.body.note, 'Reading traced to a faulty sensor')
  })

  it('will not post without a poster, rather than posting unauthenticated', async () => {
    await assert.rejects(
      submitOutcome({ alertId: 'a1', determination: 'false', reason: 'sensor_fault', determinedBy: 'me' }),
      /needs a `post` function/,
      'a silent default poster would file determinations with no auth header and no way to tell',
    )
  })

  it('reports the server\'s refusal instead of pretending it worked', async () => {
    const result = await submitOutcome(
      { alertId: 'a1', determination: 'false', reason: 'because', determinedBy: 'me' },
      { post: async () => ({ success: false, error: 'reason must be one of sensor_fault…' }) },
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /sensor_fault/)
  })
})

describe('ENH-19 — the coverage line says what it knows', () => {
  it('says plainly that nothing has been judged', () => {
    const note = coverageNote({ alerts: 400, determined: 0, false_alerts: 0, justified: 0 })
    assert.match(note, /coverage_none/)
    assert.match(note, /400/)
  })

  it('states the counts a rate would be computed from', () => {
    const note = coverageNote({ alerts: 400, determined: 12, false_alerts: 2, justified: 10 })
    assert.match(note, /12/)
    assert.match(note, /400/)
    assert.match(note, /3/)  // 3% of the alerts judged
  })

  it('says nothing at all when the tally could not be fetched', () => {
    assert.equal(coverageNote(null), '')
    assert.equal(coverageNote(undefined), '')
  })
})

describe('ENH-19 — the surface is reachable and the reason catalogue comes from one place', () => {
  const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

  it('every alert row carries a determination control', () => {
    assert.match(APP, /data-action="outcome"/,
      'the rail renders an alert row and offers no way to say whether it was justified — ' +
      'the channel exists and nobody can post to it')
  })

  it('the dialog exists, with both determinations and a reason select', () => {
    // In a deferred template, not in index.html: eight controls at boot is eight
    // controls a console on a field connection pays for, to open a dialog about
    // once a week. `test/web-deferred-panels.test.js` owns the ceiling.
    const template = readFileSync(new URL('../public/panels/outcome.html', import.meta.url), 'utf8')
    for (const id of ['outcomeDialog', 'outcomeReason', 'outcomeDeterminedBy', 'outcomeSubmit']) {
      assert.ok(template.includes(`id="${id}"`), `#${id} is missing from the deferred dialog`)
      assert.ok(!INDEX.includes(`id="${id}"`), `#${id} is back inline in index.html; that is the first-load cost the deferral removed`)
    }
    assert.match(template, /name="outcomeDetermination"[^>]*value="justified"|value="justified"[^>]*name="outcomeDetermination"/)
    assert.match(template, /value="false"/)
  })

  it('the deferred dialog is precached, because offline is when it is needed', () => {
    // A worker who has just received an alert is often offline. A dialog that
    // will not open without a connection is the outcome channel closed on the
    // devices it exists for.
    const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
    assert.match(sw, /'\/panels\/outcome\.html'/,
      'the determination dialog is deferred and not precached, so it cannot open offline')
  })

  it('its wiring cannot be module-level, because the markup is not there yet', () => {
    // A listener attached to an element that does not exist is a control that
    // silently does nothing, and the symptom is an operator who cannot judge an
    // alert and no error anywhere.
    assert.match(APP, /await loadOutcomeTemplate\(\)/,
      'the dialog opens its template before reading its elements')
    assert.doesNotMatch(APP, /^\$\('outcomeSubmit'\)\?\.addEventListener/m,
      'a module-level listener on deferred markup attaches to nothing')
  })

  it('both coverage sentences exist in English, or the line renders a key', () => {
    // A gate that catches a missing `data-i18n` key cannot see a template
    // literal, so the one string on this panel that no locale could reach was
    // invisible to it. The keys are asserted here instead.
    const en = JSON.parse(readFileSync(new URL('../public/i18n/en.json', import.meta.url), 'utf8'))
    for (const key of ['outcome.coverage_none', 'outcome.coverage_some']) {
      assert.ok(typeof en[key] === 'string' && en[key].length > 0,
        `${key} is missing from en.json, so the coverage line renders the key itself`)
    }
    assert.match(APP, /formatOutcomeCoverageFallback/,
      'and the builder needs a fallback for a locale that has not translated it, ' +
      'so a missing key reads as English rather than as an identifier')
  })

  it('the reason list is fetched, never a second copy in the client', () => {
    assert.match(APP, /fetchReasons\(\)/,
      'a client-side copy of the reasons is a second definition of what a false alert is')
  })

  it('the coverage line has a host, and it is hidden until the tally answers', () => {
    assert.ok(INDEX.includes('id="alertsOutcomeCoverage"'))
    assert.match(APP, /if \(!tally\) \{[\s\S]*?host\.hidden = true/,
      'an unanswerable tally must leave the line blank; "0 of 0 determined" is a claim nobody made')
  })

  it('the reason ids read as words in the dropdown', () => {
    // `sensor_fault` in a list of choices is a bug report to nobody.
    assert.match(humanReason('sensor_fault'), /sensor/i)
    assert.notEqual(humanReason('no_hazard_observed'), 'no_hazard_observed')
    const options = reasonOptions(REASONS.false)
    assert.match(options, /value="sensor_fault"/)
    assert.match(options, /value="no_hazard_observed"/)
  })

  it('a determined alert marks its row, and an undetermined one does not', () => {
    // A badge on every un-reviewed alert turns the rail into a wall of hedges and
    // an operator learns to skip it. The unknown is stated once, in aggregate.
    assert.match(APP, /if \(determination\.kind !== 'recorded'\) return ''/)
  })
})

describe('ENH-19 — the fetches degrade without lying', () => {
  it('an unreachable reason catalogue falls back rather than offering nothing', async () => {
    const reasons = await fetchReasons({ fetchImpl: async () => { throw new Error('offline') } })
    assert.ok(reasons.justified.length > 0 && reasons.false.length > 0,
      'a dead catalogue must not leave the dialog with an empty dropdown')
  })

  it('an unreachable tally is null, not zero', async () => {
    assert.equal(await fetchCoverage({ fetchImpl: async () => { throw new Error('offline') } }), null)
    assert.equal(await fetchCoverage({ fetchImpl: async () => ({ ok: false, status: 503 }) }), null)
  })

  it('a tally that answers is passed through', async () => {
    const tally = await fetchCoverage({
      fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, data: { alerts: 4, determined: 1 } }) }),
    })
    assert.equal(tally.determined, 1)
  })
})
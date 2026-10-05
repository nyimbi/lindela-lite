import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import {
  normalizeAlertOutcome, determinationFor, outcomeTally, outcomeReasons, DETERMINATIONS,
} from '../src/outcomes.js'
import { evaluateAlertRules } from '../src/alerts.js'

/**
 * ENH-19 — every calibration surface reports "not estimable", for one reason.
 *
 * Nothing records whether the warning was justified. `false_alert` is a field on
 * the alert, filled in by hand when somebody remembers, and for a long time a
 * free-text `resolution_note` stood in for it — which is how the confirmed miss
 * on Mandera, whose note reads "Reading traced to a faulty sensor", matched no
 * keyword any of the three readers looked for while being perfectly visible to
 * the one that read a field somebody had filled in.
 *
 * So a determination is a record: a reason from a closed set, a person, a time,
 * and the ids of the evidence. A note cannot be a denominator. A reason can be
 * counted, compared between districts, and acted on — `false` because of a
 * sensor fault is a repair ticket, and `false` because the threshold was mistuned
 * is a rule change, and a metric that lumps them together tells an operator only
 * that the number is high.
 */

const DAY = 24 * 60 * 60 * 1000

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-enh19-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await store.merge({
    alert_events: [{
      id: 'alert-1',
      type: 'alert_event',
      rule_id: 'rule-1',
      rule_name: 'Flood threshold',
      status: 'open',
      severity: 'high',
      metric: 'counts.hazard_events',
      created_at: new Date().toISOString(),
    }],
  })
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const record = (body) => fetch(`${globalThis.__base}/api/v1/alert-events/alert-1/outcome`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('ENH-19 — a determination is a reason, not a note', () => {
  it('refuses a reason outside the closed set', () => {
    // The whole reason the record is countable. A free-text reason cannot be
    // aggregated, so accepting one would put a value in the denominator that no
    // query could ever group by — the exact shape of the defect this fixes.
    assert.throws(
      () => normalizeAlertOutcome({ alert_event_id: 'a', determination: 'false', reason: 'it just looked wrong', determined_by: 'me' }),
      /reason must be one of/,
    )
  })

  it('refuses a determination that is not one of the two', () => {
    assert.throws(
      () => normalizeAlertOutcome({ alert_event_id: 'a', determination: 'probably', reason: 'sensor_fault', determined_by: 'me' }),
      /determination must be one of/,
    )
  })

  it('a reason from the wrong determination is refused too', () => {
    // "hazard_occurred_as_warned" is a reason for a warning that was right. A
    // false alert cannot have one, and accepting it would make the two
    // categories indistinguishable in every rollup.
    assert.throws(
      () => normalizeAlertOutcome({ alert_event_id: 'a', determination: 'false', reason: 'hazard_occurred_as_warned', determined_by: 'me' }),
      /reason must be one of/,
    )
  })

  it('requires somebody to own the determination', () => {
    assert.throws(
      () => normalizeAlertOutcome({ alert_event_id: 'a', determination: 'false', reason: 'sensor_fault' }),
      /determined_by is required/,
    )
  })

  it('a note is kept and is not load-bearing', () => {
    // The Mandera note matches no keyword — and that is the point. The note is
    // the human explanation; the reason is what gets counted.
    const outcome = normalizeAlertOutcome({
      alert_event_id: 'a',
      determination: 'false',
      reason: 'sensor_fault',
      determined_by: 'focal_point',
      note: 'Reading traced to a faulty sensor',
    })
    assert.equal(outcome.note, 'Reading traced to a faulty sensor')
    assert.equal(outcome.false_alert, true, 'the determination itself is what the metric reads')
  })

  it('the closed set is served, not duplicated per client', () => {
    const reasons = outcomeReasons()
    assert.deepEqual(reasons.determinations, [...DETERMINATIONS])
    assert.ok(reasons.reasons.false.includes('sensor_fault'))
    assert.ok(!reasons.reasons.justified.includes('sensor_fault'),
      'the two lists must not overlap, or the closed set is not closed')
  })
})

describe('ENH-19 — a correction supersedes, and the sequence stays readable', () => {
  it('the latest revision wins, and the earlier one is still there', async () => {
    await withServer(async (base) => {
      globalThis.__base = base
      const first = await (await record({ determination: 'false', reason: 'sensor_fault', determined_by: 'focal_point' })).json()
      const corrected = await (await record({ determination: 'justified', reason: 'hazard_occurred_as_warned', determined_by: 'focal_point' })).json()

      assert.equal(first.data.revision, 1)
      assert.equal(corrected.data.revision, 2)
      assert.equal(corrected.data.supersedes, first.data.id,
        'a correction names what it corrects; "we were wrong, then right" and "we were never right" are different signals')

      const data = await (await fetch(`${base}/api/v1/alert-outcomes`)).json()
      assert.equal(data.data.length, 2, 'the superseded determination is part of the record, not deleted')
      assert.equal(determinationFor('alert-1', data.data).determination, 'justified')
    })
  })

  it('an alert with no outcome has no determination, which is not "sound"', async () => {
    await withServer(async (base) => {
      const tally = await (await fetch(`${base}/api/v1/alert-outcomes/tally`)).json()
      assert.equal(tally.data.determined, 0)
      assert.equal(tally.data.undetermined, 1)
      assert.equal(tally.data.coverage, 0)
      // The projection: with no outcome, the alert carries no `false_alert`
      // field at all, so a metric reading it cannot mistake unknown for false.
      const alerts = await (await fetch(`${base}/api/v1/alert-events`)).json()
      assert.ok(!('false_alert' in (alerts.data[0] || {})),
        'an undetermined alert must not read as a determined sound one')
    })
  })
})

describe('ENH-19 — coverage is a number, not a feeling', () => {
  it('a platform with almost no determinations says so', () => {
    const alerts = Array.from({ length: 400 }, (_, i) => ({ id: `a${i}` }))
    const outcomes = alerts.slice(0, 12).map((a, i) => ({
      alert_event_id: a.id,
      determination: i < 2 ? 'false' : 'justified',
      reason: i < 2 ? 'sensor_fault' : 'hazard_occurred_as_warned',
      revision: 1,
    }))
    const tally = outcomeTally(alerts, outcomes)
    assert.equal(tally.alerts, 400)
    assert.equal(tally.determined, 12)
    assert.equal(tally.undetermined, 388)
    assert.equal(tally.coverage, 0.03)
    assert.equal(tally.by_reason['false:sensor_fault'], 2,
      'the reason breakdown is what makes "false" actionable')
  })

  it('undetermined is never negative when outcomes exceed alerts', () => {
    // An outcome for a deleted alert is possible; a negative "we do not know"
    // would be a worse number than none.
    const tally = outcomeTally([{ id: 'a' }], [
      { alert_event_id: 'a', determination: 'justified', reason: 'hazard_occurred_as_warned', revision: 1 },
      { alert_event_id: 'gone', determination: 'justified', reason: 'hazard_occurred_as_warned', revision: 1 },
    ])
    assert.equal(tally.undetermined, 0)
    assert.equal(tally.undetermined >= 0, true)
  })
})

describe('ENH-24 — every alert says why it fired', () => {
  const data = {
    alert_rules: [{
      id: 'rule-1',
      name: 'Flood threshold',
      metric: 'counts.hazard_events',
      operator: '>=',
      threshold: 3,
      severity: 'high',
      status: 'active',
      version: 4,
    }],
    alert_events: [],
    hazard_events: [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }, { id: 'h4' }],
  }
  const context = {
    counts: { hazard_events: 4 },
    operations: {},
    data_quality: [],
  }

  it('the raised alert carries its rule version, its reading and its inputs', () => {
    const { raised } = evaluateAlertRules(data, context)
    assert.equal(raised.length, 1)
    const derivation = raised[0].derivation
    assert.equal(derivation.rule_version, 4,
      'a rule is versioned and an edit is a new version, so rule_id alone cannot say which threshold applied')
    assert.equal(derivation.observed_value, 4)
    assert.equal(derivation.threshold, 3)
    assert.deepEqual(derivation.context_snapshot.counts, { hazard_events: 4 },
      'the reading at the time, not one reconstructed from a store that has moved on')
    assert.deepEqual(derivation.input_record_ids, ['h1', 'h2', 'h3', 'h4'],
      'the ids behind the count, so "why did this fire" is answerable from the alert itself')
  })

  it('a rule over an aggregate records no input ids rather than an empty list', () => {
    const aggregate = {
      ...data,
      alert_rules: [{ ...data.alert_rules[0], metric: 'operations.coverage_pct' }],
    }
    const { raised } = evaluateAlertRules(aggregate, {
      counts: { hazard_events: 4 },
      operations: { coverage_pct: 91 },
      data_quality: [],
    })
    assert.equal(raised[0].derivation.input_record_ids, null,
      'an aggregate has no per-record identity to name, and [] would read as "no records were involved"')
  })
})

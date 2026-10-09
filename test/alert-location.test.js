import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateAlertRules } from '../src/alerts.js'

/**
 * Alerts must say WHERE.
 *
 * An alert card in the ops rail had a severity, a rule name, a timestamp and a
 * message, and no place. An operator scanning a country's worth of alerts
 * cannot act on "threshold exceeded" without knowing where the threshold was
 * crossed — and the records behind the count already carry a place, so the
 * alert was throwing away what it needed at the moment it was built.
 *
 * The fix resolves `location` from the alert's own evidence: the records the
 * metric was computed over (the ids `inputIdsFor` already names), first one
 * with a place wins. A rule whose `scope` names a district supplies a fallback
 * label. Nothing resolves to `location: null` — and null is a statement the
 * console words ("not recorded for this alert"), not a missing field a reader
 * has to guess about.
 */

const RULE = {
  id: 'rule-hazard-count',
  name: 'Hazard pressure',
  status: 'active',
  metric: 'counts.hazard_events',
  operator: '>=',
  threshold: 1,
  severity: 'high',
  suppression_minutes: 120,
  actions: [],
  scope: {},
  metadata: {},
}

const withData = (records, over = {}) => ({
  alert_rules: [{ ...RULE, ...over.rule }],
  alert_events: [],
  hazard_events: records,
  ...over.data,
})

describe('a raised alert carries the place its inputs name', () => {
  it('emits location from the first place-bearing input record', () => {
    const data = withData([
      { id: 'hz_placeless', event_type: 'heat' },
      {
        id: 'hz_1',
        event_type: 'flood',
        title: 'Flood near Bor town',
        admin1: 'Jonglei',
        admin2: 'Bor',
        country: 'SS',
        latitude: 6.207,
        longitude: 31.548,
      },
    ])
    const { raised } = evaluateAlertRules(data, { counts: { hazard_events: 2 } })
    assert.equal(raised.length, 1)
    assert.deepEqual(raised[0].location, {
      name: 'Flood near Bor town',
      admin1: 'Jonglei',
      country: 'SS',
      latitude: 6.207,
      longitude: 31.548,
    })
  })

  it('falls through place-bearing records in order: first with a place wins', () => {
    const data = withData([
      { id: 'hz_1', event_type: 'heat' },
      {
        id: 'hz_2',
        event_type: 'flood',
        admin2: 'Bor',
        district: 'Bor',
        latitude: 6.207,
        longitude: 31.548,
      },
      {
        id: 'hz_3',
        event_type: 'flood',
        title: 'Later record with a full place',
        admin1: 'Jonglei',
        country: 'SS',
      },
    ])
    const { raised } = evaluateAlertRules(data, { counts: { hazard_events: 3 } })
    assert.deepEqual(raised[0].location, {
      name: 'Bor',
      admin1: null,
      country: null,
      latitude: 6.207,
      longitude: 31.548,
    })
  })

  it('records a partial place honestly: present fields filled, absent ones null', () => {
    const data = withData([{ id: 'hz_1', event_type: 'flood', admin1: 'Jonglei', country: 'SS' }])
    const { raised } = evaluateAlertRules(data, { counts: { hazard_events: 1 } })
    assert.deepEqual(raised[0].location, {
      name: null,
      admin1: 'Jonglei',
      country: 'SS',
      latitude: null,
      longitude: null,
    })
  })

  it('coordinates count as a place only as a pair; one without the other is not a place', () => {
    const half = withData([{ id: 'hz_1', event_type: 'flood', latitude: 6.2 }])
    assert.deepEqual(half, withData(half.hazard_events))
    const { raised: withoutLon } = evaluateAlertRules(half, { counts: { hazard_events: 1 } })
    assert.equal(withoutLon[0].location, null)
  })

  it('a rule whose scope names a district uses it as the fallback label', () => {
    const data = withData([{ id: 'hz_1', event_type: 'heat' }], {
      rule: { scope: { district: 'Turkana' } },
    })
    const { raised } = evaluateAlertRules(data, { counts: { hazard_events: 1 } })
    assert.deepEqual(raised[0].location, {
      name: 'Turkana',
      admin1: null,
      country: null,
      latitude: null,
      longitude: null,
    })
  })

  it('location is null — the key present, the place not recorded — when nothing resolves', () => {
    const data = withData([{ id: 'hz_1', event_type: 'heat' }])
    const { raised } = evaluateAlertRules(data, { counts: { hazard_events: 1 } })
    assert.ok(raised.length === 1 && Object.hasOwn(raised[0], 'location'))
    assert.equal(raised[0].location, null)
  })

  it('an aggregate metric has no input records, so scope is the last word and silence is null', () => {
    const data = withData([], { rule: { metric: 'operations.coverage_pct' } })
    const { raised } = evaluateAlertRules(data, {
      counts: { hazard_events: 1 },
      operations: { coverage_pct: 50 },
    })
    assert.equal(raised[0].derivation.input_record_ids, null)
    assert.equal(raised[0].location, null)
  })

  it('ids beyond the recorded cap are walked only as far as the list goes — and the cap says so', () => {
    const records = Array.from({ length: 60 }, (_, i) => ({
      id: `hz_${i}`,
      event_type: 'flood',
      admin1: `Region ${i}`,
      country: 'SS',
    }))
    const data = withData(records)
    const { raised } = evaluateAlertRules(data, { counts: { hazard_events: 60 } })
    assert.equal(raised[0].derivation.input_record_ids.length, 50)
    assert.equal(raised[0].derivation.input_record_ids_total, 60)
    assert.equal(raised[0].derivation.input_record_ids_truncated, true,
      'the id list is a sample; the derivation says so rather than implying completeness')
    assert.deepEqual(raised[0].location, {
      name: null,
      admin1: 'Region 0',
      country: 'SS',
      latitude: null,
      longitude: null,
    })
  })
})
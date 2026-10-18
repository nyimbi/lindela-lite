import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { chainGenesis, chainWithdrawal, chainEntry, chainStateFrom, verifyChain } from '../src/audit-chain.js'
import { normalizeCommunityFeedback } from '../src/community.js'
import { actionLog } from '../src/operations.js'
import { normalizeParametricRule, simulateDisbursement } from '../src/parametric.js'
import { normalizeDistributionRun, normalizeReport, normalizeReportSchedule } from '../src/reports.js'
import { runScenario } from '../src/scenarios.js'
import { normalizeWorkflowInstance } from '../src/workflows.js'
import { parseRapidProReply } from '../src/rapidpro.js'

/**
 * DATA-12 — a record id names the record, not the moment it was written.
 *
 * The register states the defect as "record ids mix the current timestamp into
 * the hash, so re-submitting identical content produces a different id and
 * defeats dedup". Probed against the tree before this file existed, the claim
 * held at nine call sites: normalising the same input twice a moment apart
 * minted two ids, and nothing downstream could tell the pair from two genuine
 * events.
 *
 * The clock is mocked in every test below rather than left to real time. Two
 * `await`s a fraction of a millisecond apart can land in the same millisecond,
 * and a test that passes because the machine was fast is not testing the key —
 * the same reason `road-access.js` takes an injectable `now`.
 *
 * Each case is paired with a *control* that changes the input and asserts the
 * id moves. A constant id would satisfy the first half of every pair and
 * collapse the deployment into one row per collection, which is the opposite
 * failure and the one a naive fix produces.
 */

/** Run `fn` with `Date` pinned, so `new Date().toISOString()` is deterministic. */
async function at(iso, fn) {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) })
  try {
    return await fn()
  } finally {
    mock.timers.reset()
  }
}

const EARLY = '2026-10-18T09:00:00.000Z'
const LATER = '2026-10-18T09:06:30.000Z'

describe('DATA-12 — the workflow instance', () => {
  const subject = { type: 'anticipatory_alert', subject_kind: 'alert_event', subject_id: 'ae-1' }

  it('is one instance per (type, subject), however long the retry takes', async () => {
    const first = await at(EARLY, () => normalizeWorkflowInstance(subject))
    const second = await at(LATER, () => normalizeWorkflowInstance(subject))
    assert.equal(first.id, second.id, 'a retried POST opened a second review of one alert')
  })

  it('is a different instance for a different subject', async () => {
    const a = await at(EARLY, () => normalizeWorkflowInstance(subject))
    const b = await at(EARLY, () => normalizeWorkflowInstance({ ...subject, subject_id: 'ae-2' }))
    assert.notEqual(a.id, b.id, 'two alerts shared one workflow')
  })

  it('is a different instance for a different process on one subject', async () => {
    const a = await at(EARLY, () => normalizeWorkflowInstance(subject))
    const b = await at(EARLY, () => normalizeWorkflowInstance({ ...subject, type: 'community_feedback_loop' }))
    assert.notEqual(a.id, b.id, 'two processes on one alert shared one workflow')
  })
})

describe('DATA-12 — community feedback', () => {
  const message = { alert_event_id: 'ae-1', message: 'the water point is dry' }

  it('is one row per (alert, message, reporter)', async () => {
    const first = await at(EARLY, () => normalizeCommunityFeedback(message))
    const second = await at(LATER, () => normalizeCommunityFeedback(message))
    assert.equal(first.id, second.id, 'a retried feedback POST wrote the same message twice')
  })

  it('is two rows when two different people report the same sentence', async () => {
    const a = await at(EARLY, () => normalizeCommunityFeedback({ ...message, reporter_urn: 'tel:+254700000001' }))
    const b = await at(EARLY, () => normalizeCommunityFeedback({ ...message, reporter_urn: 'tel:+254700000002' }))
    assert.notEqual(a.id, b.id, 'two reporters were collapsed into one report')
  })

  it('is two rows for two different messages on one alert', async () => {
    const a = await at(EARLY, () => normalizeCommunityFeedback(message))
    const b = await at(EARLY, () => normalizeCommunityFeedback({ ...message, message: 'the clinic is closed' }))
    assert.notEqual(a.id, b.id)
  })
})

describe('DATA-12 — the parametric rule', () => {
  const rule = { name: 'Flood trigger, Turkana', chain: 'polygon-mumbai', trigger_metric: 'rainfall_mm_72h' }

  it('is one rule per (name, chain)', async () => {
    const first = await at(EARLY, () => normalizeParametricRule(rule))
    const second = await at(LATER, () => normalizeParametricRule(rule))
    assert.equal(first.id, second.id, 'a retried POST defined the same payout twice')
  })

  it('is two rules for two names on one chain', async () => {
    const a = await at(EARLY, () => normalizeParametricRule(rule))
    const b = await at(EARLY, () => normalizeParametricRule({ ...rule, name: 'Drought trigger, Turkana' }))
    assert.notEqual(a.id, b.id)
  })
})

describe('DATA-12 — a parametric disbursement', () => {
  const rule = {
    id: 'rule-1',
    chain: 'polygon-mumbai',
    trigger_metric: 'rainfall_mm_72h',
    trigger_operator: '>=',
    trigger_threshold: 100,
    disbursement_amount_local_currency: 5000,
    currency: 'KES',
    status: 'active',
  }

  it('is one payout per (rule, metric, value, verdict)', async () => {
    const first = await at(EARLY, () => simulateDisbursement(rule, { triggerValue: 120 }))
    const second = await at(LATER, () => simulateDisbursement(rule, { triggerValue: 120 }))
    assert.equal(first.disbursement_id, second.disbursement_id, 'a retried simulation minted a second payout')
  })

  it('is a new payout when the observed value changes', async () => {
    const a = await at(EARLY, () => simulateDisbursement(rule, { triggerValue: 120 }))
    const b = await at(EARLY, () => simulateDisbursement(rule, { triggerValue: 131 }))
    assert.notEqual(a.disbursement_id, b.disbursement_id, 'two observations shared one payout')
  })
})

describe('DATA-12 — the reporting family', () => {
  const data = {
    report_templates: [{ id: 't1', report_type: 'situation_report', title_pattern: 'SITREP - {{country}} - {{date}}', owner: 'ops' }],
  }

  it('is one schedule per (template, recurrence)', async () => {
    const input = { template_id: 't1', recurrence: { type: 'daily', time: '07:00' } }
    const first = await at(EARLY, () => normalizeReportSchedule(input, data))
    const second = await at(LATER, () => normalizeReportSchedule(input, data))
    assert.equal(first.id, second.id, 'a retried POST scheduled the SITREP twice a day')
  })

  it('is a different schedule on a different recurrence', async () => {
    const a = await at(EARLY, () => normalizeReportSchedule({ template_id: 't1', recurrence: { type: 'daily', time: '07:00' } }, data))
    const b = await at(EARLY, () => normalizeReportSchedule({ template_id: 't1', recurrence: { type: 'weekly', time: '07:00' } }, data))
    assert.notEqual(a.id, b.id)
  })

  it('is one distribution per (report, channel)', async () => {
    const report = { id: 'r1', template_id: 't1', title: 'SITREP', status: 'approved' }
    const first = await at(EARLY, () => normalizeDistributionRun({ channel: 'csv' }, report))
    const second = await at(LATER, () => normalizeDistributionRun({ channel: 'csv' }, report))
    assert.equal(first.id, second.id, 'a retried distribute prepared the send twice')
    const other = await at(EARLY, () => normalizeDistributionRun({ channel: 'webhook' }, report))
    assert.notEqual(first.id, other.id, 'two channels shared one run')
  })

  it('is one report per (template, type, title, scope)', async () => {
    const first = await at(EARLY, () => normalizeReport({ template_id: 't1', scope: { country: 'KE' } }, data))
    const second = await at(LATER, () => normalizeReport({ template_id: 't1', scope: { country: 'KE' } }, data))
    assert.equal(first.id, second.id, 'a retried POST drafted the same SITREP twice')
    const other = await at(EARLY, () => normalizeReport({ template_id: 't1', scope: { country: 'SS' } }, data))
    assert.notEqual(first.id, other.id, 'two countries shared one report')
  })
})

describe('DATA-12 — the action log', () => {
  const record = { id: 'inc-1', status: 'open', priority: 'high' }

  it('is one row per (collection, action, record)', async () => {
    const first = await at(EARLY, () => actionLog('incidents', 'updated', record, 'ops'))
    const second = await at(LATER, () => actionLog('incidents', 'updated', record, 'ops'))
    assert.equal(first.id, second.id, 'a retried write logged the action twice')
    // The wall clock is still recorded — it is when the log was written, and it
    // is not what the id names.
    assert.equal(second.created_at, LATER)
  })

  it('is a separate row for a separate action or record', async () => {
    const updated = await at(EARLY, () => actionLog('incidents', 'updated', record))
    const closed = await at(EARLY, () => actionLog('incidents', 'closed', record))
    const other = await at(EARLY, () => actionLog('incidents', 'updated', { ...record, id: 'inc-2' }))
    assert.equal(new Set([updated.id, closed.id, other.id]).size, 3)
  })
})

describe('DATA-12 — a chain withdrawal', () => {
  const entry = (id) => ({
    id, collection: 'incidents', record_id: id, action: 'created',
    actor: 'ops', subject: null, created_at: '2026-10-18T08:00:00.000Z',
    summary: `created incident ${id}`, metadata: {},
  })

  it('is one withdrawal per entry, and a repeat returns the standing one', async () => {
    const base = [chainEntry(entry('e1'), chainGenesis())]
    const first = await at(EARLY, () => chainWithdrawal(base, 'e1', 'ops'))
    const chained = [...base, first]
    const second = await at(LATER, () => chainWithdrawal(chained, 'e1', 'ops'))
    assert.equal(second.id, first.id, 'a retried withdrawal wrote a second row naming one entry')
    // The retry returns the standing row rather than a fresh one, so a caller
    // that merges it writes nothing new and the log still verifies.
    assert.equal(second.seq, first.seq, 'the retry minted a second chain position')
    assert.equal(verifyChain([...base, second], { expectedHead: first.entry_hash }).verified, true)
    // And appending both is exactly what the return prevents: the verifier
    // reports a repeated id and a repeated seq as fatal defects, so a retry that
    // wrote a second row would make the chain condemn itself.
    const both = verifyChain([...base, first, second])
    assert.equal(both.verified, false)
    assert.ok(both.defects.some((d) => d.type === 'duplicate_id'))
  })

  it('is a separate withdrawal for a separate entry', async () => {
    const base = [
      chainEntry(entry('e1'), chainGenesis()),
      chainEntry(entry('e2'), chainStateFrom([chainEntry(entry('e1'), chainGenesis())])),
    ]
    const a = await at(EARLY, () => chainWithdrawal(base, 'e1', 'ops'))
    const b = await at(EARLY, () => chainWithdrawal([...base, a], 'e2', 'ops'))
    assert.notEqual(a.id, b.id)
  })
})

describe('DATA-12 — a scenario', () => {
  // The four collections `runScenario` actually reads: the flood scorer walks
  // service assets to find regions, so a stub without them throws before any id
  // is minted.
  const data = { climate_observations: [], hazard_events: [], conflict_events: [], service_assets: [] }
  const perturbation = { precipitation_multiplier: 1.5 }

  it('is named by the perturbation it runs, not by when it ran', async () => {
    const first = await at(EARLY, () => runScenario(data, perturbation))
    const second = await at(LATER, () => runScenario(data, perturbation))
    assert.equal(first.scenario_id, second.scenario_id, 'a shared scenario link minted a new id on every open')
  })

  it('is a different scenario for a different perturbation', async () => {
    const a = await at(EARLY, () => runScenario(data, perturbation))
    const b = await at(EARLY, () => runScenario(data, { precipitation_multiplier: 2.5 }))
    assert.notEqual(a.scenario_id, b.scenario_id)
  })
})

describe('DATA-12 — an inbound webhook', () => {
  const payload = { from: '+254700000001', text: 'ACK blocked' }

  it('is one row when the provider echoes no id and the webhook is retried', async () => {
    // Probed before the fix: two parses a few milliseconds apart minted
    // `rapidpro_inbound_be79f8bd5eb3b1d6` and `rapidpro_inbound_b58a378e5469c9bc`,
    // so a retried webhook wrote a second inbound row for one message.
    const first = await at(EARLY, () => parseRapidProReply(payload, null))
    const second = await at(LATER, () => parseRapidProReply(payload, null))
    assert.equal(first.id, second.id, 'a retried reply with no provider id wrote a second inbound row')
  })

  it('takes the provider stamp when there is one, so a real repeat keeps its own id', async () => {
    const first = await at(EARLY, () => parseRapidProReply({ ...payload, received_on: '2026-10-18T09:00:00.000Z' }, null))
    const second = await at(EARLY, () => parseRapidProReply({ ...payload, received_on: '2026-10-18T09:30:00.000Z' }, null))
    assert.notEqual(first.id, second.id, 'two genuinely different messages collapsed into one row')
  })
})

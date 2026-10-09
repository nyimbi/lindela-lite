import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * The explain panel must understand protocol alerts.
 *
 * What an operator saw on Details for `alert_ccb4e74b…` — the demo's fired
 * pre-authorised protocol alert — was "no registered scoring rule… The
 * dashboard does not know a /api/v1/explain kind for this record's type."
 * Both halves were true and both were useless: an alert has no score to
 * decompose, and the record's own derivation carries exactly the answer to
 * "why did this fire and what authorisation did" — the condition set, the
 * pre-authorisation, and (since the playbook-outcome field) what executed.
 *
 * This panel reads the record as the alert builder wrote it. It never invents
 * a decomposition: a refused step shows its reason, a fetch that did not
 * happen says so, and an outcome that lives only in the execution record is
 * labelled as coming from there.
 */

const ROOT = new URL('..', import.meta.url).pathname

async function loadWireExplain() {
  const source = readFileSync(new URL('../public/workflow/wire-explain.js', import.meta.url), 'utf8')
  const shared = (name) => pathToFileURL(path.join(ROOT, 'public', 'shared', name)).href
  const rewritten = source
    .replace("from '/shared/viz-explain.js'", `from '${shared('viz-explain.js')}'`)
    .replace("from '/shared/viz-uncertainty.js'", `from '${shared('viz-uncertainty.js')}'`)
    .replace("from '/shared/fmt.js'", `from '${shared('fmt.js')}'`)
  const dir = mkdtempSync(path.join(tmpdir(), 'wire-explain-alert-'))
  const file = path.join(dir, 'wire-explain.js')
  writeFileSync(file, rewritten)
  try {
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const FIRE_STAMP = '2026-10-08T10:05:45.146Z'

/** The stored demo alert, minus nothing: pre-dates metadata.playbook_results. */
function protocolAlert(over = {}) {
  return {
    id: 'alert_ccb4e74b45e63613',
    rule_id: null,
    rule_name: 'Extreme discharge: protect cold chain and clinics',
    status: 'open',
    severity: 'high',
    metric: 'counts.hazard_events',
    operator: '>=',
    threshold: 1,
    value: 575,
    actions: [
      { type: 'notify', recipients: ['+254700000001'] },
      { type: 'intervention', id: 'protect', title: 'Protect cold chain ahead of flooding', district: 'turkana' },
      { type: 'task', for: 'protect', title: 'Relocate vaccines within 6 hours' },
    ],
    scope: { protocol_id: 'trigger_protocol_ff561e1091ea5325' },
    approval: {
      state: 'auto_approved',
      pre_authorised: true,
      protocol_id: 'trigger_protocol_ff561e1091ea5325',
      protocol_version: 1,
      approvers: ['Turkana County Health Management Team', 'Lodwar District Hospital'],
      decided_at: FIRE_STAMP,
    },
    metadata: {
      protocol_id: 'trigger_protocol_ff561e1091ea5325',
      protocol_version: 1,
      execution_id: 'protocol_execution_98b1eaf1ba88171b',
      pre_authorised: true,
    },
    derivation: {
      rule_id: null,
      rule_version: 1,
      rule_name_at_fire: 'Extreme discharge: protect cold chain and clinics',
      metric: 'counts.hazard_events',
      operator: '>=',
      threshold: 1,
      observed_value: 575,
      observed_at: FIRE_STAMP,
      condition_set: {
        combinator: 'and',
        negate: false,
        evaluable: true,
        terms: [
          { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false, observed_value: 575, satisfied: true, term_unresolvable: false },
          { metric: 'counts.climate_observations', operator: '>=', threshold: 10, negate: false, observed_value: 233, satisfied: true, term_unresolvable: false },
        ],
      },
      engine: { module: 'src/protocols.js', rule_schema: 'protocol/1' },
    },
    ...over,
  }
}

const PROTOCOL_RECORD = {
  id: 'trigger_protocol_ff561e1091ea5325',
  name: 'Extreme discharge: protect cold chain and clinics',
  version: 1,
  agreed_at: '2026-10-07',
  approvers: ['Turkana County Health Management Team', 'Lodwar District Hospital'],
}

const EXECUTION_ROW = {
  id: 'protocol_execution_98b1eaf1ba88171b',
  alert_id: 'alert_ccb4e74b45e63613',
  status: 'partial',
  actions: [
    { type: 'notify', status: 'refused', detail: 'rapidpro not configured; alert raised, dispatch awaits manual send' },
    { type: 'intervention', status: 'executed', record_id: 'intervention_3cfa50f69cb85fe9', detail: 'incident incident_9ecfd2ee50e11315 and intervention created' },
    { type: 'task', status: 'executed', record_id: 'task_2873997c36aa4bec', detail: 'attached to intervention intervention_3cfa50f69cb85fe9' },
  ],
}

/** A `load` that serves the protocol record and the store's executions. */
function protocolLoader({ withExecutions = true } = {}) {
  return async (url) => {
    if (url.includes('/api/v1/trigger-protocols/')) {
      return { success: true, data: PROTOCOL_RECORD }
    }
    if (withExecutions && url.includes('/api/v1/protocol-executions')) {
      return { success: true, data: { data: [EXECUTION_ROW] } }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

describe('the explain panel understands a protocol alert', () => {
  it('renders the condition set, the pre-authorisation and the playbook outcome', async () => {
    const { renderExplain } = await loadWireExplain()
    const host = { innerHTML: '' }
    await renderExplain(host, protocolAlert(), { load: protocolLoader() })
    const html = host.innerHTML
    assert.match(html, /counts\.hazard_events/, 'term one names its metric')
    assert.match(html, /counts\.climate_observations/, 'term two names its metric')
    assert.match(html, /AND/, 'the combinator is named')
    assert.match(html, /575/, 'the reading travels with the term')
    assert.match(html, /satisfied/, 'each term says whether it held')
    assert.match(html, /Extreme discharge: protect cold chain and clinics/, 'the protocol by name')
    assert.match(html, /2026-10-07/, 'agreed_at comes from the protocol record')
    assert.match(html, /Turkana County Health Management Team/, 'the approvers')
    assert.match(html, /rapidpro not configured; dispatch awaits manual send|rapidpro not configured/,
      'the refused notify step shows its honest reason')
    assert.match(html, /intervention_3cfa50f69cb85fe9/, 'executed steps name their record')
    assert.match(html, /executed/)
    assert.match(html, /refused/)
  })

  it('labels a playbook outcome that came from the execution record, not the alert', async () => {
    const { renderExplain } = await loadWireExplain()
    const host = { innerHTML: '' }
    await renderExplain(host, protocolAlert(), { load: protocolLoader() })
    assert.match(host.innerHTML, /linked execution record/,
      'the row provenance is said, for an alert the field predates')
  })

  it('prefers the alert\u2019s own playbook results and fetches no execution list for it', async () => {
    const { renderExplain } = await loadWireExplain()
    const fetched = []
    const load = async (url) => {
      fetched.push(url)
      if (url.includes('/api/v1/trigger-protocols/')) return { success: true, data: PROTOCOL_RECORD }
      throw new Error('unexpected fetch: ' + url)
    }
    const host = { innerHTML: '' }
    const alert = protocolAlert({ metadata: {
      protocol_id: 'trigger_protocol_ff561e1091ea5325',
      protocol_version: 1,
      execution_id: 'protocol_execution_98b1eaf1ba88171b',
      pre_authorised: true,
      playbook_results: EXECUTION_ROW.actions,
    } })
    await renderExplain(host, alert, { load })
    assert.doesNotMatch(host.innerHTML, /linked execution record/,
      'the outcome is the alert\u2019s own; the fallback label must not appear')
    assert.ok(!fetched.some((u) => u.includes('protocol-executions')),
      'a self-contained alert needs no execution lookup')
    assert.match(host.innerHTML, /intervention_3cfa50f69cb85fe9/)
  })

  it('says fail-closed in the panel when the condition set was not evaluable', async () => {
    const { renderExplain } = await loadWireExplain()
    const alert = protocolAlert()
    alert.derivation.condition_set.evaluable = false
    alert.derivation.condition_set.terms[1] = { metric: 'counts.cold_chain_breaches', operator: '>=', threshold: 1, negate: false, observed_value: null, satisfied: false, term_unresolvable: true }
    const host = { innerHTML: '' }
    await renderExplain(host, alert, { load: protocolLoader() })
    assert.match(host.innerHTML, /fail-closed: an unresolvable term never fires/)
    assert.match(host.innerHTML, /unresolvable/)
  })

  it('names a protocol fetch that never happened rather than rendering invented facts', async () => {
    const { renderExplain } = await loadWireExplain()
    const host = { innerHTML: '' }
    await renderExplain(host, protocolAlert(), { load: undefined })
    const html = host.innerHTML
    assert.doesNotMatch(html, /2026-10-07/, 'no agreed_at invented from nothing')
    // The approvers the ALERT itself carries still render — the refusal is
    // narrowly about the fetched protocol record (its agreed date and name).
    assert.match(html, /was not fetched|no authenticated loader|could not be/,
      'the absence of the protocol record is said, not papered over')
    assert.match(html, /Turkana County Health Management Team/, 'the approvers the alert itself carries still render')
    assert.match(html, /counts\.hazard_events/, 'the condition set needs no fetch and still renders')
  })

  it('a 404 for the protocol record is the honest miss', async () => {
    const { renderExplain } = await loadWireExplain()
    const load = async (url) => {
      if (url.includes('/api/v1/trigger-protocols/')) {
        return { success: false, error: 'Not found' }
      }
      return { success: true, data: { data: [EXECUTION_ROW] } }
    }
    const host = { innerHTML: '' }
    await renderExplain(host, protocolAlert(), { load })
    assert.match(host.innerHTML, /is not in this store|not found/i)
  })
})

describe('the explain panel understands a rule alert', () => {
  const ruleAlert = {
    id: 'alert_rule_x',
    rule_id: 'alert_rule_x_rule',
    rule_name: 'Flood Watch: High Precipitation',
    status: 'approved',
    severity: 'high',
    metric: 'counts.hazard_events',
    operator: '>=',
    threshold: 3,
    value: 5,
    approval: { state: 'approved', reviewer: 'Peter Deng', reviewed_at: '2026-10-06T09:00:00.000Z', decision_note: 'Two crossings confirmed' },
    location: { name: null, admin1: 'Jonglei', country: 'SS', latitude: 6.2, longitude: 31.5 },
    derivation: {
      rule_id: 'alert_rule_x_rule',
      rule_version: 4,
      rule_name_at_fire: 'Flood Watch: High Precipitation',
      metric: 'counts.hazard_events',
      operator: '>=',
      threshold: 3,
      observed_value: 5,
      observed_at: '2026-10-05T12:00:00.000Z',
      input_record_ids: ['h1', 'h2', 'h3', 'h4'],
      input_record_ids_total: 9,
      input_record_ids_truncated: false,
      engine: { module: 'src/alerts.js', rule_schema: '1' },
    },
  }

  it('renders the rule derivation, the input count and the where', async () => {
    const { renderExplain } = await loadWireExplain()
    const host = { innerHTML: '' }
    await renderExplain(host, ruleAlert, { load: async () => ({ success: false }) })
    const html = host.innerHTML
    assert.match(html, /counts\.hazard_events/)
    assert.match(html, /&gt;=/, 'the operator (escaped, as the panel escapes everything)')
    assert.match(html, /5/, 'the observed value')
    assert.match(html, /4 record/, 'the count says its denominator')
    assert.match(html, /Jonglei/, 'the where (Task 2)')
    assert.match(html, /Peter Deng/, 'the human approval is the answer to what authorisation did')
  })

  it('says when the input id list is a sample rather than hiding the cap', async () => {
    const { renderExplain } = await loadWireExplain()
    const host = { innerHTML: '' }
    const truncated = { ...ruleAlert, derivation: { ...ruleAlert.derivation, input_record_ids: Array.from({ length: 50 }, (_, i) => `h${i}`), input_record_ids_total: 137, input_record_ids_truncated: true } }
    await renderExplain(host, truncated, { load: async () => ({ success: false }) })
    assert.match(host.innerHTML, /sample|truncated/, 'the cap is stated')
    assert.match(host.innerHTML, /137/, 'the total is stated')
  })

  it('leaves the no-derivation path untouched for records that are not alerts', async () => {
    const { renderExplain } = await loadWireExplain()
    const host = { innerHTML: '' }
    const asset = { id: 'asset_x', source: 'service_assets', name: 'Bor Model Primary', service_type: 'school' }
    await renderExplain(host, asset, { load: async () => ({ success: true, provenance: { known: false } }) })
    assert.match(host.innerHTML, /no source run is named by this record/,
      'the asset path (and its tests) are exactly as before')
  })
})
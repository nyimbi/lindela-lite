import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/**
 * The alert card says WHERE it is about, and what authorisation DID.
 *
 * Tasks 2 and 3 of the demo-polish plan, made checkable as source. The card
 * renderer is console markup behind the runner's 30-second repaint, so a DOM
 * pass would be a browser gate's job; what a source test can pin is the
 * decision structure: the Where line exists and words its absence; the
 * authorisation block reads the alert's own playbook results first and the
 * execution record only as a fallback; refused steps show their detail; and
 * every i18n key the new markup asks for exists in all ten locales — the
 * parent plan's "ALL 10" requirement, asserted rather than remembered.
 */

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

describe('the alert card carries where and what authorisation did', () => {
  it('renders a Where line on every card, and words the absence', () => {
    assert.match(APP, /alertWhereHtml\(alert\)/, 'the card template must render the Where line')
    assert.match(APP, /function alertWhere\(/, 'the place resolution is a named, testable decision')
    assert.match(APP, /t\('alert\.whereNotRecorded'\)/,
      'a null location is an answer the console words, not a missing line')
  })

  it('the Where precedence reads fields the record itself holds, in order', () => {
    const fn = APP.match(/function alertWhere\(alert\) \{[\s\S]*?\n\}/)?.[0] || ''
    const location = fn.indexOf('alert?.location')
    const scope = fn.indexOf("alert?.scope?.district ?? alert?.metadata?.district")
    const playbook = fn.indexOf("alert.actions.find")
    assert.ok(location !== -1, 'rung 1: the resolved location field')
    assert.ok(scope !== -1, 'rung 2: the district the rule/seed carried')
    assert.ok(playbook !== -1, 'rung 3: the playbook snapshot on the alert')
    assert.ok(location < scope && scope < playbook, 'resolved location beats scope beats playbook')
  })

  it('the authorisation block is a named decision, not inline markup', () => {
    assert.match(APP, /function alertAuthorisationBlock\(alert\)/)
    assert.match(APP, /t\('alert\.authorisedAction'\)/)
    assert.match(APP, /playbookRowsFor\(alert\)/)
  })

  it('the playbook outcome prefers the alert record and falls back to the execution row', () => {
    const fn = APP.match(/function playbookRowsFor\(alert\) \{[\s\S]*?\n\}/)?.[0] || ''
    assert.match(fn, /metadata\?\.playbook_results/, 'primary source: the alert itself')
    assert.match(fn, /metadata\?\.execution_id/, 'fallback addressing: the execution the alert already names')
    assert.match(fn, /_protocolOutcomeCache/, 'the fallback is hydrated, not refetched per repaint')
  })

  it('refused steps show their detail — the honest reason travels with the row', () => {
    const fn = APP.match(/function playbookRowHtml\(row\) \{[\s\S]*?\n\}/)?.[0] || ''
    assert.match(fn, /row\?\.detail/, 'a refused step without its detail reads as nothing happened')
    assert.match(fn, /record_id/, 'the record id is on the row')
  })

  it('hydrates once per execution id per session — no repaint loop', () => {
    const fn = APP.match(/async function hydrateProtocolOutcomes\(alerts\) \{[\s\S]*?\n\}/)?.[0] || ''
    assert.match(fn, /_protocolOutcomeAsked\.add/, 'each id is asked for once')
    assert.match(fn, /renderAlertsPanel\(\)/, 'the rail repaints only when the cache gained rows')
    assert.match(APP, /hydrateProtocolOutcomes\(alerts\.data \|\| \[\]\)/,
      'wired where alert data lands, not per paint')
  })

  it('the authorised-action block carries no emoji', () => {
    const block = APP.match(/function alertAuthorisationBlock[\s\S]*?\n\}/)?.[0] || ''
    const where = APP.match(/function alertWhereHtml[\s\S]*?\n\}/)?.[0] || ''
    for (const [name, src] of [['alertWhereHtml', where], ['alertAuthorisationBlock', block]]) {
      assert.doesNotMatch(src, /[\u2190-\u2BFF\u{1F000}-\u{1FAFF}\uFE0F]/u, `${name} carries an emoji`)
    }
  })

  it('every i18n key the new markup asks for exists in all ten locales', () => {
    const keys = [
      'alert.approvers',
      'alert.approvedBy',
      'alert.authorisedAction',
      'alert.noApprovers',
      'alert.outcomeFromExecution',
      'alert.outcomePending',
      'alert.outcomeUnavailable',
      'alert.preAuthorisedBy',
      'alert.where',
      'alert.whereNotRecorded',
      'playbook.status.executed',
      'playbook.status.partial',
      'playbook.status.refused',
    ]
    const dir = new URL('../public/i18n/', import.meta.url)
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const catalog = JSON.parse(readFileSync(dir.pathname + file, 'utf8'))
      const missing = keys.filter((k) => !(k in catalog))
      assert.deepEqual(missing, [], `${file} lacks: ${missing.join(', ')}`)
    }
  })
})
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { installBrowserEnv } from './browser-env.mjs'

/**
 * The alert card says WHERE it is about, and what authorisation DID.
 *
 * Tasks 2 and 3 of the demo-polish plan. This file used to read `public/app.js`
 * into a string and assert on the shape of the code — `assert.match(APP,
 * /alertWhereHtml\(alert\)/)`, `assert.match(fn, /metadata\?\.playbook_results/)`.
 * Every one of those passes when the line exists in a dead branch and fails on a
 * rename that changes nothing (QUA-02). The card renderer is drivable through
 * the real boot (see `test/browser-env.mjs`), so what is asserted now is the
 * markup the rail actually renders for a given alert, and the requests the
 * console actually makes:
 *
 *   - the Where line appears on the card, and words its absence when the record
 *     holds no place;
 *   - the place resolves from the record's own fields in order — a resolved
 *     location beats the district on the scope beats the playbook snapshot;
 *   - the authorisation block reads the alert's own playbook results first and
 *     the execution record only as a fallback, fetching nothing when the alert
 *     already carries the outcome;
 *   - a refused step shows its detail, and the execution fallback is hydrated
 *     once per execution id per session;
 *   - every i18n key the markup asks for exists in all ten locales.
 *
 * The one remaining read of a file is the i18n catalogue, which is a data
 * fixture whose parsed keys ARE the contract — not program text.
 */

const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const PUBLIC_ROOT = new URL('../public/', import.meta.url)
const EN = JSON.parse(readFileSync(new URL('../public/i18n/en.json', import.meta.url), 'utf8'))

/**
 * Let the boot's own awaits drain.
 *
 * The module's top-level `await refresh({ first: true })` means the import
 * resolving is the fetch-and-render having finished, but `hydrateProtocolOutcomes`
 * is deliberately *not* awaited by the refresh (a slow execution lookup must not
 * hold the alert list hostage). Two macrotask turns is enough for its fetch and
 * the repaint it triggers. Real timers, not the environment's unref'd stubs, or
 * the promise never resolves once the loop empties.
 */
const settle = () => new Promise((r) => realSetTimeout(r, 5)).then(() => new Promise((r) => realSetTimeout(r, 5)))

const EXECUTION_ROW = {
  id: 'protocol_execution_1',
  status: 'partial',
  actions: [
    { type: 'notify', status: 'refused', detail: 'rapidpro not configured' },
    { type: 'task', status: 'executed', record_id: 'task_999' },
  ],
}

/** The hydration request, distinguished from the panel's own `/protocol-executions?…`. */
const hydrationFetches = (fetched) => fetched
  .map((u) => String(u).replace(/^https?:\/\/[^/]+/, ''))
  .filter((p) => p === '/api/v1/protocol-executions')

const card = (over = {}) => ({
  id: 'alert_card',
  status: 'open',
  severity: 'high',
  rule_name: 'Flood Watch',
  created_at: '2026-10-08T10:00:00Z',
  ...over,
})

/**
 * Boot the console against a stub store and hand back what it rendered.
 *
 * A fresh specifier per call: ESM caches by URL, and two scenarios sharing one
 * `app.js` URL would run the second against the first's module state. The
 * English catalogue is served so `t()` resolves the keys the card asks for —
 * without it every assertion would read a raw key name.
 */
let boots = 0
async function boot(alerts, { executions = null } = {}) {
  boots += 1
  const rows = Array.isArray(alerts) ? alerts : [alerts]
  const elements = new Map()
  const fetched = []
  installBrowserEnv({
    elements,
    respond: (url) => {
      fetched.push(String(url))
      if (url.includes('/i18n/en.json')) return { body: EN }
      if (url.includes('/api/v1/alert-events')) {
        return { body: { success: true, data: rows, returned: rows.length, limit: 200, total: rows.length, has_more: false, next_cursor: null } }
      }
      if (url.includes('/api/v1/protocol-executions') && executions) {
        return { body: { success: true, data: { data: executions } } }
      }
      return undefined
    },
  })
  const mod = await import(new URL(`app.js?card=${boots}`, PUBLIC_ROOT).href)
  await settle()
  return { mod, elements, fetched, rail: () => elements.get('alertsList')?.innerHTML || '' }
}

const PRE_AUTHORISED = {
  state: 'auto_approved',
  pre_authorised: true,
  approvers: ['Turkana County Health Management Team'],
  protocol_id: 'trigger_protocol_1',
  protocol_version: 1,
}

describe('the alert card carries where and what authorisation did', () => {
  it('renders a Where line on the card, naming the place the record holds', async () => {
    const { rail } = await boot(card({ location: { name: 'Lodwar', admin1: 'Turkana', country: 'KE' } }))
    const html = rail()
    assert.match(html, /class="alert-where/, 'the card template must render the Where line')
    assert.match(html, /Lodwar, Turkana, KE/, 'the place the record holds must reach the card')
  })

  it('words the absence rather than dropping the line', async () => {
    // A null location is an answer the console words, not a missing line.
    const { rail } = await boot(card({}))
    const html = rail()
    assert.match(html, /class="alert-where alert-where-none"/,
      'a place-less alert must still carry the Where line, marked as none')
    assert.match(html, /Not recorded for this alert/,
      'the absence must be worded, not left blank')
  })

  it('resolves the place from the record’s own fields, in precedence order', async () => {
    // Rung 1 (the resolved location) beats rung 2 (the district the rule carried)
    // beats rung 3 (the playbook snapshot). All three present, only the first
    // may render — a wrong order draws a scope district over a resolved place.
    const { rail } = await boot(card({
      location: { name: 'Lodwar', admin1: 'Turkana', country: 'KE' },
      scope: { district: 'scope_district_value' },
      actions: [{ type: 'intervention', district: 'playbook_district_value' }],
    }))
    const html = rail()
    assert.match(html, /Lodwar, Turkana, KE/, 'rung 1: the resolved location field')
    assert.doesNotMatch(html, /scope_district_value/, 'rung 2 must not win over a resolved location')
    assert.doesNotMatch(html, /playbook_district_value/, 'rung 3 must not win over a resolved location')
  })

  it('falls to the district the scope carried when no location resolved', async () => {
    const { rail } = await boot(card({ scope: { district: 'scope_district_value' } }))
    const html = rail()
    assert.match(html, /scope_district_value/, 'rung 2: the district the rule/seed carried')
    assert.doesNotMatch(html, /alert-where-none/, 'a scope district is a place, not an absence')
  })

  it('falls to the playbook snapshot when neither a location nor a scope district exists', async () => {
    const { rail } = await boot(card({ actions: [{ type: 'intervention', district: 'playbook_district_value' }] }))
    assert.match(rail(), /playbook_district_value/, 'rung 3: the playbook snapshot on the alert')
  })
})

describe('the authorisation block says what authorisation did', () => {
  it('renders the block, the approvers and the playbook rows for a pre-authorised alert', async () => {
    const { rail } = await boot(card({
      approval: PRE_AUTHORISED,
      metadata: {
        playbook_results: [
          { type: 'notify', status: 'refused', detail: 'rapidpro not configured' },
          { type: 'task', status: 'executed', record_id: 'task_999' },
        ],
      },
    }))
    const html = rail()
    assert.match(html, /class="alert-auth-block"/, 'the authorised-action block must render')
    assert.match(html, /Authorised action/, 'the block names itself through the catalogue, not a raw key')
    assert.match(html, /Turkana County Health Management Team/, 'the approvers the alert carries')
  })

  it('prefers the alert’s own playbook results and fetches no execution list for it', async () => {
    // Primary source: the alert itself. A self-contained alert that still
    // triggered an execution lookup is a wasted request on every repaint.
    const { rail, fetched } = await boot(card({
      approval: PRE_AUTHORISED,
      metadata: {
        playbook_results: [
          { type: 'notify', status: 'refused', detail: 'rapidpro not configured' },
          { type: 'task', status: 'executed', record_id: 'task_999' },
        ],
      },
    }))
    const html = rail()
    assert.match(html, /task_999/, 'the alert’s own outcome must render')
    assert.doesNotMatch(html, /Outcome read from the linked execution record/,
      'the outcome is the alert’s own; the fallback provenance label must not appear')
    assert.deepEqual(hydrationFetches(fetched), [],
      'a self-contained alert needs no execution lookup')
  })

  it('shows a refused step’s detail and an executed step’s record id', async () => {
    // A refused step without its detail reads as nothing happened; the record id
    // is how an operator finds what executed.
    const { rail } = await boot(card({
      approval: PRE_AUTHORISED,
      metadata: {
        playbook_results: [
          { type: 'notify', status: 'refused', detail: 'rapidpro not configured' },
          { type: 'task', status: 'executed', record_id: 'task_999' },
        ],
      },
    }))
    const html = rail()
    assert.match(html, /rapidpro not configured/, 'the refused step shows its honest reason')
    assert.match(html, /task_999/, 'the executed step names its record')
    assert.match(html, /refused/, 'the refused status travels with the row')
    assert.match(html, /executed/, 'the executed status travels with the row')
  })

  it('hydrates the fallback from the execution row, and labels its provenance', async () => {
    // A pre-field alert carries only `metadata.execution_id`. The outcome lives
    // in the execution record, and the card must fetch it, use it, and say where
    // it came from.
    const { rail } = await boot(
      card({ approval: PRE_AUTHORISED, metadata: { execution_id: 'protocol_execution_1' } }),
      { executions: [EXECUTION_ROW] },
    )
    const html = rail()
    assert.match(html, /task_999/, 'the execution row must fill the fallback outcome')
    assert.match(html, /Outcome read from the linked execution record/,
      'the row provenance must be said, for an alert the field predates')
  })

  it('asks for an execution id once per session, not once per alert or per repaint', async () => {
    const alerts = [
      card({ id: 'a1', approval: PRE_AUTHORISED, metadata: { execution_id: 'protocol_execution_1' } }),
      card({ id: 'a2', approval: PRE_AUTHORISED, metadata: { execution_id: 'protocol_execution_1' } }),
    ]
    const { mod, fetched } = await boot(alerts, { executions: [EXECUTION_ROW] })
    const afterBoot = hydrationFetches(fetched).length
    assert.equal(afterBoot, 1, 'two alerts sharing one execution id must be one lookup')
    // The boot's own hydration is deduped by the asked-set; a second call with
    // the same id must not fetch again.
    await mod.hydrateProtocolOutcomes(alerts)
    assert.equal(hydrationFetches(fetched).length, afterBoot,
      'a second hydration of the same execution id refetched; the cache was not consulted')
  })

  it('the authorised-action block carries no emoji', async () => {
    const { rail } = await boot(card({
      location: { name: 'Lodwar', admin1: 'Turkana', country: 'KE' },
      approval: PRE_AUTHORISED,
      metadata: {
        playbook_results: [{ type: 'notify', status: 'refused', detail: 'rapidpro not configured' }],
      },
    }))
    assert.doesNotMatch(rail(), /[←-⯿\u{1F000}-\u{1FAFF}️]/u,
      'the card markup carries an emoji')
  })
})

describe('the i18n keys the card asks for', () => {
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

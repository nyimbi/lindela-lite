#!/usr/bin/env node
/**
 * ARC-06 residue — a bounded read stated as a total, in front of an irreversible delete.
 *
 * `workflow/ops.js` reads both collections it is about to delete from with
 * `?limit=500` and then counted `data.length`. The dialog renders that number
 * as "<strong>N exist</strong>" on a button that permanently deletes records,
 * so on any store larger than 500 it understates what the delete would touch —
 * the one place in the console where understating a set is not a display
 * question.
 *
 * The register's ARC-06 note said `ops.js` "discloses nothing". Measured, it is
 * worse: it asserts a page length as an exact total, and it does so for a route
 * whose whole purpose is to describe the scale of an irreversible act.
 *
 * Three failures, one shape:
 *
 *   1. a truncated read printed as the whole set (`total: list.length`);
 *   2. a failed read printed as a confident zero — `apiSettled` answers `null`,
 *      `data.length` is 0, and the dialog says "0 exist" about a collection it
 *      never saw, then opens the confirm gate anyway;
 *   3. `unaged` counted within the held page and was printed as a whole-set
 *      count ("N carry no timestamp and are always kept").
 *
 * These drive the real exported functions. The prior wiring test for this area
 * read the source text of the call sites, which is QUA-02's exemplar — it fails
 * on a rename and passes on a regression.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { importFrontEnd } from './browser-env.mjs'

const ops = await importFrontEnd('workflow/ops.js')
const { retentionPlan, retentionRow, retentionRefusal, outboxBacklog } = ops

/** An envelope shaped exactly like `collectionPage`/`matchedAndPage` returns. */
function envelope(rows, { total = rows.length, hasMore = false } = {}) {
  return {
    data: rows,
    returned: rows.length,
    limit: 500,
    total,
    has_more: hasMore,
    next_cursor: hasMore ? 'cursor' : null,
  }
}

const aged = (id) => ({ id, occurred_at: '2020-01-01T00:00:00.000Z' })
const unaged = (id) => ({ id })

describe('the retention preview states a set it can actually see', () => {
  it('reads the server total, not the page length', () => {
    const page = Array.from({ length: 500 }, (_, i) => aged(`r${i}`))
    const plan = retentionPlan(envelope(page, { total: 1200, hasMore: true }), envelope([]))
    assert.equal(plan.fieldReports.total, 1200, 'the server said 1200; a page length of 500 is not the set')
    assert.equal(plan.fieldReports.held, 500)
    assert.equal(plan.fieldReports.complete, false)
  })

  it('says a truncated set is truncated, and does not print the page length as the set', () => {
    const page = Array.from({ length: 500 }, (_, i) => aged(`r${i}`))
    const plan = retentionPlan(envelope(page, { total: 1200, hasMore: true }), envelope([]))
    const row = retentionRow('Field reports', plan.fieldReports)
    assert.match(row.detail, /1,200 exist/, 'the server total, not the 500 rows held')
    assert.match(row.detail, /has read 500/)
    assert.match(row.detail, /the scan for missing timestamps is not/)
  })

  it('calls a complete set complete, and does not hedge it', () => {
    const plan = retentionPlan(envelope([aged('a'), aged('b')]), envelope([]))
    const row = retentionRow('Field reports', plan.fieldReports)
    assert.match(row.detail, /^2 exist/)
    assert.doesNotMatch(row.detail, /has read/, 'a complete page is not a partial read')
  })

  it('does not print a failed read as zero records', () => {
    // `apiSettled` answers `null` when the request throws. The old code did
    // `reports?.data || []` and rendered "0 exist" for a collection it never saw.
    const plan = retentionPlan(null, envelope([]))
    assert.equal(plan.fieldReports.readable, false)
    const row = retentionRow('Field reports', plan.fieldReports)
    assert.doesNotMatch(row.detail, /^0 exist/, 'a read that failed is not a set of zero')
    assert.match(row.detail, /could not be read/)
  })

  it('scopes the unaged count to the records it read', () => {
    const page = [aged('a'), unaged('b'), unaged('c')]
    const plan = retentionPlan(envelope(page, { total: 900, hasMore: true }), envelope([]))
    const row = retentionRow('Field reports', plan.fieldReports)
    assert.match(row.detail, /2 of the records read carry no timestamp/)
    // The old copy said "2 carry no timestamp and are always kept" — a whole-set
    // claim built from three rows out of nine hundred.
    assert.doesNotMatch(row.detail, /^900 exist; 2 carry no timestamp/)
  })

  it('keeps the unaged clause off a complete page that has none', () => {
    const plan = retentionPlan(envelope([aged('a'), aged('b')]), envelope([]))
    assert.doesNotMatch(retentionRow('Field reports', plan.fieldReports).detail, /timestamp/)
  })
})

describe('the preview refuses before the confirm gate, not after it', () => {
  it('proceeds when both collections were read', () => {
    const plan = retentionPlan(envelope([aged('a')]), envelope([aged('b')]))
    assert.equal(retentionRefusal(plan), null)
  })

  it('refuses and names the collection it could not read', () => {
    const plan = retentionPlan(null, envelope([aged('b')]))
    const refusal = retentionRefusal(plan)
    assert.match(refusal, /field reports could not be read/)
    assert.match(refusal, /Nothing was deleted/)
  })

  it('names both when neither was read', () => {
    const refusal = retentionRefusal(retentionPlan(null, null))
    assert.match(refusal, /field reports and RapidPro inbound messages could not be read/)
  })

  it('refuses on the inbound side alone', () => {
    const refusal = retentionRefusal(retentionPlan(envelope([aged('a')]), null))
    assert.match(refusal, /RapidPro inbound messages could not be read/)
    assert.doesNotMatch(refusal, /field reports and/, 'only one collection is missing here')
  })
})

describe('the refusal is on the path the button takes, not just in a function', () => {
  /**
   * Serve the two preview reads through `installBrowserEnv`'s own `respond`
   * hook, failing whichever the case names by answering with a status the
   * runtime treats as a failure.
   *
   * Not by assigning `globalThis.fetch`: `installBrowserEnv` *replaces* the
   * global with its own stub, so a stub assigned before the import is
   * overwritten and every request succeeds against `{data: []}`. That is a
   * silently vacuous test — it passed with the refusal disabled.
   */
  function responder({ fail = [] } = {}) {
    return (url) => {
      const path = String(url)
      const which = path.includes('field-reports') ? 'reports' : path.includes('rapidpro/inbound') ? 'inbound' : null
      if (which && fail.includes(which)) return { ok: false, status: 503, body: { success: false, error: 'unavailable' } }
      const rows = which === 'reports'
        ? [{ id: 'r1', occurred_at: '2020-01-01T00:00:00.000Z' }]
        : [{ id: 'i1', occurred_at: '2020-01-01T00:00:00.000Z' }]
      return { body: { data: rows, returned: rows.length, limit: 500, total: rows.length, has_more: false, next_cursor: null } }
    }
  }

  /**
   * Drive the real `runRetention` — the function the button handler awaits —
   * rather than the button itself. The element stub's `closest()` returns null,
   * so a click never reaches the handler's `result(control, …)` line, and a test
   * that fires the click observes nothing: it passed for both the broken and the
   * fixed code until this was pointed at the seam that carries the behaviour.
   */
  async function runWith(opened, { fail = [] } = {}) {
    const { runRetention } = await importFrontEnd('workflow/ops.js', { respond: responder({ fail }) })
    return await runRetention((opts) => opened.push(opts))
  }

  it('does not open the confirm gate when a collection could not be read', async () => {
    const opened = []
    const refusal = await runWith(opened, { fail: ['reports'] })
    assert.equal(opened.length, 0, 'the confirm gate for an irreversible delete must not open on a preview built from a failed read')
    assert.match(String(refusal), /could not be read/, 'and it must say why, or the caller reports a dialog that never opened')
  })

  it('does open it when both collections were read', async () => {
    const opened = []
    const refusal = await runWith(opened)
    assert.equal(opened.length, 1, 'a readable preview must still be able to reach the delete')
    assert.equal(refusal, null, 'a dialog that opened is not a refusal')
  })
})

describe('the outbox dispatch count names its bound', () => {
  it('does not present a truncated backlog as the whole backlog', () => {
    const page = [{ id: 'e1', status: 'pending' }, { id: 'e2', status: 'sent' }]
    const said = outboxBacklog(envelope(page, { total: 900, hasMore: true }), 1)
    assert.match(said, /1 pending in the first 2 events read/)
    assert.match(said, /of 900 in the outbox/, 'thousands-separated by num()')
    assert.match(said, /dispatch acts on the whole outbox/)
  })

  it('says so when the count could not be read at all', () => {
    // `pending` is 0 here because the envelope never arrived, and dispatch still
    // runs against every pending event in the store.
    const said = outboxBacklog(null, 0)
    assert.match(said, /could not read/)
    assert.doesNotMatch(said, /^0 pending/, 'a failed read is not a backlog of zero')
  })

  it('states a complete backlog plainly', () => {
    const page = [{ id: 'e1', status: 'pending' }, { id: 'e2', status: 'pending' }]
    assert.equal(outboxBacklog(envelope(page), 2), '2 pending')
  })
})

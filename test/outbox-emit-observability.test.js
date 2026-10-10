/**
 * OBS-02 — an emit that failed was indistinguishable from one that succeeded.
 *
 * `try { await emit(store, 'report.created', record) } catch {}` swallowed the
 * failure whole. The record was stored, the handler returned 201 `success: true`,
 * and no subscriber was ever told — with no error line, no counter, and no
 * dead-letter row. Every other emit site in the platform logs and counts; these
 * two were the exception, and they sit on the report paths an operator is most
 * likely to be watching during an incident.
 *
 * The store here fails the outbox merge specifically, which is the real failure
 * mode: the record write succeeds and the event write does not.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/** Capture what the process writes to stderr — the logger's only sink. */
function captureStderr() {
  const original = process.stderr.write
  const lines = []
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk))
    return original.call(process.stderr, chunk, ...rest)
  }
  return {
    lines,
    events() {
      return lines
        .map((line) => { try { return JSON.parse(line) } catch { return null } })
        .filter(Boolean)
    },
    restore() { process.stderr.write = original },
  }
}

/**
 * A JsonStore whose outbox merge always fails.
 *
 * Wrapping `merge` rather than making every write fail is the point: the report
 * itself must be persisted, so the only thing under test is what the handler
 * does about the event it could not enqueue.
 */
class OutboxFailingStore extends JsonStore {
  async merge(writes) {
    if (writes && Object.prototype.hasOwnProperty.call(writes, 'events_outbox')) {
      throw new Error('events_outbox write refused (simulated)')
    }
    return super.merge(writes)
  }
}

describe('OBS-02 — an outbox emit failure is logged and counted, not swallowed', () => {
  let server
  let baseUrl
  let store
  let tmpDir

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-emit-obs-'))
    store = new OutboxFailingStore(path.join(tmpDir, 'store.json'))
    store.mode = 'json'
    server = createServer({ store })
    await new Promise((resolve) => server.listen(0, resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('names the failure on the log line when a report is created', async () => {
    const capture = captureStderr()
    try {
      const res = await fetch(`${baseUrl}/api/v1/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Emit observability probe', actor: 'test' }),
      })
      // The report is still created: the gap is the event, not the record.
      assert.equal(res.status, 201)

      const failures = capture.events().filter((line) => line.event === 'outbox_emit_failed')
      assert.ok(failures.length >= 1, `expected an outbox_emit_failed line, got: ${JSON.stringify(capture.events().map((l) => l.event))}`)
      const line = failures.find((item) => item.event_name === 'report.created') || failures[0]
      // A named event, a readable message, and the error's own text. The old
      // shape produced `{0:'o',1:'u',…}` with no `event` field at all.
      assert.equal(typeof line.event, 'string')
      assert.ok(line.message, 'the failure must carry a message a human can read')
      assert.ok(line.err?.message, 'the failure must carry the underlying error')
    } finally {
      capture.restore()
    }
  })

  it('counts the failure so a scrape sees it without reading logs', async () => {
    const before = await (await fetch(`${baseUrl}/api/v1/metrics`)).text()
    const beforeCount = Number((before.match(/outbox_emit_failed_total\{[^}]*\}\s+(\d+)/) || [])[1] || 0)

    await fetch(`${baseUrl}/api/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Emit observability probe 2', actor: 'test' }),
    })

    const after = await (await fetch(`${baseUrl}/api/v1/metrics`)).text()
    const afterCount = Number((after.match(/outbox_emit_failed_total\{[^}]*\}\s+(\d+)/) || [])[1] || 0)
    assert.ok(afterCount > beforeCount,
      `outbox_emit_failed_total must rise when an emit fails (before=${beforeCount}, after=${afterCount})`)
  })

  it('still records the report, because the record is the durable half', async () => {
    const data = await store.read()
    assert.ok(data.reports.some((report) => report.title === 'Emit observability probe'))
  })
})

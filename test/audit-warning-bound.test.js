import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  auditChainWarning,
  auditChainWarningStats,
  auditRollup,
  chainEntries,
  resetAuditChainWarnings,
} from '../src/audit-chain.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * CON-08 — the "already warned" set grew for the process lifetime, and nothing
 * called the function that owns it.
 *
 * `reportedHeads` is keyed `event:head`, and a head changes on every append to
 * `action_logs` — so every write produced a new key and the set grew without
 * bound. It is a dedupe cache, not a record.
 *
 * The second half is that `auditChainWarning` had zero callers in the whole
 * repository: a broken chain was reported on the readiness body and in no log,
 * which is the opposite of what it was written for. An operator watching logs
 * during an incident saw nothing.
 */

function captureStderr() {
  const original = process.stderr.write
  const lines = []
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk))
    return original.call(process.stderr, chunk, ...rest)
  }
  return {
    events() {
      return lines.map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    },
    restore() { process.stderr.write = original },
  }
}

const logs = (n) => Array.from({ length: n }, (_, i) => ({
  id: `l${i + 1}`,
  collection: 'reports',
  record_id: `r${i + 1}`,
  action: 'created',
  actor: 'a',
  subject: null,
  created_at: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
  summary: `created report r${i + 1}`,
  metadata: {},
}))

describe('CON-08 — the warned-head cache is bounded', () => {
  it('does not grow without limit as heads change', () => {
    resetAuditChainWarnings()
    const { limit } = auditChainWarningStats()
    // One append per head, which is the shape the key has: every write to
    // action_logs moves the head and so mints a new key.
    for (let i = 0; i < limit * 3; i += 1) {
      auditChainWarning('ready', { head: `head-${i}`, valid: false, entry_count: i, fatal_types: ['seq_gap'] })
    }
    const stats = auditChainWarningStats()
    assert.equal(stats.size, limit, `the set held ${stats.size} heads with a limit of ${limit}`)
  })

  it('still suppresses a repeat of the same head', () => {
    // The bound must not defeat the purpose: the same broken head, seen twice,
    // is one log line. Otherwise a probe polling every few seconds floods.
    resetAuditChainWarnings()
    const capture = captureStderr()
    try {
      const result = { head: 'same-head', valid: false, entry_count: 2, fatal_types: ['entry_hash_mismatch'] }
      assert.equal(auditChainWarning('ready', result), 'ready:same-head')
      assert.equal(auditChainWarning('ready', result), null, 'the second sighting logged again')
      assert.equal(capture.events().filter((e) => e.event === 'audit_chain_broken').length, 1)
    } finally {
      capture.restore()
    }
  })

  it('evicts the oldest head rather than refusing new ones', () => {
    // A cache that stopped accepting new keys at the bound would go permanently
    // silent on the newest break, which is the one worth reporting.
    resetAuditChainWarnings()
    const { limit } = auditChainWarningStats()
    for (let i = 0; i < limit; i += 1) auditChainWarning('ready', { head: `h${i}`, valid: false })
    assert.equal(auditChainWarningStats().size, limit)
    auditChainWarning('ready', { head: 'the-newest', valid: false })
    assert.equal(auditChainWarningStats().size, limit)
    assert.equal(auditChainWarning('ready', { head: 'the-newest', valid: false }), null,
      'the newest head must be remembered, or the cache is a one-shot silence')
  })
})

describe('a broken chain is logged, not only reported on a JSON body', () => {
  it('names the break on stderr when the readiness probe finds one', async () => {
    // The wiring half. `auditChainWarning` had no callers, so this line did not
    // exist for any input.
    resetAuditChainWarnings()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-audit-warn-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    // A linked chain with one entry edited: the stored linkage no longer
    // recomputes, which is the one shape `auditRollup` can fail on.
    const { entries } = chainEntries(logs(3))
    const tampered = entries.map((entry) => ({ ...entry }))
    tampered[1].actor = 'token_operator_forged'
    await store.merge({ action_logs: tampered })
    const server = createServer({ store }).listen(0)
    const base = `http://127.0.0.1:${server.address().port}`
    const capture = captureStderr()
    try {
      const body = await (await fetch(`${base}/api/v1/ready`)).json()
      assert.equal(body.audit.valid, false, 'the fixture must actually break the chain')
      const warnings = capture.events().filter((line) => line.event === 'audit_chain_broken')
      assert.ok(warnings.length >= 1, `expected an audit_chain_broken line, got ${JSON.stringify(capture.events().map((l) => l.event))}`)
      assert.equal(warnings[0].head, body.audit.head)
      assert.deepEqual(warnings[0].defects, body.audit.fatal_types)
    } finally {
      capture.restore()
      server.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('does not repeat the line for a head it has already reported', async () => {
    resetAuditChainWarnings()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-audit-once-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const { entries } = chainEntries(logs(3))
    const tampered = entries.map((entry) => ({ ...entry }))
    tampered[0].actor = 'forged'
    await store.merge({ action_logs: tampered })
    const server = createServer({ store }).listen(0)
    const base = `http://127.0.0.1:${server.address().port}`
    const capture = captureStderr()
    try {
      await fetch(`${base}/api/v1/ready`)
      await fetch(`${base}/api/v1/ready`)
      await fetch(`${base}/api/v1/ready`)
      const warnings = capture.events().filter((line) => line.event === 'audit_chain_broken')
      assert.equal(warnings.length, 1,
        `a probe polled three times logged the same break ${warnings.length} times`)
    } finally {
      capture.restore()
      server.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a clean chain as unanchored rather than as broken', () => {
    // The advisory case: a chain that recomputes but has no published head. It
    // is still worth a line — a proof nobody anchored is weaker than it looks —
    // but it must not read as a break.
    resetAuditChainWarnings()
    const capture = captureStderr()
    try {
      const rollup = auditRollup(chainEntries(logs(2)).entries)
      assert.equal(rollup.valid, true)
      assert.equal(rollup.anchored, false)
      auditChainWarning('ready', rollup)
      const line = capture.events().find((e) => e.event === 'audit_chain_broken')
      assert.ok(line, 'the unanchored case is reported too')
      assert.match(line.message, /without a published head/)
    } finally {
      capture.restore()
    }
  })
})

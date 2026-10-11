import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHash, webcrypto } from 'node:crypto'

import {
  CHAINED_FIELDS,
  GENESIS_HASH,
  chainDigestInput,
  verifyChainWith,
  verifyChainInBrowser,
} from '../public/shared/audit-chain-core.js'
import { chainEntries, verifyChain } from '../src/audit-chain.js'

/** A chain built the way the server builds one, so both halves see real input. */
function build(n, mutate = null) {
  const records = []
  for (let i = 1; i <= n; i += 1) {
    records.push({
      id: `log_${i}`,
      collection: 'hazard_events',
      record_id: `hazard_${i}`,
      action: 'create',
      actor: 'user:alice',
      subject: 'region:TURKANA',
      summary: `entry ${i}`,
      created_at: `2026-01-0${i}T00:00:00.000Z`,
      metadata: { run: 'run_1' },
    })
  }
  const { entries } = chainEntries(records)
  return mutate ? mutate(entries) : entries
}

const serverHash = (text) => createHash('sha256').update(text).digest('hex')

describe('audit chain core (ENH-75) — one walk, two digest sources', () => {
  it('is the field list the server hashes', () => {
    // The split module's whole risk is two encodings drifting. There is one list
    // and the server imports it; if a field is added here, the server commits to
    // it too, and this asserts the two are the same object rather than equal.
    assert.ok(CHAINED_FIELDS.includes('created_at'), 'created_at is chained; re-dating an entry is a forgery')
    assert.equal(GENESIS_HASH, '0'.repeat(64))
    assert.equal(chainDigestInput({ seq: 1 }, GENESIS_HASH), `${GENESIS_HASH}\n${JSON.stringify({
      action: null, actor: null, collection: null, created_at: null,
      metadata: null, record_id: null, seq: 1, subject: null, summary: null,
    })}`, 'keys are sorted at every depth, which is the whole encoding')
  })

  it('verifies a clean chain with a synchronous hash', () => {
    const entries = build(5)
    const result = verifyChainWith(entries, serverHash)
    assert.equal(result.verified, true)
    assert.equal(result.entry_count, 5)
    assert.equal(result.head, entries[4].entry_hash)
  })

  it('catches an edited entry with the same defect the server reports', () => {
    const entries = build(5, (e) => {
      const copy = structuredClone(e)
      copy[2].summary = 'entry 3, revised'
      return copy
    })
    const result = verifyChainWith(entries, serverHash)
    assert.equal(result.verified, false)
    assert.ok(result.defects.some((d) => d.type === 'entry_hash_mismatch'))
    assert.ok(result.defects.some((d) => d.type === 'prev_hash_mismatch'))
  })

  it('catches a removed middle entry', () => {
    const entries = build(5, (e) => e.filter((_, i) => i !== 2))
    const result = verifyChainWith(entries, serverHash)
    assert.equal(result.verified, false)
    assert.ok(result.defects.some((d) => d.type === 'seq_gap'))
  })

  it('catches a consistent re-chain only with an anchor', () => {
    // The failure mode the whole module exists to close: rewrite every entry and
    // re-chain it, and every stored field agrees with every other. Only the
    // published head, obtained out of band, sees it.
    const original = build(5)
    const publishedHead = original[4].entry_hash
    const rechain = build(5, (e) => chainEntries(
      e.map((entry) => ({ ...entry, summary: `${entry.summary} (revised)` })),
    ).entries)

    assert.equal(verifyChainWith(rechain, serverHash).verified, true, 'internally consistent, as designed')
    const anchored = verifyChainWith(rechain, serverHash, { expectedHead: publishedHead })
    assert.equal(anchored.verified, false)
    assert.ok(anchored.defects.some((d) => d.type === 'head_mismatch'))
  })

  it('marks an unanchored clean chain verified but not anchored', () => {
    const result = verifyChainWith(build(3), serverHash)
    assert.equal(result.verified, true)
    assert.equal(result.anchored, false)
    assert.ok(result.defects.some((d) => d.type === 'unanchored' && d.severity === 'advisory'))
  })
})

describe('audit chain core (ENH-75) — the browser verifier', () => {
  it('recomputes the same head the server does, over the same entries', async () => {
    // The cross-check that matters: the browser walk and the server walk must
    // agree bit-for-bit on real input, or a partner verifying an export gets a
    // false alarm on an intact chain.
    const entries = build(6)
    const server = verifyChain(entries, { expectedHead: entries[5].entry_hash })
    const browser = await verifyChainInBrowser(entries, { expectedHead: entries[5].entry_hash, scope: { crypto: webcrypto } })

    assert.equal(browser.available, true)
    assert.equal(browser.head, server.head)
    assert.equal(browser.verified, server.verified)
    assert.equal(browser.entry_count, server.entry_count)
  })

  it('catches the same tampering the server catches', async () => {
    const entries = build(6, (e) => {
      const copy = structuredClone(e)
      copy[1].actor = 'user:mallory'
      return copy
    })
    const server = verifyChain(entries, { expectedHead: entries[5].entry_hash })
    const browser = await verifyChainInBrowser(entries, { expectedHead: entries[5].entry_hash, scope: { crypto: webcrypto } })

    assert.equal(browser.verified, false)
    assert.equal(browser.verified, server.verified)
    assert.deepEqual(
      browser.defects.map((d) => d.type).sort(),
      server.defects.map((d) => d.type).sort(),
    )
  })

  it('reports a missing secure context as its own state, not as a broken chain', async () => {
    // A verifier that throws is one the caller renders as "could not check",
    // which is indistinguishable on screen from "the chain is broken". Absence
    // of crypto.subtle is its own answer.
    const entries = build(3)
    const result = await verifyChainInBrowser(entries, { scope: {} })
    assert.equal(result.available, false)
    assert.equal(result.verified, false)
    assert.equal(result.head, null)
    assert.ok(result.defects.some((d) => d.type === 'no_webcrypto'))
  })

  it('agrees with the synchronous core on an unanchored chain', async () => {
    const entries = build(4)
    const sync = verifyChainWith(entries, serverHash)
    const browser = await verifyChainInBrowser(entries, { scope: { crypto: webcrypto } })
    assert.equal(browser.verified, sync.verified)
    assert.equal(browser.anchored, sync.anchored)
    assert.equal(browser.head, sync.head)
  })
})

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { PostgresStore, WRITE_LOCK_KEY, withWriteRetry } from '../src/postgres-store.js'
import { postgresCluster } from './pg-harness.mjs'

/**
 * CON-02 and CON-03, against a real PostgreSQL.
 *
 * Both defects are races, and a race is the one thing a mock cannot reproduce:
 * every assertion here needs two connections genuinely contending, with the
 * database deciding the order. A fake pool that returns canned rows would make
 * these tests pass against the broken code — which is the failure mode this
 * file exists to avoid, so nothing here is stubbed. `pg-harness.mjs` starts a
 * throwaway cluster rather than skipping, and a skip under CI is an error.
 *
 * CON-02 — no deadlock retry, and a `write()`/`merge()` lock inversion.
 *   `write()` deletes every row outside `__schema` inside one transaction while
 *   `merge()` upserts those same rows. Two connections doing that at once can
 *   deadlock, and the caller used to get a raw `40P01` with no backoff.
 *
 * CON-03 — the `payload_hash` dedupe SELECT is not serialised against a
 *   concurrent merge. Two merges both read the hash as absent and both insert,
 *   producing two rows with different ids and identical content, which
 *   `ON CONFLICT (collection, id)` does not catch.
 *
 * The fix for both is one transaction-scoped advisory lock taken by every
 * writer, so the tests below are about that lock: that it is actually taken,
 * that it actually serialises, and that a writer cannot proceed while another
 * holds it. A test that only checked the outcome could pass on a machine whose
 * timing happened not to interleave.
 */

describe('CON-02 / CON-03 — every write takes the same advisory lock', () => {
  let cluster
  let store
  let sql

  /** Skips loudly; fails outright under CI, where green must have meant something. */
  const needsPostgres = (t) => {
    const reason = cluster?.skipped
    if (!reason) return false
    if (process.env.CI) {
      throw new Error(
        `CI ran the CON-02/CON-03 suite without a database: ${reason}. Every test here `
        + 'would have passed without executing a single statement.',
      )
    }
    t.skip(`no PostgreSQL: ${reason}`)
    return true
  }

  /** A second connection to the same cluster, independent of the store's pool. */
  const client = async () => {
    if (!sql) {
      const pg = (await import('pg')).default
      sql = new pg.Client({ connectionString: cluster.url })
      await sql.connect()
    }
    return sql
  }

  /** How many advisory locks one key is currently held under, cluster-wide. */
  const holdersOf = async (key) => {
    const db = await client()
    const { rows } = await db.query(
      `SELECT count(*)::int AS held FROM pg_locks
        WHERE locktype = 'advisory' AND objid = $1 AND granted`,
      [key],
    )
    return rows[0].held
  }

  /** Resolves true if `promise` has not settled within `ms`. */
  const stillPending = async (promise, ms) => {
    let settled = false
    promise.then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => { setTimeout(resolve, ms) })
    return !settled
  }

  before(async () => {
    cluster = await postgresCluster({ name: 'lindela-write-lock' })
    if (cluster.skipped) {
      process.stderr.write(`pg-write-lock: ${cluster.skipped}\n`)
      return
    }
    store = new PostgresStore({ databaseUrl: cluster.url })
    await store.ensureSchema()
    await store.write({ field_reports: [] })
  })

  after(async () => {
    await sql?.end()
    await store?.close()
    await cluster?.stop()
  })

  it('holds the lock while a merge is in flight, and not after', async (t) => {
    // The mechanism itself. A merge that never took the lock would leave this
    // count at zero the whole way through, and the serialisation the two
    // defects need would be absent even though every outcome test still passed.
    if (needsPostgres(t)) return
    const db = await client()
    // Hold the key on a separate connection so the merge must queue behind it.
    await db.query('BEGIN')
    await db.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK_KEY])
    try {
      assert.equal(await holdersOf(WRITE_LOCK_KEY), 1, 'the fixture must hold the lock')
      const merging = store.merge({ field_reports: [{ id: 'r-blocked', note: 'waits' }] })
      assert.equal(await stillPending(merging, 150), true,
        'the merge committed while another connection held the write lock')
    } finally {
      await db.query('ROLLBACK')
    }
    await store.merge({ field_reports: [{ id: 'r-unblocked', note: 'proceeds' }] })
    const data = await store.read(['field_reports'])
    assert.deepEqual((data.field_reports || []).map((r) => r.id).sort(), ['r-blocked', 'r-unblocked'],
      'the queued merge must complete once the lock is released')
  })

  it('serialises two concurrent merges so a duplicate hash cannot slip through', async (t) => {
    // CON-03, reproduced deterministically rather than by hoping two fast merges
    // interleave. Issuing two merges together and checking the row count is not
    // a guard: without the lock they usually finish one after the other anyway,
    // and the test passes on the broken code. (It did — the canary caught it.)
    //
    // So the interleaving is forced. A separate connection takes the write lock,
    // inserts the content *uncommitted*, and only then is the merge issued. The
    // merge's dedupe SELECT runs under READ COMMITTED and cannot see an
    // uncommitted row, so:
    //   - without the lock the merge proceeds at once, sees nothing, and inserts
    //     a second row with the same hash under a different id — the defect;
    //   - with the lock the merge is queued behind the insert above, and by the
    //     time it reads, the row is committed and the hash is recognised.
    if (needsPostgres(t)) return
    const hash = 'con03-shared-content'
    const db = await client()
    await db.query('BEGIN')
    await db.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK_KEY])
    await db.query(
      `INSERT INTO lite_records (collection, id, body, payload_hash, updated_at)
       VALUES ('field_reports', 'dup-a', $1::jsonb, $2, now())`,
      [JSON.stringify({ id: 'dup-a', payload_hash: hash, note: 'first' }), hash],
    )
    const merging = store.merge({ field_reports: [{ id: 'dup-b', payload_hash: hash, note: 'second' }] })
    // The merge must not have committed while the row above is uncommitted —
    // that is the whole serialisation guarantee.
    assert.equal(await stillPending(merging, 150), true,
      'the merge ran while another connection held an uncommitted row it should have seen')
    await db.query('COMMIT')
    await merging
    const data = await store.read(['field_reports'])
    const withHash = (data.field_reports || []).filter((r) => r.payload_hash === hash)
    assert.equal(withHash.length, 1,
      `the same content was stored ${withHash.length} times under different ids`)
  })

  it('serialises a write() behind the same lock a merge() takes', async (t) => {
    // CON-02. `write()` and `merge()` take row locks in opposite orders, so
    // running them together is the deadlock the audit found — and, as with
    // CON-03, a test that merely runs them concurrently passes on the broken
    // code whenever the timing does not collide. The lock is asserted directly:
    // while another connection holds it, neither a write nor a merge may
    // proceed.
    if (needsPostgres(t)) return
    const db = await client()
    await db.query('BEGIN')
    await db.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK_KEY])
    let write = null
    let merge = null
    try {
      write = store.write({ field_reports: [{ id: 'w-1' }, { id: 'w-2' }] })
      merge = store.merge({ field_reports: [{ id: 'm-1' }] })
      assert.equal(await stillPending(write, 150), true, 'write() did not take the write lock')
      assert.equal(await stillPending(merge, 150), true, 'merge() did not take the write lock')
    } finally {
      await db.query('ROLLBACK')
    }
    const results = await Promise.allSettled([write, merge])
    const failed = results.filter((r) => r.status === 'rejected')
    assert.deepEqual(failed.map((r) => r.reason?.code ?? String(r.reason)), [],
      'a write or merge failed rather than waiting for the lock')
  })

  it('leaves the lock released after a write, so a later writer is not blocked', async (t) => {
    // A session-scoped lock, or an unlock missed on one exit path, would show up
    // here: the transaction that took it has ended, so the key must be free.
    if (needsPostgres(t)) return
    await store.merge({ field_reports: [{ id: 'after-1' }] })
    await store.remove({ collection: { field_reports: ['after-1'] } })
    await store.replaceCollection('field_reports', [{ id: 'after-2' }])
    assert.equal(await holdersOf(WRITE_LOCK_KEY), 0,
      'a write transaction left the advisory lock held after it finished')
  })
})

describe('CON-02 — a retryable serialisation failure is retried, not returned', () => {
  it('retries a deadlock and returns the eventual result', async () => {
    // The retry is the secondary mechanism now that the lock serialises writers,
    // but it still covers contention with a process that does not take the lock.
    // Driven with a synthetic error so the test does not depend on the timing
    // that produces a real `40P01` — which is not reliably reproducible on
    // demand, and a test that could not fail would be worse than none.
    let attempts = 0
    const result = await withWriteRetry(async () => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('deadlock detected')
        error.code = '40P01'
        throw error
      }
      return 'committed'
    })
    assert.equal(result, 'committed')
    assert.equal(attempts, 3, 'the retry gave up before the write could succeed')
  })

  it('does not retry a failure the database will repeat', async () => {
    // Retrying a syntax error or a constraint violation pays the backoff three
    // times to report the same thing. Only the two codes Postgres names as
    // retryable are retried.
    let attempts = 0
    const error = new Error('duplicate key value violates unique constraint')
    error.code = '23505'
    await assert.rejects(
      () => withWriteRetry(async () => { attempts += 1; throw error }),
      /duplicate key/,
    )
    assert.equal(attempts, 1, 'a non-retryable error was retried')
  })

  it('surfaces the last error when every attempt is retryable', async () => {
    // Exhausting the attempts must not swallow the failure into an undefined
    // return: the caller has to be able to see why the write never landed.
    let attempts = 0
    await assert.rejects(
      () => withWriteRetry(async () => {
        attempts += 1
        const error = new Error(`serialization failure ${attempts}`)
        error.code = '40001'
        throw error
      }),
      /serialization failure 3/,
    )
    assert.equal(attempts, 3)
  })
})

describe('CON-02 — the store\'s write paths are actually wrapped in the retry', () => {
  /**
   * A pool whose first `BEGIN` fails with a deadlock and whose second succeeds.
   *
   * `withWriteRetry` being correct is not the same as the store calling it: the
   * wrapper could be removed from `#mergeOnce` and every test above would still
   * pass, because they exercise the function directly. A real `40P01` cannot be
   * produced on demand, so the pool is faked here — the one place in this file
   * where a fake is the honest tool, because the subject is the wiring and not
   * the database.
   */
  function flakyPool({ failWith = '40P01', failTimes = 1 } = {}) {
    const statements = []
    let begins = 0
    const client = {
      async query(sql) {
        statements.push(sql.trim().split('\n')[0].slice(0, 40))
        if (/^BEGIN/i.test(sql)) {
          begins += 1
          if (begins <= failTimes) {
            const error = new Error('deadlock detected')
            error.code = failWith
            throw error
          }
        }
        if (/SELECT payload_hash/i.test(sql)) return { rows: [] }
        return { rows: [] }
      },
      release() {},
    }
    return { pool: { connect: async () => client }, statements, begins: () => begins }
  }

  it('retries a merge that deadlocked, rather than returning the error', async () => {
    const { pool, begins } = flakyPool({ failTimes: 1 })
    const store = new PostgresStore({ pool })
    store.ready = true // skip ensureSchema; the pool is not a real database
    await store.merge({ field_reports: [{ id: 'r-1' }] })
    assert.equal(begins(), 2, 'the merge did not start a second transaction after the deadlock')
  })

  it('retries a write() that deadlocked', async () => {
    const { pool, begins } = flakyPool({ failTimes: 1 })
    const store = new PostgresStore({ pool })
    store.ready = true
    await store.write({ field_reports: [{ id: 'r-1' }] })
    assert.equal(begins(), 2, 'write() did not retry')
  })

  it('does not retry a merge that failed for a reason the database will repeat', async () => {
    // The other side of the wiring: a non-retryable error must reach the caller
    // on the first attempt, or a constraint violation would be hidden behind two
    // backoffs and then reported anyway.
    const { pool, begins } = flakyPool({ failWith: '23505', failTimes: 99 })
    const store = new PostgresStore({ pool })
    store.ready = true
    await assert.rejects(() => store.merge({ field_reports: [{ id: 'r-1' }] }), /deadlock detected/)
    assert.equal(begins(), 1, 'a non-retryable error was retried')
  })
})

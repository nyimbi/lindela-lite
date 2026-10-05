import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer, applyScheduledRetention, runPeriodicTick } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { retentionWindowFor } from '../src/pii.js'

/**
 * R-12 — `community_feedback` was the only PII-bearing collection with no
 * retention rule, and retention ran only when somebody POSTed to it.
 *
 * Two defects, and either alone is survivable; together they are the reason a
 * member of the public's words were kept forever.
 *
 * The missing rule: the collection carries `reporter_urn_hash` and a free-text
 * `message`, and the two collections holding the same class of data —
 * `field_reports`, `rapidpro_inbound_messages` — both had one. Being the only
 * collection without a rule is what makes it an oversight rather than a
 * decision, so the fix gives it a window of its own (shorter by default, because
 * a hazard report is about a hazard and a community comment is a person) rather
 * than folding it into the general one and calling the two the same thing.
 *
 * The unscheduled route: `POST /api/v1/maintenance/apply-retention` was the only
 * way retention ran. A privacy window that is applied when somebody remembers
 * is a comment in a JSON file. It runs on the driver now, and the driver's
 * heartbeat says what it expired — a retention job that reports success forever
 * is the DAT-07 failure mode, and a gate that has never watched it purge
 * anything is not a gate.
 */

const DAY = 24 * 60 * 60 * 1000

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r12-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store, dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const feedback = (id, ageDays) => ({
  id,
  type: 'community_feedback',
  reporter_urn_hash: 'sha256:abc',
  message: 'the borehole at Kilima has been dry',
  created_at: new Date(Date.now() - ageDays * DAY).toISOString(),
})

describe('R-12 — community feedback has a window of its own', () => {
  it('it is shorter than the general window by default', () => {
    const policy = { retentionDays: 365, communityFeedbackDays: 180 }
    assert.equal(retentionWindowFor(policy, 'community_feedback'), 180,
      'a person\'s own words are not an operational record and are kept for less time')
    assert.equal(retentionWindowFor(policy, 'field_reports'), 365)
  })

  it('a deployment can set them equal', () => {
    assert.equal(
      retentionWindowFor({ retentionDays: 365, communityFeedbackDays: 365 }, 'community_feedback'),
      365,
      'the window is a decision, and the decision is the deployment\'s',
    )
  })

  it('a collection with no window configured purges nothing and says so', () => {
    // The NaN-window failure: `age > NaN` is false for every record, so a
    // misconfigured policy expired nothing while reporting success.
    assert.equal(retentionWindowFor({ retentionDays: 0, communityFeedbackDays: null }, 'community_feedback'), null)
    assert.equal(retentionWindowFor({}, 'community_feedback'), null)
  })
})

describe('R-12 — retention runs without anybody remembering to run it', () => {
  it('a tick expires old feedback and keeps the recent', async () => {
    await withStore(async (store) => {
      await store.merge({ community_feedback: [feedback('old-feedback', 400), feedback('new-feedback', 3)] })

      const data = await store.read()
      const result = await applyScheduledRetention(store, data)
      assert.equal(result.collections.community_feedback.expired, 1,
        'a 400-day-old community comment is past the 180-day window')
      assert.equal(result.collections.community_feedback.kept, 1)

      const after = await store.read()
      const ids = after.community_feedback.map((r) => r.id)
      assert.deepEqual(ids, ['new-feedback'],
        'the expired record must actually be gone — the DAT-07 failure was a removal that reported success')
    })
  })

  it('the removal reaches the store, not just the report', async () => {
    // Asserted through a tick rather than by calling the helper, because the
    // defect was never that retention could not expire a record — it is that
    // nothing called it.
    await withStore(async (store) => {
      await store.merge({ community_feedback: [feedback('ancient', 900)] })
      const heartbeat = await runPeriodicTick(store)
      const retention = heartbeat.items.find((item) => item.id === 'retention')
      assert.ok(retention, 'the driver does not run retention, so the window is only applied by hand')
      assert.equal(retention.ok, true, retention.error || '')
      assert.equal(retention.summary.expired, 1)

      const after = await store.read()
      assert.equal(after.community_feedback.length, 0)
    })
  })

  it('the maintenance route reports the collection rather than staying silent about it', async () => {
    await withStore(async (store) => {
      await store.merge({ community_feedback: [feedback('stale', 400)] })
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r12-http-'))
      const listener = createServer({ store }).listen(0)
      const base = `http://localhost:${listener.address().port}`
      try {
        const res = await fetch(`${base}/api/v1/maintenance/apply-retention`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.ok(body.community_feedback,
          'the route answers about two collections and not the third, which is how ' +
          'a collection with no rule stays invisible')
        assert.equal(body.community_feedback.expired, 1)
        assert.equal(body.community_feedback.window_days, 180)
      } finally {
        listener.close()
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })
})

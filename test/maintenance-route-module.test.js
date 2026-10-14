import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { JsonStore } from '../src/store.js'
import { loadPolicy, personalWindowKey } from '../src/pii.js'
import {
  RETENTION_COLLECTIONS,
  applyRetentionForRequest,
  matchMaintenanceRoute,
} from '../src/routes/maintenance.js'
import { createServer, applyScheduledRetention } from '../src/server.js'

/**
 * ENH-60 — the operator-maintenance family, and the defect that made it one.
 *
 * `POST /api/v1/maintenance/apply-retention` and the driver's `retention` item
 * are two implementations of one operation, and they disagreed about which
 * window decides a refusal. The route asked `retentionWindowDays` — the
 * *general* window — and 400'd when it was unset. The driver asked
 * `retentionWindowFor(policy, collection)` per collection. A deployment that
 * set only `communityFeedbackDays`, the more sensitive of the two, and left
 * `retentionDays` at zero got a 400 saying "Nothing was deleted" from the route
 * while the scheduled driver expired `community_feedback` on every tick.
 *
 * The tests below are the ones that would have caught it: the route and the
 * driver are run against the same policy and asserted to agree about which
 * collections have a window and how many records each expires. A test of the
 * route alone cannot see this — the divergence is between two call sites, so
 * the assertion has to be between two call sites.
 */

const DAY = 24 * 60 * 60 * 1000

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-maint-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store, dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const record = (id, collection, ageDays) => ({
  id,
  type: collection,
  created_at: new Date(Date.now() - ageDays * DAY).toISOString(),
})

/** A policy shaped like `loadPolicy()`'s output, so the helpers see a real one. */
const policy = (over = {}) => ({
  redactNames: true,
  redactPhone: true,
  coarsenGeoToH3Cell: null,
  retentionDays: 365,
  communityFeedbackDays: 180,
  ...over,
})

/**
 * A config that leaves *every* collection without a window, derived rather than
 * hand-listed.
 *
 * `RETENTION_COLLECTIONS` grows — `annotations` joined it under ENH-74 — and a
 * test that spells out `{retentionDays: 0, communityFeedbackDays: 0}` is a
 * policy where the new collection still has its default and therefore still has
 * a window. The refusal would never fire and the test would report that the
 * route refused nothing, which reads as a defect in the route. Every key the
 * set names is zeroed here instead, so adding a collection cannot silently
 * retire this case.
 */
const NO_WINDOW = {
  retentionDays: 0,
  ...Object.fromEntries(RETENTION_COLLECTIONS.map((c) => [personalWindowKey(c), 0]).filter(([k]) => k)),
}

/**
 * Run `fn` with the process policy set to `config`, the way a deployment sets it.
 *
 * The driver calls `loadPolicy()` itself and takes no policy argument, so a
 * test that compares the route against the driver has to configure both through
 * the same channel or it is comparing two different policies and calling the
 * difference a defect.
 */
async function withPolicyEnv(config, fn) {
  const prior = process.env.LINDELA_LITE_PII_POLICY
  process.env.LINDELA_LITE_PII_POLICY = JSON.stringify(config)
  try {
    return await fn(await loadPolicy())
  } finally {
    if (prior === undefined) delete process.env.LINDELA_LITE_PII_POLICY
    else process.env.LINDELA_LITE_PII_POLICY = prior
  }
}

describe('ENH-60 the maintenance matcher is method-aware and path-exact', () => {
  it('resolves both routes, and only on POST', () => {
    assert.deepEqual(matchMaintenanceRoute('/api/v1/maintenance/apply-retention', 'POST'), { kind: 'apply-retention' })
    assert.deepEqual(matchMaintenanceRoute('/api/v1/demo/seed', 'POST'), { kind: 'demo-seed' })
    // Neither is a route on any other verb. A matcher that took every method
    // would make `GET /api/v1/demo/seed` a seed.
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal(matchMaintenanceRoute('/api/v1/demo/seed', method), null, `${method} was matched`)
      assert.equal(matchMaintenanceRoute('/api/v1/maintenance/apply-retention', method), null, `${method} was matched`)
    }
    assert.equal(matchMaintenanceRoute('/api/v1/maintenance', 'POST'), null, 'a prefix is not the route')
    assert.equal(matchMaintenanceRoute('/api/v1/demo/seed/extra', 'POST'), null)
  })
})

describe('ENH-60 the route and the driver agree about which window applies', () => {
  it('a policy with only the community window is not a refusal, and both expire the same record', async () => {
    // The defect, stated as one assertion across both call sites. `retentionDays`
    // is 0 — the value the route used to read as "nothing is configured" — while
    // `communityFeedbackDays` is set. The driver expires the stale feedback; the
    // route must agree rather than 400.
    //
    // Both are driven through the process policy, because the driver calls
    // `loadPolicy()` itself: comparing a hand-built policy object against it
    // would compare two policies and call the difference a defect.
    await withPolicyEnv({ retentionDays: 0, communityFeedbackDays: 30 }, async (loaded) => {
      await withStore(async (store) => {
        await store.merge({
          field_reports: [record('fr-kept', 'field_reports', 4000)],
          community_feedback: [record('fb-stale', 'community_feedback', 400)],
        })
        const data = await store.read()

        const viaRoute = await applyRetentionForRequest(store, data, loaded)
        assert.equal(viaRoute.community_feedback.window_days, 30, 'the route did not read the collection\'s own window')
        assert.equal(viaRoute.community_feedback.expired, 1)
        // No general window, so the operational collections have no rule — the
        // route reports that per collection rather than refusing the request.
        assert.equal(viaRoute.field_reports.window_days, null)
        assert.equal(viaRoute.field_reports.expired, 0)
      })

      // The control: the driver, same policy, same collection, same verdict.
      await withStore(async (store) => {
        await store.merge({ community_feedback: [record('fb-stale', 'community_feedback', 400)] })
        const data = await store.read()
        const viaDriver = await applyScheduledRetention(store, data)
        assert.equal(viaDriver.collections.community_feedback.window_days, 30,
          'the driver and the route disagree about the community window — this is the ENH-60 defect')
        assert.equal(viaDriver.collections.community_feedback.expired, 1)
      })
    })
  })

  it('a policy with no window at all is still the refusal', async () => {
    // The condition the 400 was always about: nothing can be applied. Removing
    // the refusal would be the opposite defect — a route that reports success
    // over a policy that purges nothing, which is DAT-07.
    const none = policy(NO_WINDOW)
    await withStore(async (store) => {
      await store.merge({ community_feedback: [record('fb-old', 'community_feedback', 900)] })
      const data = await store.read()
      const result = await applyRetentionForRequest(store, data, none)
      assert.ok(Object.values(result).every((c) => c.window_days === null),
        'a collection reported a window under a policy that has none')
      assert.ok(Object.values(result).every((c) => c.expired === 0))
    })
  })

  it('a collection with no rule of its own falls back to the general window, and is still reported', async () => {
    // `RETENTION_COLLECTIONS` is the set both call sites must cover — a route
    // that answers about two of three is how R-12's omission stayed invisible.
    //
    // The fallback is deliberate and is not the same thing as "no rule":
    // `retentionWindowFor` prefers the collection's own window and uses the
    // general one otherwise. A collection has *no* rule only when the general
    // window is unset too, and the assertion below distinguishes the two so a
    // future change cannot collapse them.
    await withStore(async (store) => {
      await store.merge({
        field_reports: [record('fr-old', 'field_reports', 400)],
        rapidpro_inbound_messages: [record('rp-old', 'rapidpro_inbound_messages', 400)],
        community_feedback: [record('fb-old', 'community_feedback', 400)],
      })
      const data = await store.read()

      // General window set, community window unset: feedback falls back to 365
      // and a 400-day-old record expires under it.
      const fallback = await applyRetentionForRequest(store, data, policy({ communityFeedbackDays: 0 }))
      assert.deepEqual(Object.keys(fallback).sort(), [...RETENTION_COLLECTIONS].sort())
      assert.equal(fallback.field_reports.expired, 1)
      assert.equal(fallback.rapidpro_inbound_messages.expired, 1)
      assert.equal(fallback.community_feedback.window_days, 365, 'the unset community window falls back to the general one')
      assert.equal(fallback.community_feedback.expired, 1)

      // Neither set: every collection has no rule, and each says so rather than
      // being skipped out of the response.
      const none = await applyRetentionForRequest(store, data, policy(NO_WINDOW))
      assert.deepEqual(Object.keys(none).sort(), [...RETENTION_COLLECTIONS].sort())
      assert.ok(Object.values(none).every((c) => c.window_days === null),
        'a collection reported a window under a policy that has none')
    })
  })

  it('the removal reaches the store, not just the report', async () => {
    // DAT-07: `merge()` keyed on id left every expired record where it was while
    // the route reported `expired: 1`. Asserted against the store, not the count.
    await withStore(async (store) => {
      await store.merge({
        field_reports: [record('fr-old', 'field_reports', 400), record('fr-new', 'field_reports', 3)],
      })
      const data = await store.read()
      await applyRetentionForRequest(store, data, policy())
      const after = await store.read()
      assert.deepEqual(after.field_reports.map((r) => r.id), ['fr-new'])
    })
  })
})

describe('ENH-60 the route answers over HTTP the way the module does', () => {
  it('a community-only policy is a 200, not the 400 the route used to send', async () => {
    // The end-to-end half, because the divergence was reachable only through the
    // real dispatcher: the module agreeing with the driver is worth nothing if
    // the route still refuses before it gets there.
    await withPolicyEnv({ retentionDays: 0, communityFeedbackDays: 30 }, async () => {
      await withStore(async (store) => {
        await store.merge({ community_feedback: [record('fb-stale', 'community_feedback', 400)] })
        const listener = createServer({ store }).listen(0)
        const base = `http://localhost:${listener.address().port}`
        try {
          const res = await fetch(`${base}/api/v1/maintenance/apply-retention`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          assert.equal(res.status, 200, 'the route refused a policy that the driver acts on')
          const body = await res.json()
          assert.equal(body.success, true)
          assert.equal(body.community_feedback.window_days, 30)
          assert.equal(body.community_feedback.expired, 1)
          assert.equal(body.field_reports.window_days, null)
        } finally {
          listener.close()
        }
      })
    })
  })

  it('a policy with no window at all is still a 400 over HTTP', async () => {
    // The other side of the same boundary: the refusal must survive the fix.
    await withPolicyEnv(NO_WINDOW, async () => {
      await withStore(async (store) => {
        const listener = createServer({ store }).listen(0)
        const base = `http://localhost:${listener.address().port}`
        try {
          const res = await fetch(`${base}/api/v1/maintenance/apply-retention`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          assert.equal(res.status, 400, 'a policy that purges nothing reported success')
          const body = await res.json()
          assert.equal(body.success, false)
          assert.match(body.error, /no retention window is configured/)
        } finally {
          listener.close()
        }
      })
    })
  })
})

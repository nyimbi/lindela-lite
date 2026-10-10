import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseTokens, scopeToPartnerOrg } from '../src/auth.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * Partner-organisation scoping was a no-op that displayed itself as working.
 *
 * To be precise about what this separates, because the word "multi-tenancy" is
 * the wrong one and has been used for this feature throughout: a Lindela Lite
 * deployment is one operator running one country programme against one
 * database. `partner_org` separates *organisations working the same response* —
 * NGO A's field reports from NGO B's — not customers sharing infrastructure.
 * The records it guards are the ones carrying names and affected household
 * counts, so one organisation reading another's is a disclosure, not a cosmetic
 * mismatch.
 *
 * `scopeToPartnerOrg` keyed on `auth.partner_org`, a field `authenticate()`
 * never set — so it always returned every record. It had no call sites in
 * `src/` at all. Meanwhile the partner portal sent `?partner_org=<org>` on
 * every request, the server read nothing, and the header rendered the
 * organisation from localStorage. A partner could have believed they were
 * looking at their own data while receiving the whole store.
 *
 * Three separate layers were missing: the claim could not be expressed, the
 * claim could not be enforced, and the claim could not be checked.
 */

const TOKENS = JSON.stringify([
  { token: 'tok-a', scopes: ['read:*'], partner_org: 'orgA' },
  { token: 'tok-b', scopes: ['read:*'], partner_org: 'orgB' },
  { token: 'tok-plain', scopes: ['read:*'] },
  // The by-id write tests need a token that can reach the route at all. A
  // 403 from the scope gate would prove nothing about partner scoping, so the
  // writer carries the scope the route requires and the partner claim under
  // test.
  { token: 'tok-a-writer', scopes: ['read:*', 'write:reports'], partner_org: 'orgA' },
])

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-partner-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  const previous = { tokens: process.env.LINDELA_LITE_TOKENS }
  process.env.LINDELA_LITE_TOKENS = TOKENS
  try {
    return await fn(base, store)
  } finally {
    if (previous.tokens === undefined) delete process.env.LINDELA_LITE_TOKENS
    else process.env.LINDELA_LITE_TOKENS = previous.tokens
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const get = (base, path, token) => fetch(`${base}${path}`, {
  headers: { authorization: `Bearer ${token}` },
})

describe('a partner claim can be expressed', () => {
  it('carries partner_org from the token definition through authenticate', () => {
    const tokens = parseTokens({ LINDELA_LITE_TOKENS: TOKENS })
    assert.equal(tokens[0].partner_org, 'orgA')
    assert.equal(tokens[2].partner_org, null, 'a token with no claim has none, rather than an empty string that matches nothing')
  })

  it('refuses a partner_org that is not a string', () => {
    assert.throws(
      () => parseTokens({ LINDELA_LITE_TOKENS: JSON.stringify([{ token: 't', scopes: [], partner_org: 7 }]) }),
      (err) => err.statusCode === 500 || /partner_org/.test(err.message),
    )
  })

  it('scopes by the token, not by the caller', () => {
    const records = [
      { id: 'r1', partner_org: 'orgA' },
      { id: 'r2', partner_org: 'orgB' },
      { id: 'r3' },
    ]
    assert.deepEqual(scopeToPartnerOrg(records, { partner_org: 'orgA' }).map((r) => r.id), ['r1'])
    assert.deepEqual(scopeToPartnerOrg(records, { partner_org: 'orgB' }).map((r) => r.id), ['r2'])
    // A token with no claim is a platform token, and sees the platform.
    assert.equal(scopeToPartnerOrg(records, {}).length, 3)
  })

  it('shows a partner nothing when no record is tagged', () => {
    // The truthful answer for a deployment with no per-partner tagging. The
    // alternative — passing untagged records through — is the leak.
    assert.deepEqual(scopeToPartnerOrg([{ id: 'r1' }, { id: 'r2' }], { partner_org: 'orgA' }), [])
  })
})

describe('a partner claim is enforced', () => {
  const assets = [
    { id: 'a1', name: 'Clinic A', partner_org: 'orgA', service_type: 'health', population_served: 100 },
    { id: 'a2', name: 'Clinic B', partner_org: 'orgB', service_type: 'health', population_served: 200 },
    { id: 'a3', name: 'Clinic C', service_type: 'health', population_served: 300 },
  ]

  it('returns only the caller\'s own records', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const body = await (await get(base, '/api/v1/service-assets', 'tok-a')).json()
      assert.deepEqual(body.data.map((r) => r.id), ['a1'])
    })
  })

  it('gives a different partner a different answer from the same store', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const a = await (await get(base, '/api/v1/service-assets', 'tok-a')).json()
      const b = await (await get(base, '/api/v1/service-assets', 'tok-b')).json()
      assert.deepEqual(a.data.map((r) => r.id), ['a1'])
      assert.deepEqual(b.data.map((r) => r.id), ['a2'])
    })
  })

  it('hides untagged records rather than showing them to everyone', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const body = await (await get(base, '/api/v1/service-assets', 'tok-a')).json()
      assert.ok(!body.data.some((r) => r.id === 'a3'),
        'a record with no partner_org is not this partner\'s')
    })
  })

  it('leaves an unscoped token with the whole platform', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const body = await (await get(base, '/api/v1/service-assets', 'tok-plain')).json()
      assert.equal(body.data.length, 3)
    })
  })

  it('scopes the widest read in the API', async () => {
    // GET /api/v1/export.csv is the route SEC-01 found serving field reports
    // and RapidPro message bodies unauthenticated. It also passed no context
    // at all, so it had no partner scoping either: an export that ignored the
    // token would undo everything the list routes now do.
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const res = await get(base, '/api/v1/export.csv', 'tok-a')
      assert.equal(res.status, 200)
      const text = await res.text()
      assert.match(text, /Clinic A/)
      assert.ok(!text.includes('Clinic B'), "orgB's clinic appeared in orgA's export")
      assert.ok(!text.includes('Clinic C'))
    })
  })

  it('refuses a partner_org on the export route too', async () => {
    await withServer(async (base) => {
      const res = await get(base, '/api/v1/export.csv?partner_org=orgB', 'tok-a')
      assert.equal(res.status, 403)
    })
  })

  it('applies the scope after the filters, not instead of them', async () => {
    // A filter that matched nothing must still return nothing: scoping by
    // partner is a restriction on top of the query, not a substitute.
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const body = await (await get(base, '/api/v1/service-assets?service_type=water', 'tok-a')).json()
      assert.deepEqual(body.data, [])
    })
  })
})

describe('a partner claim can be checked', () => {
  it('refuses a partner_org the token does not speak for', async () => {
    await withServer(async (base) => {
      const res = await get(base, '/api/v1/service-assets?partner_org=orgB', 'tok-a')
      assert.equal(res.status, 403)
      assert.match((await res.json()).error, /does not match this token/)
    })
  })

  it('refuses a partner_org from a token that has no claim', async () => {
    // The portal sent this on every request. Before, the server read nothing
    // and every partner received the whole store while the interface showed
    // the filter as applied.
    await withServer(async (base) => {
      const res = await get(base, '/api/v1/service-assets?partner_org=orgA', 'tok-plain')
      assert.equal(res.status, 403)
      assert.match((await res.json()).error, /not scoped to a partner organisation/)
    })
  })

  it('accepts the token\'s own partner_org', async () => {
    await withServer(async (base) => {
      const res = await get(base, '/api/v1/service-assets?partner_org=orgA', 'tok-a')
      assert.equal(res.status, 200)
    })
  })

  it('reports who the caller is', async () => {
    await withServer(async (base) => {
      const { data } = await (await get(base, '/api/v1/auth-info', 'tok-b')).json()
      assert.equal(data.partner_org, 'orgB')
      assert.match(data.subject, /^token_[0-9a-f]{12}$/)
      assert.deepEqual(data.scopes, ['read:*'])
      assert.equal(data.auth_configured, true)
    })
  })

  it('reports no organisation for a platform token rather than inventing one', async () => {
    await withServer(async (base) => {
      const { data } = await (await get(base, '/api/v1/auth-info', 'tok-plain')).json()
      assert.equal(data.partner_org, null)
    })
  })
})
describe('the calibration figures are scoped like the records beside them', () => {
	// JTBD-018 cited `calibrationReport` as evidence that
	// GET /api/v1/assessments "includes calibration metadata". It did not: the
	// function was exported, documented and called from nowhere. Wiring it
	// creates a second way to learn about another organisation's data — a mean over
	// scores the caller may not read — so the wiring has to carry the scope.
	const scores = [
		{ id: 's1', type: 'flood_risk', score: 40, confidence: 0.8, interval_width: 20, partner_org: 'orgA' },
		{ id: 's2', type: 'flood_risk', score: 60, confidence: 0.6, interval_width: 30, partner_org: 'orgB' },
		{ id: 's3', type: 'flood_risk', score: 20, confidence: 0.4, interval_width: 40 },
	]

	it('reports calibration at all, which is what the catalogue claims it does', async () => {
		await withServer(async (base, store) => {
			await store.merge({ risk_scores: scores })
			const { data } = await (await get(base, '/api/v1/assessments', 'tok-plain')).json()
			assert.ok(Array.isArray(data.calibration), 'the field the catalogue cites is present')
			assert.equal(data.calibration.length, 1)
			assert.equal(data.calibration[0].type, 'flood_risk')
		})
	})

	it('averages only the scores the caller may see', async () => {
		await withServer(async (base, store) => {
			await store.merge({ risk_scores: scores })
			const { data } = await (await get(base, '/api/v1/assessments', 'tok-a')).json()
			const row = data.calibration.find((r) => r.type === 'flood_risk')
			assert.equal(row.count, 1, "orgB's and untagged scores are not counted in orgA's calibration")
			assert.equal(row.mean_score, 40)
			assert.equal(row.mean_confidence, 0.8)
		})
	})

	it('gives each partner a different mean from the same store', async () => {
		await withServer(async (base, store) => {
			await store.merge({ risk_scores: scores })
			const mean = async (token) => {
				const { data } = await (await get(base, '/api/v1/assessments', token)).json()
				return data.calibration.find((r) => r.type === 'flood_risk').mean_score
			}
			assert.equal(await mean('tok-a'), 40)
			assert.equal(await mean('tok-b'), 60)
		})
	})

	it('reports an empty calibration rather than a mean of nothing', async () => {
		await withServer(async (base, store) => {
			await store.merge({ risk_scores: scores })
			const { data } = await (await get(base, '/api/v1/assessments', 'tok-a')).json()
			assert.ok(!data.calibration.some((r) => r.type === 'climate_conflict_risk'),
				'a type with no visible scores is absent, not zero')
		})
	})
})

describe('a partner claim is enforced on the by-id read too', () => {
	// VUL-03. The list form was scoped and the by-id form was not. `GET
	// /api/v1/reports` returned only orgA's reports while `GET
	// /api/v1/reports/<orgB-id>` returned orgB's, because the by-id branch was
	// `data.reports.find((item) => item.id === route.id)` — a lookup with no
	// predicate at all. An id is not a secret: every listing, every export and
	// every link in a report the two organisations share carries one.
	//
	// Thirty-one call sites had that shape across nine handlers. Fixing one of
	// them would have been the bug again one route over, so the fix is a single
	// resolver every by-id branch goes through, and these tests drive the routes
	// rather than the resolver — a test of the helper would pass while a handler
	// still called `.find()`.
	const reports = [
		{ id: 'rep_a', title: 'A situation report', partner_org: 'orgA', status: 'draft' },
		{ id: 'rep_b', title: 'B situation report', partner_org: 'orgB', status: 'draft' },
		{ id: 'rep_untagged', title: 'Untagged report', status: 'draft' },
	]

	it('refuses another organisation\'s report by id', async () => {
		await withServer(async (base, store) => {
			await store.merge({ reports })
			const res = await get(base, '/api/v1/reports/rep_b', 'tok-a')
			assert.equal(res.status, 404, 'orgA read orgB\'s report by id')
		})
	})

	it('still serves the caller\'s own report by id', async () => {
		// The scoping must not be a blanket refusal: a partner that cannot read
		// its own record by id has lost a working feature, not a leak.
		await withServer(async (base, store) => {
			await store.merge({ reports })
			const res = await get(base, '/api/v1/reports/rep_a', 'tok-a')
			assert.equal(res.status, 200)
			assert.equal((await res.json()).data.id, 'rep_a')
		})
	})

	it('hides an untagged report by id, the same as in the listing', async () => {
		await withServer(async (base, store) => {
			await store.merge({ reports })
			const res = await get(base, '/api/v1/reports/rep_untagged', 'tok-a')
			assert.equal(res.status, 404, 'an untagged record is not this partner\'s')
		})
	})

	it('leaves an unscoped token the whole platform by id', async () => {
		await withServer(async (base, store) => {
			await store.merge({ reports })
			for (const id of ['rep_a', 'rep_b', 'rep_untagged']) {
				const res = await get(base, `/api/v1/reports/${id}`, 'tok-plain')
				assert.equal(res.status, 200, `${id} was hidden from a platform token`)
			}
		})
	})

	it('refuses another organisation\'s record on the export by id', async () => {
		await withServer(async (base, store) => {
			await store.merge({ reports })
			const res = await get(base, '/api/v1/reports/rep_b/export.md', 'tok-a')
			assert.equal(res.status, 404, 'orgB\'s report was rendered for orgA')
		})
	})

	it('refuses another organisation\'s record on a mutating by-id route', async () => {
		// The write side matters more than the read side: a PATCH is how orgA
		// would change a record it must not see, and a 200 here is worse than a
		// leaked body because the change persists.
		await withServer(async (base, store) => {
			await store.merge({ reports })
			const res = await fetch(`${base}/api/v1/reports/rep_b`, {
				method: 'PATCH',
				headers: { authorization: 'Bearer tok-a-writer', 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'rewritten by orgA' }),
			})
			assert.equal(res.status, 404, 'orgA patched orgB\'s report')
			const after = await store.read()
			assert.equal(after.reports.find((r) => r.id === 'rep_b').title, 'B situation report')
		})
	})

	it('agrees with the listing about a record that carries no partner claim', async () => {
		// `webhook_subscriptions` are platform configuration, not partner data:
		// they carry no `partner_org` and never will. Whatever a deployment
		// decides about a partner token reading them, the by-id form must give
		// the same answer as the list form — a by-id read that is more
		// permissive than the listing is the leak, and one that is stricter is a
		// feature that works in the console and 404s on refresh.
		await withServer(async (base, store) => {
			await store.merge({ webhook_subscriptions: [{ id: 'wh_1', url: 'https://example.test/hook', events: ['alert.created'] }] })
			const listed = await (await get(base, '/api/v1/webhooks', 'tok-a')).json()
			const byId = await get(base, '/api/v1/webhooks/wh_1', 'tok-a')
			assert.equal(byId.status, listed.data.length ? 200 : 404,
				'the by-id read disagreed with the listing about the same record')
		})
	})
})

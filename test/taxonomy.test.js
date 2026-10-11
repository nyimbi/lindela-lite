import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  BUILTIN_CATEGORIES, CATEGORY_GROUPS, mergeCategories, loadTaxonomySync,
  resolveCategory, assertCategory, categoriesInGroup, taxonomyDocument,
} from '../src/taxonomy.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-taxonomy-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://127.0.0.1:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('impact/needs taxonomy (CAP-05)', () => {
  it('gives every built-in a code, a label and a declared group', () => {
    for (const category of BUILTIN_CATEGORIES) {
      assert.match(category.code, /^[a-z][a-z0-9_]*$/, `${category.code} is not a slug`)
      assert.ok(category.label, `${category.code} has no label`)
      assert.ok(category.group in CATEGORY_GROUPS, `${category.code} has no declared group`)
    }
    const codes = BUILTIN_CATEGORIES.map((c) => c.code)
    assert.equal(new Set(codes).size, codes.length, 'a code is listed twice')
  })

  it('covers the values the store already holds, including the American spelling', () => {
    // The demo seed writes `diarrhea`; the code is `diarrhoea`. A taxonomy that
    // refuses the data it already has is a migration, not a taxonomy.
    assert.equal(resolveCategory('diarrhea'), 'diarrhoea')
    assert.equal(resolveCategory('fever'), 'fever')
    assert.equal(resolveCategory('cholera'), 'cholera')
    assert.equal(resolveCategory('flood'), 'flood')
    for (const code of ['fever', 'cough', 'diarrhea', 'flood', 'drought', 'conflict']) {
      assert.ok(resolveCategory(code), `the seed's '${code}' does not resolve`)
    }
  })

  it('resolves case, whitespace and label spellings', () => {
    assert.equal(resolveCategory('  FLOOD '), 'flood')
    assert.equal(resolveCategory('Flood'), 'flood')
    assert.equal(resolveCategory('Suspected cholera'), 'cholera')
    assert.equal(resolveCategory('wash'), 'water')
    assert.equal(resolveCategory('violence'), 'conflict')
  })

  it('returns null for no category, and for a value it does not know', () => {
    // "Not classified" is a legitimate state; "classified as nonsense" is not,
    // and the two must not collapse into the same answer.
    assert.equal(resolveCategory(null), null)
    assert.equal(resolveCategory(''), null)
    assert.equal(resolveCategory('   '), null)
    assert.equal(resolveCategory('a made up category'), null)
  })

  it('throws a 400 naming the vocabulary for an unknown category', () => {
    assert.throws(() => assertCategory('nonsense'), (error) => {
      assert.equal(error.statusCode, 400)
      assert.match(error.message, /category must be one of/)
      assert.match(error.message, /flood/, 'the error does not say what would have been accepted')
      return true
    })
    assert.equal(assertCategory('wash'), 'water')
    assert.equal(assertCategory(null), null)
  })

  it('lets a deployment add a category without a code change', () => {
    const merged = mergeCategories([{ code: 'locust', label: 'Locust swarm', group: 'hazard' }])
    assert.ok(merged.some((c) => c.code === 'locust' && c.deployment === true))
    // And the resolver sees it when the taxonomy is passed explicitly.
    const tax = { categories: merged, aliases: {} }
    assert.equal(resolveCategory('locust', { taxonomy: tax }), 'locust')
  })

  it('lets a deployment relabel a built-in rather than fork the list', () => {
    const merged = mergeCategories([{ code: 'flood', label: 'Flooding', group: 'hazard' }])
    const flood = merged.find((c) => c.code === 'flood')
    assert.equal(flood.label, 'Flooding')
    assert.equal(merged.filter((c) => c.code === 'flood').length, 1, 'the relabel duplicated the code')
  })

  it('ignores a malformed extension with a reason rather than throwing', () => {
    // A bad config must not stop the process from serving, and the refusal has
    // to be visible rather than swallowed.
    const bad = loadTaxonomySync({ env: { LINDELA_LITE_TAXONOMY: '{not json' } })
    assert.equal(bad.problems.length, 1)
    assert.match(bad.problems[0], /not valid JSON/)
    assert.ok(bad.categories.length >= BUILTIN_CATEGORIES.length, 'the built-ins were lost with the extension')

    const shapeless = loadTaxonomySync({ env: { LINDELA_LITE_TAXONOMY: '{"nope":true}' } })
    assert.match(shapeless.problems[0], /carried no `categories` array/)
  })

  it('drops an extension entry whose code is not a slug', () => {
    const merged = mergeCategories([{ code: 'Not A Slug', label: 'x' }, { code: 'ok_one' }])
    assert.equal(merged.some((c) => c.code === 'Not A Slug'), false)
    assert.ok(merged.some((c) => c.code === 'ok_one'))
    // An entry with no group lands in `other` rather than failing: a partner
    // adding a category should not have to know the group vocabulary.
    assert.equal(merged.find((c) => c.code === 'ok_one').group, 'other')
  })

  it('groups categories for a form that renders a section at a time', () => {
    assert.ok(categoriesInGroup('health').some((c) => c.code === 'fever'))
    assert.ok(categoriesInGroup('hazard').some((c) => c.code === 'flood'))
    assert.deepEqual(categoriesInGroup('nonexistent'), [])
  })

  it('serves the vocabulary through the front door', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/taxonomy`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.data.categories.some((c) => c.code === 'flood'))
      assert.ok(body.data.groups.hazard)
      assert.ok(body.data.aliases.diarrhea)
    })
  })

  it('refuses an unknown category on a field report, through the route', async () => {
    await withServer(async (base, store) => {
      await store.merge({ incidents: [{ id: 'inc-1', title: 'Flood', status: 'open', severity: 'high' }] })
      const res = await fetch(`${base}/api/v1/field-reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ incident_id: 'inc-1', summary: 'Water rising', category: 'nonsense' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(JSON.stringify(body), /category must be one of/)
    })
  })

  it('stores an aliased spelling under its canonical code, through the route', async () => {
    await withServer(async (base, store) => {
      await store.merge({ incidents: [{ id: 'inc-1', title: 'Flood', status: 'open', severity: 'high' }] })
      const res = await fetch(`${base}/api/v1/field-reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ incident_id: 'inc-1', summary: 'Sick child', category: 'diarrhea' }),
      })
      const body = await res.json()
      assert.equal(res.status, 201, JSON.stringify(body))
      const record = body.data || body
      assert.equal(record.category, 'diarrhoea')
    })
  })

  it('guards the CHW route too, which writes field_reports without the normaliser', async () => {
    // `POST /api/v1/chw/report` builds its `field_reports` record inline and
    // never reaches `normalizeFieldReport`, so a registry wired only there is a
    // gate at one of two doors. The CHW client is the highest-volume writer of
    // this field, which makes it the door that matters.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/chw/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'symptom', category: 'nonsense', description: 'x' }),
      })
      assert.equal(res.status, 400, 'the CHW door accepted a category the taxonomy does not know')

      // And it no longer stores the *form* as the category when none was sent.
      const bare = await fetch(`${base}/api/v1/chw/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'incident', description: 'flooded road' }),
      })
      assert.equal(bare.status, 201)
      assert.equal((await bare.json()).data.category, null, 'a transport fact was stored as a category')
    })
  })

  it('carries every value the CHW symptom wizard can post', async () => {
    // The wizard's five buttons are the client's whole vocabulary for this
    // field. A taxonomy that omits one refuses the client that writes most of
    // these records — the failure is not hypothetical, it is the first report
    // a health worker files from the rash button.
    const html = await fs.readFile(new URL('../public/chw/index.html', import.meta.url), 'utf8')
    const offered = [...html.matchAll(/data-symptom-type="([^"]+)"/g)].map((m) => m[1])
    assert.ok(offered.length >= 5, `the wizard offers ${offered.length} symptoms; the regex found none`)
    for (const value of offered) {
      // `diarrhea` is the American spelling on the button and `diarrhoea` is the
      // code, so the assertion is that the value resolves — not that it is
      // unchanged. `assertCategory` throws on a refusal, so an omitted button
      // fails here; the idempotency check catches an alias pointing at a code
      // the vocabulary does not hold, which would resolve once and never again.
      const code = assertCategory(value)
      assert.ok(code, `the wizard's '${value}' button posts a category that resolves to nothing`)
      assert.equal(assertCategory(code), code, `'${value}' resolved to '${code}', which does not itself resolve`)
    }
  })

  it('writes the seed\'s categories where the API reads them, not in metadata', async () => {
    // The seed parked its category in `metadata.category`, which nothing reads:
    // a filter on `category` missed all forty seed reports and every one of them
    // listed as unclassified. The demo store is what a new deployment's screens
    // are judged against, so a field the API validates and the seed ignores is
    // the first thing a partner sees.
    const { seedAll } = await import('../src/demo-seed.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-seed-taxonomy-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    try {
      await seedAll(store)
      const reports = (await store.read()).field_reports || []
      assert.ok(reports.length >= 40, `the seed produced ${reports.length} field reports`)
      const unresolved = reports.filter((r) => r.category && !resolveCategory(r.category))
      assert.deepEqual(unresolved.map((r) => r.category), [], 'the seed writes categories the taxonomy refuses')
      assert.ok(reports.every((r) => r.metadata?.category === undefined),
        'the category is still duplicated into metadata, where nothing reads it')
      assert.ok(reports.some((r) => r.category), 'no seed report carries a category at all')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('presents the vocabulary as one document', () => {
    const doc = taxonomyDocument()
    assert.ok(doc.categories.length > 5)
    assert.equal(doc.problems.length, 0)
    assert.equal(doc.deployment_count, 0)
  })
})

/**
 * The product's only PII control.
 *
 * `src/pii.js` had no tests at all (TEST-03) and the control had three defects
 * (PRIV-02): the name redaction ships off, the pseudonym is an unsalted hash
 * truncated to 32 bits, and a coordinate at 0° was read as an absent one.
 *
 * What is asserted here is the return value of the real function, never a regex
 * over the source — the rule from docs/improvements/_research/00-audit-baseline.md
 * §B1, honoured here because the zero-coordinate fix landed in the same file.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import * as pii from '../src/pii.js'

// Namespace import, not a named one: a missing export is a link error that
// aborts the whole file, and a defect that cannot even be named is still a
// defect the rest of the suite has to be able to report on.
const { applyRetention, redactPii, piiSaltStatus } = pii

const COARSE = { coarsenGeoToH3Cell: 4 }

/**
 * A bounded name set — the shape of the population this hash is applied to.
 * A county's field reporters, a district's common given names. Not a password
 * corpus: a population anyone can enumerate from a voter roll or a phone book.
 */
const BOUNDED_NAMES = [
  'Achieng Odhiambo', 'Adhiambo Ochieng', 'Bakari Mwangi', 'Chitembwe Mulenga',
  'Daniel Kiptoo', 'Esther Wanjiku', 'Fatuma Ali', 'Grace Njeri', 'Hakim Said',
  'Ibrahim Mohammed', 'Jackline Akinyi', 'Kamau wa Ngugi', 'Lydia Chebet',
  'Miriam Wanjiru', 'Njeri Kamau', 'Otieno Ochola', 'Peter Kariuki', 'Rehema Mushi',
  'Selina Ndungu', 'Tshepo Molefe', 'Ubuntu wa Kasi', 'Victoria Atieno',
  'Wanjiru Kimani', 'Yusuf Abdalla', 'Zipporah Kiplagat', 'Amani Cheruiyot',
  'Baraka Simiyu', 'Chelsea Mbeki', 'Dennis Mutiso', 'Eunice Wafula',
]

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')

/** The pseudonym exactly as `src/pii.js` used to build it: 32 bits, no salt. */
const legacyToken = (value) => `sha256:${sha256(value).slice(0, 8)}`

/** Hex digest carried by a token produced by the current implementation. */
function digestOf(token) {
  const parts = String(token).split(':')
  return parts[parts.length - 1]
}

// -------------------------------------------------------------------
// The control must be on unless the deployment says otherwise
// -------------------------------------------------------------------

describe('pii name redaction default', () => {
  it('redacts a reporter name when the caller says nothing', () => {
    const out = redactPii({ reporter_name: 'Achieng Odhiambo', category: 'cholera' })
    assert.notEqual(out.reporter_name, 'Achieng Odhiambo', 'the name shipped unredacted')
    assert.equal(out.category, 'cholera', 'and the record survived the redaction')
  })

  it('redacts a contact name when the caller says nothing', () => {
    const out = redactPii({ contact_name: 'Fatuma Ali' })
    assert.notEqual(out.contact_name, 'Fatuma Ali')
  })

  it('treats an explicit undefined in the policy as "caller did not say"', () => {
    // `src/server.js:2563` passes `redactNames: body.anonymous`, which is
    // `undefined` for every request that omits the flag. A plain object spread
    // copies that undefined over the default, so the default was unreachable
    // from the one call site that most wants it.
    const out = redactPii({ reporter_name: 'Grace Njeri' }, { redactNames: undefined })
    assert.notEqual(out.reporter_name, 'Grace Njeri')
  })

  it('still honours an explicit opt-out', () => {
    const out = redactPii({ reporter_name: 'Grace Njeri' }, { redactNames: false })
    assert.equal(out.reporter_name, 'Grace Njeri')
  })

  it('leaves an absent name absent rather than inventing a pseudonym', () => {
    for (const record of [{ reporter_name: '' }, { reporter_name: null }, {}]) {
      const out = redactPii(record)
      assert.equal(out.reporter_name ?? '', '', 'no name in, no name out')
    }
  })

  it('does not mutate the record it was handed', () => {
    // redactPii runs on read paths too, where an in-place edit would destroy
    // the only copy of the plaintext.
    const record = { reporter_name: 'Hakim Said', phone: '+254700000001' }
    redactPii(record)
    assert.equal(record.reporter_name, 'Hakim Said')
    assert.equal(record.phone, '+254700000001')
  })
})

// -------------------------------------------------------------------
// The pseudonym has to survive a bounded dictionary
// -------------------------------------------------------------------

describe('pii name pseudonym', () => {
  it('is not an unsalted digest an attacker can precompute', () => {
    // The attacker has the roster. They hash every name on it and look the
    // result up. Under the old scheme this table is free to build.
    const dictionary = new Map(BOUNDED_NAMES.map((name) => [legacyToken(name), name]))
    // The attacker also has one confirmed (token, name) pair from any side
    // channel — an export, a support ticket — so a token shared by the whole
    // population is a dictionary of one entry that names everyone.
    const observed = new Map()
    for (const name of BOUNDED_NAMES) {
      const token = redactPii({ reporter_name: name }, { redactNames: true }).reporter_name
      assert.equal(
        dictionary.get(token), undefined,
        `a plain sha256 dictionary reverses this token back to a real name: ${token}`,
      )
      assert.ok(
        !String(token).includes(sha256(name)),
        `the token leaks the unsalted digest of ${name}`,
      )
      assert.equal(
        observed.get(token), undefined,
        `one token, ${BOUNDED_NAMES.length} people: a single confirmed pair identifies them all`,
      )
      observed.set(token, name)
    }
  })

  it('does not collide across a bounded name set', () => {
    // The old code truncated the *prefixed* string, so every redacted name was
    // the literal `sha256:a` — not 32 bits of collision, one value for the whole
    // population.
    const tokens = new Set()
    for (const name of BOUNDED_NAMES) {
      const token = redactPii({ reporter_name: name }, { redactNames: true }).reporter_name
      assert.ok(!tokens.has(token), `${name} and another name share the pseudonym ${token}`)
      tokens.add(token)
    }
    assert.equal(tokens.size, BOUNDED_NAMES.length)
  })

  it('carries far more than 32 bits of digest', () => {
    // 32 bits over a few thousand reporters is a birthday collision, not a
    // theoretical one: 10^4 names gives roughly a 1-in-230 chance of two
    // people sharing a pseudonym in any given deployment.
    const digest = digestOf(redactPii({ reporter_name: 'Peter Kariuki' }, { redactNames: true }).reporter_name)
    assert.match(digest, /^[0-9a-f]{32,}$/, `digest is only ${digest.length} hex chars`)
    assert.ok(
      digest.length * 4 >= 128,
      `digest is ${digest.length * 4} bits; a pseudonym needs at least 128`,
    )
  })

  it('is stable within a process, so two records of one person still link', () => {
    const first = redactPii({ reporter_name: 'Miriam Wanjiru' }, { redactNames: true }).reporter_name
    const second = redactPii({ contact_name: 'Miriam Wanjiru', id: 'b' }, { redactNames: true }).contact_name
    assert.equal(first, second, 'linkage across sources is the reason the hash exists')
  })

  it('changes when the deployment salt changes', () => {
    const before = process.env.LINDELA_LITE_PII_SALT
    try {
      delete process.env.LINDELA_LITE_PII_SALT
      const generated = redactPii({ reporter_name: 'Zipporah Kiplagat' }).reporter_name
      process.env.LINDELA_LITE_PII_SALT = 'a-different-deployment-salt'
      const configured = redactPii({ reporter_name: 'Zipporah Kiplagat' }).reporter_name
      assert.notEqual(generated, configured, 'two deployments must not share a pseudonym space')
    } finally {
      if (before === undefined) delete process.env.LINDELA_LITE_PII_SALT
      else process.env.LINDELA_LITE_PII_SALT = before
    }
  })
})

// -------------------------------------------------------------------
// The salt must never be silently absent
// -------------------------------------------------------------------

describe('pii salt', () => {
  it('never means "no salt" when it is unset', () => {
    const before = process.env.LINDELA_LITE_PII_SALT
    try {
      delete process.env.LINDELA_LITE_PII_SALT
      assert.equal(pii.piiSaltStatus().source, 'generated', 'unset must still key the hash')
      assert.ok(pii.piiSaltStatus().saltId.length > 0)
    } finally {
      if (before === undefined) delete process.env.LINDELA_LITE_PII_SALT
      else process.env.LINDELA_LITE_PII_SALT = before
    }
  })

  it('reports a configured salt without echoing it', () => {
    const before = process.env.LINDELA_LITE_PII_SALT
    try {
      process.env.LINDELA_LITE_PII_SALT = 'hunter2-hunter2-hunter2-hunter2'
      const status = pii.piiSaltStatus()
      assert.equal(status.source, 'configured')
      assert.ok(!JSON.stringify(status).includes('hunter2'), 'the salt leaked into its own status')
    } finally {
      if (before === undefined) delete process.env.LINDELA_LITE_PII_SALT
      else process.env.LINDELA_LITE_PII_SALT = before
    }
  })

  it('warns at first use when the salt is unset', () => {
    // Run in a child process: the warning fires once per process, so asserting
    // it in-process would depend on test ordering.
    const env = { ...process.env }
    delete env.LINDELA_LITE_PII_SALT
    const script = `
      import { redactPii } from ${JSON.stringify(new URL('../src/pii.js', import.meta.url).href)}
      redactPii({ reporter_name: 'Esther Wanjiku' })
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env, encoding: 'utf8',
    })
    assert.equal(child.status, 0, `child failed: ${child.stderr}`)
    assert.match(
      child.stderr, /LINDELA_LITE_PII_SALT/,
      'an unset salt must announce itself at startup, not run silently',
    )
  })
})

// -------------------------------------------------------------------
// 0° is a place
// -------------------------------------------------------------------

describe('pii geo coarsening at zero', () => {
  it('coarsens Null Island rather than reading it as absent', () => {
    const out = redactPii({ latitude: 0, longitude: 0 }, COARSE)
    assert.equal(out.geo_precision_deg, 1 / 16, 'the control did not apply')
    assert.equal(out.latitude, 0)
    assert.equal(out.longitude, 0)
  })

  it('coarsens each zero line on its own', () => {
    const onEquator = redactPii({ latitude: 0, longitude: 36.8 }, COARSE)
    assert.equal(onEquator.geo_precision_deg, 1 / 16)
    assert.equal(onEquator.latitude, 0)
    assert.notEqual(onEquator.longitude, 36.8)

    const onMeridian = redactPii({ latitude: 3.1167, longitude: 0 }, COARSE)
    assert.equal(onMeridian.geo_precision_deg, 1 / 16)
    assert.equal(onMeridian.longitude, 0)
    assert.notEqual(onMeridian.latitude, 3.1167)
  })

  it('accepts negative zero as a coordinate', () => {
    const out = redactPii({ latitude: -0, longitude: -0 }, COARSE)
    assert.equal(out.geo_precision_deg, 1 / 16, '-0 is a value, not an absence')
    assert.ok(Math.abs(out.latitude) === 0 && Math.abs(out.longitude) === 0)
  })

  it('leaves an undetermined coordinate alone', () => {
    for (const record of [
      { latitude: null, longitude: 36.8 },
      { latitude: 3.1167, longitude: undefined },
      { latitude: '', longitude: '' },
      { latitude: 'north-ish', longitude: 'somewhere' },
      { latitude: NaN, longitude: 36.8 },
    ]) {
      const out = redactPii(record, COARSE)
      assert.equal(out.geo_precision_deg, undefined, `coarsened an absent coordinate: ${JSON.stringify(record)}`)
      assert.equal(out.latitude, record.latitude)
      assert.equal(out.longitude, record.longitude)
    }
  })

  it('coarsens coordinates that arrive as strings', () => {
    const out = redactPii({ latitude: '3.1167', longitude: '36.8' }, COARSE)
    assert.equal(out.geo_precision_deg, 1 / 16)
    assert.equal(out.latitude, 3.125)
  })
})

// -------------------------------------------------------------------
// The rest of the module, which the absence of tests had left uncovered
// -------------------------------------------------------------------

describe('pii phone masking', () => {
  it('keeps only the last four digits', () => {
    const out = redactPii({ phone: '+254712345678' })
    assert.equal(out.phone, 'xxxx5678')
    assert.equal(out.urn, undefined, 'masking must not invent fields')
  })

  it('keeps a tel: prefix, so the redacted value is still a URN', () => {
    // It used to return `xxxx5678` — the same string as for a bare number, so a
    // column that had been URNs became a column of unparseable text and two
    // subscribers sharing a suffix became indistinguishable.
    assert.equal(redactPii({ phone: 'tel:+254712345678' }).phone, 'tel:xxxx5678')
    assert.equal(redactPii({ phone: '+254712345678' }).phone, 'xxxx5678',
      'and a bare number must not acquire a prefix it never had')
  })

  it('does not mangle a number it cannot mask', () => {
    assert.equal(redactPii({ phone: '123' }).phone, '123')
    assert.equal(redactPii({ phone: '' }).phone, '')
  })

  it('honours an explicit opt-out of phone masking', () => {
    assert.equal(redactPii({ phone: '+254712345678' }, { redactPhone: false }).phone, '+254712345678')
  })
})

describe('pii retention', () => {
  const now = Date.parse('2026-10-03T00:00:00Z')

  it('splits records on the boundary and keeps undated ones', () => {
    const { kept, expired } = applyRetention([
      { id: 'fresh', occurred_at: '2026-10-01T00:00:00Z' },
      { id: 'stale', occurred_at: '2025-09-01T00:00:00Z' },
      { id: 'undated' },
    ], 365, now)
    assert.deepEqual(kept.map((r) => r.id), ['fresh', 'undated'])
    assert.deepEqual(expired.map((r) => r.id), ['stale'])
  })

  it('survives a non-array', () => {
    assert.deepEqual(applyRetention(null, 365, now), { kept: [], expired: [] })
  })
})

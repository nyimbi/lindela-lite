import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sdnCacheTtlMs, parseSdnCsv, normalizeName } from '../src/sanctions.js'

describe('the SDN cache TTL is a duration, not an absence', () => {
  // `Number(env || 24h)` read a nonsense setting as NaN, and `elapsed < NaN` is
  // false, so the cache was never used: every screening downloaded the whole
  // SDN export again. A disbursement loop screens one recipient at a time, so a
  // typo in an env file became one large fetch per recipient. Nothing about
  // that failure looks wrong — screening still answers, only slower.
  const DAY = 24 * 60 * 60 * 1000

  it('takes the stated duration', () => {
    assert.equal(sdnCacheTtlMs({ OFAC_SDN_CACHE_TTL_MS: '60000' }), 60000)
  })

  it('falls back to a day when the setting is unset or blank', () => {
    assert.equal(sdnCacheTtlMs({}), DAY)
    assert.equal(sdnCacheTtlMs({ OFAC_SDN_CACHE_TTL_MS: '' }), DAY)
    assert.equal(sdnCacheTtlMs({ OFAC_SDN_CACHE_TTL_MS: '   ' }), DAY)
  })

  it('falls back when the setting cannot be read, rather than never caching', () => {
    for (const junk of ['abc', '24h', 'NaN', 'Infinity']) {
      const ttl = sdnCacheTtlMs({ OFAC_SDN_CACHE_TTL_MS: junk })
      assert.equal(ttl, DAY, `'${junk}' became ${ttl}, which disables the cache`)
      assert.ok(Number.isFinite(ttl))
    }
  })

  it('treats a zero or negative duration as unset, the same direction as the query budget', () => {
    assert.equal(sdnCacheTtlMs({ OFAC_SDN_CACHE_TTL_MS: '0' }), DAY)
    assert.equal(sdnCacheTtlMs({ OFAC_SDN_CACHE_TTL_MS: '-5' }), DAY)
  })
})

describe('the SDN CSV reader', () => {
  it('keeps a comma inside a quoted name', () => {
    const entries = parseSdnCsv('2676,"ANGLO-CARIBBEAN CO., LTD.",-0- \n')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'ANGLO-CARIBBEAN CO., LTD.')
  })

  it('drops the corporate suffix and keeps the distinguishing word', () => {
    // `Holdings` is part of the name, not a suffix: two entities called
    // "Acme Holdings" and "Acme Trading" are different companies.
    assert.equal(normalizeName('Acme Holdings Ltd.'), 'ACME HOLDINGS')
    assert.equal(normalizeName('ACME HOLDINGS'), 'ACME HOLDINGS')
  })
})

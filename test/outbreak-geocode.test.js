import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COUNTRY_CENTROIDS,
  COUNTRY_NAMES,
  geocodeOutbreakLocation,
  matchPilotDistrict,
} from '../public/shared/outbreak-geocode.js'

describe('outbreak geocoding', () => {
  it('places a pilot district name as subnational evidence', () => {
    const hit = geocodeOutbreakLocation('Lodwar, Turkana County', null)
    assert.deepEqual(hit, {
      latitude: 3.1167,
      longitude: 35.6,
      location_name: 'Turkana',
      granularity: 'subnational',
    })
  })

  it('matches district names on word boundaries — Bor is not Borno', () => {
    assert.equal(matchPilotDistrict('Borno State epidemic'), null)
    assert.notEqual(matchPilotDistrict('Bor, Jonglei'), null)
    assert.notEqual(matchPilotDistrict('Mandera county cholera'), null)
  })

  it('maps a country name (not a substring of it) to its centroid', () => {
    // 'Sudan' must never match 'South Sudan' — exact-match map.
    assert.deepEqual(COUNTRY_NAMES['south sudan'], 'SS')
    assert.equal(COUNTRY_NAMES['sudan'], undefined)
    const hit = geocodeOutbreakLocation('South Sudan: Meningitis outbreak - Jun 2026', null)
    assert.deepEqual(hit, {
      latitude: COUNTRY_CENTROIDS.SS.lat,
      longitude: COUNTRY_CENTROIDS.SS.lon,
      location_name: 'South Sudan',
      granularity: 'national',
    })
  })

  it('falls back on a country code, including 3-letter ISO3 spellings', () => {
    const hit = geocodeOutbreakLocation(null, 'SO')
    assert.equal(hit.granularity, 'national')
    assert.equal(hit.location_name, 'Somalia')
    assert.equal(hit.latitude, COUNTRY_CENTROIDS.SO.lat)
    // An out-of-codebook or 3-char code the table does not know: honest null.
    assert.equal(geocodeOutbreakLocation(null, 'BGD'), null)
  })

  it('a district name beats the record country code', () => {
    // A feed may label the record 'Ethiopia' while the glance text names
    // Mandera — the district is the evidence; the country is the address.
    const hit = geocodeOutbreakLocation('Mandera County surveillance', 'ET')
    assert.equal(hit.granularity, 'subnational')
    assert.equal(hit.location_name, 'Mandera')
  })

  it('returns null when neither the place nor the country matches', () => {
    assert.equal(geocodeOutbreakLocation(null, null), null)
    assert.equal(geocodeOutbreakLocation('Borno State', 'NG'), null)
    assert.equal(geocodeOutbreakLocation('', ''), null)
  })
})
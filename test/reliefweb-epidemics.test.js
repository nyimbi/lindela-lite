import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildApiUrl,
  extractCounts,
  extractDiseaseName,
  parseRss,
  recordsFromApiItems,
  reliefwebEpidemicsConnector,
} from '../src/connectors/reliefweb-epidemics.js'
import { COUNTRY_CENTROIDS } from '../public/shared/outbreak-geocode.js'

// Fixtures model what the spike (2026-10-07) actually observed on ReliefWeb:
// the v2 API shape and the keyless RSS item shape.

const RSS_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>ReliefWeb - Disasters</title>
<item>
  <title>Kenya: Cholera Outbreak - Turkana - Nov 2026</title>
  <link>https://reliefweb.int/disaster/ep-2026-000201-ken</link>
  <pubDate>Sun, 02 Nov 2026 00:00:00 +0000</pubDate>
  <category>Kenya</category>
  <category>Cholera</category>
</item>
<item>
  <title>Ethiopia: Measles Outbreak - Oct 2026, 1,200 suspected cases, 15 deaths</title>
  <link>https://reliefweb.int/disaster/ep-2026-000188-eth</link>
  <pubDate>Sat, 10 Oct 2026 00:00:00 +0000</pubDate>
  <category>Ethiopia</category>
  <category>Measles</category>
</item>
<item>
  <title>Bangladesh: Dengue Outbreak - Sep 2026</title>
  <link>https://reliefweb.int/disaster/ep-2026-000174-bgd</link>
  <pubDate>Thu, 01 Sep 2026 00:00:00 +0000</pubDate>
  <category>Bangladesh</category>
</item>
<item>
  <title>Niger: Floods - Sep 2026</title>
  <link>https://reliefweb.int/disaster/fl-2026-000181-ner</link>
  <pubDate>Thu, 01 Sep 2026 00:00:00 +0000</pubDate>
  <category>Niger</category>
</item>
</channel></rss>`

const API_FIXTURE = [
  {
    id: 555001,
    fields: {
      name: 'Kenya: Meningitis outbreak in Aweil - Aug 2026, 300 cases',
      country: [{ iso3: 'KEN', shortname: 'Kenya' }],
      primary_location: { name: 'Aweil', lat: 8.767, lon: 27.4 },
      status: 'current',
      date: { event: '2026-08-20T00:00:00.000Z', created: '2026-08-21T10:00:00.000Z' },
      url: 'https://reliefweb.int/disaster/ep-2026-000233-ken',
      description: null,
    },
  },
  {
    id: 555002,
    fields: {
      name: 'Somalia: Yellow fever outbreak - Jul 2026',
      country: [{ iso3: 'SOM', shortname: 'Somalia' }],
      location: [{ name: 'Somalia' }],
      status: 'current',
      date: { event: '2026-07-11T00:00:00.000Z' },
      url: 'https://reliefweb.int/disaster/ep-2026-000214-som',
      description: null,
    },
  },
  {
    // No location objects at all: country-centroid fallback, then unknown.
    id: 555003,
    fields: {
      name: 'Chad: Plague outbreak - Jun 2026',
      country: [{ iso3: 'TCD', shortname: 'Chad' }],
      status: 'closed',
      date: { event: '2026-06-01T00:00:00.000Z' },
      url: 'https://reliefweb.int/disaster/ep-2026-000199-tcd',
      description: null,
    },
  },
]

describe('reliefweb epidemics connector', () => {
  it('parses the keyless RSS with pilot filtering inside the process', () => {
    const items = parseRss(RSS_FIXTURE)
    // Bangladesh drops for its country, Niger for its type: two survivors.
    assert.equal(items.length, 2)
    assert.deepEqual(items.map((i) => i.country), ['KE', 'ET'])
    assert.ok(items.every((i) => i.glideId.startsWith('EP-')))
    // GLIDE suffix decodes the country even when the category is absent.
    const kenya = items[0]
    assert.equal(kenya.glideId, 'EP-2026-000201-KEN')
  })

  it('builds one disease_observations record per relevant item', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(RSS_FIXTURE, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
    let result
    try {
      result = await reliefwebEpidemicsConnector.ingest({ timeout_ms: 1000, retries: 1 })
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.deepEqual(result.errors, [])
    assert.equal(result.disease_observations.length, 2)

    const turkana = result.disease_observations.find((r) => r.disease === 'cholera')
    // Title carries the district name: subnational evidence, not a centroid.
    assert.equal(turkana.granularity, 'subnational')
    assert.equal(turkana.location_name, 'Turkana')
    assert.ok(Number.isFinite(turkana.latitude) && Number.isFinite(turkana.longitude))
    assert.equal(turkana.source, 'reliefweb_epidemics')
    assert.equal(turkana.country, 'KE')
    assert.equal(turkana.source_id, 'EP-2026-000201-KEN')
    assert.equal(turkana.observed_at, '2026-11-02T00:00:00.000Z')
    assert.equal(turkana.source_url, 'https://reliefweb.int/disaster/ep-2026-000201-ken')
    assert.ok(turkana.model_limit.includes('country centroid with national-aggregate label'))

    const measles = result.disease_observations.find((r) => r.disease === 'measles')
    // National centroid labelled national; counts parsed from the glance.
    assert.equal(measles.granularity, 'national')
    assert.equal(measles.location_name, 'Ethiopia')
    assert.equal(measles.latitude, COUNTRY_CENTROIDS.ET.lat)
    assert.equal(measles.cases, 1200)
    assert.equal(measles.deaths, 15)
  })

  it('falls back to RSS when the appname is not approved, and says so', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      // Route-based, not call-count-based: fetchWithRetry counts attempts as
      // `attempt <= retries`, so a one-count mock desynchronises the moment a
      // retry runs.
      if (String(url).includes('/v2/disasters')) {
        return new Response(JSON.stringify({ status: 403, error: { type: 'AccessDeniedHttpException', message: 'You are not using an approved appname.' } }), { status: 403, headers: { 'content-type': 'application/json' } })
      }
      return new Response(RSS_FIXTURE, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
    }
    try {
      const result = await reliefwebEpidemicsConnector.ingest({ reliefweb_appname: 'unapproved-name', timeout_ms: 1000, retries: 1 })
      assert.equal(result.disease_observations.length, 2, 'RSS fallback still yields the pilot records')
      assert.equal(result.errors.length, 1)
      assert.match(result.errors[0], /not approved by ReliefWeb/)
      assert.match(result.errors[0], /keyless RSS feed/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('API records: source geometry wins, centroid fallback, unknown otherwise', () => {
    const records = recordsFromApiItems(API_FIXTURE)
    assert.equal(records.length, 3)

    const aweil = records[0]
    // primary_location lat/lon: subnational, exactly the published point.
    assert.equal(aweil.granularity, 'subnational')
    assert.equal(aweil.latitude, 8.767)
    assert.equal(aweil.longitude, 27.4)
    assert.equal(aweil.disease, 'meningitis')
    assert.equal(aweil.cases, 300)
    assert.equal(aweil.source_id, '555001')

    const somalia = records[1]
    // No geometry objects: national centroid via the country code.
    assert.equal(somalia.granularity, 'national')
    assert.equal(somalia.latitude, COUNTRY_CENTROIDS.SO.lat)
    assert.equal(somalia.location_name, 'Somalia')

    const chad = records[2]
    // Non-pilot country: country label kept as given, nothing placed.
    assert.equal(chad.granularity, 'unknown')
    assert.equal(chad.latitude, null)
    assert.equal(chad.longitude, null)
    assert.equal(chad.disease, 'plague')
  })

  it('the URL contract is the documented v2 request', () => {
    const url = buildApiUrl('some-app')
    assert.ok(url.startsWith('https://api.reliefweb.int/v2/disasters?appname=some-app'))
    assert.ok(url.includes('filter[type.name]=Epidemic'))
    assert.ok(url.includes('filter[country.iso3]=KEN,UGA,SSD,ETH,SOM'))
    assert.ok(url.includes('limit=50'))
  })

  it('disease vocabulary and count extraction are keyword-level', () => {
    assert.equal(extractDiseaseName('Cholera Outbreak - Turkana'), 'cholera')
    assert.equal(extractDiseaseName('Yellow Fever Outbreak'), 'yellow fever')
    assert.equal(extractDiseaseName('Dengue Outbreak - Sep 2026'), 'other')
    assert.deepEqual(extractCounts('3,500 suspected cases and 47 deaths'), { cases: 3500, deaths: 47 })
    assert.deepEqual(extractCounts('Funding appeal for prevention'), { cases: null, deaths: null })
    assert.deepEqual(extractCounts('2 cases'), { cases: 2, deaths: null })
  })
})
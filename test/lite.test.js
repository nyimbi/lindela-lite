import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { computeClimateConflictRisk, computeDataQuality, computeFloodRisk, computeServiceImpacts } from '../src/analytics.js'
import { computeEnsembleStats } from '../src/analytics/ensemble.js'
import { computePopulationAtRisk, computeFacilitiesAtRisk } from '../src/analytics/impact.js'
import { quantileMap } from '../src/analytics/downscaling.js'
import { getConnector, runIngestion } from '../src/ingestion.js'
import { createServer } from '../src/server.js'
import { stacCatalog, stacItem, stacCollection, ogcFeatureCollection } from '../src/stac.js'
import { renderCapXml } from '../src/cap.js'
import { spec as openMeteoSpec } from '../src/connectors/open-meteo.js'
import { defineConnector, validateConnector } from '../src/connectors/spec.js'
import { emit, dispatchPending } from '../src/outbox.js'
import { normalizeWebhookSubscription } from '../src/webhooks.js'
import { runScenario, encodeScenarioUrl, decodeScenarioUrl } from '../src/scenarios.js'
import { Pg0Manager } from '../src/pg0.js'
import { createStoreFromEnv } from '../src/storage.js'
import { JsonStore, mergeById } from '../src/store.js'
import { toCsv, toGeoJson } from '../src/utils.js'
import { t, isRtl, plainLanguage } from '../src/i18n.js'
import { normalizeWorkflowInstance, transitionWorkflow, workflowMetrics } from '../src/workflows.js'
import { hasRole, scopeToPartnerOrg } from '../src/auth.js'
import { computeQuarterlyKpi } from '../src/kpi.js'
import { equityByDistrict, detectAccuracyBreaches, createEquityAuditWorkflows } from '../src/equity.js'
import { normalizeCommunityFeedback } from '../src/community.js'
import { computeRoadAccess, summarizeRoadAccess } from '../src/road-access.js'
import { buildRoadGraph, shortestPath, planDelivery } from '../src/routing.js'
import { readNamespacedTag } from '../src/connectors/spec.js'
import { lonLatToTile, tileBounds, loadTile, clearTileCache } from '../src/terrain.js'
import { depthAtPoint, depthGrid, depthProfile, terrainContext } from '../src/flood-depth.js'
import { normalizeServiceAsset } from '../src/connectors/uploads.js'

const execFileAsync = promisify(execFile)

describe('Lindela Lite STAC', () => {
  it('returns catalog with non-empty links', () => {
    const catalog = stacCatalog('http://localhost:4177')
    assert.equal(catalog.type, 'Catalog')
    assert.equal(catalog.stac_version, '1.0.0')
    assert.ok(Array.isArray(catalog.links))
    assert.ok(catalog.links.length > 0)
  })

  it('GET /stac/catalog.json returns valid STAC Catalog', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-stac-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/stac/catalog.json`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.type, 'Catalog')
      assert.equal(json.stac_version, '1.0.0')
      assert.ok(json.links.length > 0)
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite CAP', () => {
  it('renders valid CAP 1.2 XML that names the real hazard', () => {
    const alert = {
      id: 'alert_123',
      event_type: 'flood',
      severity: 'high',
      headline: 'Flash flood warning',
      description: 'Heavy rainfall expected',
      latitude: 3.1,
      longitude: 35.6,
      lead_time_days: 1,
    }
    const xml = renderCapXml(alert)
    assert.ok(xml.startsWith('<?xml'))
    assert.ok(xml.includes('<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">'))
    // Asserts the event names the hazard. It used to assert <event>flood</event>
    // verbatim, which passed only because <event> echoed event_type.
    assert.match(xml, /<event>Flood<\/event>/)
  })

  it('carries the alert, not placeholder text', () => {
    // The generator read headline, description, event_type, latitude, longitude,
    // radius_km and lead_time_days. An alert event carries none of them, so every
    // alert published as "Hazard Alert / A hazard alert has been issued".
    const alert = {
      id: 'alert_real',
      rule_name: 'Conflict Proximity Alert',
      metric: 'conflict_events_count_7d',
      value: 4,
      threshold: 3,
      operator: '>=',
      message: 'Conflict Proximity Alert: value 4 in Bor',
      severity: 'high',
      status: 'open',
      scope: { district: 'Bor' },
    }
    const xml = renderCapXml(alert)
    assert.ok(xml.includes('Conflict Proximity Alert: value 4 in Bor'), 'headline must be the real message')
    assert.ok(!xml.includes('A hazard alert has been issued'), 'no placeholder description')
    assert.ok(xml.includes('conflict_events_count_7d 4 &gt;= 3'), 'the trigger must be stated')
    assert.ok(xml.includes('not an official forecast'), 'provenance must be stated')
  })

  it('never places an alert at Null Island', () => {
    // It emitted `<circle>0,0 50</circle>` for every alert, because alert events
    // carry no latitude or longitude. A 50 km circle at 0,0 is in the Gulf of
    // Guinea; an external alerting system would place every alert in this system
    // in open water.
    const xml = renderCapXml({
      id: 'alert_noname',
      message: 'Unlocated alert',
      severity: 'medium',
      status: 'open',
    })
    assert.ok(!/<circle>0(\.0+)?,0(\.0+)?\s/.test(xml),
      'no circle may be emitted at 0,0')
    assert.ok(!xml.includes('<circle>0,0'), 'no circle may be emitted at 0,0')
    assert.match(xml, /extent not established/i,
      'an alert with no location must say so rather than assert one')
    assert.ok(!xml.includes('<circle>'), 'no circle at all when nothing is known')
  })

  it('uses the district centroid when the alert names a district', () => {
    const xml = renderCapXml({
      id: 'alert_bor',
      message: 'Flooding reported',
      severity: 'critical',
      status: 'open',
      scope: { district: 'Bor' },
    })
    assert.match(xml, /<circle>6\.207,31\.548 150<\/circle>/,
      'the circle must be the district centroid and its radius')
    assert.match(xml, /Bor district extent/)
  })

  it('derives urgency from severity rather than a field that does not exist', () => {
    // It read lead_time_days, which no alert event carries, so every alert
    // published as Immediate including a low-severity observation.
    assert.match(renderCapXml({ severity: 'critical', message: 'x' }), /<urgency>Immediate<\/urgency>/)
    assert.match(renderCapXml({ severity: 'low', message: 'x' }), /<urgency>Future<\/urgency>/)
  })

  it('publishes a resolved alert as a Cancel so downstream systems retire it', () => {
    const xml = renderCapXml({ id: 'a', message: 'Situation resolved', status: 'resolved', severity: 'high' })
    assert.match(xml, /<msgType>Cancel<\/msgType>/)
    assert.match(xml, /<status>Actual<\/status>/, 'the message itself remains true')
  })

  it('GET /api/v1/alert-events/:id.cap returns XML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-cap-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      await store.merge({
        alert_events: [{
          id: 'test_alert_1',
          event_type: 'flood',
          severity: 'high',
          headline: 'Test alert',
          latitude: 3.1,
          longitude: 35.6,
        }],
      })

      const res = await fetch(`${baseUrl}/api/v1/alert-events/test_alert_1.cap`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8')
      const xml = await res.text()
      assert.ok(xml.startsWith('<?xml'))
      assert.ok(xml.includes('<alert xmlns'))
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite STAC and OGC', () => {
  it('does not place a location-less record at Null Island', () => {
    // `Number(null)` is 0, so the isFinite guard passed for every record that
    // explicitly had no location. 233 of 280 hazard events carry
    // `latitude: null` and were each published with geometry Point [0, 0] and
    // bbox [0,0,0,0] — a FIRMS forest-fire notification with no coordinates
    // placed in the Gulf of Guinea for every STAC client to load.
    const located = stacItem({ id: 'hz-1', latitude: 3.12, longitude: 35.6 }, 'hazard-events', 'http://x')
    assert.deepEqual(located.geometry.coordinates, [35.6, 3.12])
    assert.equal(located.properties.location_basis, 'point')

    const unlocated = stacItem({ id: 'hz-2', latitude: null, longitude: null }, 'hazard-events', 'http://x')
    assert.equal(unlocated.geometry, null, 'no geometry rather than an invented point')
    assert.equal(unlocated.bbox, null, 'no degenerate zero-area bbox')
    assert.equal(unlocated.properties.location_basis, 'none')
    assert.match(unlocated.properties.location_status, /no coordinates/i)
    assert.ok(!JSON.stringify(unlocated).includes('[0,0]'), 'never emit a null-island coordinate')
  })

  it('treats blank and non-numeric coordinates as absent', () => {
    for (const value of ['', '   ', 'unknown', null, undefined, NaN]) {
      const item = stacItem({ id: 'x', latitude: value, longitude: value }, 'hazard-events', 'http://x')
      assert.equal(item.geometry, null, `latitude ${JSON.stringify(value)} must not become a coordinate`)
    }
  })

  it('omits the spatial extent rather than fabricating a box', () => {
    // computeBbox returned [0,0,1,1] for a collection with no coordinates — an
    // extent in the Gulf of Guinea that no record occupies.
    const empty = stacCollection('hazard-events', [], 'http://x')
    assert.ok(!empty.extent || !empty.extent.spatial, 'no spatial extent for an empty collection')
    const allNull = stacCollection('hazard-events', [{ id: 'a', latitude: null, longitude: null }], 'http://x')
    assert.ok(!allNull.extent || !allNull.extent.spatial, 'no spatial extent when nothing has coordinates')

    const real = stacCollection('hazard-events', [{ id: 'a', latitude: 1, longitude: 2 }], 'http://x')
    assert.deepEqual(real.extent.spatial.bbox, [[2, 1, 2, 1]])
  })

  it('excludes location-less records from an OGC feature collection', () => {
    const fc = ogcFeatureCollection([
      { id: 'a', latitude: 3.12, longitude: 35.6 },
      { id: 'b', latitude: null, longitude: null },
      { id: 'c', latitude: '', longitude: '' },
    ])
    assert.equal(fc.numberMatched, 1)
    assert.equal(fc.numberReturned, 1)
    // OGC features carry the identifier inside properties; STAC items carry it
    // at the top level.
    assert.deepEqual(fc.features.map((f) => f.properties.id), ['a'])
    assert.ok(!JSON.stringify(fc).includes('[0,0]'))
  })
})

describe('Lindela Lite connectors SDK', () => {
  it('exports spec from open-meteo connector', () => {
    assert.equal(openMeteoSpec.id, 'open_meteo')
    assert.ok(openMeteoSpec.description)
    assert.ok(openMeteoSpec.schema)
    assert.ok(openMeteoSpec.defaults)
    assert.equal(typeof openMeteoSpec.ingest, 'function')
  })

  it('validates connector specs', () => {
    const errors = validateConnector(openMeteoSpec)
    assert.equal(errors.length, 0)
  })

  it('rejects invalid connector specs', () => {
    const errors = validateConnector({ id: 'test' })
    assert.ok(errors.length > 0)
  })

  it('defines new connectors and freezes them', () => {
    const customSpec = defineConnector({
      id: 'test_connector',
      description: 'Test connector',
      schema: {},
      defaults: {},
      ingest: async () => ({ test_data: [] }),
    })
    assert.equal(customSpec.id, 'test_connector')
    assert.throws(() => {
      customSpec.id = 'changed'
    }, /Cannot assign to read only property/)
  })
})

describe('Lindela Lite report content and scope', () => {
  it('refuses to mark an ungenerated report approved or distributed', async () => {
    // POST and PATCH set `status` through normalizeReport, bypassing
    // approveReport. A client could declare a report `distributed` with no
    // sections: an empty SITREP that rendered as a title and four metadata lines
    // and looked finished to every consumer.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-empty-report-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          report_type: 'situation_report',
          title: 'Empty distributed SITREP',
          status: 'distributed',
          sections: [],
        }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.match(body.error, /must be generated before approval or distribution/)
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('never reports zero figures for a report with no content', () => {
    // With no sections the metric lookups fall back to 0, so every ungenerated
    // report announced "0 incidents, 0 open alerts" over SMS — a positive claim
    // that the district was quiet, sent to the people meant to act on it.
    const summary = formatReportSmsSummary({
      id: 'report_empty',
      title: 'Turkana Flood SITREP W37',
      sections: [],
    })
    assert.match(summary, /not generated/i)
    assert.ok(!/0 incidents/.test(summary), 'must not assert zero incidents')
    assert.ok(!/0 open alerts/.test(summary), 'must not assert zero alerts')
  })

  it('renders a visible warning when a report has no sections', () => {
    const md = renderReportMarkdown({ id: 'r', title: 'Empty', status: 'ready', sections: [] })
    assert.match(md, /no generated sections/i)
    assert.match(md, /must not be used as a situation picture/i)
  })

  it('scopes a district report to that district, not the whole store', () => {
    // `district` is not a key filterRecords understands, so a district-scoped
    // report fell through to no filtering: the "Turkana Flood SITREP" reported
    // all 280 hazard events in the store, from Indonesia, Brazil and Australia.
    const data = {
      report_templates: [],
      source_runs: [], climate_observations: [], risk_scores: [], data_quality: [],
      service_assets: [], impact_assessments: [], interventions: [], intervention_tasks: [],
      field_reports: [], response_resources: [], rapidpro_dispatches: [],
      rapidpro_inbound_messages: [], alert_events: [],
      incidents: [
        { id: 'inc-turkana', latitude: 3.12, longitude: 35.6 },
        { id: 'inc-bor', latitude: 6.21, longitude: 31.55 },
      ],
      hazard_events: [
        { id: 'hz-turkana', latitude: 3.4, longitude: 35.9 },
        { id: 'hz-brazil', latitude: -15.8, longitude: -47.9 },
        { id: 'hz-unlocatable', event_type: 'flood' },
      ],
      conflict_events: [],
    }
    const context = resolveReportContext(data, { district: 'Turkana' })
    assert.deepEqual(context.incidents.map((r) => r.id), ['inc-turkana'])
    assert.deepEqual(context.events.map((r) => r.id), ['hz-turkana'])
    // The unlocatable record is excluded from district counts, not silently counted.
    assert.ok(!context.events.some((r) => r.id === 'hz-unlocatable'))
    assert.ok(context.district_attribution.unlocatable >= 1)
  })

  it('filters list endpoints by district instead of ignoring the parameter', async () => {
    // filterRecords ignores parameters it does not understand, so `district` and
    // `region` were indistinguishable from no filter: `?district=Bor` returned
    // every incident in the collection, handing cross-district data to a caller
    // that had asked to be scoped to one district.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-district-filter-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      await store.merge({
        incidents: [
          { id: 'inc-turkana', latitude: 3.12, longitude: 35.6, severity: 'high', status: 'open' },
          { id: 'inc-bor', latitude: 6.21, longitude: 31.55, severity: 'critical', status: 'open' },
          { id: 'inc-brazil', latitude: -15.8, longitude: -47.9, severity: 'critical', status: 'open' },
        ],
      })
      const count = async (qs) => (await (await fetch(`${baseUrl}/api/v1/incidents${qs}`)).json()).data.length
      assert.equal(await count(''), 3, 'no filter returns everything')
      assert.equal(await count('?district=Bor'), 1)
      assert.equal(await count('?region=Turkana'), 1, 'region is a district alias')
      // A misspelt district returns nothing rather than everything.
      assert.equal(await count('?district=Nonexistentville'), 0)
      // Filters compose.
      assert.equal(await count('?district=Bor&severity=critical'), 1)
      assert.equal(await count('?district=Bor&severity=high'), 0)
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('attributes records that carry no location through their parent', () => {
    // Interventions carry no coordinates and no district field. Filtered
    // directly they matched nothing, so every district reported no activity
    // while interventions were attached to it — which reads as a finding rather
    // than an absence of data. They are attributed through their incident, and
    // tasks through the intervention, the way districtOverview does.
    const data = {
      incidents: [
        { id: 'inc-bor', latitude: 6.21, longitude: 31.55 },
        { id: 'inc-aweil', latitude: 8.77, longitude: 27.41 },
      ],
      interventions: [
        { id: 'int-bor-1', incident_id: 'inc-bor' },
        { id: 'int-aweil-1', incident_id: 'inc-aweil' },
      ],
      intervention_tasks: [
        { id: 'task-bor-1', intervention_id: 'int-bor-1' },
        { id: 'task-aweil-1', intervention_id: 'int-aweil-1' },
      ],
      alert_events: [
        { id: 'al-bor', scope: { district: 'Bor' } },
        { id: 'al-aweil', scope: { district: 'Aweil' } },
      ],
      rapidpro_dispatches: [
        { id: 'disp-bor', alert_event_id: 'al-bor' },
        { id: 'disp-aweil', alert_event_id: 'al-aweil' },
      ],
    }
    const q = new URLSearchParams('district=Bor')
    const scoped = (records, collection) => filterRecords(records, q, { data, collection }).map((r) => r.id)
    assert.deepEqual(scoped(data.interventions, 'interventions'), ['int-bor-1'])
    // Two levels deep: the task is attributed through the intervention.
    assert.deepEqual(scoped(data.intervention_tasks, 'intervention_tasks'), ['task-bor-1'])
    assert.deepEqual(scoped(data.rapidpro_dispatches, 'rapidpro_dispatches'), ['disp-bor'])
  })

  it('agrees with report scope on what is in a district', () => {
    // The API filter and the report scope must not disagree, or a partner
    // reading the report would see a different district than the API returns.
    const data = {
      report_templates: [], source_runs: [], climate_observations: [], risk_scores: [],
      service_assets: [], impact_assessments: [], interventions: [], intervention_tasks: [],
      field_reports: [], response_resources: [], rapidpro_dispatches: [],
      rapidpro_inbound_messages: [], alert_events: [], hazard_events: [], conflict_events: [],
      data_quality: [],
      incidents: [
        { id: 'inc-turkana', latitude: 3.12, longitude: 35.6 },
        { id: 'inc-bor', latitude: 6.21, longitude: 31.55 },
        { id: 'inc-brazil', latitude: -15.8, longitude: -47.9 },
        { id: 'inc-unlocatable' },
      ],
    }
    const context = resolveReportContext(data, { district: 'Turkana' })
    const query = new URLSearchParams('district=Turkana')
    const viaFilter = filterRecords(data.incidents, query).map((r) => r.id)
    assert.deepEqual(context.incidents.map((r) => r.id).sort(), viaFilter.sort())
    assert.ok(!viaFilter.includes('inc-unlocatable'), 'an unplaceable record is not in any district')
  })

  it('warns when scope cannot be assessed for a district', () => {
    const data = {
      report_templates: [], source_runs: [], climate_observations: [], risk_scores: [],
      service_assets: [], impact_assessments: [], interventions: [], intervention_tasks: [],
      field_reports: [], response_resources: [], rapidpro_dispatches: [],
      rapidpro_inbound_messages: [], alert_events: [], incidents: [], conflict_events: [],
      hazard_events: [{ id: 'hz-unlocatable', event_type: 'flood' }],
      data_quality: [{ id: 'dq-1', freshness: 'stale', confidence: 0.9 }],
    }
    const warnings = buildReportWarnings(resolveReportContext(data, { district: 'Turkana' }))
    assert.ok(warnings.some((w) => /could not be attributed to this district/i.test(w)))
    assert.ok(warnings.some((w) => /source freshness and confidence could not be assessed/i.test(w)))
  })
})

describe('Lindela Lite invented-uncertainty guard', () => {
  it('does not synthesize ensemble percentiles from a point value', async () => {
    // open-meteo read a deterministic forecast and manufactured p10/p50/p90 with
    // a spread of `0.25 + (1 - probability/100) * 0.75`, publishing them under the
    // field names a real probabilistic forecast uses. At a reported probability of
    // 10% that made p90 about 1.9x the observed precipitation, and the risk scorer
    // preferred p90 over the point value.
    const { ENSEMBLE_MODEL_LIMIT } = await import('../src/connectors/open-meteo.js')
    assert.match(ENSEMBLE_MODEL_LIMIT, /Deterministic point forecast only/)
    const source = await fs.readFile(new URL('../src/connectors/open-meteo.js', import.meta.url), 'utf8')
    assert.ok(!/function synthesizeEnsemble/.test(source), 'the synthesizer must be gone, not just unused')
    assert.ok(!/ensemble_p90:\s*Number\(p90/.test(source), 'no percentile may be computed from a spread')
  })

  it('does not publish zero percentiles for a source that has none', async () => {
    // glofas emitted ensemble_p10/p50/p90 of 0, which reads as a certain
    // forecast of zero rather than the absence of one.
    const source = await fs.readFile(new URL('../src/connectors/glofas.js', import.meta.url), 'utf8')
    assert.ok(!/ensemble_p90:\s*0\b/.test(source), 'a missing ensemble must be null, not zero')
    assert.match(source, /ensemble_p10:\s*null/)
  })

  it('only prefers a percentile that came from a real ensemble', () => {
    // A synthesized percentile must not raise the score or claim ensemble
    // coverage, or the absence of a probabilistic forecast presents as
    // quantified uncertainty.
    const base = {
      regions: [{ name: 'Turkana', lat: 3.1167, lon: 35.6 }],
      climate_observations: [{
        id: 'obs-1', region_name: 'Turkana', latitude: 3.12, longitude: 35.6,
        precipitation_mm: 10, precipitation_probability_pct: 10,
        ensemble_p90: 19.25, ensemble_p10: 0, ensemble_p50: 10,
      }],
      hazard_events: [], conflict_events: [], service_assets: [], impact_assessments: [],
      incidents: [], interventions: [], intervention_tasks: [], field_reports: [],
      response_resources: [], data_quality: [],
    }
    const withFake = computeFloodRisk(base)[0]
    assert.ok(!withFake.drivers.ensemble_used, 'a synthesized percentile is not ensemble coverage')
    assert.equal(withFake.drivers.precipitation_mm, 10, 'the real point value is scored, not the inflated p90')

    const withReal = computeFloodRisk({
      ...base,
      climate_observations: [{ ...base.climate_observations[0], ensemble_source: 'open_meteo_ensemble' }],
    })[0]
    assert.equal(withReal.drivers.ensemble_used, true, 'a genuine ensemble is still used')
    assert.ok(Math.abs(withReal.drivers.precipitation_mm - 19.25) < 0.1, `expected ~19.25, got ${withReal.drivers.precipitation_mm}`)
  })
})

describe('Lindela Lite missing-input handling', () => {
  const base = {
    regions: [{ name: 'Turkana', lat: 3.1167, lon: 35.6 }],
    hazard_events: [], conflict_events: [], service_assets: [], impact_assessments: [],
    incidents: [], interventions: [], intervention_tasks: [], field_reports: [],
    response_resources: [], data_quality: [],
  }
  const observation = (precipitation, probability) => ([{
    id: 'obs-1', region_name: 'Turkana', latitude: 3.12, longitude: 35.6,
    precipitation_mm: precipitation, precipitation_probability_pct: probability,
  }])

  it('does not read a missing precipitation record as a measured dry spell', () => {
    // `Number(x || 0)` cannot tell "no rain" from "no data". An absent
    // observation became 0 mm, which is a confident reading that lowers flood
    // risk — the worst direction for an absent input.
    const missing = computeFloodRisk({ ...base, climate_observations: observation(null, null) })[0]
    assert.equal(missing.drivers.missing_precipitation_records, 1)
    assert.equal(missing.drivers.missing_probability_records, 1)
    assert.equal(missing.drivers.climate_observations_in_scope, 1)
    assert.match(missing.limits, /Incomplete input/)
    assert.match(missing.limits, /may reflect missing data rather than low risk/)
  })

  it('lowers confidence rather than the score when an input is absent', () => {
    // The score cannot be raised without inventing a value, so the honest move is
    // to make how sure the score is depend on the readings that were actually used.
    const present = computeFloodRisk({ ...base, climate_observations: observation(40, 60) })[0]
    const absent = computeFloodRisk({ ...base, climate_observations: observation(null, null) })[0]
    assert.equal(present.drivers.precipitation_mm, 40)
    assert.ok(absent.confidence < present.confidence,
      `confidence must fall when readings are missing: ${absent.confidence} vs ${present.confidence}`)
    assert.equal(absent.confidence, 0)
  })

  it('reports a complete input as complete', () => {
    const complete = computeFloodRisk({ ...base, climate_observations: observation(40, 60) })[0]
    assert.equal(complete.drivers.missing_precipitation_records, 0)
    assert.match(complete.limits, /All in-scope climate observations carried a precipitation reading/)
    assert.ok(!/Incomplete input/.test(complete.limits))
  })

  it('keeps absent readings absent through the connector', async () => {
    const source = await fs.readFile(new URL('../src/connectors/open-meteo.js', import.meta.url), 'utf8')
    // A day the API did not report — `?.[i]` past the end of a shorter array —
    // must not become a confident zero either.
    assert.ok(!/precipitation_mm: Number\(/.test(source), 'no raw Number() coercion on precipitation')
    assert.ok(!/Number\(daily\.precipitation_sum\?\.\[i\] \|\| 0\)/.test(source), 'an unreported day is not 0 mm')
    assert.match(source, /function readMeasurement/)
  })
})

describe('Lindela Lite scenario workbench', () => {
  const testData = {
    climate_observations: [
      { id: 'c1', source: 'open_meteo', type: 'precipitation_forecast', latitude: 3.1, longitude: 35.6, country: 'KE', region_name: 'Turkana', precipitation_mm: 42, precipitation_probability_pct: 80 },
    ],
    hazard_events: [
      { id: 'h1', source: 'gdacs', event_type: 'flood', severity: 'high', latitude: 3.2, longitude: 35.7, country: 'KE' },
    ],
    conflict_events: [
      { id: 'e1', source: 'conflict_csv', event_type: 'communal_tension', latitude: 3.15, longitude: 35.62, country: 'KE', fatalities: 1 },
    ],
    service_assets: [
      { id: 'a1', name: 'Clinic A', service_type: 'health', latitude: 3.13, longitude: 35.63, country: 'KE' },
    ],
  }

  it('runs scenarios with precipitation multiplier', () => {
    const perturbation = { precipitation_multiplier: 2 }
    const result = runScenario(testData, perturbation)
    assert.ok(result.scenario_id)
    assert.ok(Array.isArray(result.risk_scores))
    assert.ok(Array.isArray(result.impact_assessments))
    assert.ok(result.diff)
    assert.ok(Number.isFinite(result.diff.flood_risk_delta_mean))
  })

  it('encodes and decodes scenario URLs', () => {
    const perturbation = { precipitation_multiplier: 1.5, offline_asset_ids: ['a1'] }
    const token = encodeScenarioUrl(perturbation)
    assert.ok(token)
    assert.ok(typeof token === 'string')
    const decoded = decodeScenarioUrl(token)
    assert.equal(decoded.precipitation_multiplier, 1.5)
    assert.deepEqual(decoded.offline_asset_ids, ['a1'])
  })

  it('POST /api/v1/scenarios returns scenario result with token', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-scenario-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      climate_observations: testData.climate_observations,
      hazard_events: testData.hazard_events,
      conflict_events: testData.conflict_events,
      service_assets: testData.service_assets,
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/scenarios`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ precipitation_multiplier: 2 }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.equal(json.success, true)
      assert.ok(json.risk_scores)
      assert.ok(json.token)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/scenarios/:token decodes and reruns scenario', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-scenario-get-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      climate_observations: testData.climate_observations,
      hazard_events: testData.hazard_events,
      conflict_events: testData.conflict_events,
      service_assets: testData.service_assets,
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const token = encodeScenarioUrl({ precipitation_multiplier: 1.5 })
      const res = await fetch(`${baseUrl}/api/v1/scenarios/${token}`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.success, true)
      assert.ok(json.risk_scores)
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite webhook event bus', () => {
  it('emits events to outbox', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-outbox-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const payload = { id: 'test_1', event_type: 'flood' }
    await emit(store, 'alert.created', payload)
    const data = await store.read()
    assert.ok(data.events_outbox.length > 0)
    assert.equal(data.events_outbox[0].event, 'alert.created')
    assert.equal(data.events_outbox[0].status, 'pending')
  })

  it('dispatches pending events to webhooks with mock fetch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-dispatch-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const payload = { id: 'test_2', event_type: 'flood' }
    await emit(store, 'alert.created', payload)

    const data = await store.read()
    assert.ok(data.events_outbox.length > 0)
    assert.equal(data.events_outbox[0].status, 'pending')

    const webhooks = [{
      id: 'wh1',
      url: 'http://webhook.test/events',
      events: ['alert.*'],
      status: 'active',
      headers: {},
      secret: null,
    }]

    // Mock dispatchPending to avoid actual network calls
    const dataAfter = await store.read()
    const pending = dataAfter.events_outbox.filter((e) => e.status === 'pending')
    assert.ok(pending.length > 0)
  })

  it('normalizes webhook subscriptions', () => {
    const input = {
      url: 'https://webhook.example.com/events',
      events: ['alert.*', 'incident.*'],
      headers: { 'x-token': 'secret' },
      secret: 'webhook-secret',
    }
    const sub = normalizeWebhookSubscription(input)
    assert.ok(sub.id)
    assert.equal(sub.url, 'https://webhook.example.com/events')
    assert.equal(sub.events.length, 2)
    assert.equal(sub.status, 'active')
  })
})

describe('Lindela Lite open-source boundary', () => {
  it('rejects gdelt ingestion', () => {
    assert.throws(() => getConnector('gdelt'), /excluded/)
  })

  it('rejects gdelt in ingestion requests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await assert.rejects(() => runIngestion(store, { sources: ['gdelt'] }), /excluded/)
  })

  it('honors ingestion retry settings when a connector throws', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-retry-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const result = await runIngestion(store, {
      sources: ['service_assets'],
      retries: 1,
      service_assets_geojson: '{',
    })
    assert.equal(result.source_runs[0].status, 'failed')
    assert.equal(result.source_runs[0].diagnostics.attempts, 2)
  })
})

describe('Lindela Lite analytics', () => {
  const data = {
    climate_observations: [
      { id: 'c1', source: 'open_meteo', type: 'precipitation_forecast', latitude: 3.1, longitude: 35.6, country: 'KE', region_name: 'Turkana', precipitation_mm: 42, precipitation_probability_pct: 80 },
    ],
    hazard_events: [
      { id: 'h1', source: 'gdacs', event_type: 'flood', severity: 'high', latitude: 3.2, longitude: 35.7, country: 'KE' },
    ],
    conflict_events: [
      { id: 'e1', source: 'conflict_csv', event_type: 'communal_tension', latitude: 3.15, longitude: 35.62, country: 'KE', fatalities: 1 },
    ],
    service_assets: [
      { id: 'a1', name: 'Clinic A', service_type: 'health', latitude: 3.13, longitude: 35.63, country: 'KE' },
    ],
  }

  it('scores risk only within the operational area, not wherever alerts are global', async () => {
    // Every record with coordinates used to become a region, so a global alert
    // feed defined the analytical surface: after a live GDACS pull the console
    // computed risk for 87 regions across 25 countries, 82 of them outside the
    // area the platform operates in. The risk surface then said almost nothing
    // about the five pilot districts.
    const { computeFloodRisk } = await import('../src/analytics.js')
    const world = {
      climate_observations: [],
      hazard_events: [
        { id: 'turkana', event_type: 'flood', severity: 'high', country: 'KE', region_name: 'Turkana', latitude: 3.11, longitude: 35.60 },
        { id: 'aweil', event_type: 'flood', severity: 'high', country: 'SS', region_name: 'Aweil', latitude: 8.77, longitude: 27.40 },
        { id: 'france', event_type: 'flood', severity: 'low', country: 'France', latitude: 46.6, longitude: 2.4 },
        { id: 'brazil', event_type: 'flood', severity: 'low', country: 'Brazil', latitude: -15.8, longitude: -47.9 },
        { id: 'japan', event_type: 'flood', severity: 'low', country: 'JPN', latitude: 35.6, longitude: 139.7 },
      ],
      conflict_events: [],
      service_assets: [],
    }
    const names = computeFloodRisk(world).map((r) => r.region_name)
    assert.ok(names.includes('Turkana'), 'pilot districts must be scored')
    assert.ok(names.includes('Aweil'), 'pilot districts must be scored')
    for (const foreign of ['France', 'Brazil', 'Japan']) {
      assert.ok(!names.includes(foreign), `${foreign} is outside the operational area and must not be scored`)
    }
  })

  it('keeps scoring everything when the scope is explicitly widened', async () => {
    // The bound must be adjustable, not a permanent narrowing: a deployment
    // covering other countries needs to widen it rather than lose the surface.
    const { computeFloodRisk } = await import('../src/analytics.js')
    const data = {
      climate_observations: [],
      hazard_events: [{ id: 'fr', event_type: 'flood', severity: 'low', country: 'France', latitude: 46.6, longitude: 2.4 }],
      conflict_events: [],
      service_assets: [],
    }
    const widened = computeFloodRisk(data, { scope: { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180, marginDeg: 0 } })
    assert.equal(widened.length, 1, 'an explicit global scope must score worldwide')
  })

  it('computes flood and climate-conflict risk scores from real records', () => {
    const flood = computeFloodRisk(data)
    const conflict = computeClimateConflictRisk(data)
    assert.equal(flood.length, 1)
    assert.equal(conflict.length, 1)
    assert.ok(flood[0].score > 0)
    assert.ok(conflict[0].score > 0)
    assert.ok(flood[0].confidence > 0)
    assert.ok(conflict[0].confidence > 0)
  })

  it('computes service delivery impacts', () => {
    const risks = [...computeFloodRisk(data), ...computeClimateConflictRisk(data)]
    const impacts = computeServiceImpacts(data, risks)
    assert.equal(impacts.length, 1)
    assert.equal(impacts[0].asset_name, 'Clinic A')
    assert.ok(impacts[0].impact_score > 0)
    assert.ok(impacts[0].confidence > 0)
  })

  it('computes source-level data quality', () => {
    const quality = computeDataQuality({
      ...data,
      source_runs: [{ id: 'r1', source: 'gdacs', status: 'success', completed_at: new Date().toISOString(), errors: [] }],
    })
    assert.ok(quality.some((item) => item.source === 'gdacs'))
    assert.ok(quality.every((item) => Number.isFinite(item.confidence)))
  })

  it('labels risk bands as a sensitivity range, not calibrated uncertainty', () => {
    // The bands are named score_p10/p50/p90, which reads as quantiles of a
    // predictive distribution. They are a fixed function of input coverage, so
    // a well-populated region returns a zero-width band that looks like
    // certainty. The truthful names and the explicit flag prevent that
    // misreading; the aliases stay for existing consumers.
    const flood = computeFloodRisk(data)
    assert.equal(flood.length, 1)
    const risk = flood[0]
    for (const field of ['sensitivity_low', 'sensitivity_mid', 'sensitivity_high', 'sensitivity_width']) {
      assert.ok(Number.isFinite(risk[field]), `missing ${field}`)
    }
    assert.ok(risk.sensitivity_low <= risk.sensitivity_mid)
    assert.ok(risk.sensitivity_mid <= risk.sensitivity_high)
    assert.ok(risk.sensitivity_width >= 0)
    assert.equal(risk.calibrated_uncertainty, false)
    assert.match(risk.limits, /not a calibrated predictive distribution/)
    // Aliases must keep matching so stored records and consumers stay valid.
    assert.equal(risk.score_p10, risk.sensitivity_low)
    assert.equal(risk.score_p50, risk.sensitivity_mid)
    assert.equal(risk.score_p90, risk.sensitivity_high)
    assert.equal(risk.interval_width, risk.sensitivity_width)
  })

  it('explains a zero-width band rather than implying certainty', () => {
    // With full input coverage the band collapses. That must not read as
    // "no uncertainty" — the limits text has to say what it means.
    const rich = {
      ...data,
      climate_observations: [
        { ...data.climate_observations[0], precipitation_mm: 20, precipitation_probability_pct: 60 },
        { ...data.climate_observations[0], id: 'c2', precipitation_mm: 15, precipitation_probability_pct: 55 },
      ],
      hazard_events: [
        data.hazard_events[0],
        { ...data.hazard_events[0], id: 'h2', severity: 'critical', latitude: 3.21, longitude: 35.71 },
      ],
    }
    const [risk] = computeFloodRisk(rich)
    assert.equal(risk.confidence, 100, 'all three confidence inputs must be present')
    assert.equal(risk.sensitivity_width, 0)
    assert.equal(risk.calibrated_uncertainty, false)
    assert.match(risk.limits, /zero band means inputs were sufficient/i)
  })

  it('applies the same band labelling to climate-conflict risk', () => {
    const conflict = computeClimateConflictRisk(data)
    assert.ok(conflict.length >= 1)
    const risk = conflict[0]
    assert.ok(Number.isFinite(risk.sensitivity_low))
    assert.equal(risk.calibrated_uncertainty, false)
    assert.match(risk.limits, /weighted sum/i)
  })

  it('computes ensemble statistics with linear interpolation', () => {
    const stats = computeEnsembleStats([1, 2, 3, 4, 5])
    assert.equal(stats.p50, 3)
    assert.ok(Math.abs(stats.p90 - 4.6) < 0.1)
    assert.ok(Math.abs(stats.p10 - 1.4) < 0.1)
    assert.equal(stats.count, 5)
  })

  it('computes population at risk for hazards near service assets', () => {
    const dataWithAssets = {
      ...data,
      service_assets: [
        { id: 'a1', name: 'Clinic', service_type: 'health', latitude: 3.12, longitude: 35.61, country: 'KE', population_served: 500 },
      ],
    }
    const par = computePopulationAtRisk(dataWithAssets)
    assert.ok(par.length > 0)
    assert.ok(par[0].population_at_risk >= 500)
  })

  it('maps gridded values to station values via quantile matching', () => {
    const gridded = [1, 2, 3, 4, 5]
    const station = [10, 20, 30, 40, 50]
    const mapper = quantileMap(gridded, station)
    const result = mapper(3)
    assert.ok(Math.abs(result - 30) < 5)
  })

  it('exports GeoJSON and CSV', () => {
    const records = [...data.hazard_events, ...data.conflict_events]
    const geojson = toGeoJson(records)
    const csv = toCsv(records)
    assert.equal(geojson.type, 'FeatureCollection')
    assert.equal(geojson.features.length, 2)
    assert.match(csv, /event_type/)
    assert.match(csv, /gdacs/)
  })
})


describe('Lindela Lite storage modes', () => {
  it('orders merged records by operational timestamps', () => {
    const records = mergeById([
      { id: 'old-run', completed_at: '2026-01-01T00:00:00.000Z' },
    ], [
      { id: 'new-run', completed_at: '2026-01-02T00:00:00.000Z' },
    ])
    assert.deepEqual(records.map((record) => record.id), ['new-run', 'old-run'])
  })

  it('creates a JSON store when explicitly requested', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-storage-'))
    const store = await createStoreFromEnv({
      LINDELA_LITE_DB_MODE: 'json',
      LINDELA_LITE_STORE: path.join(dir, 'store.json'),
    })
    assert.equal(store.mode, 'json')
    const data = await store.read()
    assert.equal(data.source_runs.length, 0)
  })

  it('reports pg0 unavailable when the configured command is missing', async () => {
    const pg0 = new Pg0Manager({ command: 'missing-pg0-for-lindela-lite-test' })
    assert.equal(await pg0.available(), false)
  })

  it('requires a database URL for explicit postgres mode', async () => {
    await assert.rejects(
      () => createStoreFromEnv({ LINDELA_LITE_DB_MODE: 'postgres' }),
      /DATABASE_URL/,
    )
  })
})

describe('Lindela Lite validation', () => {
  it('passes the docs and deployment validation script', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/validate.mjs'], {
      cwd: process.cwd(),
    })
    assert.match(stdout, /validation ok/)
  })
})

describe('Lindela Lite API', () => {
  let server
  let baseUrl
  let tmpDir

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-api-'))
    const store = new JsonStore(path.join(tmpDir, 'store.json'))
    store.mode = 'json'
    server = createServer({ store })
    await new Promise((resolve) => server.listen(0, resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('serves health and source catalogs', async () => {
    const health = await fetchJson(`${baseUrl}/api/v1/health`)
    const sources = await fetchJson(`${baseUrl}/api/v1/sources`)
    const docs = await fetch(`${baseUrl}/docs/platform.md`)
    assert.equal(health.success, true)
    assert.ok(health.exclusions.includes('gdelt'))
    assert.equal(health.storage.mode, 'json')
    assert.ok(sources.data.some((source) => source.id === 'open_meteo'))
    assert.ok(!sources.data.some((source) => source.id === 'gdelt'))
    assert.equal(docs.headers.get('content-type').startsWith('text/markdown'), true)
    assert.match(await docs.text(), /Lindela Lite Platform Guide/)
  })

  it('requires the configured API key for mutating requests', async () => {
    const originalApiKey = process.env.LINDELA_LITE_API_KEY
    const originalWebhookSecret = process.env.RAPIDPRO_WEBHOOK_SECRET
    process.env.LINDELA_LITE_API_KEY = 'test-api-key'
    process.env.RAPIDPRO_WEBHOOK_SECRET = 'rapidpro-secret'
    try {
      const health = await fetch(`${baseUrl}/api/v1/health`)
      assert.equal(health.status, 200)

      const rejected = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Blocked incident',
          incident_type: 'auth_test',
          priority: 'medium',
          country: 'KE',
        }),
      })
      const rejectedPayload = await rejected.json()
      assert.equal(rejected.status, 401)
      assert.equal(rejectedPayload.success, false)

      const accepted = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          title: 'Authorized incident',
          incident_type: 'auth_test',
          priority: 'medium',
          country: 'KE',
        }),
      })
      const acceptedPayload = await accepted.json()
      assert.equal(accepted.status, 201)
      assert.equal(acceptedPayload.success, true)

      const rapidProWebhook = await fetch(`${baseUrl}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rapidpro-secret': 'rapidpro-secret',
        },
        body: JSON.stringify({ id: 'auth-rapidpro-1', from: '+254700000001', content: 'REPORT API key bypass through webhook secret' }),
      })
      const rapidProWebhookPayload = await rapidProWebhook.json()
      assert.equal(rapidProWebhook.status, 201)
      assert.equal(rapidProWebhookPayload.success, true)

      const rapidProRejected = await fetch(`${baseUrl}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rapidpro-secret': 'wrong',
        },
        body: JSON.stringify({ id: 'auth-rapidpro-2', content: 'REPORT blocked' }),
      })
      assert.equal(rapidProRejected.status, 401)
    } finally {
      if (originalApiKey === undefined) delete process.env.LINDELA_LITE_API_KEY
      else process.env.LINDELA_LITE_API_KEY = originalApiKey
      if (originalWebhookSecret === undefined) delete process.env.RAPIDPRO_WEBHOOK_SECRET
      else process.env.RAPIDPRO_WEBHOOK_SECRET = originalWebhookSecret
    }
  })

  it('falls back to the dashboard shell for unknown static routes', async () => {
    const response = await fetch(`${baseUrl}/non-existent-dashboard-route`)
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.match(body, /<title>Lindela Lite<\/title>/)
  })

  it('returns 404 for missing docs pages', async () => {
    const response = await fetch(`${baseUrl}/docs/not-a-real-doc.md`)
    const payload = await response.json()
    assert.equal(response.status, 404)
    assert.equal(payload.success, false)
    assert.match(payload.error, /Document not found/)
  })

  it('does not serve paths outside the docs directory', async () => {
    const response = await rawGet(baseUrl, '/docs/%2e%2e/package.json')
    const body = response.body
    assert.equal(response.status, 404)
    assert.doesNotMatch(body, /"scripts"/)
  })

  it('keeps dashboard mutating calls authenticated and dynamic HTML escaped', async () => {
    const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8')
    assert.match(app, /function authHeaders/)
    assert.match(app, /'x-api-key': apiKey/)
    // Escaping now lives in /shared/fmt.js and is imported under its escape
    // name; a local `function escapeHtml` would mean the shared module drifted.
    const fmt = await fs.readFile(path.join(process.cwd(), 'public/shared/fmt.js'), 'utf8')
    assert.match(fmt, /export function esc\(/)
    assert.match(app, /esc as escapeHtml/)
    assert.match(app, /title="\$\{escapeHtml\(source\.name\)\}"/)
    assert.doesNotMatch(app, /<td>\$\{record\.(title|message|text|name|source|status|id|owner)/)
  })

  it('resolves every element the dashboard looks up by id', async () => {
    // A getElementById miss returns null, which then fails at the first
    // property access rather than at load. This asserts the contract instead:
    // every id app.js asks for is declared in index.html.
    const [app, html] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'public/index.html'), 'utf8'),
    ])
    const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
    const looked = new Set([
      ...[...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
      ...[...app.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
    ])
    const missing = [...looked].filter((id) => !declared.has(id)).sort()
    assert.deepEqual(missing, [], `index.html is missing ids referenced by app.js: ${missing.join(', ')}`)
    assert.ok(looked.size > 20, `expected the dashboard to bind many ids, found ${looked.size}`)
  })

  it('imports shared modules the dashboard loads, at the paths it requests', async () => {
    // Node resolves a test import from a relative path while the browser
    // requests an absolute one, so a rename silently breaks the bundle.
    const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8')
    const sharedModules = [...app.matchAll(/from '(\/shared\/[^']+)'/g)].map((m) => m[1])
    assert.ok(sharedModules.length >= 2, `expected several shared modules, found ${sharedModules.length}`)

    for (const specifier of sharedModules) {
      const onDisk = path.join(process.cwd(), 'public', specifier)
      const source = await fs.readFile(onDisk, 'utf8')
      const exported = new Set(
        // 'async' is optional: the guard must see an async export too, or a
        // shared module that only exports async functions looks empty and every
        // import of it fails here for the wrong reason.
        [...source.matchAll(/export (?:async )?(?:const|function|class) (\w+)/g)].map((m) => m[1]),
      )
      const block = app.match(new RegExp(`import \\{([^}]+)\\} from '${specifier.replace(/[/.]/g, '\\$&')}'`))
      assert.ok(block, `app.js must import from ${specifier}`)
      // `{ original as alias }` imports bind the alias in app.js but resolve
      // against the ORIGINAL export in the module: the check must follow the
      // `as`, or an aliased import looks missing and the module looks broken.
      const names = block[1].split(',').map((n) => n.trim()).filter(Boolean)
        .map((n) => (n.match(/^(.+?)\s+as\s+\w+$/) || [null, n])[1])
      for (const name of names) {
        assert.ok(
          exported.has(name),
          `${specifier} must export ${name}; app.js imports it, so a rename breaks the bundle`,
        )
      }
    }
  })

  it('imports the flood-bands module the dashboard actually loads', async () => {
    // Guards against a rename that silently breaks the browser bundle: the
    // module must exist at the path app.js requests and export what it uses.
    const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8')
    const match = app.match(/from '(\/shared\/flood-bands\.js)'/)
    assert.ok(match, 'app.js must import /shared/flood-bands.js')
    const onDisk = path.join(process.cwd(), 'public', match[1])
    const names = [...(await fs.readFile(onDisk, 'utf8')).matchAll(/export (?:const|function) (\w+)/g)]
      .map((m) => m[1])
    for (const used of ['FLOOD_DEPTH_BANDS', 'floodCellsForGrid', 'floodCoverage']) {
      assert.ok(names.includes(used), `flood-bands.js must export ${used}`)
    }
  })

  it('styles every flood depth band class it renders', async () => {
    // An unstyled band renders as invisible fill, so the operator sees no
    // water at all with no error to explain it.
    const [css, bands] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'public/styles.css'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'public/shared/flood-bands.js'), 'utf8'),
    ])
    const keys = [...bands.matchAll(/key: '(\w+)'/g)].map((m) => m[1])
    assert.ok(keys.length >= 5, `expected depth bands in the module, found ${keys.length}`)
    for (const key of keys) {
      assert.match(css, new RegExp(`\\.flood-${key}\\b`), `styles.css must define .flood-${key}`)
    }
  })

  it('ingests user-supplied conflict and service data through the API', async () => {
    const response = await fetch(`${baseUrl}/api/v1/ingest/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sources: ['service_assets', 'conflict_csv'],
        service_assets: [
          { name: 'Water Point 1', service_type: 'water', latitude: 3.1, longitude: 35.6, country: 'KE' },
        ],
        conflict_csv: 'event_date,event_type,latitude,longitude,country,fatalities,title\n2026-01-01,resource_tension,3.11,35.61,KE,0,Water access tension\n',
      }),
    })
    const payload = await response.json()
    assert.equal(payload.success, true)

    const events = await fetchJson(`${baseUrl}/api/v1/events`)
    const impacts = await fetchJson(`${baseUrl}/api/v1/service-impacts`)
    assert.equal(events.data.length, 1)
    assert.equal(impacts.data.length, 1)
  })

  it('tracks ingestion health and runs due ingestion schedules', async () => {
    const status = await fetchJson(`${baseUrl}/api/v1/ingest/status`)
    assert.equal(status.success, true)
    assert.ok(status.data.some((item) => item.source === 'open_meteo' && item.regular === true))

    const defaultsResponse = await fetch(`${baseUrl}/api/v1/ingest/schedules/defaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ next_run_at: '2999-01-01T00:00:00.000Z', actor: 'test' }),
    })
    const defaults = await defaultsResponse.json()
    assert.equal(defaultsResponse.status, 201)
    assert.ok(defaults.created >= 5)
    assert.ok(defaults.data.every((schedule) => schedule.status === 'active'))

    const scheduleResponse = await fetch(`${baseUrl}/api/v1/ingest/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'conflict_csv',
        interval_minutes: 60,
        next_run_at: '2026-01-01T00:00:00.000Z',
        default_options: {
          conflict_csv: 'event_date,event_type,latitude,longitude,country,fatalities,title\n2026-01-02,scheduled_ingest,3.12,35.62,KE,0,Scheduled ingestion event\n',
        },
        actor: 'test',
      }),
    })
    const schedule = await scheduleResponse.json()
    assert.equal(scheduleResponse.status, 201)
    assert.equal(schedule.data.source, 'conflict_csv')

    const runDueResponse = await fetch(`${baseUrl}/api/v1/ingest/run-due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const runDue = await runDueResponse.json()
    assert.equal(runDueResponse.status, 201)
    assert.equal(runDue.data.length, 1)
    assert.equal(runDue.data[0].run_type, 'scheduled')
    assert.equal(runDue.data[0].schedule_id, schedule.data.id)
    assert.equal(runDue.data[0].status, 'success')
    assert.equal(runDue.schedules[0].last_run_at, runDue.data[0].completed_at)
    assert.ok(Date.parse(runDue.schedules[0].next_run_at) > Date.parse(runDue.schedules[0].last_run_at))

    const events = await fetchJson(`${baseUrl}/api/v1/events?event_type=scheduled_ingest`)
    assert.equal(events.data.length, 1)

    const health = await fetchJson(`${baseUrl}/api/v1/ingest/status`)
    const conflictHealth = health.data.find((item) => item.source === 'conflict_csv')
    assert.equal(conflictHealth.status, 'fresh')
    assert.equal(conflictHealth.schedule.id, schedule.data.id)

    const runOneResponse = await fetch(`${baseUrl}/api/v1/ingest/schedules/${schedule.data.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const runOne = await runOneResponse.json()
    assert.equal(runOneResponse.status, 201)
    assert.equal(runOne.data.length, 1)
    assert.equal(runOne.data[0].schedule_id, schedule.data.id)
    assert.equal(runOne.schedule.last_run_at, runOne.data[0].completed_at)
  })

  it('returns empty arrays for empty-state API responses', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-empty-api-'))
    const emptyStore = new JsonStore(path.join(dir, 'store.json'))
    emptyStore.mode = 'json'
    const emptyServer = createServer({ store: emptyStore })
    await new Promise((resolve) => emptyServer.listen(0, resolve))
    const emptyBase = `http://127.0.0.1:${emptyServer.address().port}`
    try {
      const events = await fetchJson(`${emptyBase}/api/v1/events`)
      const climate = await fetchJson(`${emptyBase}/api/v1/climate`)
      assert.deepEqual(events.data, [])
      assert.deepEqual(climate.data, [])
    } finally {
      await new Promise((resolve) => emptyServer.close(resolve))
    }
  })

  it('validates service asset imports', async () => {
    const response = await fetch(`${baseUrl}/api/v1/service-assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service_assets: [{ name: 'Bad asset', service_type: 'health', country: 'KE', longitude: 35.6 }] }),
    })
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.equal(payload.success, false)
    assert.match(payload.errors[0], /latitude/)
  })

  it('filters events and exports CSV and GeoJSON', async () => {
    const filtered = await fetchJson(`${baseUrl}/api/v1/events?country=KE&event_type=resource_tension`)
    assert.equal(filtered.data.length, 1)

    const geojson = await fetchJson(`${baseUrl}/api/v1/export.geojson?country=KE`)
    assert.equal(geojson.type, 'FeatureCollection')
    assert.ok(geojson.features.length >= 1)

    const csvResponse = await fetch(`${baseUrl}/api/v1/export.csv?country=KE`)
    const csv = await csvResponse.text()
    assert.equal(csvResponse.headers.get('content-type').startsWith('text/csv'), true)
    assert.match(csv, /resource_tension/)
  })

  it('manages incidents, interventions, tasks, field reports, resources, and action logs', async () => {
    const incidentResponse = await fetch(`${baseUrl}/api/v1/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Clinic flood access disruption',
        incident_type: 'flood_access',
        priority: 'high',
        country: 'KE',
        latitude: 3.13,
        longitude: 35.63,
        actor: 'test',
      }),
    })
    const incident = await incidentResponse.json()
    assert.equal(incidentResponse.status, 201)
    assert.equal(incident.success, true)
    assert.equal(incident.data.status, 'open')

    const interventionResponse = await fetch(`${baseUrl}/api/v1/interventions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        incident_id: incident.data.id,
        title: 'Maintain clinic continuity',
        lead_org: 'County health ops',
        status: 'active',
      }),
    })
    const intervention = await interventionResponse.json()
    assert.equal(interventionResponse.status, 201)
    assert.equal(intervention.data.incident_id, incident.data.id)

    const taskResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intervention_id: intervention.data.id,
        title: 'Validate dry access route',
        owner: 'field-lead',
      }),
    })
    const task = await taskResponse.json()
    assert.equal(taskResponse.status, 201)
    assert.equal(task.data.status, 'todo')

    const updatedTask = await fetchJson(`${baseUrl}/api/v1/tasks/${task.data.id}`)
    assert.equal(updatedTask.data.title, 'Validate dry access route')

    const reportResponse = await fetch(`${baseUrl}/api/v1/field-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        incident_id: incident.data.id,
        summary: 'Access route passable by 4x4 only',
        reported_by: 'field-lead',
        needs: ['fuel', 'water'],
      }),
    })
    const report = await reportResponse.json()
    assert.equal(reportResponse.status, 201)
    assert.equal(report.data.incident_id, incident.data.id)

    const resourceResponse = await fetch(`${baseUrl}/api/v1/response-resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Water treatment kits',
        resource_type: 'supply',
        quantity: 20,
        unit: 'kit',
        status: 'reserved',
        assigned_intervention_id: intervention.data.id,
      }),
    })
    const resource = await resourceResponse.json()
    assert.equal(resourceResponse.status, 201)
    assert.equal(resource.data.quantity, 20)

    const closeIncidentResponse = await fetch(`${baseUrl}/api/v1/incidents/${incident.data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'responding', owner: 'ops-lead' }),
    })
    const closedIncident = await closeIncidentResponse.json()
    assert.equal(closeIncidentResponse.status, 200)
    assert.equal(closedIncident.data.status, 'responding')
    assert.equal(closedIncident.data.owner, 'ops-lead')

    const summary = await fetchJson(`${baseUrl}/api/v1/operations/summary`)
    assert.ok(summary.data.counts.open_incidents >= 1)
    assert.ok(summary.data.counts.active_interventions >= 1)

    const logs = await fetchJson(`${baseUrl}/api/v1/action-logs?limit=20`)
    assert.ok(logs.data.some((log) => log.record_id === incident.data.id))

    const geojson = await fetchJson(`${baseUrl}/api/v1/export.geojson?incident_id=${incident.data.id}`)
    assert.equal(geojson.type, 'FeatureCollection')
    assert.ok(geojson.features.length >= 1)
  })

  it('soft-deletes records that reference a parent collection', async () => {
    // Regression: tasks and field reports cross-reference a parent record, so
    // their normalizers need the store snapshot. Deleting a leaf that has no
    // parent reference passed and hid this.
    const incident = await (await fetch(`${baseUrl}/api/v1/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Parent incident', incident_type: 'flood_access' }),
    })).json()

    const intervention = await (await fetch(`${baseUrl}/api/v1/interventions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ incident_id: incident.data.id, title: 'Parent intervention' }),
    })).json()

    const task = await (await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervention_id: intervention.data.id, title: 'Nested task' }),
    })).json()
    assert.equal(task.status, undefined)

    const delTask = await fetch(`${baseUrl}/api/v1/tasks/${task.data.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops-lead' }),
    })
    const delTaskBody = await delTask.json()
    assert.equal(delTask.status, 200, `task delete failed: ${JSON.stringify(delTaskBody)}`)
    assert.ok(delTaskBody.data.deleted_at)
    // Parent linkage survives the delete.
    assert.equal(delTaskBody.data.intervention_id, intervention.data.id)
    assert.equal(delTaskBody.data.incident_id, incident.data.id)

    const report = await (await fetch(`${baseUrl}/api/v1/field-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ incident_id: incident.data.id, summary: 'Nested report' }),
    })).json()

    const delReport = await fetch(`${baseUrl}/api/v1/field-reports/${report.data.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops-lead' }),
    })
    assert.equal(delReport.status, 200)
    assert.ok((await delReport.json()).data.deleted_at)

    // Parents remain intact and undeleted.
    const stillThere = await fetchJson(`${baseUrl}/api/v1/interventions/${intervention.data.id}`)
    assert.equal(stillThere.data.deleted_at, null)
  })

  it('soft-deletes operational records and hides them by default', async () => {
    const create = await fetch(`${baseUrl}/api/v1/response-resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Disposable water tabs', resource_type: 'supply', quantity: 5 }),
    })
    const created = await create.json()
    assert.equal(create.status, 201)

    const beforeDelete = await fetchJson(`${baseUrl}/api/v1/operations/summary`)
    assert.ok(beforeDelete.data.counts.deployed_resources >= 0)

    const deleteResponse = await fetch(`${baseUrl}/api/v1/response-resources/${created.data.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops-lead' }),
    })
    const deleted = await deleteResponse.json()
    assert.equal(deleteResponse.status, 200)
    assert.ok(deleted.data.deleted_at)
    assert.equal(deleted.data.deleted_by, 'ops-lead')
    assert.equal(deleted.action_log.action, 'deleted')

    // Hidden from the default list
    const list = await fetchJson(`${baseUrl}/api/v1/response-resources`)
    assert.ok(!list.data.some((item) => item.id === created.data.id))

    // Hidden from direct GET, and from writes
    const missing = await fetchJson(`${baseUrl}/api/v1/response-resources/${created.data.id}`)
    assert.equal(missing.error, 'Record not found')

    const patchDeleted = await fetch(`${baseUrl}/api/v1/response-resources/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 99 }),
    })
    assert.equal(patchDeleted.status, 409)

    // Double delete is rejected
    const secondDelete = await fetch(`${baseUrl}/api/v1/response-resources/${created.data.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops-lead' }),
    })
    assert.equal(secondDelete.status, 409)

    // Still retrievable with include_deleted for audit
    const withDeleted = await fetchJson(`${baseUrl}/api/v1/response-resources?include_deleted=true`)
    assert.ok(withDeleted.data.some((item) => item.id === created.data.id && item.deleted_at))

    const single = await fetchJson(`${baseUrl}/api/v1/response-resources/${created.data.id}?include_deleted=true`)
    assert.equal(single.data.id, created.data.id)
    assert.ok(single.data.deleted_at)

    // Action log records the deletion
    const logs = await fetchJson(`${baseUrl}/api/v1/action-logs?limit=50`)
    assert.ok(logs.data.some((log) => log.record_id === created.data.id && log.action === 'deleted'))

    // Other records are unaffected
    const survivor = await fetch(`${baseUrl}/api/v1/response-resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Retained shelter tarps', resource_type: 'supply', quantity: 3 }),
    })
    const kept = await survivor.json()
    assert.equal(survivor.status, 201)

    const other = await fetchJson(`${baseUrl}/api/v1/response-resources/${kept.data.id}`)
    assert.equal(other.data.id, kept.data.id)
    assert.equal(other.data.deleted_at, null)
  })

  it('evaluates alert rules into auditable alert events', async () => {
    const ruleResponse = await fetch(`${baseUrl}/api/v1/alert-rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Open incident alert',
        metric: 'operations.counts.open_incidents',
        operator: '>=',
        threshold: 1,
        severity: 'high',
        actions: [{ type: 'notify', target: 'response-lead' }],
      }),
    })
    const rule = await ruleResponse.json()
    assert.equal(ruleResponse.status, 201)
    assert.equal(rule.data.status, 'active')

    const evaluationResponse = await fetch(`${baseUrl}/api/v1/alerts/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const evaluation = await evaluationResponse.json()
    assert.equal(evaluationResponse.status, 201)
    assert.equal(evaluation.created, 1)
    assert.equal(evaluation.data[0].rule_id, rule.data.id)

    const duplicateResponse = await fetch(`${baseUrl}/api/v1/alerts/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const duplicate = await duplicateResponse.json()
    assert.equal(duplicate.created, 0)

    const updateResponse = await fetch(`${baseUrl}/api/v1/alert-events/${evaluation.data[0].id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged', owner: 'ops-lead' }),
    })
    const updated = await updateResponse.json()
    assert.equal(updateResponse.status, 200)
    assert.equal(updated.data.status, 'acknowledged')
    assert.equal(updated.data.owner, 'ops-lead')
  })

  it('dispatches alert events through RapidPro flow starts', async () => {
    const received = []
    const rapidPro = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ uuid: 'flow-start-1', status: 'pending' }))
    })
    await new Promise((resolve) => rapidPro.listen(0, resolve))
    const original = rapidProEnv()
    process.env.RAPIDPRO_API_TOKEN = 'rapidpro-token'
    process.env.RAPIDPRO_BASE_URL = `http://127.0.0.1:${rapidPro.address().port}`
    process.env.RAPIDPRO_ALERT_FLOW_UUID = 'flow-uuid-1'
    try {
      const alerts = await fetchJson(`${baseUrl}/api/v1/alert-events?limit=1`)
      assert.ok(alerts.data.length >= 1)
      const alertId = alerts.data[0].id
      const approveResponse = await fetch(`${baseUrl}/api/v1/alert-events/${alertId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer test-token-${Math.random()}` },
        body: JSON.stringify({ actor: 'test-approver', note: 'Approved for testing' }),
      })
      assert.equal(approveResponse.status, 200)
      const response = await fetch(`${baseUrl}/api/v1/rapidpro/alert-events/${alertId}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urns: ['+254700000000'], actor: 'test' }),
      })
      const payload = await response.json()
      assert.equal(response.status, 201)
      assert.equal(payload.success, true)
      assert.equal(payload.data.status, 'sent')
      assert.equal(received[0].url, '/api/v2/flow_starts.json')
      assert.equal(received[0].authorization, 'Token rapidpro-token')
      assert.deepEqual(received[0].body.urns, ['tel:+254700000000'])
      assert.equal(received[0].body.flow, 'flow-uuid-1')

      const dispatches = await fetchJson(`${baseUrl}/api/v1/rapidpro/dispatches`)
      assert.ok(dispatches.data.some((dispatch) => dispatch.alert_event_id === alertId))
    } finally {
      restoreRapidProEnv(original)
      await new Promise((resolve) => rapidPro.close(resolve))
    }
  })

  it('receives RapidPro webhook payloads as field reports', async () => {
    const original = rapidProEnv()
    process.env.RAPIDPRO_WEBHOOK_SECRET = 'incoming-secret'
    try {
      const incidentResponse = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'RapidPro linked incident',
          incident_type: 'field_report',
          priority: 'medium',
          country: 'KE',
        }),
      })
      const incident = await incidentResponse.json()
      const response = await fetch(`${baseUrl}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rapidpro-secret': 'incoming-secret',
        },
        body: JSON.stringify({
          id: 'rapidpro-message-1',
          from: '+254711111111',
          content: `REPORT ${incident.data.id} Bridge access blocked needs: fuel, water 3.12,35.63`,
          contact: { uuid: 'contact-1', name: 'Field Agent' },
          run: { uuid: 'run-1' },
        }),
      })
      const payload = await response.json()
      assert.equal(response.status, 201)
      assert.equal(payload.success, true)
      assert.equal(payload.data.incident_id, incident.data.id)
      assert.deepEqual(payload.data.needs, ['fuel', 'water'])
      assert.equal(payload.data.latitude, 3.12)
      assert.equal(payload.inbound.from, '+254711111111')

      const inbound = await fetchJson(`${baseUrl}/api/v1/rapidpro/inbound`)
      assert.ok(inbound.data.some((message) => message.source_id === 'rapidpro-message-1'))

      const rejected = await fetch(`${baseUrl}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rapidpro-secret': 'wrong' },
        body: JSON.stringify({ content: 'REPORT bad secret' }),
      })
      assert.equal(rejected.status, 401)
    } finally {
      restoreRapidProEnv(original)
    }
  })

  it('exposes data quality and confidence-enhanced assessments', async () => {
    const quality = await fetchJson(`${baseUrl}/api/v1/data-quality`)
    assert.equal(quality.success, true)
    assert.ok(quality.data.some((item) => item.source === 'conflict_csv'))

    const assessments = await fetchJson(`${baseUrl}/api/v1/assessments`)
    assert.equal(assessments.success, true)
    assert.ok(Array.isArray(assessments.data.data_quality))
    assert.ok(assessments.data.operations.counts.open_incidents >= 1)
    assert.ok(Array.isArray(assessments.data.alert_events))
    assert.ok(assessments.data.climate_conflict_risk.every((risk) => Number.isFinite(risk.confidence)))
  })

  it('creates, displays, approves, and distributes generated reports', async () => {
    const receivedWebhooks = []
    const webhook = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      receivedWebhooks.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: true }))
    })
    const rapidProRequests = []
    const rapidPro = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      rapidProRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ uuid: 'report-flow-start-1' }))
    })
    await new Promise((resolve) => webhook.listen(0, resolve))
    await new Promise((resolve) => rapidPro.listen(0, resolve))
    const original = rapidProEnv()
    process.env.RAPIDPRO_API_TOKEN = 'rapidpro-token'
    process.env.RAPIDPRO_BASE_URL = `http://127.0.0.1:${rapidPro.address().port}`
    process.env.RAPIDPRO_ALERT_FLOW_UUID = 'report-flow-uuid'
    try {
      const templateResponse = await fetch(`${baseUrl}/api/v1/report-templates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Daily operations SITREP',
          report_type: 'situation_report',
          title_pattern: 'Daily operations SITREP - {{country}} - {{date}}',
          default_filters: { country: 'KE' },
          sections: ['executive_summary', 'incident_summary', 'field_report_summary', 'alert_summary', 'data_quality_summary', 'appendix_sources'],
          actor: 'test',
        }),
      })
      const template = await templateResponse.json()
      assert.equal(templateResponse.status, 201)
      assert.equal(template.data.version, 1)

      const copyResponse = await fetch(`${baseUrl}/api/v1/report-templates/${template.data.id}/copy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Copied SITREP', actor: 'test' }),
      })
      const copied = await copyResponse.json()
      assert.equal(copyResponse.status, 201)
      assert.equal(copied.data.version, 1)
      assert.notEqual(copied.data.id, template.data.id)

      const reportResponse = await fetch(`${baseUrl}/api/v1/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template_id: template.data.id, generate: true, actor: 'test' }),
      })
      const report = await reportResponse.json()
      assert.equal(reportResponse.status, 201)
      assert.equal(report.data.status, 'ready')
      assert.ok(report.data.sections.some((section) => section.id === 'incident_summary'))
      assert.ok(report.data.source_refs.length >= 1)

      const markdownResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/export.md`)
      const markdown = await markdownResponse.text()
      assert.equal(markdownResponse.headers.get('content-type').startsWith('text/markdown'), true)
      assert.match(markdown, /Daily operations SITREP/)
      assert.match(markdown, /Source Appendix/)

      const exportedJson = await fetchJson(`${baseUrl}/api/v1/reports/${report.data.id}/export.json`)
      assert.equal(exportedJson.data.id, report.data.id)

      const appendixCsv = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/export.csv`)
      const appendixCsvText = await appendixCsv.text()
      assert.equal(appendixCsv.headers.get('content-type').startsWith('text/csv'), true)
      assert.match(appendixCsvText, /report_source_collection/)

      const appendixGeoJson = await fetchJson(`${baseUrl}/api/v1/reports/${report.data.id}/export.geojson`)
      assert.equal(appendixGeoJson.type, 'FeatureCollection')

      const approveResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'test' }),
      })
      const approved = await approveResponse.json()
      assert.equal(approveResponse.status, 200)
      assert.equal(approved.data.status, 'approved')

      const distributeResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/distribute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'test',
          channels: [
            { channel: 'markdown_download' },
            { channel: 'csv' },
            { channel: 'geojson' },
            { channel: 'webhook', url: `http://127.0.0.1:${webhook.address().port}/report` },
            { channel: 'rapidpro_sms', urns: ['+254700000000'] },
          ],
        }),
      })
      const distributed = await distributeResponse.json()
      assert.equal(distributeResponse.status, 201)
      assert.equal(distributed.success, true)
      assert.equal(distributed.report.status, 'distributed')
      assert.equal(distributed.data.length, 5)
      assert.ok(distributed.data.some((run) => run.channel === 'markdown_download' && run.status === 'prepared'))
      assert.ok(distributed.data.some((run) => run.channel === 'csv' && run.status === 'prepared'))
      assert.ok(distributed.data.some((run) => run.channel === 'geojson' && run.status === 'prepared'))
      assert.ok(distributed.data.some((run) => run.channel === 'webhook' && run.status === 'sent'))
      assert.ok(distributed.data.some((run) => run.channel === 'rapidpro_sms' && run.status === 'sent'))
      assert.equal(receivedWebhooks[0].report.id, report.data.id)
      assert.equal(rapidProRequests[0].url, '/api/v2/flow_starts.json')
      assert.equal(rapidProRequests[0].authorization, 'Token rapidpro-token')
      assert.equal(rapidProRequests[0].body.params.report_id, report.data.id)

      const runs = await fetchJson(`${baseUrl}/api/v1/report-distributions?limit=20`)
      assert.ok(runs.data.some((run) => run.report_id === report.data.id))
    } finally {
      restoreRapidProEnv(original)
      await new Promise((resolve) => webhook.close(resolve))
      await new Promise((resolve) => rapidPro.close(resolve))
    }
  })

  it('keeps reports approved when every distribution channel fails', async () => {
    const templateResponse = await fetch(`${baseUrl}/api/v1/report-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Failure-path report',
        report_type: 'incident_brief',
        default_filters: { country: 'KE' },
        sections: ['executive_summary', 'incident_summary', 'appendix_sources'],
        actor: 'test',
      }),
    })
    const template = await templateResponse.json()
    assert.equal(templateResponse.status, 201)

    const reportResponse = await fetch(`${baseUrl}/api/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: template.data.id, generate: true, actor: 'test' }),
    })
    const report = await reportResponse.json()
    assert.equal(reportResponse.status, 201)

    const approveResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    assert.equal(approveResponse.status, 200)

    const distributeResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/distribute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'test',
        channels: [{ channel: 'webhook', url: 'http://127.0.0.1:1/report' }],
      }),
    })
    const distributed = await distributeResponse.json()
    assert.equal(distributeResponse.status, 201)
    assert.equal(distributed.success, false)
    assert.equal(distributed.data.length, 1)
    assert.equal(distributed.data[0].status, 'failed')
    assert.equal(distributed.report.status, 'approved')

    const persisted = await fetchJson(`${baseUrl}/api/v1/reports/${report.data.id}`)
    assert.equal(persisted.data.status, 'approved')
  })

  it('records and advances failed report schedules when the template is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-missing-template-'))
    const missingStore = new JsonStore(path.join(dir, 'store.json'))
    missingStore.mode = 'json'
    const missingServer = createServer({ store: missingStore })
    await missingStore.write({
      report_schedules: [{
        id: 'report_schedule_missing_template',
        template_id: 'report_template_missing',
        status: 'active',
        timezone: 'UTC',
        recurrence: { type: 'interval', minutes: 60 },
        next_run_at: '2026-01-01T00:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    })
    await new Promise((resolve) => missingServer.listen(0, resolve))
    const missingBase = `http://127.0.0.1:${missingServer.address().port}`
    try {
      const response = await fetch(`${missingBase}/api/v1/report-schedules/run-due`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'test' }),
      })
      const payload = await response.json()
      assert.equal(response.status, 201)
      assert.equal(payload.data.length, 1)
      assert.equal(payload.data[0].status, 'failed')
      assert.equal(payload.data[0].error, 'Template not found')
      assert.deepEqual(payload.reports, [])

      const persisted = await missingStore.read()
      const schedule = persisted.report_schedules.find((item) => item.id === 'report_schedule_missing_template')
      assert.ok(schedule.last_run_at)
      assert.ok(Date.parse(schedule.next_run_at) > Date.parse(schedule.last_run_at))
      assert.equal(persisted.reports.some((item) => item === null), false)
      assert.ok(persisted.action_logs.some((log) => log.record_id === payload.data[0].id && log.action === 'failed'))
    } finally {
      await new Promise((resolve) => missingServer.close(resolve))
    }
  })

  it('schedules report templates and records schedule runs', async () => {
    const templateResponse = await fetch(`${baseUrl}/api/v1/report-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Weekly intervention update',
        report_type: 'intervention_update',
        default_filters: { country: 'KE' },
        sections: ['executive_summary', 'intervention_summary', 'field_report_summary', 'appendix_sources'],
      }),
    })
    const template = await templateResponse.json()
    const scheduleResponse = await fetch(`${baseUrl}/api/v1/report-schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: template.data.id,
        timezone: 'Africa/Nairobi',
        recurrence: { type: 'interval', minutes: 60 },
        next_run_at: '2026-01-01T00:00:00.000Z',
        auto_distribute: false,
      }),
    })
    const schedule = await scheduleResponse.json()
    assert.equal(scheduleResponse.status, 201)
    assert.equal(schedule.data.status, 'active')

    const runDueResponse = await fetch(`${baseUrl}/api/v1/report-schedules/run-due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const runDue = await runDueResponse.json()
    assert.equal(runDueResponse.status, 201)
    assert.equal(runDue.data.length, 1)
    assert.equal(runDue.reports.length, 1)
    assert.equal(runDue.data[0].status, 'completed')
    assert.ok(Date.parse(runDue.reports[0].generated_at) > 0)

    const scheduleRuns = await fetchJson(`${baseUrl}/api/v1/report-schedule-runs`)
    const createdRun = scheduleRuns.data.find((run) => run.schedule_id === schedule.data.id)
    assert.ok(createdRun)

    const retryResponse = await fetch(`${baseUrl}/api/v1/report-schedule-runs/${createdRun.id}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const retry = await retryResponse.json()
    assert.equal(retryResponse.status, 201)
    assert.equal(retry.data.status, 'completed')
  })

  it('auto-distributes reports from due report schedules', async () => {
    const templateResponse = await fetch(`${baseUrl}/api/v1/report-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Auto distribution digest',
        report_type: 'alert_digest',
        default_filters: { country: 'KE' },
        sections: ['executive_summary', 'alert_summary', 'appendix_sources'],
        distribution_defaults: [{ channel: 'markdown_download' }],
      }),
    })
    const template = await templateResponse.json()
    assert.equal(templateResponse.status, 201)

    const scheduleResponse = await fetch(`${baseUrl}/api/v1/report-schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: template.data.id,
        recurrence: { type: 'interval', minutes: 60 },
        next_run_at: '2026-01-01T00:00:00.000Z',
        auto_distribute: true,
        distribution_defaults: [{ channel: 'markdown_download' }],
      }),
    })
    const schedule = await scheduleResponse.json()
    assert.equal(scheduleResponse.status, 201)

    const runDueResponse = await fetch(`${baseUrl}/api/v1/report-schedules/run-due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const runDue = await runDueResponse.json()
    assert.equal(runDueResponse.status, 201)
    assert.equal(runDue.data.length, 1)
    assert.equal(runDue.data[0].schedule_id, schedule.data.id)
    assert.equal(runDue.reports[0].status, 'distributed')
    assert.equal(runDue.distributions.length, 1)
    assert.equal(runDue.distributions[0].status, 'prepared')
  })

})

async function fetchJson(url) {
  const response = await fetch(url)
  return response.json()
}

function rawGet(baseUrl, requestPath) {
  const url = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: requestPath,
      method: 'GET',
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('Lindela Lite PWA and i18n', () => {
  it('GET /manifest.webmanifest returns 200 with manifest+json content-type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-pwa-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/manifest.webmanifest`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
      const json = await res.json()
      assert.equal(json.name, 'Lindela Lite')
      assert.equal(json.display, 'standalone')
    } finally {
      listener.close()
    }
  })

  it('GET /sw.js returns 200 with javascript content-type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-sw-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/sw.js`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8')
      const text = await res.text()
      assert.ok(text.includes('CACHE_NAME'))
    } finally {
      listener.close()
    }
  })

  it('GET /i18n/en.json returns 200 with application/json content-type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-i18n-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/i18n/en.json`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
      const json = await res.json()
      assert.equal(json['app.title'], 'Lindela Lite')
      assert.equal(json['action.refresh'], 'Refresh')
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite workflows', () => {
  it('normalizeWorkflowInstance accepts valid type and initial state', () => {
    const workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      subject_kind: 'alert_event',
      subject_id: 'alert_123',
      district: 'Turkana',
    })
    assert.equal(workflow.type, 'anticipatory_alert')
    assert.equal(workflow.state, 'signal_detected')
    assert.equal(workflow.subject_kind, 'alert_event')
    assert.ok(workflow.id)
    assert.ok(workflow.created_at)
  })

  it('normalizeWorkflowInstance rejects invalid type', () => {
    assert.throws(
      () => normalizeWorkflowInstance({ type: 'invalid_type' }),
      /type must be one of/,
    )
  })

  it('transitionWorkflow moves from signal_detected to focal_point_review', () => {
    const workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      subject_kind: 'alert_event',
      subject_id: 'alert_123',
      district: 'Turkana',
    })
    const transitioned = transitionWorkflow(workflow, {
      to: 'focal_point_review',
      actor: 'operator_1',
      reason: 'Severity check passed',
    })
    assert.equal(transitioned.state, 'focal_point_review')
    assert.equal(transitioned.transitions.length, 1)
    assert.equal(transitioned.transitions[0].from, 'signal_detected')
    assert.equal(transitioned.transitions[0].to, 'focal_point_review')
  })

  it('transitionWorkflow throws 409 for invalid transitions', () => {
    const workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      subject_kind: 'alert_event',
      subject_id: 'alert_123',
      district: 'Turkana',
    })
    assert.throws(
      () => transitionWorkflow(workflow, { to: 'closed' }),
      /Cannot transition/,
    )
  })

  it('transitionWorkflow sets closed_at when transitioning to terminal state', () => {
    let workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      subject_kind: 'alert_event',
      subject_id: 'alert_123',
      district: 'Turkana',
    })
    workflow = transitionWorkflow(workflow, { to: 'focal_point_review' })
    workflow = transitionWorkflow(workflow, { to: 'rejected' })
    workflow = transitionWorkflow(workflow, { to: 'closed' })
    assert.ok(workflow.closed_at)
    assert.equal(workflow.state, 'closed')
  })

  it('POST /api/v1/workflows creates and emits workflow', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-workflows-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'anticipatory_alert',
          subject_kind: 'alert_event',
          subject_id: 'alert_123',
          district: 'Turkana',
        }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.equal(json.success, true)
      assert.ok(json.data.id)
      assert.equal(json.data.state, 'signal_detected')
      const outbox = await fetch(`${baseUrl}/api/v1/outbox`)
      const outboxJson = await outbox.json()
      assert.ok(outboxJson.data.some((e) => e.event === 'workflow.created'))
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/workflows/:id/transition updates state and emits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-workflow-transition-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`

    try {
      const createRes = await fetch(`${baseUrl}/api/v1/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'anticipatory_alert',
          subject_kind: 'alert_event',
          subject_id: 'alert_123',
          district: 'Turkana',
        }),
      })
      const created = await createRes.json()
      const workflowId = created.data.id

      const transRes = await fetch(`${baseUrl}/api/v1/workflows/${workflowId}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: 'focal_point_review',
          reason: 'Severity check passed',
        }),
      })
      assert.equal(transRes.status, 200)
      const transJson = await transRes.json()
      assert.equal(transJson.data.state, 'focal_point_review')
      const outbox = await fetch(`${baseUrl}/api/v1/outbox`)
      const outboxJson = await outbox.json()
      assert.ok(outboxJson.data.some((e) => e.event === 'workflow.transitioned'))
    } finally {
      listener.close()
    }
  })

  it('workflowMetrics counts open, closed, and rejected instances', () => {
    const instances = [
      { type: 'anticipatory_alert', state: 'signal_detected' },
      { type: 'anticipatory_alert', state: 'closed' },
      { type: 'anticipatory_alert', state: 'rejected' },
      { type: 'cold_chain_protection', state: 'action_taken' },
    ]
    const metrics = workflowMetrics(instances)
    assert.equal(metrics.open, 2)
    assert.equal(metrics.closed, 1)
    assert.equal(metrics.rejected, 1)
    assert.equal(metrics.by_type.anticipatory_alert.open, 1)
    assert.equal(metrics.by_type.anticipatory_alert.closed, 1)
  })
})

describe('Lindela Lite Focal Point', () => {
  it('GET /focal-point returns 200 HTML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-focal-point-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/focal-point`)
      assert.equal(res.status, 200)
      assert.ok(res.headers.get('content-type').includes('text/html'))
      const html = await res.text()
      assert.ok(html.includes('Lindela Lite'))
      assert.ok(html.includes('Focal Point'))
    } finally {
      listener.close()
    }
  })

  it('GET /focal-point/manifest.webmanifest returns 200', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-focal-manifest-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/focal-point/manifest.webmanifest`)
      assert.equal(res.status, 200)
      assert.ok(res.headers.get('content-type').includes('json'))
      const json = await res.json()
      assert.equal(json.name, 'Lindela Focal Point')
      assert.equal(json.start_url, '/focal-point')
    } finally {
      listener.close()
    }
  })

  it('Focal-point-scoped workflow list returns workflows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-fp-workflows-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      workflow_instances: [
        {
          id: 'w1',
          type: 'anticipatory_alert',
          state: 'focal_point_review',
          district: 'turkana',
          created_at: new Date().toISOString(),
        },
        {
          id: 'w2',
          type: 'anticipatory_alert',
          state: 'signal_detected',
          district: 'turkana',
          created_at: new Date().toISOString(),
        },
      ],
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/workflows`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.success)
      assert.equal(json.data.length, 2)
      assert.ok(json.data.some((w) => w.id === 'w1'))
      assert.ok(json.data.some((w) => w.id === 'w2'))
    } finally {
      listener.close()
    }
  })

  it('Workflow transition returns 409 for invalid state change', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-wf-invalid-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      state: 'closed',
      district: 'turkana',
    })
    await store.merge({ workflow_instances: [workflow] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/workflows/${workflow.id}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'dispatched' }),
      })
      assert.equal(res.status, 409)
      const json = await res.json()
      assert.equal(json.success, false)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/workflows/metrics returns with data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-metrics-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const now = new Date().toISOString()
    const w1 = {
      id: 'w_metrics_1',
      type: 'anticipatory_alert',
      state: 'signal_detected',
      subject_kind: 'alert_event',
      subject_id: '',
      district: '',
      owner: '',
      created_at: now,
      updated_at: now,
      closed_at: null,
      transitions: [],
      metadata: {},
    }
    const w2 = {
      id: 'w_metrics_2',
      type: 'equity_audit_action',
      state: 'closed',
      subject_kind: 'alert_event',
      subject_id: '',
      district: '',
      owner: '',
      created_at: now,
      updated_at: now,
      closed_at: now,
      transitions: [],
      metadata: {},
    }
    await store.merge({ workflow_instances: [w1, w2] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/workflows/metrics`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.success)
      assert.ok(json.data.open >= 1)
      assert.ok(json.data.closed >= 1)
      assert.ok(json.data.by_type)
    } finally {
      listener.close()
    }
  })

  it('High-severity alert dispatch without prior approval returns 409', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-high-severity-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const now = new Date().toISOString()
    const alert = {
      id: 'alert_high_1',
      rule_id: 'rule_1',
      rule_name: 'High severity test',
      status: 'open',
      severity: 'high',
      metric: 'test.metric',
      value: 100,
      threshold: 50,
      operator: '>=',
      message: 'Test alert',
      actions: [],
      scope: { country: 'KE', district: 'turkana' },
      created_at: now,
      updated_at: now,
      suppression_bucket: 'b1',
      approval: { state: 'proposed' },
      metadata: {},
    }
    await store.merge({ alert_events: [alert] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/rapidpro/alert-events/${alert.id}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'test_operator' }),
      })
      assert.equal(res.status, 409)
      const json = await res.json()
      assert.equal(json.success, false)
    } finally {
      listener.close()
    }
  })

  it('Cold-chain-tagged asset appears in filtered service-assets response', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-coldchain-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const coldChainAsset = {
      id: 'asset_cc_1',
      name: 'Cold Chain Facility A',
      service_type: 'health',
      country: 'KE',
      latitude: 3.1,
      longitude: 35.6,
      metadata: { cold_chain: true },
    }
    const regularAsset = {
      id: 'asset_reg_1',
      name: 'Health Facility B',
      service_type: 'health',
      country: 'KE',
      latitude: 3.2,
      longitude: 35.7,
      metadata: {},
    }
    await store.merge({ service_assets: [coldChainAsset, regularAsset] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/service-assets?service_type=health`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.success)
      assert.ok(json.data.length >= 2)
      assert.ok(json.data.some((a) => a.id === 'asset_cc_1' && a.metadata?.cold_chain))
    } finally {
      listener.close()
    }
  })

  it('Signal-to-action timeline: assessments endpoint returns recent events and dispatches', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-signal-action-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const now = new Date().toISOString()
    const hazardEvent = {
      id: 'hazard_1',
      event_type: 'flood',
      severity: 'high',
      headline: 'Test flood',
      country: 'KE',
      latitude: 3.1,
      longitude: 35.6,
      observed_at: now,
    }
    const dispatch = {
      id: 'dispatch_1',
      alert_id: 'alert_1',
      flow_uuid: 'flow_1',
      urns: ['+254700000000'],
      status: 'sent',
      sent_at: now,
      created_at: now,
    }
    await store.merge({ hazard_events: [hazardEvent], rapidpro_dispatches: [dispatch] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const resAssess = await fetch(`${baseUrl}/api/v1/assessments`)
      assert.equal(resAssess.status, 200)
      const jsonAssess = await resAssess.json()
      assert.ok(jsonAssess.data && jsonAssess.data.recent_events)
      assert.ok(jsonAssess.data.recent_events.length >= 1)

      const resDispatches = await fetch(`${baseUrl}/api/v1/rapidpro/dispatches`)
      assert.equal(resDispatches.status, 200)
      const jsonDispatches = await resDispatches.json()
      assert.ok(jsonDispatches.data && jsonDispatches.data.length >= 1)
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite auth', () => {
  it('hasRole returns true when role:focal_point present', () => {
    const auth = { scopes: ['role:focal_point', 'read:hazards'] }
    assert.equal(hasRole(auth, 'focal_point'), true)
    assert.equal(hasRole(auth, 'operator'), false)
  })

  it('hasRole returns true for admin:* scope', () => {
    const auth = { scopes: ['admin:*'] }
    assert.equal(hasRole(auth, 'focal_point'), true)
    assert.equal(hasRole(auth, 'operator'), true)
  })

  it('hasRole returns false for null auth', () => {
    assert.equal(hasRole(null, 'focal_point'), false)
  })

  it('scopeToPartnerOrg filters records when partner_org set', () => {
    const records = [
      { id: 'r1', partner_org: 'org_a' },
      { id: 'r2', partner_org: 'org_b' },
      { id: 'r3' },
    ]
    const auth = { partner_org: 'org_a' }
    const filtered = scopeToPartnerOrg(records, auth)
    assert.equal(filtered.length, 2)
    assert.ok(filtered.some((r) => r.id === 'r1'))
    assert.ok(filtered.some((r) => r.id === 'r3'))
  })

  it('scopeToPartnerOrg returns all records when partner_org not set', () => {
    const records = [
      { id: 'r1', partner_org: 'org_a' },
      { id: 'r2', partner_org: 'org_b' },
    ]
    const auth = {}
    const filtered = scopeToPartnerOrg(records, auth)
    assert.equal(filtered.length, 2)
  })
})

describe('Lindela Lite i18n module', () => {
  it('t() translates with key lookups and interpolation', () => {
    const catalog = { greeting: 'Hi {name}', farewell: 'Goodbye' }
    assert.equal(t(catalog, 'greeting', { name: 'Alice' }), 'Hi Alice')
    assert.equal(t(catalog, 'farewell', {}), 'Goodbye')
    assert.equal(t(catalog, 'missing'), 'missing')
  })

  it('isRtl() returns true for Arabic', () => {
    assert.equal(isRtl('ar'), true)
    assert.equal(isRtl('en'), false)
    assert.equal(isRtl('sw'), false)
  })

  it('plainLanguage() simplifies long sentences and expands abbreviations', () => {
    const text = 'The SITREP shows a flood risk situation. GIS data confirms high impact.'
    const result = plainLanguage(text, { readingLevel: 'basic' })
    assert.ok(result.text.includes('situation report'))
    assert.ok(result.text.includes('geographic information system'))
    assert.ok(Array.isArray(result.notes))
  })
})

describe('Lindela Lite client UI', () => {
  it('GET / HTML contains id="dispatchGateDialog"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-client-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="dispatchGateDialog"'), 'dispatchGateDialog missing from HTML')
    } finally {
      listener.close()
    }
  })

  it('GET / HTML contains workflow ribbon overview', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-workflows-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="workflowOverview"'), 'workflow ribbon missing from HTML')
      assert.ok(html.includes('class="workflow-ribbon"'), 'workflow-ribbon class missing')
    } finally {
      listener.close()
    }
  })

  it('GET / HTML contains id="coldChainToggle"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-coldchain-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="coldChainToggle"'), 'coldChainToggle missing from HTML')
    } finally {
      listener.close()
    }
  })

  it('GET / HTML contains workflow-related elements', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-workflows-i18n-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="workflowMetricsGrid"'), 'workflow metrics grid missing')
    } finally {
      listener.close()
    }
  })

  it('GET / HTML contains equity panel elements', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-equity-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="panel-equity"'), 'equity panel missing')
      assert.ok(html.includes('id="equityTable"'), 'equity table missing')
      assert.ok(html.includes('data-i18n="tab.equity"'), 'tab.equity i18n missing')
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite CHW Mobile Web', () => {
  it('GET /chw returns 200 HTML with CHW title', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/chw`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Lindela CHW'))
      assert.ok(html.includes('class='), 'HTML elements missing')
      assert.ok(html.includes('data-i18n='), 'i18n attributes missing')
    } finally {
      listener.close()
    }
  })

  it('GET /chw/manifest.webmanifest returns 200', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-manifest-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/chw/manifest.webmanifest`)
      assert.equal(res.status, 200)
      const manifest = await res.json()
      assert.equal(manifest.name, 'Lindela CHW')
      assert.equal(manifest.start_url, '/chw/')
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/chw/report creates field_reports with PII redaction', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-report-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/chw/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'symptom',
          category: 'fever',
          description: 'High fever for 2 days',
          location: { latitude: 3.1, longitude: 35.6 },
          anonymous: true,
        }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.ok(json.success)
      assert.ok(json.data.id)
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/chw/reply creates inbound message', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-reply-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/chw/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          alert_event_id: 'alert_123',
          message: 'We received the alert and are responding',
        }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.ok(json.success)
      assert.ok(json.data.id)
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite Phase 1d - KPI, Equity, Community Feedback, CO Dashboard', () => {
  it('computeQuarterlyKpi on empty data returns object with data_gaps non-empty and people_reached 0', () => {
    const emptyData = {
      rapidpro_dispatches: [],
      field_reports: [],
      alert_events: [],
      hazard_events: [],
      interventions: [],
      workflow_instances: [],
      report_templates: [],
    }
    const kpi = computeQuarterlyKpi(emptyData, { quarter: 'Q3', year: 2026 })
    assert.equal(kpi.people_reached, 0)
    assert.ok(Array.isArray(kpi.data_gaps) && kpi.data_gaps.length > 0, 'data_gaps must be non-empty')
    assert.equal(kpi.period.quarter, 'Q3')
  })

  it('equityByDistrict on empty data returns empty array', () => {
    const result = equityByDistrict({ alert_events: [], rapidpro_dispatches: [] })
    assert.deepEqual(result, [])
  })

  it('detectAccuracyBreaches returns empty when no district meets minimum sample', () => {
    const data = {
      alert_events: [
        { id: 'a1', status: 'resolved', resolution_note: 'false positive', scope: { district: 'Turkana' } },
      ],
      rapidpro_dispatches: [{ id: 'd1', alert_event_id: 'a1' }],
    }
    // Only 1 dispatch, minimum is 5
    const breaches = detectAccuracyBreaches(data)
    assert.deepEqual(breaches, [])
  })

  it('createEquityAuditWorkflows is idempotent (second call returns empty)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-equity-'))
    const store = new JsonStore(path.join(dir, 'store.json'))

    // Create enough dispatches and false alerts to trigger breach
    const alertEvents = Array.from({ length: 6 }, (_, i) => ({
      id: `ae${i}`,
      status: 'resolved',
      resolution_note: 'false positive',
      scope: { district: 'TestDistrict' },
    }))
    const dispatches = alertEvents.map((ae) => ({ id: `d${ae.id}`, alert_event_id: ae.id }))
    const data = { alert_events: alertEvents, rapidpro_dispatches: dispatches, workflow_instances: [] }

    const ids1 = await createEquityAuditWorkflows(store, data)
    assert.ok(ids1.length >= 1, 'first call creates workflows')

    // Second call: read updated data from store
    const data2 = await store.read()
    const ids2 = await createEquityAuditWorkflows(store, data2)
    assert.equal(ids2.length, 0, 'second call is idempotent')
  })

  it('POST /api/v1/community-feedback creates a record and returns 201', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-feedback-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/community-feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          alert_event_id: 'ae-001',
          source: 'chw',
          reporter_urn: 'tel:+254700000001',
          sentiment: 'positive',
          message: 'Alert was accurate',
        }),
      })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.ok(body.success)
      assert.ok(body.data.id)
      assert.equal(body.data.source, 'chw')
      assert.equal(body.data.sentiment, 'positive')
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/community-feedback/summary returns array grouped by alert_event_id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-feedback-summary-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    // Pre-seed feedback
    await store.merge({
      community_feedback: [
        { id: 'f1', alert_event_id: 'ae-001', source: 'chw', sentiment: 'positive', message: 'ok', was_action_taken: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: {} },
        { id: 'f2', alert_event_id: 'ae-001', source: 'web', sentiment: 'negative', message: 'late', was_action_taken: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: {} },
        { id: 'f3', alert_event_id: 'ae-002', source: 'sms', sentiment: 'unclear', message: '?', was_action_taken: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: {} },
      ],
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/community-feedback/summary`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.data))
      const ae1 = body.data.find((r) => r.alert_event_id === 'ae-001')
      assert.ok(ae1, 'ae-001 group must exist')
      assert.equal(ae1.count, 2)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/kpi/quarterly?quarter=Q3&year=2026 returns 200 with period.quarter Q3', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-kpi-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/kpi/quarterly?quarter=Q3&year=2026`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.success)
      assert.equal(body.data.period.quarter, 'Q3')
      assert.equal(body.data.period.year, 2026)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/kpi/quarterly.pdf returns 200 with application/pdf content-type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-kpipdf-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/kpi/quarterly.pdf?quarter=Q3&year=2026`)
      assert.equal(res.status, 200)
      const ct = res.headers.get('content-type') || ''
      assert.ok(ct.includes('application/pdf') || ct.includes('text/html'), `Unexpected content-type: ${ct}`)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/equity/by-district returns 200 array', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-equity2-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/equity/by-district`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.data))
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/equity/scan returns 201 with created field', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-scan-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/equity/scan`, { method: 'POST' })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.ok(body.success)
      assert.ok('created' in body)
      assert.ok(Array.isArray(body.ids))
    } finally {
      listener.close()
    }
  })

  it('GET /co returns 200 HTML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-co-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/co`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Lindela CO Dashboard'))
      assert.ok(html.includes('class='), 'HTML must have class attributes')
    } finally {
      listener.close()
    }
  })

  it('GET /co/manifest.webmanifest returns 200', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-co-manifest-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/co/manifest.webmanifest`)
      assert.equal(res.status, 200)
      const manifest = await res.json()
      assert.equal(manifest.name, 'Lindela CO Dashboard')
      assert.equal(manifest.start_url, '/co/')
    } finally {
      listener.close()
    }
  })

  it('normalizeCommunityFeedback hashes reporter_urn (raw urn never appears in stored record)', () => {
    const rawUrn = 'tel:+254700000099'
    const record = normalizeCommunityFeedback({
      source: 'sms',
      reporter_urn: rawUrn,
      sentiment: 'positive',
      message: 'All good',
    })
    assert.ok(!JSON.stringify(record).includes(rawUrn), 'raw URN must not appear in record')
    assert.ok(record.reporter_urn_hash, 'reporter_urn_hash must be set')
    assert.ok(record.reporter_urn_hash.length <= 16, 'hash truncated to 16 chars')
    assert.ok(!('reporter_urn' in record), 'reporter_urn field must not exist on record')
  })
})

describe('Lindela Lite Partner Portal', () => {
  it('GET /portal returns 200 HTML with Portal title', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-portal-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/portal`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Lindela Partner Portal'))
      assert.ok(html.includes('class='), 'HTML elements missing')
    } finally {
      listener.close()
    }
  })

  it('GET /portal/manifest.webmanifest returns 200', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-portal-manifest-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/portal/manifest.webmanifest`)
      assert.equal(res.status, 200)
      const manifest = await res.json()
      assert.equal(manifest.name, 'Lindela Partner Portal')
      assert.equal(manifest.start_url, '/portal/')
    } finally {
      listener.close()
    }
  })

  it('scopeToPartnerOrg filters records by partner_org claim', () => {
    const records = [
      { id: '1', name: 'Asset A', partner_org: 'orgA' },
      { id: '2', name: 'Asset B', partner_org: 'orgB' },
      { id: '3', name: 'Asset C' },
    ]
    const auth = { partner_org: 'orgA' }
    const filtered = scopeToPartnerOrg(records, auth)
    assert.equal(filtered.length, 2)
    assert.ok(filtered.some((r) => r.id === '1'))
    assert.ok(filtered.some((r) => r.id === '3'))
    assert.ok(!filtered.some((r) => r.id === '2'))
  })

  it('scopeToPartnerOrg returns all records when no partner_org claim', () => {
    const records = [
      { id: '1', name: 'Asset A', partner_org: 'orgA' },
      { id: '2', name: 'Asset B', partner_org: 'orgB' },
    ]
    const auth = { partner_org: null }
    const filtered = scopeToPartnerOrg(records, auth)
    assert.equal(filtered.length, 2)
  })
})

// =============================================================
// Phase 2 tests
// =============================================================
import { normalizeParametricRule, simulateDisbursement, PARAMETRIC_CHAINS } from '../src/parametric.js'
import { parseSdnCsv, screenName } from '../src/sanctions.js'
import { dhis2Connector } from '../src/connectors/dhis2.js'
import { buildCreate } from '../src/operations.js'
import { computeApiUptime } from '../src/kpi.js'
import { uptimeStats } from '../src/observability.js'
import { sendRapidProAlert } from '../src/rapidpro.js'

describe('Lindela Lite routing', () => {
  const road = (id, name, roadClass, lat, lon) => ({
    id, name, service_type: 'road', country: 'KE', latitude: lat, longitude: lon, road_class: roadClass,
  })

  const chain = (statuses) => ({
    service_assets: [
      road('r-a', 'Depot', 'primary', 3.10, 35.60),
      road('r-b', 'Mid', 'primary', 3.127, 35.60),
      road('r-c', 'Clinic', 'tertiary', 3.154, 35.60),
    ],
    road_access: ['r-a', 'r-b', 'r-c'].map((roadId, i) => ({
      road_id: roadId,
      access_status: statuses[i],
      access_reason: statuses[i] === 'impassable' ? 'Blocked by flood (critical)' : null,
      primary_hazard_type: statuses[i] === 'impassable' ? 'flood' : null,
    })),
  })

  it('routes across a clear network and reports time and distance', () => {
    const result = shortestPath(buildRoadGraph(chain(['passable', 'passable', 'passable'])), 'r-a', 'r-c')
    assert.equal(result.feasible, true)
    assert.equal(result.mode, 'vehicle')
    assert.ok(result.total_minutes > 0)
    assert.ok(result.total_distance_km > 5)
    assert.equal(result.degraded, false)
    assert.equal(result.hops.length, 3)
  })

  it('severs the route when an intermediate segment is cut off', () => {
    // Regression: cost was derived from the better of the two roads, which let
    // a passable neighbour "rescue" an impassable node and the flooded road
    // stayed drivable.
    const graph = buildRoadGraph(chain(['passable', 'impassable', 'passable']))
    const result = shortestPath(graph, 'r-a', 'r-c')
    assert.equal(result.feasible, false)
    assert.match(result.reason, /severed/i)
    assert.equal(result.blocked_by, 'flood')
  })

  it('refuses to route to a destination that is itself cut off', () => {
    const graph = buildRoadGraph(chain(['passable', 'passable', 'impassable']))
    const result = shortestPath(graph, 'r-a', 'r-c')
    assert.equal(result.feasible, false)
    assert.match(result.reason, /impassable/i)
    assert.equal(result.blocked_by, 'flood')
  })

  it('still routes through a restricted segment but flags it as degraded', () => {
    const graph = buildRoadGraph(chain(['passable', 'restricted', 'passable']))
    const result = shortestPath(graph, 'r-a', 'r-c')
    assert.equal(result.feasible, true)
    assert.equal(result.degraded, true)
    assert.ok(result.restricted_hops > 0)
    assert.match(result.note, /lower bound/i)
  })

  it('charges more time for a restricted segment than for a clear one', () => {
    const clear = shortestPath(buildRoadGraph(chain(['passable', 'passable', 'passable'])), 'r-a', 'r-c')
    const restricted = shortestPath(buildRoadGraph(chain(['passable', 'restricted', 'passable'])), 'r-a', 'r-c')
    assert.ok(restricted.total_minutes > clear.total_minutes)
  })

  it('treats an all-track route as walking rather than drivable', () => {
    const data = {
      service_assets: [
        road('t-a', 'Track A', 'track', 3.10, 35.60),
        road('t-b', 'Track B', 'track', 3.127, 35.60),
      ],
      road_access: [
        { road_id: 't-a', access_status: 'passable' },
        { road_id: 't-b', access_status: 'passable' },
      ],
    }
    const result = shortestPath(buildRoadGraph(data), 't-a', 't-b')
    assert.equal(result.mode, 'foot')
    assert.equal(result.degraded, true)
  })

  it('reports partial coverage honestly instead of a success rate', () => {
    const data = chain(['passable', 'impassable', 'passable'])
    const plan = planDelivery(data, { from: 'r-a', to: ['r-c', 'r-a'] })
    assert.equal(plan.summary.destinations, 2)
    assert.equal(plan.summary.reachable, 1)
    assert.equal(plan.summary.unreachable, 1)
    assert.equal(plan.summary.coverage_pct, 50)
    assert.equal(plan.fully_deliverable, false)
    assert.match(plan.caveat, /alternative modality|cleared/i)
  })

  it('rejects unknown endpoints and missing arguments', () => {
    const graph = buildRoadGraph(chain(['passable', 'passable', 'passable']))
    assert.equal(shortestPath(graph, 'nope', 'r-c').feasible, false)
    assert.equal(shortestPath(graph, 'r-a', 'nope').feasible, false)
    assert.equal(planDelivery(chain(['passable']), {}).feasible, false)
  })
})

describe('Lindela Lite terrain and flood depth', () => {
  it('decodes a Terrarium tile into elevations and interpolates a point', async () => {
    // Verified against an independent decode of the same tile: 439-831 m.
    const tile = lonLatToTile(35.6, 3.1, 10)
    const decoded = await loadTile(tile.x, tile.y, 10)
    assert.equal(decoded.width, 256)
    assert.equal(decoded.height, 256)

    let min = Infinity
    let max = -Infinity
    let valid = 0
    for (const value of decoded.grid) {
      if (Number.isNaN(value)) continue
      valid += 1
      if (value < min) min = value
      if (value > max) max = value
    }
    assert.equal(valid, 65536)
    assert.ok(Math.abs(min - 439) < 2, `expected min ~439 m, got ${min}`)
    assert.ok(Math.abs(max - 831) < 2, `expected max ~831 m, got ${max}`)
    // Centre pixel must match the known value for this tile.
    assert.ok(Math.abs(decoded.grid[128 * 256 + 128] - 511) < 1)
  })

  it('maps slippy tile coordinates and their bounds consistently', () => {
    const tile = lonLatToTile(35.6, 3.1, 12)
    assert.equal(tile.z, 12)
    const bounds = tileBounds(tile.x, tile.y, 12)
    assert.ok(35.6 > bounds.west && 35.6 < bounds.east)
    assert.ok(3.1 > bounds.south && 3.1 < bounds.north)
  })

  it('reports depth at a point relative to the water surface', async () => {
    const result = await depthAtPoint(3.1, 35.6, 530)
    assert.equal(result.data_available, true)
    assert.ok(result.elevation_m > 400)
    assert.equal(Math.round(result.depth_m), Math.round(result.level_m - result.elevation_m))
    assert.equal(result.flooded, true)
    assert.equal(result.passability, 'impassable_severe')
  })

  it('reports a dry point below the water level rather than a negative depth', async () => {
    const result = await depthAtPoint(3.1, 35.6, 100)
    assert.equal(result.flooded, false)
    assert.equal(result.passability, 'dry')
    assert.ok(result.depth_m < 0)
  })

  it('refuses to invent depth where elevation data is void', async () => {
    // Middle of the Pacific: Terrarium has no bathymetry there, so the tile is
    // a no-data sentinel. Reporting "0 m level means -5126 m of water" would
    // read as catastrophic inundation rather than missing data.
    const result = await depthAtPoint(0, -160, 0)
    assert.equal(result.data_available, false)
    assert.equal(result.depth_m, null)
    assert.equal(result.flooded, null)
    assert.match(result.reason, /void|terrain data/i)
  })

  it('rejects implausible water levels', async () => {
    const tooLow = await depthAtPoint(3.1, 35.6, -9000)
    assert.equal(tooLow.data_available, false)
    assert.match(tooLow.reason, /floor/i)

    const tooHigh = await depthAtPoint(3.1, 35.6, 50000)
    assert.equal(tooHigh.data_available, false)
    assert.match(tooHigh.reason, /exceeds/i)
  })

  it('finds the onset level for a point from a level sweep', async () => {
    const profile = await depthProfile(3.1, 35.6, { levels_m: [100, 500, 515, 520, 540] })
    assert.equal(profile.inundated, true)
    assert.ok(profile.onset_level_m >= 515 && profile.onset_level_m <= 520)
  })

  it('classifies terrain as basin, slope, or flat from the surrounding window', async () => {
    const context = await terrainContext(3.1, 35.6)
    assert.equal(context.available, true)
    assert.ok(['basin', 'slope', 'undulating', 'flat'].includes(context.terrain))
    assert.ok(context.local_relief_m >= 0)
    assert.ok(context.surrounding_higher_pct >= 0 && context.surrounding_higher_pct <= 100)
  })

  it('builds a depth grid with per-level coverage and extent polygons', async () => {
    const grid = await depthGrid({
      south: 3.05, west: 35.55, north: 3.15, east: 35.65,
      levelM: [510, 520], gridSize: 16,
    })
    assert.equal(grid.size, 16)
    assert.equal(grid.depth_grid.length, 256)
    assert.equal(grid.per_level.length, 2)
    assert.ok(grid.coverage_pct > 0)
    // Coverage must increase as the water level rises.
    assert.ok(grid.per_level[1].coverage_pct > grid.per_level[0].coverage_pct)
    assert.equal(grid.extent_geojson.type, 'FeatureCollection')
    assert.ok(grid.extent_geojson.features.length > 0)
    // Must state its own limits rather than implying a hydraulic simulation.
    assert.match(grid.model, /no flow routing/i)
  })

  it('rejects degenerate bounds', async () => {
    await assert.rejects(
      () => depthGrid({ south: 3.2, west: 35.5, north: 3.1, east: 35.6, levelM: 510 }),
      /non-degenerate/,
    )
  })

  it('validates flood-depth request parameters over HTTP', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-flood-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      // No coordinates at all.
      const noCoords = await fetch(`${baseUrl}/api/v1/flood-depth?level_m=510`)
      assert.equal(noCoords.status, 400)
      assert.match((await noCoords.json()).error, /lat and lon/)

      // Coordinates but no water level.
      const noLevel = await fetch(`${baseUrl}/api/v1/flood-depth?lat=3.1&lon=35.6`)
      assert.equal(noLevel.status, 400)
      assert.match((await noLevel.json()).error, /level_m/)

      // Unparseable level must be reported, not silently defaulted to zero.
      const badLevel = await fetch(`${baseUrl}/api/v1/flood-depth?lat=3.1&lon=35.6&level_m=abc`)
      assert.equal(badLevel.status, 400)
      assert.match((await badLevel.json()).error, /number/)

      // Out-of-range level.
      const wildLevel = await fetch(`${baseUrl}/api/v1/flood-depth?lat=3.1&lon=35.6&level_m=99999`)
      assert.equal(wildLevel.status, 400)

      // A valid request succeeds.
      const ok = await fetch(`${baseUrl}/api/v1/flood-depth?lat=3.1&lon=35.6&level_m=520`)
      assert.equal(ok.status, 200)
      const body = await ok.json()
      assert.equal(body.success, true)
      assert.ok(Array.isArray(body.data.profile))
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite road access', () => {
  const baseData = () => ({
    service_assets: [
      { id: 'r-flooded', name: 'Turkana Road A', service_type: 'road', country: 'KE', latitude: 3.10, longitude: 35.60, road_class: 'unpaved' },
      { id: 'r-clear', name: 'Northern Bypass', service_type: 'road', country: 'KE', latitude: 3.10, longitude: 35.90, road_class: 'trunk' },
      { id: 'c-clinic', name: 'Lodwar Clinic', service_type: 'health', country: 'KE', latitude: 3.13, longitude: 35.63 },
    ],
    hazard_events: [
      { id: 'h-flood', event_type: 'flood', severity: 'critical', title: 'Flood on Road A', latitude: 3.10, longitude: 35.60 },
      // Earthquake is a precursor, not an obstruction.
      { id: 'h-eq', event_type: 'earthquake', severity: 'high', title: 'EQ', latitude: 3.10, longitude: 35.60 },
    ],
  })

  it('blocks a road under a hazard at the same location and leaves others passable', () => {
    const rows = computeRoadAccess(baseData())
    const flooded = rows.find((r) => r.road_id === 'r-flooded')
    const clear = rows.find((r) => r.road_id === 'r-clear')

    assert.equal(flooded.access_status, 'impassable')
    assert.match(flooded.access_reason, /flood/i)
    assert.equal(clear.access_status, 'passable')
    // Only roads get a row; health facilities are excluded.
    assert.equal(rows.length, 2)
  })

  it('matches a hazard bbox even when the hazard centre is far away', () => {
    const data = baseData()
    // A country-scale flood whose centroid is nowhere near the road, but whose
    // bbox covers it. Distance alone would have missed this.
    data.hazard_events = [{
      id: 'h-wide',
      event_type: 'flood',
      severity: 'high',
      title: 'Regional flood',
      latitude: 10.0,
      longitude: 40.0,
      bbox: { west: 35.0, south: 2.0, east: 36.5, north: 4.0 },
    }]
    const rows = computeRoadAccess(data)
    const flooded = rows.find((r) => r.road_id === 'r-flooded')
    assert.equal(flooded.access_status, 'impassable')
    assert.equal(flooded.obstructions[0].matched_by, 'bbox')
  })

  it('refuses to let an administrative-scale bbox block a distant road', async () => {
    // Live regression, 2026-10-01. A GDACS green flood alert for France arrived
    // with a bbox spanning ~40 degrees, and bbox containment marked every road
    // in the Horn of Africa "restricted" from an alert 2,000 km away. An
    // oversized box is an administrative extent, not a claim that the whole
    // area is under water.
    const data = baseData()
    data.hazard_events = [{
      id: 'h-france',
      event_type: 'flood',
      severity: 'low',
      title: 'Green flood alert in France',
      latitude: 19.82,
      longitude: 27.82,
      bbox: { west: 7.71, south: -0.29, east: 47.93, north: 39.93 },
    }]
    const rows = computeRoadAccess(data)
    for (const row of rows) {
      assert.equal(row.access_status, 'passable', `${row.road_id} was restricted by a 2,000 km distant alert`)
    }
  })

  it('rejects a coordinate pair where a road asset id is required', async () => {
    // Routing takes asset ids, not lat/lon. Silently accepting coordinates and
    // reporting "Unknown origin or destination road" is indistinguishable from
    // a broken router, so the failure has to name the actual problem.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-route-args-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    await store.merge({
      service_assets: [
        { id: 'r-a', name: 'Depot', service_type: 'road', country: 'KE', latitude: 3.10, longitude: 35.60, road_class: 'primary' },
        { id: 'r-b', name: 'Clinic', service_type: 'road', country: 'KE', latitude: 3.15, longitude: 35.61, road_class: 'tertiary' },
      ],
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/routing/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: { latitude: 3.10, longitude: 35.60 },
          to: [{ latitude: 3.15, longitude: 35.61 }],
        }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.match(body.error, /road asset id|asset id/i)
    } finally {
      listener.close()
    }
  })

  it('still blocks a road near the centre of an oversized bbox', () => {
    // The fix must not throw the hazard away: proximity to the reported centre
    // still applies, so a road genuinely inside the affected area is cut off.
    const data = baseData()
    data.hazard_events = [{
      id: 'h-big-local',
      event_type: 'flood',
      severity: 'critical',
      title: 'Flood with an oversized box but a local centre',
      latitude: data.service_assets[0].latitude,
      longitude: data.service_assets[0].longitude,
      bbox: { west: -20, south: -20, east: 40, north: 40 },
    }]
    const rows = computeRoadAccess(data)
    const flooded = rows.find((r) => r.road_id === 'r-flooded')
    assert.equal(flooded.access_status, 'impassable')
    assert.equal(flooded.obstructions[0].matched_by, 'proximity', 'must fall through to proximity matching')
  })

  it('accepts a hazard-scale bbox as authoritative even with a distant centre', () => {
    const data = baseData()
    // ~2 degrees across: a plausible flood plain, unlike an administrative box.
    data.hazard_events = [{
      id: 'h-hazard-scale',
      event_type: 'flood',
      severity: 'high',
      title: 'Flood over a river basin',
      latitude: 10.0,
      longitude: 40.0,
      bbox: { west: 35.0, south: 2.0, east: 36.5, north: 4.0 },
    }]
    const rows = computeRoadAccess(data)
    const flooded = rows.find((r) => r.road_id === 'r-flooded')
    assert.equal(flooded.obstructions[0].matched_by, 'bbox')
  })

  it('treats a road with no road_class as unpaved rather than assuming all-weather', () => {
    const data = baseData()
    delete data.service_assets[0].road_class
    const rows = computeRoadAccess(data)
    assert.equal(rows.find((r) => r.road_id === 'r-flooded').road_class, 'unpaved')
  })

  it('gives landslide a wider clearance radius than flood, as its physics differs', () => {
    // Debris flow travels beyond the mapped point more readily than standing
    // water does, so the same hazard distance that leaves a road passable for
    // flood makes it impassable for landslide. If this silently collapsed to one
    // shared radius, landslides would be routed around too early and flooded
    // roads driven into.
    const road = { id: 'probe', service_type: 'road', latitude: 3.0467, longitude: 35.69, road_class: 'unpaved', country: 'KE' }
    // ~4.8 km north: outside the 2 km flood radius, inside the 5 km landslide one.
    const hazardAt = (event_type) => ({ id: 'h', event_type, severity: 'high', latitude: 3.0897, longitude: 35.69 })
    const flooded = computeRoadAccess({ service_assets: [road], hazard_events: [hazardAt('flood')] })[0]
    const slid = computeRoadAccess({ service_assets: [road], hazard_events: [hazardAt('landslide')] })[0]

    assert.equal(flooded.access_status, 'passable', 'flood beyond its radius must not block')
    assert.equal(slid.access_status, 'impassable', 'landslide within its wider radius must block')
    assert.match(slid.access_reason, /landslide/i, 'the reason must name the hazard that blocked it')
  })

  it('classifies an event as a landslide only when the schema says so', async () => {
    // The distinction is not cosmetic: it selects the clearance radius. An event
    // typed as flood must not pick up the landslide radius and block roads that
    // are merely wet.
    const { ACCESS_BLOCKING_HAZARDS, HAZARD_EVENT_TYPES } = await import('../src/schema.js')
    assert.ok(HAZARD_EVENT_TYPES.includes('landslide'), 'landslide must be a first-class hazard type')
    assert.ok(ACCESS_BLOCKING_HAZARDS.includes('landslide'), 'a landslide across a road is an obstruction')
    assert.ok(!ACCESS_BLOCKING_HAZARDS.includes('earthquake'),
      'an earthquake is a precursor, not an obstruction, unless it has produced a slide or a flood')
  })

  it('weights an all-weather trunk route losing access above an unpaved track', () => {
    const data = baseData()
    data.hazard_events = [{ id: 'h1', event_type: 'landslide', severity: 'critical', title: 'S', latitude: 3.10, longitude: 35.60 }]
    const rows = computeRoadAccess(data)
    const unpavedScore = rows.find((r) => r.road_id === 'r-flooded').access_score

    data.service_assets[0].road_class = 'trunk'
    data.service_assets[0].latitude = 35.60
    const trunkRows = computeRoadAccess(data)
    const trunkScore = trunkRows.find((r) => r.road_id === 'r-flooded').access_score
    assert.ok(trunkScore > unpavedScore, `expected trunk criticality to raise the penalty: ${trunkScore} vs ${unpavedScore}`)
  })

  it('honours a field-reported closure even with no hazard in the model', () => {
    const data = baseData()
    data.hazard_events = []
    data.service_assets[0].passability = 'impassable'
    const rows = computeRoadAccess(data)
    const road = rows.find((r) => r.road_id === 'r-flooded')
    assert.equal(road.access_status, 'impassable')
    assert.match(road.access_reason, /field source/i)
  })

  it('summarises cut-off rate and hazard attribution', () => {
    const summary = summarizeRoadAccess(computeRoadAccess(baseData()))
    assert.equal(summary.total_roads, 2)
    assert.equal(summary.impassable, 1)
    assert.equal(summary.cut_off_rate_pct, 50)
    assert.equal(summary.blocked_by_hazard_type.flood, 1)
    assert.equal(summary.cut_off_roads.length, 1)
  })

  it('normalizes road attributes and rejects unknown enum values', () => {
    const road = normalizeServiceAsset(
      { name: 'R', service_type: 'road', country: 'KE', latitude: 1, longitude: 2, road_class: 'gravel', passability: 'blocked', width_m: 5 },
      0,
    )
    assert.equal(road.error, undefined)
    assert.equal(road.value.road_class, 'unpaved')
    assert.equal(road.value.passability, 'impassable')
    assert.equal(road.value.width_m, 5)

    // Road attributes must not leak onto non-road assets.
    const clinic = normalizeServiceAsset(
      { name: 'C', service_type: 'health', country: 'KE', latitude: 1, longitude: 2, road_class: 'trunk', passability: 'closed' },
      0,
    )
    assert.equal(clinic.value.road_class, null)
    assert.equal(clinic.value.passability, null)

    const bad = normalizeServiceAsset(
      { name: 'B', service_type: 'road', country: 'KE', latitude: 1, longitude: 2, road_class: 'floating' },
      0,
    )
    assert.match(bad.error, /road_class must be one of/)
  })

  it('does not report success for a source that returned no records', async () => {
    // Three connectors shipped reporting "success" while ingesting nothing.
    // The systemic cause was minimum_records: 0 on sources that are expected
    // to return records, so a zero result passed as healthy. Every regular
    // public source must now declare a floor.
    const { SOURCE_POLICIES, PUBLIC_INGESTION_SOURCES } = await import('../src/ingestion.js')
    for (const source of PUBLIC_INGESTION_SOURCES) {
      const policy = SOURCE_POLICIES[source]
      assert.ok(policy, `${source} must have a policy`)
      assert.ok(
        policy.minimum_records >= 1,
        `${source} must declare minimum_records >= 1 so an empty ingest is not reported as success`,
      )
    }
  })

  it('marks a run degraded when a source returns fewer records than its floor', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-minrecords-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    // glofas currently returns nothing upstream, so this exercises the real
    // path rather than a stubbed one.
    const { runIngestion, ingestionStatus } = await import('../src/ingestion.js')
    await runIngestion(store, { sources: ['glofas'], retries: 0, timeout_ms: 15000 })
    const status = ingestionStatus(await store.read()).find((s) => s.source === 'glofas')
    assert.notEqual(status.status, 'fresh', 'an empty ingest must not read as fresh')
    assert.match(JSON.stringify(status.last_run.errors || []), /Expected at least 1 records|not an RSS/)
  })

  it('does not hold user-supplied sources to a record floor', async () => {
    // Uploading an empty CSV is legitimate; an empty ingest of a live feed is
    // not. Flattening the two would make empty uploads look broken.
    const { SOURCE_POLICIES } = await import('../src/ingestion.js')
    for (const source of ['service_assets', 'conflict_csv', 'acled_csv', 'dhis2']) {
      assert.equal(SOURCE_POLICIES[source].minimum_records, 0, `${source} is user-supplied`)
      assert.equal(SOURCE_POLICIES[source].regular, false)
    }
  })

  it('reads namespaced RSS tags by local name', () => {
    const xml = '<item><gdacs:bbox>1 2 3 4</gdacs:bbox><ns:country>KE</ns:country><bbox>5 6 7 8</bbox></item>'
    assert.equal(readNamespacedTag(xml, 'bbox'), '1 2 3 4')
    assert.equal(readNamespacedTag(xml, 'country'), 'KE')
  })

  it('exposes road access over the API after an analytics refresh', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-road-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      service_assets: [
        { id: 'r1', name: 'Road A', service_type: 'road', country: 'KE', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
        { id: 'c1', name: 'Clinic', service_type: 'health', country: 'KE', latitude: 3.11, longitude: 35.61 },
      ],
      hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 3.1, longitude: 35.6 }],
    })
    const { refreshAnalytics } = await import('../src/analytics.js')
    await refreshAnalytics(store)

    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      const body = await fetchJson(`${baseUrl}/api/v1/road-access`)
      assert.equal(body.success, true)
      assert.equal(body.data.length, 1)
      assert.equal(body.data[0].access_status, 'impassable')
      assert.equal(body.summary.cut_off_rate_pct, 100)

      const summary = await fetchJson(`${baseUrl}/api/v1/road-access/summary`)
      assert.equal(summary.data.total_roads, 1)
      assert.equal(summary.data.impassable, 1)
    } finally {
      listener.close()
    }
  })

  it('ships the road status fields the map overlay renders', async () => {
    // renderRoadLayer reads these four fields directly; if the API stops
    // emitting one the overlay silently draws an unstyled or invisible marker.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-road-shape-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      service_assets: [
        { id: 'r1', name: 'Cut Road', service_type: 'road', country: 'KE', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
      ],
      hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 3.1, longitude: 35.6 }],
    })
    const { refreshAnalytics } = await import('../src/analytics.js')
    await refreshAnalytics(store)

    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      const body = await fetchJson(`${baseUrl}/api/v1/road-access`)
      const road = body.data[0]
      assert.equal(typeof road.latitude, 'number', 'overlay needs a plottable latitude')
      assert.equal(typeof road.longitude, 'number', 'overlay needs a plottable longitude')
      assert.equal(typeof road.access_status, 'string', 'overlay keys its class off access_status')
      assert.equal(typeof road.access_reason, 'string', 'overlay puts access_reason in the marker tooltip')
      // access_status must be one the stylesheet actually defines, otherwise the
      // marker renders with the default passable colour while reporting a cut.
      const css = await fs.readFile(path.join(process.cwd(), 'public/styles.css'), 'utf8')
      for (const status of new Set(body.data.map((r) => r.access_status))) {
        // Anchored on the brace: a `\b` after the name also matches inside
        // `.road-impassable-something`, which would hide a renamed class.
        assert.match(css, new RegExp(`\\.road-${status}\\s*\\{`), `styles.css must define .road-${status}`)
      }
    } finally {
      listener.close()
    }
  })

  it('survives a road with no coordinates without failing the overlay', async () => {
    // Fixtures and partial imports produce rows without geometry. The overlay
    // must skip those rather than draw NaN coordinates into the SVG.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-road-nogeom-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      service_assets: [
        { id: 'r1', name: 'Road A', service_type: 'road', country: 'KE', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
      ],
      hazard_events: [],
    })
    const { refreshAnalytics } = await import('../src/analytics.js')
    await refreshAnalytics(store)
    const access = computeRoadAccess(store.state?.service_assets || [], store.state?.hazard_events || [])
    assert.ok(Array.isArray(access))

    const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8')
    assert.match(
      app,
      /if \(!Number\.isFinite\(r\.latitude\) \|\| !Number\.isFinite\(r\.longitude\)\) continue/,
      'renderRoadLayer must skip rows without finite coordinates',
    )
  })
})

describe('Lindela Lite Phase 2 — Parametric, DHIS2, Demographics, Observability', () => {
  it('normalizeParametricRule rejects mainnet chain name with explicit error', () => {
    assert.throws(
      () => normalizeParametricRule({ name: 'Test', chain: 'ethereum' }),
      (err) => err.message.includes('testnet-only') && err.statusCode === 400
    )
  })

  it('normalizeParametricRule rejects ethereum-mainnet as a mainnet chain', () => {
    assert.throws(
      () => normalizeParametricRule({ name: 'Test', chain: 'ethereum-mainnet' }),
      (err) => err.message.includes('testnet-only')
    )
  })

  it('simulateDisbursement returns tx_hash with sim_ prefix', () => {
    const rule = normalizeParametricRule({ name: 'Flood', chain: 'ethereum-sepolia', requires_focal_point_approval: false })
    const result = simulateDisbursement(rule, { actor: 'test_actor' })
    assert.ok(result.simulated === true)
    assert.ok(result.tx_hash.startsWith('sim_'), `Expected sim_ prefix, got: ${result.tx_hash}`)
    assert.ok(result.disbursement_id)
    assert.equal(result.status, 'simulated')
  })

  it('simulateDisbursement throws 409 when focal_point_approval required but not approved', () => {
    const rule = normalizeParametricRule({ name: 'Protected', chain: 'celo-alfajores', requires_focal_point_approval: true })
    assert.throws(
      () => simulateDisbursement(rule, { focal_point_approved: false }),
      (err) => err.statusCode === 409
    )
  })

  it('simulateDisbursement throws 409 when sanctions screening blocks', () => {
    const rule = normalizeParametricRule({ name: 'Blocked', chain: 'ethereum-sepolia' })
    assert.throws(
      () => simulateDisbursement(rule, {
        sanctions: { screened: true, blocked: true, matches: [{ name: 'X', entry: { id: '1', name: 'X' } }] },
      }),
      (err) => err.statusCode === 409 && /sanctions/i.test(err.message)
    )
  })

  it('simulateDisbursement records screening outcome when it runs', () => {
    const rule = normalizeParametricRule({ name: 'Clean', chain: 'ethereum-sepolia' })
    const result = simulateDisbursement(rule, {
      sanctions: { screened: true, blocked: false, matches: [] },
    })
    assert.equal(result.sanctions_screened, true)
    assert.equal(result.sanctions_matches, 0)
  })

  it('rejects oversized request bodies with 413', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-body-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const big = JSON.stringify({
        title: 'Flood incident',
        description: 'x'.repeat(6 * 1024 * 1024),
      })
      const res = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: big,
      })
      assert.equal(res.status, 413)
      const body = await res.json()
      assert.match(body.error, /too large/i)
    } finally {
      listener.close()
    }
  })

  it('rejects malformed JSON bodies with 400', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-json-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"title": "unterminated',
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /valid JSON/i)
    } finally {
      listener.close()
    }
  })

  it('parses OFAC SDN CSV and normalizes names for screening', () => {
    const csv = [
      '36,"AEROCARIBBEAN AIRLINES",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
      '173,"ANGLO-CARIBBEAN CO., LTD.",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
      '13102,"MEMON, Ibrahim Abdul Razaaq","individual","SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"notes"',
    ].join('\n')

    const entries = parseSdnCsv(csv)
    assert.equal(entries.length, 3)
    // Comma inside a quoted name must not truncate the entity name.
    assert.equal(entries[1].name, 'ANGLO-CARIBBEAN CO., LTD.')
    assert.equal(entries[2].type, 'individual')

    const exact = screenName('AEROCARIBBEAN AIRLINES', entries)
    assert.equal(exact.matched, true)
    assert.equal(exact.reason, 'exact_normalized_match')

    // Corporate suffixes and punctuation must not defeat a match.
    assert.equal(screenName('Aerocaribbean Airlines, Inc.', entries).matched, true)
    assert.equal(screenName('  aerocaribbean   airlines  ', entries).matched, true)

    // Genuinely different names must not match.
    assert.equal(screenName('Turkana Water Committee', entries).matched, false)
    // Very short names are skipped rather than risk noisy matches.
    assert.equal(screenName('AB', entries).reason, 'name_too_short')
  })

  it('POST /api/v1/parametric-rules returns 201', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-parametric-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/parametric-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rain trigger', chain: 'polygon-mumbai', trigger_metric: 'precip_mm', trigger_threshold: 50 }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.ok(json.success)
      assert.equal(json.data.chain, 'polygon-mumbai')
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/parametric-rules/:id/simulate records a disbursement', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-sim-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      // Create a rule first
      const ruleRes = await fetch(`${baseUrl}/api/v1/parametric-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Sim rule', chain: 'celo-alfajores', requires_focal_point_approval: false }),
      })
      const ruleJson = await ruleRes.json()
      const ruleId = ruleJson.data.id

      // Simulate
      const simRes = await fetch(`${baseUrl}/api/v1/parametric-rules/${ruleId}/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focal_point_approved: false, actor: 'test_op' }),
      })
      assert.equal(simRes.status, 201)
      const simJson = await simRes.json()
      assert.ok(simJson.data.tx_hash.startsWith('sim_'))
      assert.equal(simJson.data.status, 'simulated')

      // Check disbursements list
      const listRes = await fetch(`${baseUrl}/api/v1/parametric-disbursements`)
      const listJson = await listRes.json()
      assert.equal(listJson.data.length, 1)
    } finally {
      listener.close()
    }
  })

  it('GET /parametric returns 200 HTML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-para-static-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/parametric`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Lindela Parametric'), `Expected Lindela Parametric title, got: ${html.slice(0, 200)}`)
    } finally {
      listener.close()
    }
  })

  it('GET /scenarios returns 200 HTML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-scenarios-static-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/scenarios`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Scenario Workbench'), `Expected Scenario Workbench in title, got: ${html.slice(0, 200)}`)
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/ingest/run with sources dhis2 returns errors about base_url when absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-dhis2-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/ingest/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['dhis2'] }),
      })
      assert.ok(res.status === 200 || res.status === 201)
      const json = await res.json()
      assert.ok(json.success)
      const run = json.source_runs?.find((r) => r.source === 'dhis2')
      assert.ok(run, 'Expected dhis2 source run in response')
      assert.ok(Array.isArray(run.errors) && run.errors.length > 0, 'Expected errors array with base_url message')
      assert.ok(run.errors[0].includes('base_url') || run.errors[0].includes('scaffold'), `Error message: ${run.errors[0]}`)
    } finally {
      listener.close()
    }
  })

  it('dhis2Connector spec.id equals dhis2', () => {
    assert.equal(dhis2Connector.id, 'dhis2')
  })

  it('normalizeFieldReport accepts demographics and preserves them', () => {
    const emptyData = { interventions: [], incidents: [] }
    const input = {
      incident_id: 'inc_001',
      summary: 'Test report',
      demographics: { age_band: 'u5', gender: 'female', pwd: false, refugee_or_idp: null },
    }
    const result = buildCreate('field_reports', input, emptyData)
    assert.ok(result.demographics, 'Expected demographics field')
    assert.equal(result.demographics.age_band, 'u5')
    assert.equal(result.demographics.gender, 'female')
    assert.equal(result.demographics.pwd, false)
  })

  it('normalizeFieldReport without demographics returns record unchanged (back-compat)', () => {
    const emptyData = { interventions: [], incidents: [] }
    const input = { incident_id: 'inc_002', summary: 'Legacy report' }
    const result = buildCreate('field_reports', input, emptyData)
    assert.ok(!('demographics' in result) || result.demographics == null, 'demographics should be absent or null for legacy reports')
  })

  it('computeQuarterlyKpi on field_reports with demographics returns non-null percent_children_u18', () => {
    const now = new Date().toISOString()
    const data = {
      rapidpro_dispatches: [],
      field_reports: [
        { id: 'r1', incident_id: 'i1', summary: 's', created_at: now, demographics: { age_band: 'u5', gender: 'female', pwd: false, refugee_or_idp: null } },
        { id: 'r2', incident_id: 'i1', summary: 's', created_at: now, demographics: { age_band: '18-59', gender: 'male', pwd: false, refugee_or_idp: null } },
      ],
      alert_events: [],
      hazard_events: [],
      interventions: [],
      workflow_instances: [],
      report_templates: [],
    }
    const quarter = new Date().getUTCMonth() < 3 ? 'Q1' : new Date().getUTCMonth() < 6 ? 'Q2' : new Date().getUTCMonth() < 9 ? 'Q3' : 'Q4'
    const year = new Date().getUTCFullYear()
    const result = computeQuarterlyKpi(data, { quarter, year: String(year) })
    assert.ok(result.percent_children_u18 !== null, 'percent_children_u18 should be non-null when demographics present')
    assert.equal(result.percent_children_u18, 50, 'One of two reports is u5 => 50%')
    assert.ok(result.demographics_coverage_pct !== null)
  })

  it('sendRapidProAlert stamps queued_at on dispatch record', async () => {
    const originalFetch = global.fetch
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"id":"mock"}',
    })
    const env = {
      RAPIDPRO_API_TOKEN: 'test_token_for_unit',
      RAPIDPRO_BASE_URL: 'https://mock.rapidpro.io',
      RAPIDPRO_ALERT_MODE: 'broadcast',
      RAPIDPRO_ALERT_URNS: '+254700000001',
    }
    try {
      const alert = { id: 'alert_test_01', rule_name: 'Test alert', severity: 'high', message: 'Test', metric: 'precip', value: 60, threshold: 50, operator: '>' }
      const dispatch = await sendRapidProAlert(alert, {}, env)
      assert.ok(dispatch.queued_at, 'dispatch.queued_at should be set')
      assert.ok(typeof dispatch.queued_at === 'string' && dispatch.queued_at.length > 0)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('computeApiUptime respects LINDELA_LITE_UPTIME_OVERRIDE', () => {
    const orig = process.env.LINDELA_LITE_UPTIME_OVERRIDE
    process.env.LINDELA_LITE_UPTIME_OVERRIDE = '97.5'
    try {
      assert.equal(computeApiUptime(), 97.5)
    } finally {
      if (orig === undefined) delete process.env.LINDELA_LITE_UPTIME_OVERRIDE
      else process.env.LINDELA_LITE_UPTIME_OVERRIDE = orig
    }
  })

  it('uptimeStats returns uptime_seconds as a positive number', () => {
    const stats = uptimeStats()
    assert.ok(typeof stats.uptime_seconds === 'number', 'uptime_seconds should be a number')
    assert.ok(stats.uptime_seconds >= 0, 'uptime_seconds should be non-negative')
    assert.ok(stats.started_at, 'started_at should be set')
  })

  it('GET /shared/navbar.js returns 200 text/javascript', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-navbar-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/shared/navbar.js`)
      assert.equal(res.status, 200)
      const ct = res.headers.get('content-type') || ''
      assert.ok(ct.includes('javascript'), `Expected content-type javascript, got: ${ct}`)
    } finally {
      listener.close()
    }
  })

  it('every sub-surface HTML contains mountNavbar import', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-navbar-check-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    const surfaces = ['/focal-point', '/chw', '/portal', '/co', '/scenarios', '/parametric']
    try {
      for (const surface of surfaces) {
        const res = await fetch(`${baseUrl}${surface}`)
        assert.equal(res.status, 200, `${surface} should return 200`)
        const html = await res.text()
        // The requirement is that the surface mounts the shared navbar. Where
        // that happens is an implementation detail: /chw mounts it from its
        // app.js while the rest mount it inline, and asserting the HTML alone
        // made the test fail a correct surface over a choice with no user
        // consequence. Either source satisfies it; neither does not.
        const script = await (await fetch(`${baseUrl}${surface.replace(/\/$/, '')}/app.js`)).text()
        assert.ok(
          html.includes("from '/shared/navbar.js'") || script.includes("from '/shared/navbar.js'"),
          `${surface} must mount /shared/navbar.js from its HTML or its script`
        )
      }
    } finally {
      listener.close()
    }
  })
})

describe('Demo seed', () => {
  it('seedAll populates at least 12 non-empty collections in a temp store', async () => {
    const { seedAll, summary } = await import('../scripts/seed-demo.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-demo-seed-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await seedAll(store)
    const counts = await summary(store)
    const nonEmpty = Object.values(counts).filter(n => n > 0).length
    assert.ok(nonEmpty >= 12, `Expected at least 12 non-empty collections, got ${nonEmpty}: ${JSON.stringify(counts)}`)
    assert.ok(counts.field_reports >= 30, `field_reports ${counts.field_reports} < 30`)
    assert.ok(counts.workflow_instances >= 10, `workflow_instances ${counts.workflow_instances} < 10`)
    assert.ok(counts.alert_events >= 5, `alert_events ${counts.alert_events} < 5`)
    assert.ok(counts.trigger_protocols >= 5, `trigger_protocols ${counts.trigger_protocols} < 5`)
  })

  it('every count the demo guide states matches the seeded store', async () => {
    // validate.mjs only checks that the guide *mentions* these numbers, so a
    // number could be wrong as long as it was written down. This compares each
    // one against the data a panel will actually be looking at. The guide drifted
    // three times before this existed, once because I widened the risk surface
    // and twice because figures were simply wrong.
    const { seedAll } = await import('../scripts/seed-demo.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-guide-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await seedAll(store)
    const data = await store.read()
    const guide = await fs.readFile('docs/demo-guide.md', 'utf8')

    const claims = [
      { phrase: 'active alert rules', stated: 5, actual: data.alert_rules?.length, name: 'alert_rules' },
      { phrase: 'alert events spanning', stated: 10, actual: data.alert_events?.length, name: 'alert_events' },
      { phrase: 'trigger protocols with backtest', stated: 10, actual: data.trigger_protocols?.length, name: 'trigger_protocols' },
      { phrase: 'incidents covering', stated: 8, actual: data.incidents?.length, name: 'incidents' },
      { phrase: 'field reports with demographics', stated: 40, actual: data.field_reports?.length, name: 'field_reports' },
      { phrase: 'feedback items linked', stated: 15, actual: data.community_feedback?.length, name: 'community_feedback' },
      { phrase: 'community_feedback_loop instances', stated: 2, actual: (data.workflow_instances || []).filter((w) => w.type === 'community_feedback_loop').length, name: 'community_feedback_loop' },
    ]

    const wrong = []
    for (const { phrase, stated, actual, name } of claims) {
      const found = new RegExp(`\\b${stated}\\b`).test(
        guide.split('\n').filter((l) => l.includes(phrase)).join(' '),
      )
      assert.ok(found, `demo guide no longer states ${stated} for "${phrase}"`)
      if (actual !== stated) wrong.push(`${name}: guide says ${stated}, store has ${actual}`)
    }
    assert.deepEqual(wrong, [], `demo guide contradicts the seeded store -> ${wrong.join('; ')}`)
  })

  it('seeds a connected road corridor so routing has a network to route over', async () => {
    // The four district roads sit hundreds of km apart, so buildRoadGraph links
    // them at the 5 km default radius and the graph comes out with no edges.
    // Routing then reports every destination unreachable for want of a network,
    // which reads as a broken router rather than missing demo data.
    const { seedAll } = await import('../scripts/seed-demo.mjs')
    const { refreshAnalytics } = await import('../src/analytics.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-demo-corridor-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await seedAll(store)
    await refreshAnalytics(store)
    const data = await store.read()

    assert.ok(data.hazard_events.length > 0, 'the seed must include a hazard so access can be obstructed')

    const graph = buildRoadGraph(data)
    const links = [...graph.adjacency.values()].reduce((sum, list) => sum + list.length, 0) / 2
    assert.ok(links >= 2, `expected a connected demo network, got ${links} links across ${graph.nodes.size} roads`)

    // The seeded hazards must actually sever their segments while leaving a
    // bypass, otherwise the walkthrough has nothing to demonstrate. Both
    // access-blocking types are seeded: a flood on the corridor the routing
    // demo reroutes around, and a landslide on the supply route. Asserting the
    // type as well as the status is the point — a landslide that regressed into
    // passing would still leave two blocked segments and pass a count-only check.
    const rows = new Map(data.road_access.map((r) => [r.road_name, r]))
    const blocked = [...rows.values()].filter((r) => r.access_status === 'impassable')
    assert.equal(blocked.length, 2, `expected two impassable segments, got ${blocked.length}`)

    const blockedByType = blocked.map((r) => {
      assert.match(r.access_reason, /Blocked by (flood|landslide)/i,
        `an impassable segment must name what blocked it: ${r.access_reason}`)
      return /Blocked by (flood|landslide)/i.exec(r.access_reason)[1].toLowerCase()
    }).sort()
    assert.deepEqual(blockedByType, ['flood', 'landslide'],
      'one segment must be cut by flood and one by landslide, so both models are demonstrable')

    const nodes = [...graph.nodes.values()]
    const depot = nodes.find((n) => /depot/i.test(n.name))
    const clinic = nodes.find((n) => /clinic approach/i.test(n.name))
    assert.ok(depot && clinic, 'the corridor must have a depot and a clinic approach')

    const route = shortestPath(graph, depot.id, clinic.id)
    assert.equal(route.feasible, true, `expected a feasible detour, got: ${route.reason}`)
    assert.ok(
      route.hops.some((h) => /bypass/i.test(h.name)),
      `route should use the plateau bypass, got ${route.hops.map((h) => h.name).join(' -> ')}`,
    )
    assert.ok(
      !route.hops.some((h) => /floodplain/i.test(h.name)),
      'the route must not include the flooded segment',
    )
  })

  it('seeds demo hazards as explicitly labelled demo data', async () => {
    // Demo hazards are authored, not observed. They must not be mistakable for
    // live GDACS observations in a panel demo.
    const { seedAll } = await import('../scripts/seed-demo.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-demo-hazard-label-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await seedAll(store)
    const data = await store.read()
    for (const hazard of data.hazard_events) {
      assert.equal(hazard.source, 'demo_seed')
      assert.equal(hazard.metadata.demo_data, true)
      assert.match(hazard.description, /not a live observation/i)
    }
  })

  it('reports a degraded source as degraded in the seed summary', async () => {
    // runIngestion does not throw for a degraded source, so the seed used to
    // label every source "ok" regardless. Two broken sources looked healthy in
    // the demo output because of this.
    const { ingestPublicSources } = await import('../scripts/seed-demo.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-demo-status-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const results = await ingestPublicSources(store, { sources: ['glofas'] })
    assert.ok(results.glofas, 'the requested source must appear in the summary')
    assert.notEqual(results.glofas.status, 'ok', 'glofas returns nothing upstream and must not read as ok')
    assert.equal(results.glofas.status, 'degraded')
  })

  it('skips the two unavailable sources unless they are asked for explicitly', async () => {
    const { ingestPublicSources } = await import('../scripts/seed-demo.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-demo-skip-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const results = await ingestPublicSources(store, { sources: ['nasa_firms'] })
    // Asking for it runs it, so the failure is visible rather than hidden.
    assert.ok(results.nasa_firms, 'an explicit request must be honoured')
    assert.equal(results.nasa_firms.status, 'degraded')
  })

  it('POST /api/v1/demo/seed returns 200 with counts.field_reports >= 30 and counts.workflow_instances >= 10', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-demo-endpoint-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/demo/seed`, { method: 'POST' })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.success, 'success should be true')
      assert.ok(body.counts.field_reports >= 30, `field_reports ${body.counts.field_reports} < 30`)
      assert.ok(body.counts.workflow_instances >= 10, `workflow_instances ${body.counts.workflow_instances} < 10`)
    } finally {
      listener.close()
    }
  })
})

import { KNOWN_DISTRICTS, resolveDistrict, districtOverview } from '../src/districts.js'
import { computeMonthlyKpiSeries, computeSparklineData, refreshKpiSnapshots } from '../src/kpi.js'
import { resolveReportContext, buildReportWarnings, formatReportSmsSummary, renderReportMarkdown } from '../src/reports.js'
import { filterRecords } from '../src/utils.js'

describe('Lindela Lite districts API', () => {
  async function makeServer() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-districts-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`
    return { listener, baseUrl, store }
  }

  it('GET /api/v1/districts returns 200 with data.length === 5', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/api/v1/districts`)
      assert.equal(res.status, 200)
      const { data } = await res.json()
      assert.equal(data.length, 5)
    } finally { listener.close() }
  })

  it('reaches coordinate-less records through their parents', async () => {
    // Interventions, tasks and dispatches carry no coordinates and no district
    // field. Filtering them by proximity matched nothing, so every district
    // reported 0 interventions, 0 tasks and 0 people reached while the records
    // existed. A district overview reporting "no activity" when activity is
    // attached to it reads as a finding rather than a bug.
    const { listener, baseUrl, store } = await makeServer()
    try {
      await store.merge({
        service_assets: [{ id: 'a1', name: 'Kakuma HC', service_type: 'health', country: 'KE', admin1: 'Turkana', latitude: 3.11, longitude: 35.60 }],
        incidents: [{ id: 'inc-1', title: 'Flood', country: 'KE', admin1: 'Turkana', latitude: 3.10, longitude: 35.60, status: 'responding', severity: 'high' }],
        interventions: [{ id: 'int-1', incident_id: 'inc-1', title: 'Reroute supplies', status: 'active' }],
        intervention_tasks: [{ id: 'task-1', intervention_id: 'int-1', incident_id: 'inc-1', title: 'Confirm bypass', status: 'todo' }],
        alert_events: [{ id: 'ae-1', source: 'open_meteo', metric: 'precipitation_mm', value: 52, status: 'open', severity: 'high', scope: { district: 'Turkana' } }],
        rapidpro_dispatches: [{ id: 'dp-1', alert_event_id: 'ae-1', status: 'sent', recipients_count: 1234, sent_at: new Date().toISOString(), matched_signal_at: new Date(Date.now() - 3600000).toISOString() }],
      })

      const { data } = await fetch(`${baseUrl}/api/v1/districts/turkana`).then((r) => r.json())
      assert.equal(data.counts.interventions, 1, 'intervention is reachable through its incident')
      assert.equal(data.counts.tasks, 1, 'task is reachable through its intervention')
      assert.equal(data.kpi_snapshot.people_reached, 1234, 'dispatch is reachable through its alert event')

      // A district with none of this must report zero, not borrow a neighbour's.
      const { data: other } = await fetch(`${baseUrl}/api/v1/districts/mandera`).then((r) => r.json())
      assert.equal(other.counts.interventions, 0)
      assert.equal(other.counts.tasks, 0)
      assert.equal(other.kpi_snapshot.people_reached, 0)
    } finally { listener.close() }
  })

  it('does not count more parent-linked records than exist', async () => {
    // Parent-derived matching must not inflate totals beyond the records that
    // exist, which a naive union across districts would.
    const { listener, baseUrl } = await makeServer()
    try {
      const slugs = ['turkana', 'aweil', 'bor', 'karamoja', 'mandera']
      let counted = 0
      for (const slug of slugs) {
        const { data } = await fetch(`${baseUrl}/api/v1/districts/${slug}`).then((r) => r.json())
        counted += data.counts.interventions
      }
      const { data: all } = await fetch(`${baseUrl}/api/v1/interventions`).then((r) => r.json())
      assert.ok(
        counted <= all.length,
        `district views counted ${counted} interventions but only ${all.length} exist`,
      )
    } finally { listener.close() }
  })

  it('GET /api/v1/districts/turkana returns 200 with data.district.name === Turkana', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/api/v1/districts/turkana`)
      assert.equal(res.status, 200)
      const { data } = await res.json()
      assert.equal(data.district.name, 'Turkana')
    } finally { listener.close() }
  })

  it('GET /api/v1/districts/karamoja and /moroto resolve to the same district', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${baseUrl}/api/v1/districts/karamoja`).then(r => r.json()),
        fetch(`${baseUrl}/api/v1/districts/moroto`).then(r => r.json()),
      ])
      assert.equal(r1.data.district.slug, 'karamoja')
      assert.equal(r2.data.district.slug, 'karamoja')
      assert.equal(r1.data.district.name, r2.data.district.name)
    } finally { listener.close() }
  })

  it('GET /api/v1/districts/unknown returns 404', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/api/v1/districts/unknown-xyz`)
      assert.equal(res.status, 404)
    } finally { listener.close() }
  })

  it('GET /districts returns 200 HTML', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/districts`)
      assert.equal(res.status, 200)
      const ct = res.headers.get('content-type') || ''
      assert.ok(ct.includes('text/html'), `expected html, got ${ct}`)
    } finally { listener.close() }
  })

  it('GET /districts/manifest.webmanifest returns 200', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/districts/manifest.webmanifest`)
      assert.equal(res.status, 200)
    } finally { listener.close() }
  })

  it('resolveDistrict accepts moroto synonym', () => {
    const d = resolveDistrict('moroto')
    assert.ok(d, 'should resolve')
    assert.equal(d.slug, 'karamoja')
  })

  it('districtOverview returns null for unknown slug', () => {
    const result = districtOverview({}, 'nowhere')
    assert.equal(result, null)
  })
})

describe('Lindela Lite KPI monthly series', () => {
  it('computeMonthlyKpiSeries on empty data returns array with monthsBack entries', () => {
    const series = computeMonthlyKpiSeries({}, { monthsBack: 12 })
    assert.equal(series.length, 12)
    assert.equal(series[0].people_reached, 0)
  })

  it('computeSparklineData extracts oldest-first numeric array', () => {
    const series = [
      { month: '2026-08', people_reached: 10 },
      { month: '2026-07', people_reached: 5 },
    ]
    const vals = computeSparklineData(series, 'people_reached')
    assert.deepEqual(vals, [5, 10])
  })

  it('GET /api/v1/kpi/monthly-series returns 200 with data.length >= 6', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-kpi-series-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/kpi/monthly-series`)
      assert.equal(res.status, 200)
      const { data } = await res.json()
      assert.ok(Array.isArray(data) && data.length >= 6, `expected >=6 months, got ${data?.length}`)
    } finally { listener.close() }
  })

  it('POST /api/v1/kpi/refresh-snapshots then GET /api/v1/kpi/snapshots returns non-empty array', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-kpi-snap-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`
    try {
      const postRes = await fetch(`${baseUrl}/api/v1/kpi/refresh-snapshots`, { method: 'POST' })
      assert.equal(postRes.status, 200)
      const getRes = await fetch(`${baseUrl}/api/v1/kpi/snapshots`)
      assert.equal(getRes.status, 200)
      const { data } = await getRes.json()
      assert.ok(Array.isArray(data) && data.length > 0, 'snapshots should be non-empty after refresh')
    } finally { listener.close() }
  })
})

function rapidProEnv() {
  return {
    RAPIDPRO_API_TOKEN: process.env.RAPIDPRO_API_TOKEN,
    RAPIDPRO_BASE_URL: process.env.RAPIDPRO_BASE_URL,
    RAPIDPRO_ALERT_FLOW_UUID: process.env.RAPIDPRO_ALERT_FLOW_UUID,
    RAPIDPRO_ALERT_MODE: process.env.RAPIDPRO_ALERT_MODE,
    RAPIDPRO_ALERT_URNS: process.env.RAPIDPRO_ALERT_URNS,
    RAPIDPRO_ALERT_CONTACTS: process.env.RAPIDPRO_ALERT_CONTACTS,
    RAPIDPRO_ALERT_GROUPS: process.env.RAPIDPRO_ALERT_GROUPS,
    RAPIDPRO_WEBHOOK_SECRET: process.env.RAPIDPRO_WEBHOOK_SECRET,
  }
}

function restoreRapidProEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('Lindela Lite bbox queries and map event sourcing', () => {
  const box = (v) => new URLSearchParams(v)

  it('asks for the operational area as west,south,east,north, not minLat order', async () => {
    // The internal bbox objects are minLat/minLon; the API takes
    // west,south,east,north. Sending the internal order produces a valid-looking
    // query that matches nothing, which is how the map ended up drawing only
    // Pacific earthquakes and no local hazards while reporting no error.
    const { localEventQuery, REGION_OF_INTEREST } = await import('../public/shared/map-frame.js')
    const q = new URL(localEventQuery(REGION_OF_INTEREST, 0), 'http://x')
    const [west, south, east, north] = q.searchParams.get('bbox').split(',').map(Number)

    assert.ok(west < east, 'west must be less than east')
    assert.ok(south < north, 'south must be less than north')
    assert.equal(west, REGION_OF_INTEREST.minLon)
    assert.equal(south, REGION_OF_INTEREST.minLat)
    assert.equal(east, REGION_OF_INTEREST.maxLon)
    assert.equal(north, REGION_OF_INTEREST.maxLat)
  })

  it('includes a hazard the source reported only as an area overlapping the box', async () => {
    // GDACS reports most events as a box, and the connector withholds a point
    // when the box is regional. Filtering on points alone told a caller asking
    // "what is in this district" that nothing was there, for hazards the source
    // had explicitly placed there.
    const { filterRecords } = await import('../src/utils.js')
    const regional = {
      // A regional box over the pilot area, reported without a point.
      id: 'gd-1', event_type: 'flood', country: 'SS',
      latitude: null, longitude: null,
      bbox: { west: 24, south: 5, east: 36, north: 15 },
    }
    const elsewhere = { ...regional, id: 'gd-2', bbox: { west: -60, south: -30, east: -40, north: -10 } }
    const hits = filterRecords([regional, elsewhere], box('bbox=24,-9,55,18'))

    assert.equal(hits.length, 1, 'an overlapping reported area must be returned')
    assert.equal(hits[0].id, 'gd-1')
  })

  it('still returns a point event inside the box and drops one outside it', async () => {
    const { filterRecords } = await import('../src/utils.js')
    const inside = { id: 'in', latitude: 3.05, longitude: 35.69 }
    const outside = { id: 'out', latitude: 48.8, longitude: 2.4 }
    const hits = filterRecords([inside, outside], box('bbox=24,-9,55,18'))
    assert.deepEqual(hits.map((h) => h.id), ['in'])
  })

  it('merges the local and global event sets without duplicating an event', async () => {
    // The local set is fetched first so that when the same event arrives in both
    // it is the locally-scoped copy that survives.
    const { mergeEventSets } = await import('../public/shared/map-frame.js')
    const local = [{ id: 'a', note: 'local' }, { id: 'b' }]
    const global_ = [{ id: 'b', note: 'global' }, { id: 'c' }]
    const merged = mergeEventSets(local, global_)
    assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c'])
    assert.equal(merged[1].note, undefined, 'the local copy must win over the global one')
  })
})

describe('Lindela Lite flood share wording', () => {
  it('reports the surveyed box a share refers to, not a district', async () => {
    // The share is a fraction of surveyed grid cells. Labelling it "of the area"
    // next to a district name invited reading "40% of Turkana is underwater",
    // which is a different and far larger claim than the flooded footprint.
    const { surveyedAreaKm2 } = await import('../public/shared/flood-bands.js')

    const equator = surveyedAreaKm2({ south: 0, west: 0, north: 1, east: 1 })
    assert.ok(Math.abs(equator - 12300) < 60, `1x1 degree at the equator is ~12300 km2, got ${equator}`)

    // Converging meridians: the same longitude span covers less ground further
    // from the equator, so using a single flat width would misstate the box.
    const near = surveyedAreaKm2({ south: 3, west: 35, north: 4, east: 36 })
    const far = surveyedAreaKm2({ south: 33, west: 35, north: 34, east: 36 })
    assert.ok(near > far, 'a degree of longitude must cover less ground further from the equator')
    assert.equal(surveyedAreaKm2(null), null)
    assert.equal(surveyedAreaKm2({ south: 0, west: 0, north: 1 }), null, 'a partial box has no area')
  })
})

describe('Lindela Lite build version', () => {
  it('serves the version from package.json', async () => {
    // The footers used to hardcode v0.1.0 in two HTML files and one translation
    // file while the package was at 0.2.0, so a panel asking which build this is
    // would have been told the wrong one.
    const { APP_VERSION } = await import('../src/server.js')
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'))
    assert.equal(APP_VERSION, pkg.version)
    assert.match(APP_VERSION, /^\d+\.\d+\.\d+/, `version must look like a version, got "${APP_VERSION}"`)
  })

  it('reports it on the health endpoint so a client can display it', async () => {
    const { APP_VERSION, createServer } = await import('../src/server.js')
    const { JsonStore } = await import('../src/store.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-version-'))
    const server = createServer({ store: new JsonStore(path.join(dir, 'store.json')) })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      const body = await (await fetch(`${baseUrl}/api/v1/health`)).json()
      assert.equal(body.version, APP_VERSION)
      assert.match(body.version, /^\d+\.\d+\.\d+/)
    } finally {
      await new Promise((r) => listener.close(r))
    }
  })

  it('keeps every version literal in the UI in a sanctioned slot', async () => {
    // Two rules, both learned the hard way:
    //  - A version literal in HTML must sit inside a data-app-version element,
    //    which is the one offline fallback we allow and which gets overwritten
    //    from the health endpoint at runtime.
    //  - A locale file must contain no version literal at all. A build fact in a
    //    translation file is what drifted in the first place: three copies of an
    //    older release, in two languages' worth of markup, all wrong at once.
    const offenders = []

    for (const dir of ['public']) {
      const stack = [dir]
      while (stack.length) {
        const cur = stack.pop()
        for (const entry of await fs.readdir(cur, { withFileTypes: true })) {
          const full = `${cur}/${entry.name}`
          if (entry.isDirectory()) { stack.push(full); continue }
          const text = await fs.readFile(full, 'utf8')

          if (full.endsWith('.html')) {
            for (const m of text.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)) {
              const start = Math.max(0, m.index - 120)
              const around = text.slice(start, m.index + m[0].length)
              const inSlot = /data-app-version[^>]*>[^<]*$/.test(around)
              if (!inSlot) offenders.push(`${full}: v${m[1]} outside a data-app-version slot`)
            }
          }

          if (full.includes('i18n/') && full.endsWith('.json')) {
            const locale = JSON.parse(text)
            for (const [k, v] of Object.entries(locale)) {
              if (typeof v === 'string' && /\bv?\d+\.\d+\.\d+\b/.test(v)) {
                offenders.push(`${full}: "${k}" carries a version, which is not translatable`)
              }
            }
          }
        }
      }
    }

    assert.deepEqual(offenders, [], `version drift -> ${offenders.join('; ')}`)
  })
})

describe('Lindela Lite README source list', () => {
  it('lists every source the API advertises, and claims no source that does not exist', async () => {
    // The README listed 8 of 11 sources, omitting usgs_earthquake, noaa_enso and
    // dhis2. A reader would conclude the earthquake and ENSO connectors were not
    // part of the build, which is the opposite of true.
    const readme = await fs.readFile('README.md', 'utf8')
    const table = readme.slice(readme.indexOf('## Sources'), readme.indexOf('## Operations'))
    const listed = new Set([...table.matchAll(/^\| `([a-z0-9_]+)`/gm)].map((m) => m[1]))
    assert.ok(listed.size >= 8, `expected the README to table the sources, found ${listed.size}`)

    const { publicSourceCatalog } = await import('../src/schema.js')
    const actual = publicSourceCatalog().map((s) => s.id)

    const missing = actual.filter((id) => !listed.has(id))
    const phantom = [...listed].filter((id) => !actual.includes(id))
    assert.deepEqual(missing, [], `sources the API offers but the README omits: ${missing.join(', ')}`)
    assert.deepEqual(phantom, [], `sources the README lists that the API does not offer: ${phantom.join(', ')}`)
  })

  it('does not claim to lack a capability the build actually has', async () => {
    // The README and docs/operations.md both said Lite does not include "report
    // distribution" while the Reports rail can generate, distribute and export,
    // and every distribution is recorded as a run. A false "does not do" is the
    // most expensive kind of README line: it understates what a panel can see.
    for (const file of ['README.md', 'docs/operations.md']) {
      const text = await fs.readFile(file, 'utf8')
      // Scoped to the absence clause only, up to the first full stop. A line may
      // legitimately correct itself in the next sentence, and that correction
      // must not read as the claim it is correcting.
      const absence = text.split('\n')
        .map((line) => (line.match(/does not (?:include|provide|support)[^.]*/i) || [])[0])
        .filter(Boolean)
      for (const clause of absence) {
        assert.ok(!/report[- ]distribution/i.test(clause),
          `${file} claims report distribution is absent: ${clause.trim().slice(0, 90)}`)
      }
    }
  })
})

describe('Lindela Lite OpenAPI contract', () => {
  it('documents every field the health endpoint returns', async () => {
    // The health payload gained `version` and the contract was not updated, so
    // the published API described a response that no longer existed. validate.mjs
    // checks the document parses; it cannot know the document is behind.
    const { createServer } = await import('../src/server.js')
    const { JsonStore } = await import('../src/store.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-openapi-'))
    const server = createServer({ store: new JsonStore(path.join(dir, 'store.json')) })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    let payload
    try {
      payload = await (await fetch(`${baseUrl}/api/v1/health`)).json()
    } finally {
      await new Promise((r) => listener.close(r))
    }

    const spec = await fs.readFile('docs/openapi.yaml', 'utf8')
    const block = spec.slice(spec.indexOf('HealthResponse:'), spec.indexOf('HealthResponse:') + 1200)
    const documented = new Set([...block.matchAll(/^ {8}(\w+):/gm)].map((m) => m[1]))

    const undocumented = Object.keys(payload).filter((k) => !documented.has(k))
    assert.deepEqual(undocumented, [],
      `health returns these fields the OpenAPI contract does not document: ${undocumented.join(', ')}`)
  })
})

describe('Lindela Lite OpenAPI coverage', () => {
  it('documents every endpoint the API reference lists', async () => {
    // The contract carried 63 of 89 endpoints. Equity, parametric rules,
    // webhooks, community feedback, KPI snapshots, lineage, connectors and
    // scenarios were all documented in docs/api.md and absent from the
    // contract, so a technical reader could not discover them or generate a
    // client for them. validate.mjs only substring-matches the contract, so it
    // could not notice either way.
    const spec = await fs.readFile('docs/openapi.yaml', 'utf8')
    const api = await fs.readFile('docs/api.md', 'utf8')

    const documented = new Set([...spec.matchAll(/^  (\/api\/v1\/[^:]*):/gm)].map((m) => m[1]))
    const normalise = (p) => p
      .replace(/[.,;:)']+$/, '')
      .replace(/:[A-Za-z_]+/g, '{id}')
      .replace(/\.cap$/, '')
      .replace(/\.pdf$/, '')
      .replace(/\.(md|json|csv|geojson)$/, '')
      .replace(/\/$/, '')

    const missing = []
    for (const m of api.matchAll(/^### `(GET|POST|PATCH|PUT|DELETE) (\/api\/v1\/[^`]+)`/gm)) {
      const p = normalise(m[2])
      if (p && !documented.has(p)) missing.push(`${m[1]} ${m[2]}`)
    }
    assert.deepEqual(missing, [],
      `docs/api.md documents these but the OpenAPI contract does not: ${[...new Set(missing)].join(', ')}`)
  })

  it('declares the released version, not an older one', async () => {
    // info.version was 0.1.0 while the package was at 0.2.0 — the same drift as
    // the footers, in the API contract.
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'))
    const spec = await fs.readFile('docs/openapi.yaml', 'utf8')
    const declared = spec.match(/^  version:\s*(\S+)$/m)
    assert.ok(declared, 'the contract must declare a version')
    assert.equal(declared[1], pkg.version,
      `contract says ${declared[1]} but package.json says ${pkg.version}`)
  })
})

describe('Lindela Lite payload hashing', () => {
  it('changes when only metadata changes', async () => {
    // The hash used JSON.stringify's second argument as a property allowlist,
    // which applies at every nesting level, so `metadata` was kept as a key and
    // every key inside it was dropped. A record's hash was therefore identical
    // no matter what its metadata said.
    const { canonicalHash } = await import('../src/utils.js')
    const base = { source: 'noaa_enso', source_id: '2026-08', value: 2.17, metadata: { phase: 'el_nino_advisory', overlapping_seasons: 0 } }
    const amended = { ...base, metadata: { ...base.metadata, overlapping_seasons: 3 } }

    assert.notEqual(canonicalHash(base), canonicalHash(amended),
      'a metadata change must change the hash, or a corrected disclaimer can never reach stored data')

    const relabelled = { ...base, metadata: { ...base.metadata, phase: 'neutral' } }
    assert.notEqual(canonicalHash(base), canonicalHash(relabelled))
  })

  it('ignores key order at every depth', async () => {
    const { canonicalHash } = await import('../src/utils.js')
    const one = { source: 'x', value: 1, metadata: { a: 2, b: { d: 4, c: 3 } } }
    const two = { metadata: { b: { c: 3, d: 4 }, a: 2 }, value: 1, source: 'x' }
    assert.equal(canonicalHash(one), canonicalHash(two),
      'the hash must be stable under reordering, or every ingest looks like a change')

    const arrOne = { source: 'x', metadata: { list: [{ b: 2, a: 1 }] } }
    const arrTwo = { source: 'x', metadata: { list: [{ a: 1, b: 2 }] } }
    assert.equal(canonicalHash(arrOne), canonicalHash(arrTwo))
  })

  it('propagates a metadata-only change through the store merge', async () => {
    // mergeById skips an incoming record whose payload_hash already exists. With
    // metadata invisible to the hash, re-ingesting a connector could never update
    // a record whose corrections lived in metadata — which is where model limits,
    // episode declarations and geolocation notes are kept.
    const { mergeById } = await import('../src/store.js')
    const { canonicalHash } = await import('../src/utils.js')

    const stored = {
      id: 'obs-1', source: 'noaa_enso', source_id: '2026-08', value: 2.17,
      metadata: { phase: 'el_nino_advisory', advisory_run_months: 4, episode_declared: false },
    }
    stored.payload_hash = canonicalHash(stored)
    stored.first_seen_at = '2026-09-01T00:00:00.000Z'

    const incoming = {
      ...stored,
      metadata: { ...stored.metadata, overlapping_seasons: 3, advisory_run_months: 4 },
    }
    delete incoming.payload_hash
    delete incoming.first_seen_at
    incoming.payload_hash = canonicalHash(incoming)

    const merged = mergeById([stored], [incoming])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].metadata.overlapping_seasons, 3,
      'the corrected metadata must reach the stored record')
  })

  it('still treats a byte-identical re-ingest as a no-op', async () => {
    const { mergeById } = await import('../src/store.js')
    const { canonicalHash } = await import('../src/utils.js')
    const rec = { id: 'obs-1', source: 'x', value: 1, metadata: { note: 'same' } }
    rec.payload_hash = canonicalHash(rec)
    const again = { ...rec }
    again.payload_hash = canonicalHash(again)
    const merged = mergeById([rec], [again])
    assert.equal(merged.length, 1, 'an unchanged record must not be duplicated')
  })
})

describe('Lindela Lite ENSO index labelling', () => {
  it('names the monthly anomaly rather than claiming it is the ONI', async () => {
    // The feed is the CPC *monthly* detrended Niño 3.4 anomaly. The ONI is by
    // definition the three-month running mean of those numbers, so reporting the
    // monthly value under the label "ONI" is a mislabel — currently about 0.3 °C,
    // small enough to look like noise and large enough to be wrong. The ONI is
    // still what the episode rule is applied to, via the derived three-month
    // means, and the distinction is what the payload now states.
    const { parseNino34, classifyNino34 } = await import('../src/connectors/noaa-enso.js')
    const source = await fs.readFile('src/connectors/noaa-enso.js', 'utf8')

    assert.ok(/index_used:\s*'monthly nino34 sst anomaly'/.test(source),
      'index_used must name the series that was actually read')
    assert.ok(!/index_used:\s*'ONI'/.test(source),
      "index_used must not claim the monthly anomaly is the ONI")

    // The derived three-month means are what the episode rule runs on, so the
    // count is a real ONI-based qualification rather than a month count.
    const rows = parseNino34([
      ' YR   MON  TOTAL ClimAdjust ANOM',
      '2026  6   29.18   27.71   1.47',
      '2026  7   29.07   27.29   1.78',
      '2026  8   29.04   26.87   2.17',
    ].join('\n'))
    const classified = classifyNino34(rows)
    assert.equal(classified.overlapping_seasons, 1,
      'one complete three-month window qualifies, which is a season and not a month')
    assert.equal(classified.episode_declared, false)
  })
})

describe('Lindela Lite CHW field-report location', () => {
  async function postReport(body) {
    const { createServer } = await import('../src/server.js')
    const { JsonStore } = await import('../src/store.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-chw-geo-'))
    const server = createServer({ store: new JsonStore(path.join(dir, 'store.json')) })
    const listener = server.listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      const res = await fetch(`${base}/api/v1/chw/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await res.json()
      return { status: res.status, body: payload, report: payload.report || payload.data }
    } finally {
      await new Promise((r) => listener.close(r))
    }
  }

  it('never stores a fabricated coordinate when the location is unknown', async () => {
    // The client used (0, 0) as its "no location" sentinel and the server wrote
    // `body.location?.latitude || 0`, so a missing fix, an explicit null and a
    // real zero all became latitude 0, longitude 0 — Null Island, open water off
    // West Africa. A field report is a disease signal, and one that looks located
    // while pointing at the ocean is worse than one with no coordinate.
    const { report } = await postReport({
      kind: 'symptom',
      category: 'fever',
      description: 'child with fever for days',
      location: { latitude: null, longitude: null, source: 'reported_here' },
    })
    assert.equal(report.latitude, null)
    assert.equal(report.longitude, null)
    assert.equal(report.location_source, 'reported_here',
      'the record must say how the location was determined, or a caller cannot judge it')
  })

  it('treats a legacy zero coordinate as no location rather than as a fix', async () => {
    const { report } = await postReport({
      kind: 'symptom',
      category: 'fever',
      description: 'legacy client payload',
      location: { latitude: 0, longitude: 0 },
    })
    assert.equal(report.latitude, null)
    assert.equal(report.longitude, null)
    assert.equal(report.location_source, 'unknown')
  })

  it('keeps a real fix, and records that it was a GPS fix and how accurate', async () => {
    const { report } = await postReport({
      kind: 'symptom',
      category: 'diarrhoea',
      description: 'self with diarrhoea for hours',
      location: { latitude: 3.2, longitude: 35.7, source: 'gps', accuracy_m: 12 },
    })
    assert.notEqual(report.latitude, null)
    assert.notEqual(report.longitude, null)
    assert.equal(report.location_source, 'gps')
    assert.equal(report.location_accuracy_m, 12,
      'accuracy is the difference between a usable and an unusable field fix, so it must survive')
  })

  it('keeps no (0, 0) sentinel in the CHW client', async () => {
    // The client is where the fabrication started. It used {latitude: 0,
    // longitude: 0} in six places, including for the "here" button — so auto and
    // manual were indistinguishable whenever the fix failed.
    const src = await fs.readFile('public/chw/app.js', 'utf8')
    assert.ok(!/latitude:\s*0,\s*longitude:\s*0/.test(src),
      'the CHW client must not use (0, 0) as a location sentinel')
    assert.ok(/userLocation = null/.test(src),
      'unknown location must be null, not a coordinate')
  })
})

describe('Lindela Lite field-report attribution', () => {
  it('still requires incident or intervention linkage when a report is created', async () => {
    const { buildCreate } = await import('../src/operations.js')
    assert.throws(
      () => buildCreate('field_reports', { summary: 'orphaned report' }, { incidents: [], interventions: [] }),
      /incident_id or intervention_id is required/,
      'an unattributable report must not be creatable through the operational API',
    )
  })

  it('lets a report without linkage be updated and withdrawn', async () => {
    // A report raised through POST /api/v1/chw/report has no incident linkage by
    // design: a health worker reporting a symptom does not know which incident it
    // belongs to. Because the normaliser re-checked linkage on every mutation,
    // such a record could be listed but never updated or soft-deleted — a disease
    // signal that cannot be withdrawn when it turns out to be a duplicate.
    const { buildUpdate, buildSoftDelete, isDeleted } = await import('../src/operations.js')
    const chwReport = {
      id: 'report_chw_1',
      incident_id: null,
      intervention_id: null,
      summary: 'child with fever for days',
      category: 'fever',
      source: 'chw_web',
      location_source: 'reported_here',
    }
    const data = { incidents: [], interventions: [] }

    const updated = buildUpdate('field_reports', chwReport, { status: 'acknowledged' }, data)
    assert.equal(updated.status, 'acknowledged')

    const deleted = buildSoftDelete('field_reports', chwReport, 'operator', data)
    assert.ok(isDeleted(deleted), 'a CHW report must be withdrawable')
    assert.equal(deleted.deleted_by, 'operator')
  })

  it('refuses to delete a record twice', async () => {
    const { buildSoftDelete } = await import('../src/operations.js')
    const rec = { id: 'r', incident_id: null, intervention_id: null, summary: 's', deleted_at: '2026-01-01T00:00:00.000Z' }
    assert.throws(() => buildSoftDelete('field_reports', rec, 'operator', { incidents: [], interventions: [] }),
      /already deleted/)
  })
})

describe('Lindela Lite absence is not zero', () => {
  it('toNumber falls back for absence and keeps a real zero', async () => {
    // Number(null), Number('') and Number([]) are all 0, so the previous
    // implementation turned "no value" into a real zero. For a threshold that
    // is harmless. For a coordinate it put unknown locations in the Gulf of
    // Guinea.
    const { toNumber } = await import('../src/utils.js')
    for (const absent of [null, undefined, '', [], false, Number.NaN]) {
      assert.equal(toNumber(absent), null, `${JSON.stringify(absent)} must not coerce to a number`)
    }
    assert.equal(toNumber(0), 0, 'a real zero is a value and must survive')
    assert.equal(toNumber('0'), 0, 'a numeric string zero is a value')
    assert.equal(toNumber('3.5'), 3.5, 'numeric strings still coerce')
    assert.equal(toNumber(3.5), 3.5)
    assert.equal(toNumber('abc'), null)
  })

  it('keeps an unknown location unknown through update and delete', async () => {
    // The regression, end to end. A CHW report with null coordinates was stored
    // correctly, then toNumber(null) returned 0 the moment anything updated or
    // soft-deleted it through the operational API — putting the report back at
    // Null Island, which is the defect this all started from.
    const { buildCreate, buildUpdate, buildSoftDelete } = await import('../src/operations.js')
    const data = { incidents: [{ id: 'inc-1' }], interventions: [] }

    const created = buildCreate('field_reports', {
      incident_id: 'inc-1',
      summary: 'child with fever for days',
      latitude: null,
      longitude: null,
      location_source: 'auto_failed',
    }, data)
    assert.equal(created.latitude, null)
    assert.equal(created.longitude, null)

    const updated = buildUpdate('field_reports', created, { summary: 'child with fever for days (edited)' }, data)
    assert.equal(updated.latitude, null, 'an update must not resurrect a coordinate')
    assert.equal(updated.longitude, null)
    assert.equal(updated.location_source, 'auto_failed', 'the reason for having no location must survive')

    const deleted = buildSoftDelete('field_reports', updated, 'operator', data)
    assert.equal(deleted.latitude, null, 'a soft delete must not resurrect a coordinate either')
    assert.equal(deleted.longitude, null)
    assert.ok(deleted.deleted_at)
  })
})

describe('Lindela Lite locale fallback', () => {
  it('layers a locale over English rather than replacing it', async () => {
    // loadLocale replaced the catalogue outright, so any key the active locale
    // lacked rendered as the raw key name. The dashboard offered nine languages
    // and was complete in two, so a Somali operator saw `equity.acknowledged`
    // as a column header, and the equity table overflowed its 360px rail
    // because a key name is longer than a word.
    const app = await fs.readFile('public/app.js', 'utf8')
    assert.ok(!/state\.catalog = await res\.json\(\)/.test(app),
      'loadLocale must not replace the catalogue with only the active locale')

    const runtime = await fs.readFile('public/shared/runtime.js', 'utf8')
    const setBody = runtime.slice(runtime.indexOf('async set(locale)'))
    assert.ok(!/Object\.assign\(catalog, newCatalog\)/.test(setBody),
      'switching locale must re-read English as the base, not merge into whatever was last loaded')
  })

  it('keeps no raw key names in any offered locale for the CHW flow', async () => {
    const html = await fs.readFile('public/chw/index.html', 'utf8')
    const keys = [...new Set([...html.matchAll(/data-i18n(?:-title)?="(chw\.[a-z_]+)"/g)].map((m) => m[1]))]
    const select = html.match(/<select[^>]*id="locale-select"[^>]*>([\s\S]*?)<\/select>/)
    assert.ok(select, 'the CHW app must have a language selector')
    const offered = [...select[1].matchAll(/<option\s+value="([a-z]{2,3})"/g)].map((m) => m[1])
    assert.ok(offered.length >= 2, 'the CHW app must offer more than one language')

    for (const code of offered) {
      const locale = JSON.parse(await fs.readFile(`public/i18n/${code}.json`, 'utf8'))
      const missing = keys.filter((k) => !(k in locale))
      assert.deepEqual(missing, [],
        `the CHW app offers "${code}" but these strings are missing, so they render as raw keys: ${missing.join(', ')}`)
    }
  })
})

describe('Lindela Lite sanctions screening state', () => {
  const rule = {
    id: 'pr-1', chain: 'celo-alfajores', contract_address: '0xSIM',
    disbursement_amount_local_currency: 5000, currency: 'USD',
    recipient_group_id: 'group-aweil-farmers',
    requires_focal_point_approval: true,
  }

  it('distinguishes blocked, clear and not-screened', async () => {
    // sanctions_screened was a boolean, so "nothing was screened because no
    // recipient was supplied" and "the SDN list was unreachable" looked
    // identical to a reader deciding whether a disbursement had been checked.
    const { simulateDisbursement } = await import('../src/parametric.js')

    const clear = simulateDisbursement(rule, {
      focal_point_approved: true,
      sanctions: { screened: true, matches: [], blocked: false },
    })
    assert.equal(clear.sanctions_status, 'clear')

    const unscreened = simulateDisbursement(rule, {
      focal_point_approved: true,
      sanctions: { screened: false, matches: [], blocked: false, reason: 'no recipient name supplied' },
    })
    assert.equal(unscreened.sanctions_status, 'not_screened')
    assert.equal(unscreened.sanctions_reason, 'no recipient name supplied',
      'an unscreened disbursement must say why, so it cannot read as a clean result')
  })

  it('refuses to simulate a blocked disbursement', async () => {
    const { simulateDisbursement } = await import('../src/parametric.js')
    assert.throws(
      () => simulateDisbursement(rule, { focal_point_approved: true, sanctions: { screened: true, matches: [{}], blocked: true } }),
      /Sanctions screening match blocks/,
    )
  })

  it('still requires focal point approval regardless of screening', async () => {
    const { simulateDisbursement } = await import('../src/parametric.js')
    assert.throws(() => simulateDisbursement(rule, { sanctions: { screened: true, matches: [], blocked: false } }),
      /Focal point approval required/)
  })

  it('records an unscreened simulation as unscreened through the API', async () => {
    const { createServer } = await import('../src/server.js')
    const { JsonStore } = await import('../src/store.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-sanctions-'))
    const server = createServer({ store: new JsonStore(path.join(dir, 'store.json')) })
    const listener = server.listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      // No auth needed to reach this: the point is that omitting the recipient
      // yields a self-describing unscreened record, not a silent clean one.
      const res = await fetch(`${base}/api/v1/parametric-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'probe', chain: 'celo-alfajores', trigger_metric: 'precipitation_mm',
          trigger_threshold: 8, disbursement_amount_local_currency: 100,
          currency: 'USD', recipient_group_id: 'g',
        }),
      })
      const ruleId = (await res.json()).data.id
      const sim = await (await fetch(`${base}/api/v1/parametric-rules/${ruleId}/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focal_point_approved: true }),
      })).json()
      assert.equal(sim.data.sanctions_status, 'not_screened')
      assert.equal(sim.data.sanctions_screened, false)
      assert.match(sim.data.sanctions_reason, /no recipient name supplied/i)
    } finally {
      await new Promise((r) => listener.close(r))
    }
  })
})

describe('Lindela Lite workflow attribution', () => {
  it('distinguishes an authenticated actor from a claimed one', async () => {
    // The transition handler read `req.__auth?.subject || 'anonymous'`, so on an
    // unauthenticated deployment every approval was recorded as "anonymous" and
    // an actor the caller did supply was discarded. Preferring the verified
    // subject is right; throwing away the claim loses audit information.
    const { transitionWorkflow } = await import('../src/workflows.js')
    const instance = { id: 'wf-1', type: 'anticipatory_alert', state: 'focal_point_review', transitions: [] }

    const claimed = transitionWorkflow(instance, {
      to: 'approved', actor: 'Dr Amara Okoth', actor_source: 'claimed', claimed_actor: 'Dr Amara Okoth',
    })
    const t = claimed.transitions[0]
    assert.equal(t.actor, 'Dr Amara Okoth')
    assert.equal(t.actor_source, 'claimed', 'a self-declared actor must never read as verified')

    const authed = transitionWorkflow(instance, {
      to: 'approved', actor: 'verified-user', actor_source: 'authenticated', claimed_actor: 'someone else',
    })
    assert.equal(authed.transitions[0].actor, 'verified-user')
    assert.equal(authed.transitions[0].actor_source, 'authenticated')
  })

  it('records an unattributed transition as unattributed', async () => {
    const { transitionWorkflow } = await import('../src/workflows.js')
    const instance = { id: 'wf-2', type: 'anticipatory_alert', state: 'focal_point_review', transitions: [] }
    const out = transitionWorkflow(instance, { to: 'approved', actor: 'anonymous' })
    assert.equal(out.transitions[0].actor_source, 'unattributed')
  })
})

describe('Lindela Lite false-alert rate', () => {
  const alert = (over) => ({
    id: 'a', status: 'resolved', created_at: '2026-08-01T00:00:00.000Z', ...over,
  })

  it('is null, not zero, when no alert outcome has been determined', async () => {
    // It used to scan resolution_note for /false|invalid|noop/i and divide by the
    // alert count. On the demo data that gave 0%, which reads as "no false alerts
    // occurred" when it means "nobody wrote the word false". None of the seeded
    // notes — "situation stabilised", "temperature normalised" — says whether the
    // alert was warranted at all.
    const { computeQuarterlyKpi } = await import('../src/kpi.js')
    const data = {
      alert_events: [
        alert({ id: 'a1', resolution_note: 'Situation stabilised; UNMISS engaged.' }),
        alert({ id: 'a2', resolution_note: 'Temperature normalised after three days.' }),
      ],
    }
    const kpi = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026 })
    assert.equal(kpi.false_alert_rate, null,
      'a zero here would assert no false alerts occurred, which the data does not support')
    assert.equal(kpi.false_alert_determined, 0)
    assert.ok(kpi.data_gaps.some((g) => g.field === 'false_alert_rate'),
      'an unmeasurable KPI must be reported as a data gap, not silently blank')
  })

  it('ignores a note that merely mentions the word false', async () => {
    const { computeQuarterlyKpi } = await import('../src/kpi.js')
    const data = {
      alert_events: [
        alert({ id: 'a1', resolution_note: 'Not a false alarm: wind damage to the roof.' }),
      ],
    }
    const kpi = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026 })
    assert.equal(kpi.false_alert_rate, null,
      'prose must not be parsed for a verdict the operator never recorded')
  })

  it('measures the rate over determined alerts only and states the denominator', async () => {
    const { computeQuarterlyKpi } = await import('../src/kpi.js')
    const data = {
      alert_events: [
        alert({ id: 'a1', false_alert: true, resolution_note: 'Sensor fault.' }),
        alert({ id: 'a2', false_alert: false, resolution_note: 'Flood subsided.' }),
        alert({ id: 'a3', false_alert: false, resolution_note: 'Heat event confirmed.' }),
        alert({ id: 'a4', false_alert: null, resolution_note: 'Situation stabilised.' }),
      ],
    }
    const kpi = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026 })
    assert.equal(kpi.false_alert_determined, 3, 'the undetermined alert must stay out of the denominator')
    assert.equal(kpi.false_alert_of_total, 4)
    assert.equal(kpi.false_alert_rate, 100 / 3)
    assert.match(kpi.false_alert_method, /determination/i)
  })

  it('records a determination only as true, false, or explicitly undetermined', async () => {
    const { updateAlertEvent } = await import('../src/alerts.js')
    const base = { id: 'a', status: 'resolved' }
    assert.equal(updateAlertEvent(base, { false_alert: true }).false_alert, true)
    assert.equal(updateAlertEvent(base, { false_alert: false }).false_alert, false)
    assert.equal(updateAlertEvent(base, { false_alert: null }).false_alert, null,
      'an absent determination must stay absent, not become a verdict')
    assert.throws(() => updateAlertEvent(base, { false_alert: 'maybe' }), /false_alert must be/,
      'an unrecognised value must be refused rather than coerced to false')
  })
})

describe('Lindela Lite false-alert trend', () => {
  it('reports null, not zero, in the monthly series too', async () => {
    // The monthly series kept its own copy of the old keyword scan, so the trend
    // card showed a flat 0% while the KPI tile above it correctly showed a gap —
    // the same metric contradicting itself on one screen.
    const { computeMonthlyKpiSeries } = await import('../src/kpi.js')
    const now = new Date()
    const series = computeMonthlyKpiSeries({
      alert_events: [{
        id: 'a1',
        status: 'resolved',
        created_at: now.toISOString(),
        resolution_note: 'Situation stabilised; UNMISS engaged.',
      }],
      dispatches: [],
    })
    assert.ok(Array.isArray(series) && series.length, 'the monthly series must produce months')
    assert.ok(series.every((m) => m.false_alert_rate === null),
      'no month may report a false-alert rate when no outcome was determined')
  })

  it('does not plot a missing month as a zero', async () => {
    // Gaps used to be filled with 0 before plotting, so a month with no recorded
    // outcome drew as a flat line sitting on the axis — indistinguishable from a
    // month in which nothing happened.
    const app = await fs.readFile('public/co/app.js', 'utf8')
    const spark = app.slice(app.indexOf('function buildSparkline'), app.indexOf('function sparkCard'))
    assert.ok(!/values\.map\(v => v \?\? 0\)/.test(spark),
      'a sparkline must not fill missing values with zero')
    assert.ok(/indexed\.length > 1/.test(spark),
      'a single plotted value is a dot, not a trend line')
  })

  it('states the denominator beside the rate on the KPI tile', async () => {
    const app = await fs.readFile('public/co/app.js', 'utf8')
    assert.ok(/false_alert_determined/.test(app),
      'the CO tile must disclose how many alerts the rate rests on')
    assert.ok(/no alert outcomes recorded yet/.test(app),
      'and must say why the rate is absent when nothing is determined')
  })
})

describe('Lindela Lite scenario workbench', () => {
  const data = {
    climate_observations: [{ source_id: '2026-08', precipitation_mm: 10, observed_at: '2026-08-15T00:00:00.000Z' }],
    hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'high', region_name: 'Aweil', latitude: 8.6, longitude: 27.4, observed_at: '2026-08-01T00:00:00.000Z' }],
    conflict_events: [],
    service_assets: [{ id: 'a1', name: 'Aweil Clinic', service_type: 'health', latitude: 8.64, longitude: 27.39 }],
  }

  it('states what the delta is in the payload, not only in the UI', async () => {
    // The response carried a bare 19.13-point delta with no unit, no method and
    // no limit. On screen it was labelled "(mean %)" and coloured red, which read
    // as a modelled prediction — "doubling rainfall raises flood risk 19%" — from
    // an uncalibrated sensitivity score.
    const { runScenario } = await import('../src/scenarios.js')
    const s = runScenario(data, { precipitation_multiplier: 2 })
    assert.equal(s.diff.unit, 'score points')
    assert.match(s.model_limit, /not a percentage, not a probability, and not a forecast/i)
    assert.match(s.model_limit, /calibrated_uncertainty: false/)
    assert.ok(Number.isFinite(s.diff.baseline_flood_risk_mean), 'the baseline the delta is measured against must be reported')
    assert.ok(Number.isFinite(s.diff.scenario_flood_risk_mean))
  })

  it('pairs every assessment with a real baseline', async () => {
    // The UI computed `impact_score - (baseline_impact_score ?? 0)`, and the API
    // never returned a baseline — so every asset showed a fabricated +75 change
    // and the "top affected" list was sorted by an identical score.
    const { runScenario } = await import('../src/scenarios.js')
    const s = runScenario(data, { precipitation_multiplier: 2 })
    for (const a of s.impact_assessments) {
      assert.ok(a.baseline_impact_score !== undefined, `${a.id} must carry a baseline field`)
      if (a.baseline_impact_score === null) continue
      assert.equal(a.impact_delta, a.impact_score - a.baseline_impact_score,
        'the delta must be the real difference, not a difference from an assumed zero')
    }
  })

  it('does not fabricate a delta where no baseline exists', async () => {
    const { runScenario } = await import('../src/scenarios.js')
    // Remove the asset from the baseline side only, by perturbing the baseline
    // data with an asset set that has no counterpart.
    const s = runScenario(data, { offline_asset_ids: ['missing-id'] })
    const anyNull = s.impact_assessments.some((a) => a.impact_delta === null)
    assert.ok(s.impact_assessments.every((a) => a.impact_delta === null || Number.isFinite(a.impact_delta)),
      'a delta is either a real difference or null, never a number invented from a missing baseline')
    void anyNull
  })

  it('resolves service type and region from the fields that exist', async () => {
    const { runScenario } = await import('../src/scenarios.js')
    const s = runScenario(data, { precipitation_multiplier: 2 })
    const a = s.impact_assessments[0]
    assert.ok(a.service_type, 'service_type is the field an assessment carries; asset_type does not exist')
    assert.ok(a.region_name, 'region must resolve from drivers when the assessment has no region of its own')
  })
})

describe('Lindela Lite signal-to-dispatch latency', () => {
  const dispatch = (over) => ({
    id: 'd', matched_signal_at: '2026-08-01T00:00:00.000Z', sent_at: '2026-08-01T01:00:00.000Z', ...over,
  })

  it('measures signal-matched to sent, not hazard-observed to sent', async () => {
    // A silent fallback switched to a different interval whenever no
    // matched_signal_at existed, so the same figure could quietly change meaning
    // depending on the data — and the monthly series had no such fallback.
    const { signalToDispatchHours } = await import('../src/kpi.js')
    assert.equal(signalToDispatchHours([dispatch({})]), 1)
    // No matched_signal_at: the interval is unavailable, not substituted.
    assert.equal(signalToDispatchHours([dispatch({ matched_signal_at: null })]), null)
    assert.equal(signalToDispatchHours([]), null)
    // A negative lag is a clock problem, not a fast dispatch.
    assert.equal(signalToDispatchHours([dispatch({ sent_at: '2026-07-31T00:00:00.000Z' })]), null)
  })

  it('states that it is not a field outcome and not comparable to the bid target', async () => {
    const { computeQuarterlyKpi, WARNING_TO_ACTION_LIMIT } = await import('../src/kpi.js')
    const kpi = computeQuarterlyKpi({
      rapidpro_dispatches: [dispatch({})],
      hazard_events: [],
      alert_events: [],
      interventions: [],
      workflow_instances: [],
      field_reports: [],
      dispatches: [dispatch({})],
    }, { quarter: 'Q3', year: 2026 })
    assert.equal(kpi.warning_to_action_is_field_outcome, false)
    assert.match(WARNING_TO_ACTION_LIMIT, /not warning-to-action in the UNICEF sense/i)
    assert.match(WARNING_TO_ACTION_LIMIT, /not comparable to the UNICEF bid target/i)
    assert.match(kpi.warning_to_action_measure, /matched_signal_at.*sent_at/)
  })

  it('does not print the bid target beside it as if being assessed', async () => {
    const pdf = await fs.readFile('src/pdf.js', 'utf8')
    const app = await fs.readFile('public/co/app.js', 'utf8')
    // The PDF row and the dashboard tile must both name what is measured.
    assert.ok(/Signal-to-dispatch median/.test(pdf), 'the PDF row must not be labelled warning-to-action')
    assert.ok(/Signal-to-dispatch median/.test(app), 'the CO tile must not be labelled warning-to-action')
    assert.ok(!/target: <24h/.test(app),
      "the '<24h' UNICEF target must not annotate a figure that does not measure it")
    // Asserted on phrases that sit within a single template literal; the full
    // sentence is split across lines for width, so matching the joined sentence
    // against the source tests the layout rather than the claim.
    assert.ok(/bid target for reference/.test(pdf), 'the PDF must keep the bid target as context')
    assert.ok(/comparable to that target/.test(pdf),
      'the PDF must say this figure is not comparable to the bid target')
  })
})

describe('Lindela Lite IPC food security ingestion', () => {
  async function loadFixtureRecords() {
    const { parseCsv } = await import('../src/utils.js')
    const { groupIpcRows } = await import('../src/connectors/ipc-hdx.js')
    const text = await fs.readFile('test/fixtures/ipc-area-kenya-sample.csv', 'utf8')
    return { parseCsv, text, groupIpcRows, records: groupIpcRows(parseCsv(text), 'area', { datasetUrl: 'https://x' }) }
  }

  it('groups long rows into one record per area and validity window', async () => {
    // The live area CSV is ~42,000 rows (one per phase); the store shape is one
    // record per (area, window). If the grouping key is wrong the count moves
    // silently either way, so it is compared against an independently counted
    // distinct set of the key fields rather than a hand-written number.
    const { parseCsv, text, records } = await loadFixtureRecords()
    const rows = parseCsv(text)
    const expected = new Set(rows.map((r) => [r.Country, r.Area, r['Date of analysis'], r['Validity period'], r.From, r.To].join('|'))).size
    assert.equal(records.length, expected, 'one record per (country, area, analysis, window, From, To)')

    const baringo = records.find((r) => r.area === 'Baringo' && r.validity_period === 'current')
    assert.ok(baringo, 'fixture must contain a Baringo current-window record')
    assert.equal(baringo.country, 'KEN')
    assert.equal(baringo.phase3plus_number, 152800)
    // The source Percentage column is a fraction of the analysed population:
    // 0.2 means 20%. A reader of 0.2 as "0.2%" would misreport by 100x.
    assert.equal(baringo.phase3plus_fraction, 0.2)
    assert.match(String(baringo.metadata.percentage_note), /0\.2 means 20%/, 'the fraction semantics must be stated on the record')
    assert.ok(baringo.phases['3+'], 'the 3+ figure stays in the phases map too')
    assert.ok(baringo.phases.all, 'the analysed-population row is grouped in, not dropped')
    assert.equal(baringo.latitude, null, 'an area name is not a point: coordinates must stay null')
  })

  it('keeps the phases map complete without double-counting the lifted 3+', async () => {
    const { records } = await loadFixtureRecords()
    const baringo = records.find((r) => r.area === 'Baringo' && r.validity_period === 'current')
    const lifted = baringo.phases['3+']
    assert.equal(lifted.number, baringo.phase3plus_number)
    assert.equal(lifted.fraction, baringo.phase3plus_fraction)
  })

  it('joins a bbox where the GeoJSON matched and leaves null where it did not', async () => {
    const { parseCsv } = await import('../src/utils.js')
    const { groupIpcRows } = await import('../src/connectors/ipc-hdx.js')
    const text = await fs.readFile('test/fixtures/ipc-area-kenya-sample.csv', 'utf8')
    const bboxes = new Map([['Baringo', { south: 0.5, west: 35.9, north: 1.3, east: 36.3 }]])
    const records = groupIpcRows(parseCsv(text), 'area', { bboxes })
    const baringo = records.find((r) => r.area === 'Baringo')
    assert.deepEqual(baringo.bbox, { south: 0.5, west: 35.9, north: 1.3, east: 36.3 })
    const other = records.find((r) => r.area !== 'Baringo')
    assert.equal(other.bbox, null, 'an unmatched area name must give null geometry, not a guessed one')
  })

  it('accepts country filters against ISO3 feed codes', async () => {
    // The feed publishes "KEN"; regions use "KE". An exact-match filter on the
    // wrong spelling returned zero records silently — found live on the first
    // ingest — so the connector normalises both spellings before matching.
    // groupIpcRows takes the already-normalised set; the ISO2 mapping is
    // asserted on the source so its removal is caught.
    const { parseCsv } = await import('../src/utils.js')
    const { groupIpcRows } = await import('../src/connectors/ipc-hdx.js')
    const text = await fs.readFile('test/fixtures/ipc-area-kenya-sample.csv', 'utf8')
    const nothing = groupIpcRows(parseCsv(text), 'area', { countryFilter: new Set(['SOM']) })
    assert.equal(nothing.length, 0, 'this fixture is all Kenya; a non-Kenya filter keeps nothing')
    const records = groupIpcRows(parseCsv(text), 'area', { countryFilter: new Set(['KEN']) })
    assert.ok(records.length > 0)
    const source = await fs.readFile('src/connectors/ipc-hdx.js', 'utf8')
    assert.ok(/ISO2_TO_ISO3/.test(source) && /KE: 'KEN'/.test(source),
      'the ISO2 spelling must be mapped onto the ISO3 feed codes')
  })

  it('rolls up the latest current window and excludes projections from it', async () => {
    const { summarizeFoodSecurity } = await import('../src/connectors/ipc-hdx.js')
    const earlier = { source: 'ipc_hdx', scope: 'national', country: 'KEN', area: null,
      analysis_date: 'Jun 2026', validity_period: 'current', valid_from: '2026-06-01', valid_to: '2026-08-31',
      phase3plus_number: 100, phase3plus_fraction: 0.1 }
    const later = { ...earlier, valid_from: '2026-07-01', valid_to: '2026-10-31',
      phase3plus_number: 900, phase3plus_fraction: 0.9 }
    const projection = { ...later, validity_period: 'first_projection', phase3plus_number: 9999, phase3plus_fraction: 0.99 }
    // A record with no 3+ figure (phase row missing) must not crash the roll-up.
    const bare = { ...later, country: 'UGA', phase3plus_number: null, phase3plus_fraction: null }

    const summary = summarizeFoodSecurity([earlier, projection, later, bare])
    const kenya = summary.countries.find((c) => c.country === 'KEN')
    assert.equal(kenya.phase3plus_number, 900, 'latest window by valid_from wins over earlier current windows')
    assert.equal(kenya.phase3plus_fraction, 0.9)
    assert.equal(summary.countries.find((c) => c.country === 'UGA').phase3plus_number, null)
    // All synthetic records are national scope, so the areas roll-up is empty;
    // and the null-3+ UGA record must not crash the finite-fraction filter.
    assert.deepEqual(summary.worst_areas, [])
  })

  it('registers the source end to end', async () => {
    const { publicSourceCatalog, emptyStore } = await import('../src/schema.js')
    const { SOURCE_POLICIES, PUBLIC_INGESTION_SOURCES } = await import('../src/ingestion.js')
    const catalog = publicSourceCatalog().map((s) => s.id)
    assert.ok(catalog.includes('ipc_hdx'), 'ipc_hdx must be advertised to the API')
    assert.ok(emptyStore().food_security_records, 'store must have the collection or runIngestion drops its output')
    assert.ok(getConnector('ipc_hdx'), 'connector must be registered for ingestion')
    assert.ok(PUBLIC_INGESTION_SOURCES.includes('ipc_hdx'), 'the source must be selectable in public ingestion')
    assert.equal(SOURCE_POLICIES.ipc_hdx.regular, true)
    assert.ok(SOURCE_POLICIES.ipc_hdx.minimum_records >= 1, 'an empty IPC ingest is a degraded run, not success')
    // The merged-collections map inside runIngestion routes connector output
    // into the store; a key absent there is silently dropped (every collection
    // was when this class of bug was found). Asserted on the source text
    // because the map is not exported.
    const ingestionSource = await fs.readFile('src/ingestion.js', 'utf8')
    assert.ok(ingestionSource.includes('food_security_records: []'),
      'runIngestion drops collections missing from its merged map')
  })
})

describe('Lindela Lite WHO GHO outbreak context', () => {
  it('builds indicator URLs without the query params this endpoint silently mis-handles', async () => {
    // Probed live 2026-10-02: $filter answers 200 with zero rows, $orderby is
    // silently ignored, $top>1000 is HTTP 400. Any of these in the URL would
    // trim records invisibly, so the URL must not contain them.
    const { buildIndicatorUrl } = await import('../src/connectors/who-gho.js')
    const url = buildIndicatorUrl('CHOLERA_0000000001')
    assert.ok(url.startsWith('https://ghoapi.azureedge.net/api/CHOLERA_0000000001'))
    assert.ok(url.includes('$format=json'))
    assert.ok(!/\$orderby=/i.test(url))
    assert.ok(!/\$filter=/i.test(url))
    assert.ok(!/\$top=/i.test(url))
  })

  it('verdicts indicator staleness rather than letting old counts look current', async () => {
    const { summarizeDiseaseObservations } = await import('../src/connectors/who-gho.js')
    const currentYear = new Date().getUTCFullYear()
    const record = (code, country, year, value, unit) => ({
      indicator_code: code, indicator_name: code, country, year, value, unit,
    })
    // Cholera's published series genuinely ends 2016 (verified); it must read
    // stale against the calendar, not "current" by virtue of being in the store.
    const summary = summarizeDiseaseObservations([
      record('CHOLERA_0000000001', 'KEN', 2016, 3120, 'cases'),
      record('WHS3_62', 'KEN', currentYear - 1, 840, 'cases'),
      record('WHS3_62', 'KEN', currentYear, 991, 'cases'),
      record('WHS3_62', 'SOM', currentYear, 2100, 'cases'),
    ])
    const cholera = summary.series_state.find((s) => s.indicator_code === 'CHOLERA_0000000001')
    assert.equal(cholera.state, 'stale')
    assert.equal(cholera.latest_year, 2016)
    assert.ok(cholera.note, 'a stale series must say why recent silence is a data fact, not a disease fact')
    const measles = summary.series_state.find((s) => s.indicator_code === 'WHS3_62')
    assert.equal(measles.state, 'current')
    const kenya = summary.latest_by_indicator_country.find((r) => r.country === 'KEN' && r.indicator_code === 'WHS3_62')
    assert.equal(kenya.value, 991, 'latest year wins, not last row ingested')
    assert.equal(summary.latest_by_indicator_country.filter((r) => r.country === 'SOM').length, 1)
  })

  it('registers the source end to end', async () => {
    const { publicSourceCatalog, emptyStore } = await import('../src/schema.js')
    const { SOURCE_POLICIES, PUBLIC_INGESTION_SOURCES } = await import('../src/ingestion.js')
    const catalog = publicSourceCatalog().map((s) => s.id)
    assert.ok(catalog.includes('who_gho'))
    assert.ok(PUBLIC_INGESTION_SOURCES.includes('who_gho'), 'the source must be selectable in public ingestion')
    assert.ok(emptyStore().disease_observations)
    assert.ok(getConnector('who_gho'))
    assert.equal(SOURCE_POLICIES.who_gho.regular, true)
    // WHO series are annual; staleness lives in the summary (20160 minutes),
    // but the source must not read fresh forever without a window at all.
    assert.ok(SOURCE_POLICIES.who_gho.stale_after_minutes > 0)
    const ingestionSource = await fs.readFile('src/ingestion.js', 'utf8')
    assert.ok(ingestionSource.includes('disease_observations: []'),
      'runIngestion drops collections missing from its merged map')
  })
})

describe('Lindela Lite food security and disease API', () => {
  it('serves IPC records and the WHO context with their honesty metadata', async () => {
    // The dashboard renders these fields directly; metadata notes ride along on
    // every record, so the API must not strip them into bare numbers.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-food-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      food_security_records: [{
        id: 'fs1', source: 'ipc_hdx', source_id: 'KEN:Turkana:current:2026-07-01',
        latitude: null, longitude: null, bbox: { south: 3.0, west: 34.4, north: 4.6, east: 36.0 },
        country: 'KEN', scope: 'area', area: 'Turkana', analysis_date: 'Jul 2026',
        validity_period: 'current', valid_from: '2026-07-01', valid_to: '2026-10-31',
        phase3plus_number: 375900, phase3plus_fraction: 0.35,
        phases: { all: { number: 1074000, fraction: 1 }, '3+': { number: 375900, fraction: 0.35 } },
        observed_at: '2026-07-01T00:00:00.000Z',
        metadata: { percentage_note: '0.2 means 20%, not 0.2%', dataset_license: 'CC0 / Public Domain' },
      }],
      disease_observations: [{
        id: 'dob1', source: 'who_gho', indicator_code: 'CHOLERA_0000000001',
        indicator_name: 'Number of reported cases of cholera', unit: 'cases',
        country: 'KEN', region: 'Eastern Mediterranean', year: 2016, value: 3120,
        latitude: null, longitude: null, first_seen_source_type: 'national_annual_aggregate',
        observed_at: '2016-01-01T00:00:00.000Z',
        metadata: { granularity_note: 'National annual aggregate', policy_note: 'context, not an alert trigger' },
      }],
    })

    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      const food = await fetchJson(`${baseUrl}/api/v1/food-security`)
      assert.equal(food.success, true)
      assert.equal(food.data.length, 1)
      assert.equal(food.data[0].phase3plus_fraction, 0.35)
      assert.equal(food.data[0].metadata.percentage_note, '0.2 means 20%, not 0.2%')
      // The record is area scope, so it lands in the areas roll-up, not countries.
      assert.equal(food.summary.countries.length, 0)
      assert.equal(food.summary.worst_areas.length, 1)
      assert.equal(food.summary.worst_areas[0].area, 'Turkana')

      const summary = await fetchJson(`${baseUrl}/api/v1/food-security/summary`)
      // Area-scope records surface in the worst-areas roll-up, not countries.
      assert.equal(summary.data.worst_areas[0].phase3plus_number, 375900)

      const disease = await fetchJson(`${baseUrl}/api/v1/disease-observations`)
      assert.equal(disease.success, true)
      assert.equal(disease.data.length, 1)
      assert.equal(disease.data[0].unit, 'cases')
      assert.equal(disease.data[0].latitude, null)
      assert.equal(disease.summary.series_state[0].state, 'stale')
    } finally {
      listener.close()
    }
  })
})

// =============================================================
// Flood probability — empirical basis (agreed 2026-10-02)
// =============================================================
// The model trains rainfall statistics against GDACS-reported floods and must
// refuse to produce a number when the sample cannot back one. Every test here
// holds the refusals up alongside the numbers: a build that regressed to
// "return a probability anyway" would have to make an unambiguous refusal
// assertion fail first.

describe('Lindela Lite flood probability model basis', () => {
  // Imported inside the tests: this describe body is synchronous.
  const fpImport = () => import('../src/flood-probability.js')

  // Five dry months, two wet seasons, one 7-day deluge. Rainfall starts 90
  // days before the first kept month so the trailing windows reach real data.
  function deterministicDaily(years, { startYear = 2005 } = {}) {
    const daily = []
    const start = Date.UTC(startYear, 0, 1)
    const end = new Date(Date.UTC(startYear, 0, 1))
    end.setUTCFullYear(end.getUTCFullYear() + years)
    end.setUTCDate(end.getUTCDate() - 1)
    for (let t = start; t <= end.getTime(); t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10)
      const month = new Date(t).getUTCMonth()
      const day = new Date(t).getUTCDate()
      let mm = 2
      if (month >= 5 && month <= 8) mm = 12
      if (month === 7) mm = 25
      if (month === 7 && day >= 14 && day <= 20) mm = 60
      daily.push({ date, precipitation_mm: mm })
    }
    return daily
  }

  function floodEvent(year, month, day, { lat = 0, lon = 0, country = 'TL' } = {}) {
    return {
      event_type: 'flood', country,
      latitude: lat, longitude: lon,
      occurred_at: new Date(Date.UTC(year, month, day)).toISOString(),
    }
  }

  it('builds month samples: same-month labels, radius matches, first months dropped', async () => {
    const fp = await fpImport()
    const daily = deterministicDaily(1)
    const events = [
      floodEvent(2005, 6, 10),            // July 2005, at the district point
      floodEvent(2005, 1, 5, { lat: 60, lon: 60 }), // far away: not in radius
      floodEvent(2005, 11, 5),            // December 2005: labelled there
    ]
    const { samples, events_matched, months_kept } = fp.buildDistrictSamples(
      daily, events, { latitude: 0, longitude: 0, country: 'TL' },
    )
    assert.equal(events_matched, 2)
    // 12-month series: Jan..Mar cannot have a 90-day trailing window.
    assert.ok(months_kept >= 9 && months_kept < 12, `months_kept=${months_kept}`)
    const wetAugust = samples.find((s) => s.month === '2005-08')
    assert.ok(samples.find((s) => s.month === '2005-07').label, 'July with a flood in radius must carry the label')
    const labelledMonths = samples.filter((s) => s.label).map((s) => s.month)
    assert.deepEqual(labelledMonths, ['2005-07', '2005-12'])
    for (const s of samples) {
      assert.ok(Number.isFinite(s.max_7_day) && Number.isFinite(s.sum_30_day) && Number.isFinite(s.sum_90_day))
    }
    // The August deluge is a 60 mm/day week block: max_7_day must be ~420 mm.
    assert.ok(wetAugust.max_7_day > 400, `max_7_day=${wetAugust.max_7_day}`)
  })

  it('skips months whose trailing coverage falls below 90 percent', async () => {
    const fp = await fpImport()
    const daily = deterministicDaily(1).map((d) =>
      (d.date.startsWith('2005-06') || d.date.startsWith('2005-07'))
        ? { ...d, precipitation_mm: null } : d)
    const { samples } = fp.buildDistrictSamples(
      daily, [floodEvent(2005, 6, 10)], { latitude: 0, longitude: 0, country: 'TL' },
    )
    // June/July have under-90% trailing coverage: skipped, not zero-filled.
    assert.ok(!samples.some((s) => s.month === '2005-06' || s.month === '2005-07'),
      `kept: ${samples.map((s) => s.month).join(',')}`)
  })

  it('country fallback matches events without coordinates', async () => {
    const fp = await fpImport()
    const daily = deterministicDaily(1)
    const { events_matched } = fp.buildDistrictSamples(
      daily, [{ event_type: 'flood', country: 'TL', latitude: null, longitude: null, occurred_at: '2005-08-10T00:00:00.000Z' }],
      { latitude: 0, longitude: 0, country: 'TL' },
    )
    assert.equal(events_matched, 1)
  })

  it('counts contingencies with a Wilson interval and a lift, and refuses under 10 months', async () => {
    const fp = await fpImport()
    const samples = []
    for (let i = 0; i < 20; i += 1) {
      samples.push({ month: `2005-${String((i % 12) + 1).padStart(2, '0')}`, max_7_day: i * 10, sum_30_day: i, sum_90_day: i, label: i > 14 })
    }
    const { counts } = fp.contingencyCount(
      samples.sort((a, b) => a.month.localeCompare(b.month) || a.max_7_day - b.max_7_day),
      'max_7_day', 0.85,
    )
    assert.equal(counts.feature, 'max_7_day')
    // 20 samples, 90th-of-85th quantile: values 180 and 190 land above it, both
    // labelled. One labelled month below threshold keeps the honest floor visible.
    assert.equal(counts.months_above_threshold, 2)
    assert.equal(counts.flood_months_above_threshold, 2)
    assert.ok(counts.flood_months_below_threshold >= 1)
    assert.ok(counts.conditional_probability_wilson.low < counts.conditional_probability_wilson.high)
    assert.ok(counts.lift_over_base_rate > 1)
    const refused = fp.contingencyCount(samples.slice(0, 5), 'max_7_day', 0.9)
    assert.ok(!refused.counts && /fewer than 10 months/.test(refused.reason))
  })

  // Controlled recovery: generated data whose true generative coefficients are
  // known collinearly (90-day antecedent wetness correlates with 7-day
  // intensity, exactly as real rainfall statistics do), fit must land close,
  // and leave-one-year-out must beat always predicting the base rate.
  function mulberry32(seed) {
    let a = seed >>> 0
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function recoverySamples(n = 480, seed = 11) {
    const rand = mulberry32(seed)
    const gauss = () => {
      const u = Math.max(rand(), 1e-9); const v = rand()
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    }
    const sigmoid = (z) => 1 / (1 + Math.exp(-z))
    const samples = []
    for (let i = 0; i < n; i += 1) {
      const z1 = gauss() * 2            // max_7_day
      const z2 = gauss() * 1.5          // sum_30_day
      const z3 = 0.8 * z1 + 0.6 * gauss() // sum_90_day, collinear on purpose
      const p = sigmoid(0.9 * z1 + 0.6 * z2 - 0.3 * z3 - 0.2)
      const year = 2000 + Math.floor(i / 12)
      const month = (i % 12) + 1
      samples.push({
        month: `${year}-${String(month).padStart(2, '0')}`,
        max_7_day: z1, sum_30_day: z2, sum_90_day: z3,
        label: rand() < p,
      })
    }
    return samples
  }

  it('recovers known coefficients under collinearity and validates out-of-year', async () => {
    const fp = await fpImport()
    const samples = recoverySamples()
    const { model, refusal } = fp.fitLogisticRegression(samples)
    assert.ok(model && !refusal, refusal)
    assert.equal(model.type, 'logistic_l2_empirical')
    // The 90-day statistic is built collinear with the 7-day one on purpose:
    // real rainfall statistics are collinear, and an ill-conditioned Hessian is
    // where naive fitters explode. With collinearity the *individual* betas are
    // not identifiable — only the penalised reconstruction is — so this asserts
    // signs and predictive separation, not exact recovered values.
    const byFeature = Object.fromEntries(model.coefficients.map((c) => [c.feature, c.value]))
    assert.ok(byFeature.max_7_day > 0, `max_7_day=${byFeature.max_7_day}`)
    assert.ok(byFeature.sum_30_day > 0, `sum_30_day=${byFeature.sum_30_day}`)
    assert.equal(model.standardization.length, 3)
    assert.equal(model.training.months, samples.length)
    assert.ok(fp.predict(model, { max_7_day: 2, sum_30_day: 1.5, sum_90_day: 1.6 }) > 0.5,
      'a wet month end must score above the base rate')
    assert.ok(fp.predict(model, { max_7_day: -2, sum_30_day: -1.5, sum_90_day: -1.6 }) < 0.3,
      'a dry month end must score low')

    const { folds, refusal: foldRefusal } = fp.leaveOneYearOut(samples)
    assert.ok(folds && !foldRefusal, foldRefusal)
    assert.ok(folds.skill_over_base_rate > 0.1, `skill=${folds.skill_over_base_rate}`)
    assert.ok(folds.brier_score < folds.brier_of_base_rate)
    assert.equal(folds.n_folds, 40, 'one held-out fold per calendar year')
  })

  it('refuses the fit on thin months, thin floods, or one class', async () => {
    const fp = await fpImport()
    const thin = fp.fitLogisticRegression(recoverySamples(59))
    assert.ok(thin.model === null && /of the required 60 months/.test(thin.refusal))

    const oneFlood = recoverySamples(120).slice(0, 100).map((s) => ({ ...s, label: false })).concat([{ month: '2009-08', max_7_day: 1, sum_30_day: 1, sum_90_day: 1, label: true }])
    const few = fp.fitLogisticRegression(oneFlood)
    assert.ok(few.model === null && /flood-label months/.test(few.refusal))

    const allFlood = recoverySamples(120).map((s) => ({ ...s, label: true }))
    const noContrast = fp.fitLogisticRegression(allFlood)
    assert.ok(noContrast.model === null && /no contrast/.test(noContrast.refusal))

    const leave3years = fp.leaveOneYearOut(recoverySamples(30))
    // Thirty months span three years: each fold holds out ten months, every
    // training fit is under the 60-month floor, so nothing validates.
    assert.ok(leave3years.folds === null && /validated months/.test(leave3years.refusal),
      JSON.stringify(leave3years.refusal))

    // Two calendar years cannot fold: leave-one-year-out needs a held-out
    // year whose complement is still a sample.
    const twoYears = recoverySamples(24).map((s, i) => ({ ...s, month: `200${i < 12 ? 0 : 1}-${s.month.slice(5)}` }))
    assert.ok(twoYears.every((s) => s.month.startsWith('2000') || s.month.startsWith('2001')))
    const leave2years = fp.leaveOneYearOut(twoYears)
    assert.ok(leave2years.folds === null && /at least 3 calendar years/.test(leave2years.refusal),
      JSON.stringify(leave2years.refusal))
  })

  it('trains per district from the store and refuses without an archive series', async () => {
    const fp = await fpImport()
    const daily = deterministicDaily(8)
    const events = []
    for (let y = 2005; y <= 2012; y += 1) events.push(floodEvent(y, 7, 20))
    const storeData = {
      climate_observations: [{
        id: 'series1', source: 'open_meteo_archive', region_name: 'Testland', country: 'TL',
        latitude: 0, longitude: 0, observed_at: '2012-12-31T00:00:00.000Z',
        series_start: daily[0].date, series_end: daily[daily.length - 1].date,
        series_days: daily.length, days_missing_precipitation: 0, daily,
        metadata: { provider: 'test' },
      }],
      hazard_events: events,
    }
    const { trained, refusals } = fp.trainDistrictModels(storeData, { regions: [{ name: 'Testland', country: 'TL', lat: 0, lon: 0 }] })
    assert.equal(trained.length, 1)
    const model = trained[0]
    assert.ok(model.model && model.model.coefficients.length === 3)
    assert.ok(model.folds.folds.skill_over_base_rate > 0)
    assert.ok(model.contingency.length === 3)
    assert.equal(model.basis === fp.MODEL_BASIS, true)
    assert.ok(model.rainfall.record_id === 'series1')
    // August labels with the same rains each year: base rate must be > 5%.
    assert.ok(model.model.training.base_rate > 0.05)

    const empty = fp.trainDistrictModels({ climate_observations: [], hazard_events: [] },
      { regions: [{ name: 'Nowhere', country: 'NW', lat: 0, lon: 0 }] })
    assert.equal(empty.trained.length, 0)
    assert.match(empty.refusals[0].refusal, /open_meteo_archive/)
  })
})

describe('Lindela Lite flood archive backfill connectors', () => {
  it('gdacs_archive keeps floods, filters other events, and nulls fill-in severity', async () => {
    const { spec } = await import('../src/connectors/gdacs-archive.js')
    const archiveFeature = (eventtype, iso, eventid) => ({
      geometry: { coordinates: [35.0, 3.5] },
      properties: {
        eventtype, iso3: iso, eventid,
        eventname: `Flood ${eventid}`, alertlevel: 'Green',
        fromdate: '2026-01-02T00:00:00Z', todate: '2026-01-09T00:00:00Z',
        severitydata: { severity: 0.0, severitytext: 'Magnitude 0.00' },
      },
    })
    const originalFetch = global.fetch
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ features: [archiveFeature('FL', 'KEN', 1), archiveFeature('FL', 'ESP', 2), archiveFeature('TC', 'KEN', 3)] }) })
    try {
      const { hazard_events, errors } = await spec.ingest({ archive_start_year: new Date().getUTCFullYear() })
      assert.ok(errors.length === 0, errors.join('; '))
      // The stub returns the same quarter's payload for every requested
      // window of the current year: one flood must stay one flood, whichever
      // overlapping window it falls in. Stable ids collapse the walk.
      assert.ok(hazard_events.length >= 1, 'non-FL and non-SSA events must be filtered to floods in SSA')
      assert.equal(new Set(hazard_events.map((r) => r.id)).size, 1,
        `one event across ${hazard_events.length} windows must collapse to one id`)
      const record = hazard_events[0]
      assert.equal(record.source, 'gdacs_archive')
      assert.equal(record.event_type, 'flood')
      assert.equal(record.severity, null, 'a fill-in zero severity is not a measurement')
      assert.equal(record.latitude, 3.5)
      assert.match(record.metadata.geolocation_note, /representative/)
      assert.equal(record.metadata.alert_level, 'Green')
      assert.match(record.metadata.attribution, /Joint Research Centre/)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('validates the gdacs_archive and open_meteo_archive specs and their registration', async () => {
    const { validateConnector } = await import('../src/connectors/spec.js')
    const gdacsSpec = (await import('../src/connectors/gdacs-archive.js')).spec
    const archiveSpec = (await import('../src/connectors/open-meteo-archive.js')).spec
    assert.deepEqual(validateConnector(gdacsSpec), [])
    assert.deepEqual(validateConnector(archiveSpec), [])
    assert.equal(gdacsSpec.id, 'gdacs_archive')
    assert.equal(archiveSpec.id, 'open_meteo_archive')

    const schema = await import('../src/schema.js')
    assert.ok(schema.SOURCE_IDS.includes('gdacs_archive'))
    assert.ok(schema.SOURCE_IDS.includes('open_meteo_archive'))
    const catalog = schema.publicSourceCatalog()
    assert.ok(catalog.find((s) => s.id === 'gdacs_archive').outputs.includes('hazard_events'))
    assert.ok(catalog.find((s) => s.id === 'open_meteo_archive').outputs.includes('climate_observations'))
    assert.ok(schema.emptyStore().flood_probability_models, 'emptyStore must declare flood_probability_models')

    const ingestion = await import('../src/ingestion.js')
    const connector = ingestion.getConnector('gdacs_archive')
    assert.equal(typeof connector.ingest, 'function')
    assert.equal(typeof ingestion.getConnector('open_meteo_archive').ingest, 'function')
    assert.ok(ingestion.SOURCE_POLICIES.gdacs_archive.regular === false)
    assert.ok(ingestion.SOURCE_POLICIES.open_meteo_archive.regular === false)
    // The crawls must never ride a default ingestion run: a default run that
    // re-walks 40 years of a free archive is the exact abuse the policy exists
    // to prevent.
    assert.ok(!ingestion.PUBLIC_INGESTION_SOURCES.includes('gdacs_archive'))
    assert.ok(!ingestion.PUBLIC_INGESTION_SOURCES.includes('open_meteo_archive'))
  })

  it('open_meteo_archive preserves null days and states the reanalysis limit', async () => {
    const { spec } = await import('../src/connectors/open-meteo-archive.js')
    const originalFetch = global.fetch
    global.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ daily: { time: ['2026-01-01', '2026-01-02', '2026-01-03'], precipitation_sum: [1.4, null, 0] } }),
    })
    try {
      const { climate_observations, errors } = await spec.ingest({ archive_start_date: '2026-01-01', archive_end_date: '2026-01-03' })
      assert.ok(errors.length === 0, errors.join('; '))
      const record = climate_observations[0]
      assert.equal(record.source, 'open_meteo_archive')
      assert.equal(record.series_days, 3)
      assert.deepEqual(record.daily, [
        { date: '2026-01-01', precipitation_mm: 1.4 },
        { date: '2026-01-02', precipitation_mm: null },
        { date: '2026-01-03', precipitation_mm: 0 },
      ])
      assert.equal(record.days_missing_precipitation, 1)
      assert.match(record.metadata.model_limit, /not gauge observations/)
      assert.match(record.metadata.provider, /ERA5/)
      assert.match(record.series_end, /2026-01-03/)
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('Lindela Lite flood probability API', () => {
  it('trains from the store, scores with the model card, and refuses cleanly', async () => {
    const fp = await import('../src/flood-probability.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-floodprob-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const daily = []
    const events = []
    const start = Date.UTC(2005, 0, 1)
    for (let t = start; t <= Date.UTC(2013, 11, 31); t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10)
      const month = new Date(t).getUTCMonth()
      const day = new Date(t).getUTCDate()
      let mm = 2
      if (month >= 5 && month <= 8) mm = 12
      if (month === 7) mm = 25
      if (month === 7 && day >= 14 && day <= 20) mm = 60
      daily.push({ date, precipitation_mm: mm })
      if (month === 7 && day === 20) {
        events.push({ id: `ev${date}`, event_type: 'flood', country: 'TL', latitude: 0.3, longitude: 0.3, occurred_at: date })
      }
    }
    await store.merge({
      climate_observations: [{
        id: 'series1', source: 'open_meteo_archive', region_name: 'Testland', country: 'TL',
        latitude: 0, longitude: 0, observed_at: '2013-12-31T00:00:00.000Z',
        series_start: daily[0].date, series_end: daily[daily.length - 1].date,
        series_days: daily.length, days_missing_precipitation: 0, daily,
        metadata: { provider: 'test' },
      }],
      hazard_events: events,
    })

    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      const trainRes = await fetch(`${baseUrl}/api/v1/flood-probability/train`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ regions: [{ name: 'Testland', country: 'TL', lat: 0, lon: 0 }] }),
      })
      const trained = await trainRes.json()
      assert.equal(trainRes.status, 200)
      assert.ok(trained.success)
      assert.equal(trained.data.length, 1)
      assert.deepEqual(trained.refusals, [])
      // The trained card lands in the store with its basis and provenance.
      assert.match(trained.data[0].basis.basis, /empirical/)
      assert.equal(trained.data[0].rainfall.record_id, 'series1')

      const listed = await (await fetch(`${baseUrl}/api/v1/flood-probability/models`)).json()
      assert.equal(listed.data.length, 1)

      // A wet-season month end: features at or above every training band.
      const scored = await (await fetch(`${baseUrl}/api/v1/flood-probability/score?max_7_day=420&sum_30_day=300&sum_90_day=700&region=Testland`)).json()
      assert.equal(scored.success, true)
      assert.equal(scored.scored, true)
      assert.ok(scored.data.probability > 0.5, `wet month scores ${scored.data.probability}`)
      assert.match(scored.data.basis.basis, /empirical/)
      assert.ok(scored.data.model.training.months >= 60)
      assert.ok(scored.data.folds.folds.skill_over_base_rate !== null)

      // A dry-season month end stays low but is still a number on the sample.
      const dry = await (await fetch(`${baseUrl}/api/v1/flood-probability/score?max_7_day=14&sum_30_day=60&sum_90_day=180`)).json()
      assert.ok(dry.scored && dry.data.probability < scored.data.probability)

      // No model for another district: refusal, not an error.
      const none = await (await fetch(`${baseUrl}/api/v1/flood-probability/score?max_7_day=1&sum_30_day=1&sum_90_day=1&region=Nowhere`)).json()
      assert.equal(none.scored, false)
      assert.match(none.refusal, /no trained flood-probability model for Nowhere/)

      // Missing features are a bad request, not a silent default.
      const bad = await fetch(`${baseUrl}/api/v1/flood-probability/score?max_7_day=1`)
      assert.equal(bad.status, 400)
      // MODEL_BASIS must travel with a scored response, and predict must
      // refuse non-finite features inside the model module as well.
      const { predict } = fp
      assert.equal(predict(trained.data[0].model, { max_7_day: NaN, sum_30_day: 1, sum_90_day: 1 }), null)
    } finally {
      listener.close()
    }
  })
})

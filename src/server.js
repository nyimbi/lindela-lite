import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshAnalytics } from './analytics.js'
import { runIngestion } from './ingestion.js'
import { publicSourceCatalog } from './schema.js'
import { createStoreFromEnv } from './storage.js'
import { filterRecords, jsonResponse, readRequestJson, toCsv, toGeoJson } from './utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(__dirname, '../public')
let defaultStorePromise

export function createServer(options = {}) {
  const storeProvider = options.store ? Promise.resolve(options.store) : getDefaultStore()
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      if (url.pathname.startsWith('/api/v1/')) {
        await handleApi(await storeProvider, req, res, url)
        return
      }
      await handleStatic(res, url.pathname)
    } catch (error) {
      jsonResponse(res, error.statusCode || 500, {
        success: false,
        error: error.message || 'Internal server error',
      })
    }
  })
}

async function handleApi(store, req, res, url) {
  if (process.env.LINDELA_LITE_API_KEY && req.method !== 'GET') {
    if (req.headers['x-api-key'] !== process.env.LINDELA_LITE_API_KEY) {
      jsonResponse(res, 401, { success: false, error: 'Invalid API key' })
      return
    }
  }

  const data = await store.read()

  if (req.method === 'GET' && url.pathname === '/api/v1/health') {
    jsonResponse(res, 200, {
      success: true,
      status: 'ok',
      updated_at: data.updated_at,
      counts: counts(data),
      sources: publicSourceCatalog().map((source) => source.id),
      exclusions: ['gdelt'],
      storage: { mode: store.mode || 'custom' },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/sources') {
    jsonResponse(res, 200, {
      success: true,
      data: publicSourceCatalog().map((source) => ({
        ...source,
        last_run: data.source_runs.find((run) => run.source === source.id) || null,
      })),
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/ingest/run') {
    const body = await readRequestJson(req)
    const ingestion = await runIngestion(store, body)
    const analytics = await refreshAnalytics(store)
    jsonResponse(res, 200, {
      success: true,
      source_runs: ingestion.source_runs,
      counts: ingestion.counts,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/events') {
    const records = [...data.hazard_events, ...data.conflict_events]
    jsonResponse(res, 200, { success: true, data: filterRecords(records, url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/climate') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.climate_observations, url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/flood-risk') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.risk_scores.filter((risk) => risk.type === 'flood_risk'), url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/conflict-risk') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.risk_scores.filter((risk) => risk.type === 'climate_conflict_risk'), url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/service-impacts') {
    jsonResponse(res, 200, { success: true, data: filterRecords(data.impact_assessments, url.searchParams) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/assessments') {
    jsonResponse(res, 200, {
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        counts: counts(data),
        flood_risk: filterRecords(data.risk_scores.filter((risk) => risk.type === 'flood_risk'), url.searchParams),
        climate_conflict_risk: filterRecords(data.risk_scores.filter((risk) => risk.type === 'climate_conflict_risk'), url.searchParams),
        service_impacts: filterRecords(data.impact_assessments, url.searchParams),
        recent_events: filterRecords([...data.hazard_events, ...data.conflict_events], url.searchParams),
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/export.geojson') {
    const records = filterRecords([...data.hazard_events, ...data.conflict_events, ...data.service_assets, ...data.risk_scores, ...data.impact_assessments], url.searchParams)
    jsonResponse(res, 200, toGeoJson(records), { 'content-type': 'application/geo+json; charset=utf-8' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/export.csv') {
    const records = filterRecords([...data.hazard_events, ...data.conflict_events, ...data.risk_scores, ...data.impact_assessments], url.searchParams)
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="lindela-lite-export.csv"',
    })
    res.end(toCsv(records))
    return
  }

  jsonResponse(res, 404, { success: false, error: 'Not found' })
}

async function handleStatic(res, pathname) {
  const target = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const safeTarget = path.normalize(target).replace(/^(\.\.(\/|\\|$))+/, '')
  const filePath = path.join(publicDir, safeTarget)
  try {
    const content = await fs.readFile(filePath)
    res.writeHead(200, { 'content-type': contentType(filePath) })
    res.end(content)
  } catch {
    const index = await fs.readFile(path.join(publicDir, 'index.html'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(index)
  }
}

function getDefaultStore() {
  if (!defaultStorePromise) defaultStorePromise = createStoreFromEnv()
  return defaultStorePromise
}

function counts(data) {
  return {
    source_runs: data.source_runs.length,
    climate_observations: data.climate_observations.length,
    hazard_events: data.hazard_events.length,
    conflict_events: data.conflict_events.length,
    service_assets: data.service_assets.length,
    impact_assessments: data.impact_assessments.length,
    risk_scores: data.risk_scores.length,
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  return 'text/html; charset=utf-8'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.LINDELA_LITE_PORT || 4177)
  createServer().listen(port, () => {
    console.log(`Lindela Lite listening on http://127.0.0.1:${port}`)
  })
}

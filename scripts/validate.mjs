import fs from 'node:fs'

const jsonFiles = [
  'examples/trigger-protocols/flood-watch.json',
  'examples/trigger-protocols/climate-conflict-watch.json',
  'examples/trigger-protocols/service-impact-watch.json',
  'examples/trigger-protocols/intervention-response-watch.json',
]

for (const file of jsonFiles) {
  JSON.parse(fs.readFileSync(file, 'utf8'))
}

const openapi = fs.readFileSync('docs/openapi.yaml', 'utf8')
const platform = fs.readFileSync('docs/platform.md', 'utf8')
const docsIndex = fs.readFileSync('docs/README.md', 'utf8')
const deployment = fs.readFileSync('docs/deployment.md', 'utf8')
const architecture = fs.readFileSync('docs/architecture.md', 'utf8')
const dataModel = fs.readFileSync('docs/data-model.md', 'utf8')
const ingestion = fs.readFileSync('docs/ingestion.md', 'utf8')
const dashboard = fs.readFileSync('docs/dashboard.md', 'utf8')
const configuration = fs.readFileSync('docs/configuration.md', 'utf8')
const runbook = fs.readFileSync('docs/runbook.md', 'utf8')
const developerGuide = fs.readFileSync('docs/developer-guide.md', 'utf8')

for (const requiredDoc of [
  'Platform Guide',
  '/api/v1/ingest/status',
  '/api/v1/report-schedules/run-due',
  'RapidPro',
  'Storage',
  'Troubleshooting',
]) {
  if (!platform.includes(requiredDoc)) throw new Error(`Platform guide missing ${requiredDoc}`)
}

for (const requiredLink of [
  '(platform.md)',
  '(architecture.md)',
  '(data-model.md)',
  '(ingestion.md)',
  '(api.md)',
  '(dashboard.md)',
  '(configuration.md)',
  '(deployment.md)',
  '(runbook.md)',
  '(storage.md)',
  '(rapidpro.md)',
  '(developer-guide.md)',
  '(open-source-boundary.md)',
  '(flood-probability-model-basis.md)',
]) {
  if (!docsIndex.includes(requiredLink)) throw new Error(`Docs index missing ${requiredLink}`)
}

const requiredDocSections = [
  [architecture, 'Request Lifecycle', 'architecture guide'],
  [architecture, 'Scheduling Model', 'architecture guide'],
  [dataModel, 'Collection Reference', 'data model guide'],
  [dataModel, 'Relationships', 'data model guide'],
  [ingestion, 'Source Health', 'ingestion guide'],
  [ingestion, 'Regular Ingestion Schedules', 'ingestion guide'],
  [dashboard, 'API Key Field', 'dashboard guide'],
  [dashboard, 'GeoJSON Viewer', 'dashboard guide'],
  [configuration, 'Core Server', 'configuration guide'],
  [configuration, 'RapidPro', 'configuration guide'],
  [runbook, 'Daily Checks', 'runbook'],
  [runbook, 'Backups', 'runbook'],
  [developerGuide, 'Adding A Connector', 'developer guide'],
  [developerGuide, 'Adding An API Endpoint', 'developer guide'],
]

for (const [doc, requiredSection, label] of requiredDocSections) {
  if (!doc.includes(requiredSection)) throw new Error(`${label} missing ${requiredSection}`)
}

for (const requiredDeploymentDetail of [
  './deploy/one-click.sh',
  'docker compose up -d --build',
  'LINDELA_LITE_API_KEY',
  'POST /api/v1/ingest/run-due',
  'POST /api/v1/report-schedules/run-due',
]) {
  if (!deployment.includes(requiredDeploymentDetail)) throw new Error(`Deployment guide missing ${requiredDeploymentDetail}`)
}

for (const endpoint of [
  '/api/v1/health',
  '/api/v1/sources',
  '/api/v1/ingest/run',
  '/api/v1/ingest/status',
  '/api/v1/ingest/schedules',
  '/api/v1/ingest/schedules/defaults',
  '/api/v1/ingest/schedules/{id}',
  '/api/v1/ingest/schedules/{id}/run',
  '/api/v1/ingest/run-due',
  '/api/v1/service-assets',
  '/api/v1/data-quality',
  '/api/v1/operations/summary',
  '/api/v1/incidents',
  '/api/v1/interventions',
  '/api/v1/tasks',
  '/api/v1/field-reports',
  '/api/v1/response-resources',
  '/api/v1/action-logs',
  '/api/v1/alert-rules',
  '/api/v1/alerts/evaluate',
  '/api/v1/alert-events',
  '/api/v1/rapidpro/status',
  '/api/v1/rapidpro/alert-events/{id}/send',
  '/api/v1/rapidpro/field-report',
  '/api/v1/rapidpro/dispatches',
  '/api/v1/rapidpro/inbound',
  '/api/v1/report-templates',
  '/api/v1/report-templates/{id}',
  '/api/v1/report-templates/{id}/copy',
  '/api/v1/reports',
  '/api/v1/reports/{id}',
  '/api/v1/reports/{id}/generate',
  '/api/v1/reports/{id}/approve',
  '/api/v1/reports/{id}/distribute',
  '/api/v1/reports/{id}/export.md',
  '/api/v1/reports/{id}/export.json',
  '/api/v1/reports/{id}/export.csv',
  '/api/v1/reports/{id}/export.geojson',
  '/api/v1/report-distributions',
  '/api/v1/report-distributions/{id}',
  '/api/v1/report-distributions/{id}/retry',
  '/api/v1/report-schedules',
  '/api/v1/report-schedules/{id}',
  '/api/v1/report-schedules/{id}/run',
  '/api/v1/report-schedules/run-due',
  '/api/v1/report-schedule-runs',
  '/api/v1/report-schedule-runs/{id}',
  '/api/v1/report-schedule-runs/{id}/retry',
  '/api/v1/events',
  '/api/v1/export.geojson',
  '/api/v1/export.csv',
  '/api/v1/flood-depth',
  '/api/v1/road-access',
  '/api/v1/road-access/summary',
  '/api/v1/routing/plan',
]) {
  if (!openapi.includes(endpoint)) throw new Error(`OpenAPI contract missing ${endpoint}`)
}

// Schemas the hazard and access responses depend on. These are named in
// $ref from the paths above, so a rename would silently break any generated
// client while the paths themselves still validated.
for (const requiredSchema of [
  'FloodDepthGrid:',
  'RiskScore:',
  'RoadAccess:',
  'RoadAccessSummary:',
  'RoutingPlanInput:',
  'RoutingPlan:',
]) {
  if (!openapi.includes(requiredSchema)) throw new Error(`OpenAPI schema missing ${requiredSchema}`)
}

// Every $ref in the spec must resolve. A dangling reference is invisible in
// review and breaks every consumer that resolves the document.
const specRefs = [...openapi.matchAll(/\$ref:\s*'#\/components\/schemas\/([A-Za-z0-9_]+)'/g)].map((m) => m[1])
const declaredSchemas = new Set(
  [...openapi.matchAll(/^ {4}([A-Za-z0-9_]+):$/gm)].map((m) => m[1]),
)
const danglingRefs = [...new Set(specRefs)].filter((name) => !declaredSchemas.has(name))
if (danglingRefs.length) {
  throw new Error(`OpenAPI has dangling schema references: ${danglingRefs.join(', ')}`)
}

// The ingestion guide lists every source with its default policy. This reads
// the real policies from src/ingestion.js rather than a hard-coded copy, so a
// changed interval cannot drift away from the table unnoticed.
const { SOURCE_POLICIES, PUBLIC_INGESTION_SOURCES } = await import('../src/ingestion.js')
for (const sourceId of PUBLIC_INGESTION_SOURCES) {
  const policy = SOURCE_POLICIES[sourceId]
  if (!policy) throw new Error(`Ingestion guide lists ${sourceId} but SOURCE_POLICIES has no entry`)
  const row = `| \`${sourceId}\` | ${policy.interval_minutes} min | ${policy.timeout_ms / 1000} sec | ${policy.retries} | ${policy.stale_after_minutes} min |`
  if (!ingestion.includes(row)) {
    throw new Error(`Ingestion guide policy row is stale or missing for ${sourceId}; expected:\n  ${row}`)
  }
}

// Sources with regular: false have no schedule by default, so the guide should
// not claim one, and the source must still be documented somewhere.
for (const sourceId of Object.keys(SOURCE_POLICIES)) {
  if (SOURCE_POLICIES[sourceId].regular) continue
  if (!ingestion.includes(`\`${sourceId}\``)) {
    throw new Error(`Ingestion guide does not mention non-regular source ${sourceId}`)
  }
}

// The flood-probability model-basis proposal must stay linked and must
// keep saying it is a proposal. If implementation ever lands, this is the
// place that documents the agreed basis, and it should be rewritten rather
// than deleted.
const modelBasis = fs.readFileSync('docs/flood-probability-model-basis.md', 'utf8')
if (!/Status: proposal for review/i.test(modelBasis)) {
  throw new Error('flood-probability-model-basis.md must state its status; a proposal that reads as settled is worse than none')
}

console.log('validation ok')

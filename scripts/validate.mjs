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
]) {
  if (!openapi.includes(endpoint)) throw new Error(`OpenAPI contract missing ${endpoint}`)
}

console.log('validation ok')

import fs from 'node:fs'

const jsonFiles = [
  'examples/trigger-protocols/flood-watch.json',
  'examples/trigger-protocols/climate-conflict-watch.json',
  'examples/trigger-protocols/service-impact-watch.json',
]

for (const file of jsonFiles) {
  JSON.parse(fs.readFileSync(file, 'utf8'))
}

const openapi = fs.readFileSync('docs/openapi.yaml', 'utf8')
for (const endpoint of [
  '/api/v1/health',
  '/api/v1/sources',
  '/api/v1/ingest/run',
  '/api/v1/service-assets',
  '/api/v1/events',
  '/api/v1/export.geojson',
  '/api/v1/export.csv',
]) {
  if (!openapi.includes(endpoint)) throw new Error(`OpenAPI contract missing ${endpoint}`)
}

console.log('validation ok')

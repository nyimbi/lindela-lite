const sourceGrid = document.querySelector('#sourceGrid')
const metrics = document.querySelector('#metrics')
const statusBox = document.querySelector('#status')
const floodRisk = document.querySelector('#floodRisk')
const conflictRisk = document.querySelector('#conflictRisk')
const eventsTable = document.querySelector('#eventsTable')
const map = document.querySelector('#map')
const storageMode = document.querySelector('#storageMode')
const sourceFreshness = document.querySelector('#sourceFreshness')
const serviceAssetInput = document.querySelector('#serviceAssetInput')

const defaultSources = ['open_meteo', 'gdacs', 'glofas', 'chirps', 'nasa_firms']

document.querySelector('#refreshButton').addEventListener('click', refresh)
document.querySelector('#runButton').addEventListener('click', runIngestion)
document.querySelector('#importCsvButton').addEventListener('click', () => importServiceAssets('csv'))
document.querySelector('#importGeoJsonButton').addEventListener('click', () => importServiceAssets('geojson'))
document.querySelector('#exportGeoJsonButton').addEventListener('click', () => open('/api/v1/export.geojson', '_blank'))
document.querySelector('#exportCsvButton').addEventListener('click', () => open('/api/v1/export.csv', '_blank'))

await loadSources()
await refresh()

async function loadSources() {
  const response = await fetch('/api/v1/sources')
  const payload = await response.json()
  sourceGrid.innerHTML = payload.data.map((source) => `
    <label title="${source.name}">
      <input type="checkbox" value="${source.id}" ${defaultSources.includes(source.id) ? 'checked' : ''}>
      <span>${source.id}</span>
    </label>
  `).join('')
  renderFreshness(payload.data)
}

async function runIngestion() {
  setStatus('Running ingestion...')
  const selectedSources = [...sourceGrid.querySelectorAll('input:checked')].map((input) => input.value)
  const body = {
    sources: selectedSources,
    regions: [{
      name: document.querySelector('#regionInput').value,
      country: document.querySelector('#countryInput').value,
      lat: Number(document.querySelector('#latInput').value),
      lon: Number(document.querySelector('#lonInput').value),
    }],
  }
  const response = await fetch('/api/v1/ingest/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (!payload.success) {
    setStatus(payload.error || 'Ingestion failed')
    return
  }
  setStatus(`Ingestion complete. ${payload.source_runs.length} source runs recorded.`)
  await refresh()
}

async function importServiceAssets(kind) {
  setStatus(`Importing service assets as ${kind.toUpperCase()}...`)
  const key = kind === 'geojson' ? 'service_assets_geojson' : 'service_assets_csv'
  const response = await fetch('/api/v1/service-assets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: serviceAssetInput.value }),
  })
  const payload = await response.json()
  if (!payload.success) {
    setStatus((payload.errors || [payload.error]).join(' | '))
    return
  }
  setStatus(`Imported ${payload.imported} service assets.`)
  await refresh()
}

async function refresh() {
  const [health, sources, flood, conflict, events, assets] = await Promise.all([
    fetchJson('/api/v1/health'),
    fetchJson('/api/v1/sources'),
    fetchJson('/api/v1/flood-risk'),
    fetchJson('/api/v1/conflict-risk'),
    fetchJson('/api/v1/events?limit=20'),
    fetchJson('/api/v1/service-assets?limit=100'),
  ])

  storageMode.textContent = `storage: ${health.storage?.mode || 'unknown'}`
  renderMetrics(health.counts || {})
  renderFreshness(sources.data || [])
  renderCards(floodRisk, flood.data || [])
  renderCards(conflictRisk, conflict.data || [])
  renderEvents(events.data || [])
  renderMap([...(flood.data || []), ...(conflict.data || []), ...(events.data || []), ...(assets.data || [])])
  setStatus(`Updated ${new Date().toLocaleString()}. GDELT excluded.`)
}

async function fetchJson(path) {
  const response = await fetch(path)
  return response.json()
}

function renderMetrics(counts) {
  metrics.innerHTML = Object.entries(counts).map(([key, value]) => `
    <div class="metric">
      <span>${key.replaceAll('_', ' ')}</span>
      <strong>${value}</strong>
    </div>
  `).join('')
}

function renderFreshness(sources) {
  sourceFreshness.innerHTML = sources.map((source) => {
    const run = source.last_run
    const label = run ? `${run.status} at ${new Date(run.completed_at).toLocaleString()} (${run.records_processed} records)` : 'not run'
    return `<div class="freshness-row"><strong>${source.id}</strong><span>${label}</span></div>`
  }).join('')
}

function renderCards(container, records) {
  container.innerHTML = records.length ? records.map((record) => `
    <article class="card">
      <h3>${record.region_name || record.type}</h3>
      <p><strong>${record.score}</strong> ${record.risk_level}</p>
      <p>${Object.entries(record.drivers || {}).map(([key, value]) => `${key}: ${value}`).join(' | ')}</p>
    </article>
  `).join('') : '<p class="note">No scores yet. Run ingestion first.</p>'
}

function renderEvents(records) {
  eventsTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${record.event_type || record.type || ''}</td>
      <td>${record.severity || ''}</td>
      <td>${record.title || ''}</td>
      <td>${record.source || ''}</td>
    </tr>
  `).join('') : '<tr><td colspan="4">No events loaded.</td></tr>'
}

function renderMap(records) {
  const plotted = records.filter((record) => Number.isFinite(record.latitude) && Number.isFinite(record.longitude))
  const labels = plotted.map((record) => {
    const x = ((record.longitude + 180) / 360) * 100
    const y = (1 - ((record.latitude + 90) / 180)) * 100
    const level = record.risk_level || record.impact_level || record.severity || 'unknown'
    const label = record.title || record.region_name || record.asset_name || record.name || level
    return `<span class="pin ${level}" style="left:${x}%;top:${y}%" title="${label}"></span>`
  }).join('')
  map.innerHTML = `<div class="graticule-label">${plotted.length || 'No'} geocoded records</div>${labels}`
}

function setStatus(message) {
  statusBox.textContent = message
}

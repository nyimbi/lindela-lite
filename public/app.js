const sourceGrid = document.querySelector('#sourceGrid')
const metrics = document.querySelector('#metrics')
const statusBox = document.querySelector('#status')
const floodRisk = document.querySelector('#floodRisk')
const conflictRisk = document.querySelector('#conflictRisk')
const eventsTable = document.querySelector('#eventsTable')
const map = document.querySelector('#map')

const defaultSources = ['open_meteo', 'gdacs', 'glofas', 'chirps', 'nasa_firms']

document.querySelector('#refreshButton').addEventListener('click', refresh)
document.querySelector('#runButton').addEventListener('click', runIngestion)

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

async function refresh() {
  const [health, flood, conflict, events] = await Promise.all([
    fetchJson('/api/v1/health'),
    fetchJson('/api/v1/flood-risk'),
    fetchJson('/api/v1/conflict-risk'),
    fetchJson('/api/v1/events?limit=20'),
  ])

  renderMetrics(health.counts || {})
  renderCards(floodRisk, flood.data || [])
  renderCards(conflictRisk, conflict.data || [])
  renderEvents(events.data || [])
  renderMap([...(flood.data || []), ...(conflict.data || []), ...(events.data || [])])
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
  map.innerHTML = plotted.map((record) => {
    const x = ((record.longitude + 180) / 360) * 100
    const y = (1 - ((record.latitude + 90) / 180)) * 100
    const level = record.risk_level || record.severity || 'unknown'
    return `<span class="pin ${level}" style="left:${x}%;top:${y}%" title="${record.title || record.region_name || level}"></span>`
  }).join('')
}

function setStatus(message) {
  statusBox.textContent = message
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { emptyStore } from './schema.js'
import { nowIso } from './utils.js'

const COLLECTIONS = [
  'source_runs',
  'climate_observations',
  'hazard_events',
  'conflict_events',
  'service_assets',
  'impact_assessments',
  'risk_scores',
]

export class JsonStore {
  constructor(filePath = process.env.LINDELA_LITE_STORE || path.resolve('data/lindela-lite-store.json')) {
    this.filePath = filePath
  }

  async read() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return { ...emptyStore(), ...parsed }
    } catch (error) {
      if (error.code === 'ENOENT') return emptyStore()
      throw error
    }
  }

  async write(data) {
    const next = { ...emptyStore(), ...data, updated_at: nowIso() }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  async merge(partial) {
    const current = await this.read()
    const next = { ...current }
    for (const collection of COLLECTIONS) {
      const incoming = partial[collection] || []
      if (!incoming.length) continue
      next[collection] = mergeById(current[collection] || [], incoming)
    }
    return this.write(next)
  }

  async replaceAnalytics({ risk_scores = [], impact_assessments = [] }) {
    const current = await this.read()
    return this.write({
      ...current,
      risk_scores,
      impact_assessments,
    })
  }
}

function mergeById(existing, incoming) {
  const map = new Map()
  for (const item of existing) map.set(item.id, item)
  for (const item of incoming) map.set(item.id, { ...map.get(item.id), ...item })
  return [...map.values()].sort((a, b) => String(b.updated_at || b.observed_at || b.occurred_at || '').localeCompare(String(a.updated_at || a.observed_at || a.occurred_at || '')))
}

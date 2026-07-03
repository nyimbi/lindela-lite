import fs from 'node:fs/promises'
import path from 'node:path'
import { emptyStore } from './schema.js'
import { nowIso } from './utils.js'

export const COLLECTIONS = [
  'source_runs',
  'ingestion_schedules',
  'climate_observations',
  'hazard_events',
  'conflict_events',
  'service_assets',
  'impact_assessments',
  'risk_scores',
  'data_quality',
  'population_at_risk',
  'facilities_at_risk',
  'data_lineage',
  'incidents',
  'interventions',
  'intervention_tasks',
  'field_reports',
  'response_resources',
  'action_logs',
  'alert_rules',
  'alert_events',
  'trigger_protocols',
  'rapidpro_dispatches',
  'rapidpro_inbound_messages',
  'report_templates',
  'reports',
  'report_distribution_runs',
  'report_schedules',
  'report_schedule_runs',
  'events_outbox',
  'webhook_subscriptions',
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

  async replaceAnalytics({ risk_scores = [], impact_assessments = [], data_quality = [], population_at_risk = [], facilities_at_risk = [] }) {
    const current = await this.read()
    return this.write({
      ...current,
      risk_scores,
      impact_assessments,
      data_quality,
      population_at_risk,
      facilities_at_risk,
    })
  }
}

export function mergeById(existing, incoming) {
  const map = new Map()
  const hashMap = new Map()

  for (const item of existing) {
    map.set(item.id, item)
    if (item.payload_hash) {
      if (!hashMap.has(item.payload_hash)) {
        hashMap.set(item.payload_hash, item)
      }
    }
  }

  for (const item of incoming) {
    if (item.payload_hash && hashMap.has(item.payload_hash)) {
      continue
    }
    map.set(item.id, { ...map.get(item.id), ...item })
    if (item.payload_hash) {
      hashMap.set(item.payload_hash, item)
    }
  }

  return [...map.values()].sort((a, b) => recordTimestamp(b).localeCompare(recordTimestamp(a)))
}

function recordTimestamp(record) {
  return String(record.updated_at
    || record.completed_at
    || record.generated_at
    || record.observed_at
    || record.occurred_at
    || record.created_at
    || record.started_at
    || '')
}

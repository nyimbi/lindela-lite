export const MODEL_UNAVAILABLE = Symbol('model-unavailable')

export function createRegistry({ maxEntries = 1024 } = {}) {
  const store = new Map()
  return {
    register(d) {
      if (!d || !d.id || !d.version) throw new Error('registry requires {id, version}')
      const key = d.id + '::' + d.version
      if (store.has(key)) throw new Error('registry: duplicate ' + key)
      if (store.size >= maxEntries) throw new Error('registry full')
      store.set(key, Object.freeze({ ...d, key }))
    },
    has(id, version) { return store.has(id + '::' + version) },
    get(id, version) { const r = store.get(id + '::' + version); return r ? r : MODEL_UNAVAILABLE },
    byCapability(c) { return Array.from(store.values()).filter((d) => d.capability === c) },
    list() { return Array.from(store.values()) },
    size() { return store.size },
  }
}

export async function runShadowDue({ registry, records, state, runShadow, minIntervalMs = 15 * 60 * 1000, now = Date.now() }) {
  if (state && typeof state.lastRunMs === 'number' && now - state.lastRunMs < minIntervalMs) {
    return { results: [], action_logs: [], skipped: true }
  }
  const shadows = registry.byCapability('shadow')
  const out = { results: [], action_logs: [], skipped: false }
  for (const m of shadows) {
    if (!m || m.status !== 'active') continue
    const r = runShadow(records || [], {
      model_id: m.id, model_version: m.version,
      algorithm_version: m.algorithm_version, threshold: m.threshold,
      features: m.features, mode: 'shadow', weights: m.weights, bias: m.bias,
    })
    out.results.push(...r.results)
    out.action_logs.push(...r.action_logs)
  }
  if (state) state.lastRunMs = now
  return out
}

export const ENV_FLAG = 'LITE_SHADOW_MODELS'

export function plannedModelsFromEnv(env = process.env) {
  const raw = env ? env[ENV_FLAG] : undefined
  if (typeof raw !== 'string' || raw.length === 0) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}
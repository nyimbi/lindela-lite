const LOG_LEVEL = process.env.LINDELA_LITE_LOG_LEVEL || 'info'
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

export const logger = {
  info: (event, fields = {}) => logEvent('info', event, fields),
  warn: (event, fields = {}) => logEvent('warn', event, fields),
  error: (event, fields = {}) => logEvent('error', event, fields),
}

function logEvent(level, event, fields) {
  if (LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return
  const log = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  }
  console.error(JSON.stringify(log))
}

const metricsStore = {
  counters: new Map(),
  histograms: new Map(),
}

export const metrics = {
  counter: (name, labels = {}) => {
    const key = buildMetricKey(name, labels)
    if (!metricsStore.counters.has(key)) {
      metricsStore.counters.set(key, { name, labels, value: 0 })
    }
    const entry = metricsStore.counters.get(key)
    entry.value += 1
    return entry.value
  },

  histogram: (name, valueMs, labels = {}) => {
    const key = buildMetricKey(name, labels)
    if (!metricsStore.histograms.has(key)) {
      metricsStore.histograms.set(key, {
        name,
        labels,
        values: [],
        buckets: [5, 25, 100, 500, 2000, 10000],
      })
    }
    const entry = metricsStore.histograms.get(key)
    entry.values.push(valueMs)
  },

  render: () => {
    let output = '# HELP process_up Server is running\n# TYPE process_up gauge\nprocess_up 1\n\n'

    for (const [, entry] of metricsStore.counters) {
      const labels = formatLabels(entry.labels)
      output += `# HELP ${entry.name} Counter metric\n`
      output += `# TYPE ${entry.name} counter\n`
      output += `${entry.name}${labels} ${entry.value}\n\n`
    }

    for (const [, entry] of metricsStore.histograms) {
      const labels = formatLabels(entry.labels)
      output += `# HELP ${entry.name} Histogram metric\n`
      output += `# TYPE ${entry.name} histogram\n`

      const buckets = new Map()
      for (const bucket of entry.buckets) {
        buckets.set(bucket, 0)
      }
      buckets.set('+Inf', 0)

      let sum = 0
      for (const value of entry.values) {
        sum += value
        for (const [bucket, count] of buckets.entries()) {
          if (bucket === '+Inf' || value <= bucket) {
            buckets.set(bucket, count + 1)
          }
        }
      }

      const labelWithLe = labels.slice(0, -1)
      for (const [bucket, count] of buckets) {
        const le = bucket === '+Inf' ? '+Inf' : bucket.toString()
        const fullLabels = labelWithLe + (labelWithLe.length > 1 ? ',' : '') + `le="${le}"}`
        output += `${entry.name}_bucket${fullLabels} ${count}\n`
      }

      output += `${entry.name}_sum${labels} ${sum}\n`
      output += `${entry.name}_count${labels} ${entry.values.length}\n\n`
    }

    return output
  },
}

export function timer() {
  const start = Date.now()
  return {
    end: () => Date.now() - start,
  }
}

function buildMetricKey(name, labels) {
  return `${name}:${JSON.stringify(labels)}`
}

function formatLabels(labels) {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  const pairs = keys.map((k) => `${k}="${labels[k]}"`)
  return `{${pairs.join(',')}}`
}

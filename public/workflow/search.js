/**
 * Record search for the command palette.
 *
 * JTBD-091 is marked Missing: "Without search, operators must scan full lists
 * to locate specific records." The palette that already existed searched
 * actions — a list of about fifteen things the console can do — so it found
 * every button and no records.
 *
 * The index is built once per palette open from five collections, bounded at
 * 200 records each. It is a client-side scan rather than a server query
 * because no endpoint accepts a free-text term, and adding one is a change to
 * src/ that this work does not own. The limit is stated on the results, because
 * a search that silently covers the first 200 of 4,000 assets will confidently
 * report "no match" for a record that exists.
 */

import { apiFetch } from '/shared/runtime.js'
import { truncate } from '/shared/fmt.js'

/** Each collection the palette can find a record in, and how to name one. */
const SOURCES = [
  {
    key: 'alert_event',
    label: 'Alert events',
    icon: '!',
    path: '/api/v1/alert-events?limit=200',
    name: (r) => r.rule_name || r.message || r.id,
    extra: (r) => [r.id, r.metric, r.status, r.severity],
  },
  {
    key: 'incident',
    label: 'Incidents',
    icon: '#',
    path: '/api/v1/incidents?limit=200',
    name: (r) => r.title || r.id,
    extra: (r) => [r.id, r.incident_type, r.status, r.priority, r.country],
  },
  {
    key: 'intervention',
    label: 'Interventions',
    icon: '>',
    path: '/api/v1/interventions?limit=200',
    name: (r) => r.title || r.id,
    extra: (r) => [r.id, r.status, r.lead_org],
  },
  {
    key: 'service_asset',
    label: 'Service assets',
    icon: '□',
    path: '/api/v1/service-assets?limit=200',
    name: (r) => r.name || r.id,
    extra: (r) => [r.id, r.service_type, r.country, r.district],
  },
  {
    key: 'workflow_instance',
    label: 'Workflows',
    icon: 'w',
    path: '/api/v1/workflows?limit=200',
    name: (r) => `${r.type} ${String(r.state || '').replace(/_/g, ' ')}`.trim(),
    extra: (r) => [r.id, r.type, r.state, r.owner, r.district, r.subject_id],
  },
]

let index = null
let loading = null
let builtAt = 0
/** Collections whose fetch failed, so the note can name them. */
const failed = new Set()

/**
 * How stale the index is allowed to get.
 *
 * A minute. Long enough that holding Cmd+K twice in a row does not cost ten
 * requests, short enough that an operator who creates an incident and searches
 * for it a moment later finds it — the failure this feature exists to fix is an
 * operator concluding a record is not there.
 */
const TTL_MS = 60_000

/**
 * Build the index, or return the one already built.
 */
export function recordIndex({ rebuild = false } = {}) {
  const fresh = index && (Date.now() - builtAt) < TTL_MS
  if (fresh && !rebuild) return index
  if (loading && !rebuild) return loading
  loading = (async () => {
    const settled = await Promise.all(SOURCES.map(async (source) => {
      try {
        const payload = await apiFetch(source.path)
        failed.delete(source.key)
        return (payload?.data || []).map((record) => toItem(source, record))
      } catch (err) {
        console.error(`Palette search could not read ${source.key}:`, err)
        failed.add(source.key)
        return []
      }
    }))
    index = settled.flat()
    builtAt = Date.now()
    loading = null
    return index
  })()
  return loading
}

function toItem(source, record) {
  const name = source.name(record) || record.id
  return {
    icon: source.icon,
    label: `${source.label}: ${truncate(String(name), { max: 60 })}`,
    category: source.label,
    // Every field an operator might know the record by, so searching a district
    // or a status finds the record as well as searching its name does.
    haystack: [record.id, name, ...source.extra(record)].join(' ').toLowerCase(),
    action: () => openSubjectFor(source.key, record),
  }
}

// Set by app.js so this module does not import app.js, which imports this one.
let openSubject = () => {}

function openSubjectFor(kind, record) {
  openSubject({ kind, id: record.id })
}

export function bindSubjectOpener(fn) {
  openSubject = fn
}

export function searchingFor(query) {
  if (!index) return []
  const q = query.trim().toLowerCase()
  if (!q) return []
  return index.filter((item) => item.haystack.includes(q)).slice(0, 25)
}

/**
 * What the palette should say when the answer is empty.
 *
 * Silence reads as "no such record". It may instead be that a collection failed
 * to load, or that the record sits past the 200-record bound.
 */
export function searchCaveat(query) {
  if (!query.trim()) return ''
  const notes = []
  if (failed.size) {
    notes.push(`${[...failed].join(', ')} could not be read, so records there are missing from these results`)
  }
  notes.push(`searched the first 200 records of each collection, client-side`)
  return notes.join(' · ')
}

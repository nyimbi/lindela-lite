#!/usr/bin/env node
/**
 * ENH-59. Regenerates `ROUTE_MANIFESTS` and `WIDE_ROUTES` in
 * `src/route-manifests.js` from `src/route-declaration.js`.
 *
 * Everything that is not one of those two tables is carried through verbatim:
 * the file's own docblock, `UNMAPPED_COUNT`, `HISTORY_ROUTES`, and the six
 * functions below them. They are logic and prose about the tables, not tables.
 *
 * The emitted order is a plain sort of the keys, and that is a decision worth
 * recording: `matchRouteKey` resolves a request by *specificity score*, not by
 * iteration order, so the hand-made order the file used to carry was latent
 * behaviour nothing depended on. That was measured rather than assumed — over
 * all 965 (method, served path) pairs, the current order and the sorted order
 * resolve to the same key. A generator that preserved an order it cannot
 * reconstruct would be a generator that only works on the file it was written
 * against.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const FILE = 'src/route-manifests.js'

/** Spec paths use `{name}`; these tables use `:name`. */
export function toColon(specPath) {
  return specPath.replace(/\{([^}]+)\}/g, ':$1')
}

/**
 * The spelling the table keys on, when it differs from the spec's.
 *
 * The tile routes are the case: the spec names the captures `{z}/{x}/{y}` and
 * the matcher names them `:id/:id/:id`, because a regex group has no way to say
 * what it means. The table keeps the matcher's spelling, so the declaration
 * carries both and this maps one to the other.
 */
export const TABLE_SPELLING = [
  ['GET /api/v1/basemap/tiles/osm/{z}/{x}/{y}.png', 'GET /api/v1/basemap/tiles/osm/:id/:id/:id.png'],
  ['GET /api/v1/basemap/tiles/carto/{z}/{x}/{y}.png', 'GET /api/v1/basemap/tiles/carto/:id/:id/:id.png'],
  ['GET /stac/collections/{id}/items/{id2}', 'GET /stac/collections/:id/items/:id'],
]

/** One table entry, as the lines that write it. */
function entryLines(key, { indent = '  ', notes = null, value = null } = {}) {
  const out = []
  if (notes) for (const n of notes) out.push(n === '' ? `${indent}//` : `${indent}// ${n}`)
  if (value === null) {
    out.push(`${indent}'${key}',`)
  } else {
    // The collection lists are short and read as prose; `["a", "b"]` matches the
    // hand-kept file, where `JSON.stringify`'s `["a","b"]` would rewrite every
    // one of the 120 rows for a whitespace difference.
    const list = value.map((v) => JSON.stringify(v)).join(', ')
    out.push(`${indent}'${key}': Object.freeze([${list}]),`)
  }
  return out
}

/**
 * @returns {{ source: string, measured: number, wide: number }}
 */
export function generateRouteManifests({ root = ROOT, write = true } = {}) {
  const target = path.join(root, FILE)
  const current = fs.readFileSync(target, 'utf8')
  const lines = current.split('\n')

  const at = (needle) => {
    const i = lines.findIndex((l) => l.includes(needle))
    if (i < 0) throw new Error(`generate-route-manifests: no ${JSON.stringify(needle)}`)
    return i
  }

  const prologueEnd = at('export const ROUTE_MANIFESTS')

  // The region between the two tables: the docblock that explains `WIDE_ROUTES`
  // ("Routes left on the whole-store read, and why", with its three groups).
  // It sits above the table rather than above any key, so a generator that only
  // collected per-key comments would drop it.
  const betweenStart = (() => {
    let i = lines.findIndex((l, n) => n > prologueEnd && l.trim() === '})')
    if (i < 0) throw new Error('generate-route-manifests: no end of ROUTE_MANIFESTS')
    i += 1
    while (i < lines.length && lines[i].trim() === '') i += 1
    return i
  })()
  const betweenEnd = at('export const WIDE_ROUTES')

  const unmappedAt = at('export const UNMAPPED_COUNT')
  // The docblock that explains `UNMAPPED_COUNT` is the comment run above it.
  let unmappedBlock = unmappedAt
  while (unmappedBlock > 0 && lines[unmappedBlock - 1].trim().startsWith('*')) unmappedBlock -= 1
  if (unmappedBlock > 0 && lines[unmappedBlock - 1].trim().startsWith('/**')) unmappedBlock -= 1

  const historyAt = at('const HISTORY_ROUTES = new Set([')
  let historyBlock = historyAt
  while (historyBlock > 0 && lines[historyBlock - 1].trim().startsWith('*')) historyBlock -= 1
  if (historyBlock > 0 && lines[historyBlock - 1].trim().startsWith('/**')) historyBlock -= 1

  const epilogueAt = at('/** True when this request')

  return import(path.join(root, 'src/route-declaration.js')).then(({ ROUTE_DECLARATION }) => {
    const alias = new Map(TABLE_SPELLING)
    const measured = new Map()
    const wide = new Map()

    for (const e of ROUTE_DECLARATION) {
      const specKey = `${e.method} ${e.path}`
      const key = alias.get(specKey) ?? `${e.method} ${toColon(e.path)}`
      const notes = e.notes ?? null
      if (e.wide) wide.set(key, notes)
      else measured.set(key, { notes, reads: e.reads })
    }

    const out = lines.slice(0, prologueEnd)

    out.push('export const ROUTE_MANIFESTS = Object.freeze({')
    for (const key of [...measured.keys()].sort()) {
      const { notes, reads } = measured.get(key)
      out.push(...entryLines(key, { notes, value: reads }))
    }
    out.push('})')

    out.push('')
    out.push(...lines.slice(betweenStart, betweenEnd))

    out.push('export const WIDE_ROUTES = Object.freeze([')
    for (const key of [...wide.keys()].sort()) {
      out.push(...entryLines(key, { notes: wide.get(key) }))
    }
    out.push('])')

    out.push(...lines.slice(unmappedBlock, unmappedAt + 1))
    out.push('')
    out.push(...lines.slice(historyBlock, historyAt))
    out.push('const HISTORY_ROUTES = new Set([')
    for (const key of [...measured.keys(), ...wide.keys()].sort()) {
      const e = ROUTE_DECLARATION.find(
        (d) => (alias.get(`${d.method} ${d.path}`) ?? `${d.method} ${toColon(d.path)}`) === key,
      )
      if (e?.history) out.push(`  '${key}',`)
    }
    out.push('])')
    out.push('')
    out.push(...lines.slice(epilogueAt))

    const source = out.join('\n')
    if (write) fs.writeFileSync(target, source)
    return { source, measured: measured.size, wide: wide.size }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateRouteManifests({ write: process.argv.includes('--write') })
    .then(({ measured, wide }) => {
      process.stderr.write(
        `generate-route-manifests: ${measured} measured, ${wide} wide`
        + `${process.argv.includes('--write') ? ' -> src/route-manifests.js' : ' (dry run)'}\n`,
      )
    })
    .catch((error) => {
      process.stderr.write(`${error.stack}\n`)
      process.exit(1)
    })
}

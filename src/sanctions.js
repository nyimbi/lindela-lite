import { fetchWithRetry } from './connectors/http.js'

const SDN_CSV = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV'

const SDN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long a fetched SDN list is kept, from `OFAC_SDN_CACHE_TTL_MS`.
 *
 * `Number(env || 24h)` read a *nonsense* setting as `NaN`, and `Date.now() -
 * loadedAt < NaN` is false, so the cache was never used: every screening
 * downloaded the whole SDN export again. A disbursement loop screens one
 * recipient at a time, so a typo in an env file turned into one ~10 MB fetch
 * per recipient against a service nobody here controls. The failure is silent
 * because nothing about it is wrong-looking — screening still works, only
 * slower, and only under load.
 *
 * A non-positive or unreadable setting is the default, the same direction
 * `queryBudgetLimits` falls: a nonsense value must not become "never cache".
 */
export function sdnCacheTtlMs(env = process.env) {
  const raw = env.OFAC_SDN_CACHE_TTL_MS
  if (raw === undefined || raw === null || String(raw).trim() === '') return SDN_DEFAULT_TTL_MS
  const stated = Number(raw)
  return Number.isFinite(stated) && stated > 0 ? stated : SDN_DEFAULT_TTL_MS
}

/**
 * Minimal OFAC SDN name matcher.
 *
 * Scope: this screens *names* of recipients and counterparties against the
 * published SDN list. It does not resolve blockchain addresses, does not do
 * fuzzy/phonetic matching, and is not a substitute for a compliance review.
 * A match means "a human must look at this", never "this is a criminal".
 */

let cache = null

/**
 * Returns the parsed SDN entries, fetching on first use and caching for TTL.
 */
export async function loadSdnList(options = {}) {
  if (cache && Date.now() - cache.loadedAt < (options.ttlMs ?? sdnCacheTtlMs())) {
    return cache
  }
  const text = await fetchWithRetry(SDN_CSV, {
    timeoutMs: options.timeoutMs || 30000,
    retries: options.retries ?? 2,
  })
  cache = { entries: parseSdnCsv(text), loadedAt: Date.now() }
  return cache
}

/**
 * Parses the OFAC SDN legacy CSV export.
 * Columns: ent_num, SDN_Name, SDN_Type, Program, ... , Country, ..., Remarks
 * SDN_Name may contain commas inside a quoted field, so the first three fields
 * are read by a quote-aware scan rather than `split(',')`.
 *
 * The scan is written out because the regex that used to be here,
 * `/^(\d+),((?:"[^"]*"|[^,])*),([^,]*),/`, *looked* quote-aware and was not.
 * Its `((?:"[^"]*"|[^,])*)` can match a partial quoted run, so on a line with
 * no trailing comma to satisfy the tail the engine backtracked out of the quote
 * and matched `"ANGLO-CARIBBEAN CO.` as the name — dropping `, LTD.` from a
 * person's or company's name with no error. A name is what this module matches
 * on, so a truncated one is a screening that misses the entity it exists to
 * find, and the SDN list is exactly the list whose names carry commas.
 */
export function parseSdnCsv(text) {
  const entries = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    const fields = readCsvFields(line, 3)
    if (fields.length < 3 || !/^\d+$/.test(fields[0])) continue
    entries.push({
      id: fields[0],
      name: fields[1].trim(),
      type: fields[2].trim(),
    })
  }
  return entries
}

/**
 * The first `limit` comma-separated fields of one CSV line, unquoted.
 *
 * A doubled quote inside a quoted field is one literal quote. Stops once it has
 * enough fields, so the remark column — which is free text and may hold an
 * unbalanced quote — cannot affect the three fields read here.
 */
function readCsvFields(line, limit) {
  const fields = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { field += '"'; i += 1 } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      fields.push(field)
      field = ''
      if (fields.length === limit) return fields
    } else {
      field += char
    }
  }
  fields.push(field)
  return fields
}

/**
 * Normalizes a name for comparison: uppercase, collapse punctuation and
 * whitespace, drop corporate suffixes that add no identifying signal.
 */
export function normalizeName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[.,'"\-()]/g, ' ')
    .replace(/\b(INC|LLC|LTD|LIMITED|CORP|CORPORATION|CO|COMPANY|GMBH|SA|SAS|PTE|PLC|NV|BV|AG|KK|OOO)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Screens a single name against the SDN list.
 * Returns { matched, reason, entry }.
 */
export function screenName(name, entries) {
  const target = normalizeName(name)
  if (target.length < 4) return { matched: false, reason: 'name_too_short' }

  for (const entry of entries) {
    const candidate = normalizeName(entry.name)
    if (!candidate || candidate.length < 4) continue
    if (candidate === target) {
      return { matched: true, reason: 'exact_normalized_match', entry }
    }
  }
  return { matched: false, reason: 'no_match' }
}

/**
 * Screens a list of names, returning every match found.
 */
export async function screenNames(names, options = {}) {
  const { entries } = await loadSdnList(options)
  const matches = []
  for (const name of names || []) {
    const result = screenName(name, entries)
    if (result.matched) matches.push({ name, entry: result.entry })
  }
  return { matches, screened: (names || []).length }
}

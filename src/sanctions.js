import { fetchWithRetry } from './connectors/http.js'

const SDN_CSV = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV'

const DEFAULT_TTL_MS = Number(process.env.OFAC_SDN_CACHE_TTL_MS || 24 * 60 * 60 * 1000)

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
  if (cache && Date.now() - cache.loadedAt < (options.ttlMs ?? DEFAULT_TTL_MS)) {
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
 * SDN_Name may contain commas inside a quoted field, so it is matched with a
 * regex rather than split(',') to avoid truncating names like
 * "ANGLO-CARIBBEAN CO., LTD.".
 */
export function parseSdnCsv(text) {
  const entries = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^(\d+),((?:"[^"]*"|[^,])*),([^,]*),/)
    if (!match) continue
    entries.push({
      id: match[1],
      name: match[2].replace(/^"|"$/g, '').replace(/""/g, '"').trim(),
      type: match[3].trim().replace(/^"|"$/g, ''),
    })
  }
  return entries
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

/**
 * Clears the cached SDN list. Used by tests.
 */
export function resetSdnCache() {
  cache = null
}
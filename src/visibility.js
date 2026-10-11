import { isDeleted } from './operations.js'
import { filterRecords } from './utils.js'

/**
 * VUL-03. The one way a by-id route resolves a record.
 *
 * The list form of every collection was scoped and the by-id form was not.
 * `GET /api/v1/reports` returned only the caller's organisation's reports while
 * `GET /api/v1/reports/<someone-else's-id>` returned the other organisation's,
 * because the by-id branch was
 *
 *     data.reports.find((item) => item.id === route.id)
 *
 * — a lookup with no predicate at all. Thirty-one branches across nine handlers
 * had that shape. An id is not a secret: it appears in every listing, in every
 * export and in every link, so this is a per-object authorization gap that holds
 * for an authenticated, scoped caller.
 *
 * The fix is not thirty-one predicates. Thirty-one copies of a predicate is
 * thirty-two chances to write it wrong, and the three `filterRecords` call sites
 * that omitted their context are the proof: scoping that is opt-in is scoping
 * that gets missed. So the predicate lives here once and every by-id branch
 * calls this, which also means a route added later cannot have a by-id form
 * that disagrees with its own listing.
 *
 * `isDeleted` is applied for the caller that asks, not unconditionally: the
 * operational routes accept `?include_deleted=true` and their by-id form has to
 * honour the same switch, or a record the console shows in the archive would
 * 404 on refresh.
 *
 * Returns `null` for "not there, or not yours". The two are the same answer on
 * purpose: a 403 on another organisation's id confirms the id exists, which
 * turns a scoped listing into an id oracle.
 */
export function findVisible(records, id, { includeDeleted = false } = {}) {
  if (!id) return null
  const [record] = filterRecords(records || [], new URLSearchParams(''), {}, { unlimited: true })
    .filter((item) => item.id === id)
  if (!record) return null
  if (!includeDeleted && isDeleted(record)) return null
  return record
}

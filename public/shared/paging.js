// =============================================================
// Lindela Lite — list paging
// =============================================================
// Pure arithmetic, deliberately free of the DOM.
//
// This lived in public/app.js and was exported from there, which meant it could
// not be tested: app.js imports browser-absolute specifiers (`/shared/…`), so a
// Node test runner cannot resolve them and every assertion against this code
// had to be made by driving a browser against whatever the demo store happened
// to hold. On that data no list ever exceeded a page, so the pager rendered
// exactly zero times in any test run.
//
// Paging logic that never shows up under test is paging logic nobody has run.
// It is here so a test can require it directly.

/** Rows per page. 25 keeps the alert rail inside a screen without scrolling. */
export const LIST_PAGE_SIZE = 25

/** Current page per list key, so the rail survives a 30-second refresh. */
const listPages = {}

/**
 * The slice of `total` rows for the current page.
 *
 * The page is clamped rather than trusted: a stored page of 4 against a list
 * that shrank to two pages would otherwise return an empty slice and read as
 * "no results" when there are records and the operator simply scrolled past
 * them.
 */
export function pageWindow(key, total, size = LIST_PAGE_SIZE) {
  const safeTotal = Math.max(0, Number(total) || 0)
  const pages = Math.max(1, Math.ceil(safeTotal / size))
  const page = Math.min(Math.max(1, listPages[key] || 1), pages)
  listPages[key] = page
  const start = (page - 1) * size
  return { page, pages, start, end: Math.min(start + size, safeTotal), total: safeTotal }
}

/** Move to a page. Out-of-range values are ignored rather than clamped, so a
 *  stale control cannot silently move the reader somewhere they did not ask for. */
export function setPage(key, page, total, size = LIST_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / size))
  const next = Number(page)
  if (!Number.isFinite(next) || next < 1 || next > pages) return pageWindow(key, total, size)
  listPages[key] = Math.floor(next)
  return pageWindow(key, total, size)
}

/** Forget every list's page. Tests need it; a reset action may too. */
export function resetPages() {
  for (const key of Object.keys(listPages)) delete listPages[key]
}

/**
 * Walk a paged endpoint to its end, or to a declared cap.
 *
 * ENH-81. Every list route pages properly — `matchedAndPage` returns
 * `next_cursor`, refuses a cursor naming no record, and reports `has_more` — and
 * no client read it. The console fetched `/api/v1/alert-events?limit=30` and
 * paged *inside* that window with `pageWindow`, so on a set of 61 the 31 rows
 * past the fetch were unreachable from any surface. ARC-06 stopped the count
 * from claiming completeness; it did not make the rows reachable.
 *
 * The cap is the part worth being careful about. A walk that stops at its
 * `maxPages` and returns what it holds, saying nothing, is the same defect one
 * layer down — a page that reads as the whole set. So the return value carries
 * `truncated`, and `truncated` is set by two different causes that must not be
 * conflated with "complete":
 *
 *   - the cap was reached with `has_more` still true
 *   - a page failed mid-walk, so the rows after it were never requested
 *
 * Both leave a list that is real and incomplete, which is a thing the operator
 * can be told. `total` comes from the last envelope that reported one, so the
 * pager's "N of M" is the server's M rather than the number of rows this walk
 * happened to accumulate.
 *
 * `fetchPage(path)` is injected rather than imported: this module is DOM-free so
 * it can be tested without a browser, and a walk that called `fetch` itself
 * could only be tested by driving a browser against whatever the demo store
 * held.
 */
export async function fetchAllPages(fetchPage, { path, limit = 200, maxPages = 20 } = {}) {
  const rows = []
  const seen = new Set()
  let cursor = null
  let pages = 0
  let total = null
  let truncated = false

  while (pages < maxPages) {
    const query = `limit=${encodeURIComponent(limit)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const joiner = path.includes('?') ? '&' : '?'
    let envelope
    try {
      envelope = await fetchPage(`${path}${joiner}${query}`)
    } catch {
      // The rows already collected are real and worth showing; the ones after
      // the failure were never asked for. Returning nothing would blank a panel
      // that has data, and returning the rows silently would read as complete.
      return { rows, pages, total: total ?? rows.length, truncated: true, failed: true }
    }
    pages += 1

    const page = Array.isArray(envelope) ? envelope : (envelope?.data || [])
    for (const row of page) {
      // A server that hands back the same record on two pages — a cursor off by
      // one, a set that changed under the walk — must not put it in the list
      // twice. `id` is the store's primary key and every list route returns it.
      const key = row?.id
      if (key !== undefined && seen.has(key)) continue
      if (key !== undefined) seen.add(key)
      rows.push(row)
    }

    if (Array.isArray(envelope)) { cursor = null } else {
      if (Number.isFinite(envelope?.total)) total = envelope.total
      cursor = envelope?.next_cursor || null
      if (envelope?.has_more === false) cursor = null
    }

    if (!cursor) return { rows, pages, total: total ?? rows.length, truncated: false, failed: false }
    if (pages >= maxPages) break
  }

  // Out of the loop with a cursor still in hand: the cap, not the end of the set.
  return { rows, pages, total: total ?? rows.length, truncated: true, failed: false }
}

/**
 * What the pager may *claim*, given what the server actually sent.
 *
 * ARC-06. The list endpoints answer with `{data, returned, total, has_more,
 * next_cursor}`, and the console read only `data`. Everything downstream —
 * `pageWindow`, `renderPager`, `renderAlertsBadge` — was then handed
 * `data.length` as though it were the size of the set. On a feed longer than the
 * fetched page that is two wrong answers at once: the rows past the page are
 * unreachable, because the client pages within a window it already holds and
 * never follows `next_cursor`, and the count reads "Showing all 30" over a set
 * the server says is 61.
 *
 * The distinction this draws is the one the panel copy has to make: a page the
 * server says is complete may be described with its own length, and a page it
 * says is truncated may not. `total` comes from the
 * envelope when present and falls back to the page length — the fallback is for
 * a caller holding a bare array, not a licence to guess.
 *
 * `complete` is deliberately `has_more === false` rather than a truthiness test:
 * an envelope that omits the field has not said the page is complete, and
 * defaulting to "complete" is the exact claim this exists to withhold.
 */
export function listScope(envelope, rows = null) {
  const items = Array.isArray(envelope) ? envelope : (envelope?.data || [])
  const held = Array.isArray(rows) ? rows.length : items.length
  const reported = Array.isArray(envelope) ? undefined : envelope?.total
  const total = Number.isFinite(reported) ? Math.max(reported, held) : held
  // `held`, not `total`, is what the server said this page carries — a filtered
  // list is shorter than the page it was filtered from, and calling that "30 of
  // 61" would be a third wrong number.
  return {
    total,
    held,
    complete: Array.isArray(envelope) ? true : envelope?.has_more === false,
    truncated: Array.isArray(envelope) ? false : envelope?.has_more === true,
  }
}

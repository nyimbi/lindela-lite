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
 * What the pager says, in words.
 *
 * "25 rows" and "all 25 rows" are different facts, and the row count is the
 * only place either appears. A silent cap reads as completeness.
 */
export function pagerSummary({ shown, total }, { noun = 'record' } = {}) {
  if (!total) return ''
  if (shown >= total) return `Showing all ${total} ${total === 1 ? noun : `${noun}s`}.`
  return `Showing ${shown} of ${total} ${noun}${total === 1 ? '' : 's'}.`
}

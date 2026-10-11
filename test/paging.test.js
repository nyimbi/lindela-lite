import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  LIST_PAGE_SIZE, pageWindow, setPage, resetPages, listScope, fetchAllPages,
} from '../public/shared/paging.js'

beforeEach(() => resetPages())

describe('paging', () => {
  it('returns everything when the list fits on one page', () => {
    const w = pageWindow('a', 10)
    assert.deepEqual(w, { page: 1, pages: 1, start: 0, end: 10, total: 10 })
  })

  it('splits a list across pages', () => {
    const w = pageWindow('a', 60)
    assert.equal(w.pages, 3)
    assert.equal(w.start, 0)
    assert.equal(w.end, LIST_PAGE_SIZE)
  })

  it('keeps the page across a refresh, so the rail does not jump back', () => {
    setPage('alerts', 3, 100)
    const w = pageWindow('alerts', 100)
    assert.equal(w.page, 3)
    assert.equal(w.start, 50)
  })

  it('clamps a stored page that now exceeds the page count', () => {
    // A list that shrank while the operator was on page 4 must not render an
    // empty slice and read as "no results".
    setPage('alerts', 4, 100)
    const w = pageWindow('alerts', 12)
    assert.equal(w.page, 1)
    assert.equal(w.end, 12)
  })

  it('ignores a request for a page that does not exist', () => {
    setPage('a', 2, 100)
    const w = setPage('a', 99, 100)
    assert.equal(w.page, 2, 'an out-of-range control does not move the reader')
  })

  it('treats an empty list as one empty page rather than zero', () => {
    const w = pageWindow('a', 0)
    assert.equal(w.pages, 1)
    assert.equal(w.end, 0)
  })

  it('survives a count that is not a number', () => {
    // An API that returns null for a count must not produce NaN pages.
    for (const bad of [null, undefined, NaN, 'many', -5]) {
      const w = pageWindow('a', bad)
      assert.equal(w.pages, 1, `pages for ${bad}`)
      assert.equal(w.total, 0)
    }
  })

  describe('listScope — what a fetched page may claim about the set', () => {
    // ARC-06. Every list route answers with `{data, returned, total, has_more,
    // next_cursor}` and the console read only `data`, so `data.length` was
    // handed to the pager as the size of the set. On `/api/v1/alert-events`
    // against a store of 61 alerts with `?limit=30` that rendered "Showing all
    // 30" and stopped — the other 31 unreachable, because the client pages
    // inside the window it already holds and never follows `next_cursor`.

    const envelope = (over) => ({ data: Array.from({ length: 30 }, (_, i) => ({ id: i })), returned: 30, limit: 30, total: 61, has_more: true, next_cursor: 'x', ...over })

    it('takes the total from the envelope, not the page it was handed', () => {
      const scope = listScope(envelope())
      assert.equal(scope.total, 61, 'the page is 30 rows; the set is 61')
      assert.equal(scope.held, 30)
      assert.equal(scope.truncated, true)
    })

    it('will not call a page complete unless the server said so', () => {
      // `has_more` absent is not `has_more: false`. An envelope that never
      // answered the question has not answered it, and defaulting to complete
      // is precisely the claim this exists to withhold.
      assert.equal(listScope(envelope({ has_more: undefined })).complete, false)
      assert.equal(listScope({ data: [] }).complete, false)
      assert.equal(listScope(envelope({ has_more: false, total: 30 })).complete, true)
    })

    it('reads a bare array as the complete set it is', () => {
      // The equity panel groups districts client-side, so its list really is
      // whole and its own length is the honest total.
      const scope = listScope([1, 2, 3])
      assert.equal(scope.total, 3)
      assert.equal(scope.complete, true)
      assert.equal(scope.truncated, false)
    })

    it('never reports a total smaller than the rows in hand', () => {
      // A filtered list is shorter than the page it came from. Reporting the
      // page's length there would be a second wrong number, and reporting a
      // total below `held` would make the pager render fewer rows than exist.
      const scope = listScope(envelope({ total: 61, has_more: false }), [1, 2, 3, 4, 5])
      assert.equal(scope.held, 5)
      assert.equal(scope.total, 61)
      assert.ok(scope.total >= scope.held)
    })

    it('falls back to the page length when the envelope carries no count', () => {
      assert.equal(listScope({ data: [1, 2, 3] }).total, 3)
      assert.equal(listScope({}).total, 0)
      assert.equal(listScope(null).total, 0)
    })

    it('survives a count that is not a number', () => {
      // The falsy-zero class: a `total` of null must not become NaN pages.
      for (const bad of [null, undefined, NaN, 'many']) {
        assert.equal(listScope(envelope({ total: bad })).total, 30, `total for ${bad}`)
      }
      assert.equal(listScope(envelope({ total: 0 })).total, 30, 'a zero total must not undercut the rows held')
    })
  })

  it('keeps separate lists on separate pages', () => {
    setPage('alerts', 3, 100)
    assert.equal(pageWindow('reports', 100).page, 1,
      'paging the alerts must not move the reports list')
  })
})

describe('ENH-81 — walking a paged endpoint to its end', () => {
  /** A server holding `all`, answering `limit`/`cursor` the way `matchedAndPage` does. */
  const server = (all) => async (path) => {
    const url = new URL(path, 'http://x')
    const limit = Number(url.searchParams.get('limit'))
    const cursor = url.searchParams.get('cursor')
    const start = cursor ? all.findIndex((r) => r.id === cursor) + 1 : 0
    const page = all.slice(start, start + limit)
    const hasMore = start + page.length < all.length
    return {
      data: page,
      returned: page.length,
      limit,
      total: all.length,
      has_more: hasMore,
      next_cursor: hasMore ? page[page.length - 1].id : null,
    }
  }
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }))

  it('reaches rows past the first page, which is the whole point', async () => {
    // The defect: the console fetched 30 and paged inside that window, so on a
    // set of 61 the last 31 rows were unreachable from any surface.
    const result = await fetchAllPages(server(rows(61)), { path: '/api/v1/alert-events', limit: 30 })
    assert.equal(result.rows.length, 61)
    assert.equal(result.rows[60].id, 'r60', 'the last row of the set must be reachable')
    assert.equal(result.total, 61)
    assert.equal(result.truncated, false)
  })

  it('stops when the server says the page is the last one', async () => {
    const result = await fetchAllPages(server(rows(10)), { path: '/api/v1/x', limit: 30 })
    assert.equal(result.rows.length, 10)
    assert.equal(result.pages, 1, 'a complete first page must not cost a second request')
    assert.equal(result.truncated, false)
  })

  it('reports truncation when the cap is reached, rather than reading as complete', async () => {
    // A walk that stops at maxPages and says nothing is the same defect one
    // layer down: a page that reads as the whole set.
    const result = await fetchAllPages(server(rows(1000)), { path: '/api/v1/x', limit: 10, maxPages: 3 })
    assert.equal(result.rows.length, 30)
    assert.equal(result.pages, 3)
    assert.equal(result.truncated, true, 'hitting the cap is not the end of the set')
    assert.equal(result.total, 1000, "the server's total, not the rows this walk accumulated")
  })

  it('reports truncation and keeps what it has when a page fails mid-walk', async () => {
    // Returning nothing would blank a panel that has data; returning the rows
    // silently would read as complete. Neither is the honest answer.
    const base = server(rows(100))
    let calls = 0
    const flaky = async (path) => {
      calls += 1
      if (calls === 2) throw new Error('connection reset')
      return base(path)
    }
    const result = await fetchAllPages(flaky, { path: '/api/v1/x', limit: 10 })
    assert.equal(result.rows.length, 10, 'the rows already collected are real')
    assert.equal(result.truncated, true)
    assert.equal(result.failed, true, 'a failure is distinguishable from hitting the cap')
  })

  it('does not list a record twice when the set shifts under the walk', async () => {
    // A cursor off by one, or a set that changed between pages, must not put
    // the same row in the list twice.
    const all = rows(6)
    let n = 0
    const overlapping = async (path) => {
      const url = new URL(path, 'http://x')
      const limit = Number(url.searchParams.get('limit'))
      const cursor = url.searchParams.get('cursor')
      const start = cursor ? all.findIndex((r) => r.id === cursor) : 0
      n += 1
      // Every page after the first re-sends the cursor row.
      const page = all.slice(start, start + limit)
      return { data: page, total: 6, has_more: start + page.length < 6, next_cursor: page.length ? page[page.length - 1].id : null }
    }
    const result = await fetchAllPages(overlapping, { path: '/api/v1/x', limit: 2 })
    assert.equal(n > 1, true, 'the walk must actually page')
    assert.equal(new Set(result.rows.map((r) => r.id)).size, result.rows.length,
      'a row must appear once')
  })

  it('accepts a path that already carries a query string', async () => {
    // `/api/v1/climate?source=noaa_enso` is the fetch whose page cannot be
    // crowded out by another connector, and it already has a `?`.
    const seen = []
    const spy = async (path) => { seen.push(path); return { data: [], total: 0, has_more: false, next_cursor: null } }
    await fetchAllPages(spy, { path: '/api/v1/climate?source=noaa_enso', limit: 500 })
    assert.equal(seen[0], '/api/v1/climate?source=noaa_enso&limit=500',
      'a second ? would make the source filter part of the limit value')
  })

  it('treats a bare array as a complete page', async () => {
    const result = await fetchAllPages(async () => [{ id: 'a' }, { id: 'b' }], { path: '/api/v1/x' })
    assert.equal(result.rows.length, 2)
    assert.equal(result.truncated, false, 'an array has no cursor and cannot be walked further')
  })

  it('stops on has_more false even when a cursor is still present', async () => {
    // The two fields are supposed to agree. When they do not, the one that
    // cannot cause an infinite loop wins.
    let calls = 0
    const contradictory = async () => {
      calls += 1
      return { data: [{ id: `x${calls}` }], total: 1, has_more: false, next_cursor: 'x1' }
    }
    const result = await fetchAllPages(contradictory, { path: '/api/v1/x', limit: 1 })
    assert.equal(calls, 1, 'a false has_more must end the walk')
    assert.equal(result.truncated, false)
  })
})

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  LIST_PAGE_SIZE, pageWindow, setPage, resetPages, listScope,
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

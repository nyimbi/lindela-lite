import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  LIST_PAGE_SIZE, pageWindow, setPage, resetPages, pagerSummary,
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

  it('says how much of the list is not on screen', () => {
    assert.equal(pagerSummary({ shown: 25, total: 60 }), 'Showing 25 of 60 records.')
    assert.equal(pagerSummary({ shown: 60, total: 60 }), 'Showing all 60 records.')
    assert.equal(pagerSummary({ shown: 1, total: 1 }), 'Showing all 1 record.')
    assert.equal(pagerSummary({ shown: 0, total: 0 }), '')
  })

  it('keeps separate lists on separate pages', () => {
    setPage('alerts', 3, 100)
    assert.equal(pageWindow('reports', 100).page, 1,
      'paging the alerts must not move the reports list')
  })
})

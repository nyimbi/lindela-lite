import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  FLOOD_DEPTH_BANDS,
  floodCellsForGrid,
  floodCoverage,
  floodDepthBand,
} from '../public/shared/flood-bands.js'
import { AFRICA_BBOX } from '../public/shared/map-frame.js'
import { mapProjection, projectToViewBox } from '../public/shared/tiles.js'

/**
 * Equirectangular projection onto a fixed viewport, matching the dashboard's
 * project(). Kept local so these tests do not need a DOM.
 */
const project = (lat, lon) => ({
  x: (lon - 34) * 100,
  y: (12 - lat) * 100,
})

const bounds = { north: 12, south: 10, east: 36, west: 34 }

const gridOf = (depth_grid, size = 2) => ({ size, bounds, depth_grid })

describe('flood depth bands', () => {
  it('treats dry and unknown ground as unshaded', () => {
    assert.equal(floodDepthBand(0), null)
    assert.equal(floodDepthBand(-3.2), null)
    assert.equal(floodDepthBand(null), null)
    assert.equal(floodDepthBand(undefined), null)
    assert.equal(floodDepthBand(NaN), null)
    assert.equal(floodDepthBand('1.5'), null)
  })

  it('bands depths at the operational cut points', () => {
    assert.equal(floodDepthBand(0.01).key, 'd0')
    assert.equal(floodDepthBand(0.3).key, 'd0')
    assert.equal(floodDepthBand(0.31).key, 'd1')
    assert.equal(floodDepthBand(1).key, 'd1')
    assert.equal(floodDepthBand(1.01).key, 'd2')
    assert.equal(floodDepthBand(2).key, 'd2')
    assert.equal(floodDepthBand(2.5).key, 'd3')
    assert.equal(floodDepthBand(5).key, 'd3')
    assert.equal(floodDepthBand(5.01).key, 'd4')
    assert.equal(floodDepthBand(40).key, 'd4')
  })

  it('separates passable from restricted at the 0.3 m cut', () => {
    // The whole point of the band boundary: 20 cm leaves a road usable and
    // 50 cm does not. Collapsing these into one band would hide the
    // distinction an operator needs.
    assert.equal(floodDepthBand(0.2).note, 'passable')
    assert.equal(floodDepthBand(0.5).note, 'restricted')
  })

  it('produces strictly increasing, contiguous bands with no gap or overlap', () => {
    const bands = FLOOD_DEPTH_BANDS
    for (let i = 1; i < bands.length; i += 1) {
      assert.ok(
        bands[i].max > bands[i - 1].max,
        `band ${bands[i].key} must start above where ${bands[i - 1].key} stops`,
      )
      // A depth at the previous band's ceiling must fall in the earlier band,
      // and one just above it in the later one: no depth is left unshaded.
      assert.equal(floodDepthBand(bands[i - 1].max).key, bands[i - 1].key)
      assert.equal(floodDepthBand(bands[i - 1].max + 0.001).key, bands[i].key)
    }
    assert.equal(bands.at(-1).max, Number.POSITIVE_INFINITY, 'last band must be open-ended')
  })
})

describe('floodCellsForGrid', () => {
  it('returns nothing for a malformed or missing grid', () => {
    assert.deepEqual(floodCellsForGrid(null, project), [])
    assert.deepEqual(floodCellsForGrid({}, project), [])
    assert.deepEqual(floodCellsForGrid({ size: 0, bounds, depth_grid: [] }, project), [])
    assert.deepEqual(floodCellsForGrid(gridOf(null), project), [])
  })

  it('skips dry cells and keeps the wet ones', () => {
    const cells = floodCellsForGrid(gridOf([0.5, 0, -1, 2.2]), project)
    assert.equal(cells.length, 2)
    assert.deepEqual(cells.map((c) => c.band.key), ['d1', 'd3'])
  })

  it('reads the grid row-major and north-first', () => {
    // depth_grid[0] is the north-west corner and depth_grid[size*size-1] the
    // south-east. If the renderer walked the array in the wrong order, or with
    // the wrong stride, the shading would be transposed across the map.
    const cells = floodCellsForGrid(gridOf([3, 0, 0, 3]), project)
    assert.equal(cells.length, 2)
    const [northWest, southEast] = cells
    assert.equal(northWest.x, 0, 'north-west cell is at the western edge')
    assert.equal(northWest.y, 0, 'north-west cell is at the northern edge')
    assert.equal(southEast.x, 100, 'stride of size skips a full row, not one cell')
    assert.equal(southEast.y, 100, 'south row is one degree further south')
  })

  it('sizes cells to the requested grid resolution', () => {
    const cells = floodCellsForGrid(gridOf([1, 1, 1, 1], 2), project)
    assert.equal(cells.length, 4)
    for (const cell of cells) {
      assert.equal(cell.width, 100, '2 degrees of longitude over 2 cells = 1 degree each')
      assert.equal(cell.height, 100, '2 degrees of latitude over 2 cells = 1 degree each')
    }
  })

  it('emits positive geometry even when projection inverts an axis', () => {
    // Negative width or height silently draws nothing in SVG, so the
    // normalisation is load-bearing rather than cosmetic.
    const flipped = (lat, lon) => ({ x: (34 - lon) * 100, y: (lat - 12) * 100 })
    const [cell] = floodCellsForGrid(gridOf([1, 0, 0, 0]), flipped)
    assert.ok(cell.width > 0, 'width must be positive')
    assert.ok(cell.height > 0, 'height must be positive')
  })

  it('reaches every wet cell at a realistic grid size', () => {
    const size = 64
    const depths = new Array(size * size).fill(0)
    depths[0] = 1.4
    depths[100] = 0.2
    depths[size * size - 1] = 7
    const cells = floodCellsForGrid(gridOf(depths, size), project)
    assert.equal(cells.length, 3)
    assert.deepEqual(cells.map((c) => c.band.key), ['d2', 'd0', 'd4'])
  })

  it('keeps every wet cell visible when the projection rounds to a coarse grid', () => {
    // The dashboard's `project` rounds every coordinate to 0.1 viewBox units,
    // and it was also what `floodCellsForGrid` was handed. The Africa
    // projection puts ~6.45 viewBox units on a degree (800 across 124), so the
    // live demo's 32-cell mesh over 0.3° has cells 0.06 units across — under
    // the rounding step. Both corners then round onto the same tenth, or onto
    // adjacent ones, and a cell whose width *or* height rounds to zero draws
    // nothing: 677 of 1077 cells in the live demo had no area, while the status
    // line still reported the full 1165 km². `projectExact` is the unrounded
    // projection the dashboard now passes here; this pins the contract that a
    // cell's geometry survives it, over the population rather than one cell —
    // whether a single 0.06-unit cell collapses depends on where it sits
    // relative to the tenth grid, so a one-cell assertion would be a coin toss.
    const proj = mapProjection(AFRICA_BBOX, 800, 500)
    const toViewBox = (lat, lon) => projectToViewBox(proj, lat, lon)
    const rounded = (lat, lon) => {
      const p = toViewBox(lat, lon)
      return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }
    }

    // The Turkana demo mesh: 32×32 over ~0.3°, every cell wet.
    const size = 32
    const bounds = { north: 3.6, south: 3.3, east: 35.4, west: 35.1 }
    const grid = { size, bounds, depth_grid: new Array(size * size).fill(1.5) }

    // Premise: a cell really is finer than the rounding step, so the losses
    // below are the rounding's doing and not some other collapse.
    const meshWidth = toViewBox(bounds.north, bounds.east).x - toViewBox(bounds.north, bounds.west).x
    const cellWidth = meshWidth / size
    assert.ok(cellWidth < 0.1, `a demo cell spans ${cellWidth.toFixed(4)} units, not under the 0.1 step`)

    // Unrounded: every wet cell is emitted, and every one has area.
    const exact = floodCellsForGrid(grid, toViewBox)
    assert.equal(exact.length, size * size, 'every wet cell is emitted')
    assert.ok(
      exact.every((c) => c.width > 0 && c.height > 0),
      'a wet cell must have area',
    )

    // Rounded: cells are lost — the bug this test exists to rule out. The
    // fixture reproduces the demo's rate (63% here against 677 of 1077 live),
    // so the assertion is scaled to it rather than to "at least one".
    const lossy = floodCellsForGrid(grid, rounded)
    const invisible = lossy.filter((c) => !(c.width > 0 && c.height > 0))
    assert.ok(
      invisible.length > lossy.length / 2,
      `the coarse rounding must lose most cells, lost ${invisible.length} of ${lossy.length}`,
    )
  })
})

describe('floodCoverage', () => {
  it('reports wet fraction and deepest cell', () => {
    const result = floodCoverage([0, 0.5, 1, -2, 3])
    assert.equal(result.cells, 5, 'negative depth is still a valid sample')
    assert.equal(result.wet_cells, 3)
    assert.equal(result.wet_pct, 60)
    assert.equal(result.max_depth_m, 3)
  })

  it('reports a fully dry grid without dividing by zero', () => {
    const result = floodCoverage([0, 0, -0.5])
    assert.equal(result.wet_pct, 0)
    assert.equal(result.max_depth_m, 0)
  })

  it('reports zero coverage for an empty grid', () => {
    assert.deepEqual(floodCoverage([]), { cells: 0, wet_cells: 0, wet_pct: 0, max_depth_m: 0 })
  })

  it('excludes non-numeric samples from the denominator', () => {
    // An area with no terrain data must not be counted as dry ground, or the
    // coverage figure would understate the flood extent.
    const result = floodCoverage([null, undefined, NaN, 1, 1])
    assert.equal(result.cells, 2)
    assert.equal(result.wet_pct, 100)
  })

  it('keeps two decimal places on the wet percentage', () => {
    assert.equal(floodCoverage(Array.from({ length: 3 }, () => 1)).wet_pct, 100)
    assert.equal(floodCoverage([1, 1, 1, 0]).wet_pct, 75)
    assert.equal(floodCoverage([1, 0, 0]).wet_pct, 33.33)
  })
})
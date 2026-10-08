import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MERCATOR_MAX_LAT,
  TILE_MAX_ZOOM,
  TILE_MIN_ZOOM,
  TILE_SOURCES,
  TILE_ATTRIBUTION,
  latToTileY,
  lonToTileX,
  mapProjection,
  projectToViewBox,
  svgPlacement,
  tileGridKey,
  tileToBounds,
  tileUrlFor,
  tilesForRect,
  tileYToLat,
  viewBoxToWorld,
  visibleWorldRect,
  zoomForRect,
} from '../public/shared/tiles.js'

// Turkana (Lodwar): the frame the pilot region is about. The 2026-10-07
// "fixed" selector hardcoded z6/x30/y20 here believing it was Turkana; it is
// the North Sea off Denmark. These tests exist because that arithmetic was
// eyeballed once and was quietly wrong — the numbers are asserted now.
const TURKANA = { lat: 3.1167, lon: 35.6 }
const FULL_FRAME = {
  minLon: 27, maxLon: 52,   // Turkana, Bor, Aweil, Moroto, Mandera + margin
  minLat: -6, maxLat: 15,
}
const SVG_W = 800
const SVG_H = 500

describe('slippy-map tile arithmetic', () => {
  it('Turkana is tile z6/x38/y31 — not x30/y20', () => {
    assert.equal(Math.floor(lonToTileX(TURKANA.lon, 6)), 38)
    assert.equal(Math.floor(latToTileY(TURKANA.lat, 6)), 31)
    // The wrong tile, named for what it actually covers:
    const wrong = tileToBounds(30, 20, 6)
    assert.ok(wrong.north > 50, `x30/y20 is far north of the pilot region, not inside it (${wrong.north})`)
  })

  it('tile bounds round-trip through the mercator formulas', () => {
    const zoom = 7
    for (const [x, y] of [[64, 64], [100, 60], [120, 64], [64, 52]]) {
      const b = tileToBounds(x, y, zoom)
      assert.ok(Math.abs(Math.floor(lonToTileX(b.west + 0.001, zoom)) - x) <= 0)
      assert.ok(Math.abs(Math.floor(latToTileY(b.north - 0.001, zoom)) - y) <= 0)
      assert.ok(b.south < b.north)
    }
    // Equator and the mercator edges are coordinates, not errors.
    assert.equal(Math.floor(latToTileY(0, 6)), 32)
    assert.ok(Math.abs(tileYToLat(0, 6) - MERCATOR_MAX_LAT) < 0.01)
    assert.ok(Math.abs(tileYToLat(64, 6) + MERCATOR_MAX_LAT) < 0.01)
  })

  it('zoom matches the viewport, clamped to policy', () => {
    assert.equal(zoomForRect({ west: -180, east: 180, south: -85, north: 85 }, SVG_W, SVG_H), TILE_MIN_ZOOM)
    assert.equal(zoomForRect({ west: 35, east: 35.001, south: 3, north: 3.001 }, SVG_W, SVG_H), TILE_MAX_ZOOM)
    // 35 degrees wide: log2(360*800/(35*256)) ≈ 5 — natural resolution on the
    // binding (horizontal) axis, then only stepped down if it busts the budget.
    assert.equal(zoomForRect({ west: 27, east: 62, south: -10, north: 25 }, SVG_W, SVG_H), 5)
    // A tall thin rect at that zoom would fetch hundreds of tiles: step down
    // until the budget fits.
    const tall = zoomForRect({ west: 35, east: 37, south: -30, north: 40 }, SVG_W, SVG_H)
    assert.ok(tall < 9, `a tall thin frame must step down, got z${tall}`)
    assert.ok(tilesForRect({ west: 35, east: 37, south: -30, north: 40 }, tall, Infinity).length <= 64)
  })

  it('enumerates exactly the tiles a visible window covers', () => {
    const tiles = tilesForRect(
      { west: 33.75, east: 39.375, south: 0, north: 5.6 }, 6,
    )
    assert.notEqual(tiles.length, 0)
    const xs = [...new Set(tiles.map((t) => t.x))]
    const ys = [...new Set(tiles.map((t) => t.y))]
    // 33.75..39.375 is exactly tile column 38; latitudes 0..5.6 sit in rows 31-32.
    assert.deepEqual(xs, [38])
    assert.deepEqual(ys, [31, 32])
    // And it contains the tile the pilot region actually sits on.
    assert.ok(tiles.some((t) => t.x === 38 && t.y === 31))
    for (const t of tiles) {
      assert.equal(t.z, 6)
      assert.ok(t.west < t.east && t.south < t.north)
    }
  })

  it('refuses to enumerate more than maxTiles and returns empty instead', () => {
    assert.deepEqual(tilesForRect({ west: -180, east: 180, south: -85, north: 85 }, TILE_MAX_ZOOM, 4), [])
  })

  it('places a tile preserving the frame aspect (no stretch)', () => {
    // A frame whose aspect matches the viewBox fills it exactly.
    const wide = { minLon: 0, maxLon: 160, minLat: 0, maxLat: 100 } // 1.6:1 like 800×500
    const placement = svgPlacement({ z: 0, x: 0, y: 0, west: wide.minLon, east: wide.maxLon, north: wide.maxLat, south: wide.minLat }, wide, SVG_W, SVG_H)
    assert.deepEqual(placement, { x: 0, y: 0, width: SVG_W, height: SVG_H })

    // A square frame letterboxes: it fills the height and centres, rather than
    // stretching to fill the width — that stretch is the deformation this
    // projection exists to prevent.
    const square = { minLon: 0, maxLon: 100, minLat: 0, maxLat: 100 }
    const letter = svgPlacement({ z: 0, x: 0, y: 0, west: 0, east: 100, north: 100, south: 0 }, square, SVG_W, SVG_H)
    assert.equal(letter.height, SVG_H)
    assert.equal(letter.width, 500)
    assert.equal(letter.x, 150)
    assert.equal(letter.y, 0)

    // A tile half the frame wide sits where its bounds say, not at 0,0, and
    // keeps its own aspect (a square tile stays square in viewBox units).
    const half = svgPlacement({ z: 6, x: 38, y: 31, ...tileToBounds(38, 31, 6) }, FULL_FRAME, SVG_W, SVG_H)
    assert.ok(half.x > 0)
    assert.ok(half.width < SVG_W)
    const b = tileToBounds(38, 31, 6)
    const ratio = (b.east - b.west) / (b.north - b.south)
    assert.ok(Math.abs(half.width / half.height - ratio) < 0.01, 'tile aspect preserved')
  })

  it('mapProjection preserves aspect, centres the frame, and round-trips', () => {
    // A square frame on the 1.6:1 viewBox letterboxes: one scale for both
    // axes, height filled, width centred — never stretched to fit.
    const square = mapProjection({ minLon: 0, maxLon: 100, minLat: 0, maxLat: 100 }, SVG_W, SVG_H)
    assert.equal(square.scale, 5)
    assert.equal(square.offsetX, 150)
    assert.equal(square.offsetY, 0)

    const p = mapProjection({ minLon: -45, maxLon: 79, minLat: -38, maxLat: 40 }, SVG_W, SVG_H)
    // One degree of longitude and one degree of latitude are the same number
    // of pixels — the property that keeps the continent at its true shape.
    const closeTo = (a, b) => Math.abs(a - b) < 1e-9
    assert.ok(closeTo(projectToViewBox(p, 0, 18).x - projectToViewBox(p, 0, 17).x, p.scale), '1° lon == scale px')
    assert.ok(closeTo(projectToViewBox(p, 0, 17).y - projectToViewBox(p, 1, 17).y, p.scale), '1° lat == scale px')
    // lon/lat ↔ viewBox is a clean round-trip.
    const pt = projectToViewBox(p, 1, 17)
    const w = viewBoxToWorld(p, pt.x, pt.y)
    assert.ok(Math.abs(w.lat - 1) < 1e-9 && Math.abs(w.lon - 17) < 1e-9, 'round-trips')
  })

  it('tile placement is null for tiles fully outside the frame', () => {
    assert.equal(svgPlacement(null, FULL_FRAME, SVG_W, SVG_H), null)
    const outside = { z: 2, x: 0, y: 0, west: -180, east: -178, north: 40, south: 39 }
    assert.equal(svgPlacement(outside, FULL_FRAME, SVG_W, SVG_H), null)
  })

  it('visible window pulls the frame back through the transform', () => {
    const view = visibleWorldRect(FULL_FRAME, { x: 0, y: 0, scale: 2 }, SVG_W, SVG_H)
    // Scaling by 2 around the viewBox origin shows half the frame along each axis.
    assert.equal(view.lonSpan, (FULL_FRAME.maxLon - FULL_FRAME.minLon) / 2)
    assert.equal(view.latSpan, (FULL_FRAME.maxLat - FULL_FRAME.minLat) / 2)
    // Panning left by half a viewBox shows the right half of the frame.
    const panned = visibleWorldRect(FULL_FRAME, { x: -SVG_W / 2, y: 0, scale: 1 }, SVG_W, SVG_H)
    assert.equal(panned.east, FULL_FRAME.maxLon)
    assert.equal(panned.west, (FULL_FRAME.minLon + FULL_FRAME.maxLon) / 2)
  })
})

describe('same-origin tile URLs and attribution', () => {
  it('every source URL is same-origin — the CSP only allows img-src self', () => {
    for (const [source, prefix] of Object.entries(TILE_SOURCES)) {
      assert.ok(prefix.startsWith('/api/v1/basemap/tiles/'), `${source} must be same-origin`)
      assert.ok(!prefix.includes('://'), `${source} leaks an absolute URL`)
      const url = tileUrlFor(source, { z: 6, x: 38, y: 31 })
      assert.equal(url, `${prefix}/6/38/31.png`)
    }
    assert.equal(tileUrlFor('none', { z: 6, x: 38, y: 31 }), null)
    assert.equal(tileUrlFor('osm', { z: 6, x: 1.5, y: 2 }), null)
    assert.equal(tileUrlFor('osm', { z: 1, x: 300, y: 300 }), null)
  })

  it('attribution names the provider, as the tile policies require', () => {
    for (const source of ['osm', 'carto']) {
      assert.ok(TILE_ATTRIBUTION[source].includes('OpenStreetMap'), `${source} lacks OSM credit`)
    }
    assert.ok(TILE_ATTRIBUTION.none.includes('Offline'))
  })

  it('same tile list yields the same key; a different source does not', () => {
    const a = tilesForRect({ west: 33.75, east: 39.375, south: 0, north: 5.6 }, 6)
    assert.notEqual(a.length, 0)
    assert.equal(tileGridKey('osm', a), tileGridKey('osm', [...a].reverse()))
    assert.ok(tileGridKey('osm', a) !== tileGridKey('carto', a))
    assert.equal(tileGridKey('osm', []), 'osm:none:[]')
  })
})
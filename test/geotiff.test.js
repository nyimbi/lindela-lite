import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeGeoTiff, sampleAt } from '../src/geotiff.js'
import { TAG, buildTiff, stripTag } from './tiff-fixture.mjs'

/**
 * The reader is tested against TIFFs this suite writes, byte by byte — see
 * `test/tiff-fixture.mjs` for why a committed binary fixture would prove the
 * wrong thing.
 *
 * The four canaries the plan named are marked below: a predicted file decodes
 * to the unprected values, an unsupported compression throws rather than
 * returning a grid, a nodata cell reads `NaN` and not `0`, and a point outside
 * the grid is refused rather than clamped.
 */

/** A 4x3 grid with one nodata cell, and the bbox its tags describe. */
const WIDTH = 4
const HEIGHT = 3
const NODATA = -9999
const VALUES = [1, 2, 3, 4, 5, NODATA, 7, 8, 9, 10, 11, 12]
const TIE = [0, 0, 0, -180, 50, 0]
const SCALE = [0.05, 0.05, 0]
const BBOX = { west: -180, east: -179.8, north: 50, south: 49.85 }
const DECLARED = { width: WIDTH, height: HEIGHT, values: VALUES, tiepoint: TIE, pixelScale: SCALE }

const finite = (grid) => Array.from(grid).map((v) => (Number.isNaN(v) ? 'NaN' : v))

describe('decodeGeoTiff', () => {
  it('reads a stripped Float32 grid and its geographic extent', () => {
    const decoded = decodeGeoTiff(buildTiff({ ...DECLARED, nodataTag: String(NODATA) }))
    assert.equal(decoded.width, WIDTH)
    assert.equal(decoded.height, HEIGHT)
    assert.equal(decoded.nodata, NODATA)
    assert.deepEqual(decoded.bbox, BBOX)
    // Canary for the nodata mask: the cell must be NaN, not 0 and not -9999.
    // A reader that dropped the mask would put -9999 here, which a downstream
    // "no rainfall" test would read as a value.
    assert.deepEqual(finite(decoded.grid),
      [1, 2, 3, 4, 5, 'NaN', 7, 8, 9, 10, 11, 12])
  })

  it('reads a deflate-compressed file to the same values', () => {
    const plain = decodeGeoTiff(buildTiff({ ...DECLARED, nodataTag: String(NODATA) }))
    const packed = decodeGeoTiff(buildTiff({ ...DECLARED, compression: 8, nodataTag: String(NODATA) }))
    assert.deepEqual(finite(packed.grid), finite(plain.grid))
  })

  it('undoes Predictor 2 so a differenced file reads as the original', () => {
    // Canary: the same values, once stored flat and once stored as horizontal
    // differences. If the reader skipped the predictor the second grid would be
    // differences — small numbers that still look like a rainfall field.
    const flat = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    const options = { ...DECLARED, values: flat, bitsPerSample: 16, sampleFormat: 2 }
    const plain = decodeGeoTiff(buildTiff({ ...options, predictor: 1 }))
    const differenced = decodeGeoTiff(buildTiff({ ...options, predictor: 2 }))
    assert.deepEqual(finite(plain.grid), flat)
    assert.deepEqual(finite(differenced.grid), flat)
  })

  it('reads each strip at its own offset, not by assuming a contiguous run', () => {
    const oneRow = buildTiff({ ...DECLARED, rowsPerStrip: 1, nodataTag: String(NODATA) })
    const allRows = buildTiff({ ...DECLARED, nodataTag: String(NODATA) })
    assert.deepEqual(finite(decodeGeoTiff(oneRow).grid), finite(decodeGeoTiff(allRows).grid))
  })

  it('reads a big-endian file', () => {
    const be = decodeGeoTiff(buildTiff({ ...DECLARED, little: false, nodataTag: String(NODATA) }))
    const le = decodeGeoTiff(buildTiff({ ...DECLARED, nodataTag: String(NODATA) }))
    assert.deepEqual(finite(be.grid), finite(le.grid))
  })

  it('reads a tag whose field type it does not implement, as long as nobody asks for it', () => {
    // The real CHIRPS file carries XResolution (282) as a RATIONAL (type 5).
    // The first version of this reader threw on it and refused the whole file,
    // which no synthetic fixture could have found — hence the live check in
    // docs/research/chirps-geotiff/README.md, and hence this regression test.
    const withRational = buildTiff({
      ...DECLARED, nodataTag: String(NODATA),
      extra: [{ tag: 282, type: 5, values: [72, 1] }],
    })
    assert.deepEqual(
      finite(decodeGeoTiff(withRational).grid),
      finite(decodeGeoTiff(buildTiff({ ...DECLARED, nodataTag: String(NODATA) })).grid))
  })

  it('masks the nodata value the caller names when the file declares none', () => {
    // CHIRPS declares no GDAL_NODATA. The connector passes -9999 explicitly;
    // this is that path.
    const decoded = decodeGeoTiff(buildTiff(DECLARED), { nodata: NODATA })
    assert.equal(decoded.nodata, NODATA)
    assert.ok(Number.isNaN(decoded.grid[5]))
  })

  it('does not invent a nodata value when neither the file nor the caller gives one', () => {
    // The converse of the test above: with nothing declared, -9999 is a
    // measurement as far as this reader knows. Inventing a default here would
    // punch a hole in a real value, so it must not.
    const decoded = decodeGeoTiff(buildTiff(DECLARED))
    assert.equal(decoded.nodata, null)
    assert.equal(decoded.grid[5], NODATA)
  })

  it('refuses an unsupported compression instead of returning a grid', () => {
    // Canary: LZW (5). A reader that fell through to "just read the bytes"
    // would return a grid of compressed noise, which is the failure mode this
    // whole module is written against.
    assert.throws(() => decodeGeoTiff(buildTiff({ ...DECLARED, compression: 5 })), /Compression 5 is not supported/)
  })

  it('refuses a tiled file', () => {
    // A tiled file is one with no StripOffsets. Removing the tag is how that
    // looks to this reader, and it must refuse rather than read the tile
    // payload as if it were a strip.
    assert.throws(() => decodeGeoTiff(stripTag(buildTiff(DECLARED), TAG.StripOffsets)), /no StripOffsets/)
  })

  it('refuses a multi-band file', () => {
    assert.throws(
      () => decodeGeoTiff(buildTiff({ ...DECLARED, extra: [{ tag: TAG.SamplesPerPixel, type: 3, values: [3] }] })),
      /SamplesPerPixel is 3/)
  })

  it('refuses a rotated grid rather than sampling it as axis-aligned', () => {
    assert.throws(
      () => decodeGeoTiff(buildTiff({ ...DECLARED, extra: [{ tag: TAG.ModelTransformation, type: 12, values: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }] })),
      /ModelTransformation/)
  })

  it('refuses something that is not a TIFF at all', () => {
    assert.throws(() => decodeGeoTiff(Buffer.from('not a tiff, just prose')), /byte-order mark/)
    assert.throws(() => decodeGeoTiff(Buffer.alloc(4)), /shorter than a TIFF header/)
  })
})

describe('sampleAt', () => {
  const decoded = decodeGeoTiff(buildTiff({ ...DECLARED, nodataTag: String(NODATA) }))

  it('samples the cell a coordinate falls in', () => {
    // Cell centres for the bbox above: col c at -180 + (c + 0.5) * 0.05.
    assert.equal(sampleAt(decoded, 49.975, -179.975).value, 1)
    assert.equal(sampleAt(decoded, 49.975, -179.875).value, 3)
    assert.equal(sampleAt(decoded, 49.925, -179.975).value, 5)
    assert.equal(sampleAt(decoded, 49.875, -179.975).value, 9)
  })

  it('reports a nodata cell as nodata, not as a value', () => {
    const hit = sampleAt(decoded, 49.925, -179.925)
    assert.equal(hit.value, null)
    assert.equal(hit.nodata, true)
    assert.equal(hit.reason, 'nodata')
  })

  it('refuses a point outside the grid rather than clamping to the edge', () => {
    // Canary: CHIRPS covers 50S-50N, so a point in Europe is a routine input.
    // Clamping would answer with the northernmost row's value and call it rain
    // in Oslo.
    for (const [lat, lon] of [[0, 10], [-60, 35.6], [55, 35.6], [3.1167, -200], [3.1167, 180]]) {
      const miss = sampleAt(decoded, lat, lon)
      assert.equal(miss.value, null, `${lat},${lon} should be outside the grid`)
      assert.equal(miss.reason, 'outside_grid')
    }
  })

  it('refuses a grid with no georeferencing, and a non-finite coordinate', () => {
    assert.equal(sampleAt({ width: 1, height: 1, grid: new Float64Array(1), bbox: null }, 0, 0).reason, 'no_georeferencing')
    assert.equal(sampleAt(decoded, NaN, 35.6).reason, 'invalid_coordinate')
  })
})

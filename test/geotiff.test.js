import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { decodeGeoTiff, sampleAt } from '../src/geotiff.js'

/**
 * The reader is tested against TIFFs this file writes, byte by byte.
 *
 * A committed binary fixture would prove only that the reader agrees with
 * whatever produced it — and the failure this reader exists to avoid is the one
 * where it agrees with itself and disagrees with the product. Building the
 * bytes here means the tag layout, the strip table and the predictor are all
 * visible in the test that depends on them.
 *
 * The four canaries the plan named are marked below: a predicted file decodes
 * to the unprected values, an unsupported compression throws rather than
 * returning a grid, a nodata cell reads `NaN` and not `0`, and a point outside
 * the grid is refused rather than clamped.
 */

const TAG = Object.freeze({
  ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
  StripOffsets: 273, SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279,
  PlanarConfig: 284, Predictor: 317, SampleFormat: 339,
  ModelPixelScale: 33550, ModelTiepoint: 33922, GdalNoData: 42113,
})
const TYPE_SIZE = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8 })

/** A 4x3 grid with one nodata cell, and the bbox its tags describe. */
const WIDTH = 4
const HEIGHT = 3
const NODATA = -9999
const VALUES = [1, 2, 3, 4, 5, NODATA, 7, 8, 9, 10, 11, 12]
const TIE = [0, 0, 0, -180, 50, 0]
const SCALE = [0.05, 0.05, 0]
const BBOX = { west: -180, east: -179.8, north: 50, south: 49.85 }

/** Writes samples of one TIFF sample type into a buffer. */
function encodeSamples(values, { bitsPerSample, sampleFormat, little }) {
  const step = bitsPerSample / 8
  const buf = Buffer.alloc(values.length * step)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  values.forEach((v, i) => {
    const off = i * step
    if (sampleFormat === 3) {
      if (bitsPerSample === 64) view.setFloat64(off, v, little)
      else view.setFloat32(off, v, little)
    } else if (bitsPerSample === 8) {
      if (sampleFormat === 2) view.setInt8(off, v)
      else view.setUint8(off, v)
    } else if (bitsPerSample === 16) {
      if (sampleFormat === 2) view.setInt16(off, v, little)
      else view.setUint16(off, v, little)
    } else if (sampleFormat === 2) view.setInt32(off, v, little)
    else view.setUint32(off, v, little)
  })
  return buf
}

/** Predictor 2's forward transform: store each sample as its difference. */
function applyHorizontal(values, width, height) {
  const out = values.slice()
  for (let r = 0; r < height; r += 1) {
    for (let c = width - 1; c >= 1; c -= 1) {
      out[r * width + c] = values[r * width + c] - values[r * width + c - 1]
    }
  }
  return out
}

function entryBytes(entry, little) {
  if (entry.type === 2) return Buffer.from(`${entry.values}\u0000`, 'latin1')
  const size = TYPE_SIZE[entry.type]
  const buf = Buffer.alloc(size * entry.values.length)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  entry.values.forEach((v, i) => {
    const off = i * size
    if (entry.type === 3) view.setUint16(off, v, little)
    else if (entry.type === 4) view.setUint32(off, v, little)
    else if (entry.type === 11) view.setFloat32(off, v, little)
    else view.setFloat64(off, v, little)
  })
  return buf
}

/** Builds a TIFF: header, strip payloads, IFD, then any out-of-line values. */
function buildTiff({
  width = WIDTH, height = HEIGHT, values = VALUES,
  bitsPerSample = 32, sampleFormat = 3, compression = 1, predictor = 1,
  little = true, tiepoint = TIE, pixelScale = SCALE, nodataTag = null,
  rowsPerStrip = null, extra = [],
} = {}) {
  const rps = rowsPerStrip || height
  const stripCount = Math.ceil(height / rps)
  const payload = predictor === 2 ? applyHorizontal(values, width, height) : values.slice()

  const strips = []
  for (let s = 0; s < stripCount; s += 1) {
    const firstRow = s * rps
    const rows = Math.min(rps, height - firstRow)
    const slice = payload.slice(firstRow * width, (firstRow + rows) * width)
    const encoded = encodeSamples(slice, { bitsPerSample, sampleFormat, little })
    strips.push(compression === 8 ? deflateSync(encoded) : encoded)
  }

  let cursor = 8
  const offsets = []
  for (const strip of strips) {
    offsets.push(cursor)
    cursor += strip.length
  }

  const entries = [
    { tag: TAG.ImageWidth, type: 4, values: [width] },
    { tag: TAG.ImageLength, type: 4, values: [height] },
    { tag: TAG.BitsPerSample, type: 3, values: [bitsPerSample] },
    { tag: TAG.Compression, type: 3, values: [compression] },
    { tag: TAG.StripOffsets, type: 4, values: offsets },
    { tag: TAG.SamplesPerPixel, type: 3, values: [1] },
    { tag: TAG.RowsPerStrip, type: 4, values: [rps] },
    { tag: TAG.StripByteCounts, type: 4, values: strips.map((s) => s.length) },
    { tag: TAG.PlanarConfig, type: 3, values: [1] },
    { tag: TAG.Predictor, type: 3, values: [predictor] },
    { tag: TAG.SampleFormat, type: 3, values: [sampleFormat] },
    { tag: TAG.ModelPixelScale, type: 12, values: pixelScale },
    { tag: TAG.ModelTiepoint, type: 12, values: tiepoint },
    ...(nodataTag === null ? [] : [{ tag: TAG.GdalNoData, type: 2, values: nodataTag }]),
    ...extra,
  ].sort((a, b) => a.tag - b.tag)

  const ifdOffset = cursor
  const ifdSize = 2 + entries.length * 12 + 4
  const extraBase = ifdOffset + ifdSize

  const header = Buffer.alloc(8)
  const hview = new DataView(header.buffer, header.byteOffset, header.byteLength)
  header.write(little ? 'II' : 'MM', 0, 'latin1')
  hview.setUint16(2, 42, little)
  hview.setUint32(4, ifdOffset, little)

  const ifd = Buffer.alloc(ifdSize)
  const iview = new DataView(ifd.buffer, ifd.byteOffset, ifd.byteLength)
  iview.setUint16(0, entries.length, little)
  const extraChunks = []
  let extraCursor = 0
  entries.forEach((entry, i) => {
    const pos = 2 + i * 12
    const bytes = entryBytes(entry, little)
    iview.setUint16(pos, entry.tag, little)
    iview.setUint16(pos + 2, entry.type, little)
    iview.setUint32(pos + 4, entry.type === 2 ? bytes.length : entry.values.length, little)
    if (bytes.length <= 4) {
      bytes.copy(ifd, pos + 8)
    } else {
      iview.setUint32(pos + 8, extraBase + extraCursor, little)
      extraChunks.push(bytes)
      extraCursor += bytes.length
    }
  })
  iview.setUint32(2 + entries.length * 12, 0, little)

  return Buffer.concat([header, ...strips, ifd, ...extraChunks])
}

const finite = (grid) => Array.from(grid).map((v) => (Number.isNaN(v) ? 'NaN' : v))

describe('decodeGeoTiff', () => {
  it('reads a stripped Float32 grid and its geographic extent', () => {
    const decoded = decodeGeoTiff(buildTiff({ nodataTag: String(NODATA) }))
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
    const plain = decodeGeoTiff(buildTiff({ nodataTag: String(NODATA) }))
    const packed = decodeGeoTiff(buildTiff({ compression: 8, nodataTag: String(NODATA) }))
    assert.deepEqual(finite(packed.grid), finite(plain.grid))
  })

  it('undoes Predictor 2 so a differenced file reads as the original', () => {
    // Canary: the same values, once stored flat and once stored as horizontal
    // differences. If the reader skipped the predictor the second grid would be
    // differences — small numbers that still look like a rainfall field.
    const flat = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    const options = { values: flat, bitsPerSample: 16, sampleFormat: 2 }
    const plain = decodeGeoTiff(buildTiff({ ...options, predictor: 1 }))
    const differenced = decodeGeoTiff(buildTiff({ ...options, predictor: 2 }))
    assert.deepEqual(finite(plain.grid), flat)
    assert.deepEqual(finite(differenced.grid), flat)
  })

  it('reads each strip at its own offset, not by assuming a contiguous run', () => {
    const twoStrips = decodeGeoTiff(buildTiff({ rowsPerStrip: 1, nodataTag: String(NODATA) }))
    assert.deepEqual(finite(twoStrips.grid), finite(decodeGeoTiff(buildTiff({ nodataTag: String(NODATA) })).grid))
  })

  it('reads a big-endian file', () => {
    const be = decodeGeoTiff(buildTiff({ little: false, nodataTag: String(NODATA) }))
    assert.deepEqual(finite(be.grid), finite(decodeGeoTiff(buildTiff({ nodataTag: String(NODATA) })).grid))
  })

  it('masks the nodata value the caller names when the file declares none', () => {
    // CHIRPS declares no GDAL_NODATA. The connector passes -9999 explicitly;
    // this is that path.
    const decoded = decodeGeoTiff(buildTiff(), { nodata: NODATA })
    assert.equal(decoded.nodata, NODATA)
    assert.ok(Number.isNaN(decoded.grid[5]))
  })

  it('does not invent a nodata value when neither the file nor the caller gives one', () => {
    // The converse of the test above: with nothing declared, -9999 is a
    // measurement as far as this reader knows. Inventing a default here would
    // punch a hole in a real value, so it must not.
    const decoded = decodeGeoTiff(buildTiff())
    assert.equal(decoded.nodata, null)
    assert.equal(decoded.grid[5], NODATA)
  })

  it('refuses an unsupported compression instead of returning a grid', () => {
    // Canary: LZW (5). A reader that fell through to "just read the bytes"
    // would return a grid of compressed noise, which is the failure mode this
    // whole module is written against.
    assert.throws(() => decodeGeoTiff(buildTiff({ compression: 5 })), /Compression 5 is not supported/)
  })

  it('refuses a tiled file', () => {
    // A tiled file is one with no StripOffsets. Removing the tag is how that
    // looks to this reader, and it must refuse rather than read the tile
    // payload as if it were a strip.
    assert.throws(() => decodeGeoTiff(stripTag(buildTiff(), TAG.StripOffsets)), /no StripOffsets/)
  })

  it('refuses a multi-band file', () => {
    assert.throws(
      () => decodeGeoTiff(buildTiff({ extra: [{ tag: TAG.SamplesPerPixel, type: 3, values: [3] }] })),
      /SamplesPerPixel is 3/)
  })

  it('refuses something that is not a TIFF at all', () => {
    assert.throws(() => decodeGeoTiff(Buffer.from('not a tiff, just prose')), /byte-order mark/)
    assert.throws(() => decodeGeoTiff(Buffer.alloc(4)), /shorter than a TIFF header/)
  })
})

describe('sampleAt', () => {
  const decoded = decodeGeoTiff(buildTiff({ nodataTag: String(NODATA) }))

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

/**
 * Rewrites a TIFF with one tag's entry removed, by zeroing its tag id.
 *
 * The reader skips tags it does not know, so a zeroed tag is simply absent —
 * which is how a tiled file looks to it.
 */
function stripTag(buffer, tag) {
  const out = Buffer.from(buffer)
  const little = out.toString('latin1', 0, 2) === 'II'
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const ifdOffset = view.getUint32(4, little)
  const count = view.getUint16(ifdOffset, little)
  for (let i = 0; i < count; i += 1) {
    const pos = ifdOffset + 2 + i * 12
    if (view.getUint16(pos, little) === tag) view.setUint16(pos, 0, little)
  }
  return out
}

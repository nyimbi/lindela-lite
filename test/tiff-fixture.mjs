import { deflateSync } from 'node:zlib'

/**
 * Builds GeoTIFF bytes for tests.
 *
 * The reader is proved against bytes a test writes rather than against a
 * committed binary, because a committed fixture proves only that the reader
 * agrees with whatever produced it — and the failure it exists to avoid is
 * agreeing with itself while disagreeing with the product. That is not
 * hypothetical: the real CHIRPS file carries `XResolution` (282) as a TIFF
 * RATIONAL, a field type the first version of the reader refused, and no
 * synthetic fixture could have found it.
 *
 * Shared rather than duplicated: `test/geotiff.test.js` exercises the reader
 * directly and `test/fixtures.test.js` serves these bytes through a mocked
 * fetch, so both drive one encoder.
 */

const TAG = Object.freeze({
  ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
  StripOffsets: 273, SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279,
  PlanarConfig: 284, Predictor: 317, SampleFormat: 339,
  ModelPixelScale: 33550, ModelTiepoint: 33922, ModelTransformation: 34264,
  GdalNoData: 42113,
})
const TYPE_SIZE = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8 })

/** Writes samples of one TIFF sample type into a buffer. */
export function encodeSamples(values, { bitsPerSample, sampleFormat, little }) {
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
export function applyHorizontal(values, width, height) {
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
  // RATIONAL: two uint32 per value. The reader does not implement type 5, and
  // the fixture has to be able to write one anyway — a test asks for a file
  // carrying a tag the reader must tolerate rather than refuse.
  if (entry.type === 5) {
    const buf = Buffer.alloc(8 * entry.values.length)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    entry.values.forEach((v, i) => view.setUint32(i * 8, v, little))
    return buf
  }
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

/**
 * Builds a TIFF: header, strip payloads, IFD, then any out-of-line values.
 *
 * `extra` appends entries, which is how a test asks for a file the reader must
 * refuse — a second band, a RATIONAL tag it does not read.
 */
export function buildTiff({
  width, height, values,
  bitsPerSample = 32, sampleFormat = 3, compression = 1, predictor = 1,
  little = true, tiepoint = null, pixelScale = null, nodataTag = null,
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
    ...(pixelScale === null ? [] : [{ tag: TAG.ModelPixelScale, type: 12, values: pixelScale }]),
    ...(tiepoint === null ? [] : [{ tag: TAG.ModelTiepoint, type: 12, values: tiepoint }]),
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
    // The count in an IFD entry is a count of *values*, not of bytes: a
    // RATIONAL of 72/1 is one value in eight bytes, and a STRING's count is its
    // byte length because each byte is one value.
    iview.setUint32(pos + 4,
      entry.type === 2 ? bytes.length : entry.type === 5 ? entry.values.length / 2 : entry.values.length,
      little)
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

/**
 * A global 0.05-degree CHIRPS-shaped grid with the three default regions at
 * their own cells.
 *
 * The real product is 7200x2000 and 57.6 MB; this is the same geometry at a
 * coarser scale so a test can name a coordinate and know its value. Nodata
 * (-9999) fills everything the test did not set, which is how the real file
 * distinguishes ocean from a dry day.
 */
export function buildChirpsShapedTiff({ values, nodata = -9999 } = {}) {
  const width = 720
  const height = 200
  const scale = 0.5
  const grid = new Array(width * height).fill(nodata)
  const cell = (lat, lon) => {
    const col = Math.min(width - 1, Math.floor((lon + 180) / scale))
    const row = Math.min(height - 1, Math.floor((50 - lat) / scale))
    return row * width + col
  }
  const put = (lat, lon, value) => { grid[cell(lat, lon)] = value }
  for (const [lat, lon, value] of values) put(lat, lon, value)
  return buildTiff({
    width, height, values: grid, bitsPerSample: 32, sampleFormat: 3,
    tiepoint: [0, 0, 0, -180, 50, 0], pixelScale: [scale, scale, 0],
    nodataTag: String(nodata),
  })
}

export { TAG as TAG }

/**
 * Rewrites a TIFF with one tag's entry removed, by zeroing its tag id.
 *
 * The reader skips tags it does not know, so a zeroed tag is simply absent —
 * which is how a tiled file looks to it.
 */
export function stripTag(buffer, tag) {
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

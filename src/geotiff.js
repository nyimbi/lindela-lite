import { inflateSync } from 'node:zlib'

/**
 * A minimal GeoTIFF reader, sized to CHIRPS and honest about everything else.
 *
 * CHIRPS-2.0 daily p05 is the easiest possible raster case, verified from the
 * live bytes (see `docs/research/chirps-geotiff/README.md`): little-endian,
 * stripped one row per strip, **uncompressed inside the TIFF** (the `.gz` is
 * the whole of the compression), single-band Float32, a contiguous data run,
 * nodata -9999 by convention. A general raster library would be 3.8 MB and
 * eight transitive dependencies for a format this repository reads one product
 * from — the same trade `src/terrain.js:68-73` already declined for Terrarium
 * PNGs.
 *
 * The design rule here is the one this repo keeps re-learning: **refuse to
 * guess**. A reader that silently mis-decodes LZW, or forgets to undo a
 * horizontal predictor, does not fail — it returns plausible numbers, and
 * plausible numbers are indistinguishable from rainfall. Every unsupported
 * combination throws with the tag named.
 *
 * Supported: TIFF baseline, byte order either way, single band, chunky
 * (PlanarConfig 1), compression 1 / 8 / 32946, BitsPerSample 8/16/32/64,
 * SampleFormat unsigned / signed / IEEE float, Predictor 1 or 2.
 * Not supported, and refused: tiled files, multiple bands, LZW/PackBits/JPEG,
 * Predictor 3 (floating-point differencing), ModelTransformation (rotated
 * grids), BigTIFF.
 */

/** TIFF tags this reader reads. Anything else is ignored, not guessed at. */
const TAG = Object.freeze({
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  PlanarConfig: 284,
  Predictor: 317,
  SampleFormat: 339,
  ModelPixelScale: 33550,
  ModelTiepoint: 33922,
  ModelTransformation: 34264,
  GdalNoData: 42113,
})

/** Bytes per element for the TIFF field types this reader implements. */
const TYPE_SIZE = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8 })

const COMPRESSION_NONE = 1
const COMPRESSION_DEFLATE = 8
const COMPRESSION_DEFLATE_OLD = 32946

const SAMPLEFORMAT_UNSIGNED = 1
const SAMPLEFORMAT_SIGNED = 2
const SAMPLEFORMAT_FLOAT = 3

/**
 * Decodes a GeoTIFF into a row-major grid of values.
 *
 * `nodata` is resolved from the file's own `GDAL_NODATA` tag when it declares
 * one, and from `options.nodata` otherwise — CHIRPS does not declare it, so the
 * caller has to, and the value it passes is recorded in the research note
 * rather than assumed here. With neither, no cell is masked: a reader that
 * invents -9999 as a default would turn a real measurement into a hole.
 *
 * Cells holding the nodata sentinel, and non-finite cells, come back as `NaN` —
 * the same contract `decodeTerrarium` uses (`src/terrain.js:83`).
 */
export function decodeGeoTiff(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('GeoTIFF: expected a Buffer')
  if (buffer.length < 8) throw new Error('GeoTIFF: shorter than a TIFF header')

  const order = buffer.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') {
    throw new Error(`GeoTIFF: byte-order mark is ${JSON.stringify(order)}, neither II nor MM`)
  }
  const little = order === 'II'
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  const magic = view.getUint16(2, little)
  if (magic !== 42) throw new Error(`GeoTIFF: magic is ${magic}, not 42 — this is not a TIFF (BigTIFF uses 43 and is not supported)`)

  const entries = readIfd(buffer, view, view.getUint32(4, little), little)
  // A tag this reader does not read may use a field type it does not implement
  // — the real CHIRPS file carries XResolution (282) as a RATIONAL (type 5),
  // which nothing here needs. Its values are therefore resolved lazily: asking
  // for a tag whose type is unsupported throws, and a tag nobody asks for is
  // simply absent. Refusing the whole file over a tag that is never read would
  // make the reader narrower than the format for no gain.
  const valuesOf = (tag) => {
    const entry = entries.get(tag)
    if (!entry) return undefined
    if (entry.unsupportedType) {
      throw new Error(`GeoTIFF: tag ${tag} uses TIFF field type ${entry.unsupportedType}, which this reader does not implement`)
    }
    return entry.values
  }
  const num = (tag) => {
    const values = valuesOf(tag)
    return values === undefined ? undefined : values[0]
  }
  const list = (tag) => valuesOf(tag)

  if (entries.has(TAG.ModelTransformation)) {
    throw new Error('GeoTIFF: ModelTransformation (34264) present — the grid is rotated or sheared, which this reader does not model')
  }
  if (list(TAG.StripOffsets) === undefined) {
    throw new Error('GeoTIFF: no StripOffsets (273) — the file is tiled, which this reader does not support')
  }

  const width = num(TAG.ImageWidth)
  const height = num(TAG.ImageLength)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`GeoTIFF: ImageWidth/ImageLength are ${width}/${height}, which do not describe a grid`)
  }

  const samplesPerPixel = num(TAG.SamplesPerPixel) ?? 1
  if (samplesPerPixel !== 1) {
    throw new Error(`GeoTIFF: SamplesPerPixel is ${samplesPerPixel}; this reader decodes one band, not a colour image`)
  }
  const planarConfig = num(TAG.PlanarConfig) ?? 1
  if (planarConfig !== 1) {
    throw new Error(`GeoTIFF: PlanarConfig is ${planarConfig}; only chunky (1) is supported`)
  }

  const bits = list(TAG.BitsPerSample) ?? [8]
  if (new Set(bits).size !== 1) {
    throw new Error(`GeoTIFF: BitsPerSample is ${bits.join('/')}; mixed sample widths are not supported`)
  }
  const bitsPerSample = bits[0]
  if (![8, 16, 32, 64].includes(bitsPerSample)) {
    throw new Error(`GeoTIFF: BitsPerSample ${bitsPerSample} is not 8, 16, 32 or 64`)
  }
  const sampleFormat = num(TAG.SampleFormat) ?? SAMPLEFORMAT_UNSIGNED
  if (![SAMPLEFORMAT_UNSIGNED, SAMPLEFORMAT_SIGNED, SAMPLEFORMAT_FLOAT].includes(sampleFormat)) {
    throw new Error(`GeoTIFF: SampleFormat ${sampleFormat} is not unsigned (1), signed (2) or IEEE float (3)`)
  }
  if (sampleFormat === SAMPLEFORMAT_FLOAT && bitsPerSample !== 32 && bitsPerSample !== 64) {
    throw new Error(`GeoTIFF: IEEE float samples are stored as 32 or 64 bits, not ${bitsPerSample}`)
  }

  const compression = num(TAG.Compression) ?? COMPRESSION_NONE
  if (![COMPRESSION_NONE, COMPRESSION_DEFLATE, COMPRESSION_DEFLATE_OLD].includes(compression)) {
    throw new Error(`GeoTIFF: Compression ${compression} is not supported (1 = none, 8/32946 = deflate). LZW and PackBits are refused rather than mis-decoded`)
  }

  const predictor = num(TAG.Predictor) ?? 1
  if (predictor !== 1 && predictor !== 2) {
    throw new Error(`GeoTIFF: Predictor ${predictor} is not supported (1 = none, 2 = horizontal differencing)`)
  }
  if (predictor === 2 && sampleFormat === SAMPLEFORMAT_FLOAT) {
    throw new Error('GeoTIFF: Predictor 2 is horizontal differencing on integers; a float sample with Predictor 2 is a malformed file')
  }

  const stripOffsets = list(TAG.StripOffsets)
  const stripByteCounts = list(TAG.StripByteCounts)
  if (!stripByteCounts) throw new Error('GeoTIFF: no StripByteCounts (279) beside StripOffsets (273)')
  if (stripOffsets.length !== stripByteCounts.length) {
    throw new Error(`GeoTIFF: ${stripOffsets.length} strip offsets against ${stripByteCounts.length} byte counts`)
  }

  const rowsPerStrip = num(TAG.RowsPerStrip) ?? height
  if (!Number.isInteger(rowsPerStrip) || rowsPerStrip <= 0) {
    throw new Error(`GeoTIFF: RowsPerStrip is ${rowsPerStrip}, which does not describe a strip`)
  }
  const stripCount = Math.ceil(height / rowsPerStrip)
  if (stripOffsets.length !== stripCount) {
    throw new Error(`GeoTIFF: ${stripOffsets.length} strips for ${height} rows at ${rowsPerStrip} rows per strip, which needs ${stripCount}`)
  }

  const bytesPerSample = bitsPerSample / 8
  const sample = { little, bitsPerSample, sampleFormat }
  const raw = new Float64Array(width * height)

  for (let s = 0; s < stripCount; s += 1) {
    const firstRow = s * rowsPerStrip
    const rows = Math.min(rowsPerStrip, height - firstRow)
    const expected = rows * width * bytesPerSample
    const start = stripOffsets[s]
    const length = stripByteCounts[s]
    if (start + length > buffer.length) {
      throw new Error(`GeoTIFF: strip ${s} claims bytes ${start}..${start + length} of a ${buffer.length}-byte file`)
    }

    let bytes = buffer.subarray(start, start + length)
    if (compression !== COMPRESSION_NONE) bytes = inflateSync(bytes)
    if (bytes.length < expected) {
      throw new Error(`GeoTIFF: strip ${s} holds ${bytes.length} bytes, short of the ${expected} its ${rows}x${width} rows need`)
    }

    if (predictor === 2) undoHorizontalPredictor(bytes, rows, width, sample)
    const values = readSamples(bytes, rows * width, sample)
    raw.set(values, firstRow * width)
  }

  const tagNodata = num(TAG.GdalNoData)
  const declared = tagNodata === undefined ? null : Number.parseFloat(tagNodata)
  const nodata = Number.isFinite(declared)
    ? declared
    : (Number.isFinite(options.nodata) ? options.nodata : null)

  const grid = new Float64Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) {
    const v = raw[i]
    grid[i] = Number.isFinite(v) && (nodata === null || v !== nodata) ? v : NaN
  }

  return {
    width,
    height,
    grid,
    nodata,
    bbox: gridBbox(list(TAG.ModelTiepoint), list(TAG.ModelPixelScale), width, height),
  }
}

/**
 * Samples one point from a decoded grid, nearest cell.
 *
 * A point outside the grid is refused, never clamped to the edge and never
 * answered with a 0: "no rainfall here" and "we did not look here" are
 * different findings, and CHIRPS covers 50S-50N, so the second is common.
 * The bounds are half-open on the far edge, because the eastern boundary
 * column belongs to the next cell, not this one.
 */
export function sampleAt(decoded, lat, lon) {
  if (!decoded || !decoded.bbox) return { value: null, nodata: false, reason: 'no_georeferencing' }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { value: null, nodata: false, reason: 'invalid_coordinate' }

  const { north, south, west, east } = decoded.bbox
  if (lon < west || lon >= east || lat > north || lat <= south) {
    return { value: null, nodata: false, reason: 'outside_grid' }
  }

  const col = Math.min(decoded.width - 1, Math.floor(((lon - west) / (east - west)) * decoded.width))
  const row = Math.min(decoded.height - 1, Math.floor(((north - lat) / (north - south)) * decoded.height))
  const value = decoded.grid[row * decoded.width + col]
  if (!Number.isFinite(value)) return { value: null, nodata: true, reason: 'nodata' }
  return { value, nodata: false, reason: null }
}

/** The geographic extent a tiepoint and a pixel scale imply, or null. */
function gridBbox(tiepoint, pixelScale, width, height) {
  if (!tiepoint || !pixelScale || tiepoint.length < 6 || pixelScale.length < 2) return null
  const [i, j] = tiepoint
  const x = tiepoint[3]
  const y = tiepoint[4]
  const [sx, sy] = pixelScale
  if (![i, j, x, y, sx, sy].every(Number.isFinite) || sx === 0 || sy === 0) return null
  return {
    west: x - i * sx,
    east: x + (width - i) * sx,
    north: y - j * sy,
    south: y - (j + height) * sy,
  }
}

/** Reads IFD0 into a tag-keyed map of resolved values. */
function readIfd(buffer, view, offset, little) {
  if (offset + 2 > buffer.length) throw new Error(`GeoTIFF: IFD offset ${offset} is past the end of a ${buffer.length}-byte file`)
  const count = view.getUint16(offset, little)
  const entries = new Map()
  for (let i = 0; i < count; i += 1) {
    const pos = offset + 2 + i * 12
    if (pos + 12 > buffer.length) throw new Error(`GeoTIFF: IFD entry ${i} runs past the end of the file`)
    const tag = view.getUint16(pos, little)
    const type = view.getUint16(pos + 2, little)
    const n = view.getUint32(pos + 4, little)
    if (!TYPE_SIZE[type]) {
      entries.set(tag, { tag, type, unsupportedType: type, values: undefined })
      continue
    }
    entries.set(tag, { tag, type, values: readValues(buffer, view, { tag, type, count: n, valueFieldPos: pos + 8 }, little) })
  }
  return entries
}

/** Resolves one IFD entry's values, inline when they fit in four bytes. */
function readValues(buffer, view, entry, little) {
  const size = TYPE_SIZE[entry.type]
  const total = size * entry.count
  const start = total <= 4 ? entry.valueFieldPos : view.getUint32(entry.valueFieldPos, little)
  if (start + total > buffer.length) {
    throw new Error(`GeoTIFF: tag ${entry.tag} claims ${total} bytes at ${start}, past the end of a ${buffer.length}-byte file`)
  }
  if (entry.type === 2) {
    return [buffer.toString('latin1', start, start + entry.count).split('\u0000')[0]]
  }
  const out = []
  for (let i = 0; i < entry.count; i += 1) {
    const off = start + i * size
    if (entry.type === 3) out.push(view.getUint16(off, little))
    else if (entry.type === 4) out.push(view.getUint32(off, little))
    else if (entry.type === 11) out.push(view.getFloat32(off, little))
    else out.push(view.getFloat64(off, little))
  }
  return out
}

/** Reads a strip's samples as numbers, honouring width, signedness and order. */
function readSamples(bytes, count, { little, bitsPerSample, sampleFormat }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float64Array(count)
  const step = bitsPerSample / 8
  for (let i = 0; i < count; i += 1) {
    const off = i * step
    if (sampleFormat === SAMPLEFORMAT_FLOAT) {
      out[i] = bitsPerSample === 64 ? view.getFloat64(off, little) : view.getFloat32(off, little)
    } else if (bitsPerSample === 8) {
      out[i] = sampleFormat === SAMPLEFORMAT_SIGNED ? view.getInt8(off) : view.getUint8(off)
    } else if (bitsPerSample === 16) {
      out[i] = sampleFormat === SAMPLEFORMAT_SIGNED ? view.getInt16(off, little) : view.getUint16(off, little)
    } else {
      out[i] = sampleFormat === SAMPLEFORMAT_SIGNED ? view.getInt32(off, little) : view.getUint32(off, little)
    }
  }
  return out
}

/**
 * Undoes Predictor 2, horizontal differencing, in place.
 *
 * Each row restarts: the first sample of a row is stored verbatim and every
 * later sample is the difference from its left neighbour. Skipping this step is
 * the classic silent-corruption trap — the grid still reads as numbers, and the
 * numbers are differences, so a rainfall field turns into a field of small
 * signed deltas that look like plausible dry-day values.
 *
 * Arithmetic is done on the integer domain and written back through the same
 * width, so 16- and 32-bit wraparound is the file format's own and not a
 * float64 artefact.
 */
function undoHorizontalPredictor(bytes, rows, width, { little, bitsPerSample, sampleFormat }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const step = bitsPerSample / 8
  const read = (off) => {
    if (bitsPerSample === 8) return sampleFormat === SAMPLEFORMAT_SIGNED ? view.getInt8(off) : view.getUint8(off)
    if (bitsPerSample === 16) return sampleFormat === SAMPLEFORMAT_SIGNED ? view.getInt16(off, little) : view.getUint16(off, little)
    return sampleFormat === SAMPLEFORMAT_SIGNED ? view.getInt32(off, little) : view.getUint32(off, little)
  }
  const write = (off, v) => {
    if (bitsPerSample === 8) { sampleFormat === SAMPLEFORMAT_SIGNED ? view.setInt8(off, v) : view.setUint8(off, v); return }
    if (bitsPerSample === 16) { sampleFormat === SAMPLEFORMAT_SIGNED ? view.setInt16(off, v, little) : view.setUint16(off, v, little); return }
    sampleFormat === SAMPLEFORMAT_SIGNED ? view.setInt32(off, v, little) : view.setUint32(off, v, little)
  }
  for (let r = 0; r < rows; r += 1) {
    const rowStart = r * width * step
    for (let c = 1; c < width; c += 1) {
      const off = rowStart + c * step
      write(off, read(off) + read(off - step))
    }
  }
}

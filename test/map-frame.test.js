import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  NEAR_REGION_MARGIN_DEG,
  REGION_OF_INTEREST,
  computeBbox,
  isFinitePoint,
  mapFrame,
  withinBbox,
} from '../public/shared/map-frame.js'

const R = REGION_OF_INTEREST

const at = (latitude, longitude) => ({ latitude, longitude })

// Five pilot districts, roughly where the demo seeds them.
const PILOT = [
  at(3.1167, 35.6),    // Turkana
  at(6.207, 31.548),   // Bor
  at(8.767, 27.4),     // Aweil
  at(2.5333, 34.6667), // Moroto
  at(3.9366, 41.8569), // Mandera
]

// The shape of a worldwide GDACS pull observed on 2026-10-01: 125 geolocated
// events spanning 131 degrees of longitude, under 1% inside the region.
const WORLDWIDE = [
  at(-67.7, 63.2),
  at(63.2, -179.2),
  at(10.5, -32.9),
  at(-6.18, 1.82),
  at(35.68, 139.69),
  at(1.35, 103.8),
  ...PILOT,
]

describe('map framing', () => {
  it('identifies only records with finite coordinates', () => {
    assert.equal(isFinitePoint(at(1, 2)), true)
    assert.equal(isFinitePoint({ latitude: 1 }), false)
    assert.equal(isFinitePoint({ latitude: NaN, longitude: 2 }), false)
    assert.equal(isFinitePoint({ latitude: '3', longitude: '4' }), false)
    assert.equal(isFinitePoint(null), false)
    assert.equal(isFinitePoint(undefined), false)
  })

  it('tests bbox containment with an optional margin', () => {
    const box = { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 }
    assert.equal(withinBbox(at(5, 5), box), true)
    assert.equal(withinBbox(at(0, 0), box), true, 'edges are inside')
    assert.equal(withinBbox(at(11, 5), box), false)
    assert.equal(withinBbox(at(11, 5), box, 2), true, 'margin admits nearby points')
    assert.equal(withinBbox({ latitude: 5 }, box), false)
  })

  it('returns null for an empty record set rather than a zero-area box', () => {
    assert.equal(computeBbox([]), null)
    assert.equal(computeBbox([{ latitude: NaN, longitude: 1 }]), null)
  })

  it('pads the computed extent', () => {
    const box = computeBbox([at(0, 0), at(10, 10)], 1)
    assert.equal(box.minLat, -1)
    assert.equal(box.maxLat, 11)
    assert.equal(box.minLon, -1)
    assert.equal(box.maxLon, 11)
  })

  it('always covers the region of interest even with no data', () => {
    const { frame, framedBy } = mapFrame([])
    assert.equal(frame.minLat, R.minLat)
    assert.equal(frame.maxLat, R.maxLat)
    assert.equal(frame.minLon, R.minLon)
    assert.equal(frame.maxLon, R.maxLon)
    assert.equal(framedBy, 'all_data')
  })

  it('does not let worldwide feeds dictate the frame', () => {
    // The bug: a global alert stream spanned 131 degrees of longitude and
    // squeezed the five pilot districts into an unreadable smudge at the
    // centre. Found by screenshotting the running dashboard.
    const { frame, nearCount, outOfRegionCount, framedBy } = mapFrame(WORLDWIDE)
    assert.equal(framedBy, 'region_of_interest_plus_nearby_data')
    assert.ok(outOfRegionCount > 0, 'the fixture must include far-flung points')

    const spanBefore = { lat: 130.9, lon: 322.4 }
    const spanAfter = { lat: frame.maxLat - frame.minLat, lon: frame.maxLon - frame.minLon }
    assert.ok(
      spanAfter.lat < spanBefore.lat / 4,
      `latitude span ${spanAfter.lat.toFixed(1)} should be far below the raw data span`,
    )
    assert.ok(
      spanAfter.lon < spanBefore.lon / 4,
      `longitude span ${spanAfter.lon.toFixed(1)} should be far below the raw data span`,
    )
    assert.ok(nearCount > 0)
  })

  it('keeps every pilot district inside the frame', () => {
    const { frame } = mapFrame(WORLDWIDE)
    for (const point of PILOT) {
      assert.ok(
        point.latitude >= frame.minLat && point.latitude <= frame.maxLat
        && point.longitude >= frame.minLon && point.longitude <= frame.maxLon,
        `${point.latitude},${point.longitude} fell outside the frame`,
      )
    }
  })

  it('reports the same extent for drawing and for terrain requests', () => {
    // A terrain request over the whole globe would time out, or silently drop
    // to a zoom where cell depths average across whole landscapes. The two
    // extents must therefore agree.
    const { frame, dataExtent } = mapFrame(WORLDWIDE)
    assert.deepEqual(dataExtent, frame)
  })

  it('adopts near-region data outside the base extent', () => {
    // Data just outside the region still counts when it is within the margin.
    const outside = at(R.maxLat + NEAR_REGION_MARGIN_DEG - 1, R.maxLon - 1)
    const { frame, nearCount } = mapFrame([...PILOT, outside])
    assert.equal(nearCount, PILOT.length + 1)
    assert.ok(frame.maxLat >= outside.latitude, 'nearby data must widen the frame')
  })

  it('falls back to all data when nothing is near the region', () => {
    const far = [at(35.68, 139.69), at(-33.9, 18.4)]
    const { framedBy, nearCount, frame } = mapFrame(far)
    assert.equal(nearCount, 0)
    assert.equal(framedBy, 'all_data')
    assert.ok(frame.maxLat > R.maxLat, 'with no near data, the frame follows the data')
  })

  it('survives records missing coordinates without dropping the rest', () => {
    const { frame, nearCount } = mapFrame([...PILOT, { id: 'no-geo' }, null])
    assert.equal(nearCount, PILOT.length)
    assert.ok(Number.isFinite(frame.maxLon))
  })
})
describe('map framing with an active simulation', () => {
  const simFocus = { minLat: 2.9, maxLat: 3.4, minLon: 35.3, east: 35.9, maxLon: 35.9 }

  it('frames on the simulation extent when one is supplied', () => {
    // Without this the shaded district sat as a few pixels in a Horn-wide view.
    const { frame, framedBy } = mapFrame(WORLDWIDE, R, simFocus)
    assert.equal(framedBy, 'focus')
    assert.ok(frame.maxLat - frame.minLat <= simFocus.maxLat - simFocus.minLat + 1e-9)
    assert.ok(frame.maxLon - frame.minLon <= simFocus.maxLon - simFocus.minLon + 1e-9)
  })

  it('lets an explicit focus replace the region anchor entirely', () => {
    // Unioning the focus with a 25-degree region would leave the focus a
    // no-op, which is the bug: the shaded district stayed a few pixels wide
    // inside a Horn-wide view.
    const zoomIn = { minLat: 40, maxLat: 41, minLon: 10, maxLon: 11 }
    const { frame, framedBy } = mapFrame([], R, zoomIn)
    assert.equal(framedBy, 'focus')
    assert.deepEqual(frame, zoomIn)
    assert.ok(frame.maxLat - frame.minLat < R.maxLat - R.minLat)
  })

  it('ignores a null focus and frames normally', () => {
    const { framedBy, frame } = mapFrame(PILOT, R, null)
    assert.equal(framedBy, 'region_of_interest_plus_nearby_data')
    assert.ok(frame.maxLat >= R.maxLat)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AFRICA_BBOX,
  NEAR_REGION_MARGIN_DEG,
  REGION_OF_INTEREST,
  MAX_MAP_SCALE,
  MIN_MAP_SCALE,
  computeBbox,
  fitTransform,
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
    assert.equal(framedBy, 'pilot_districts_plus_nearby_data')
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
    assert.equal(framedBy, 'pilot_districts_plus_nearby_data')
    // A null focus must fall through to ordinary framing. That framing is the
    // pilot districts plus nearby data — not the whole region box, which is the
    // behaviour this deliberately stopped doing: the region is 21 degrees tall
    // and the districts occupy 6.2 of that, so the rest was ocean.
    const districtTop = Math.max(...PILOT.map((p) => p.latitude))
    assert.ok(
      frame.maxLat >= districtTop,
      `every pilot district stays in frame (top ${districtTop}, frame ${frame.maxLat.toFixed(2)})`,
    )
    assert.ok(
      frame.maxLat < R.maxLat,
      `and the frame does not climb back to the region ceiling (${frame.maxLat.toFixed(2)} vs ${R.maxLat})`,
    )
  })
})

describe('Africa projection frame and transform fitting', () => {
  it('exposes an Africa-wide bbox', () => {
    assert.ok(AFRICA_BBOX.minLat < -30)
    assert.ok(AFRICA_BBOX.maxLat > 30)
    assert.ok(AFRICA_BBOX.minLon < 0)
    assert.ok(AFRICA_BBOX.maxLon > 50)
    assert.ok(AFRICA_BBOX.maxLat - AFRICA_BBOX.minLat > 70)
    assert.ok(AFRICA_BBOX.maxLon - AFRICA_BBOX.minLon > 70)
  })

  it('fits the Horn region into the Africa frame at scale > 1', () => {
    const t = fitTransform(REGION_OF_INTEREST, AFRICA_BBOX, 800, 500)
    assert.ok(t.scale > 1, `scale ${t.scale} should zoom in on the Horn`)
    // Center of the Horn should project near the centre of the viewport after fitting.
    const hornCx = (REGION_OF_INTEREST.minLon + REGION_OF_INTEREST.maxLon) / 2
    const hornCy = (REGION_OF_INTEREST.minLat + REGION_OF_INTEREST.maxLat) / 2
    const px = ((hornCx - AFRICA_BBOX.minLon) / (AFRICA_BBOX.maxLon - AFRICA_BBOX.minLon)) * 800
    const py = ((AFRICA_BBOX.maxLat - hornCy) / (AFRICA_BBOX.maxLat - AFRICA_BBOX.minLat)) * 500
    const screenX = t.x + t.scale * px
    const screenY = t.y + t.scale * py
    assert.ok(Math.abs(screenX - 400) < 1, `fitted center x ${screenX} should be viewport centre`)
    assert.ok(Math.abs(screenY - 250) < 1, `fitted center y ${screenY} should be viewport centre`)
  })

  it('fits the whole Africa frame at unit scale when padding is zero', () => {
    const t = fitTransform(AFRICA_BBOX, AFRICA_BBOX, 800, 500, 0)
    assert.ok(Math.abs(t.scale - 1) < 1e-9)
    assert.ok(Math.abs(t.x) < 1e-9)
    assert.ok(Math.abs(t.y) < 1e-9)
  })

  it('returns null for invalid inputs', () => {
    assert.equal(fitTransform(null, AFRICA_BBOX, 800, 500), null)
    assert.equal(fitTransform(AFRICA_BBOX, null, 800, 500), null)
    assert.equal(fitTransform(AFRICA_BBOX, AFRICA_BBOX, 0, 500), null)
    assert.equal(fitTransform({ minLat: 0, maxLat: 0, minLon: 0, maxLon: 10 }, AFRICA_BBOX, 800, 500), null)
  })

  it('frames a corridor far too small for the projection, instead of throwing it off-screen', () => {
    // The Lodwar corridor the demo routes through: 6.8 km of road, which is
    // 0.09 by 0.11 degrees. Inside the Africa projection that asks for scale
    // ~774 — but applyMapTransform clamps the rendered scale to 10, so the
    // returned translate (computed for 774) was applied to a scale of 10 and
    // put every hop marker hundreds of thousands of pixels outside the
    // viewport. Planning a route blanked the map.
    const corridor = { minLat: 3.05, maxLat: 3.14, minLon: 35.55, maxLon: 35.66 }
    const t = fitTransform(corridor, AFRICA_BBOX, 800, 500)
    assert.ok(t.scale <= MAX_MAP_SCALE, `scale ${t.scale} must be renderable`)
    assert.ok(t.scale >= MIN_MAP_SCALE, `scale ${t.scale} must be renderable`)

    // Every point of the target must land inside the viewBox once the transform
    // is applied — that is what "frame on this" promises.
    const projLonSpan = AFRICA_BBOX.maxLon - AFRICA_BBOX.minLon
    const projLatSpan = AFRICA_BBOX.maxLat - AFRICA_BBOX.minLat
    const onScreen = (lat, lon) => {
      const px = ((lon - AFRICA_BBOX.minLon) / projLonSpan) * 800
      const py = ((AFRICA_BBOX.maxLat - lat) / projLatSpan) * 500
      return { x: t.x + t.scale * px, y: t.y + t.scale * py }
    }
    for (const [lat, lon] of [[corridor.minLat, corridor.minLon], [corridor.maxLat, corridor.maxLon]]) {
      const { x, y } = onScreen(lat, lon)
      assert.ok(x > 0 && x < 800, `x ${x} outside the viewBox`)
      assert.ok(y > 0 && y < 500, `y ${y} outside the viewBox`)
    }

    // Inside the frame is not enough — the corridor must be *legible*. The
    // routing feature exists to show a detour around a cut segment, and at the
    // old cap of 10 the whole corridor rendered across ~2 px, so the reroute
    // was a single dot. The requirement is that the hop markers do not collide:
    // each is drawn at radius 8 (renderRouteLayer) and counter-scaled to a
    // constant screen size, so the corridor must span several marker diameters.
    const a = onScreen(corridor.minLat, corridor.minLon)
    const b = onScreen(corridor.maxLat, corridor.maxLon)
    const spread = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    const markerDiameter = 16
    assert.ok(spread > 3 * markerDiameter,
      `corridor spans ${spread.toFixed(1)} of 800 viewBox units, under 3 marker diameters (${3 * markerDiameter})`)
  })

  it('keeps a fit that is already within the zoom bounds unclamped', () => {
    // The clamp must not move an ordinary fit. The Horn frame is the default
    // view and the Africa frame is the floor; neither is near a bound.
    const horn = fitTransform(REGION_OF_INTEREST, AFRICA_BBOX, 800, 500)
    assert.ok(horn.scale > 1 && horn.scale < MAX_MAP_SCALE)
    const africa = fitTransform(AFRICA_BBOX, AFRICA_BBOX, 800, 500, 0)
    assert.ok(Math.abs(africa.scale - 1) < 1e-9)
  })
})

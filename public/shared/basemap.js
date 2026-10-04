// Horn of Africa basemap — inline polygon data, no network requests.
// All coordinates [lon, lat]. Rings are closed (last vertex == first vertex).
// Accuracy: ~15-30 vertices per country, recognizable at glance, not survey-grade.

export const REGION_POLYGONS = {
  KEN: {
    name: 'Kenya',
    ring: [
      [34.0, 0.1], [34.0, 1.2], [34.8, 4.0], [35.9, 4.6],
      [38.5, 5.0], [40.5, 4.3], [41.9, 3.9],
      [41.8, 2.0], [41.5, 0.0], [40.8, -1.8],
      [40.2, -3.2], [39.7, -4.0], [39.2, -4.7], [37.5, -4.7],
      [36.0, -1.8], [34.5, -0.8], [34.0, 0.1],
    ],
  },
  UGA: {
    name: 'Uganda',
    ring: [
      [29.6, 4.2], [30.5, 4.2], [31.8, 3.8], [33.9, 3.8],
      [34.8, 3.5], [34.0, 1.2], [34.0, 0.1], [33.5, -0.5],
      [32.0, -1.5], [30.8, -1.4], [30.0, -1.0],
      [29.7, 0.5], [29.6, 2.0], [29.5, 3.5], [29.6, 4.2],
    ],
  },
  SSD: {
    name: 'South Sudan',
    ring: [
      [27.0, 10.0], [29.0, 10.5], [31.5, 12.0],
      [33.5, 11.5], [35.5, 11.0], [36.0, 8.5],
      [34.5, 6.5], [33.9, 4.5], [31.8, 3.8],
      [30.5, 4.2], [29.6, 4.2], [29.5, 3.5],
      [28.0, 5.5], [27.0, 7.0], [26.5, 9.0], [27.0, 10.0],
    ],
  },
  ETH: {
    name: 'Ethiopia',
    ring: [
      [33.0, 12.0], [34.0, 14.5], [36.5, 15.0],
      [38.5, 15.0], [40.5, 15.0], [42.0, 13.0],
      [43.0, 11.5], [44.5, 10.0], [46.0, 8.5],
      [47.5, 7.5], [47.5, 4.5], [44.0, 4.0],
      [41.9, 3.9], [40.5, 4.3], [38.5, 5.0],
      [35.9, 4.6], [34.5, 4.5], [34.5, 6.5],
      [35.5, 11.0], [33.0, 12.0],
    ],
  },
  SOM: {
    name: 'Somalia',
    ring: [
      [43.0, 11.5], [44.5, 11.3], [47.0, 11.5],
      [49.0, 11.5], [51.3, 11.8], [51.5, 11.0],
      [51.0, 8.5], [50.0, 6.5], [48.0, 3.5],
      [45.5, 1.5], [43.5, 0.0], [42.0, -0.8],
      [41.5, -1.7], [41.9, 3.9], [44.0, 4.0],
      [44.5, 8.5], [44.0, 11.0], [43.0, 11.5],
    ],
  },
  TZA: {
    name: 'Tanzania',
    ring: [
      [29.5, -1.0], [30.8, -1.4], [32.0, -1.5],
      [34.0, -0.5], [34.5, -1.0], [36.0, -1.8],
      [37.5, -4.7], [39.2, -4.7], [40.5, -6.0],
      [40.5, -11.5], [29.5, -11.5], [29.5, -1.0],
    ],
  },
}

// Pilot districts matching src/districts.js, center as [lon, lat].
export const PILOT_DISTRICTS = [
  { slug: 'turkana',  name: 'Turkana',  country: 'KE', center: [35.6,    3.1167], radius_km: 200 },
  { slug: 'aweil',    name: 'Aweil',    country: 'SS', center: [27.4,    8.767 ], radius_km: 150 },
  { slug: 'bor',      name: 'Bor',      country: 'SS', center: [31.548,  6.207 ], radius_km: 150 },
  { slug: 'karamoja', name: 'Karamoja', country: 'UG', center: [34.6667, 2.5333], radius_km: 200 },
  { slug: 'mandera',  name: 'Mandera',  country: 'KE', center: [41.8569, 3.9366], radius_km: 150 },
]

// The Indian Ocean east of Somalia, Kenya and Tanzania.
//
// This was a rectangle from lon 40 to lon 52, meant to be a stub for the sea
// and harmless because it was drawn under the land. It is not harmless: the
// land layer is a 60% wash, not an opaque plate, so the water tints through it
// and the rectangle's western edge shows as a hard vertical seam down the map.
// Widened frame, seam at the edge; frame anchored on the pilot districts, seam
// at lon 40 straight through the middle of Kenya.
//
// So the western edge follows the coast instead. It traces the country rings'
// own eastern vertices offset 0.6 degrees inland: those rings carry 15-30
// vertices per country, so where the sea is drawn slightly wrong it is drawn
// slightly wrong UNDER the land, where the 60% land wash hides it. Bias it too
// far and that same wash stops being an outline and starts being a two-tone
// map — 3 degrees inland put the sea under most of Somalia and the land came
// out uniformly dark. A polygon that poked past the coast would paint sea
// inside Somalia, which is worse.
export const INDIAN_OCEAN_POLYGON = [
  [50.7, 15.5], [52.5, 15.5], [52.5, -12.0], [39.9, -11.5],
  [39.9, -6.0], [39.1, -4.0], [39.6, -3.2], [40.2, -1.8],
  [41.4, -0.8], [42.9, 0.0], [44.9, 1.5], [47.4, 3.5],
  [49.4, 6.5], [50.4, 8.5], [50.9, 11.0], [50.7, 11.8],
  [50.7, 15.5],
]

// Lake Victoria: shared by Uganda, Kenya, Tanzania.
export const LAKE_VICTORIA = [
  [31.5, 0.5],  [33.0, 0.5],  [34.2, -0.5],
  [34.5, -1.5], [34.0, -2.5], [33.0, -3.0],
  [31.5, -2.5], [30.5, -1.5], [30.5, -0.5],
  [31.5, 0.5],
]

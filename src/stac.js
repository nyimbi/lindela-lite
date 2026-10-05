import { toGeoJson, readCoordinate, publicProperties } from './utils.js'

/**
 * The catalog's collections, in one place.
 *
 * This list was written in four. The catalog advertised three child links; the
 * collection renderer validated against a hardcoded `validIds`; and `server.js`
 * spelled the same three-way `if/else` out twice — once for the STAC route and
 * once for the OGC route. They agree today, and the mechanism by which they
 * would stop agreeing is that anyone adding a collection edits the two the
 * server needs and forgets the two in this file. The result would be a collection
 * the catalog advertises and the server 404s, or worse, one the server serves and
 * the catalog never mentions.
 *
 * This is the same defect class as `COLLECTIONS` vs `OUTPUT_COLLECTIONS`, and the
 * fix is the same: one list, derived from, with a test that walks it.
 */
export const STAC_COLLECTIONS = Object.freeze([
  {
    id: 'hazard-events',
    title: 'Hazard Events',
    description: 'Hazard events from disaster monitoring systems',
    resolve: (data) => [...(data.hazard_events || []), ...(data.conflict_events || [])],
  },
  {
    id: 'service-assets',
    title: 'Service Assets',
    description: 'Critical service assets and infrastructure',
    resolve: (data) => data.service_assets || [],
  },
  {
    id: 'risk-scores',
    title: 'Risk Scores',
    description: 'Computed flood and conflict risk scores',
    resolve: (data) => data.risk_scores || [],
  },
])

/** The records behind a collection id, or null when the id is not one of ours. */
export function resolveStacCollection(data, collectionId) {
  const entry = STAC_COLLECTIONS.find((c) => c.id === collectionId)
  return entry ? entry.resolve(data) : null
}

export function stacCatalog(baseUrl) {
  return {
    type: 'Catalog',
    stac_version: '1.0.0',
    id: 'lindela-lite',
    title: 'Lindela Lite Hazards',
    description: 'Spatiotemporal Asset Catalog of hazards, service assets, and risk scores from Lindela Lite',
    links: [
      ...STAC_COLLECTIONS.map((c) => ({
        rel: 'child',
        href: `${baseUrl}/stac/collections/${c.id}`,
        title: c.title,
        type: 'application/json',
      })),
      {
        rel: 'root',
        href: `${baseUrl}/stac/catalog.json`,
        title: 'Root Catalog',
        type: 'application/json',
      },
      {
        rel: 'self',
        href: `${baseUrl}/stac/catalog.json`,
        title: 'This Catalog',
        type: 'application/json',
      },
    ],
  }
}

export function stacCollection(collectionId, records, baseUrl) {
  const entry = STAC_COLLECTIONS.find((c) => c.id === collectionId)
  if (!entry) {
    throw Object.assign(new Error(`Invalid collection id: ${collectionId}`), { statusCode: 400 })
  }

  const filtered = records.filter((r) => readCoordinate(r.latitude) !== null && readCoordinate(r.longitude) !== null)
  const bbox = computeBbox(filtered)
  const temporal = computeTemporal(filtered)

  return {
    type: 'Collection',
    stac_version: '1.0.0',
    stac_extensions: ['https://stac-extensions.github.io/projection/v1.0.0/schema.json'],
    id: collectionId,
    title: entry.title,
    description: entry.description,
    license: 'CC-BY-4.0',
    extent: {
      // STAC permits a collection with no spatial extent. Emitting `[null]` is
      // not valid, so the key is omitted rather than filled in.
      ...(bbox ? { spatial: { bbox: [bbox] } } : {}),
      temporal: { interval: [temporal] },
    },
    links: [
      {
        rel: 'parent',
        href: `${baseUrl}/stac/catalog.json`,
        title: 'Root Catalog',
        type: 'application/json',
      },
      {
        rel: 'root',
        href: `${baseUrl}/stac/catalog.json`,
        title: 'Root Catalog',
        type: 'application/json',
      },
      {
        rel: 'self',
        href: `${baseUrl}/stac/collections/${collectionId}`,
        title: 'This Collection',
        type: 'application/json',
      },
      {
        rel: 'items',
        href: `${baseUrl}/stac/collections/${collectionId}/items`,
        title: 'Items',
        type: 'application/geo+json',
      },
    ],
  }
}

/**
 * Read a coordinate, treating null and blank as absent.
 *
 * `Number(null)` is 0 and `Number('')` is 0, so the guard below passed for every
 * record that explicitly had no location: 233 of 280 hazard events carry
 * `latitude: null`, and each was published with `geometry: Point [0, 0]` and
 * `bbox: [0,0,0,0]`. A STAC client loading these — QGIS, Earth Engine, anything
 * planetary-computing — put every FIRMS forest-fire notification that has no
 * coordinates into the Gulf of Guinea, one per event, at Null Island.
 */
export function stacItem(record, collectionId, baseUrl) {
  const lat = readCoordinate(record.latitude)
  const lon = readCoordinate(record.longitude)

  // STAC permits a null geometry for an item with no spatial position. Refusing
  // the whole collection listing over 233 location-less records is worse than
  // serving them properly, so the geometry is omitted and the reason stated in
  // `location_status` rather than being invented.
  const hasGeometry = lat !== null && lon !== null

  const timestamp = (
    record.observed_at
    || record.occurred_at
    || record.event_date
    || record.generated_at
    || record.created_at
    || new Date().toISOString()
  )

  return {
    type: 'Feature',
    stac_version: '1.0.0',
    id: record.id,
    geometry: hasGeometry ? { type: 'Point', coordinates: [lon, lat] } : null,
    bbox: hasGeometry ? [lon, lat, lon, lat] : null,
    properties: {
      'datetime': timestamp,
      // Stated rather than implied, so a client can tell a measured position from
      // one derived from an extent, a district centroid, or nothing at all.
      'location_basis': hasGeometry ? 'point' : 'none',
      'location_status': hasGeometry
        ? 'point coordinates as provided by the source'
        : 'the source reported no coordinates for this record; this item has no geometry',
      ...publicProperties(record),
    },
    assets: {},
    links: [
      {
        rel: 'parent',
        href: `${baseUrl}/stac/collections/${collectionId}`,
        title: 'Collection',
        type: 'application/json',
      },
      {
        rel: 'root',
        href: `${baseUrl}/stac/catalog.json`,
        title: 'Root Catalog',
        type: 'application/json',
      },
      {
        rel: 'self',
        href: `${baseUrl}/stac/collections/${collectionId}/items/${record.id}`,
        title: 'This Item',
        type: 'application/geo+json',
      },
    ],
  }
}

/**
 * OGC API Features Part 1 wraps `toGeoJson` in the paging fields.
 *
 * The feature construction was a second copy of the one in `src/utils.js`,
 * written independently and matching it today. It also filtered coordinates with
 * bare `Number.isFinite`, so a coordinate stored as the string `"3.12"` — which
 * `readCoordinate` accepts, and which the STAC path therefore admits — dropped the
 * record here. Two renderers of the same geometry disagreed about what a
 * coordinate is, which is the falsy-zero class of defect wearing a different hat.
 */
export function ogcFeatureCollection(records) {
  const collection = toGeoJson(records)

  return {
    ...collection,
    numberMatched: collection.features.length,
    numberReturned: collection.features.length,
    timeStamp: new Date().toISOString(),
    links: [
      {
        rel: 'self',
        href: 'self',
        type: 'application/geo+json',
      },
    ],
  }
}

function computeBbox(records) {
  // No extent is not an extent of [0,0,1,1]. STAC allows a collection to carry no
  // bbox, and an absent one is honest in a way that a box in the Gulf of Guinea
  // is not.
  if (!records.length) return null

  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity

  for (const record of records) {
    const lon = readCoordinate(record.longitude)
    const lat = readCoordinate(record.latitude)
    if (lon !== null) {
      minLon = Math.min(minLon, lon)
      maxLon = Math.max(maxLon, lon)
    }
    if (lat !== null) {
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
    }
  }

  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null
  if (!Number.isFinite(maxLon) || !Number.isFinite(maxLat)) return null
  return [minLon, minLat, maxLon, maxLat]
}

function computeTemporal(records) {
  if (!records.length) return [null, null]

  let minTime = null
  let maxTime = null

  for (const record of records) {
    const timestamp = (
      record.observed_at
      || record.occurred_at
      || record.event_date
      || record.generated_at
      || record.created_at
    )
    if (timestamp) {
      const time = new Date(timestamp).getTime()
      if (Number.isFinite(time)) {
        minTime = minTime === null ? time : Math.min(minTime, time)
        maxTime = maxTime === null ? time : Math.max(maxTime, time)
      }
    }
  }

  return [
    minTime !== null ? new Date(minTime).toISOString() : null,
    maxTime !== null ? new Date(maxTime).toISOString() : null,
  ]
}

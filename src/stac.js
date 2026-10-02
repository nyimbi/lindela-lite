export function stacCatalog(baseUrl) {
  return {
    type: 'Catalog',
    stac_version: '1.0.0',
    id: 'lindela-lite',
    title: 'Lindela Lite Hazards',
    description: 'Spatiotemporal Asset Catalog of hazards, service assets, and risk scores from Lindela Lite',
    links: [
      {
        rel: 'child',
        href: `${baseUrl}/stac/collections/hazard-events`,
        title: 'Hazard Events',
        type: 'application/json',
      },
      {
        rel: 'child',
        href: `${baseUrl}/stac/collections/service-assets`,
        title: 'Service Assets',
        type: 'application/json',
      },
      {
        rel: 'child',
        href: `${baseUrl}/stac/collections/risk-scores`,
        title: 'Risk Scores',
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
        href: `${baseUrl}/stac/catalog.json`,
        title: 'This Catalog',
        type: 'application/json',
      },
    ],
  }
}

export function stacCollection(collectionId, records, baseUrl) {
  const validIds = ['hazard-events', 'service-assets', 'risk-scores']
  if (!validIds.includes(collectionId)) {
    throw Object.assign(new Error(`Invalid collection id: ${collectionId}`), { statusCode: 400 })
  }

  const titles = {
    'hazard-events': 'Hazard Events',
    'service-assets': 'Service Assets',
    'risk-scores': 'Risk Scores',
  }

  const descriptions = {
    'hazard-events': 'Hazard events from disaster monitoring systems',
    'service-assets': 'Critical service assets and infrastructure',
    'risk-scores': 'Computed flood and conflict risk scores',
  }

  const filtered = records.filter((r) => readCoordinate(r.latitude) !== null && readCoordinate(r.longitude) !== null)
  const bbox = computeBbox(filtered)
  const temporal = computeTemporal(filtered)

  return {
    type: 'Collection',
    stac_version: '1.0.0',
    stac_extensions: ['https://stac-extensions.github.io/projection/v1.0.0/schema.json'],
    id: collectionId,
    title: titles[collectionId],
    description: descriptions[collectionId],
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
function readCoordinate(value) {
  if (value === null || value === undefined) return null
  // Whitespace-only and other blank strings coerce to 0 just as `null` does, so
  // they are trimmed away before the numeric check rather than after it.
  if (typeof value === 'string' && value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

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
      ...Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== 'latitude' && key !== 'longitude')
      ),
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

export function ogcFeatureCollection(records) {
  const filtered = records.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))

  return {
    type: 'FeatureCollection',
    features: filtered.map((item) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [item.longitude, item.latitude],
      },
      properties: Object.fromEntries(
        Object.entries(item).filter(([key]) => key !== 'latitude' && key !== 'longitude')
      ),
    })),
    numberMatched: filtered.length,
    numberReturned: filtered.length,
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

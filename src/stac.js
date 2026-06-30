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

  const filtered = records.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
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
      spatial: { bbox: [bbox] },
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

export function stacItem(record, collectionId, baseUrl) {
  const lat = Number(record.latitude)
  const lon = Number(record.longitude)

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw Object.assign(new Error('Record must have latitude and longitude'), { statusCode: 400 })
  }

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
    geometry: {
      type: 'Point',
      coordinates: [lon, lat],
    },
    bbox: [lon, lat, lon, lat],
    properties: {
      'datetime': timestamp,
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
  if (!records.length) return [0, 0, 1, 1]

  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity

  for (const record of records) {
    const lon = Number(record.longitude)
    const lat = Number(record.latitude)
    if (Number.isFinite(lon)) {
      minLon = Math.min(minLon, lon)
      maxLon = Math.max(maxLon, lon)
    }
    if (Number.isFinite(lat)) {
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
    }
  }

  return [
    Number.isFinite(minLon) ? minLon : 0,
    Number.isFinite(minLat) ? minLat : 0,
    Number.isFinite(maxLon) ? maxLon : 1,
    Number.isFinite(maxLat) ? maxLat : 1,
  ]
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

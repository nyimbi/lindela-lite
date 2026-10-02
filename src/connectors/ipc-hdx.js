import { fetchWithRetry } from './http.js'
import { parseCsv, stableId, toNumber } from '../utils.js'
import { defineConnector } from './spec.js'

/**
 * IPC acute food insecurity classifications, via the Humanitarian Data Exchange.
 *
 * Verified live on 2026-10-02 at:
 *   https://data.humdata.org/api/3/action/package_show?id=global-acute-food-insecurity-country-data
 *
 * This channel did not exist in the earlier scoping. docs/outbreak-and-food-
 * security-scoping.md checked 2026-10-01 against ipcinfo.org (403) and FENIX
 * (unreachable) and concluded no keyless machine-readable IPC feed existed. It
 * never checked HDX, on which the IPC organisation publishes the same data:
 * keyless, CC0 / public domain, scraped by HDX within days of publication, and
 * — decisive against the scoping's granularity objection — subnational. The
 * global area CSV carries per-district Phase 1-5 populations with an analysis
 * month and validity window (e.g. Kenya: Jul 2026 analysis, current period to
 * 2026-10-31), so the "country-level only" limitation is solved without any
 * licence because none is needed: the dataset licence is CC0.
 *
 * Three honesty notes ride along in every output:
 *
 * 1. IPC is an analytical classification by National IPC Technical Working
 *    Groups, not an observation and not our estimate. These records relay the
 *    published classification; they do not re-derive it. A home-grown phase
 *    number would carry triggering consequences no protocol of ours stands
 *    behind.
 * 2. The source's Percentage column is a fraction of the analysed population
 *    (0.15), not 15. Stored verbatim; callers must not read 0.2 as 0.2%.
 * 3. Records are grouped one per area and validity window, with every phase's
 *    published figure inside. Storing the long CSV row-per-phase verbatim
 *    would put ~42,000 rows in the store; grouping keeps all of those numbers
 *    queryable at a tenth of the size.
 *
 * Geometry: per-country GeoJSON resources (`ipc_<iso>_geojson`) are parsed to
 * bounding boxes only, and only for countries whose area rows actually appear
 * in the feed — a country without an IPC analysis has no GeoJSON either, and
 * probing for one 46 times per run would fill the error log with expected
 * absences. Full polygons are deliberately not stored: a national GeoJSON is
 * megabytes of coordinates, and a bbox is honest about precision — it
 * includes neighbouring ground the classification does not cover.
 */

const GLOBAL_DATASET = 'global-acute-food-insecurity-country-data'
const DATASET_ROOT = 'https://data.humdata.org/api/3/action/package_show'
const DOWNLOAD_ROOT = 'https://data.humdata.org/dataset'

/**
 * Sub-Saharan Africa, ISO4217/ISO3166 alpha-3 codes, per the UN geoscheme
 * (Eastern, Middle, Southern, and Western Africa). This is the ingestion
 * default by operator decision: flood seasons, IPC coverage, and the pilot
 * districts all sit inside this band, and the classification is defined
 * wherever IPC analysed it. A country with no IPC analysis yields no records
 * rather than an error; `countries: [...]` narrows explicitly.
 */
export const DEFAULT_COUNTRIES = Object.freeze([
  'AGO', 'BDI', 'BEN', 'BWA', 'BFA', 'CMR', 'CPV', 'CAF', 'TCD', 'COM',
  'COG', 'COD', 'CIV', 'DJI', 'GNQ', 'ERI', 'GAB', 'GMB', 'GHA', 'GIN',
  'GNB', 'KEN', 'LSO', 'LBR', 'MDG', 'MWI', 'MLI', 'MUS', 'MRT', 'MOZ',
  'NAM', 'NER', 'NGA', 'RWA', 'STP', 'SEN', 'SLE', 'SOM', 'ZAF', 'SSD',
  'SWZ', 'TZA', 'TGO', 'UGA', 'ZMB', 'ZWE',
])

const VALIDITY_MAP = Object.freeze({
  current: 'current',
  'first projection': 'first_projection',
  'second projection': 'second_projection',
})

async function connectorIngest(options = {}) {
  const food_security_records = []
  const errors = []
  const countryFilter = optionCountryFilter(options)

  try {
    const dataset = await packageShow(GLOBAL_DATASET, options)
    const resources = new Map((dataset.result?.resources || []).map((r) => [r.name, r]))

    // National rows give each country's Phase 3+ total; area rows give the
    // district detail. Only the _latest long forms are read: the wide forms
    // duplicate the same numbers transposed, and the non-latest files carry
    // the full 2017+ history that would bury the current window.
    const national = requiredResource(resources, 'ipc_global_national_long_latest.csv')
    const area = requiredResource(resources, 'ipc_global_area_long_latest.csv')

    const [areaRows, nationalRows] = await Promise.all([
      parseCsvResource(area, options),
      parseCsvResource(national, options),
    ])
    if (!areaRows.length || !nationalRows.length) {
      errors.push('ipc_hdx: one of the IPC CSVs parsed to zero rows; the feed or its layout may have changed')
    }

    // Geometry is looked up only for countries that actually have area rows —
    // national-only coverage does not need it, and a failed lookup must not
    // block the CSV half of the ingest.
    const areaCountries = new Set(areaRows.map((row) => row.Country).filter((c) => countrySelected(c, countryFilter)))
    const { bboxes, geoErrors } = await areaBboxes([...areaCountries], options)
    errors.push(...geoErrors)

    const datasetUrl = `${DOWNLOAD_ROOT}/${GLOBAL_DATASET}`
    food_security_records.push(
      ...groupIpcRows(nationalRows, 'national', { bboxes, datasetUrl, countryFilter }),
      ...groupIpcRows(areaRows, 'area', { bboxes, datasetUrl, countryFilter }),
    )
  } catch (error) {
    errors.push(`ipc_hdx: ${error.message}`)
  }

  return { food_security_records, errors }
}

function requiredResource(resources, name) {
  const resource = resources.get(name)
  // Names not found is not "zero records, carry on": the scraper renames the
  // resource list and guessing a fallback would store the wrong file's rows
  // under this source id. Failing loudly keeps the source run degraded and visible.
  if (!resource) throw new Error(`HDX resource "${name}" not found; got [${[...resources.keys()].join(', ')}]`)
  return resource
}

async function parseCsvResource(resource, options) {
  const text = await fetchWithRetry(resource.url || `${DOWNLOAD_ROOT}/${resource.download_url || ''}`, {
    timeoutMs: options.timeout_ms || 30000,
    retries: options.retries ?? 2,
    parse: 'text',
  })
  return parseCsv(text)
}

function optionCountryFilter(options) {
  if (options.countries === 'all') return null
  const list = Array.isArray(options.countries) && options.countries.length
    ? options.countries
    : DEFAULT_COUNTRIES
  // IPC publishes ISO3 codes ("KEN"); the project's regions use ISO2 ("KE").
  // Both spellings are accepted so a caller passing region countries does not
  // silently match nothing — which is exactly what an exact-match filter does.
  const upper = new Set(list.map(normalizeCountryCode).filter(Boolean))
  return upper.size ? upper : null
}

const ISO2_TO_ISO3 = Object.freeze({
  KE: 'KEN', SO: 'SOM', SS: 'SSD', UG: 'UGA', ET: 'ETH', SD: 'SDN',
})

function normalizeCountryCode(code) {
  const raw = String(code || '').trim().toUpperCase()
  return ISO2_TO_ISO3[raw] || raw
}

function countrySelected(country, filter) {
  return !filter || filter.has(normalizeCountryCode(country))
}

/**
 * Folds one long-format CSV row into its (area, validity window) record,
 * creating or extending it. The `3+` row is lifted to top-level fields since
 * it is the aggregate every downstream consumer reads; phases 1-5 and `all`
 * stay in the `phases` map.
 */
/**
 * Folds long-format CSV rows into one record per (area, validity window),
 * the storage shape: the raw feed is a row per phase (~44,000 rows for all
 * SSA), and one grouped record keeps every published number at a tenth of the
 * store size. Exported for direct testing — grouping is where rows can
 * silently drop.
 */
export function groupIpcRows(rows, scope, { bboxes = new Map(), datasetUrl = '', countryFilter = null } = {}) {
  // Keyed by record id: folding 44,000 rows with a per-row find over the list
  // would be O(n²) and visibly slow the ingest.
  const byId = new Map()
  const records = []
  for (const row of rows) {
    if (!countrySelected(row.Country, countryFilter)) continue
    groupRow(records, byId, row, { scope, bboxes, datasetUrl })
  }
  return records
}

function groupRow(records, byId, row, { scope, bboxes, datasetUrl }) {
  const validity = VALIDITY_MAP[row['Validity period']]
  const area = scope === 'area' ? row.Area : null
  const level1 = scope === 'area' ? row['Level 1'] : null
  if (!row.Phase || !validity) return

  const id = stableId('food_security', [scope, row.Country, area || 'national', row['Date of analysis'], validity, row.From, row.To])
  let record = byId.get(id)
  if (!record) {
    const bbox = area && bboxes.get(area)
    byId.set(id, record = {
      id,
      source: 'ipc_hdx',
      source_id: [row.Country, area || 'national', row['Validity period'], row.From].join(':'),
      // An area name is not a point. Coordinates stay null so the record
      // cannot be attributed to a district by proximity, which would be
      // wrong; the bbox, where the GeoJSON matched, is the only geometry.
      latitude: null,
      longitude: null,
      bbox: bbox || null,
      country: row.Country,
      // Country names are not in the feed; the ISO3 code is what IPC
      // publishes. Leaving the name absent beats guessing one.
      country_name: null,
      scope,
      level1: level1 || null,
      area: area || null,
      analysis_date: row['Date of analysis'],
      validity_period: validity,
      valid_from: row.From,
      valid_to: row.To,
      total_country_population: Math.round(toNumber(row['Total country population'])) || null,
      phase3plus_number: null,
      phase3plus_fraction: null,
      phases: {},
      observed_at: `${row.From}T00:00:00.000Z`,
      metadata: buildMetadata(row, { scope, area, level1, bbox, datasetUrl }),
    })
    records.push(record)
  }

  const number = toNumber(row.Number)
  const fraction = toNumber(row.Percentage)
  record.phases[row.Phase] = { number, fraction }
  if (row.Phase === '3+') {
    record.phase3plus_number = number
    record.phase3plus_fraction = fraction
  }
}

function buildMetadata(row, { scope, area, level1, bbox, datasetUrl }) {
  return {
    provider: 'IPC (published via HDX)',
    classification_note: 'Analytical classification produced by National IPC Technical Working Groups. Not an observation, not a model output, not an estimate by this platform. Phase thresholds carry triggering consequences under famine and anticipatory-action policy; read them as published, never re-derived.',
    percentage_note: 'population fractions are the source Percentage column: a fraction of the analyzed population for that window, so 0.2 means 20%, not 0.2%.',
    validity_note: `Classification window of kind "${row['Validity period']}" covering ${row.From} to ${row.To}. Projections are IPC projections, not forecasts by this platform.`,
    dataset: datasetUrl,
    dataset_license: 'CC0 / Public Domain (HDX dataset license_id other-pd-nr)',
    attribution: 'IPC Integrated Food Security Phase Classification data via data.humdata.org, produced by National IPC Technical Working Groups',
    granularity: scope === 'area' ? `Admin area "${area || ''}" in "${level1 || 'national'}"` : 'National',
    geometry_note: scope === 'national'
      ? 'National records carry no geometry: the classification is country-wide.'
      : bbox
        ? 'Only the bounding box of the mapped area polygon is stored. A bbox includes neighbouring ground the classification does not cover.'
        : 'No geometry: the dataset GeoJSON carried no feature matching this area name. Coordinates are null and the area name is the only geography.',
    model_limit: 'Published classification snapshot; a monitoring and context signal, not a per-district trigger on its own',
    fetched_at: new Date().toISOString(),
  }
}

/**
 * Fetches the per-country GeoJSON resources and records one bbox per area,
 * keyed by feature title to join against the CSV `Area` column.
 *
 * A missing or mismatched GeoJSON degrades to null bboxes and a stated error;
 * it is not an ingest failure. Half a feed being absent must not lose the CSV
 * half's data, and geometry is presentation, not evidence.
 */
async function areaBboxes(isoCodes, options) {
  const bboxes = new Map()
  const geoErrors = []
  if (options.geometry === false) return { bboxes, geoErrors }

  await Promise.all([...new Set(isoCodes)].map(async (iso) => {
    try {
      const dataset = await packageShow(slugFor(iso), options)
      const geo = (dataset.result?.resources || []).find((resource) => String(resource.name).endsWith('.geojson'))
      if (!geo) {
        geoErrors.push(`ipc_hdx: dataset "${slugFor(iso)}" carries no .geojson resource; areas get no bbox`)
        return
      }
      const text = await fetchWithRetry(geo.url, { timeoutMs: options.timeout_ms || 30000, retries: options.retries ?? 2, parse: 'text' })
      const geoJson = JSON.parse(text)
      for (const feature of geoJson.features || []) {
        const bbox = featureBbox(feature.geometry)
        const title = feature.properties?.title
        if (bbox && title) bboxes.set(title, bbox)
      }
      if (!bboxes.size) {
        geoErrors.push(`ipc_hdx: GeoJSON for ${iso} yielded no area bounding boxes`)
      }
    } catch (error) {
      geoErrors.push(`ipc_hdx: geometry lookup failed for ${iso}: ${error.message}`)
    }
  }))
  return { bboxes, geoErrors }
}

/**
 * The IPC HDX datasets are named `<country>-acute-food-insecurity-country-
 * data` with the country spelled out ("south-sudan-..."), not the ISO code.
 * Country names must be exact: an unmapped code fails loudly (the geo error
 * is reported) rather than guessing a slug from spelling.
 */
  // Slugs verified against data.humdata.org on 2026-10-02. Where HDX does not
  // match the spelling a geography would suggest (Côte d'Ivoire, DR Congo,
  // Tanzania, Eswatini), the dataset name wins over any prettier form.
  const COUNTRY_SLUGS = Object.freeze({
    AGO: 'angola', BDI: 'burundi', BEN: 'benin', BWA: 'botswana', BFA: 'burkina-faso',
    CMR: 'cameroon', CPV: 'cabo-verde', CAF: 'central-african-republic', TCD: 'chad',
    COM: 'comoros', COG: 'congo', COD: 'democratic-republic-of-the-congo', CIV: 'cote-d-ivoire',
    DJI: 'djibouti', GNQ: 'equatorial-guinea', ERI: 'eritrea', SWZ: 'eswatini',
    GAB: 'gabon', GMB: 'gambia', GHA: 'ghana', GIN: 'guinea', GNB: 'guinea-bissau',
    KEN: 'kenya', LSO: 'lesotho', LBR: 'liberia', MDG: 'madagascar', MWI: 'malawi',
    MLI: 'mali', MUS: 'mauritius', MRT: 'mauritania', MOZ: 'mozambique', NAM: 'namibia',
    NER: 'niger', NGA: 'nigeria', RWA: 'rwanda', STP: 'sao-tome-and-principe',
    SEN: 'senegal', SLE: 'sierra-leone', SOM: 'somalia', ZAF: 'south-africa',
    SSD: 'south-sudan', TZA: 'united-republic-of-tanzania', TGO: 'togo', UGA: 'uganda',
    ZMB: 'zambia', ZWE: 'zimbabwe',
  })

function slugFor(iso) {
  const name = COUNTRY_SLUGS[iso]
  if (!name) {
    throw new Error(`no HDX dataset slug mapping for country ${iso}; areas get no bbox (extend COUNTRY_SLUGS if HDX publishes it)`)
  }
  return `${name}-acute-food-insecurity-country-data`
}

/**
 * Bounding box of a GeoJSON geometry: min/max over every position, recursed
 * through Polygon and MultiPolygon nesting. A broken polygon loses its bbox,
 * not the record.
 */
function featureBbox(geometry) {
  const box = [Infinity, Infinity, -Infinity, -Infinity]
  const visit = (node) => {
    if (!node) return
    if (Array.isArray(node) && node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      // GeoJSON positions are [longitude, latitude].
      if (node[0] < box[0]) box[0] = node[0]
      if (node[1] < box[1]) box[1] = node[1]
      if (node[0] > box[2]) box[2] = node[0]
      if (node[1] > box[3]) box[3] = node[1]
      return
    }
    if (Array.isArray(node)) node.forEach(visit)
  }
  visit(geometry?.coordinates)
  return box.every(Number.isFinite) ? { south: box[1], west: box[0], north: box[3], east: box[2] } : null
}

/**
 * Roll-up for dashboards: per country and scope, the Phase 3+ figure from the
 * latest published window, plus the worst ten areas. "Latest" is by window
 * start date, not by string order of the analysis month — "Jul 2026" and
 * "Aug 2026" as text sort wrong next to each other, while the ISO `From`
 * dates do not.
 */
export function summarizeFoodSecurity(records) {
  const threePlus = records.filter((record) => record.validity_period === 'current')

  const nationalByCountry = new Map()
  const areasByCountry = new Map()
  for (const record of threePlus) {
    const bucket = record.scope === 'area' ? areasByCountry : nationalByCountry
    const key = record.scope === 'area' ? `${record.country}:${record.area}` : record.country
    const existing = bucket.get(key)
    if (!existing || String(record.valid_from) > String(existing.valid_from)) bucket.set(key, record)
  }

  return {
    generated_at: new Date().toISOString(),
    methodology: 'Phase 3+ population figures as published by National IPC Technical Working Groups; latest validity window per country/area, relayed verbatim, not re-classified.',
    countries: [...nationalByCountry.values()]
      .sort((a, b) => String(a.country).localeCompare(String(b.country)))
      .map(toSummary),
    worst_areas: [...areasByCountry.values()]
      .filter((r) => Number.isFinite(r.phase3plus_fraction))
      .sort((a, b) => b.phase3plus_fraction - a.phase3plus_fraction)
      .slice(0, 10)
      .map(toSummary),
  }
}

function toSummary(record) {
  return {
    country: record.country,
    area: record.area || null,
    analysis_date: record.analysis_date,
    valid_from: record.valid_from,
    valid_to: record.valid_to,
    phase3plus_number: record.phase3plus_number,
    phase3plus_fraction: record.phase3plus_fraction,
  }
}

async function packageShow(id, options) {
  const text = await fetchWithRetry(`${DATASET_ROOT}?id=${encodeURIComponent(id)}`, {
    timeoutMs: options.timeout_ms || 30000,
    retries: options.retries ?? 2,
    parse: 'text',
  })
  const payload = JSON.parse(text)
  if (!payload.success || !payload.result) {
    throw new Error(`HDX package_show for ${id} did not succeed`)
  }
  return payload
}

export const spec = defineConnector({
  id: 'ipc_hdx',
  description: 'IPC Acute Food Insecurity classifications (national and subnational phases 1-5 with validity windows) via HDX; CC0, keyless',
  schema: {
    requestSchema: {
      countries: "array of ISO2/ISO3 country codes to keep (default: all Sub-Saharan Africa); 'all' for every country",
      geometry: 'boolean (default true) - also fetch GeoJSON for countries with area data and store per-area bounding boxes',
      timeout_ms: 'number (default 30000)',
      retries: 'number (default 2)',
    },
    outputSchema: {
      food_security_records: 'one record per area and validity window; coordinates null, bbox present only where the GeoJSON matched',
    },
  },
  defaults: {
    rateLimit: { perMinute: 20 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 30000,
  },
  source: 'IPC via the Humanitarian Data Exchange',
  license: 'CC0 / Public Domain (dataset license_id other-pd-nr)',
  ingest: connectorIngest,
})

export const ipcHdxConnector = spec
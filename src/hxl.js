/**
 * ENH-31 — HXL hashtags for the CSV export.
 *
 * HXL is a single extra header row of hashtags (`#loc+name`, `#date+occurred`)
 * that sits above the human column names. It exists because a humanitarian CSV
 * is otherwise a private dialect: HDX, and every pipeline built on it, reads
 * the hashtag row to know that a column called `district` is an administrative
 * name and not a district code, without a per-dataset mapping table. Without
 * it, a partner hand-maps 341 columns — which is the same as saying the widest
 * read in this product is readable by a person and interoperable with nobody.
 *
 * **The registry is keyed by the column name the export actually emits**, and
 * the row is built by looking each header up. That direction matters. A row
 * built by walking this registry would emit every hashtag in registry order,
 * so a file whose headers are sorted differently — which they are, `toCsv`
 * sorts them — would carry tags that are each correct and each on the wrong
 * column, and nothing downstream could tell. `hxlRow(headers)` is total over
 * any header list: an unknown column is the empty string.
 *
 * **A missing tag is not a gap to fill.** HXL's `#meta` and `#indicator` are
 * broad, and a wrong hashtag is worse than none: HDX aggregates on them, so
 * `#affected` on a column that is not an affected count publishes a figure to
 * a cluster that will act on it. Only fields whose meaning is unambiguous are
 * mapped here, and the test asserts every key names a column the export really
 * emits — a registry entry for a field no record carries reads as coverage and
 * is not.
 *
 * The vocabulary is the HXL standard's own
 * (https://hxlstandard.org/standard/1_0final/), and a copy is archived beside
 * this repository's other citations.
 */

/**
 * Column name → HXL hashtag.
 *
 * Keys are the flattened column names `toCsv` produces, which for a nested
 * record is the dotted path (`drivers.precipitation_mm`). They are the export's
 * own names, not the store's field names: the two are the same only by
 * coincidence, and a registry written against the store would silently stop
 * matching the moment `flattenRecord` changed.
 */
export const HXL_HASHTAGS = Object.freeze({
  // Identity and provenance. `#meta+id` is the dataset's own key; `#meta+source`
  // and `#meta+url` are where the row came from, which is the question a
  // humanitarian reader asks of a record they did not collect.
  id: '#meta+id',
  source_id: '#meta+source',
  source: '#meta+source',
  source_url: '#meta+url',
  payload_hash: '#meta+hash',
  observed_at: '#date+updated',
  occurred_at: '#date+occurred',
  first_seen_at: '#date+start',
  last_observed_at: '#date+updated',
  created_at: '#date+created',
  updated_at: '#date+updated',
  generated_at: '#date+generated',
  start_at: '#date+start',
  end_at: '#date+end',
  due_at: '#date+due',
  completed_at: '#date+ended',
  sent_at: '#date+sent',
  queued_at: '#date+queued',

  // Geography. `#adm1`/`#adm2` are the administrative levels HXL names, and
  // `#loc+name` is a place name that is not an administrative unit.
  country: '#country+code',
  admin1: '#adm1+name',
  admin2: '#adm2+name',
  district: '#adm2+name',
  region_name: '#adm1+name',
  'location.admin1': '#adm1+name',
  'location.country': '#country+code',
  'location.name': '#loc+name',
  'location.latitude': '#geo+lat',
  'location.longitude': '#geo+lon',
  latitude: '#geo+lat',
  longitude: '#geo+lon',
  lat: '#geo+lat',
  lon: '#geo+lon',
  'bbox.west': '#geo+bounds+minlon',
  'bbox.east': '#geo+bounds+maxlon',
  'bbox.south': '#geo+bounds+minlat',
  'bbox.north': '#geo+bounds+maxlat',
  location_accuracy_m: '#geo+accuracy',
  geo_precision_deg: '#geo+precision',

  // People. `#affected` is a head count and nothing else — which is exactly
  // why `people_reached` and `recipients` are mapped and a `metadata.*` count
  // is not: those are counts of messages, not of people.
  affected_population: '#affected+total',
  population_served: '#affected+served',
  fatalities: '#affected+dead',
  'demographics.age_band': '#population+age',
  'demographics.gender': '#population+gender',
  'demographics.pwd': '#population+disabled',
  'demographics.refugee_or_idp': '#population+idp',

  // Hazard and impact. `#hazard` names the type, `#impact` the consequence.
  event_type: '#hazard+type',
  'metadata.event_type_code': '#hazard+type',
  sub_event_type: '#hazard+subtype',
  hazard_type: '#hazard+type',
  severity: '#severity',
  risk_level: '#severity',
  impact_level: '#impact+level',
  impact_score: '#impact+score',
  confidence: '#meta+confidence',
  title: '#description+short',
  description: '#description',
  summary: '#description+short',
  needs: '#need',
  recommended_actions: '#action+recommended',

  // Measures. The unit is a separate HXL attribute, and these are the units
  // the fields are documented in.
  'drivers.precipitation_mm': '#rainfall',
  'drivers.precipitation_probability_pct': '#rainfall+probability',
  depth_km: '#geo+depth',
  'metadata.magnitude': '#hazard+magnitude',
  'metadata.cdi': '#hazard+intensity',
  'metadata.alert_score': '#hazard+score',
  score: '#indicator+score',
  risk_score: '#indicator+score',
  value: '#value',
  unit: '#value+unit',
  threshold: '#indicator+threshold',
  quantity: '#item+count',
  capacity: '#capacity+total',
})

/**
 * The hashtag for one column, or the empty string.
 *
 * Total by construction. A caller that has to handle `undefined` here will
 * eventually pass it to something that renders it as the word "undefined" in a
 * cell, which is a hashtag HDX will reject the whole file over.
 */
export function hashtagFor(header) {
  return HXL_HASHTAGS[header] ?? ''
}

/**
 * The hashtag row for a header row, one cell per header, in header order.
 *
 * This is the whole of the alignment: the row is a function of the headers, so
 * it cannot disagree with them.
 */
export function hxlRow(headers) {
  return headers.map(hashtagFor)
}

/**
 * Is this a well-formed HXL hashtag?
 *
 * The grammar is `#` followed by one to three `+`-separated terms, each of
 * lowercase letters and digits. It is checked rather than trusted because the
 * registry is hand-written and a typo in it is invisible in the output: `#geo_lat`
 * renders as a tag, HDX ignores it, and the column is silently unmapped — the
 * exact outcome the registry exists to prevent.
 */
export function isValidHashtag(tag) {
  return typeof tag === 'string' && /^#[a-z][a-z0-9]*(?:\+[a-z][a-z0-9]*){0,2}$/.test(tag)
}

/**
 * The `?hxl=` query parameter, or a refusal.
 *
 * `Boolean('maybe')` is true, so a truthiness test would tag the export for a
 * caller who did not ask. Ignoring an unrecognised value instead is worse in
 * the other direction: the caller believes a parameter was honoured and gets
 * the untagged file. This is the same rule `parseLimit` applies to `?limit=abc`
 * — a parameter that cannot be honoured must say so — and it returns `null` for
 * an absent value so the caller can tell "not asked" from "asked for false".
 */
export function parseHxlFlag(raw) {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim().toLowerCase()
  if (text === '' || text === '0' || text === 'false' || text === 'no') return false
  if (text === '1' || text === 'true' || text === 'yes') return true
  return undefined
}

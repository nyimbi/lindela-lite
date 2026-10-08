import { fetchWithRetry } from './http.js'
import { stableId } from '../utils.js'
import { defineConnector } from './spec.js'
import { geocodeOutbreakLocation } from '../../public/shared/outbreak-geocode.js'

/**
 * ReliefWeb epidemic disasters — the outbreak-map event source (ADR-014).
 *
 * Two retrieval backends, one record shape, decided by a live spike:
 *
 * 1. The **v2 Disasters JSON API** (`buildApiUrl`) when an approved appname is
 *    available via `reliefweb_appname` / `LINDELA_LITE_RELIEFWEB_APPNAME`.
 *    Documented contract, 50-record window, and subnational `location`
 *    coordinates when ReliefWeb publishes them. An unapproved appname answers
 *    403 with a pointer to ReliefWeb's registration page — recorded in
 *    `errors`, never swallowed, and the connector falls back to RSS so the
 *    overlay does not go dark while the human-async registration pends.
 * 2. The **keyless RSS feed** (`RSS_URL`) otherwise — no registration, works
 *    today. Twenty latest disasters worldwide; query parameters are accepted
 *    and ignored (probed), so epidemic type and pilot-country filtering happen
 *    here, not upstream. Its limits are part of every record: no coordinates,
 *    no counts unless the glance text states them, and a zero-record success
 *    means "nothing epidemic and pilot-relevant in the 20-item window", not
 *    "no epidemics".
 *
 * What this connector deliberately does NOT do mirrors who_gho's discipline:
 * no derived rates, no severity scoring, no invented coordinates. A record
 * placed at a country centroid carries `granularity: 'national'` end to end —
 * the map dashes it, the status line counts it separately, the detail dialog
 * says "National aggregate" — because an aggregate drawn at a point reads as
 * district evidence to nobody who was told, and reads as exactly that to
 * everybody who was not.
 */

const API_ROOT = 'https://api.reliefweb.int/v2/disasters'
const RSS_URL = 'https://reliefweb.int/disasters/rss.xml'
const DEFAULT_APPNAME = 'lindela-lite-outbreak-map'
export const APPNAME_REQUEST_URL = 'https://apidoc.reliefweb.int/parameters#appname'

// Pilot countries, spelled as ReliefWeb names them and as ISO2 for the GLIDE
// suffix (`-BGD` → `BG`). Exact matches only: 'Sudan' is a different country
// from 'South Sudan', and a substring match would be a border violation.
const PILOT_COUNTRIES = Object.freeze({
	KE: { names: ['Kenya'] },
	UG: { names: ['Uganda'] },
	SS: { names: ['South Sudan'] },
	ET: { names: ['Ethiopia'] },
	SO: { names: ['Somalia'] },
})
const COUNTRY_NAME_TO_CODE = Object.freeze({
	kenya: 'KE',
	uganda: 'UG',
	'south sudan': 'SS',
	ethiopia: 'ET',
	somalia: 'SO',
})
const GLIDE_COUNTRY_SUFFIX = Object.freeze({
	KE: 'KE', UG: 'UG', SS: 'SS', ET: 'ET', SO: 'SO',
})

const MODEL_LIMIT = 'ReliefWeb epidemic disaster record. Coordinates are subnational where provided; otherwise country centroid with national-aggregate label. Case/death counts are extracted heuristically when present.'

/** The disease vocabulary the map colours and shapes. Simple keyword matching; the glance text is human-written, not a codebook. */
const DISEASE_KEYWORDS = [
	['cholera', 'cholera'],
	['measles', 'measles'],
	['meningitis', 'meningitis'],
	['yellow fever', 'yellow fever'],
	['plague', 'plague'],
]

export function extractDiseaseName(name) {
	const text = String(name || '').toLowerCase()
	for (const [needle, disease] of DISEASE_KEYWORDS) {
		if (text.includes(needle)) return disease
	}
	return 'other'
}

/**
 * Extract case/death counts when the glance text or description states them.
 * Deliberately narrow: only a number followed by the word. A dengue glance
 * that says "over 3,500 suspected cases" yields 3500; text about *funding*
 * for cases yields nothing, because no words demand it. Comma-separated
 * thousands parse; "1.5 million" does not, and stays null rather than lying.
 */
export function extractCounts(text) {
	const out = { cases: null, deaths: null }
	const value = (pattern) => {
		const match = String(text || '').match(pattern)
		if (!match) return null
		const n = Number(match[1].replace(/,/g, ''))
		return Number.isFinite(n) && n >= 0 ? n : null
	}
	out.cases = value(/([\d,]+(?:\.\d+)?)\s*(?:suspected\s+|confirmed\s+)?(?:total\s+)?cases/i)
	out.cases = out.cases ?? value(/([\d,]+)\s*(?:cholera|measles|meningitis|yellow\s+fever|dengue)/i)
	out.deaths = value(/([\d,]+)\s*(?:reported\s+|confirmed\s+)?deaths/i)
	return out
}

/** The documented v2 request. `appname` must be ReliefWeb-approved — 403 with the registration pointer otherwise, probed 2026-10-07. */
export function buildApiUrl(appname = DEFAULT_APPNAME) {
	return `${API_ROOT}?appname=${encodeURIComponent(appname || DEFAULT_APPNAME)}` +
		'&filter[type.name]=Epidemic' +
		'&filter[country.iso3]=KEN,UGA,SSD,ETH,SOM' +
		'&fields[include]=name,date,country,location,primary_location,description,url,status' +
		'&sort[]=date:desc&limit=50'
}

/** Subnational-first coordinate resolution on an API item, before any centroid is tried. A coordinate that is null must NOT become Number(null)===0 — the Null Island bug the demo audit already caught once in the CAP feed. */
function isCoordinate(value) {
	return value !== null && value !== undefined && Number.isFinite(Number(value))
}

function apiItemCoordinates(item) {
	const primary = item?.fields?.primary_location
	if (isCoordinate(primary?.lat) && isCoordinate(primary?.lon)) {
		return {
			latitude: Number(primary.lat),
			longitude: Number(primary.lon),
			location_name: primary.name || primary.location?.name || null,
			granularity: 'subnational',
			matched_name: primary.name || primary.location?.name || null,
		}
	}
	const first = Array.isArray(item?.fields?.location) ? item.fields.location[0] : null
	if (isCoordinate(first?.lat) && isCoordinate(first?.lon)) {
		return {
			latitude: Number(first.lat),
			longitude: Number(first.lon),
			location_name: first.name || null,
			granularity: 'subnational',
			matched_name: first.name || null,
		}
	}
	return null
}

/** The record shape, shared by both backends. */
function buildRecord({ glideId, disease, country, geo, locationNameFallback, cases, deaths, observedAt, sourceUrl, status, rawName }) {
	// Only a pilot country can host a centroid; anything else keeps country
	// as an ISO label and gets `unknown` geography.
	const centroidCode = GLIDE_COUNTRY_SUFFIX[country] ? country : null
	return {
		id: stableId('disease', ['reliefweb_epidemics', glideId || rawName || String(Date.now())]),
		source: 'reliefweb_epidemics',
		source_id: glideId || null,
		disease,
		country: country || null,
		// Prefer source geometry; fall back through the shared geocoder
		// (district name beats country code here, because a district name the
		// publisher chose to write is district evidence). Nothing matches →
		// null coordinates and 'unknown', which the map honestly draws as
		// nothing. `location_name` is filled by normalizeRecord when the
		// geocoder had no better label than the publisher's own text.
		...(geo || geocodeOutbreakLocation(locationNameFallback, centroidCode) || { latitude: null, longitude: null, location_name: null, granularity: 'unknown' }),
		cases,
		deaths,
		observed_at: observedAt,
		source_url: sourceUrl || null,
		model_limit: MODEL_LIMIT,
		metadata: {
			provider: 'ReliefWeb API',
			raw_name: rawName,
			status: status || null,
		},
	}
}

function normalizeRecord(record, fallbackName) {
	// `buildRecord` may carry a geocoded location_name; when it did not match
	// anything, use the publisher's own name as the label — honest about what
	// matched nothing.
	if (record.location_name == null && fallbackName) record.location_name = fallbackName
	return record
}

/** One RSS item, hand-parsed (no XML dependency — the format is fixed and small). */
export function parseRssItem(xml) {
	const block = xml.replace(/\s+/g, ' ')
	const tag = (name) => {
		const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
		return m ? m[1].trim() : null
	}
	const title = tag('title')
	const link = tag('link')
	if (!title || !link) return null
	const cats = [...xml.matchAll(/<category>([\s\S]*?)<\/category>/gi)].map((m) => m[1].trim())
	const pubDate = tag('pubDate')
	const parsedDate = pubDate ? new Date(pubDate) : null
	// GLIDE id from the link path: /disaster/ep-2026-000201-bgd — the serial is
	// SIX digits, not five; a five-digit pattern dropped every 2026 id silently
	// and the feed's country fallback then had nothing to decode.
	const glideMatch = link.match(/\/disaster\/([a-z]{2}-\d{4}-\d{6}-[a-z0-9]{3})/i)
	const glideId = glideMatch ? glideMatch[1].toUpperCase() : null
	// Country: the categories that name a pilot country, else the GLIDE
	// suffix's ISO2 + check char (`-BGD` → `BG`).
	let country = null
	for (const cat of cats) {
		const code = COUNTRY_NAME_TO_CODE[cat.toLowerCase()]
		if (code) { country = code; break }
	}
	if (!country && glideId) {
		const iso2 = glideId.slice(-3, -1).toUpperCase()
		if (GLIDE_COUNTRY_SUFFIX[iso2]) country = iso2
	}
	if (!country) return null
	// Title prefix is the publisher's country name — the geocoder's fallback
	// label when no district name matched.
	const titleCountry = title.split(':')[0]?.trim() || null
	return { title, link, glideId, country, titleCountry, observed_at: (parsedDate && !isNaN(parsedDate) ? parsedDate.toISOString() : null) }
}

export function parseRss(xml) {
	const items = []
	const blocks = String(xml).split(/<item>/i).slice(1)
	for (const raw of blocks) {
		const body = `<item>${raw}`
		const close = body.indexOf('</item>')
		if (close === -1) continue
		const parsed = parseRssItem(body.slice(0, close + 7))
		if (parsed) items.push(parsed)
	}
	return items
}

/** The RSS path: epidemic type via the GLIDE `EP-` prefix (categories do not carry type), pilot countries only. */
function recordsFromRss(items) {
	const records = []
	for (const item of items) {
		const isEpidemic = (item.glideId || '').startsWith('EP-')
		const titleDisease = extractDiseaseName(item.title) !== 'other'
		if (!isEpidemic && !titleDisease) continue
		const { cases, deaths } = extractCounts(item.title)
		const record = normalizeRecord(
			buildRecord({
				glideId: item.glideId,
				disease: extractDiseaseName(item.title),
				country: item.country,
				geo: null,
				// The FULL title text is the geocoder's input, not just the
				// country prefix: a glance that names a pilot district
				// ("Kenya: Cholera Outbreak - Turkana") is subnational evidence;
				// one that names none falls to the country centroid.
				locationNameFallback: item.title,
				cases, deaths,
				observedAt: item.observed_at || new Date().toISOString(),
				sourceUrl: item.link,
				status: null,
				rawName: item.title,
			}),
			item.titleCountry,
		)
		records.push(record)
	}
	return records
}

/** The v2 API path, per the documented contract (fixture-tested). */
export function recordsFromApiItems(items) {
	const records = []
	for (const item of items) {
		const name = item?.fields?.name || null
		const { cases, deaths } = extractCounts([name, item?.fields?.description].filter(Boolean).join(' '))
		const countryIso3 = item?.fields?.country?.[0]?.iso3 || null
		const countryIso2 = countryIso3 ? countryIso3.slice(0, 2).toUpperCase() : null
		const country = PILOT_COUNTRIES[countryIso2] ? countryIso2 : null
		const geo = apiItemCoordinates(item)
		const record = normalizeRecord(
			buildRecord({
				glideId: item?.id != null ? String(item.id) : null,
				disease: extractDiseaseName(name || ''),
				country,
				geo,
				locationNameFallback: name,
				cases, deaths,
				observedAt: item?.fields?.date?.event || item?.fields?.date?.created || new Date().toISOString(),
				sourceUrl: item?.fields?.url || null,
				status: item?.fields?.status || null,
				rawName: name,
			}),
			name,
		)
		records.push(record)
	}
	return records
}

async function connectorIngest(options = {}) {
	const errors = []
	let records = []
	let backend = 'rss'

	const appname = options.reliefweb_appname || process.env.LINDELA_LITE_RELIEFWEB_APPNAME || null
	if (appname) {
		backend = 'api'
		try {
			const text = await fetchWithRetry(buildApiUrl(appname), {
				timeoutMs: options.timeout_ms || 20000,
				retries: options.retries ?? 2,
				parse: 'text',
				source: options.source,
			})
			const payload = JSON.parse(text)
			const items = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : [])
			records = recordsFromApiItems(items)
		} catch (error) {
			// An unapproved appname is a human-async registration, not an outage;
			// record the pointer and fall back so the overlay stays alive while
			// the registration pends. Other failures fall back too — same window,
			// weaker geometry — and both diagnoses are recorded.
			if (/403|appname/i.test(String(error.message))) {
				errors.push(`reliefweb_epidemics: appname "${appname}" is not approved by ReliefWeb (${APPNAME_REQUEST_URL}); fell back to the keyless RSS feed`)
			} else {
				errors.push(`reliefweb_epidemics: v2 API failed (${error.message}); fell back to the keyless RSS feed`)
			}
			backend = 'rss'
		}
	}

	if (backend === 'rss') {
		try {
			const text = await fetchWithRetry(RSS_URL, {
				timeoutMs: options.timeout_ms || 20000,
				retries: options.retries ?? 2,
				parse: 'text',
				source: options.source,
			})
			records = recordsFromRss(parseRss(text))
		} catch (error) {
			// The 406 is ReliefWeb's CDN rejecting non-browser TLS fingerprints
			// ("Blocked due to bot activity" — probed 2026-10-07: every node-fetch
			// UA variant 406s; curl from the same IP answers 200). It is not an
			// accept-header choice, so the diagnosis travels in the error: the
			// operator's fix is the approved appname, which unlocks the v2 API —
			// that host answers node fetchs normally.
			const message = /406/.test(String(error.message))
				? 'ReliefWeb RSS refused the request (HTTP 406 — its CDN blocks non-browser TLS stacks as bots, verified 2026-10-07). The durable fix is a ReliefWeb-approved appname, which routes through api.reliefweb.int instead — set LINDELA_LITE_RELIEFWEB_APPNAME after requesting one'
				: `RSS fetch failed: ${error.message}`
			errors.push(`reliefweb_epidemics: ${message}`)
		}
	}

	return { disease_observations: records, errors }
}

export const spec = defineConnector({
	id: 'reliefweb_epidemics',
	description: 'ReliefWeb epidemic disaster events for the pilot countries (cholera, measles, meningitis, yellow fever, plague); RSS keyless with v2 JSON API when an approved appname is configured. Subnational coordinates where provided; country-centroid aggregate labelled national otherwise.',
	schema: {
		requestSchema: {
			reliefweb_appname: 'string — ReliefWeb-approved appname (default LINE env LINDELA_LITE_RELIEFWEB_APPNAME); when set, the v2 JSON API is used and falls back to RSS on 403',
			timeout_ms: 'number (default 20000)',
			retries: 'number (default 2)',
		},
		outputSchema: {
			disease_observations: 'array of epidemic-event records: disease, country, coordinates or national centroid with granularity label, heuristic case/death counts when the glance text states them',
		},
	},
	defaults: {
		rateLimit: { perMinute: 30 },
		retry: { max: 2, backoffMs: 1000 },
		timeout_ms: 20000,
	},
	source: 'ReliefWeb',
	license: 'ReliefWeb content: reuse per ReliefWeb terms, attribution required; GLIDE ids under GLIDE licence',
	ingest: connectorIngest,
})

export const reliefwebEpidemicsConnector = spec
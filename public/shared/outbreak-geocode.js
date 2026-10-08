/**
 * Outbreak location geocoding: a source that names a place but gives no
 * coordinates still deserves the most honest placement the platform owns.
 *
 * One module, imported by BOTH the connector (server-side, when ReliefWeb
 * gives no geometry) and the front end, because two centroid tables that
 * quietly disagree is the same class of mistake ADR-008 recorded as "two
 * projections, not one" — shared is a claim, not a directory name.
 *
 * The granularity label travels with the coordinates everywhere: a
 * national-centroid placement is a national *aggregate* drawn at a point, and
 * saying so at the endpoint, the marker dash, the status line and the detail
 * dialog is what keeps it from reading as district evidence.
 */

import { PILOT_DISTRICTS } from './basemap.js'

/** Country centroids, declared once. Population-weighted would be prettier and wrong: this is an aggregate label's anchor, not an epidemic's location. */
export const COUNTRY_CENTROIDS = Object.freeze({
	KE: { name: 'Kenya', lat: 0.1769, lon: 37.9083 },
	UG: { name: 'Uganda', lat: 1.3733, lon: 32.2903 },
	SS: { name: 'South Sudan', lat: 6.877, lon: 31.307 },
	ET: { name: 'Ethiopia', lat: 9.145, lon: 40.4897 },
	SO: { name: 'Somalia', lat: 5.1521, lon: 46.1996 },
})

/** Country names a feed may spell these as, mapped to the centroid keys. Exact matches only: 'Sudan' is a different country from 'South Sudan', and a substring match would be a border violation. */
export const COUNTRY_NAMES = Object.freeze({
	kenya: 'KE',
	uganda: 'UG',
	'south sudan': 'SS',
	ethiopia: 'ET',
	somalia: 'SO',
})

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Match a pilot district inside free text by word boundary.
 *
 * `String.includes` was the obvious spelling and is wrong for exactly this
 * list: 'Bor' is a district, and 'Borno', 'Tabora' and 'Borama' contain it.
 * Three- and four-character names demand the boundary; five plus get the same
 * rule for uniformity.
 */
export function matchPilotDistrict(text) {
	const normalized = String(text || '').toLowerCase().trim()
	if (!normalized) return null
	for (const d of PILOT_DISTRICTS) {
		const re = new RegExp(`(^|[^a-z])${escapeRegExp(d.name.toLowerCase())}([^a-z]|$)`)
		if (re.test(normalized)) return d
	}
	return null
}

/**
 * Resolve a place (and optional country code or name) to coordinates plus the
 * granularity label the record must carry.
 *
 * Returns `{ latitude, longitude, location_name, granularity }` or `null` —
 * `null` meaning "place nothing", which the caller must render as *nothing*
 * (`granularity: 'unknown'`, coordinates `null`), never as the map frame's
 * centre or any other invented pin.
 *
 * Priority: a pilot-district name inside the place text beats a country code,
 * because a district name the feed chose to publish is evidence about a
 * district, while 'KE' is only evidence about Kenya.
 */
export function geocodeOutbreakLocation(name, countryCode) {
	if (!name && !countryCode) return null

	// A country *name* embedded in the place text (ReliefWeb glance titles are
	// '<Country>: <Glance>') narrows nothing below a district match, but beats
	// trusting the record's own country list when they disagree — the title is
	// what the publisher wrote last. Boundary-matched like district names:
	// 'Sudan' is a different country from 'South Sudan', and one is a
	// substring of the other.
	const codeFromText = (() => {
		const text = String(name || '').toLowerCase().trim()
		if (!text) return null
		for (const [countryName, mapped] of Object.entries(COUNTRY_NAMES)) {
			const re = new RegExp(`(^|[^a-z])${escapeRegExp(countryName)}([^a-z]|$)`)
			if (re.test(text)) return mapped
		}
		return null
	})()
	const district = matchPilotDistrict(name)
	if (district) {
		return {
			latitude: district.center[1],
			longitude: district.center[0],
			location_name: district.name,
			granularity: 'subnational',
		}
	}

	// Accept either a centroid key ('SS') or a country name ('South Sudan');
	// unknown codes fall through to null rather than to a guessed country.
	const normalized = String(countryCode || '').toLowerCase().trim()
	const code = normalized.length === 2
		? normalized.toUpperCase()
		: COUNTRY_NAMES[normalized] || null
	const centroidKey = COUNTRY_CENTROIDS[code] ? code : codeFromText
	if (centroidKey && COUNTRY_CENTROIDS[centroidKey]) {
		const cc = COUNTRY_CENTROIDS[centroidKey]
		return {
			latitude: cc.lat,
			longitude: cc.lon,
			location_name: cc.name,
			granularity: 'national',
		}
	}

	// A place name that names no district and no pilot country: nothing,
	// honestly. The caller records `granularity: 'unknown'` and the map draws
	// nothing for it — an unplaced record in the endpoint's data is one the
	// operator can still read in the list and detail panes.
	return null
}
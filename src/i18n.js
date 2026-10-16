/**
 * The server-side text primitives.
 *
 * `loadCatalog` and `SUPPORTED_LOCALES` were deleted 2026-10-16: nothing
 * imported either, and the only thing that would have used them is the
 * `?locale=` option on the markdown report export, which is itself unwired —
 * `renderReportMarkdown` takes a `locale` and renders every structural word in
 * English, and the catalogs in `public/i18n/` hold UI labels, not the report
 * document's `Type:`/`Status:`/`Warnings` headings. So the loader had nothing
 * to load *for*, and deleting it removes a capability claim rather than a
 * capability. The finding is recorded against the option, not the loader: the
 * route accepts a locale it cannot honour, which is a defect a caller can hit.
 *
 * What remains is what the tree actually calls: `plainLanguage` from
 * `src/reports.js`, and `t`/`isRtl` from the client bundle's tests.
 */
export function t(catalog, key, params = {}) {
	let text = catalog[key] || key
	for (const [name, value] of Object.entries(params)) {
		text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), value)
	}
	return text
}

export function isRtl(locale) {
	return locale === 'ar'
}

export function plainLanguage(text, { readingLevel = 'standard' } = {}) {
	if (readingLevel !== 'basic') return { text, notes: [] }

	const notes = []
	const maxLength = 25
	let result = text

	const sentences = text.split(/(?<=[.!?])\s+/)
	const simplified = []

	for (const sentence of sentences) {
		const words = sentence.split(/\s+/)
		if (words.length > maxLength) {
			const chunks = []
			let chunk = []
			for (const word of words) {
				chunk.push(word)
				if (chunk.join(' ').split(/\s+/).length >= maxLength - 2) {
					chunks.push(chunk.join(' '))
					chunk = []
				}
			}
			if (chunk.length) chunks.push(chunk.join(' '))
			simplified.push(...chunks)
			notes.push(`Simplified long sentence into ${chunks.length} parts`)
		} else {
			simplified.push(sentence)
		}
	}

	result = simplified.join('. ')

	const abbreviations = {
		'SITREP': 'situation report',
		'IBF': 'impact-based forecasting',
		'GIS': 'geographic information system',
		'API': 'application programming interface',
		'SMS': 'text message',
		'URL': 'web address',
	}

	for (const [abbr, expanded] of Object.entries(abbreviations)) {
		const regex = new RegExp(`\\b${abbr}\\b`, 'g')
		if (regex.test(result)) {
			result = result.replace(regex, expanded)
			notes.push(`Expanded ${abbr} to ${expanded}`)
		}
	}

	return { text: result, notes }
}

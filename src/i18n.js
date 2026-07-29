import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const i18nDir = path.resolve(__dirname, '../public/i18n')
const catalogCache = {}

export const SUPPORTED_LOCALES = ['en', 'sw', 'ar', 'so', 'din', 'km', 'nk', 'fr', 'pt', 'am']

export async function loadCatalog(locale = 'en') {
	if (catalogCache[locale]) return catalogCache[locale]

	const normalized = SUPPORTED_LOCALES.includes(locale) ? locale : 'en'
	try {
		const data = await fs.readFile(path.join(i18nDir, `${normalized}.json`), 'utf8')
		const catalog = JSON.parse(data)
		catalogCache[normalized] = catalog
		return catalog
	} catch {
		return {}
	}
}

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

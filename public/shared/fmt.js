// =============================================================
// Lindela Lite — shared formatting
// =============================================================
// Eight surfaces, four different date idioms, five escape helpers, three
// severity-to-class mappings with different defaults, and nine inline number
// formatters. Every copy was a chance for two surfaces to disagree about how
// the same value reads, and they did: `203.0 people`, `9/28/2026, 6:55:29 AM`,
// `2026-10-02`, and a status bar whose "Updated" stamp meant nothing without
// its timezone.
//
// This is the single source for anything a user reads off a screen.

/**
 * Escape text for interpolation into innerHTML.
 *
 * Uses `??` rather than `||` on purpose: `escapeHtml(v || '')` renders a
 * legitimate 0 or false as an empty string, which silently blanks a real value.
 * Two surfaces had that bug.
 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

/** Reduce a value to a safe CSS class token. */
export function safeClass(value, fallback = 'unknown') {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9_-]/g, '-') || fallback
}

// =============================================================
// Numbers
// =============================================================

/**
 * A number, or an em dash when there is nothing to show.
 *
 * `int: true` for counts. `203.0 people` was on screen: a count carrying a
 * decimal place it cannot have.
 */
export function num(value, { dp = 1, int = false, dash = '—' } = {}) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return dash
  return int
    ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })
    : Number(value).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

/**
 * A percentage, with the scale stated rather than guessed.
 *
 * It used to infer the scale from magnitude — `Math.abs(n) <= 1 ? n * 100 : n`
 * — on the reasoning that a fraction is small and a percentage is not. The
 * heuristic cannot tell a fraction from a percentage, and a percentage has no
 * floor above 1. Measured on the old code: `0.005 → 0.5%`, `0.5 → 50.0%`,
 * `1 → 100.0%`, `1.5 → 1.5%`, `2 → 2.0%`. Two of the five are wrong, and
 * worse than wrong: `pct(1)` rendering `100.0%` turns a 1% rate into a
 * certain one, and `1 → 100.0` then `1.5 → 1.5` is *non-monotone*, so a
 * higher true rate reads as a lower one. In an early-warning product the first
 * failure raises a false alarm about the system and the second hides a real
 * one.
 *
 * `scale: 'percent'` (the default) means the value is already 0–100 and is
 * rendered as given. `scale: 'fraction'` means it is 0–1 and is multiplied by
 * 100 first. The default is `'percent'` because the majority of callers pass
 * already-scaled values and a call site that was silently getting the right
 * answer by luck should keep it.
 */
export function pct(value, { dp = 1, dash = '—', scale = 'percent' } = {}) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return dash
  if (scale !== 'percent' && scale !== 'fraction') {
    throw new TypeError(`pct(): scale must be 'percent' or 'fraction', got ${JSON.stringify(scale)}`)
  }
  const n = Number(value)
  return `${(scale === 'fraction' ? n * 100 : n).toFixed(dp)}%`
}

/** A signed number, for anomalies and deltas: +2.17, -0.4. */
export function signed(value, { dp = 2, unit = '', dash = '—' } = {}) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return dash
  const n = Number(value)
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return `${sign}${Math.abs(n).toFixed(dp)}${unit}`
}

/** Yes/no, for booleans that arrive as either. */
export function yesNo(value, yes = 'Yes', no = 'No') {
  if (value === null || value === undefined || value === '') return '—'
  return value === true || value === 'true' || value === 1 ? yes : no
}

// =============================================================
// Severity and status
// =============================================================

/** The four levels every surface agrees on. Anything else is unknown. */
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])

/**
 * Severity to CSS class.
 *
 * One default ('medium'), one allowlist. A severity string used to be
 * interpolated straight into a class attribute on one surface, so a value
 * containing a quote injected markup.
 */
export function sevClass(severity) {
  const s = String(severity || '').toLowerCase()
  return SEVERITIES.has(s) ? s : 'medium'
}

/**
 * The class attribute for a severity chip.
 *
 * Returns `sev-chip sev-<level>` and nothing else. This helper existed and
 * handed out `chip chip-<level>` — a spelling no surface's own CSS declared
 * until one of them did, by which point severity was being styled four ways
 * across the product (HX-07). A helper that emits a class string other than
 * the one the stylesheet knows is worse than no helper, because the bypass is
 * invisible at the call site.
 *
 * The returned string is safe in any attribute position: the level comes from
 * the allowlist above and the prefix is a literal.
 */
export function sevChip(severity) {
  return `sev-chip sev-${sevClass(severity)}`
}

/**
 * A complete severity chip: the canonical classes, the word, and the word
 * again in a `title`.
 *
 * The `title` is what makes truncation safe. Any surface that shortens a
 * severity label must still hand over the full one somewhere; the console's
 * alert rail already does this for rule names and this is the same rule applied
 * to the severity word itself.
 */
export function sevChipHtml(severity) {
  const level = sevClass(severity)
  const word = String(severity || '').trim().toLowerCase() || 'unknown'
  return `<span class="${sevChip(severity)}" title="${esc(word)}">${esc(word)}</span>`
}

/**
 * A duration, in the largest unit that stays readable.
 *
 * The status bar rendered every lag in minutes — "2880m" for two days — because
 * the unit was baked into the template rather than chosen.
 */
export function formatDuration(minutes, { dash = '—' } = {}) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return dash
  const n = Number(minutes)
  const abs = Math.abs(n)
  if (abs < 60) return `${Math.round(n)} min`
  if (abs < 1440) return `${(n / 60).toFixed(1)} h`
  return `${(n / 1440).toFixed(1)} d`
}

// =============================================================
// Time
// =============================================================

const TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
})()

/** Short zone label: EAT, UTC+3, GMT. */
function zoneLabel(date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date)
    return parts.find((p) => p.type === 'timeZoneName')?.value || TIME_ZONE
  } catch {
    return TIME_ZONE
  }
}

const RELATIVE_UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

const relativeFormatter = (() => {
  try {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  } catch {
    return null
  }
})()

/**
 * How long ago, in words: "12 minutes ago", "3 days ago".
 *
 * Seconds are dropped. Every timestamp on the product carried them and no user
 * ever needed them; on an approval screen they cost the reader a moment of
 * parsing for nothing.
 */
export function formatRelative(value, { dash = '—' } = {}) {
  if (!value) return dash
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return dash
  const seconds = (Date.now() - date.getTime()) / 1000
  if (Math.abs(seconds) < 45) return 'just now'
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) {
      const amount = Math.round(seconds / size)
      if (relativeFormatter) return relativeFormatter.format(-amount, unit)
      return `${amount} ${unit}${amount === 1 ? '' : 's'} ago`
    }
  }
  return 'just now'
}

/**
 * An absolute timestamp with its zone: "2 Oct 2026, 14:18 EAT".
 *
 * Day-month-year, not the browser's locale-dependent m/d/y, because the readers
 * are spread across Kenya, Uganda, Sudan and Chad and an ambiguous 9/28 is a
 * worse answer than an unambiguous 28 Sep.
 */
export function formatTimestamp(value, { style = 'datetime', dash = '—' } = {}) {
  if (!value) return dash
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return dash

  const dayMonth = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', timeZone: TIME_ZONE,
  }).format(date)
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TIME_ZONE,
  }).format(date)
  const year = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: TIME_ZONE }).format(date)

  if (style === 'date') return `${dayMonth} ${year}`
  if (style === 'iso-day') return `${year}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `${dayMonth} ${year}, ${time} ${zoneLabel(date)}`
}

// =============================================================
// Truncation
// =============================================================

/**
 * Shorten an identifier in the middle, keeping both ends recognisable.
 *
 * The parametric console showed `disbursement_7e5b8a4ca0e91ee` and
 * `0x53961be91373ac7` as primary column content, where `…ca0e91ee` and
 * `0x5396…3ac7` carry the same information and do not push the useful columns
 * off the screen.
 */
export function truncateId(value, { head = 8, tail = 6, dash = '—' } = {}) {
  if (value === null || value === undefined || value === '') return dash
  const s = String(value)
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

/** Truncate prose at a word boundary, for one-line summaries. */
export function truncate(value, { max = 140, dash = '' } = {}) {
  if (value === null || value === undefined || value === '') return dash
  const s = String(value)
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

// =============================================================
// Common units
// =============================================================

/** A count of things, pluralised: "1 alert", "0 alerts". */
export function plural(count, singular, pluralForm = `${singular}s`, { dash = '—' } = {}) {
  if (count === null || count === undefined || !Number.isFinite(Number(count))) return dash
  const n = Number(count)
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`
}

/** Metres, with a sensible number of decimals for the magnitude. */
export function metres(value, { dash = '—' } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return dash
  const n = Number(value)
  return n >= 100 ? `${Math.round(n).toLocaleString()} m` : n >= 1 ? `${n.toFixed(1)} m` : `${n.toFixed(2)} m`
}

/** Square kilometres, rounded to something an operator can hold in mind. */
export function sqKm(value, { dash = '—' } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return dash
  return `${num(value, { dp: 0 })} km²`
}
// =============================================================
// Locales
// =============================================================

/**
 * What the product knows about each locale it ships.
 *
 * `rtl` drives `document.documentElement.dir`. Three surfaces set it by
 * hand and five do not, and the RTL block in styles.css could never be reached
 * from markup because every page hardcoded `dir="ltr"` on <html>.
 *
 * `label` is the language's name in that language, which is what a reader
 * looking for their own language expects to see in a picker.
 */
const LOCALE_INFO = {
  en: { label: 'English',      rtl: false },
  sw: { label: 'Kiswahili',    rtl: false },
  so: { label: 'Soomaali',     rtl: false },
  am: { label: 'አማርኛ',        rtl: false },
  fr: { label: 'Français',     rtl: false },
  pt: { label: 'Português',    rtl: false },
  din: { label: 'Thuɔŋjäŋ',      rtl: false },
  km: { label: 'ភាសាខ្មែរ',      rtl: false },
  nk: { label: 'Nhgakarimojong', rtl: false },
  ar: { label: 'العربية',      rtl: true },
}

/** The locales this build ships, in picker order. */
export const AVAILABLE_LOCALES = Object.keys(LOCALE_INFO)

export function isRtl(locale) {
  return Boolean(LOCALE_INFO[locale]?.rtl)
}

export function localeLabel(locale) {
  return LOCALE_INFO[locale]?.label || locale
}

/**
 * Apply a locale to the document.
 *
 * Sets `lang` and `dir` together, because setting only one of them is how a
 * page ends up declaring Arabic content with a left-to-right layout.
 */
export function applyLocaleToDocument(locale) {
  const root = document.documentElement
  root.lang = locale
  root.dir = isRtl(locale) ? 'rtl' : 'ltr'
  return locale
}

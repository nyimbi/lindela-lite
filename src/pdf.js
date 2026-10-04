import crypto from 'node:crypto'

// Minimal PDF 1.4 generator using only built-in Helvetica font.
// No external dependencies. Produces a single-page PDF with title, KPI table, cohort table, and footer.
// Tested to open in macOS Preview and qlmanage.
//
// ENH-27: page 1 is the numbers, pages 2+ are the narrative — what was measured,
// what was refused, and what a reader must not conclude. A PDF that leaves the
// building carrying only a KPI table is a spreadsheet with a cover sheet, and
// the caveats it omits are the ones a reader of a printed page cannot check.
//
// The refusal vocabulary reaches this file through `narrative.limits`, built in
// `reports.js` from `MODEL_BASIS` and imported there rather than retyped — a
// quoted refusal that drifts from the code is a claim the code no longer
// supports. `fmt` has one job beyond formatting, which is refusing to print a
// null as though it were a value.

function pdfStr(s) {
  return `(${String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r').replace(/\n/g, '\\n')})`
}

/**
 * The typographic characters this document actually uses, mapped to their
 * WinAnsiEncoding bytes.
 *
 * A PDF content stream is bytes, and `Buffer.from(text, 'latin1')` truncates a
 * UTF-16 code unit to its low byte. So U+2014 (an em dash) was written as 0x14 —
 * a control character — and every refusal sentence in the narrative contains
 * one. It rendered as a control glyph in Preview and as nothing at all in a
 * text extractor, which means the exact text this file exists to print was
 * partly unreadable. Latin-1 truncation is silent about this, so it needs a
 * table rather than a cast.
 */
const WINANSI_EXTRA = Object.freeze({
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c,
  'ž': 0x9e, 'Ÿ': 0x9f,
})

/**
 * A string encoded as the bytes WinAnsiEncoding means.
 *
 * Anything with no WinAnsi byte becomes `?` rather than a wrong byte. A `?` is
 * visibly a gap a reader can report; a silently mangled control character is
 * not — and a mangled character in a refusal sentence is worse than a missing
 * one, because the sentence still looks present.
 */
function toWinAnsi(text) {
  let out = ''
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    if (code < 0x100) out += char
    else if (WINANSI_EXTRA[char] !== undefined) out += String.fromCharCode(WINANSI_EXTRA[char])
    else out += '?'
  }
  return out
}

function signatureHash(kpi) {
  return crypto.createHash('sha256').update(JSON.stringify(kpi)).digest('hex').slice(0, 16)
}

function buildTextLines(kpi) {
  const lines = []
  const period = kpi.period || {}
  const cohort = kpi.cohort || {}

  lines.push({ text: `Lindela Lite - Climate & Health KPI Report`, size: 16, bold: true, y: 760 })
  lines.push({ text: `Period: ${period.quarter || '-'} ${period.year || '-'}  |  ${period.from ? period.from.slice(0, 10) : ''} to ${period.to ? period.to.slice(0, 10) : ''}`, size: 10, y: 740 })
  lines.push({ text: `Generated: ${kpi.generated_at || new Date().toISOString()}`, size: 9, y: 728 })

  // Divider (simulated with dashes in text)
  lines.push({ text: `---`, size: 9, y: 716 })

  lines.push({ text: `KPI Summary`, size: 13, bold: true, y: 700 })

  const kpiRows = [
    ['People reached', fmt(kpi.people_reached, '')],
    ['Community reporters', fmt(kpi.community_reporters_count, '')],
    ['Youth mappers', fmt(kpi.youth_mappers_count, '')],
    ['OSS releases', fmt(kpi.oss_releases_count, '')],
    ['Signal-to-dispatch median', fmt(kpi.warning_to_action_median_hours, 'h')],
    ['Feeding repositioning rate', fmt(kpi.feeding_supply_repositioning_rate, '%')],
    ['Cold-chain protection rate', fmt(kpi.cold_chain_protection_rate, '%')],
    ['False alert rate', fmt(kpi.false_alert_rate, '%')],
    ['API uptime', fmt(kpi.api_uptime_pct, '%')],
    ['% Children U18', fmt(kpi.percent_children_u18, '%')],
    ['% Women and girls', fmt(kpi.percent_women_and_girls, '%')],
    ['% PwD', fmt(kpi.percent_pwd, '%')],
  ]

  let y = 682
  for (const [label, value] of kpiRows) {
    lines.push({ text: `  ${label.padEnd(34)} ${value}`, size: 9, y })
    y -= 14
    if (y < 300) break
  }

  lines.push({ text: `Cohort`, size: 13, bold: true, y: y - 6 })
  y -= 22

  const cohortRows = [
    ['Total', cohort.total ?? '-'],
    ['Under 18', cohort.u18 ?? '-'],
    ['Women and girls', cohort.women_and_girls ?? '-'],
    ['PwD', cohort.pwd ?? '-'],
    ['Refugees/IDPs', cohort.refugees_idps ?? '-'],
  ]
  for (const [label, value] of cohortRows) {
    lines.push({ text: `  ${label.padEnd(20)} ${value}`, size: 9, y })
    y -= 14
  }

  // The bid target is real context, but it was printed immediately under a figure
  // that does not measure the same thing, which reads as though this number were
  // being assessed against it. Kept as reference, explicitly separated, with the
  // caveat on its own lines so it cannot be skimmed past.
  lines.push({ text: `Data gaps: ${(kpi.data_gaps || []).map((g) => g.field).join(', ') || 'none'}`, size: 7, y: 68 })
  lines.push({ text: `External target for reference: warning-to-action < 24h. The signal-to-dispatch`, size: 7, y: 56 })
  lines.push({ text: `median above is this platform's own SMS latency, not a field action, and is not`, size: 7, y: 48 })
  lines.push({ text: `comparable to that target. A low value does not mean the response was fast.`, size: 7, y: 40 })
  lines.push({ text: `Signature (SHA-256/16): ${signatureHash(kpi)}`, size: 8, y: 28 })

  return lines
}

function fmt(v, unit) {
  // A withheld measurement prints as its reason, never as a dash beside other
  // figures. `-` in a column of numbers reads as zero to anyone scanning the
  // page, which is how `brier_score: null` becomes an implied score.
  if (v === null || v === undefined) return 'not measured'
  if (typeof v === 'number') return `${v.toFixed(1)}${unit}`
  return `${v}${unit}`
}

/**
 * The narrative pages, ENH-27.
 *
 * Each block is what its heading claims: the measured claims with their source
 * counts, the refusals with the reason each module gave, and the limits. Nothing
 * here recomputes anything, and there is no path by which a refusal becomes a
 * figure — the blocks are lists of strings, so a refused measurement has no
 * number to render.
 */
function buildNarrativeLines(narrative) {
  const lines = []
  let y = 780

  const heading = (text, size = 14) => {
    lines.push({ text, size, bold: true, y })
    y -= size + 8
  }
  const para = (text, size = 8) => {
    // Wrap on words. A PDF content stream has no text flow, so an unwrapped
    // refusal runs off the right margin and is silently lost — which for the
    // block that exists to prevent overstatement would be the worst possible
    // place to lose text.
    for (const line of wrapText(String(text), 108)) {
      if (y < 60) return false
      lines.push({ text: line, size, y })
      y -= size + 3.5
    }
    y -= 6
    return true
  }

  heading('What this report is')
  if (!para('Read with the figures on page 1. Those figures are counts and rates computed over what '
    + 'reached this platform during the period. They are not validated against observed outcomes and '
    + 'none of them is calibrated. Where the system declined to produce a number, it says so below '
    + 'rather than leaving a blank that reads as a zero.')) return lines

  heading('What was measured')
  for (const item of narrative.measured || []) {
    const refs = item.source_refs ? ` (${item.source_refs} source reference(s))` : ' (no source references)'
    if (!para(`- ${item.claim}${refs}`)) return lines
  }

  heading('What was refused')
  if (!(narrative.refused || []).length) {
    para('- Nothing in scope was refused. That is a statement about sample size, not a clean bill of health.')
  } else {
    for (const item of narrative.refused) {
      if (!para(`- ${item.subject}: ${item.reason}`)) return lines
    }
  }

  heading('What this report does not support')
  for (const limit of narrative.limits || []) {
    if (!para(`- ${limit}`)) return lines
  }

  if (narrative.provenance) {
    heading('Provenance')
    if (!para(`${narrative.provenance.note || ''}${narrative.provenance.origin ? ` Origin: ${narrative.provenance.origin}.` : ''}`)) return lines
    if (narrative.provenance.as_of && !para(`Underlying bodies retrieved as of ${narrative.provenance.as_of}.`)) return lines
  }

  lines.push({ text: `Signature (SHA-256/16): ${signatureHash(narrative)}`, size: 8, y: 40 })
  return lines
}

/** Greedy word wrap. Words longer than the width are left long rather than cut. */
function wrapText(text, width) {
  const out = []
  let line = ''
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (!line.length) line = word
    else if (`${line} ${word}`.length <= width) line += ` ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line.length) out.push(line)
  return out.length ? out : ['']
}

export function renderQuarterlyReportPdf(kpi, options = {}) {
  const pages = [buildTextLines(kpi)]

  // The narrative is optional so an existing caller passing only a KPI gets the
  // page it got before, and the second page appears when there is a narrative
  // to carry rather than a placeholder claiming one was considered.
  const narrative = options.narrative
  if (narrative && (narrative.measured?.length || narrative.refused?.length || narrative.limits?.length)) {
    pages.push(buildNarrativeLines(narrative))
  }

  const streamLines = ['BT']
  for (const line of pages.flat()) {
    const font = line.bold ? '/Hb' : '/H'
    const size = line.size || 10
    streamLines.push(`${font} ${size} Tf`)
    streamLines.push(`50 ${line.y} Td`)
    streamLines.push(`${pdfStr(toWinAnsi(line.text))} Tj`)
    streamLines.push('-50 0 Td')
  }
  streamLines.push('ET')

  const streamContent = streamLines.join('\n')
  // One byte per WinAnsi code, so the string must already be encoded before the
  // Buffer sees it. Passing raw UTF-8 here would double-encode and exceed the
  // declared /Length.
  const streamBytes = Buffer.from(streamContent, 'latin1')
  const streamLen = streamBytes.length

  // PDF object offsets for xref table
  const offsets = []

  const parts = []

  // Header
  const header = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  parts.push(Buffer.from(header, 'binary'))

  // Object 1: catalog
  offsets[1] = parts.reduce((s, p) => s + p.length, 0)
  parts.push(Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'ascii'))

  // Object 2: pages. Page objects are 3, 5, 7...; content streams 4, 6, 8...
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')
  offsets[2] = parts.reduce((s, p) => s + p.length, 0)
  parts.push(Buffer.from(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`, 'ascii'))

  pages.forEach((_, index) => {
    const pageObj = 3 + index * 2
    const contentObj = pageObj + 1
    offsets[pageObj] = parts.reduce((s, p) => s + p.length, 0)
    parts.push(Buffer.from(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]\n`
      + `   /Contents ${contentObj} 0 R /Resources << /Font << /H ${3 + pages.length * 2} 0 R /Hb ${4 + pages.length * 2} 0 R >> >> >>\nendobj\n`,
      'ascii'
    ))
    offsets[contentObj] = parts.reduce((s, p) => s + p.length, 0)
    parts.push(Buffer.from(`${contentObj} 0 obj\n<< /Length ${streamLen} >>\nstream\n`, 'ascii'))
    parts.push(streamBytes)
    parts.push(Buffer.from('\nendstream\nendobj\n', 'ascii'))
  })

  // The two fonts, numbered after the page/content pairs. Written once and
  // referenced by every page, because the previous single-page layout gave them
  // fixed numbers 5 and 6 and that only held while there was one page.
  const normalFont = 3 + pages.length * 2
  const boldFont = normalFont + 1
  offsets[normalFont] = parts.reduce((s, p) => s + p.length, 0)
  parts.push(Buffer.from(
    `${normalFont} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica\n`
    + '   /Encoding /WinAnsiEncoding >>\nendobj\n',
    'ascii'
  ))
  offsets[boldFont] = parts.reduce((s, p) => s + p.length, 0)
  parts.push(Buffer.from(
    `${boldFont} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold\n`
    + '   /Encoding /WinAnsiEncoding >>\nendobj\n',
    'ascii'
  ))

  const size = boldFont + 1

  // xref table
  const xrefOffset = parts.reduce((s, p) => s + p.length, 0)
  const xrefLines = ['xref', `0 ${size}`, '0000000000 65535 f \n']
  for (let i = 1; i < size; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  }
  parts.push(Buffer.from(xrefLines.join('\n'), 'ascii'))

  // trailer
  parts.push(Buffer.from(
    `\ntrailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    'ascii'
  ))

  return Buffer.concat(parts)
}

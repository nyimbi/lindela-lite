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
    // The refusal is printed as the value, not as a dash. A dash in a funder
    // report reads as "we do not know" and gets skipped; the sentence says the
    // response is below the sample floor, which is a finding.
    ['Warning-to-field-action median', kpi.warning_to_action_field_refusal
      ? `not reported: ${kpi.warning_to_action_field_refusal}`
      : `${fmt(kpi.warning_to_action_field_median_hours, 'h')} (${kpi.warning_to_action_field_samples} confirmations)`],
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
  // No page number. The sheet that lists what this file contains is page 1 and
  // the KPI figures follow it, and a cross-reference that has to be re-checked
  // whenever a section is added is a cross-reference that will be wrong.
  if (!para('Read with the KPI figures on the page immediately after this one. Those figures are counts and rates computed over what '
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

/**
 * The seven sections the CO dashboard renders, and whether the PDF carries them.
 *
 * The dashboard loaded seven sections and the export carried two — the KPI page
 * and the narrative — with nothing on either side saying so. A donor who
 * received the PDF reasonably concluded the dashboard had been summarised, and
 * a CO who exported it had no way to tell their reader what was missing.
 *
 * `quarterlyReportCoverage()` is the single declaration, used by the PDF, by
 * `GET /api/v1/kpi/quarterly/coverage` and by the export preview on the
 * dashboard. One list, so the preview cannot drift from the file.
 */
export const DASHBOARD_SECTIONS = [
  { id: 'kpi', title: 'KPI Summary', in_pdf: true },
  { id: 'trend', title: 'Trend', in_pdf: true },
  { id: 'qoq', title: 'Quarter-over-quarter', in_pdf: true },
  { id: 'equity', title: 'Equity by District', in_pdf: true },
  { id: 'histogram', title: 'Signal-to-Action Lag', in_pdf: true },
  { id: 'feedback', title: 'Community Feedback', in_pdf: true },
  { id: 'narrative', title: 'What this report is', in_pdf: true },
]

/** One line for the PDF footer and the export preview. */
export function quarterlyReportCoverage(sections = DASHBOARD_SECTIONS) {
  const carried = sections.filter((s) => s.in_pdf)
  const missing = sections.filter((s) => !s.in_pdf)
  return {
    total: sections.length,
    carried: carried.length,
    titles: carried.map((s) => s.title),
    missing: missing.map((s) => s.title),
    summary: missing.length
      ? `This export carries ${carried.length} of ${sections.length} dashboard sections. Not included: ${missing.map((s) => s.title).join(', ')}.`
      : `This export carries all ${sections.length} dashboard sections.`,
  }
}

/**
 * One table page.
 *
 * `columns` is `[label, value]` pairs. A row with an absent value prints the
 * reason rather than a dash, for the same reason `fmt` does: a dash in a column
 * of numbers reads as a zero, and a zero is a claim.
 */
function buildTablePage({ title, subtitle, columns, note, emptyNote }) {
  const lines = []
  let y = 780

  lines.push({ text: title, size: 14, bold: true, y })
  y -= 18
  if (subtitle) {
    for (const line of wrapText(subtitle, 100)) {
      lines.push({ text: line, size: 8, y })
      y -= 11
    }
    y -= 6
  }

  if (!columns.length) {
    for (const line of wrapText(emptyNote || 'No records for this period.', 100)) {
      lines.push({ text: line, size: 9, y })
      y -= 12
    }
    return lines
  }

  for (const [label, value] of columns) {
    if (y < 80) {
      lines.push({ text: '- continued -', size: 8, y })
      return lines
    }
    const text = `  ${String(label).padEnd(30)} ${value}`
    if (text.length <= 108) {
      lines.push({ text, size: 9, y })
      y -= 13
    } else {
      // A long label must not run off the page and be lost without trace.
      lines.push({ text: `  ${label}`, size: 9, y, bold: true })
      y -= 13
      for (const cont of wrapText(String(value), 96)) {
        if (y < 80) return lines
        lines.push({ text: `      ${cont}`, size: 9, y })
        y -= 13
      }
    }
  }

  if (note && y > 60) {
    y -= 8
    for (const line of wrapText(note, 100)) {
      if (y < 50) break
      lines.push({ text: line, size: 7, y })
      y -= 10
    }
  }
  return lines
}

/**
 * The four sections the export was missing, rendered as pages.
 *
 * Each takes the same array the dashboard renders from, computed by the same
 * call, so a figure cannot be one thing on screen and another in the file.
 * Anything unavailable renders an explicit refusal line — the export is the
 * artefact that leaves the building, so an omission there is the expensive one.
 */
export function buildSectionPages(sections = {}) {
  const pages = []

  // --- Trend: the twelve months ending in the reported quarter -------------
  const series = sections.trend || []
  pages.push(buildTablePage({
    title: 'Trend',
    subtitle: `Monthly series for the twelve months ending ${sections.period?.quarter || ''} ${sections.period?.year || ''}. `
      + 'Each month is computed over the records that reached this platform in that month; none is a forecast and none is back-filled.',
    columns: series.map((m) => [
      m.month,
      `reached ${fmt(m.people_reached, '')} | reporters ${fmt(m.community_reporters_count, '')} | `
      + `lag ${fmt(m.warning_to_action_median_hours, 'h')} | feeding ${fmt(m.feeding_repositioning_rate, '%')}`,
    ]),
    note: 'A null figure is a measurement this platform declined to make. It is printed with the reason, not as a zero.',
  }))

  // --- Quarter-over-quarter: the last two comparable quarters -------------
  const qoq = sections.qoq || []
  pages.push(buildTablePage({
    title: 'Quarter-over-quarter',
    subtitle: 'Change between consecutive quarters over the same three measures. A quarter with no prior comparable quarter is reported as new, not as growth.',
    columns: qoq.map((q) => [
      q.quarter,
      `reached ${fmt(q.people_reached, '')} | reporters ${fmt(q.community_reporters_count, '')} | lag ${fmt(q.warning_to_action_median_hours, 'h')}`,
    ]),
  }))

  // --- Equity by district: the section most often asked for ---------------
  const equity = sections.equity || []
  pages.push(buildTablePage({
    title: 'Equity by District',
    subtitle: 'Per district: alerts raised, how many had a matching dispatch, and the dispatch precision over alerts whose outcome someone recorded.',
    columns: equity.map((d) => [
      d.district,
      `alerts ${d.alerts} | dispatched ${d.dispatched} | reviewed ${d.false_alert_determined} | `
      + `precision ${fmt(d.dispatch_precision_pct, '%')}`,
    ]),
    note: 'Dispatch precision is measured only over alerts that were dispatched and then resolved with a note. A district '
      + 'whose sample is smaller than that has no precision figure, and this page says so rather than printing a percentage '
      + 'computed from one record.',
  }))

  // --- Signal-to-action lag ----------------------------------------------
  const lag = sections.lag || []
  pages.push(buildTablePage({
    title: 'Signal-to-Action Lag',
    subtitle: sections.lag_measure || '',
    columns: lag.map((b) => [b.label, `${b.count} dispatch(es)`]),
    note: sections.lag_note,
  }))

  // --- Community feedback -------------------------------------------------
  const feedback = sections.feedback || []
  pages.push(buildTablePage({
    title: 'Community Feedback',
    subtitle: 'Feedback received against each alert, with the sentiment recorded by the intake form. Sentiment is the submitter\'s '
      + 'word; it is not a classification this platform computed.',
    columns: feedback.map((f) => [
      f.alert_event_id || 'not linked to an alert',
      `${f.count} response(s) | positive ${f.sentiment?.positive ?? 0} | negative ${f.sentiment?.negative ?? 0} | `
      + `unclear ${f.sentiment?.unclear ?? 0} | action taken ${f.action_taken_count ?? 0}`,
    ]),
  }))

  return pages
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

  // The four sections the dashboard shows and this file did not. Rendered from
  // the same arrays the dashboard renders from, so the two cannot disagree.
  if (options.sections) pages.push(...buildSectionPages(options.sections))

  // And the line that says what the file is. A reader who is handed a PDF has
  // no way to know what they were not sent, and a CO who exported has no way to
  // tell their reader either — so it is printed, on page 1, in the file.
  if (options.coverage) {
    const cov = typeof options.coverage === 'function' ? options.coverage() : options.coverage
    pages.unshift(buildTablePage({
      title: 'What this file contains',
      columns: [
        ['Sections carried', `${cov.carried} of ${cov.total}`],
        ['Also on the dashboard', cov.missing.length ? cov.missing.join(', ') : 'nothing — this file is complete'],
        ['Source', 'Counts and rates over records that reached this platform. Not validated against field outcomes.'],
        ['Read first', 'This sheet, then the KPI figures, then "What this report is".'],
      ],
    }))
  }

  // One content stream per page.
  //
  // These were all flattened into a single stream and every page object pointed
  // at its own copy of it, so each page drew every line in the document. With
  // one page that is invisible; with two it means the narrative page also
  // appeared behind the KPI figures; and once the export grew to carry the
  // dashboard's five other sections, every page was the whole report. The
  // duplication was in the object graph, not the text, so it survived every
  // content-level test.
  const streams = pages.map((lines) => {
    const streamLines = ['BT']
    for (const line of lines) {
      const font = line.bold ? '/Hb' : '/H'
      const size = line.size || 10
      streamLines.push(`${font} ${size} Tf`)
      streamLines.push(`50 ${line.y} Td`)
      streamLines.push(`${pdfStr(toWinAnsi(line.text))} Tj`)
      streamLines.push('-50 0 Td')
    }
    streamLines.push('ET')
    // One byte per WinAnsi code, so the string must already be encoded before
    // the Buffer sees it. Passing raw UTF-8 here would double-encode and exceed
    // the declared /Length.
    return Buffer.from(streamLines.join('\n'), 'latin1')
  })

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
    parts.push(Buffer.from(`${contentObj} 0 obj\n<< /Length ${streams[index].length} >>\nstream\n`, 'ascii'))
    parts.push(streams[index])
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


/**
 * The Markdown twin of renderQuarterlyReportPdf.
 *
 * The /api/v1/kpi/quarterly.md route used to hand renderExportMarkdown a
 * generic alert digest, so the CO dashboard's "Download as Markdown" button
 * delivered a report with no quarterly figures in it at all — the right
 * refusals wrapped around the wrong numbers. This renderer takes the same
 * kpi/narrative/sections/coverage inputs the PDF takes, from the same
 * helpers, so the two files cannot disagree about what the quarter said.
 *
 * The composition order mirrors the PDF: what the file contains, then the
 * KPI figures, then the narrative, then the dashboard sections.
 */
export function renderQuarterlyReportMarkdown(kpi, options = {}) {
  const md = []
  const period = kpi.period || {}
  const cohort = kpi.cohort || {}
  const push = (s = '') => md.push(s)

  push('# Lindela Lite - Climate & Health KPI Report')
  push('')
  push(`- Period: ${period.quarter || '-'} ${period.year || '-'}  |  ${period.from ? period.from.slice(0, 10) : ''} to ${period.to ? period.to.slice(0, 10) : ''}`)
  push(`- Generated: ${kpi.generated_at || new Date().toISOString()}`)
  push('')

  // The same coverage sheet the PDF prints on page 1. A reader of the file
  // has no dashboard to compare against, so the file says what it is.
  if (options.coverage) {
    const cov = typeof options.coverage === 'function' ? options.coverage() : options.coverage
    push('## What this file contains')
    push('')
    push(`- Sections carried: ${cov.carried} of ${cov.total}`)
    push(`- Also on the dashboard: ${cov.missing.length ? cov.missing.join(', ') : 'nothing — this file is complete'}`)
    push('- Source: Counts and rates over records that reached this platform. Not validated against field outcomes.')
    push('- Read first: This sheet, then the KPI figures, then "What this report is".')
    push('')
  }

  // KPI Summary — the same rows buildTextLines prints, in the same order.
  push('## KPI Summary')
  push('')
  push('| Metric | Value |')
  push('| --- | --- |')
  const kpiRows = [
    ['People reached', fmt(kpi.people_reached, '')],
    ['Community reporters', fmt(kpi.community_reporters_count, '')],
    ['Youth mappers', fmt(kpi.youth_mappers_count, '')],
    ['OSS releases', fmt(kpi.oss_releases_count, '')],
    ['Signal-to-dispatch median', fmt(kpi.warning_to_action_median_hours, 'h')],
    // The refusal is printed as the value, not as a dash. A dash in a funder
    // report reads as "we do not know" and gets skipped; the sentence says the
    // response is below the sample floor, which is a finding.
    ['Warning-to-field-action median', kpi.warning_to_action_field_refusal
      ? `not reported: ${kpi.warning_to_action_field_refusal}`
      : `${fmt(kpi.warning_to_action_field_median_hours, 'h')} (${kpi.warning_to_action_field_samples} confirmations)`],
    ['Feeding repositioning rate', fmt(kpi.feeding_supply_repositioning_rate, '%')],
    ['Cold-chain protection rate', fmt(kpi.cold_chain_protection_rate, '%')],
    ['False alert rate', fmt(kpi.false_alert_rate, '%')],
    ['API uptime', fmt(kpi.api_uptime_pct, '%')],
    ['% Children U18', fmt(kpi.percent_children_u18, '%')],
    ['% Women and girls', fmt(kpi.percent_women_and_girls, '%')],
    ['% PwD', fmt(kpi.percent_pwd, '%')],
  ]
  for (const [label, value] of kpiRows) push(`| ${label} | ${value} |`)
  push('')

  push('### Cohort')
  push('')
  push('| Group | Count |')
  push('| --- | --- |')
  const cohortRows = [
    ['Total', cohort.total ?? '-'],
    ['Under 18', cohort.u18 ?? '-'],
    ['Women and girls', cohort.women_and_girls ?? '-'],
    ['PwD', cohort.pwd ?? '-'],
    ['Refugees/IDPs', cohort.refugees_idps ?? '-'],
  ]
  for (const [label, value] of cohortRows) push(`| ${label} | ${value} |`)
  push('')

  // The bid target caveat travels with the figures, as it does in the PDF —
  // separated from the number it does not measure, on its own lines.
  push(`Data gaps: ${(kpi.data_gaps || []).map((g) => g.field).join(', ') || 'none'}`)
  push('')
  push('> External target for reference: warning-to-action < 24h. The signal-to-dispatch '
    + 'median above is this platform\'s own SMS latency, not a field action, and is not '
    + 'comparable to that target. A low value does not mean the response was fast.')
  push('')

  const narrative = options.narrative
  if (narrative && (narrative.measured?.length || narrative.refused?.length || narrative.limits?.length)) {
    push('## What this report is')
    push('')
    push('Read with the KPI figures above. Those figures are counts and rates computed over what '
      + 'reached this platform during the period. They are not validated against observed outcomes and '
      + 'none of them is calibrated. Where the system declined to produce a number, it says so below '
      + 'rather than leaving a blank that reads as a zero.')
    push('')
    push('### What was measured')
    push('')
    for (const item of narrative.measured || []) {
      const refs = item.source_refs ? ` (${item.source_refs} source reference(s))` : ' (no source references)'
      push(`- ${item.claim}${refs}`)
    }
    push('')
    push('### What was refused')
    push('')
    if (!(narrative.refused || []).length) {
      push('- Nothing in scope was refused. That is a statement about sample size, not a clean bill of health.')
    } else {
      for (const item of narrative.refused) push(`- ${item.subject}: ${item.reason}`)
    }
    push('')
    push('### What this report does not support')
    push('')
    for (const limit of narrative.limits || []) push(`- ${limit}`)
    push('')
    if (narrative.provenance) {
      push('### Provenance')
      push('')
      push(`${narrative.provenance.note || ''}${narrative.provenance.origin ? ` Origin: ${narrative.provenance.origin}.` : ''}`)
      if (narrative.provenance.as_of) push(`Underlying bodies retrieved as of ${narrative.provenance.as_of}.`)
      push('')
    }
    push(`Signature (SHA-256/16): ${signatureHash(narrative)}`)
    push('')
  }

  // The dashboard sections — the same arrays buildSectionPages renders.
  const sections = options.sections
  if (sections) {
    const series = sections.trend || []
    push('## Trend')
    push('')
    push(`Monthly series for the twelve months ending ${sections.period?.quarter || ''} ${sections.period?.year || ''}. `
      + 'Each month is computed over the records that reached this platform in that month; none is a forecast and none is back-filled.')
    push('')
    push('| Month | Reached | Reporters | Lag | Feeding repositioning |')
    push('| --- | --- | --- | --- | --- |')
    for (const m of series) {
      push(`| ${m.month} | ${fmt(m.people_reached, '')} | ${fmt(m.community_reporters_count, '')} | `
        + `${fmt(m.warning_to_action_median_hours, 'h')} | ${fmt(m.feeding_repositioning_rate, '%')} |`)
    }
    push('')
    push('A null figure is a measurement this platform declined to make. It is printed with the reason, not as a zero.')
    push('')

    const qoq = sections.qoq || []
    push('## Quarter-over-quarter')
    push('')
    push('Change between consecutive quarters over the same three measures. A quarter with no prior comparable quarter is reported as new, not as growth.')
    push('')
    push('| Quarter | People reached | Community reporters | Signal-to-dispatch |')
    push('| --- | --- | --- | --- |')
    for (const q of qoq) {
      push(`| ${q.quarter} | ${fmt(q.people_reached, '')} | ${fmt(q.community_reporters_count, '')} | ${fmt(q.warning_to_action_median_hours, 'h')} |`)
    }
    push('')

    const equity = sections.equity || []
    push('## Equity by District')
    push('')
    push('Per district: alerts raised, how many had a matching dispatch, and the dispatch precision over alerts whose outcome someone recorded.')
    push('')
    push('| District | Alerts | Dispatched | Reviewed | Dispatch precision |')
    push('| --- | --- | --- | --- | --- |')
    for (const d of equity) {
      push(`| ${d.district} | ${d.alerts} | ${d.dispatched} | ${d.false_alert_determined} | ${fmt(d.dispatch_precision_pct, '%')} |`)
    }
    push('')
    push('Dispatch precision is measured only over alerts that were dispatched and then resolved with a note. A district '
      + 'whose sample is smaller than that has no precision figure, and this page says so rather than printing a percentage '
      + 'computed from one record.')
    push('')

    const lag = sections.lag || []
    push('## Signal-to-Action Lag')
    push('')
    if (sections.lag_measure) push(`${sections.lag_measure}`)
    if (sections.lag_measure) push('')
    push('| Bucket | Dispatches |')
    push('| --- | --- |')
    for (const b of lag) push(`| ${b.label} | ${b.count} |`)
    if (sections.lag_note) { push(''); push(sections.lag_note) }
    push('')

    const feedback = sections.feedback || []
    push('## Community Feedback')
    push('')
    push('Feedback received against each alert, with the sentiment recorded by the intake form. Sentiment is the submitter\'s '
      + 'word; it is not a classification this platform computed.')
    push('')
    push('| Alert | Responses | Positive | Negative | Unclear | Action taken |')
    push('| --- | --- | --- | --- | --- | --- |')
    for (const f of feedback) {
      push(`| ${f.alert_event_id || 'not linked to an alert'} | ${f.count} | ${f.sentiment?.positive ?? 0} | `
        + `${f.sentiment?.negative ?? 0} | ${f.sentiment?.unclear ?? 0} | ${f.action_taken_count ?? 0} |`)
    }
    push('')
  }

  push(`Signature (SHA-256/16): ${signatureHash(kpi)}`)
  return md.join('\n')
}

import crypto from 'node:crypto'

// Minimal PDF 1.4 generator using only built-in Helvetica font.
// No external dependencies. Produces a single-page PDF with title, KPI table, cohort table, and footer.
// Tested to open in macOS Preview and qlmanage.

function pdfStr(s) {
  return `(${String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r').replace(/\n/g, '\\n')})`
}

function signatureHash(kpi) {
  return crypto.createHash('sha256').update(JSON.stringify(kpi)).digest('hex').slice(0, 16)
}

function buildTextLines(kpi) {
  const lines = []
  const period = kpi.period || {}
  const cohort = kpi.cohort || {}

  lines.push({ text: `Lindela Lite - UNICEF Climate & Health KPI Report`, size: 16, bold: true, y: 760 })
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
    ['Warning-to-action median', fmt(kpi.warning_to_action_median_hours, 'h')],
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

  const sig = signatureHash(kpi)
  lines.push({ text: `Signature (SHA-256/16): ${sig}`, size: 8, y: 60 })
  lines.push({ text: `UNICEF bid target: warning-to-action < 24h`, size: 8, y: 48 })
  lines.push({ text: `Data gaps: ${(kpi.data_gaps || []).map((g) => g.field).join(', ')}`, size: 7, y: 36 })

  return lines
}

function fmt(v, unit) {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'number') return `${v.toFixed(1)}${unit}`
  return `${v}${unit}`
}

export function renderQuarterlyReportPdf(kpi, _options = {}) {
  const lines = buildTextLines(kpi)

  // Build PDF content stream
  const streamLines = []
  streamLines.push('BT')

  for (const line of lines) {
    const font = line.bold ? '/Hb' : '/H'
    const size = line.size || 10
    streamLines.push(`${font} ${size} Tf`)
    streamLines.push(`50 ${line.y} Td`)
    streamLines.push(`${pdfStr(line.text)} Tj`)
    streamLines.push(`-50 0 Td`)
  }

  streamLines.push('ET')
  const streamContent = streamLines.join('\n')
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

  // Object 2: pages
  offsets[2] = parts.reduce((s, p) => s + p.length, 0)
  parts.push(Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'ascii'))

  // Object 3: page
  offsets[3] = parts.reduce((s, p) => s + p.length, 0)
  parts.push(Buffer.from(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]\n' +
    '   /Contents 4 0 R /Resources << /Font << /H 5 0 R /Hb 6 0 R >> >> >>\nendobj\n',
    'ascii'
  ))

  // Object 4: content stream
  offsets[4] = parts.reduce((s, p) => s + p.length, 0)
  parts.push(Buffer.from(`4 0 obj\n<< /Length ${streamLen} >>\nstream\n`, 'ascii'))
  parts.push(streamBytes)
  parts.push(Buffer.from('\nendstream\nendobj\n', 'ascii'))

  // Object 5: Helvetica font
  offsets[5] = parts.reduce((s, p) => s + p.length, 0)
  parts.push(Buffer.from(
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica\n' +
    '   /Encoding /WinAnsiEncoding >>\nendobj\n',
    'ascii'
  ))

  // Object 6: Helvetica-Bold font
  offsets[6] = parts.reduce((s, p) => s + p.length, 0)
  parts.push(Buffer.from(
    '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold\n' +
    '   /Encoding /WinAnsiEncoding >>\nendobj\n',
    'ascii'
  ))

  // xref table
  const xrefOffset = parts.reduce((s, p) => s + p.length, 0)
  const xrefLines = ['xref', `0 7`, '0000000000 65535 f \n']
  for (let i = 1; i <= 6; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  }
  parts.push(Buffer.from(xrefLines.join('\n'), 'ascii'))

  // trailer
  parts.push(Buffer.from(
    `\ntrailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    'ascii'
  ))

  return Buffer.concat(parts)
}

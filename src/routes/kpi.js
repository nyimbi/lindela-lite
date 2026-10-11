/**
 * ARC-01 — the KPI routes, out of the god function.
 *
 * Seven routes that share one subject: the figures a donor reads. Two of them
 * serve the quarterly report in different formats — `.md` and `.pdf` — and the
 * defect this family carried was that the two disagreed. The Markdown route
 * handed `renderExportMarkdown` a generic alert digest, so the download button
 * on the CO dashboard delivered a report with no quarterly figures in it at all:
 * the right refusals wrapped around the wrong numbers.
 *
 * They now compose from the same three pieces — `computeQuarterlyKpi`,
 * `quarterlyPdfSections`, and `buildQuarterlyExportNarrative` — and that is
 * exactly why the family belongs in one module. Two routes that must agree are
 * two routes that must be read together, and 1,900 lines apart they were not.
 *
 * The narrative is the fourth piece, and it is a *refusal* surface rather than a
 * content one. A quarterly export whose narrative cannot be generated still
 * exports, carrying a page that says so — because a missing page reads as "there
 * was nothing to refuse", which is the one reading a refusals-carrying document
 * must never produce.
 *
 * `matchKpiRoute` reads the pathname and the method, and nothing else. The
 * method is in the matcher rather than the handler because `.md`, `.pdf` and the
 * bare `quarterly` path differ by suffix, not by verb, and a matcher that took
 * every method would make `POST /api/v1/kpi/quarterly` a route.
 */

import { computeQuarterlyKpi, computeMonthlyKpiSeries, refreshKpiSnapshots, quarterlyPdfSections } from '../kpi.js'
import { renderQuarterlyReportPdf, renderQuarterlyReportMarkdown, quarterlyReportCoverage, DASHBOARD_SECTIONS } from '../pdf.js'
import { buildExportNarrative, generateReportSections, normalizeReport, normalizeReportTemplate } from '../reports.js'

/**
 * Which KPI route a request is, or null.
 *
 * Method-aware, unlike the export matcher: three of these share a path with a
 * different verb (`refresh-snapshots` is the POST beside two GETs) and the four
 * quarterly formats differ only by suffix. `check-openapi.mjs` reads this
 * matcher's `pathname === '…'` literals, so the paths are spelled out rather
 * than assembled from a prefix and a suffix — a template literal is invisible to
 * that gate, and a route the gate cannot see is a route the document is then
 * accused of missing.
 */
export function matchKpiRoute(pathname, method = 'GET') {
  if (pathname === '/api/v1/kpi/monthly-series' && method === 'GET') return { kind: 'monthly-series' }
  if (pathname === '/api/v1/kpi/snapshots' && method === 'GET') return { kind: 'snapshots' }
  if (pathname === '/api/v1/kpi/refresh-snapshots' && method === 'POST') return { kind: 'refresh-snapshots' }
  if (pathname === '/api/v1/kpi/quarterly.md' && method === 'GET') return { kind: 'quarterly-md' }
  if (pathname === '/api/v1/kpi/quarterly/coverage' && method === 'GET') return { kind: 'quarterly-coverage' }
  if (pathname === '/api/v1/kpi/quarterly.pdf' && method === 'GET') return { kind: 'quarterly-pdf' }
  if (pathname === '/api/v1/kpi/quarterly' && method === 'GET') return { kind: 'quarterly' }
  return null
}

/**
 * The narrative both quarterly exports ride with.
 *
 * A report that cannot be built still yields an export — one that says the
 * narrative could not be produced, because a missing page reads as "there was
 * nothing to refuse". The catch is the whole point of the function: this is the
 * only place in the family where a failure is *content* rather than a status
 * code.
 */
export function buildQuarterlyExportNarrative(data, period) {
  try {
    const templates = data.report_templates || []
    const template = templates[0] || normalizeReportTemplate({ id: 'quarterly-export', name: 'Quarterly export' }, data)
    const report = generateReportSections(
      normalizeReport({ template_id: template.id, period }, data),
      data,
    )
    return buildExportNarrative({ report, data })
  } catch (err) {
    return {
      measured: [],
      refused: [{
        subject: 'Narrative',
        reason: `the report could not be generated for this period: ${err.message}`,
      }],
      limits: ['This file carries the figures only. Nothing below the KPI page is a claim about what was measured.'],
    }
  }
}

/**
 * Handle one KPI route. Returns true when it handled the request.
 *
 * `requestRing` is injected rather than imported: it is per-process state the
 * server owns, and its `successRate()` is a property of this instance's recent
 * traffic, not of the data.
 */
export async function handleKpiRoute(route, { store, data, req, res, url, jsonResponse, requestRing }) {
  const { kind } = route
  const ringRate = requestRing?.successRate()

  if (kind === 'monthly-series') {
    const monthsBack = Number(url.searchParams.get('monthsBack')) || 12
    jsonResponse(res, 200, { success: true, data: computeMonthlyKpiSeries(data, { monthsBack }) })
    return true
  }

  if (kind === 'snapshots') {
    jsonResponse(res, 200, { success: true, data: data.kpi_snapshots || [] })
    return true
  }

  if (kind === 'refresh-snapshots') {
    const snapshots = await refreshKpiSnapshots(store)
    jsonResponse(res, 200, { success: true, count: snapshots.length })
    return true
  }

  // The four quarterly formats resolve the period the same way, so it is read
  // once. `undefined` rather than `null` for the absent case, because
  // `computeQuarterlyKpi` defaults on `undefined` and would treat an explicit
  // `null` as a value it has to parse.
  const period = {
    quarter: url.searchParams.get('quarter') || undefined,
    year: url.searchParams.get('year') || undefined,
  }

  if (kind === 'quarterly-md' || kind === 'quarterly-pdf' || kind === 'quarterly') {
    let kpi
    try {
      kpi = computeQuarterlyKpi(data, { ...period, ringRate })
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      return true
    }

    if (kind === 'quarterly') {
      jsonResponse(res, 200, { success: true, data: kpi })
      return true
    }

    // The same composition the PDF renders: the dashboard sections computed by
    // the same helpers, the narrative, and the coverage sheet. Both formats
    // build this here rather than in their own renderer, so a figure cannot be
    // one thing in the Markdown and another in the PDF.
    const sections = quarterlyPdfSections(data, { quarter: kpi.period.quarter, year: kpi.period.year, ringRate })
    const narrative = buildQuarterlyExportNarrative(data, { quarter: kpi.period.quarter, year: kpi.period.year })

    if (kind === 'quarterly-md') {
      const markdown = renderQuarterlyReportMarkdown(kpi, {
        narrative,
        sections,
        coverage: quarterlyReportCoverage,
      })
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="lindela-kpi-${kpi.period.year}-${kpi.period.quarter}.md"`,
      })
      res.end(markdown)
      return true
    }

    const buf = renderQuarterlyReportPdf(kpi, {
      narrative,
      sections,
      coverage: quarterlyReportCoverage,
    })
    const filename = `lindela-kpi-${kpi.period.year}-${kpi.period.quarter}.pdf`
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': buf.length,
    })
    res.end(buf)
    return true
  }

  if (kind === 'quarterly-coverage') {
    // What the PDF carries, before anyone downloads it.
    //
    // The dashboard exported a two-section file from a seven-section page with
    // no note on either side, so a funder receiving the PDF had no way to know
    // that Equity by District — the section they most often ask for by name —
    // was not in it. The list is generated from the same declaration the
    // renderer uses, so the preview cannot drift from the file.
    jsonResponse(res, 200, { success: true, data: { sections: DASHBOARD_SECTIONS, ...quarterlyReportCoverage() } })
    return true
  }

  return false
}

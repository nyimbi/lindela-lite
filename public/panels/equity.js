/**
 * The equity panel's rendering, loaded with its markup.
 *
 * Moved out of `app.js` with the other deferred panels' behaviour. The console's
 * first load is measured by `check-budget` against a field connection, and this
 * is a table behind a tab an operator opens when they are auditing district
 * coverage — not part of the first paint.
 *
 * What it receives is listed rather than imported, because `app.js` is the
 * console: importing it here would load all of it to render four cells. The
 * parameter block below is the whole contract, and a reader can see the
 * dependency surface without opening anything else.
 */
export function render(console_) {
  const { $, state, escapeHtml, truncate, pageWindow, renderPager } = console_

  const alerts = state.data.alerts?.data || []
  const dispatches = state.data.dispatches?.data || []
  const table = $('equityTable')
  const emptyState = $('equityEmptyState')
  if (!table) return

  // Dispatched counts come from rapidpro_dispatches, joined to the alert event
  // to recover the district. Alert events do not carry a dispatch_status field at
  // all, so reading it from them yields zero dispatched for every district —
  // which renders as a false-positive rate of "—" everywhere, and reads as "we
  // never send" rather than "this was computed from the wrong table".
  const dispatchedByAlert = new Map()
  for (const dispatch of dispatches) {
    if (!dispatch.alert_event_id) continue
    if (dispatch.status !== 'sent') continue
    dispatchedByAlert.set(dispatch.alert_event_id, (dispatchedByAlert.get(dispatch.alert_event_id) || 0) + 1)
  }

  const grouped = {}
  for (const a of alerts) {
    const district = a.scope?.district || 'unknown'
    if (!grouped[district]) grouped[district] = { dispatched: 0, acknowledged: 0 }
    grouped[district].dispatched += dispatchedByAlert.get(a.id) || 0
    if (a.status === 'acknowledged' || a.status === 'resolved') grouped[district].acknowledged++
  }

  const districts = Object.entries(grouped)
  const rerender = () => render(console_)

  if (!districts.length) {
    emptyState.hidden = false
    table.hidden = true
    renderPager($('equityPager'), 'equity', 0, rerender)
    return
  }

  emptyState.hidden = true
  table.hidden = false
  const slice = pageWindow('equity', districts.length)
  const tbody = table.querySelector('tbody')
  if (tbody) {
    tbody.innerHTML = districts.slice(slice.start, slice.end).map(([district, data]) => {
      const rate = data.dispatched > 0 ? ((data.dispatched - data.acknowledged) / data.dispatched * 100).toFixed(1) : '—'
      return `<tr>
        <td title="${escapeHtml(district)}">${escapeHtml(truncate(district, { max: 40 }))}</td>
        <td>${escapeHtml(String(data.dispatched))}</td>
        <td>${escapeHtml(String(data.acknowledged))}</td>
        <td>${escapeHtml(String(rate))}%</td>
      </tr>`
    }).join('')
  }

  renderPager($('equityPager'), 'equity', districts.length, rerender)
}

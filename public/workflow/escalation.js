/**
 * The "needs escalation" view (JTBD-476, P0-B).
 *
 * The catalogue asks for "alert events past deadline". An alert event has no
 * deadline: buildAlert in src/alerts.js writes id, rule, status, severity,
 * metric, value, threshold, operator, message, actions, scope, created_at,
 * updated_at, suppression_bucket, approval and metadata — and no date by which
 * anything is due. DoD item 7 wants deadlines stored and breach detection
 * emitting an outbox event; neither exists.
 *
 * So this ranks on the nearest real signal, which is the one the wording
 * actually means in an emergency response: how long the alert has been sitting
 * open with nobody acting on it. The threshold is the operator's, it is named
 * on the control, and it is shown next to every row — because a list of "old"
 * alerts with the definition of old hidden is a list nobody can argue with.
 */

import { esc, formatRelative, num, sevClass } from '/shared/fmt.js'

const THRESHOLD_KEY = 'lindela_lite_escalation_days'
const DEFAULT_DAYS = 3

/** Statuses that mean somebody dealt with it. Anything else is still open. */
const SETTLED = new Set(['approved', 'auto_approved', 'auto-approved', 'rejected', 'closed', 'dismissed'])

const dayMs = 24 * 60 * 60 * 1000

export function readThreshold() {
  const raw = Number(localStorage.getItem(THRESHOLD_KEY))
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAYS
}

function ageDays(record, now) {
  const opened = Date.parse(record.created_at || '')
  if (!Number.isFinite(opened)) return null
  return (now - opened) / dayMs
}

/**
 * Mount the view. `getAlerts` is a function, not a value, because the console
 * repaints its alert list every thirty seconds and a view holding a snapshot
 * would disagree with the list above it.
 */
export function mountEscalation({ getAlerts, openSubject }) {
  const section = document.getElementById('escalationView')
  if (!section) return
  const toggle = document.getElementById('escalationToggle')
  const body = document.getElementById('escalationBody')
  const input = document.getElementById('escalationDays')

  if (input) {
    input.value = String(readThreshold())
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (!Number.isFinite(value) || value < 0) {
        input.value = String(readThreshold())
        return
      }
      localStorage.setItem(THRESHOLD_KEY, String(value))
      render()
    })
  }

  function render() {
    if (!body) return
    const days = readThreshold()
    const now = Date.now()
    const rows = (getAlerts() || [])
      .map((record) => ({ record, age: ageDays(record, now) }))
      // An alert with no parseable created_at cannot be ranked by age, and
      // guessing it is "new" would hide it from exactly the view meant to
      // surface things nobody looked at. It stays in, ranked last, saying why.
      .filter(({ record, age }) => !SETTLED.has(String(record.status)) && (age === null || age >= days))
      .sort((a, b) => (b.age ?? -1) - (a.age ?? -1))

    const badge = document.getElementById('escalationCount')
    if (badge) {
      badge.textContent = String(rows.length)
      badge.hidden = !rows.length
    }

    if (!rows.length) {
      body.innerHTML = `<p class="empty-note">No alert has been open ${days === 0 ? 'at all' : `for ${days} day${days === 1 ? '' : 's'} or longer`} without a decision.</p>`
      return
    }

    body.innerHTML = `<ul class="escalation-list">${rows.map(({ record, age }) => `
      <li class="escalation-item">
        <div>
          <span class="sev-chip sev-${sevClass(record.severity)}">${esc(record.severity || 'unknown')}</span>
          <span class="escalation-name">${esc(record.rule_name || record.id || '')}</span>
          <div class="escalation-meta">
            ${age === null
              ? 'no created_at on this record, so it cannot be aged'
              : `open ${num(Math.round(age * 10) / 10)} days · threshold ${days}d · ${esc(formatRelative(record.created_at))}`}
          </div>
        </div>
        <button class="btn btn-xs" type="button" data-open="${esc(record.id)}"
                aria-label="Open panel for alert ${esc(record.id)}">Panel</button>
      </li>`).join('')}</ul>`

    body.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openSubject({ kind: 'alert_event', id: btn.dataset.open }))
    })
  }

  toggle?.addEventListener('click', () => {
    const open = body.hidden
    body.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (open) render()
  })

  render()
  return { render }
}

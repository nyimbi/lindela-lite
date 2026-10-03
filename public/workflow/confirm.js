/**
 * Confirmation gates for the writes the catalogue says were ungated.
 *
 * JTBD-002: default ingestion schedules were written with no confirmation and
 * no preview of what would be created. JTBD-007: the ACLED licence gate is a
 * flag on the connector with no UI step. JTBD-540: applying retention is
 * irreversible.
 *
 * Two rules hold for every gate here.
 *
 * The confirm button starts disabled. A dialog that opens with its dangerous
 * button live is one Enter keypress — or one click that landed on the backdrop
 * of the previous dialog — away from a write the operator has not read.
 *
 * The dialog says what will change, in the past tense of the result, before it
 * asks. A confirmation that only says "are you sure?" confirms that the
 * operator was unsure, which was never in doubt.
 */

import { esc } from '/shared/fmt.js'

const dlg = () => document.getElementById('confirmDialog')

function listGate(gate) {
  if (!gate) return ''
  if (gate.type === 'text') {
    return `<label class="confirm-gate">
      <span>Type <code>${esc(gate.expect)}</code> to continue</span>
      <input id="confirmGateText" type="text" autocomplete="off" spellcheck="false">
    </label>`
  }
  return `<label class="confirm-gate confirm-gate-check">
    <input id="confirmGateCheck" type="checkbox">
    <span>${gate.label}</span>
  </label>${gate.note ? `<p class="ops-control-note">${esc(gate.note)}</p>` : ''}`
}

/**
 * Show a confirmation gate and run `onConfirm` only when it is satisfied.
 *
 * `rows` is the diff: what the write creates, changes or deletes. An empty
 * array is rendered as an explicit "nothing would change" rather than as an
 * empty box, because an empty box reads as "not loaded yet".
 */
export function askToConfirm({ title, intro, rows = [], confirmLabel = 'Confirm', danger = false, gate = null, onConfirm }) {
  const dialog = dlg()
  if (!dialog) return

  const body = dialog.querySelector('.dialog-body')
  const confirmBtn = dialog.querySelector('[data-role="confirm"]')
  const cancelBtn = dialog.querySelector('[data-role="cancel"]')
  const titleEl = dialog.querySelector('.dialog-header h2')

  if (titleEl) titleEl.textContent = title
  confirmBtn.textContent = confirmLabel
  confirmBtn.classList.toggle('btn-danger', danger)
  confirmBtn.disabled = true
  // A backdrop click cancels, which is harmless. On an irreversible delete it
  // is also a plausible accident — the click meant for the button underneath a
  // dialog that had just appeared — so the destructive gate closes only on the
  // cancel button and on Escape, both of which require a second input.
  dialog.dataset.locked = danger ? '1' : '0'

  body.innerHTML = `
    <p class="confirm-intro">${intro}</p>
    ${rows.length
      ? `<table class="ops-table"><thead><tr><th scope="col">Change</th><th scope="col">Record</th><th scope="col">Detail</th></tr></thead><tbody>${rows.map((r) => `
        <tr><td>${esc(r.change)}</td><td>${esc(r.label)}</td><td>${esc(r.detail || '')}</td></tr>`).join('')}</tbody></table>`
      : '<p class="confirm-intro">This write would change nothing: every record it covers is already in the state it would be put into.</p>'}
    ${listGate(gate)}
    <p class="confirm-result" id="confirmResult" role="status" aria-live="polite"></p>
  `

  const textInput = body.querySelector('#confirmGateText')
  const checkInput = body.querySelector('#confirmGateCheck')
  const evaluate = () => {
    confirmBtn.disabled = gate?.type === 'text'
      ? textInput?.value.trim() !== gate.expect
      : gate?.type === 'check'
        ? !checkInput?.checked
        : false
  }
  textInput?.addEventListener('input', evaluate)
  checkInput?.addEventListener('change', evaluate)
  // Once, up front: an ungated confirmation starts disabled because that is the
  // safe default for every dialog here, and only a gate can lift it. Without
  // this the one dialog that has no gate could never be confirmed at all.
  evaluate()

  const close = () => {
    confirmBtn.removeEventListener('click', confirm)
    dialog.close()
  }

  const confirm = async () => {
    if (confirmBtn.disabled) return
    confirmBtn.disabled = true
    const result = body.querySelector('#confirmResult')
    if (result) result.textContent = 'Working…'
    try {
      const message = await onConfirm()
      if (result) result.textContent = message
      // The dialog stays open on success so the operator reads what happened
      // before dismissing it; it closes itself only when the caller throws.
      confirmBtn.textContent = 'Done'
    } catch (err) {
      if (result) result.textContent = String(err?.message || err)
      confirmBtn.disabled = false
      confirmBtn.textContent = confirmLabel
    }
  }

  confirmBtn.addEventListener('click', confirm)
  cancelBtn?.addEventListener('click', close)

  if (!dialog.dataset.mounted) {
    dialog.dataset.mounted = '1'
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && dialog.dataset.locked !== '1') dialog.close()
    })
  }

  dialog.showModal()
  // Focus the gate rather than the confirm button. A dialog that opens with
  // focus on the dangerous button invites the Enter keypress the disabled state
  // was meant to prevent.
  ;(gate ? textInput || checkInput : confirmBtn)?.focus()
}

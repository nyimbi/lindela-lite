import { initI18n, t, apiFetch, initOfflineBanner, initOfflineQueue } from '/shared/runtime.js'
import { mountNavbar } from '/shared/navbar.js'
import { esc as escapeHtml } from '/shared/fmt.js'
import { ERROR, QUEUED, describeState, distinguishFailure } from '/shared/states.js'
mountNavbar({ activePath: '/chw' })

const state = {
  locale: localStorage.getItem('lindela_lite_locale') || 'en',
  currentScreen: 'home',
  symptom: { who: null, type: null, duration: null, location: null },
  incident: { category: null, description: null, location: null },
  anonymous: true,
}

const $ = (id) => document.getElementById(id)

const localeSelect = $('locale-select')
const includeNameToggle = $('includeNameToggle')
const offlineBanner = $('offlineBanner')
const statusDot = $('statusDot')
const toast = $('toast')

/**
 * Null means "no location known". It is never (0, 0): that is a real coordinate
 * in the Gulf of Guinea, and a field report carrying it looks located to every
 * downstream join while pointing at open water.
 */
let userLocation = null
let userLocationError = null

async function init() {
  await initI18n(state.locale)
  await initOfflineQueue()
  initOfflineBanner()

  localeSelect.value = state.locale
  localeSelect.addEventListener('change', async (e) => {
    state.locale = e.target.value
    localStorage.setItem('lindela_lite_locale', state.locale)
    await window.__i18n.set(state.locale)
    document.documentElement.lang = state.locale
    document.documentElement.dir = state.locale === 'ar' ? 'rtl' : 'ltr'
  })

  includeNameToggle.addEventListener('change', (e) => {
    state.anonymous = !e.target.checked
  })

  window.addEventListener('online', updateStatus)
  window.addEventListener('offline', updateStatus)
  updateStatus()

  setupHomeScreen()
  setupSymptomScreen()
  setupSymptomTypeScreen()
  setupSymptomDurationScreen()
  setupSymptomLocationScreen()
  setupSymptomAboutWhoScreen()
  setupIncidentScreen()
  setupReplyScreen()

  refreshQueueStatus()
  requestUserLocation()
}

function updateStatus() {
  if (navigator.onLine) {
    statusDot?.classList.remove('offline')
    offlineBanner.classList.remove('show')
  } else {
    statusDot?.classList.add('offline')
    offlineBanner.classList.add('show')
  }
}

async function requestUserLocation() {
  if (!navigator.geolocation) {
    // Absence of the API is a different fact from a refused permission, and a
    // caller may want to tell them apart.
    userLocationError = 'geolocation_not_supported'
    return
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      userLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        source: 'gps',
        accuracy_m: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
      }
      userLocationError = null
    },
    (error) => {
      userLocation = null
      userLocationError = error?.code === 1 ? 'permission_denied' : (error?.code === 3 ? 'timeout' : 'unavailable')
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  )
}

/**
 * Move to another wizard screen.
 *
 * This used to toggle a class and stop. A screen-reader user pressing "Next"
 * heard nothing and focus stayed on the button they had just hidden, so the
 * next thing they reached was the top of the document rather than the new
 * screen. Focus now moves to the new screen's heading and the change is
 * announced.
 */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'))
  const screen = $(`${name}Screen`)
  if (!screen) return
  screen.classList.add('active')
  state.currentScreen = name

  const heading = screen.querySelector('.screen-title')
  if (heading) {
    // tabindex=-1 so the heading can take focus without joining the tab order.
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
    heading.focus({ preventScroll: true })
    screen.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const announcer = $('screenAnnouncer')
  if (announcer && heading) {
    // Re-set to the same text does not re-announce; clear first.
    announcer.textContent = ''
    requestAnimationFrame(() => { announcer.textContent = heading.textContent.trim() })
  }
}

/**
 * Hand a report to the offline queue, and say so only once it is stored.
 *
 * The toast used to be unconditional: the report was declared queued as soon as
 * `enqueue()` was *called*, and `enqueue()` resolved successfully when it had
 * stored nothing at all — no IndexedDB, or a write the browser then aborted. A
 * health worker was told their report was saved, watched the wizard reset, and
 * walked away. Nothing about a discarded report looks like a discarded report.
 *
 * So the acknowledgement has to arrive from the store. A throw leaves the wizard
 * standing, with everything they typed still in it, and the caller's catch
 * reports the failure — which is the one outcome in which retrying is the right
 * thing to do.
 */
async function queueReport(path, options, what) {
  const result = await window.lindelaQueue.enqueue(path, options)
  if (!result?.queued) throw new Error('the offline queue did not confirm the report')
  showToast(t('chw.report_queued', { what }), 'info')
}

let toastTimer = null

/**
 * Say what the offline queue is holding, at rest, on the screen the worker
 * returns to.
 *
 * The toast already existed, and it is the wrong instrument for this: it is
 * gone in five seconds and it appears over whatever screen happened to be open.
 * A worker who finishes one report and files the next has no way to know the
 * first one is still unsent — and an app that looks identical whether it is
 * holding two reports or none is indistinguishable from one that has thrown
 * them away.
 */
async function refreshQueueStatus() {
  const el = $('queueStatus')
  if (!el) return
  const count = await window.lindelaQueue?.pendingCount?.() ?? 0
  if (!count) {
    el.hidden = true
    el.dataset.state = 'none'
    el.textContent = ''
    return
  }
  const copy = describeState(QUEUED, { queuedCount: count, what: 'They' })
  el.hidden = false
  el.dataset.state = 'queued'
  el.innerHTML = `<strong>${escapeHtml(copy.title)}</strong>${escapeHtml(copy.body)}`
}

window.addEventListener('lindela-queue-changed', () => { refreshQueueStatus() })
window.addEventListener('lindela-queue-flushed', () => { refreshQueueStatus() })

function showToast(message, kind = 'info') {
  toast.textContent = message
  toast.dataset.kind = kind
  toast.classList.add('show')
  clearTimeout(toastTimer)
  // Long enough to be read aloud by a screen reader before it is cleared.
  toastTimer = setTimeout(() => toast.classList.remove('show'), kind === 'error' ? 8000 : 5000)
}

function setupHomeScreen() {
  $('reportSymptomBtn').addEventListener('click', () => showScreen('symptom'))
  $('reportIncidentBtn').addEventListener('click', () => showScreen('incident'))
  $('replyAlertBtn').addEventListener('click', async () => {
    await loadLastAlert()
    showScreen('reply')
  })
}

function setupSymptomScreen() {
  document.querySelectorAll('[data-symptom-who]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('[data-symptom-who]').forEach((b) => b.classList.remove('selected'))
      e.target.classList.add('selected')
      state.symptom.who = e.target.dataset.symptomWho
    })
  })

  $('symptomNextBtn').addEventListener('click', () => {
    if (!state.symptom.who) return
    showScreen('symptomType')
  })
  $('symptomBackBtn').addEventListener('click', () => showScreen('home'))
}

function setupSymptomTypeScreen() {
  document.querySelectorAll('[data-symptom-type]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('[data-symptom-type]').forEach((b) => b.classList.remove('selected'))
      e.target.classList.add('selected')
      state.symptom.type = e.target.dataset.symptomType
    })
  })

  $('symptomTypeNextBtn').addEventListener('click', () => {
    if (!state.symptom.type) return
    showScreen('symptomDuration')
  })
  $('symptomTypeBackBtn').addEventListener('click', () => showScreen('symptom'))
}

function setupSymptomDurationScreen() {
  document.querySelectorAll('[data-symptom-duration]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('[data-symptom-duration]').forEach((b) => b.classList.remove('selected'))
      e.target.classList.add('selected')
      state.symptom.duration = e.target.dataset.symptomDuration
    })
  })

  $('symptomDurationNextBtn').addEventListener('click', () => {
    if (!state.symptom.duration) return
    showScreen('symptomLocation')
  })
  $('symptomDurationBackBtn').addEventListener('click', () => showScreen('symptomType'))
}

function setupSymptomLocationScreen() {
  $('autoLocationBtn').addEventListener('click', () => {
    // A refused or timed-out fix must not be reported as a fix. The report goes
    // out with no coordinates and a stated reason, which is recoverable; a
    // report at (0, 0) is not.
    state.symptom.location = userLocation
      ? { ...userLocation }
      : { latitude: null, longitude: null, source: 'auto_failed', auto_error: userLocationError || 'unavailable' }
  })
  $('hereLocationBtn').addEventListener('click', () => {
    // "Here" is the CHW telling us where the problem is. It carries no
    // coordinates — a phone with no fix cannot supply one — so it is recorded as
    // a self-reported location rather than given a made-up point.
    state.symptom.location = { latitude: null, longitude: null, source: 'reported_here' }
  })
  $('symptomLocationNextBtn').addEventListener('click', () => {
    if (!state.symptom.location) {
      state.symptom.location = { latitude: null, longitude: null, source: 'not_answered' }
    }
    showScreen('symptomAboutWho')
  })
  $('symptomLocationBackBtn').addEventListener('click', () => showScreen('symptomDuration'))
}

function setupSymptomAboutWhoScreen() {
  $('symptomSubmitBtn').addEventListener('click', () => {
    state.symptom.demographics = {
      age_band: $('demoAgeBand').value || 'unknown',
      gender: $('demoGender').value || 'unknown',
      pwd: null,
      refugee_or_idp: null,
    }
    submitSymptomReport()
  })
  $('symptomAboutWhoBackBtn').addEventListener('click', () => showScreen('symptomLocation'))
}

async function submitSymptomReport() {
  const body = {
    kind: 'symptom',
    category: state.symptom.type,
    description: `${state.symptom.who} with ${state.symptom.type} for ${state.symptom.duration}`,
    location: state.symptom.location,
    anonymous: state.anonymous,
    demographics: state.symptom.demographics || undefined,
  }

  try {
    if (!navigator.onLine) {
      await queueReport('/api/v1/chw/report', { method: 'POST', body }, 'symptom report')
    } else {
      const res = await apiFetch('/api/v1/chw/report', { method: 'POST', body })
      showToast(t('chw.report_sent', { what: 'symptom report' }), 'ok')
    }
    state.symptom = { who: null, type: null, duration: null, location: null }
    showScreen('home')
    refreshQueueStatus()
  } catch (error) {
    showToast(t('chw.save_failed', { reason: error.message }), 'error')
  }
}

function setupIncidentScreen() {
  const categorySelect = $('incidentCategory')
  const locationBtns = document.querySelectorAll('[data-incident-location]')

  locationBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      state.incident.location = e.target.dataset.incidentLocation === 'auto'
        ? (userLocation
            ? { ...userLocation }
            : { latitude: null, longitude: null, source: 'auto_failed', auto_error: userLocationError || 'unavailable' })
        : { latitude: null, longitude: null, source: 'reported_here' }
    })
  })

  $('incidentSubmitBtn').addEventListener('click', async () => {
    if (!categorySelect.value) return
    const desc = $('incidentDescription').value
    const photo = $('incidentPhoto').files[0]

    const body = {
      kind: 'incident',
      category: categorySelect.value,
      description: desc,
      location: state.incident.location,
      anonymous: state.anonymous,
    }

    try {
      if (!navigator.onLine) {
        await queueReport('/api/v1/chw/report', { method: 'POST', body }, 'incident report')
      } else {
        const res = await apiFetch('/api/v1/chw/report', { method: 'POST', body })
        showToast(t('chw.report_sent', { what: 'incident report' }), 'ok')
      }
      categorySelect.value = ''
      $('incidentDescription').value = ''
      $('incidentPhoto').value = ''
      state.incident = { category: null, description: null, location: null }
      showScreen('home')
    refreshQueueStatus()
    } catch (error) {
      showToast(t('chw.save_failed', { reason: error.message }), 'error')
    }
  })

  $('incidentBackBtn').addEventListener('click', () => showScreen('home'))
}

/**
 * The alert card, in whichever state it earned.
 *
 * Offline is not a fault here. On a health worker's phone it is the ordinary
 * condition, and the only thing this card can legitimately show is "here is an
 * alert" / "the server has no alerts" / "the server could not be reached".
 * Anything held locally is a fourth state again — not an error, and certainly
 * not an empty list.
 */
async function loadLastAlert() {
  const card = $('alertCard')
  const text = $('alertText')

  // No alert id may survive a failed load: a reply composed against the previous
  // alert would be filed against the wrong event, and the server would accept it.
  delete text.dataset.alertId

  let res = null
  let error = null
  try {
    res = await apiFetch('/api/v1/rapidpro/inbound?limit=5')
  } catch (err) {
    error = err
  }

  const stateName = distinguishFailure({
    ok: !error,
    error,
    isEmpty: !res?.data?.length,
  })

  if (stateName === ERROR) {
    const queued = await window.lindelaQueue?.pendingCount?.() ?? 0
    const copy = queued > 0
      // Queued work changes what the sentence owes: the worker has reports
      // this device still holds, so silence about them would be the real lie.
      ? describeState(QUEUED, { queuedCount: queued, what: 'They' })
      : describeState(ERROR, { subject: 'Alerts', holdsWork: true })
    text.dataset.state = stateName
    text.innerHTML = `<strong>${escapeHtml(copy.title)}</strong> ${escapeHtml(copy.body)}`
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'retry-btn'
    btn.textContent = copy.retryable ? copy.action : 'Check again'
    btn.addEventListener('click', () => loadLastAlert())
    text.appendChild(btn)
    return
  }

  if (stateName === 'empty') {
    const copy = describeState('empty', { noun: 'alerts' })
    text.dataset.state = 'empty'
    text.textContent = copy.body
    return
  }

  const msg = res.data[0]
  text.dataset.state = 'ok'
  text.textContent = msg.text || 'The alert carried no text.'
  text.dataset.alertId = msg.event_id || ''
}

function setupReplyScreen() {
  $('replySubmitBtn').addEventListener('click', async () => {
    const message = $('replyMessage').value
    const alertId = $('alertText').dataset.alertId

    if (!message) return

    try {
      if (!navigator.onLine) {
        await queueReport('/api/v1/chw/reply', {
          method: 'POST',
          body: { alert_event_id: alertId, message },
        }, 'reply')
      } else {
        const res = await apiFetch('/api/v1/chw/reply', {
          method: 'POST',
          body: { alert_event_id: alertId, message },
        })
        showToast(t('chw.reply_sent'), 'ok')
      }
      $('replyMessage').value = ''
      showScreen('home')
    refreshQueueStatus()
    } catch (error) {
      showToast(t('chw.save_failed', { reason: error.message }), 'error')
    }
  })

  $('replyBackBtn').addEventListener('click', () => showScreen('home'))
}

await init()

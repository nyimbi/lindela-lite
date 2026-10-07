import { initI18n, t, apiFetch, initOfflineBanner, initOfflineQueue, initServiceWorker, submitOrQueue, autoMarkScrollableRegions } from '/shared/runtime.js'
import { mountNavbar } from '/shared/navbar.js'
import { esc as escapeHtml } from '/shared/fmt.js'
import { ERROR, LOADING, QUEUED, createLoadSequence, describeActionFailure, describeState, distinguishFailure, staleReadNote } from '/shared/states.js'
mountNavbar({ activePath: '/chw' })

const state = {
  locale: localStorage.getItem('lindela_lite_locale') || 'en',
  currentScreen: 'home',
  symptom: { who: null, type: null, duration: null, durationUnit: 'days', durationValue: null, location: null, severity: { dangerSigns: [], verySleepy: null, breathing: null, drinking: null, bleeding: null, other: null }, exposure: { contactSick: null, contactDead: null, vaccinationStatus: null, waterSource: 'clean', otherExposure: null } },
  incident: { category: null, description: null, location: null },
  anonymous: true,
}

/**
 * The symptom wizard is five screens, and it used to say so four times over.
 *
 * Every step carried the same `<h2>Report symptom</h2>`, so arriving anywhere
 * in the wizard looked identical to arriving at the first step, and the only
 * progress signal was a row of dots the health worker had to count — against
 * four dots on a wizard that has five screens. A dot row answers "how many";
 * the screen a person has just arrived at needs to say "which one".
 *
 * So each step names itself, and the counter is rendered from this one list so
 * the dots and the count cannot drift apart again.
 */
const SYMPTOM_STEPS = [
  { screen: 'symptom', label: 'Who has this symptom?' },
  { screen: 'symptomType', label: 'Which symptom?' },
  { screen: 'symptomSeverity', label: 'Danger signs?' },
  { screen: 'symptomDuration', label: 'How long has it been?' },
  { screen: 'symptomLocation', label: 'Where is the person?' },
  { screen: 'symptomExposure', label: 'Exposure and contact?' },
  { screen: 'symptomAboutWho', label: 'About the patient' },
]
const TOTAL_STEPS = SYMPTOM_STEPS.length

/** What each refusal says. A control that will not move owes a sentence. */
const HINTS = {
  symptom: 'Choose who has this symptom to continue.',
  symptomType: 'Choose a symptom to continue.',
  symptomDuration: 'Enter how many days or hours it has been.',
  symptomLocation: 'Choose a location, or continue without one.',
  manualLocation: 'Enter both a latitude and a longitude.',
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

/** A geolocation attempt in flight, so a second tap cannot start a second one. */
let geoRequest = null

/** One alert fetch in flight at a time, so a superseded response cannot paint. */
const alertLoads = createLoadSequence()

/** Why there is no fix, in the words of the person holding the phone. */
const GEO_FAILURES = {
  permission_denied: 'Location permission was refused, so this phone will not give a fix. Type the location below instead.',
  timeout: 'The phone could not get a fix in time — often indoors or under tree cover. Type the location below instead.',
  unavailable: 'This phone cannot get a location fix right now. Type the location below instead.',
  geolocation_not_supported: 'This phone has no location service. Type the location below instead.',
  null_island: 'This phone reported 0°, 0° — open ocean, not a household. Type the location below instead.',
  not_answered: 'No location is recorded with this report. It will be filed as unlocated.',
}

/** "Step 2 of 5", plus a dot row the counter and the dots cannot disagree about. */
function renderStepProgress() {
  for (const step of SYMPTOM_STEPS) {
    const index = SYMPTOM_STEPS.indexOf(step) + 1
    const screen = $(`${step.screen}Screen`)
    if (!screen) continue
    const dots = screen.querySelector('[data-step]')
    if (dots) {
      dots.textContent = ''
      for (let i = 1; i <= TOTAL_STEPS; i += 1) {
        const dot = document.createElement('span')
        dot.className = i <= index ? 'dot active' : 'dot'
        dots.appendChild(dot)
      }
    }
    const counter = screen.querySelector('[data-step-counter]')
    if (counter) counter.textContent = `Step ${index} of ${TOTAL_STEPS}`
  }
}

/**
 * The staleness banner for the CHW alert list.
 *
 * Prepended to the screen rather than drawn over it, and the retry re-reads:
 * yesterday's alerts are worth reading on a phone with no signal, they are just
 * not worth acting on blind. The banner is removed when a read comes back live.
 */
function renderStaleBanner(note, retry) {
  const host = $('chwStaleBanner')
  if (!host) return
  host.hidden = false
  host.dataset.state = 'stale'
  host.innerHTML = `<strong>${escapeHtml(note.title)}</strong> <p>${escapeHtml(note.body)}</p>`
  if (retry && !host.querySelector('.retry-btn')) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'retry-btn'
    btn.textContent = note.action || 'Try again'
    btn.addEventListener('click', retry)
    host.appendChild(btn)
  }
}

/** Say why a control is refusing to move, in a place a person will see it. */
function setHint(id, message = '', tone = '') {
  const el = $(id)
  if (!el) return
  el.textContent = message
  if (tone) el.dataset.tone = tone
  else delete el.dataset.tone
}

async function init() {
  await initI18n(state.locale)
  await initOfflineQueue()
  initOfflineBanner()
  // The field app is the one surface that must work with no connectivity, and
  // it was the one surface that never registered the worker. The console and
  // focal-point both called this; the app whose entire purpose is filing
  // reports from a village with no signal did not — so even once the
  // registration bug was fixed, this surface would have had an offline queue
  // with nothing to drain it and no shell cached to open.
  //
  // Awaited: the first paint must not race precaching, or a worker that is
  // still installing serves a partial shell on the very first offline visit.
  await initServiceWorker()

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
  setupSymptomSeverityScreen()
  setupSymptomExposureScreen()
  setupSymptomDurationScreen()
  setupSymptomLocationScreen()
  setupSymptomAboutWhoScreen()
  setupIncidentScreen()
  setupReplyScreen()
  setupReferenceScreen()

  refreshQueueStatus()
  // No location request here. `init` used to call `requestUserLocation()`, which
  // popped a browser permission dialog the moment the app opened — before the
  // health worker had tapped anything, and on a screen that might not even be
  // the location step. The phone is asked when someone asks for it.
  renderStepProgress()
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

/**
 * Ask the phone where it is, and report what came back either way.
 *
 * `Auto-detect` used to call this and store nothing. No coordinates, no
 * spinner, no permission prompt, no error — a button press that produced no
 * observable effect at all, so a first-time health worker could not tell whether
 * the browser was asking, working, or refusing (CW-16). It also ran on page load
 * with no UI attached, which is a permission request nobody asked for.
 *
 * Now every attempt reports into a status line, says which of the four possible
 * failures it hit, and leaves `userLocation` null when it failed. It is not
 * called on load: the phone is asked when someone asks.
 *
 * @param {(state: 'pending'|'ok'|'error', detail?: object) => void} [onState]
 * @returns {Promise<object|null>} the fix, or null if there is none.
 */
function requestUserLocation(onState = () => {}) {
  if (!navigator.geolocation) {
    // Absence of the API is a different fact from a refused permission, and a
    // caller may want to tell them apart.
    userLocationError = 'geolocation_not_supported'
    userLocation = null
    onState('error', { reason: userLocationError })
    return Promise.resolve(null)
  }

  if (geoRequest) return geoRequest

  onState('pending')
  geoRequest = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude
        const lon = position.coords.longitude
        // A device can report (0, 0) as a successful fix. It is in the Gulf of
        // Guinea, not at the household, and a report carrying it joins to every
        // spatial index as though it were real.
        if (lat === 0 && lon === 0) {
          userLocation = null
          userLocationError = 'null_island'
          onState('error', { reason: userLocationError })
          resolve(null)
          return
        }
        userLocation = {
          latitude: lat,
          longitude: lon,
          source: 'gps',
          accuracy_m: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        }
        userLocationError = null
        onState('ok', { location: userLocation })
        resolve(userLocation)
      },
      (error) => {
        userLocation = null
        userLocationError = error?.code === 1
          ? 'permission_denied'
          : (error?.code === 3 ? 'timeout' : 'unavailable')
        onState('error', { reason: userLocationError })
        resolve(null)
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    )
  }).finally(() => { geoRequest = null })

  return geoRequest
}

/** "1.2864° S, 36.8172° E", to four decimals — about 11 m, finer than the fix. */
function formatCoordinate(value, positive, negative) {
  const hemisphere = value < 0 ? negative : positive
  return `${Math.abs(value).toFixed(4)}° ${hemisphere}`
}

/**
 * Everything the app knows about where this report is, said plainly.
 *
 * The old `Here` button wrote `{latitude: null, longitude: null, source:
 * 'reported_here'}`: a location field that named a location. Outbreak triage
 * and any "facilities near this report" join cannot distinguish that from a
 * coordinate, so a CHW with a dead GPS who tapped `Here` filed a report that
 * looked located and was not — and the interface gave them no way to say so.
 *
 * `Here` now means exactly what it can mean: this phone's own fix, if it has
 * one. If it does not, `Here` says the phone has no fix and offers the manual
 * picker, which is the only control here that produces a real coordinate.
 */
function describeLocation(location) {
  if (!location) return 'No location is recorded with this report.'
  if (location.source === 'manual') {
    return `Location typed in: ${formatCoordinate(location.latitude, 'N', 'S')}, ${formatCoordinate(location.longitude, 'E', 'W')}.`
  }
  const accuracy = Number.isFinite(location.accuracy_m)
    ? ` (accurate to about ${Math.round(location.accuracy_m)} m)`
    : ''
  return `This phone's location: ${formatCoordinate(location.latitude, 'N', 'S')}, ${formatCoordinate(location.longitude, 'E', 'W')}${accuracy}.`
}

function renderLocationStatus(statusId, locationState, detail = {}) {
  const el = $(statusId)
  if (!el) return
  el.hidden = false

  if (locationState === 'pending') {
    el.dataset.state = 'pending'
    el.textContent = 'Asking this phone for a location fix…'
    return
  }

  if (locationState === 'ok') {
    el.dataset.state = 'ok'
    el.textContent = describeLocation(detail.location)
    return
  }

  const reason = GEO_FAILURES[detail.reason]
    || 'This phone could not get a location fix.'
  el.dataset.state = 'error'
  el.textContent = reason
}

/**
 * Move to another wizard screen.
 *
 * This used to toggle a class and stop. A screen-reader user pressing "Next"
 * heard nothing and focus stayed on the button they had just hidden, so the
 * next thing they reached was the top of the document rather than the new
 * screen. Focus now moves to the new screen's heading and the change is
 * announced.
 *
 * The announcement carries the step number as well as the heading. "Which
 * symptom?" confirms arrival; "Step 2 of 5. Which symptom?" confirms arrival
 * *and* position, which is the whole of HX-09 — the wizard previously announced
 * the same four-word title four times and never said how far in it was.
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

  const stepIndex = SYMPTOM_STEPS.findIndex((s) => s.screen === name) + 1
  const prefix = stepIndex > 0 ? `Step ${stepIndex} of ${TOTAL_STEPS}. ` : ''

  const announcer = $('screenAnnouncer')
  if (announcer && heading) {
    // Re-set to the same text does not re-announce; clear first.
    announcer.textContent = ''
    requestAnimationFrame(() => { announcer.textContent = prefix + heading.textContent.trim() })
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
  // `what` travels with the record so the queue list can name it. A row reading
  // only "POST /api/v1/chw/report, queued 4 days ago" tells a health worker
  // nothing about which of their reports it is.
  const result = await window.lindelaQueue.enqueue(path, options, { what })
  if (!result?.queued) throw new Error('the offline queue did not confirm the report')
  // "Saved on this phone. It will send when you have signal." — now literally
  // true, because the record is written before this line is reached. It was
  // shown on a path where nothing had been written.
  showToast(t('chw.report_queued', { what }), 'info')
  return result
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

/**
 * Whether this device can deliver a queued report with the app closed.
 *
 * Worth saying out loud, because the promise the queue makes — "it will send
 * when you have signal" — means two different things depending on what is
 * installed. In a browser the report waits for the app to be opened; in the
 * native shell the OS scheduler drains it. A worker who files a report and puts
 * the phone in a pocket should be able to know which one they have, and so should
 * the person reading over their shoulder.
 *
 * Silent when there is no shell: the browser is the normal case and the line
 * would be noise on every load.
 */
async function renderDeliveryMode() {
  const el = $('deliveryMode')
  if (!el) return
  const native = await import('/shared/native.js').catch(() => null)
  if (!native?.isNative()) { el.hidden = true; return }
  const caps = native.capabilities()
  el.hidden = false
  el.textContent = caps.backgroundSync
    ? 'This app delivers queued reports with the app closed.'
    : 'Queued reports send the next time you open the app.'
  // Ask once per load: the OS may decline a duplicate request, and the page
  // polls anyway, so this is an optimisation rather than the mechanism.
  if (caps.backgroundSync) native.prepareForBackgroundDelivery().catch(() => {})
}

renderDeliveryMode()
window.addEventListener('lindela-queue-flushed', () => { refreshQueueStatus() })

/**
 * One sentence for a report or reply that did not reach the server.
 *
 * All three submission paths used to render `error.message` into the toast:
 * "Could not save: Failed to fetch. Nothing was lost — try again." A health
 * worker holding a phone in a place with two bars of signal is told the word
 * "fetch", which is a name for something happening in software and not for
 * something happening to their report. The machine text goes to the console,
 * where it is worth something; the sentence is a sentence.
 *
 * The same three events also used to fail in three different shapes. They are
 * now one template from /shared/states.js, so it can be grepped and learned.
 */
function reportSendFailure(error, what) {
  console.error(`chw: ${what} not sent`, error)
  // The shared template always produces a sentence; the catalogue supplies a
  // translated one where this locale has it. `t` echoes the key back when it
  // does not, and a health worker must never be shown `chw.save_failed`.
  // The next step has to match what actually happened, and reaching here means
  // it did NOT get queued.
  //
  // `submitOrQueue` queues on failure, so this catch fires only when there was
  // no queue to write to — private browsing, storage exhausted, a blocked
  // upgrade. The previous sentence here promised the report "will wait on this
  // phone until there is one", which in exactly this case was false: nothing had
  // been written anywhere.
  const fallback = describeActionFailure({
    action: `send the ${what}`,
    nextStep: 'It was NOT saved on this phone, so you will need to enter it again. '
      + 'The details are still on screen — copy them somewhere safe before leaving this screen.',
  })
  const sentence = `${fallback.title}. ${fallback.body}`
  const translated = t('chw.save_failed', { what })
  showToast(!translated || translated === 'chw.save_failed' ? sentence : translated, 'error')
}

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
    // The screen opens first and the card fills itself in front of the worker.
    // It used to await the fetch before showing anything, so on a slow link the
    // tap did nothing at all for the length of a round trip — the working state
    // it now renders was being written to a hidden element.
    showScreen('reply')
    await loadLastAlert()
  })
}

function setupSymptomScreen() {
  document.querySelectorAll('[data-symptom-who]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('[data-symptom-who]').forEach((b) => b.classList.remove('selected'))
      e.target.classList.add('selected')
      state.symptom.who = e.target.dataset.symptomWho
      setHint('symptomWhoHint')
    })
  })

  $('symptomNextBtn').addEventListener('click', () => {
    // Blocked, and it says why. The button used to return silently, so the only
    // feedback a health worker got for tapping Next twice was a progress dot
    // that did not move — indistinguishable from a frozen app (CW-14).
    if (!state.symptom.who) {
      setHint('symptomWhoHint', HINTS.symptom, 'warn')
      return
    }
    showScreen('symptomType')
  })
  $('symptomBackBtn').addEventListener('click', () => showScreen('home'))
}

function setupSymptomSeverityScreen() {
  $('severityNextBtn').addEventListener('click', () => showScreen('symptomExposure'))
  $('severityBackBtn').addEventListener('click', () => showScreen('symptomType'))
  document.querySelectorAll('#severityChecklist input[type="checkbox"]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const selected = Array.from(document.querySelectorAll('#severityChecklist input:checked')).map(c => c.dataset.severity)
      state.symptom.severity = { dangerSigns: selected, verySleepy: selected.includes('sleepy'), breathing: selected.includes('breathing'), drinking: selected.includes('drinking'), bleeding: selected.includes('bleeding'), other: selected.includes('other'), otherText: $('severityOtherText')?.value?.trim() || null }
      const otherGroup = $('severityOtherGroup')
      if (otherGroup) otherGroup.style.display = selected.includes('other') ? 'block' : 'none'
      if (selected.includes('other')) $('severityOtherText')?.focus()
      setHint('severityHint')
    })
  })
}

function setupSymptomExposureScreen() {
  $('exposureNextBtn').addEventListener('click', () => {
    if ($('exposeContactSick').value === '' && $('exposeContactDead').value === '' && $('exposeVaccination').value === '' && $('exposeWater').value === '') {
      setHint('exposureHint', 'Select at least the water source before continuing.', 'warn')
      return
    }
    state.symptom.exposure = { contactSick: $('exposeContactSick').value || null, contactDead: $('exposeContactDead').value || null, vaccinationStatus: $('exposeVaccination').value || null, waterSource: $('exposeWater').value || 'clean', otherExposure: null }
    showScreen('symptomDuration')
  })
  $('exposureBackBtn').addEventListener('click', () => showScreen('symptomSeverity'))
}

function setupSymptomTypeScreen() {
  document.querySelectorAll('[data-symptom-type]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('[data-symptom-type]').forEach((b) => b.classList.remove('selected'))
      e.target.classList.add('selected')
      state.symptom.type = e.target.dataset.symptomType
      setHint('symptomTypeHint')
    })
  })

  $('symptomTypeNextBtn').addEventListener('click', () => {
    if (!state.symptom.type) {
      setHint('symptomTypeHint', HINTS.symptomType, 'warn')
      return
    }
    showScreen('symptomSeverity')
  })
  $('symptomTypeBackBtn').addEventListener('click', () => showScreen('symptom'))
}

/**
 * Duration as a number and a unit, rather than a unit alone.
 *
 * The step used to offer `Hours` / `Days` and store whichever was tapped, so
 * the queued payload read `"self with fever for days"` — a value that carries
 * no information at all. A two-day fever and a twenty-day fever produced the
 * same record, and outbreak triage thresholds are duration-sensitive (CW-12).
 *
 * The count is now `state.symptom.durationValue` and the unit is
 * `state.symptom.durationUnit`; both are submitted as fields.
 */
function setupSymptomDurationScreen() {
  const valueInput = $('durationValue')

  const readValue = () => {
    const raw = valueInput.value.trim()
    const value = Number(raw)
    if (raw === '' || !Number.isFinite(value) || value <= 0) return null
    return Math.round(value)
  }

  document.querySelectorAll('[data-symptom-duration]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('[data-symptom-duration]').forEach((b) => b.classList.remove('selected'))
      e.target.classList.add('selected')
      state.symptom.durationUnit = e.target.dataset.symptomDuration
      setHint('symptomDurationHint')
    })
  })

  valueInput.addEventListener('input', () => { setHint('symptomDurationHint') })

  $('symptomDurationNextBtn').addEventListener('click', () => {
    const value = readValue()
    if (value === null) {
      setHint('symptomDurationHint', HINTS.symptomDuration, 'warn')
      valueInput.focus()
      return
    }
    state.symptom.durationValue = value
    showScreen('symptomLocation')
  })
  $('symptomDurationBackBtn').addEventListener('click', () => showScreen('symptomExposure'))
}

/**
 * Read the manual picker, refusing what would be a lie.
 *
 * ±90 / ±180 is the hard bound on the planet. (0, 0) is not rejected for being
 * out of bounds — it is in bounds, in the Gulf of Guinea — but a field report
 * carrying it looks located to every downstream join while pointing at open
 * water, which is the specific failure the server already guards against and
 * which a typed-in coordinate would walk straight back into.
 */
function readManualLocation(latId, lonId, hintId) {
  const lat = Number($(latId).value.trim())
  const lon = Number($(lonId).value.trim())
  const empty = $(latId).value.trim() === '' || $(lonId).value.trim() === ''

  if (empty || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    setHint(hintId, HINTS.manualLocation, 'warn')
    return null
  }
  if (lat < -90 || lat > 90) {
    setHint(hintId, 'Latitude must be between -90 and 90.', 'error')
    return null
  }
  if (lon < -180 || lon > 180) {
    setHint(hintId, 'Longitude must be between -180 and 180.', 'error')
    return null
  }
  if (lat === 0 && lon === 0) {
    setHint(hintId, '0°, 0° is open ocean, not a household. Check the two numbers.', 'error')
    return null
  }
  setHint(hintId)
  return { latitude: lat, longitude: lon, source: 'manual' }
}

function setupSymptomLocationScreen() {
  $('autoLocationBtn').addEventListener('click', async () => {
    // Now says what it is doing, and what came back. A button that produces no
    // observable effect cannot be told apart from one that failed (CW-05, CW-16).
    const fix = await requestUserLocation((status, detail) => {
      renderLocationStatus('locationStatus', status, detail)
      if (status === 'error') setHint('symptomLocationHint', 'Enter the location below, or continue without one.', 'warn')
    })
    state.symptom.location = fix ? { ...fix } : null
  })

  $('hereLocationBtn').addEventListener('click', async () => {
    // "Here" used to write `{latitude: null, longitude: null, source:
    // 'reported_here'}` — a location that named a location. It cannot mean
    // anything else without a fix, so when this phone has one it is used, and
    // when it does not the app says so and offers the picker rather than
    // asserting a place it never recorded.
    const fix = userLocation ?? await requestUserLocation((status, detail) => {
      renderLocationStatus('locationStatus', status, detail)
    })
    if (fix) {
      state.symptom.location = { ...fix }
      renderLocationStatus('locationStatus', 'ok', { location: fix })
      setHint('symptomLocationHint')
      return
    }
    renderLocationStatus('locationStatus', 'error', { reason: userLocationError })
    state.symptom.location = null
    setHint('symptomLocationHint', 'No fix on this phone. Enter the location below, or continue without one.', 'warn')
    $('manualLat')?.focus()
  })

  $('useManualLocationBtn').addEventListener('click', () => {
    const location = readManualLocation('manualLat', 'manualLon', 'manualLocationHint')
    if (!location) return
    state.symptom.location = location
    renderLocationStatus('locationStatus', 'ok', { location })
    setHint('symptomLocationHint')
  })

  $('symptomLocationNextBtn').addEventListener('click', () => {
    if (!state.symptom.location) {
      // Still allowed to continue — an unlocated outbreak report is worth more
      // than no report — but the record now says so in a way a reader can act
      // on, rather than claiming the health worker said "here".
      state.symptom.location = { latitude: null, longitude: null, source: 'not_answered' }
      renderLocationStatus('locationStatus', 'error', { reason: 'not_answered' })
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
  const unit = state.symptom.durationUnit || 'days'
  const count = state.symptom.durationValue
  const body = {
    kind: 'symptom',
    category: state.symptom.type,
    description: `${state.symptom.who} with ${state.symptom.type} for ${count} ${unit}`,
    // Duration as fields, not only as a sentence. `duration_days` and
    // `duration_hours` are what a triage query can filter on; the description
    // is what a person reads. A 2-day fever and a 20-day fever have to be
    // separable, and prose alone does not separate them.
    duration_days: unit === 'days' ? count : undefined,
    duration_hours: unit === 'hours' ? count : undefined,
    duration_unit: unit,
    duration_value: count,
    location: state.symptom.location,
    anonymous: state.anonymous,
    demographics: state.symptom.demographics || undefined,
    severity: state.symptom.severity ? { ...state.symptom.severity, otherText: (state.symptom.severity.other && $('severityOtherText')) ? $('severityOtherText').value?.trim() || null : null } : undefined,
    exposure: state.symptom.exposure || undefined,
  }

  try {
    const sent = await submitOrQueue('/api/v1/chw/report', body, { what: 'symptom report' })
    showToast(
      t(sent?.queued ? 'chw.report_queued' : 'chw.report_sent', { what: 'symptom report' }),
      sent?.queued ? 'info' : 'ok',
    )
    resetSymptomWizard()
    showScreen('home')
    refreshQueueStatus()
  } catch (error) {
    reportSendFailure(error, 'symptom report')
  }
}

/**
 * Return the wizard to a state a second report can start from.
 *
 * This used to be an inline object literal that cleared four fields and left
 * the rest — the duration count, the unit, the manual coordinates, the status
 * line — holding the previous report's values. The next report then inherited
 * them, and the location screen opened showing coordinates that belonged to
 * someone else.
 */
function resetSymptomWizard() {
  state.symptom = {
    who: null,
    type: null,
    duration: null,
    durationUnit: 'days',
    durationValue: null,
    location: null,
    severity: { dangerSigns: [], verySleepy: null, breathing: null, drinking: null, bleeding: null, other: null },
    exposure: { contactSick: null, contactDead: null, vaccinationStatus: null, waterSource: 'clean', otherExposure: null },
  }
  document.querySelectorAll('[data-symptom-who].selected, [data-symptom-type].selected').forEach((el) => {
    el.classList.remove('selected')
  })
  document.querySelectorAll('[data-symptom-duration]').forEach((el) => {
    el.classList.toggle('selected', el.dataset.symptomDuration === 'days')
  })
  const valueInput = $('durationValue')
  if (valueInput) valueInput.value = ''
  for (const id of ['manualLat', 'manualLon']) {
    if ($(id)) $(id).value = ''
  }
  document.querySelectorAll('#severityChecklist input[type="checkbox"]').forEach(chk => { chk.checked = false })
  const exposeFields = ['exposeContactSick', 'exposeContactDead', 'exposeVaccination', 'exposeWater']
  for (const id of exposeFields) {
    const el = $(id)
    if (el) el.value = id === 'exposeWater' ? 'clean' : ''
  }
  for (const id of ['symptomWhoHint', 'symptomTypeHint', 'symptomDurationHint', 'symptomLocationHint', 'manualLocationHint']) {
    setHint(id)
  }
  const status = $('locationStatus')
  if (status) {
    status.hidden = true
    status.textContent = ''
    status.dataset.state = 'none'
  }
}

function setupIncidentScreen() {
  const categorySelect = $('incidentCategory')
  const locationBtns = document.querySelectorAll('[data-incident-location]')

  // Same two controls, same defect, on the other report path. `Here` here wrote
  // the same `{latitude: null, longitude: null, source: 'reported_here'}`, and
  // a flood report is the case this product most needs placed on a map.
  //
  // `Auto-detect` and `Here` are now the same action with a different first
  // question: `Auto-detect` always asks the phone, `Here` reuses a fix it
  // already has before asking again. Both end at the same honest place — a
  // coordinate, or a stated reason there is none.
  locationBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const alreadyKnown = btn.dataset.incidentLocation !== 'auto' && userLocation
      const fix = alreadyKnown ?? await requestUserLocation((status, detail) => {
        renderLocationStatus('incidentLocationStatus', status, detail)
      })

      if (fix) {
        state.incident.location = { ...fix }
        renderLocationStatus('incidentLocationStatus', 'ok', { location: fix })
        return
      }
      state.incident.location = null
      renderLocationStatus('incidentLocationStatus', 'error', { reason: userLocationError })
    })
  })

  $('useIncidentManualLocationBtn').addEventListener('click', () => {
    const location = readManualLocation('incidentManualLat', 'incidentManualLon', 'incidentManualLocationHint')
    if (!location) return
    state.incident.location = location
    renderLocationStatus('incidentLocationStatus', 'ok', { location })
  })

  $('incidentSubmitBtn').addEventListener('click', async () => {
    if (!categorySelect.value) {
      showToast('Choose a category before submitting.', 'error')
      return
    }
    const desc = $('incidentDescription').value
    const photo = $('incidentPhoto').files[0]

    const body = {
      kind: 'incident',
      category: categorySelect.value,
      description: desc,
      // Null coordinates with a stated source, or nothing at all. Never a
      // `reported_here` that names a place the report does not have.
      location: state.incident.location
        ?? { latitude: null, longitude: null, source: 'not_answered' },
      anonymous: state.anonymous,
    }

    try {
      const sent = await submitOrQueue('/api/v1/chw/report', body, { what: 'incident report' })
      showToast(
        t(sent?.queued ? 'chw.report_queued' : 'chw.report_sent', { what: 'incident report' }),
        sent?.queued ? 'info' : 'ok',
      )
      categorySelect.value = ''
      $('incidentDescription').value = ''
      $('incidentPhoto').value = ''
      for (const id of ['incidentManualLat', 'incidentManualLon']) {
        if ($(id)) $(id).value = ''
      }
      setHint('incidentManualLocationHint')
      const status = $('incidentLocationStatus')
      if (status) {
        status.hidden = true
        status.dataset.state = 'none'
      }
      state.incident = { category: null, description: null, location: null }
      showScreen('home')
      refreshQueueStatus()
    } catch (error) {
      reportSendFailure(error, 'incident report')
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

  // The working state, written by the request that is running rather than left
  // behind in the HTML. "Loading alert..." used to be static markup, so it was
  // on screen before anything had been asked for, and it stayed on screen if the
  // request died without ever reaching this function again. A word that means
  // "working" and is not driven by the working is the same defect as a spinner
  // that outlives its request.
  const token = alertLoads.start()
  const working = describeState(LOADING, { noun: 'the latest alert' })
  text.dataset.state = LOADING
  text.textContent = `${working.title} ${working.body}`

  let res = null
  let error = null
  try {
    res = await apiFetch('/api/v1/rapidpro/inbound?limit=5')
  } catch (err) {
    error = err
  }

  // A second tap on "Reply" supersedes the first; its response must not paint
  // over the card the second one is already loading.
  if (!alertLoads.isCurrent(token)) return

  const stateName = distinguishFailure({
    ok: !error,
    error,
    isEmpty: !res?.data?.length,
  })

  // Settled on both paths. The working state above has a single exit.
  alertLoads.settle(token)

  // A cached answer is not a live one. The worker arrives here with the alerts
  // the service worker still holds, `distinguishFailure` calls that a success,
  // and a health worker reads a day-old list as this morning's. The banner says
  // so above the list rather than blanking it.
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

  // A response the service worker answered from its cache is not a live answer,
  // and `distinguishFailure` cannot see the difference — a successful response
  // looks like a successful response. So a cached read renders the alert *and*
  // says it may be out of date, above it, with the same retry the error path
  // offers. The alert is still worth reading on a phone with no signal; it is
  // not worth acting on blind.
  const stale = staleReadNote(res)
  if (stale) {
    text.dataset.state = 'stale'
    text.dataset.alertStale = '1'
    text.innerHTML = `<p class="stale-note"><strong>${escapeHtml(stale.title)}</strong> ${escapeHtml(stale.body)}</p>`
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'retry-btn'
    btn.textContent = stale.action || 'Try again'
    btn.addEventListener('click', () => loadLastAlert())
    text.appendChild(btn)
  } else {
    delete text.dataset.alertStale
  }

  if (stateName === 'empty') {
    const copy = describeState('empty', { noun: 'alerts' })
    text.dataset.state = 'empty'
    if (!stale) text.textContent = copy.body
    else text.appendChild(document.createTextNode(` ${copy.body}`))
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

    // The reply is the only submission here whose button stays reachable for
    // the duration of the request, and the only one with a message field the
    // worker would have to retype. Disabled while it is in flight, restored on
    // both outcomes.
    const replyBtn = $('replySubmitBtn')
    replyBtn.disabled = true
    try {
      const sent = await submitOrQueue(
        '/api/v1/chw/reply',
        { alert_event_id: alertId, message },
        { what: 'reply' },
      )
      showToast(
        sent?.queued ? t('chw.report_queued', { what: 'reply' }) : t('chw.reply_sent'),
        sent?.queued ? 'info' : 'ok',
      )
      $('replyMessage').value = ''
      showScreen('home')
      refreshQueueStatus()
    } catch (error) {
      reportSendFailure(error, 'reply')
    } finally {
      replyBtn.disabled = false
    }
  })

  $('replyBackBtn').addEventListener('click', () => showScreen('home'))
}

/** Symptom-to-disease mapping — 20 high-risk ailments, embedded offline.
 *  Each entry links symptoms (from the wizard) to a named disease.
 */
const DISEASE_MAP = [
  { name: 'Cholera', symptoms: 'fever, diarrhea (watery, frequent)', danger: 'Rapid dehydration: sunken eyes, dry mouth, no urine. Refer urgently.', note: 'Water contamination. Give oral rehydration; do not delay referral.' },
  { name: 'Typhoid', symptoms: 'fever (prolonged), headache, diarrhea/constipation, weakness', danger: 'Very high prolonged fever with confusion or abdominal swelling. Bleeding serious.', note: 'Clean water and cooked food prevent spread. Over 7 days is serious.' },
  { name: 'Malaria', symptoms: 'fever (often cyclical), headache, chills, weakness', danger: 'Very high fever, confusion, very sleepy, difficulty breathing, yellow eyes.', note: 'Rapid test if available; treat quickly. Record cycle pattern.' },
  { name: 'Measles', symptoms: 'rash (face then body), fever, cough, red eyes, runny nose', danger: 'Rash does NOT fade under glass, very sleepy, difficulty breathing.', note: 'Highly contagious. Isolate; report immediately. Vaccine-preventable.' },
  { name: 'Pneumonia', symptoms: 'cough, fast or difficult breathing, chest pain, fever', danger: 'Fast breathing, chest pulling in, blue lips/nails, very sleepy.', note: 'A leading child killer. Count breaths; refer if fast or labored.' },
  { name: 'Meningitis', symptoms: 'fever, severe headache, stiff neck, very sleepy, confusion, rash', danger: 'Stiff neck, confusion, non-blanching rash, very sleepy or hard to wake.', note: 'Medical emergency. Do not wait. Isolate; report through incident screen.' },
  { name: 'Tuberculosis', symptoms: 'cough over 2 weeks, fever, weight loss, night sweats, blood in sputum', danger: 'Blood in sputum, severe weakness, rapid weight loss, very sleepy.', note: 'Airborne. Long treatment. Report for tracking and support.' },
  { name: 'Dengue', symptoms: 'fever, severe headache, eye pain, rash, bleeding from gums/nose', danger: 'Severe abdominal pain, bleeding, very sleepy, cold clammy skin.', note: 'Keep hydrated. Watch bleeding signs. No specific medicine.' },
  { name: 'Yellow fever', symptoms: 'fever, headache, muscle pain, yellow eyes/skin, bleeding', danger: 'Yellow eyes/skin with bleeding or confusion — urgent.', note: 'Vaccine-preventable. Report immediately; outbreak risk high.' },
  { name: 'Leptospirosis', symptoms: 'fever, headache, muscle pain, red eyes, sometimes jaundice', danger: 'Yellow eyes, very little urine, bleeding, severe weakness.', note: 'Contaminated water. Wear boots; avoid standing water.' },
  { name: 'Hepatitis A / E', symptoms: 'fever, yellow eyes/skin, dark urine, nausea, tiredness', danger: 'Deep yellow eyes/skin with confusion or bleeding.', note: 'Fecal-oral spread. Clean water and handwashing prevent.' },
  { name: 'Tetanus', symptoms: 'stiff jaw and neck, painful spasms, difficulty swallowing', danger: 'Spasms spreading, difficulty breathing, locked jaw.', note: 'Often from unclean wounds. Clean wound; seek care. Vaccine-preventable.' },
  { name: 'Diphtheria', symptoms: 'fever, sore throat with thick gray membrane, difficulty swallowing', danger: 'Thick gray membrane blocking throat, very high fever, very sleepy.', note: 'Airborne. Report immediately. Vaccination is protection.' },
  { name: 'Pertussis (whooping cough)', symptoms: 'cough lasting weeks, whooping breath in, vomiting after cough', danger: 'Difficulty breathing, very sleepy (infants), blue lips.', note: 'Highly contagious. Protect infants; report clusters.' },
  { name: 'Plague (bubonic)', symptoms: 'fever, painful swollen lymph nodes (buboes), weakness', danger: 'Swollen nodes spreading, very high fever, confusion, bleeding under skin.', note: 'Flea-borne; airborne in lung form. Report immediately; isolation critical.' },
  { name: 'Rabies', symptoms: 'fever, anxiety, difficulty swallowing, excessive saliva', danger: 'Difficulty swallowing, confusion, paralysis, fear of water or air.', note: 'Always fatal once symptoms appear. Any bite must be treated before symptoms. Report bites.' },
  { name: 'Severe acute malnutrition', symptoms: 'very thin, visible ribs, swollen feet/legs, very weak, very sleepy', danger: 'Swollen feet with very thin body; very weak; not feeding; very sleepy.', note: 'Measure upper arm. Refer urgently. Food plus medical care together.' },
  { name: 'Schistosomiasis', symptoms: 'blood in urine, painful urination, abdominal pain, sometimes blood in stool', danger: 'Very little urine, continuous blood, severe abdominal swelling.', note: 'Water contact disease. Treat early; avoid contaminated freshwater.' },
  { name: 'Onchocerciasis (river blindness)', symptoms: 'severe itching, skin changes, eye pain, vision loss over time', danger: 'Rapid vision loss, severe eye pain, very swollen skin.', note: 'Blackfly-borne. Report vision changes. Mass treatment exists.' },
  { name: 'Dracunculiasis (Guinea worm)', symptoms: 'painful blister on leg/foot, worm emerging slowly', danger: 'Worm breaking inside body, severe infection around site.', note: 'Pull slowly (do not break); clean with chlorine; filter water; report any case — near elimination.' },
]

/** Offline-cached symptom reference — the "dramatically inform" addition.
 *  Each card carries danger signs (when to refer urgently), home care, and a
 *  duration note so the worker knows whether a 2-day and a 20-day fever are
 *  the same report or different ones. No network needed: the data is baked
 *  into the module, not fetched.
 */
const SYMPTOM_GUIDE = [
  {
    id: 'fever', title: 'Fever', keywords: 'fever, hot, temperature',
    body: 'Fever is the body fighting infection. Most improve in 2–3 days. Refer urgently if: very high or lasts more than 3 days, stiff neck, severe headache, confusion, rash that does not fade when pressed, not drinking, very sleepy, difficulty breathing, or the person is under 2 months old.',
    danger: 'Refer urgently: very high temperature over 3 days, stiff neck, severe headache, confusion, non-blanching rash, very sleepy or hard to wake, not drinking, difficulty breathing, under 2 months.',
    care: 'Keep hydrated with small frequent sips. Rest. Use a cool cloth. Seek care for danger signs above.',
    durationNote: 'The wizard records duration in days or hours. A 2-day fever and a 20-day fever are different reports; both need to be filed.',
  },
  {
    id: 'cough', title: 'Cough', keywords: 'cough, chest, breathing',
    body: 'A cough can be a cold, pneumonia, or asthma. Refer urgently if: fast or difficult breathing, chest pulling in under ribs, blue lips or nails, very sleepy, not feeding (child), blood in sputum, or lasts more than 2 weeks.',
    danger: 'Refer urgently: fast or difficult breathing, chest indrawing, blue lips/nails, very sleepy, not feeding, blood in sputum, over 2 weeks.',
    care: 'Keep warm, give warm fluids, rest. Seek care for any danger sign above.',
    durationNote: 'Cough duration matters: a new cough is usually different from one lasting weeks.',
  },
  {
    id: 'diarrhea', title: 'Diarrhea', keywords: 'diarrhea, loose stool, watery',
    body: 'Loose watery stools more than 3 times in a day. Refer urgently if: very watery with sunken eyes, very dry mouth, no tears when crying, not passing urine, blood in stool, very sleepy or weak.',
    danger: 'Refer urgently: sunken eyes, very dry mouth, no tears, no urine, blood in stool, very sleepy, very weak.',
    care: 'Keep giving small frequent sips of clean water or oral rehydration. Wash hands. Seek care for danger signs.',
    durationNote: 'Record how long the loose stools have lasted; duration helps identify outbreaks.',
  },
  {
    id: 'rash', title: 'Rash', keywords: 'rash, spots, skin',
    body: 'A new rash with fever may signal measles, chickenpox, or another outbreak. Refer urgently if: the rash does not fade when pressed (glass test negative, i.e. does NOT blanch), very high fever, very sleepy, confusion, or difficulty swallowing.',
    danger: 'Refer urgently: rash that does NOT fade under glass, very high fever, very sleepy, confusion, difficulty swallowing.',
    care: 'Keep cool, avoid scratching, give fluids. Seek care immediately for any danger sign.',
    durationNote: 'Note when the rash first appeared; outbreak tracking depends on timing.',
  },
  {
    id: 'ebola_precursor', title: 'Ebola / hemorrhagic precursors', keywords: 'ebola, hemorrhagic, bleeding, precursor, unexplained bleeding',
    body: 'Ebola and related viral hemorrhagic fevers begin with sudden fever, extreme weakness, headache, sore throat, muscle pain, vomiting, or diarrhea. Unexplained bleeding (gums, nose, blood in stool, bruising that appears without injury) is the defining precursor. It spreads by direct contact with blood or body fluids of a sick or dead person.',
    danger: 'Refer urgently and isolate: sudden fever with unexplained bleeding from gums/nose/stool/eyes; blood-tinged vomit or diarrhea; severe weakness with inability to stand; any bleeding without injury; or close contact with someone who died of a bleeding illness.',
    care: 'Keep the person separated from others. Do not touch blood or body fluids without gloves. Use chlorine solution (0.5%) to clean surfaces. Report immediately through the incident screen — do not wait. Keep small sips of clean water available only if the person can swallow safely.',
    durationNote: 'Record onset precisely: the first day of symptoms and the first sign of any bleeding. This is outbreak-critical.',
  },
  {
    id: 'other', title: 'Other symptoms', keywords: 'other, unknown',
    body: 'Not every serious condition is a common symptom. If the person is very unwell but does not match the common patterns above, file it anyway. Describe clearly. Refer urgently for: sudden collapse, severe pain, difficulty swallowing, bleeding that will not stop.',
    danger: 'Refer urgently: sudden collapse, severe unexplained pain, difficulty swallowing, bleeding that will not stop, or any rapid worsening.',
    care: 'Describe the symptom clearly when filing. Keep the person comfortable and seek help for any danger sign.',
    durationNote: 'Always record how long the symptom has been present.',
  },
]

function setupReferenceScreen() {
  $('referenceBtn').addEventListener('click', () => {
    state.currentScreen = 'reference'
    showScreen('reference')
    renderReferenceCards()
  })
  $('referenceBackBtn').addEventListener('click', () => showScreen('home'))

  $('referenceSearch')?.addEventListener('input', (e) => {
    renderReferenceCards(e.target.value.trim().toLowerCase())
  })
}

function renderReferenceCards(query = '') {
  const list = $('referenceList')
  if (!list) return
  list.innerHTML = ''
  const cards = SYMPTOM_GUIDE.filter((g) => {
    if (!query) return true
    const q = query
    return g.title.toLowerCase().includes(q) || g.keywords.toLowerCase().includes(q)
      || g.danger.toLowerCase().includes(q) || g.care.toLowerCase().includes(q) || g.durationNote.toLowerCase().includes(q)
  })
  if (!cards.length) {
    list.innerHTML = `<p style="font-size:0.875rem;color:var(--ink-muted);padding:0.5rem">No match for "${escapeHtml(query)}". Try "fever", "danger", or "refer".</p>`
    return
  }
  // Disease mapping layer: for each symptom card, show diseases that match
  // its keywords (symptom-to-disease mapping). Diseases are also searchable.
  const matchDiseases = (symptomId) => {
    const sym = SYMPTOM_GUIDE.find(s => s.id === symptomId)
    if (!sym) return []
    return DISEASE_MAP.filter(d => d.symptoms.toLowerCase().includes(sym.title.toLowerCase()) || sym.keywords.split(', ').some(kw => d.symptoms.toLowerCase().includes(kw.trim())))
  }
  for (const item of cards) {
    const card = document.createElement('div')
    card.className = 'icon-button'
    card.style.alignItems = 'flex-start'
    card.style.justifyContent = 'flex-start'
    card.style.padding = '0.875rem'
    card.style.gap = '0.25rem'
    const diseases = matchDiseases(item.id)
    const diseaseLine = diseases.length ? `<p style="font-size:0.75rem;color:var(--brand);font-weight:600;margin-top:0.25rem">Related diseases: ${escapeHtml(diseases.map(d => d.name).join(', '))}</p>` : ''
    card.innerHTML = `<div style="font-weight:700;font-size:1rem;margin-bottom:0.25rem">${escapeHtml(item.title)}</div>`
      + `<p style="font-size:0.8125rem;color:var(--danger);font-weight:600;line-height:1.2">${escapeHtml(item.danger)}</p>`
      + `<p style="font-size:0.8125rem;color:var(--ink-muted);line-height:1.4;margin-top:0.25rem">${escapeHtml(item.care)}</p>`
      + `<p style="font-size:0.75rem;color:var(--ink-muted);margin-top:0.25rem;font-style:italic">${escapeHtml(item.durationNote)}</p>`
      + diseaseLine
    list.appendChild(card)
  }
  // If no symptom cards matched but diseases did, show disease cards too.
  const diseaseCards = DISEASE_MAP.filter(d => {
    if (!query) return false
    const q = query
    return d.name.toLowerCase().includes(q) || d.symptoms.toLowerCase().includes(q) || d.danger.toLowerCase().includes(q) || d.note.toLowerCase().includes(q)
  })
  if (!cards.length && diseaseCards.length > 0 && query.length > 0) {
    list.innerHTML += `<p style="font-size:0.875rem;color:var(--ink-muted);padding:0.5rem;margin-top:0.5rem;font-weight:600">— Disease references for "${escapeHtml(query)}" —</p>`
    for (const d of diseaseCards) {
      const card = document.createElement('div')
      card.className = 'icon-button'
      card.style.alignItems = 'flex-start'
      card.style.justifyContent = 'flex-start'
      card.style.padding = '0.875rem'
      card.style.gap = '0.25rem'
      card.innerHTML = `<div style="font-weight:700;font-size:1rem;margin-bottom:0.25rem">${escapeHtml(d.name)}</div>`
        + `<p style="font-size:0.8125rem;color:var(--danger);font-weight:600;line-height:1.2">Danger: ${escapeHtml(d.danger)}</p>`
        + `<p style="font-size:0.8125rem;color:var(--ink-muted);line-height:1.4;margin-top:0.25rem">Symptoms: ${escapeHtml(d.symptoms)}</p>`
        + `<p style="font-size:0.75rem;color:var(--ink-muted);margin-top:0.25rem;font-style:italic">${escapeHtml(d.note)}</p>`
      list.appendChild(card)
    }
  }
}

await init()
autoMarkScrollableRegions()

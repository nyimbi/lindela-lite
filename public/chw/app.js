import { initI18n, t, apiFetch, initOfflineBanner, initOfflineQueue } from '/shared/runtime.js'

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

let userLocation = { latitude: 0, longitude: 0 }

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
  setupIncidentScreen()
  setupReplyScreen()

  requestUserLocation()
}

function updateStatus() {
  if (navigator.onLine) {
    statusDot.classList.remove('offline')
    offlineBanner.classList.remove('show')
  } else {
    statusDot.classList.add('offline')
    offlineBanner.classList.add('show')
  }
}

async function requestUserLocation() {
  if (!navigator.geolocation) return
  navigator.geolocation.getCurrentPosition(
    (position) => {
      userLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }
    },
    () => {
      userLocation = { latitude: 0, longitude: 0 }
    }
  )
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'))
  const screen = $(`${name}Screen`)
  if (screen) screen.classList.add('active')
  state.currentScreen = name
}

function showToast(message) {
  toast.textContent = message
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 3000)
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
    state.symptom.location = userLocation
    submitSymptomReport()
  })
  $('hereLocationBtn').addEventListener('click', () => {
    state.symptom.location = { latitude: 0, longitude: 0 }
    submitSymptomReport()
  })
  $('symptomLocationBackBtn').addEventListener('click', () => showScreen('symptomDuration'))
}

async function submitSymptomReport() {
  const body = {
    kind: 'symptom',
    category: state.symptom.type,
    description: `${state.symptom.who} with ${state.symptom.type} for ${state.symptom.duration}`,
    location: state.symptom.location,
    anonymous: state.anonymous,
  }

  try {
    if (!navigator.onLine) {
      await window.lindelaQueue.enqueue('/api/v1/chw/report', { method: 'POST', body })
      showToast(t('chw.queued') || 'Queued')
    } else {
      const res = await apiFetch('/api/v1/chw/report', { method: 'POST', body })
      showToast(t('chw.sent') || 'Sent')
    }
    state.symptom = { who: null, type: null, duration: null, location: null }
    showScreen('home')
  } catch (error) {
    showToast(`Error: ${error.message}`)
  }
}

function setupIncidentScreen() {
  const categorySelect = $('incidentCategory')
  const locationBtns = document.querySelectorAll('[data-incident-location]')

  locationBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      state.incident.location = e.target.dataset.incidentLocation === 'auto' ? userLocation : { latitude: 0, longitude: 0 }
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
        await window.lindelaQueue.enqueue('/api/v1/chw/report', { method: 'POST', body })
        showToast(t('chw.queued') || 'Queued')
      } else {
        const res = await apiFetch('/api/v1/chw/report', { method: 'POST', body })
        showToast(t('chw.sent') || 'Sent')
      }
      categorySelect.value = ''
      $('incidentDescription').value = ''
      $('incidentPhoto').value = ''
      state.incident = { category: null, description: null, location: null }
      showScreen('home')
    } catch (error) {
      showToast(`Error: ${error.message}`)
    }
  })

  $('incidentBackBtn').addEventListener('click', () => showScreen('home'))
}

async function loadLastAlert() {
  try {
    const res = await apiFetch('/api/v1/rapidpro/inbound?limit=5')
    const messages = res.data || []
    if (messages.length > 0) {
      const msg = messages[0]
      $('alertText').textContent = msg.text || 'No recent alerts'
      $('alertText').dataset.alertId = msg.event_id || ''
    } else {
      $('alertText').textContent = 'No recent alerts'
    }
  } catch (error) {
    $('alertText').textContent = 'Could not load alert'
  }
}

function setupReplyScreen() {
  $('replySubmitBtn').addEventListener('click', async () => {
    const message = $('replyMessage').value
    const alertId = $('alertText').dataset.alertId

    if (!message) return

    try {
      if (!navigator.onLine) {
        await window.lindelaQueue.enqueue('/api/v1/chw/reply', {
          method: 'POST',
          body: { alert_event_id: alertId, message },
        })
        showToast(t('chw.queued') || 'Queued')
      } else {
        const res = await apiFetch('/api/v1/chw/reply', {
          method: 'POST',
          body: { alert_event_id: alertId, message },
        })
        showToast(t('chw.sent') || 'Sent')
      }
      $('replyMessage').value = ''
      showScreen('home')
    } catch (error) {
      showToast(`Error: ${error.message}`)
    }
  })

  $('replyBackBtn').addEventListener('click', () => showScreen('home'))
}

await init()

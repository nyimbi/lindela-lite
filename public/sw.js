const CACHE_NAME = 'lindela-lite-v1'
const APP_SHELL = ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/i18n/en.json']

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => {
			return cache.addAll(APP_SHELL).catch(() => {
				// Partial caching is ok; app shell may not all be available yet
				return Promise.resolve()
			})
		})
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((cacheNames) => {
			return Promise.all(
				cacheNames
					.filter((name) => name !== CACHE_NAME)
					.map((name) => caches.delete(name))
			)
		})
	)
})

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url)

	// Network-first for API calls with stale-while-revalidate fallback
	if (url.pathname.startsWith('/api/v1/') && event.request.method === 'GET') {
		event.respondWith(
			fetch(event.request)
				.then((response) => {
					if (response.ok) {
						caches.open(CACHE_NAME).then((cache) => {
							cache.put(event.request, response.clone())
						})
					}
					return response
				})
				.catch(() => {
					return caches.match(event.request).then((cached) => {
						return cached || new Response(JSON.stringify({ error: 'Offline' }), {
							status: 503,
							headers: { 'content-type': 'application/json' },
						})
					})
				})
		)
		return
	}

	// Cache-first for static assets
	event.respondWith(
		caches.match(event.request).then((cached) => {
			return cached || fetch(event.request).then((response) => {
				if (response.ok) {
					caches.open(CACHE_NAME).then((cache) => {
						cache.put(event.request, response.clone())
					})
				}
				return response
			})
		})
	)
})

self.addEventListener('sync', (event) => {
	if (event.tag === 'lindela-queue') {
		event.waitUntil(replayQueue())
	}
})

self.addEventListener('message', (event) => {
	if (event.data.type === 'queueRequest') {
		enqueueRequest(event.data.request)
	}
})

async function replayQueue() {
	const db = await openQueueDb()
	const tx = db.transaction('lindela-queue', 'readonly')
	const store = tx.objectStore('lindela-queue')
	const requests = await new Promise((resolve, reject) => {
		const req = store.getAll()
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})

	const succeeded = []
	for (const item of requests) {
		try {
			const response = await fetch(item.url, {
				method: item.method,
				headers: item.headers,
				body: item.body,
			})
			if (response.ok) succeeded.push(item.id)
		} catch {
			// Skip failures; retry next sync
		}
	}

	if (succeeded.length) {
		const deleteTx = db.transaction('lindela-queue', 'readwrite')
		const deleteStore = deleteTx.objectStore('lindela-queue')
		for (const id of succeeded) {
			deleteStore.delete(id)
		}
		await new Promise((resolve, reject) => {
			deleteTx.oncomplete = () => resolve()
			deleteTx.onerror = () => reject(deleteTx.error)
		})
	}
}

async function enqueueRequest(request) {
	const db = await openQueueDb()
	const tx = db.transaction('lindela-queue', 'readwrite')
	const store = tx.objectStore('lindela-queue')
	store.add({
		id: `${Date.now()}-${Math.random()}`,
		url: request.url,
		method: request.method,
		headers: request.headers || {},
		body: request.body,
	})
	await new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve()
		tx.onerror = () => reject(tx.error)
	})
}

function openQueueDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open('lindela-queue', 1)
		req.onupgradeneeded = (event) => {
			const db = event.target.result
			if (!db.objectStoreNames.contains('lindela-queue')) {
				db.createObjectStore('lindela-queue', { keyPath: 'id' })
			}
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
}

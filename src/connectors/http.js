export async function fetchWithRetry(url, { retries = 2, timeoutMs = 20000, parse = 'text' } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (parse === 'json') return response.json()
      return response.text()
    } catch (error) {
      lastError = error
      if (attempt < retries) await delay(150 * (2 ** attempt))
    }
  }
  throw lastError
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

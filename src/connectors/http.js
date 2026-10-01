export async function fetchWithRetry(url, { retries = 2, timeoutMs = 20000, parse = 'text', headers } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (parse === 'json') return response.json()
      if (parse === 'buffer') {
        // Consume the body as bytes so binary payloads (tiles, archives) are
        // not corrupted by a utf-8 decode.
        const arrayBuffer = await response.arrayBuffer()
        return Buffer.from(arrayBuffer)
      }
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

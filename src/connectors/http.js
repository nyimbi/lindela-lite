/**
 * URLs fetched during the current source run, for the provenance envelope.
 *
 * Every connector funnels its HTTP through `fetchWithRetry`, which makes this
 * the one place the retrieval URL is knowable at all: connectors build their
 * own URLs internally and never exposed them, so the lineage row's
 * `upstream_url_or_endpoint` was hardcoded null and could not honestly be
 * anything else. The audit trail recorded that data arrived without saying
 * from where.
 *
 * A module-level map rather than a callback threaded through every connector's
 * options, because no connector passes one and adding that plumbing to sixteen
 * files is a larger and less honest change than recording it where the fetch
 * happens. It is safe for the shape of this codebase — `runIngestion` awaits
 * one source at a time — and it is stated here rather than left to look like a
 * general-purpose request log, which it is not.
 */
const fetchesByRun = new Map()
let currentRunId = null

/** Names the run subsequent fetches are attributed to. */
export function beginFetchRecording(runId) {
  currentRunId = runId
  fetchesByRun.set(runId, [])
}

export function endFetchRecording(runId) {
  currentRunId = null
  return fetchesByRun.get(runId) || []
}

/** Every URL fetched during `runId`, in order, deduplicated. */
export function fetchesForRun(runId) {
  const seen = new Set()
  return (fetchesByRun.get(runId) || []).filter((entry) => {
    if (seen.has(entry.url)) return false
    seen.add(entry.url)
    return true
  })
}

export async function fetchWithRetry(url, { retries = 2, timeoutMs = 20000, parse = 'text', headers } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers })
      if (currentRunId) {
        fetchesByRun.get(currentRunId)?.push({ url: String(url), status: response.status, attempt: attempt + 1 })
      }
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

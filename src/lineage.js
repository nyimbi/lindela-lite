import { stableId, canonicalHash } from './utils.js'

export function recordLineage(store, sourceRun, records) {
  const now = new Date().toISOString()
  const payloadHashes = records.map((r) => r.payload_hash || canonicalHash(r))
  const upstream_checksum = canonicalHash({ hashes: payloadHashes })

  return {
    id: stableId('lineage', [sourceRun.source, sourceRun.id, now]),
    source: sourceRun.source,
    source_run_id: sourceRun.id,
    retrieval_time: sourceRun.started_at,
    upstream_url_or_endpoint: null,
    transform_version: '0.1.0',
    record_count: records.length,
    payload_hashes: payloadHashes,
    upstream_checksum,
    created_at: now,
  }
}

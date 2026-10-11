import crypto from 'node:crypto'

/**
 * ENH-34 — a citable handle over a frozen read.
 *
 * CAP-04 gave an export a *vintage*: a content hash that identifies a dataset,
 * so two partners who pulled an hour apart can tell whether they hold the same
 * thing. It deliberately stopped there. `src/vintage.js` states the refusal in
 * its own header — "It is not a snapshot. The store keeps no copy, and
 * `?vintage=` on an export is refused rather than silently ignored — offering a
 * parameter that cannot be honoured is worse than not offering it, because a
 * report that names a vintage it did not actually read is a citation that lies."
 *
 * That is the right refusal and it is also the gap. A vintage says *which*
 * dataset you read; it does not let anyone else read it. A report citing "the
 * flood-risk dataset, vintage 4f2a…" names something that cannot be fetched and
 * cannot be re-derived once the store moves on. ENH-34 is the missing half: a
 * snapshot freezes the records at the read that produced them, tags them with
 * the licence and attribution their sources carry, and mints a handle that
 * resolves to them.
 *
 * **Why a handle and not the vintage as the key.** The vintage is a hash of
 * content, so the same data snapshotted twice is the same vintage — which is
 * what makes it a useful *comparison*. A handle is an identifier for one stored
 * artifact, so it is minted once and does not change when the bytes are
 * re-serialised. Using the vintage as the primary key would make the second
 * snapshot of unchanged data collide with the first and silently return the
 * older licence stamp. The handle carries the vintage, so a consumer can still
 * ask "is this the same data as what I hold" without the two roles colliding.
 *
 * **What a snapshot is not.** It is not a second copy of the whole store under
 * a different name. It covers the export collections — the ones
 * `EXPORT_COLLECTIONS` already names, which is the set a vintage is computed
 * over — and it is bounded, because an unbounded snapshot of a store past the
 * read-row budget is the read this API spent SCL-01 removing. A snapshot that
 * could not be taken says so rather than storing a truncated one: a truncated
 * snapshot is worse than none, because it carries a handle and reads as the
 * record of truth.
 */

/** Refused rather than truncated, for the reason above. */
export const MAX_SNAPSHOT_RECORDS = 50_000

/**
 * The licences a snapshot can carry, and what each obliges a consumer to do.
 *
 * A licence string alone is not enough. `CC-BY-4.0` tells a downstream consumer
 * they must attribute, but not to whom, and an export whose attribution is
 * implied is one a partner cannot actually comply with. Each entry names the
 * obligation in words, so the tag travels with its own instruction.
 */
export const LICENCES = Object.freeze({
  'CC-BY-4.0': { attribution_required: true, share_alike: false, note: 'Attribute the source named in `attribution`. Commercial use permitted.' },
  'CC-BY-SA-4.0': { attribution_required: true, share_alike: true, note: 'Attribute, and license any derivative under the same terms.' },
  'CC0-1.0': { attribution_required: false, share_alike: false, note: 'No rights reserved. Attribution is courtesy, not obligation.' },
  'ODbL-1.0': { attribution_required: true, share_alike: true, note: 'Attribute, and keep derived databases open under ODbL.' },
  'internal-only': { attribution_required: false, share_alike: false, note: 'Not for redistribution. Do not publish or pass to a third party.' },
})

export function licenceTerms(code) {
  const terms = LICENCES[code]
  if (!terms) return null
  return { code, ...terms }
}

/** A handle: stable, opaque, and safe in a URL path and a citation. */
export function mintHandle(vintage) {
  // The vintage prefix is carried so a handle is recognisable as one at a
  // glance and two snapshots of the same data sort near each other; the random
  // suffix is what makes it an identifier for *this* artifact rather than for
  // the data, which is the distinction the vintage cannot make.
  return `lds_${String(vintage).slice(0, 12)}_${crypto.randomBytes(6).toString('hex')}`
}

/**
 * Build the snapshot record. Pure, so the shape is asserted without a store.
 *
 * `records` is the already-filtered set — the caller decides what the snapshot
 * covers and this decides what the snapshot *is*.
 */
export function buildSnapshot(records, {
  vintage,
  handle,
  label = null,
  licence = null,
  attribution = null,
  collections = null,
  query = null,
  createdBy = null,
  now = new Date().toISOString(),
} = {}) {
  const list = Array.isArray(records) ? records : []
  const terms = licenceTerms(licence)
  return {
    id: handle,
    handle,
    label,
    vintage,
    // Stated separately from `licence` so a consumer that only understands the
    // SPDX string is not forced to parse the obligation out of prose, and a
    // consumer that only reads prose is not left to infer the obligation from
    // an identifier they may not recognise.
    licence: terms ? terms.code : null,
    licence_terms: terms,
    attribution,
    record_count: list.length,
    collections: Array.isArray(collections) ? collections : null,
    query,
    created_at: now,
    created_by: createdBy,
    records: list,
  }
}

/** Validate a snapshot request, returning an error string or null. */
export function validateSnapshotRequest({ licence, attribution, records }) {
  if (!licence) return 'licence is required: a snapshot a consumer cannot license is a snapshot they cannot use'
  const terms = licenceTerms(licence)
  if (!terms) {
    return `unknown licence ${JSON.stringify(licence)}; known: ${Object.keys(LICENCES).join(', ')}`
  }
  if (terms.attribution_required && !attribution) {
    return `licence ${licence} requires attribution, and none was given; a consumer cannot comply with an obligation it cannot see`
  }
  if (Array.isArray(records) && records.length > MAX_SNAPSHOT_RECORDS) {
    return `snapshot would hold ${records.length} records, past the ${MAX_SNAPSHOT_RECORDS} limit; narrow it with a query filter rather than storing a truncated one`
  }
  return null
}

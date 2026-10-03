#!/usr/bin/env node
/**
 * ENH-15: record-level provenance with real transform versions.
 *
 * What this guard is for. `src/lineage.js` was implemented, tested and wrong in
 * three ways at once, and each one is invisible from the outside:
 *
 * 1. `transform_version` was the literal `'0.1.0'` — a constant nothing
 *    revisited. The parser could change and every row written afterwards would
 *    still claim 0.1.0, so the field answered "what version transformed this?"
 *    with a value nobody had checked. The version now comes from the source of
 *    the function that did the work, which is the only version that can move
 *    when the code moves.
 * 2. `upstream_url_or_endpoint` was hardcoded `null` on every row, so no row
 *    could name where its data came from — the field existed to be filled and
 *    was filled with nothing.
 * 3. `src/ingestion.js` passed a run-wide union of records into a function
 *    called once per source run, so a nine-source run wrote nine rows whose
 *    counts and hashes all described the whole run. Nine rows, one answer,
 *    nine times.
 *
 * And the gap under all three: IPC and WHO produced no lineage at all, so the
 * two sources whose records most need a donor to be able to trace them were the
 * two the store could not trace.
 *
 * The tests below are written against `src/provenance.js`, which is not wired
 * up yet. When the wiring lands, these are the tests that fail if it is done
 * per-source and skipped for the two connectors nobody remembered.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PROVENANCE_FIELDS,
  buildProvenance,
  connectorVersion,
  payloadHashFor,
  recordLineageRow,
  transformVersionFor,
} from '../src/provenance.js'
import { stableId } from '../src/utils.js'

const SOURCE_RUN = {
  id: 'run_2f1c9a0b7d3e4f10',
  source: 'gdacs',
  started_at: '2026-10-03T08:00:00.000Z',
}

const GDACS_CONNECTOR = { id: 'gdacs', description: 'GDACS disaster alerts', defaults: {}, ingest: () => {} }
const RETRIEVAL = { url: 'https://www.gdacs.org/xml/rss.xml', retrieved_at: '2026-10-03T08:00:12.000Z' }

function gdacsRecord(overrides = {}) {
  return {
    id: 'hazard_9a1',
    source: 'gdacs',
    source_id: 'EV-2026-000412',
    event_type: 'flood',
    severity: 'high',
    latitude: 1.2,
    longitude: 34.8,
    ...overrides,
  }
}

function transformOne(row) {
  return { event_type: row.event_type, severity: row.severity }
}

describe('buildProvenance', () => {
  it('builds one envelope per record, aligned with the input order', () => {
    const records = [gdacsRecord({ source_id: 'EV-1' }), gdacsRecord({ source_id: 'EV-2' })]
    const envelopes = buildProvenance({
      sourceRun: SOURCE_RUN,
      connector: GDACS_CONNECTOR,
      records,
      retrieval: RETRIEVAL,
      transform: transformOne,
    })

    assert.equal(envelopes.length, records.length)
    assert.deepEqual(envelopes.map((e) => e.upstream_id), ['EV-1', 'EV-2'])
  })

  it('carries every field in PROVENANCE_FIELDS and nothing else', () => {
    // The silent key list is this repo's signature defect: a field that is built
    // but not listed is dropped by every consumer that iterates the list, and
    // a field that is listed but not built is a column of undefined. Both look
    // identical from outside the module, which is why they are checked here.
    const [envelope] = buildProvenance({
      sourceRun: SOURCE_RUN,
      connector: GDACS_CONNECTOR,
      records: [gdacsRecord()],
      retrieval: RETRIEVAL,
      transform: transformOne,
    })

    assert.deepEqual(Object.keys(envelope).sort(), [...PROVENANCE_FIELDS].sort())
    for (const field of PROVENANCE_FIELDS) {
      assert.ok(field in envelope, `envelope is missing ${field}`)
    }
  })

  it('stamps the run, connector, retrieval and transform onto the envelope', () => {
    const [envelope] = buildProvenance({
      sourceRun: SOURCE_RUN,
      connector: GDACS_CONNECTOR,
      records: [gdacsRecord()],
      retrieval: RETRIEVAL,
      transform: transformOne,
    })

    assert.equal(envelope.source_run_id, SOURCE_RUN.id)
    assert.equal(envelope.connector_id, 'gdacs')
    assert.equal(envelope.retrieval_url, RETRIEVAL.url)
    assert.equal(envelope.retrieved_at, RETRIEVAL.retrieved_at)
    assert.equal(envelope.payload_hash, payloadHashFor(gdacsRecord()))
    assert.equal(envelope.transform_version, transformVersionFor(transformOne))
  })

  it('gives IPC records provenance too, url read from the dataset it came from', () => {
    // IPC was excluded from lineage entirely, so its records — the ones a donor
    // most often asks about — carried no trace of the feed that produced them.
    const records = [
      {
        id: 'food_security_1',
        source: 'ipc_hdx',
        source_id: 'KEN:Turkana:Current:2026-06-01',
        country: 'KEN',
        scope: 'area',
        metadata: { dataset: 'https://data.humdata.org/dataset/global-acute-food-insecurity-country-data' },
      },
    ]
    const [envelope] = buildProvenance({
      sourceRun: { id: 'run_ipc', source: 'ipc_hdx', started_at: '2026-10-03T09:00:00.000Z' },
      connector: { id: 'ipc_hdx', defaults: {}, ingest: () => {} },
      records,
      retrieval: {},
      transform: transformOne,
    })

    assert.equal(envelope.connector_id, 'ipc_hdx')
    assert.equal(envelope.upstream_id, 'KEN:Turkana:Current:2026-06-01')
    assert.equal(envelope.upstream_id_state, 'present')
    assert.equal(
      envelope.retrieval_url,
      'https://data.humdata.org/dataset/global-acute-food-insecurity-country-data',
    )
  })

  it('gives WHO records provenance too, one url per indicator', () => {
    // WHO fetches eight indicator endpoints inside a single source run, so the
    // retrieval url cannot be a per-run constant. A single string would stamp
    // eight different feeds' rows with whichever endpoint was read first.
    const records = [
      { id: 'disease_1', source: 'who_gho', source_id: 'CHOLERA_0000000001:KEN:2016' },
      { id: 'disease_2', source: 'who_gho', source_id: 'WHS3_62:UGA:2025' },
    ]
    const envelopes = buildProvenance({
      sourceRun: { id: 'run_who', source: 'who_gho', started_at: '2026-10-03T09:30:00.000Z' },
      connector: { id: 'who_gho', defaults: {}, ingest: () => {} },
      records,
      retrieval: { url: (record) => `https://ghoapi.azureedge.net/api/${record.source_id.split(':')[0]}?$format=json` },
      transform: transformOne,
    })

    assert.equal(envelopes.length, 2)
    assert.equal(envelopes[0].retrieval_url, 'https://ghoapi.azureedge.net/api/CHOLERA_0000000001?$format=json')
    assert.equal(envelopes[1].retrieval_url, 'https://ghoapi.azureedge.net/api/WHS3_62?$format=json')
    assert.equal(envelopes[1].connector_id, 'who_gho')
  })

  it('keeps a record with no upstream identifier distinguishable from a lookup that failed', () => {
    // 'absent' is a fact about the provider: the field is there and empty.
    // 'unknown' is a fact about us: there is no identifier field on this record
    // at all, so we cannot say whether the provider has one. Both used to be
    // null, which made a connector quietly dropping its ids indistinguishable
    // from a provider that has none.
    const [absent] = buildProvenance({
      sourceRun: SOURCE_RUN,
      connector: GDACS_CONNECTOR,
      records: [gdacsRecord({ source_id: null })],
      retrieval: RETRIEVAL,
    })
    const [unknown] = buildProvenance({
      sourceRun: SOURCE_RUN,
      connector: GDACS_CONNECTOR,
      records: [{ id: 'hazard_9a1', event_type: 'flood' }],
      retrieval: RETRIEVAL,
    })

    assert.equal(absent.upstream_id_state, 'absent')
    assert.equal(unknown.upstream_id_state, 'unknown')
    assert.equal(absent.upstream_id, null)
    assert.equal(unknown.upstream_id, null)
    assert.notEqual(absent.upstream_id_state, unknown.upstream_id_state)
  })

  it('treats an upstream id of "0" or 0 as present, not absent', () => {
    // Truthiness over a nullable field is the falsy-zero trap: an id of 0 is a
    // real id, and reading it as an absence loses the record's link to the
    // provider without anything reporting a loss.
    const [stringZero, numberZero] = buildProvenance({
      sourceRun: SOURCE_RUN,
      connector: GDACS_CONNECTOR,
      records: [gdacsRecord({ source_id: '0' }), gdacsRecord({ source_id: 0 })],
      retrieval: RETRIEVAL,
    })

    assert.equal(stringZero.upstream_id, '0')
    assert.equal(stringZero.upstream_id_state, 'present')
    assert.equal(numberZero.upstream_id, 0)
    assert.equal(numberZero.upstream_id_state, 'present')
  })

  it('falls back to a later identifier key when the first is empty', () => {
    const [envelope] = buildProvenance({
      sourceRun: SOURCE_RUN,
      connector: GDACS_CONNECTOR,
      records: [{ id: 'hazard_9a1', source_id: '', guid: 'urn:gdacs:000412' }],
      retrieval: RETRIEVAL,
    })

    assert.equal(envelope.upstream_id, 'urn:gdacs:000412')
    assert.equal(envelope.upstream_id_state, 'present')
  })
})

describe('transformVersionFor', () => {
  it('changes when the transform changes, which is the whole defect', () => {
    // The old version was the string '0.1.0', typed once and never revised.
    // Editing a mapping produced records stamped identically to the records
    // before the edit, so nothing downstream could tell which rows came from
    // which parser.
    const before = (row) => ({ severity: row.alert_level })
    const after = (row) => ({ severity: row.severity })

    assert.notEqual(transformVersionFor(before), transformVersionFor(after))
  })

  it('is stable when the transform does not change', () => {
    // Two separately-defined functions with identical source are the same
    // transform, so a redeploy that moves code around must not re-version every
    // row in the store.
    const parse = (row) => ({ phase: String(row.Phase) })
    const alsoParse = (row) => ({ phase: String(row.Phase) })

    assert.equal(transformVersionFor(parse), transformVersionFor(alsoParse))
  })

  it('produces the same value for the same function twice', () => {
    // Determinism first: a version that moved on its own would be worse than a
    // constant, because it would mark every re-ingest as a change.
    assert.equal(transformVersionFor(transformOne), transformVersionFor(transformOne))
  })

  it('moves on a comment-only edit, because it hashes source and not intent', () => {
    // The coarseness is the documented trade, so it is pinned here. It costs a
    // re-run; the alternative was a version that never moved at all.
    const commented = (row) => {
      // The provider publishes alert_level, and it is the only severity signal.
      return { severity: row.alert_level }
    }
    const bare = (row) => ({ severity: row.alert_level })

    assert.notEqual(transformVersionFor(commented), transformVersionFor(bare))
  })

  it('labels the version as a source fingerprint rather than a semver', () => {
    assert.match(transformVersionFor(transformOne), /^src:tf_[0-9a-f]{16}$/)
  })

  it('combines every function in a composed transform', () => {
    // A connector's ingest composes its parser. Passing only the outer function
    // would leave the parser's edits invisible to the version.
    const parse = (row) => ({ severity: row.alert_level })
    const parseChanged = (row) => ({ severity: String(row.alert_level || '') })

    assert.notEqual(
      transformVersionFor([parse, transformOne]),
      transformVersionFor([parseChanged, transformOne]),
    )
  })

  it('returns undefined for nothing to hash rather than a version that means nothing', () => {
    assert.equal(transformVersionFor(null), undefined)
    assert.equal(transformVersionFor([]), undefined)
  })

  it('does not claim to have read a bound function it could not read', () => {
    // A bound function stringifies as `function () { [native code] }`, so
    // hashing it naively would give every bound transform the same fingerprint
    // and the guarantee would evaporate without anything reporting it. Here it
    // gets a marker derived from the function's name instead — still honest
    // that it is a fallback, and still wrong for two different bound versions of
    // the same function, which is why the caller must pass the underlying one.
    const bound = transformOne.bind(null)

    assert.equal(transformVersionFor(bound), transformVersionFor(transformOne.bind(null)))
    assert.notEqual(transformVersionFor(bound), transformVersionFor(transformOne))
  })
})

describe('connectorVersion', () => {
  it('reads id and version off a spec', () => {
    assert.equal(connectorVersion({ id: 'gdacs', version: '2.1.0' }), '2.1.0')
  })

  it('returns undefined when no version is declared, not null', () => {
    // defineConnector freezes {id, description, schema, defaults, ingest} and
    // drops anything else, so every spec in the repo today has no version. That
    // is a fact about the wiring; turning it into null on the way into the
    // envelope would make "nobody declared one" look like "declared as null".
    assert.equal(connectorVersion(GDACS_CONNECTOR), undefined)
    assert.equal(connectorVersion(undefined), undefined)
    assert.equal(connectorVersion({ id: 'gdacs', version: '   ' }), undefined)
  })
})

describe('payloadHashFor', () => {
  it('prefers the hash the ingest already computed', () => {
    const record = gdacsRecord({ payload_hash: 'deadbeef' })
    assert.equal(payloadHashFor(record), 'deadbeef')
  })

  it('is stable across a re-ingest because canonicalHash drops ids and timestamps', () => {
    // This is the property the whole thing rests on: the same upstream row must
    // hash the same on a later run, or every re-ingest would look like a
    // correction and mergeById would keep both copies.
    const first = gdacsRecord({ id: 'hazard_1', first_seen_at: '2026-10-01T00:00:00.000Z' })
    const later = gdacsRecord({ id: 'hazard_1', first_seen_at: '2026-10-03T00:00:00.000Z' })

    assert.equal(payloadHashFor(first), payloadHashFor(later))
  })

  it('ignores its own provenance envelope', () => {
    // Otherwise attaching the envelope changes the hash of the record it
    // describes, and the row hashes in a lineage row stop matching the rows
    // that were written.
    const record = gdacsRecord()
    const [envelope] = buildProvenance({
      sourceRun: SOURCE_RUN,
      connector: GDACS_CONNECTOR,
      records: [record],
      retrieval: RETRIEVAL,
      transform: transformOne,
    })

    assert.equal(payloadHashFor({ ...record, _provenance: envelope }), payloadHashFor(record))
  })
})

describe('recordLineageRow', () => {
  function runFor(source, index, records) {
    return {
      sourceRun: { id: `run_${source}_${index}`, source, started_at: '2026-10-03T08:00:00.000Z' },
      records,
      provenance: buildProvenance({
        sourceRun: { id: `run_${source}_${index}`, source, started_at: '2026-10-03T08:00:00.000Z' },
        connector: { id: source, defaults: {}, ingest: () => {} },
        records,
        retrieval: { url: `https://example.org/${source}` },
        transform: transformOne,
      }),
    }
  }

  it('names where the data came from instead of writing null', () => {
    // The old row hardcoded upstream_url_or_endpoint: null. This assertion is
    // the anti-regression for exactly that line — a null here fails the test.
    const row = recordLineageRow(runFor('gdacs', 0, [gdacsRecord()]))

    assert.notEqual(row.upstream_url_or_endpoint, null)
    assert.ok(row.upstream_url_or_endpoint)
    assert.equal(row.upstream_url_or_endpoint, 'https://example.org/gdacs')
  })

  it('stamps a derived transform version rather than the constant 0.1.0', () => {
    const row = recordLineageRow(runFor('gdacs', 0, [gdacsRecord()]))

    assert.notEqual(row.transform_version, '0.1.0')
    assert.equal(row.transform_version, transformVersionFor(transformOne))
  })

  it('writes one row per source run, each with its own count and hashes', () => {
    // The old loop rebuilt the union of every source's records and wrote it
    // once per source run, so a nine-source run produced nine rows with the
    // same count, the same hashes and the same checksum — nine copies of one
    // answer, each attributed to a different source.
    const sources = ['gdacs', 'who_gho', 'ipc_hdx', 'open_meteo', 'chirps', 'glofas', 'reliefweb', 'imf', 'nrcs']
    const rows = sources.map((source, index) =>
      recordLineageRow(runFor(source, index, [
        gdacsRecord({ id: `hazard_${source}_1`, source_id: `${source}-1` }),
        gdacsRecord({ id: `hazard_${source}_2`, source_id: `${source}-2`, severity: 'critical' }),
        gdacsRecord({ id: `hazard_${source}_3`, source_id: `${source}-3`, event_type: 'storm' }),
      ])),
    )

    assert.equal(rows.length, 9)
    assert.equal(new Set(rows.map((row) => row.id)).size, 9)
    for (const row of rows) {
      assert.equal(row.record_count, 3)
      assert.equal(row.payload_hashes.length, 3)
    }
    assert.equal(new Set(rows.map((row) => row.upstream_checksum)).size, 9)
    assert.equal(new Set(rows.map((row) => row.payload_hashes.join('|'))).size, 9)
    assert.deepEqual(rows.map((row) => row.source), sources)
  })

  it('counts only its own source run, not the whole run union', () => {
    // The defect, stated as a number: a two-source run where gdacs returned one
    // record and ipc returned three must produce a row of count 1 and a row of
    // count 3. A union-fed implementation writes 4 on both.
    const gdacsRun = runFor('gdacs', 0, [gdacsRecord({ source_id: 'EV-1' })])
    const ipcRun = runFor('ipc_hdx', 1, [
      gdacsRecord({ id: 'f1', source_id: 'KEN:a' }),
      gdacsRecord({ id: 'f2', source_id: 'KEN:b' }),
      gdacsRecord({ id: 'f3', source_id: 'KEN:c' }),
    ])
    const union = [...gdacsRun.records, ...ipcRun.records]

    assert.equal(recordLineageRow(gdacsRun).record_count, 1)
    assert.equal(recordLineageRow(ipcRun).record_count, 3)
    assert.equal(recordLineageRow({ ...gdacsRun, records: union }).record_count, 4)
    assert.deepEqual(recordLineageRow(gdacsRun).payload_hashes, gdacsRun.records.map((r) => payloadHashFor(r)))
  })

  it('derives an id from the run alone, with no clock in the key material', async () => {
    // `stableId` had `now` mixed into its key material, so nine rows written in
    // one run were nine different records as far as the store was concerned.
    // Comparing two calls made in the same millisecond would not catch that —
    // the clock has not moved — so the id is asserted against the formula
    // instead, and a real tick is waited out as well.
    const run = runFor('gdacs', 0, [gdacsRecord(), gdacsRecord({ source_id: 'EV-2' })])
    const first = recordLineageRow(run)

    assert.equal(first.id, stableId('lineage', [run.sourceRun.source, run.sourceRun.id]))

    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = recordLineageRow(run)

    assert.equal(first.id, second.id)
    assert.equal(first.upstream_checksum, second.upstream_checksum)
    assert.deepEqual(first.payload_hashes, second.payload_hashes)
  })

  it('names every transform version when one run used more than one', () => {
    // Picking one of the two would say a version that did not produce every
    // row, which is the direction of the lie that matters.
    const records = [gdacsRecord({ source_id: 'EV-1' }), gdacsRecord({ source_id: 'EV-2' })]
    const provenance = buildProvenance({
      sourceRun: SOURCE_RUN,
      connector: GDACS_CONNECTOR,
      records,
      retrieval: RETRIEVAL,
      transform: transformOne,
    })
    provenance[1].transform_version = transformVersionFor((row) => ({ severity: String(row.severity) }))
    const row = recordLineageRow({ sourceRun: SOURCE_RUN, records, provenance })

    assert.match(row.transform_version, /^mixed:src:tf_/)
  })

  it('refuses to build a row with no source run', () => {
    assert.throws(() => recordLineageRow({ records: [] }), /sourceRun/)
  })
})

describe('PROVENANCE_FIELDS', () => {
  it('is non-empty, and holds nothing but strings', () => {
    // Anti-vacuous. An empty list makes every "every field is in the list" check
    // below pass while the envelope carries whatever it likes.
    assert.ok(Array.isArray(PROVENANCE_FIELDS))
    assert.ok(PROVENANCE_FIELDS.length > 0)
    for (const field of PROVENANCE_FIELDS) assert.equal(typeof field, 'string')
    assert.equal(new Set(PROVENANCE_FIELDS).size, PROVENANCE_FIELDS.length)
  })

  it('lists the fields the audit question is actually asking', () => {
    assert.deepEqual(
      [...PROVENANCE_FIELDS].sort(),
      [
        'connector_id',
        'connector_version',
        'payload_hash',
        'retrieval_url',
        'retrieved_at',
        'source_run_id',
        'transform_version',
        'upstream_id',
        'upstream_id_state',
      ],
    )
  })

  it('is frozen, so a consumer cannot extend it behind the envelope', () => {
    assert.ok(Object.isFrozen(PROVENANCE_FIELDS))
  })

  it('covers every field the envelope builds, for each of the three connectors', () => {
    const envelopes = [
      ...buildProvenance({
        sourceRun: SOURCE_RUN,
        connector: GDACS_CONNECTOR,
        records: [gdacsRecord()],
        retrieval: RETRIEVAL,
        transform: transformOne,
      }),
      ...buildProvenance({
        sourceRun: { id: 'run_ipc', source: 'ipc_hdx', started_at: SOURCE_RUN.started_at },
        connector: { id: 'ipc_hdx', defaults: {}, ingest: () => {} },
        records: [{ id: 'food_security_1', source_id: 'KEN:Turkana:current' }],
        retrieval: { url: 'https://data.humdata.org/dataset/global-acute-food-insecurity-country-data' },
        transform: transformOne,
      }),
      ...buildProvenance({
        sourceRun: { id: 'run_who', source: 'who_gho', started_at: SOURCE_RUN.started_at },
        connector: { id: 'who_gho', defaults: {}, ingest: () => {} },
        records: [{ id: 'disease_1', source_id: 'WHS3_62:UGA:2025' }],
        retrieval: { url: 'https://ghoapi.azureedge.net/api/WHS3_62?$format=json' },
        transform: transformOne,
      }),
    ]

    assert.equal(envelopes.length, 3)
    for (const envelope of envelopes) {
      for (const field of Object.keys(envelope)) {
        assert.ok(PROVENANCE_FIELDS.includes(field), `${field} is built but not listed`)
      }
      for (const field of PROVENANCE_FIELDS) {
        assert.ok(field in envelope, `${field} is listed but not built for ${envelope.connector_id}`)
      }
    }
  })
})

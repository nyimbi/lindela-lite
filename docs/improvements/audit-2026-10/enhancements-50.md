# Fifty enhancements — audit 2026-10

**Scope.** Non-incremental changes: each either moves a systemic quantity by an
order of magnitude (throughput, veracity, or cognitive cost) or opens an
operational paradigm the platform cannot currently express. Cosmetic work,
localised refactors and feature creep are excluded by construction — an item that
cannot state its order-of-magnitude claim in one sentence does not appear here.

**Relation to the prior audit.** `docs/improvements/enhancements.md` holds
`ENH-01..ENH-30` (trust, ingestion, visualisation, response, foundations). This
set is `ENH-31..ENH-80` and is disjoint from it; no item below restates one above.
The prior audit asked whether the platform is honest and whether its claims work.
This one asks what it cannot yet *do*, and what it does too slowly.

**Scoring.** Impact and Effort are 1–5. `Score = 0.6·Impact + 0.4·(6−Effort)`,
so a high-impact, low-effort item (5,1 → 5.0) outranks a high-impact, high-effort
one (5,5 → 3.4). Effort is engineering weeks at the current team size, not
calendar time: 1 ≈ days, 5 ≈ a quarter.

---

## Status against the tree — verified 2026-10-11

Every row below was checked against the code, not against the note beneath it.
The per-item notes carry the detail; this is the summary, and it exists because
the two had drifted: three items were marked shipped while four others were
shipped and unmarked, and the register was the last place anyone looked.

| Verdict | Count | Items |
|---|---|---|
| IMPLEMENTED | 51 | 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81 |
| PARTIAL | 0 | none |
| ABSENT | 0 | none |

ENH-59 was the last PARTIAL and closed 2026-10-15. It had been marked PARTIAL on
the claim that the five tables could not be generated, and the claim was wrong in
one word: **derive** was conflated with **declare**. A scope is not a function of
a path, but it is a *value*, and values live in one declaration. What shipped is
`src/route-declaration.js` — one `(METHOD, path)`-keyed entry per operation,
carrying the spec body, the scope, the collections the handler reads, and the
comments explaining each — with `docs/openapi.yaml` and `src/route-manifests.js`
generated from it. `check-route-drift.mjs` fails when a committed file and its
regeneration differ; `check-route-reachability.mjs` fails when a declared route is
served by no matcher, or a matcher serves a route no declaration names. The
remaining two tables are not generated, and that is a decision rather than a
residue — see the closing note under the entry.

Reading a PARTIAL as done is the error this table exists to prevent, and its
mirror is reading a shipped item as partial because the reason it was held back
was never re-read. ENH-59 held for four days on a reason that one measurement
refuted; the conclusion was right and the reason was not, and the reason is what
the next reader reuses.

**Two rows were wrong in opposite directions, found 2026-10-12 by checking the
code rather than the note.** ENH-32 was marked PARTIAL against a summary line
that said it pulls and does not push — but `src/connectors/dhis2-push.js` exists,
`src/routes/exports.js` calls it, and 14 tests pass; it is IMPLEMENTED. ENH-42
was marked PARTIAL with **no shipped note at all**, and there was no tile-pack
code in the tree; at that moment it was ABSENT. (It was built later the same day —
format first, then the route — and is IMPLEMENTED above.) A register that drifts
optimistically is worse than one that drifts pessimistically, because the first
claims work that does not exist. Both counts here are read off the listed ids by
script, never by eye.

---

## Group G — Interoperability substrate: push, not only pull

The platform can *ingest* from the humanitarian ecosystem and cannot *publish*
to it. For a coordination platform that is the wrong half: DHIS2, HDX and
KoboToolbox all expect to consume, and none of them will poll a bespoke JSON API.

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-31 | HXL-tagged CSV export | 4 | 1 | 4.4 |
| ENH-32 | DHIS2 `dataValueSet` push | 4 | 2 | 4.0 |
| ENH-33 | Administrative org-unit registry | 5 | 3 | 4.2 |
| ENH-34 | Versioned datasets with citable handles | 4 | 3 | 3.6 |
| ENH-35 | OGC API Features + STAC catalogue | 3 | 3 | 3.0 |
| ENH-36 | CAP 1.2 profile validation and feed permalinks | 3 | 2 | 3.4 |
| ENH-37 | Streaming bulk export (NDJSON/Arrow) | 5 | 2 | 4.6 |

**ENH-31 — HXL-tagged CSV export.** A one-line change to the CSV writer that
emits an HXL hashtag row above the header (`#loc+name`, `#date+occurred`,
`#affected+flooded`). HDX's whole ingestion pipeline keys on it; without it a
partner must hand-map every column. `src/server.js` `export.csv` route; the
hashtag registry belongs in `src/schema.js` beside the field definitions.

**Shipped 2026-10-11.** `src/hxl.js` holds the registry and `toCsv(records, {hxl})`
emits the row; `GET /api/v1/export.csv?hxl=1` serves it. Two deviations from the
note above, both deliberate.

The registry went in its own module rather than in `src/schema.js`. `schema.js`
holds the *store's* vocabulary — the status and type enumerations a record is
validated against — and this registry is keyed by the *export's* column names,
which are what `flattenRecord` makes of a record key: a nested field becomes a
dotted path (`location.admin1`), an underscored one stays underscored
(`source_id`). Putting it beside the field definitions would have invited
writing it against the store's names, and that mistake is silent — the tag
simply never matches a header and the column reads as unmapped.

The row is built by looking each header up (`hxlRow(headers)`), not by walking
the registry. A row built by walking the registry emits every hashtag in
registry order, and `toCsv` sorts its headers, so the file would carry tags that
are each correct and each on the wrong column with nothing downstream able to
tell. The canary that walks the registry fails 3 cases.

It is opt-in (`?hxl=1`), because an export that changed shape when an option was
added would break every consumer already parsing it and the change would look
like an improvement in the diff. `?hxl=maybe` is a 400, not a truthy read —
`Boolean('maybe')` is true, so a truthiness test tags the export for a caller who
did not ask. Eleven cases in `test/hxl-export.test.js`; canaried in three
directions (registry-order row: 3 failures; truthiness: 1; a malformed hashtag in
the registry: 5).

**ENH-32 — DHIS2 `dataValueSet` push.** `src/connectors/dhis2.js` already speaks
DHIS2 to *pull*. The push half is a serializer plus a scheduled job: map the KPI
rollups to org-unit/dataElement/period triples and POST to `/api/dataValueSets`.
Today interoperability is one-way, which for a national platform is a blocker.

> **Shipped — IMPLEMENTED, mis-marked PARTIAL until 2026-10-12.** The push half
> exists and is wired: `src/connectors/dhis2-push.js` holds
> `dataValueSetFrom(records, { orgUnits, dataElements, period })` (the KPI rollup
> mapped to org-unit/dataElement/period triples) and `pushDataValueSet(request)`,
> and `src/routes/exports.js` calls it from the `export/dhis2` route as a **post**
> beside the reads, so an operator can see the exact body before sending it. 14
> tests in `test/dhis2-push.test.js`. It took the SSRF guard (ENH-78's sweep) like
> the other four outbound sites. The register's summary line still said "pulls and
> does not push", which is how it stayed PARTIAL — the note was never updated when
> the code landed.

**ENH-33 — Administrative org-unit registry.** District resolution is scattered
across `src/districts.js`, `src/utils.js`, `src/kpi.js`, `src/analytics/metrics.js`,
`src/calibration.js`, `src/reports.js` and `public/shared/districts-view.js`, each
re-deriving the hierarchy. A registry with codes, a parent pointer and boundaries
turns a district split from a data migration into a config change, and gives every
aggregation one source. This is the DHIS2 org-unit primitive the platform lacks.

**Shipped 2026-10-11 — IMPLEMENTED.** CAP-03 (`e8fcc54`, same day) built the
registry the entry names: `ORG_UNITS` with a code, a level, a parent pointer and a
declared boundary kind, and `rollupSlugsFor` so a parent aggregates its
descendants without a per-module list. Twelve tests in `test/org-units.test.js`.

What CAP-03 left was the second copy, and it was in the browser. The registry was
under `src/`, which the browser may not import, so the map kept its own:
`PILOT_DISTRICTS` in `public/shared/basemap.js`, five hand-typed districts with the
same centres and radii, kept in step by a comment reading "matching
src/districts.js". The map frame, the outbreak geocoder and the district overlay all
place units by that list, so a centre corrected on one side and not the other put a
district in two places depending on which surface drew it — the same
second-source-of-truth shape the entry is about, moved rather than closed.

The registry data now lives in `public/shared/org-units.js`; `src/org-units.js`
holds the traversal helpers and reads the data rather than restating it, so the
export surface is unchanged and a server caller has one import. The split is the
ENH-75 pattern (`public/shared/submission-id.js` → `src/submission-id.js`), and the
helpers stay out of the browser's copy because the browser walks no hierarchy.
`basemap.js` derives `PILOT_DISTRICTS` from the registry, projecting the stored
`{lat, lon}` to the `[lon, lat]` the map reads. The agreement is asserted, not
commented: a test refuses a hand-typed drift, and a canary proved it does.

**The gate defect this surfaced.** `scripts/check-budget.mjs` measured first load
by walking the module graph, and its import regex matched `from '/shared/x.js'` and
not `from './x.js'` — the relative form is how *every* module inside
`public/shared/` names its neighbour. The walk stopped at the first relative hop, so
`runtime.js → ./fmt.js`, `map-frame.js → ./basemap.js`, `secret.js → ./native.js`
and three more were never counted. Measured at HEAD with the walker fixed: **225.0
KB, already 9.0 KB over the 216 KB ceiling** the gate reported 210.7 KB against,
with 5.3 KB of "headroom" that did not exist. The ceiling was raised to 229 KB — a
correction of the measurement, not a licence: the tree was over before ENH-33 and
the walker could not see it. `test/budget-walker.test.js` pins both spellings, with
a canary that plants a relative-only dependency and requires the total to move.

**ENH-34 — Versioned datasets with citable handles.** `/api/v1/export.*` returns a
live query with an ETag. A report citing "the flood-risk dataset" cannot name which
vintage it read. Snapshot exports into an immutable, licence-tagged, handle-addressable
collection so a downstream consumer can cite a version and reproduce it.

**Shipped 2026-10-11.** CAP-04 had already given an export a *vintage* — a content
hash identifying a dataset — and stopped there on purpose. `src/vintage.js` states
the refusal in its own header: "It is not a snapshot. The store keeps no copy, and
`?vintage=` on an export is refused rather than silently ignored — offering a
parameter that cannot be honoured is worse than not offering it, because a report
that names a vintage it did not actually read is a citation that lies." That was
right, and it was also the gap: a vintage says which dataset you read and does not
let anyone else read it.

`POST /api/v1/dataset-snapshots` freezes the records at the read that produced them
and returns a handle; `GET /api/v1/dataset-snapshots/{id}` resolves it, with
`?records=false` for the provenance alone; `GET /api/v1/dataset-snapshots` is the
index, carrying handles and provenance and never the rows. The domain is
`src/snapshots.js`, the routes `src/routes/snapshots.js`.

Three decisions worth naming:

- **The handle is not the vintage.** The vintage is a hash of content, so two
  snapshots of unchanged data share one; minting the handle from it would collide
  and return the older licence stamp for a newer read. The handle carries the
  vintage, so a consumer can still ask "is this the same data I hold".
- **A licence travels with its own obligation.** `CC-BY-4.0` tells a consumer to
  attribute but not to whom, so `LICENCES` names the obligation in words beside the
  SPDX string, and a licence requiring attribution given none is refused rather
  than stored with a null. An empty body defaults to `internal-only` — the one
  licence that cannot be wrong if the caller forgot to say.
- **A snapshot that cannot be taken says so.** Past `MAX_SNAPSHOT_RECORDS` the
  request is refused rather than truncated: a truncated snapshot carries a handle,
  and a handle reads as the record of truth. This is the truncation class the
  repository keeps removing (ENH-37, R-27).

Four canaries, each watched failing on the property it removes: dropping the
attribution guard (two tests — the module guard and the route that calls it),
minting the handle from the vintage, removing the record limit, and letting the
listing carry its records. `test/snapshots.test.js` (25).

The family first shipped as one file in `src/`, and `check-openapi.mjs` reported
both documented paths as ghosts — the gate reads `src/server.js` and every module
under `src/routes/`, by directory rather than by a list, so a matcher in `src/` is
invisible to it. Split along the same line `routes/exports.js`/`vintage.js` already
follows, and the gate now reports `parsed matchSnapshotRoute → handleSnapshotRoute:
2 paths`, 162 documented and 162 served.

**ENH-35 — OGC API Features + STAC catalogue.** The vector layers and raster
products are served bespoke. OGC API Features and a STAC catalogue make them
discoverable by QGIS, GDAL and any geospatial client without custom code.

> **Shipped — verified 2026-10-12; the note was missing.** `src/stac.js` exports `stacCatalog`, `stacItem`, `stacCollection` and `ogcFeatureCollection`, served at `/stac/catalog.json` and `/ogc/collections` — the latter two named in `test/route-envelope-gate.test.js`. `test/lite.test.js` imports all four. `src/inbound-rate-limit.js` carries a deliberate exemption for the `/stac/` and `/ogc/` prefixes, because they look like unbounded reads and are not.

**ENH-36 — CAP 1.2 profile validation and feed permalinks.** `src/cap.js` emits CAP
XML. Add strict 1.2 profile validation (so a consumer's parser does not reject it)
and a stable `/feed` permalink per alert, which is how GDACS and FEWS NET are
consumed in practice.

**Shipped 2026-10-11.** `src/cap-profile.js` is the profile and `sources/CAP-v1.2-os.html`
is the archived standard it was transcribed from — element order, required sets and
every enumerated vocabulary. The route now validates each rendered document before
serving it and answers **500** rather than 200 when it does not conform;
`GET /api/v1/alert-events/cap-feed` is the Atom feed, and every `.cap` response
carries its permalink in a `Link` header.

*The failure direction is the whole point.* A malformed CAP document served as
valid is a national system that silently drops this platform's warnings — the
subscriber's parser rejects it, the subscriber logs nothing, and the alert does
not exist. An endpoint that is plainly down is a better answer than an endpoint
that is confidently wrong, so the gate refuses rather than warns. `<sent>` is
stamped at render, so the same alert rendered twice is not byte-identical; the
permalink is keyed on `identifier`, which is stable, not on the document.

*Null Island is valid CAP, so it is a warning and not an error.* The renderer's
worst historical defect was `<circle>0,0 50</circle>` — a 50 km circle in the Gulf
of Guinea for an alert about Bor — and a profile that rejected it would be wrong
about the standard: `0,0` is a legal coordinate. The profile warns, and `cap.js`'s
district resolution is what actually prevents it. A validator that refuses
conforming documents is a validator that gets deleted.

*Deprecated is not invalid.* CAP 1.2 deprecates `Very Likely` and directs readers
to treat it as `Likely`. Refusing it would fail a feed that works today, so it
warns.

Four scanner bugs, each caught only by a test feeding the validator a document
known to be wrong — which is why those tests exist and the valid-document test
does not carry the weight. The scanner could not see the root element; it read
each element's value as the *previous* element's text; it ordered elements by
close rather than open, so block grouping was wrong; and it let a close tag match
any element on its stack, so removing `</description>` still parsed as
well-formed. Every one of the four passes a "valid document" test written against
its own output.

One canary, watched failing: emitting `<severity>Catastrophic</severity>` from
`cap.js` turned 6 tests red, with the 500 body naming
`<severity> is 'Catastrophic', which is not one of Extreme, Severe, Moderate,
Minor, Unknown`. Reverted from a file backup.

Two defects found while wiring it, both the same shape as ENH-44's. The first:
`check-openapi.mjs` fired on `cap-feed` the moment it was served — a route the
gate is right about, and the reason it is a gate. The second is the register's
recurring finding: the feed was matched *after* the collection pattern in
`matchAlertingRoute`, which would have taken `cap-feed` as an alert-events record
id and 404'd a route that plainly exists. Ordering was doing work the matcher
should do, and the fix was to match the literal path first.

**ENH-37 — Streaming bulk export.** `collectionPage` materialises the full result
set in memory before serialising (see SCL-03). A chunked NDJSON/Arrow export that
streams from the store keeps memory bounded regardless of table size and lets a
partner pull millions of rows. This is the substrate ENH-31/32/34 all ride on.

**Fixed 2026-10-11.** `/api/v1/export.ndjson` streams via `store.iterateRecords`.
Measured on the demo store before the fix: `export.csv` returned **501 lines — 500
data rows — against 12,929** non-history records, and `?limit=5000` returned 1,343.
The cap is `parseLimit`'s `DEFAULT_LIMIT`, applied to a route that never says it is
paged, in a `text/csv` body with no marker — a silent truncation of 12,429 records
on the surface a partner is most likely to treat as the record of truth. The
streamed route returns all 12,937 records (the extra 8 arrive after the CSV read),
`?collection=field_reports` returns 168, an unknown collection is a 400, and
`?limit=`/`?cursor=` are refused rather than honoured or ignored — `filterRecords`
reads both, so honouring `limit` would reintroduce the cap through a second door
and ignoring it would be the `?district=` defect. NDJSON rather than streamed CSV
because a CSV header is the union of every record's flattened keys and is not known
until the last record; each NDJSON line is self-describing. Arrow was not built —
it needs a schema before the first row, the same problem, and adds a dependency
this package does not carry. Tests: `test/streaming-export.test.js` (11).

The route first shipped dispatched *below* the line that reads the whole store,
so it streamed its output while holding its input: on a store past SCL-01's
read-row budget — the one store this route exists for — it answered 503 before
the first byte, and below the budget it materialised everything anyway. Probed,
not reasoned: a 100-row store with a 10-row budget returned 503, and now returns
200 with 100 lines. The route moved above that read, and takes the district
parent collections it needs (`districtRelationCollections`) through a narrow read
rather than being handed the whole store. Both halves are canaried — reverting
the move fails the budget test, dropping the narrow read fails the attribution
test, and neither canary touches the other's test.

`export.csv` and `export.geojson` were truncating too, and stayed that way for
the first pass of this work: the register's measurement — 500 of 12,929 — was a
statement about the *existing* CSV route, and a new correct route beside a
truncating one leaves the truncation on the format partners actually file. Both
now pass `unlimited: true`. The cap saved nothing there — the dispatcher has
already materialised every collection for a wide route — it only made the file
lie. Pinned in the same test file, and canaried by removing the flag.

---

## Group H — Offline-first field system (ODK/KoboToolbox class)

The outbox gives exactly-once *intent*. What it lacks is a versioned form model,
which is the primitive ODK is built on and the reason a district can change a
question without a redeploy.

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-38 | Versioned form definitions | 5 | 4 | 3.4 |
| ENH-39 | Conflict-free submission merge | 5 | 4 | 3.4 |
| ENH-40 | Durable outbox with client idempotency keys | 4 | 2 | 4.0 |
| ENH-41 | Field-level two-way sync | 4 | 5 | 2.8 |
| ENH-42 | Offline map tile packs | 3 | 3 | 3.0 |
| ENH-43 | SMS/USSD submission fallback | 4 | 4 | 3.2 |
| ENH-44 | Submission quality gates | 4 | 2 | 4.0 |

**ENH-38 — Versioned form definitions.** The CHW wizard is hard-coded
(`public/chw/app.js`, 1,179 lines). A form is a first-class, versioned artifact
(question, type, constraint, skip logic) stored server-side and served to the
client. A district changes a question without a redeploy; the mobile app and the
web wizard share one schema.

**Shipped 2026-10-11 and 2026-10-12, both halves.** The server substrate already
existed (CAP-01: `src/forms.js`, `/api/v1/forms`, immutable versions). The gap was
that the wizard never consumed it: it carried
`const CHW_SYMPTOM_FORM_VERSION = 1` and filed version 1 forever. The server keeps
every version immutable, so publishing v2 never broke v1 — the wizard went on
asking the old question and stamping a version the district had moved past, and
nothing failed. What landed:

- **The vocabulary is shared, not duplicated.** `public/shared/forms.js` holds the
  field types, the skip-grammar evaluator, the answer coercion and the built-in
  definition; `src/forms.js` re-exports them, so the browser and the server run
  one implementation rather than two that agree until they do not. This is the
  `public/shared/submission-id.js` shape.
- **The wizard files the version it rendered.** `activeForm` starts at the
  built-in (the field app is offline-first — a health worker with no signal must
  still open the wizard) and upgrades to the served definition when
  `/api/v1/forms` answers. Every submission names `activeForm.version`.
- **A served version the static screens cannot render is refused, not truncated.**
  The screens are hand-written markup; adopting a definition that adds a field
  would drop the new question silently and file a subset under a version number
  claiming the whole. `adoptableForm` refuses and `state.formNotice` names the
  question the app cannot show.
- **The served definition is rendered, not re-titled.** The wizard now draws a
  definition it has not seen: `renderForm` builds one screen per field, in order,
  and `readAnswers` reads the answers back through the same `data-field-*` hooks
  the renderer wrote, so a district's v2 that adds a question files that question
  under its own name. `RENDERED_FIELDS` is no longer the capability — the
  renderer is.
- **The built-in still renders with no signal.** The field app is offline-first,
  and its screens are still the hand-written markup `index.html` ships, drawn
  before any fetch. A definition that asks exactly the built-in's questions
  renders through those screens and files the served version; anything else is
  drawn from scratch, so the offline path is unchanged rather than merely
  preserved by a test.
- **The refusal is narrower, not gone.** `adoptableForm` refuses a field whose
  *type* the renderer has no control for — `image` would draw as a text box whose
  answer the server rejects — and names the field and the type, rather than
  adopting it and filing a silently broken answer.

**ENH-39 — Conflict-free submission merge.** Each submission carries a UUID and the
form version it was filled against. The server merges on that key, so two versions
in the field reconcile instead of overwriting. This is ODK's instanceID primitive
and the reason offline submissions are safe to sync.

**Shipped 2026-10-11.** `public/shared/submission-id.js` mints the identity on the
device, `src/submission-id.js` derives the record id from it, and both doors into
`field_reports` use it. The form version half already existed (CAP-01:
`form_id`/`form_version` on the record and validated against the version the
client named), so this item was the identity.

*The defect was live, and measured before it was fixed.* A submission delivered
three times wrote **three** records: the field-report id hashed the content
together with the server's arrival time, so it was stable for one request and
different for the next. The sharper instance is the sequence `submitOrQueue`
actually performs — POST with no key, lose the response to a timeout, queue,
retry — which wrote **two** for one report. Both reproduced against a live server
in `test/submission-id.test.js`'s own terms.

*A key minted per attempt is a nonce, not an idempotency key.* CON-06's fix made
the server's idempotency store durable and had the queue mint a key — but it
minted it when it *queued*, and the first attempt went out with no key at all. The
server had nothing to match the retry against, so a durable store bought exactly
nothing on this path. An idempotency key has to be minted per *submission* and
carried through every attempt, which is why the fix is in `submitOrQueue` rather
than in `enqueue`, and why `enqueue` now keeps a key it was handed instead of
replacing it. Two files, one rule: the identity is minted where the act happens.

*Content cannot identify an act.* The obvious repair — drop the timestamp from the
content hash — is wrong, and the test that says so is `still files two genuinely
separate reports with identical content`. A health worker filing for a second
child in the same household writes an identical body, same symptom, same
coordinates, same day. Content cannot distinguish "the same submission twice" from
"two identical submissions" because the difference is not in the content; it is in
the act. So the identity is random, and it is minted on the device.

Three canaries, each watched failing: the two server doors reverted to the content
hash (3 tests), the client stamp removed (2), and `enqueue` overwriting the
caller's key (1). The third was found *by* the canary discipline in a way worth
recording — the first client canary passed, because the existing offline tests
assert only that a queued record carries *an* `idempotency-key`, which was true
while the duplicate was live. The test was written against a stub that echoed its
argument back, and the stub could not see that `enqueue` replaced the key. Driving
the real `enqueue` over a fake IndexedDB is what made that test able to fail.

**ENH-40 — Durable outbox with client idempotency keys.** `src/server.js`
idempotency requires a client `Idempotency-Key` the service worker does not
generate (see CON-06). Mint one per queued mutation so a retry after a process
restart is deduped rather than duplicated, and make the store durable rather than
in-process-capped at 1,000 entries.

> **Shipped — verified 2026-10-12; the note was missing.** `src/idempotency.js` is the durable store: one row per key, written under the same cross-replica lock the outbox uses (`store.withLock`, ENH-63), holding the outcome as `{status, body}`. The in-process `Map` with a 24-hour TTL and a 1,000-entry cap is gone. The client half is `public/sw.js`, where every queued write carries an `idempotency-key` equal to its queue entry, so a retry after a process restart is deduped rather than duplicated.

**ENH-41 — Field-level two-way sync.** Vector-clock or per-field last-writer-wins
so an edit made offline on a phone and an edit made online in the console converge
without one clobbering the other. The hard version of ENH-39; the payoff is a
genuinely collaborative record.

**Shipped 2026-10-12.** `public/shared/field-merge.js` — a vector clock per record,
field-level merge on the partial order, each field keeping the set of its maximal
writes and `merge = normalise(union)`.

*A vector clock, and the reason is the whole entry.* A Lamport counter is a total
order, so it cannot tell "B saw A" from "B never saw A": two concurrent writes both
bump it, one is declared older, the merge picks it, and nothing is reported. That
is the silent clobber the entry exists to prevent, and an actor-id tiebreak makes
the *choice* deterministic without making the *concurrency* visible.
`compareClocks` returns a fourth answer — concurrent — and the merge keeps both
values, reports the conflict with both actors, and asks. A merge that decides when
it cannot know is the bug wearing the feature's clothes.

*Convergence is asserted rather than claimed.* Commutativity, associativity and
idempotence are each a named test, plus a seeded `mulberry32` property test over
500 random record triples and all six arrival orders of a three-replica merge. Two
canaries watched it fail first: replacing the field merge with last-writer-wins
gave 6 failures including commutativity; removing head dedup in `maximalHeads`
gave 3 including idempotence.

No `src/` twin, deliberately: ENH-39's split exists because the server needs a
sha256 the browser cannot compute, and a merge function needs nothing server-only.
A second copy would be the drift the split is meant to avoid.

> **Still no caller, 2026-10-15 — and the reason is measured, not assumed.** The
> module is imported by its test file and by nothing else. Three facts were checked
> before concluding that, and each closes a different way the wiring could have gone:
>
> 1. **No record carries a field map.** `mergeRecords` merges `record.fields`, a map
>    of field name to a set of maximal writes. Grepping `src/` and `public/` for a
>    `fields` map finds only `assertion.fields` (a list of names to check),
>    `definition.fields` (form schema), and spread-locals — no record on either side
>    of the wire has the shape this merges. Both stores write whole records:
>    `buildUpdate` (`src/operations.js:82`) is `{...existing, ...patch}`, so the
>    server's own update model is the last-writer-wins this entry exists to reject.
> 2. **No surface edits a record concurrently.** The field app only creates —
>    `public/chw/app.js` posts to `/api/v1/chw/report` three times and issues no
>    PATCH. The console's only PATCH is an online configuration toggle
>    (`public/panels/settings.js:79`, a trigger-protocol mode). So the scenario the
>    entry is named for — a health worker correcting a case status offline while a
>    district officer edits the same case in the console — has no surface that can
>    produce it.
> 3. **Nothing is silently lost in the meantime.** The queue's `markRetry`
>    (`public/shared/queue-core.js:144`) dead-letters *any* 4xx, so a 409 conflict
>    would stop retrying — but R-60 already surfaces dead-lettered records to the
>    worker (`refreshQueueStatus`, `heldBlock`), so a refused edit is visible rather
>    than discarded. That is a weaker guarantee than convergence and it is not
>    claimed to be one: the edit is still lost, the worker is merely told.
>
> Wiring it now would mean adding a vector clock to every record, a `fields` map to
> both stores, and a conflict surface — a record-format change across the whole
> platform. That is the build this entry is, and it is a larger unit than giving a
> library a route. It stays uncalled, named here rather than left to be rediscovered,
> and `test/enhancement-status.test.js` no longer uses it as its negative case — that
> subject is now `src/index.js`, which is `package.json`'s `main` and is a fact about
> the design rather than a gap.
>
> **The budget is not what blocks it, and the first draft of this note said it was.**
> That draft added "5.6 KB gzipped against 0.1 KB of first-load headroom," and the
> sentence does not carry: `check-budget` walks the graph from `index.html` through
> static `from '…'` literals, and a module behind `lazy()` is not in it. Measured —
> `node scripts/check-budget.mjs` names `panels/` 0 times and `field-merge` 0 times,
> and every panel this repo defers is loaded that way. A 5.6 KB module reachable only
> from a merge call site costs the first load nothing, so size was never the reason;
> the headroom figure was stale besides (0.5 KB as of the panel-handler extraction).
> The four facts above are the reason, and they are about surfaces and write paths
> rather than bytes. Recorded because the conclusion is right and a wrong reason is
> the part that gets reused — it would block a *different* module that could be
> lazily loaded.
>
> 4. **The server write model strips the clock, so this cannot be a client-only
>    change.** This is the measurement that settles it, and the one the first draft
>    did not make. A client could attach `record.fields` and merge its own copy, but
>    the server's update path does not carry the key: `buildUpdate`
>    (`src/operations.js:82`) spreads the patch over the existing record and hands the
>    result to a per-collection normalizer, and `normalizeFieldReport`
>    (`src/operations.js:257`) rebuilds the record from an explicit `stripUndefined({…})`
>    allowlist of 22 keys. `fields` is not among them. Measured directly — a field
>    report carrying `fields: { status: { heads: [{ actor: 'phone', clock: { phone: 1 } }] } }`
>    goes into `buildUpdate` and comes out with `fields === undefined` and the status
>    updated. A vector clock written by any client is dropped on the first PATCH, so
>    the second writer's merge sees no clock at all. Wiring ENH-41 therefore means
>    editing every operational normalizer, not adding a call site — fact 1's
>    record-format change, with a mechanism rather than an impression.
>
> **Re-run 2026-10-15, both facts, because a proof nobody re-executes is a claim.**
> Fact 4, verbatim:
>
> ```
> node --input-type=module -e "import {buildUpdate} from './src/operations.js';
>   const out = buildUpdate('field_reports', {id:'r1',summary:'x',incident_id:'i1'},
>     {status:'confirmed', fields:{status:{heads:[{actor:'phone',clock:{phone:1}}]}}},
>     {interventions:[]});
>   console.log(out.status, out.fields, 'fields' in out)"
> # -> confirmed undefined false
> ```
>
> Fact 2, by enumeration rather than by example: `grep -rn PATCH public/` returns
> **one** hit, `public/app.js:5879`'s `patchJson` helper, and `patchJson` appears
> three times in `public/` — that definition, one import, and **one** call,
> `public/panels/settings.js:79`, the trigger-protocol mode toggle. The CHW app's
> only writes are two `submitOrQueue('/api/v1/chw/report', …)` calls
> (`public/chw/app.js`), both POSTs. So there is still no surface that can produce
> the concurrent edit this entry is named for, and no record shape for the merge to
> act on.

**ENH-42 — Offline map tile packs.** `basemap.js` is inline polygons and fetches
nothing, so the offline map is a fixed asset. Let an operator define a bbox and
generate a downloadable pack (PMTiles) so a CHW's phone has the terrain for their
ward without a connection.

> **Shipped 2026-10-12, as the pack format — no HTTP route yet.** `public/shared/tile-pack.js`
> plans a bbox, writes and reads a PMTiles v3 archive, and builds a manifest a
> client verifies offline. The spec is archived verbatim with its citation at
> `docs/research/tile-packs/sources/`, and the Hilbert index and header codecs
> were cross-checked against the reference implementation rather than written
> from memory.
>
> *The manifest carries the tile id list, not a count.* A client holding a
> partial download needs to know **which** tile is absent, and a count that
> disagrees says only that something is wrong. `verifyPackManifest` names the
> missing ids.
>
> *One canary caught a live false positive.* The corner-tile completeness check
> derived its longitude edge with `floor` where the enumerator uses `ceil - 1`,
> so a complete pack whose bbox ended on a tile boundary was reported as holed.
> Latitude never diverges — the row range absorbs the difference — which is why
> a canary aimed there did not fire and the premise, not the guard, was wrong.
>
> **IMPLEMENTED 2026-10-12** by `src/routes/tile-packs.js` (two routes, dispatched
> above the store read in `src/server.js` because neither touches a collection):
> `GET /api/v1/tile-packs/plan` sizes a pack as arithmetic and works with nothing
> configured; `GET /api/v1/tile-packs` materialises the archive. 18 tests in
> `test/tile-packs-route-module.test.js`, four of them canaried by watching them
> fail.
>
> **The plan's design was wrong, and the upstreams' own policies said so.** The
> integration step was specified as reusing `loadRasterTile` — the OSM/CARTO proxy
> ADR-013 ships. Both of those upstreams prohibit exactly that, by name: the OSM
> Tile Usage Policy §4 is headed *"Prohibited: bulk downloading ("scraping") and
> offline use"* and lists *"Building tile archives (e.g. `.zip`, `.mbtiles`) for
> later distribution"*; the CARTO Basemap Terms §9.c prohibit *"downloading or
> extracting map content in bulk"*. Both documents are now archived verbatim under
> `docs/research/tile-packs/sources/`, and the reasoning that rests on them is
> written out in `docs/research/tile-packs/README.md`. OSM names the remedy in the
> same paragraph — *"use self-hosted tiles or a provider that explicitly allows
> offline/prefetching"* — so the pack source is the operator-configured
> `LINDELA_LITE_PACK_TILE_URL`, unset by default, and a pack request without it is
> a **503 naming the variable** rather than a fallback to a server whose terms
> forbid the request.
>
> *Three refusals, each by name.* Over budget (`tile_budget`, with the count and
> the ceiling); no tile server configured (`pack_source_not_configured`, 503);
> and a tile the server does not have, reported in the manifest's `missing_tiles`
> and the `x-lindela-missing-count` header rather than silently skipped — a pack
> built with holes that ships as complete renders a blank square in a ward and
> says nothing.
>
> *A falsy-zero bug found while writing the tests.* `Number('')` is `0`, a valid
> coordinate, so `?bbox=36,2.9,35.5,` would have become a bbox with its north edge
> on the equator. `Number.isFinite` cannot see it — zero is finite — so a blank
> segment is now refused explicitly. Canaried by reverting the guard.
>
> **A pre-existing dead branch, found by the same tests, in the proxy ENH-42 was
> told to reuse.** `src/server.js`'s basemap tile route branches `if (!tile)` →
> 502, and the branch could not be reached for any non-2xx upstream:
> `fetchWithRetry` raises an `HttpError` on a non-2xx, so a 404 from a tile
> server threw out of `loadTileAt` and past the route's check. A missing tile
> took the whole request down as an unhandled error instead of being reported —
> the mirror image of this feature's own defect, and it would have made the pack
> builder abort on the first hole rather than record it. `loadTileAt` now
> catches and returns `null`, which is what both callers already branch on. Two
> tests cover it (one at the proxy, one end-to-end through the route against a
> local server), both canaried.

**ENH-43 — SMS/USSD submission fallback.** A structured SMS grammar for the field
report subset, and USSD for feature phones. The RapidPro two-way layer
(`src/rapidpro.js`) already exists; this extends the inbound verb grammar to
submissions so the platform reaches the last mile it claims to serve.

**Shipped 2026-10-12.** `src/sms-grammar.js` adds one verb to `REPLY_VERBS` —
`SUBMIT`, with `REPORT` as a synonym — and a USSD session reducer
(`startUssdSession`, `ussdAdvance`, `menuFor`) for a phone with no message editor.

*The grammar validates against the form, not against a shape of its own.* A
submission names `(form_id, form_version)` and its answers are checked by
`src/forms.js`'s existing `validateAnswers` against that exact version. Inventing
a second validator here would have let a value pass SMS that the console refuses,
which is a difference in the platform's answer depending on the handset.

*Six refusals, and the district one is the load-bearing case.* `missing_district`,
`unknown_district`, `unknown_field`, `missing_answers`, `invalid_value`,
`no_form`. A report attributed to the wrong district is a real number in the wrong
place, which is worse than no report; the district is therefore required, and it
is resolved against the org-unit registry rather than accepted as free text.

*182 characters is a carrier budget, not a style preference.* A GSM-7 concatenated
SMS is billed per 153-character segment, so the grammar is measured against the
single-segment limit and a reply that would split is a test failure. USSD is a
pure reducer — `ussdAdvance(state, key)` returns `{session, reply, done}` with no
I/O — because a session that holds server state across a dropped connection is a
session that cannot be resumed, and feature-phone networks drop connections.

**ENH-44 — Submission quality gates.** GPS accuracy, timestamp skew versus receipt
time, and near-duplicate detection at submission, carried on the record rather than
silently dropped. The field-report path has a coordinate guard; generalise it to a
quality verdict so a coordinator can weight a report by how much to trust it.

**Shipped 2026-10-11.** `src/quality.js` bands the fix radius, signs the skew, and
finds near-duplicates; the verdict is stamped on the record at both doors into
`field_reports` and rolled up at `GET /api/v1/field-reports/quality`. Three
decisions worth stating.

*The gate carries, it does not act.* Nothing in this item refuses or drops a
submission. A health worker who filed a report has filed it, and a gate that
silently discards a disease signal is worse than the noise it removes — so the
doubt travels with the record instead. The test `still files the duplicate rather
than refusing it` is the one that would fail if a later change made the gate
destructive.

*Skew is signed, and the sign is the finding.* `captured_at - received_at` is
negative for a report that sat in the offline queue, which is the normal case for
the population this platform serves. A check written as `Math.abs(skew) >
tolerance` flags every queued report as a broken clock and trains an operator to
ignore the field. Only a *positive* skew is a defect: it claims a capture time
that has not happened. The client now stamps `captured_at` at filing rather than
at sending, because the offline queue transmits the body it was handed and a
stamp taken at send time would measure the queue, not the clock.

*An unmeasured axis is not a passing one.* The grade is the weakest **measured**
axis, and a report with nothing measurable grades `unassessable` rather than
`high`. Duplicates are a penalty on that minimum rather than an axis in it:
finding none is the absence of a bad sign, not evidence of a good one, and
counting an empty duplicate list as a `high` axis is how an empty store hands an
unmeasured report a clean bill of health.

Six canaries, each watched failing on the property it removes: removing the CHW
stamp (7 tests), removing the operational stamp (2), folding a missing accuracy
into a 0 m fix (3), an unsigned skew (2), duplicate-freedom as a `high` axis (1),
and dropping pre-gate records from the tally (1). The last was re-run after a
first patch broke the file syntactically — 12/12 failing is a parse error, not
evidence that the canary fired.

Two defects found while wiring it. The first is the one the register's own
premise predicts: `field_reports` has **two** doors — the CHW route writes the
collection directly, the operational API goes through `normalizeFieldReport` —
and a gate at one of them leaves half the store unmeasured. The second was found
by the tally's own test: a record with no verdict was dropped from `by_grade`
while still counted in `reports`, so one payload carried two numbers counting
different sets. It is now folded in as `unassessable` and named in
`pre_gate_records`, which keeps the two facts inside that band separable.

---

## Group I — Veracity enforcement engine (make honesty mechanical)

The platform's discipline is real but *written*, not *enforced*: a comment says
"an absent forecast is not a 0% chance," and three lines below, `?? 0` does exactly
that (VER-02). These items turn the discipline into checks the build cannot pass
while violating.

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-45 | Aggregation-kind registry | 5 | 2 | 4.6 |
| ENH-46 | Absent-value linter as a gate | 4 | 2 | 4.0 |
| ENH-47 | Unit and dimension registry | 4 | 3 | 3.6 |
| ENH-48 | Provenance-stamped exports | 4 | 2 | 4.0 |
| ENH-49 | Contingency-table integrity monitor | 4 | 2 | 4.0 |
| ENH-50 | Model-card and floor registry | 4 | 3 | 3.6 |
| ENH-51 | Reconciliation ledger | 5 | 4 | 3.4 |

**ENH-45 — Aggregation-kind registry.** Declare every metric `additive`,
`intensive` (a mean — must not be summed) or `extensive`. A helper that refuses to
`reduce` an intensive quantity makes VER-01 (precipitation summed across stations,
`src/analytics.js:452`) impossible to write rather than merely fixed. The bug is a
map of station density; the registry is the cure for the class.

**Shipped 2026-10-11.** `public/shared/aggregation-kinds.js` is the registry and
`scripts/check-aggregation-kinds.mjs` is the gate, registered `self-contained`.
The kind is read off the unit suffix, which is what the field name actually
states: `precipitation_mm` is intensive, `hazard_events` is a count and is not.

Two things the entry did not anticipate, both forced by the tree:

  - **The axis.** `mm` is intensive over *space* and extensive over *time* — 20 mm
    at five stations is one storm reported five times, 20 mm on five days is
    100 mm of accumulated rain. Same unit, opposite answers, so the registry names
    both and `aggregationKindFor(field, { axis })` defaults to space, the axis
    VER-01 got wrong. `src/flood-probability.js` sums rainfall along time and is
    correct; a registry that could not say so would have flagged it.
  - **The marker.** `aggregation-ok: <reason>`, the same discipline as the
    absent-value gate's `absent-ok:`, for rows that partition the population —
    `src/routing.js` sums journey legs, which are disjoint. It reaches the whole
    blank-line-delimited paragraph, so one reason can cover two sums it explains.

`sumField`/`meanField` are the runtime half: a `sumField(rows, 'precipitation_mm')`
throws and names the mean to use instead. A gate that says no and stops is a gate
people route around.

The gate found the class's **second live instance** on its first run: the
climate-conflict scorer summed point rainfall across stations in the same module
where VER-01 was fixed (`src/analytics.js:624`, now the mean at `:644`). Eleven
canaries, the first two being the defect and its fix side by side.

**ENH-46 — Absent-value linter as a gate.** `?? 0`, `|| 0` and `Number(null)` on a
nullable field are the repository's named defect class. A static gate over `src/`
that flags a numeric fallback on a field the schema marks nullable turns each
instance (VER-02, VER-12) from a bug found by audit into a build failure.

**Shipped 2026-10-11.** `scripts/check-absent-values.mjs`, registered
`self-contained` in `scripts/run-gates.mjs`.

One deviation from the note above, and it is the whole design. The gate does not
read nullability from the schema, because the schema does not carry it — `SCHEMA`
in `src/store.js` lists collections, not field types, and inventing a parallel
field-type table would be a second source of truth for a fact the code already
states. **It reads the declaration the tree makes instead**: a field is nullable
when the same module publishes a `<subject>_refusal` beside it. That is this
codebase's own convention for "the number is absent, and here is why" —
`src/kpi.js:301`, `src/equity.js:105`, `src/calibration.js:363` — and a module
that has adopted it has said in code that the number can be missing. A
hand-written field list was the alternative and it is the worse one: it goes
stale silently, and the field that gets added next is exactly the one nobody
remembers to add to it.

That decision is what makes the scope defensible in both directions, which is
the only thing a gate of this kind is judged on. Too broad and it flags the
`?? 0` in `data.field_reports?.length ?? 0` — a count of an array with no third
state — and it is turned off within a week, correctly. Too narrow and it stops
matching the fields that matter while still reporting a number that looks like
coverage. Twelve canaries pin both edges, and the test file asserts the canary
expectations are not uniform, so a scanner returning a constant cannot satisfy
them.

The refusal is per *site*, not per field, because the same expression is right
in one place and wrong in another: `total += row.false_alert_rate ?? 0` inside an
accumulator whose divisor is the count of measured rows is not the same act as
publishing that field in a payload. Telling those apart needs a type system; the
gate takes the conservative reading and gives the accumulator an escape hatch —
`absent-ok: <reason>`, with the reason required, so a judgement call becomes a
line a reviewer reads. It found one site in the tree, `warning_to_action_field_samples`,
which is a genuine count returned on both branches of `fieldActionLatency` and now
carries its marker.

Canaried in both directions against the real tree: injecting `?? 0` into
`src/kpi.js`'s `false_alert_rate` makes the gate exit 1 and name the site;
restoring it exits 0.

**ENH-47 — Unit and dimension registry.** Millimetres, metres, hours, people,
percent — declared with dimensions, and checked at the boundary where a number
enters or leaves. `src/analytics/numeric.js` is the absent-value gate; this is its
unit sibling. It catches a mm/metre mix that currently renders as a plausible number.

**Shipped 2026-10-11.** The registry is `public/shared/units.js`, the gate
`scripts/check-unit-mixing.mjs`, the test `test/unit-mixing.test.js`. Three axes,
not two — and the third is the one that mattered:

- **The stated defect does not exist in this tree.** A scan for `A <op> B` where
  the two names carry different unit suffixes found **zero** mm/metre mixes. The
  class is real and worth the gate; the instance the entry names is not here.
- **The instance is one axis down.** `precipitation_mm` is written into
  `climate_observations` by `src/connectors/open-meteo.js` twice under one field
  name: from `data.current.precipitation` (type `current_weather`, the *preceding
  15 minutes*, a 900-second backward-looking sum) and from `daily.precipitation_sum[i]`
  (type `precipitation_forecast`, the *whole-day total*). `computeFloodRisk` and
  `computeClimateConflictRisk` both average them. A 3.0 mm/15 min reading beside a
  40.0 mm/day reading becomes `21.5` — a number describing no period, rendered as
  a plausible one. That is the entry's own sentence with the unit swapped for the
  period.
- **The gate found two live instances in one module** (`src/analytics.js:481`,
  `:648`), the same shape ENH-45 recorded: one class, two scorers, fixed in the
  one you were looking at and live in the one you were not.
- **`UNSPECIFIED_PERIOD` is not `null`, and only two *declared* periods refuse to
  blend.** A record that never declared its period is not evidence of a different
  one; treating it as one would fail every deployment that has not been
  re-ingested. `null` means the field does not accumulate at all.
- **The gate's own first version was the failure it exists to catch.** It exempted
  any file importing `units.js` — so reverting the fix in `src/analytics.js`,
  which now imports `meanMeasured`, left the gate reporting *clean* on the exact
  defect it was written for. The exemption is gone; the canary that caught it is
  kept (`scripts/check-unit-mixing.mjs`, "still flags a bare reduce in a file that
  also imports the helper"). A gate a file satisfies by importing the fix once, at
  one site, is the 19-of-27-paths failure this repository keeps finding.
- **`compareMeasurements` contradicted `periodsPresent` and `meanMeasured`** on
  whether an unspecified period conflicts; the test caught the registry arguing
  with itself and the wildcard reading won, since two of the three already held it.

**ENH-48 — Provenance-stamped exports.** Every exported row carries `source_id`,
`observed_at` and `payload_hash` (the record already stores the hash —
`src/ingestion.js:392`). An export a partner cannot trace is an export they cannot
defend; the stamp is what makes ENH-34 citable.

> **Shipped — verified 2026-10-12; the note was missing.** `provenanceAnnotatedRows` in `src/provenance.js` stamps `source_id`, `observed_at` and `payload_hash` on each exported row, and `test/export-narrative.test.js` has a describe block titled "every exported row carries its own provenance" asserting the stamp and the `source_id=unattributed` case.

**ENH-49 — Contingency-table integrity monitor.** VER-03 is a filter and a labeller
reading different date fields (`src/flood-probability.js:101` vs `:194`), so an
event is counted but never labels a month. A check that the set admitted by the
prefilter equals the set the label function can see turns that class into a failing
test.

**Shipped 2026-10-11.** The monitor is `events_unlabelled` and `label_coverage`,
returned by `buildDistrictSamples` and published on `/api/v1/flood-probability`
beside `events_matched` (`src/flood-probability.js:130-140`; published from
`src/routes/risk.js`'s `flood-probability/models` handler — ENH-60 moved the
route out of the dispatcher, and the citation is by handler name because the
line number moved twice while this entry sat still).
Two deviations from the entry as written:

- **The label function returns the events, not a boolean.** `monthHasFlood` became
  `monthFloodEvents` (`src/flood-probability.js:220`), and the sample's `label` is
  `matched.length > 0` over the same array the monitor counts. That is what makes
  the two halves agree *by construction* rather than by two implementations that
  happen to match today — which is exactly the failure VER-03 was, one level up.
- **The residual is published, not refused.** With the date fields agreeing, an
  event the pre-filter admits and no sampled month can label is one outside the
  months the rainfall series could sample: a record from before the CHIRPS window,
  or from a month whose trailing window was too sparse to keep. That is a real
  state, so `label_coverage` reports the share rather than the fit refusing — but
  it reports, because `events_matched` alone reads as "this many events informed
  the fit" and only some of them did. `label_coverage` is `null` when no event was
  admitted, this module's convention for a ratio over an empty set.

Guarded by four cases in `test/lite.test.js`, one of which is the VER-03 canary:
an event dated only by `from` must reach the label and the coverage count. Verified
failing on the reverted labeller (1 fail, `occurred_at` alone).

**ENH-50 — Model-card and floor registry.** Every model publishes its basis, its
sample floors and its refusal vocabulary in one machine-readable place
(`MODEL_BASIS` is the seed). `check-no-flood-probability.mjs` reads it today; a
registry lets every surface render "not measured" from the same declaration the
model refuses with.

**Shipped 2026-10-12.** `src/model-registry.js` — a card per published model, with
`modelCard`, `floorsMissed`, `refusalSentence` and `refusalCodes`.

*The floors are imported bindings, not restated numbers, and that is the whole
design.* `months` **is** `MIN_MONTHS` — the same binding the model refuses with.
`gate.py` existed twice in `infra`, production ran the second, a checker read the
first, and four correct slugs were reported as phantoms. A registry that retyped
`60` would be that bug respelled: it passes `value === 60` while the model moves
to 72. So the test asserts each floor is its declared binding, and a second test
fails outright if any floor is written as a numeric literal. Canaried — retyping
`MIN_MONTHS` as `60` fails it.

*The refusal vocabularies are declared as they are, not as they ought to be.* The
first draft gave every model a code list. Only counterfactual has one; the other
five refuse in prose (`{ psi: null, reason }`, `{ score: null, reason }`,
`skipped_reason`). Inventing codes would have made the registry match nothing —
the failure the module's own header warns about — so those cards carry
`codes: null` and a note naming how the model actually refuses. `null` rather than
`[]`, because "no vocabulary" and "an empty vocabulary" are different claims.
`COUNTERFACTUAL_REFUSALS` is now exported from the model and imported here, and a
canary that copied the list instead failed the identity assertion.

*An absent observation is unverified, not met.* `floorsMissed` refuses to call a
floor satisfied when the caller did not supply the count, which is the house rule
applied to a registry: a check that measures nothing must not report success. Two
floors (`baseline_imbalance`, `radius_ratio`) refuse when the value is too
**large**, which a single `<` comparison would wave through.

**ENH-51 — Reconciliation ledger.** Join the bitemporal history and the provenance
layer so every published number traces to the inputs and the run that produced it,
and a number that changed with unchanged inputs (already logged at
`src/analytics.js:417`) becomes a reconcilable event rather than a log line. This
is the substrate for the determinism claim in ENH-76.

> **Shipped 2026-10-12 — IMPLEMENTED.** `src/reconciliation.js` classifies every
> published number into four outcomes, not one: `reconciled` (value moved, inputs
> moved), `changed_without_input_change` (not a function of declared inputs — names
> the clock or seed if the run declared one, else says `unknown`),
> `unchanged_with_input_change` (an input not wired in — names the fields that
> moved), and `cannot_trace` (no provenance, a half-written envelope, no prior
> observation). The fourth is a refusal and is never folded into agreement:
> `reconcileRun` reports `measured`, `untraced` and `first_sight` as separate
> counts, so a run that compared nothing reports `measured: 0`. ENH-23's
> `reconcileDerivedNumbers` detected **one** of the four, only above a 5% band, and
> stored a row; the ledger answers "did it change at all" and leaves the band to
> ENH-23. Joins bitemporal history, `buildProvenance` envelopes and the analytics
> `input_counts`, keyed on the imported `derivedKey` so it cannot drift from the
> analytics key; events carry clock-free `stableId` ids so re-reconciling a pair
> updates rather than duplicates. The ledger is an append-only hash chain reusing
> `audit-chain.js`. 21 tests. The first canary of the `traceAfter` guard *passed*
> because `traceBefore` masked it — the guards were isolated and re-canaried
> (`traceAfter` fails 1, `traceBefore` fails 2) before the coverage was believed.

---

## Group J — Decision and planning (novel operational paradigms)

The platform reports. It does not yet *decide*, and the difference is the whole
point of an early-warning system.

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-52 | Anticipatory Action trigger engine | 5 | 4 | 3.4 |
| ENH-53 | Resource pre-positioning optimiser | 5 | 5 | 3.0 |
| ENH-54 | Value-of-information estimator | 4 | 4 | 3.2 |
| ENH-55 | Scenario comparison workbench | 4 | 4 | 3.2 |
| ENH-56 | Compound-hazard risk model | 5 | 5 | 3.0 |
| ENH-57 | Scheduled multi-audience briefing | 4 | 3 | 3.6 |
| ENH-58 | Counterfactual impact evaluation | 4 | 5 | 2.8 |

**ENH-52 — Anticipatory Action trigger engine.** A forecast crossing a declared
threshold fires a pre-agreed action within a funding window, with the trigger, the
crossing and the action all recorded. This is the paradigm shift from "here is a
risk score" to "here is what happens next and who is funded" — the reason
anticipatory action exists as a field.

> **Shipped 2026-10-12 — IMPLEMENTED.** `src/anticipatory-action.js`. Two things
> must hold before a trigger fires, and both are refusals rather than warnings.
> The model must not refuse for the region: the model card's own refusal or a
> missed floor is returned as-is, checked **before** the threshold comparison so
> the operator reads the model's sentence rather than a comparison against an
> absent value — an unsupplied floor refuses too, because it is unverified rather
> than met. The crossing must fall inside the funding window, checked **first**
> because `NaN` compares false in both directions and an unreadable bound would
> otherwise fall through to the fire branch, a fail-open on the one authority
> constraint; a crossing outside the window is still recorded as an audit fact
> with `fired: false`. Vocabulary is the siblings', not a parallel copy —
> operators re-exported from `alerts.js` (the list `parametric.js` validates
> against), the name limit from `parametric.js`, the model check through
> `modelCard`. The named metric is read only from `forecast.metrics`; a top-level
> `value` never stands in, which would be the silent-key-list defect. The
> crossing id is content-only, so re-evaluating is idempotent. 27 tests; disabling
> the window check drops the run to 22/27, so the window tests fire on their own
> defect.
>
> **Served since 2026-10-14.** `POST /api/v1/anticipatory/evaluate` in the compute
> family — the module was a library with no caller, which made every property above
> unobservable. The route normalises every trigger *before* evaluating any, so a
> malformed declaration is a 400 naming the field rather than a half-run trigger
> set; a fired crossing writes one `action_logs` row and emits one outbox event,
> both counted. A refusal stays a 200 with the model's own sentence beside it.
> `test/compute-route-module.test.js` drives all of it.

**ENH-53 — Resource pre-positioning optimiser.** Given the forecast distribution
and the road network (`src/road-access.js`), compute where to stage stock to
minimise expected unmet demand. A stochastic allocation over the uncertainty the
platform already carries, not a point estimate.

**Shipped 2026-10-12.** `src/prepositioning.js` — `planPrepositioning({ demandSites,
stagingSites, budget, data, now, scenarios, seed, draws, steps })`, greedy marginal
allocation on `E[unmet] = Σ_k E[max(0, G_k − r_k·A_k)]` over the forecast
distribution rather than its mean.

*The road network is a reliability, not a distance.* Transport comes from
`computeRoadAccess` plus the nearest road inside `ROAD_LINK_RADIUS_KM` (50), and
`ROUTE_RELIABILITY_BY_LEVEL` scales the delivered quantity: open 1.0, constrained
0.6, severely_constrained 0.3, cut_off **0**. That last value is the point of the
item — a route the flood has cut delivers nothing, and an optimiser that treats it
as a slow route stages stock behind a severed road. A point-estimate allocator
cannot represent this, because the loss is in the tail of the access distribution
and the mean access is a number no single dispatch ever experiences.

*Measured, not asserted:* the optimised plan leaves `expected_unmet` 75 against the
naive allocation's 87.5 — 12.5 units, 14.29%. Nine refusals, including a staging
site that cannot reach any demand site and a budget that buys nothing.

**Served since 2026-10-14.** `POST /api/v1/prepositioning/plan` in the compute
family. Every refusal is a 200 carrying its reason, never a 4xx — an unusable
budget or an unlocatable demand site is an answer the caller asked for, and only a
malformed request is a 400. `test/compute-route-module.test.js`.

**ENH-54 — Value-of-information estimator.** Rank the *data gaps* by how much
closing each would reduce decision loss. Turns the honesty about what is not
measured (all seven regions currently refuse drift with a reason) into a
procurement priority.

**Shipped 2026-10-12.** `src/value-of-information.js` — EVPI over entropy. A gap's
value is the expected loss its closure removes, in closed form
`loss·(high−threshold)²/(2·(high−low))` for a uniform posterior, so a gap is ranked
by a number with a unit rather than by how alarming its name sounds.

*The gaps are read off the refusals that already exist, not enumerated anew.*
`driftGaps` consumes the structured `input_shift` / `outcome_divergence` verdict
objects `src/drift.js` produces; `freshnessGaps` enumerates `never_run`, `broken`
and `empty_response` from `freshnessReport`. This is the item's whole leverage:
the platform already refuses to model seven regions for want of data, and those
refusals were a dead end. They are now a ranked list, and the ranking cannot drift
from the refusals because it is computed from them — the thresholds come from
`MIN_DRIFT_WINDOW_MONTHS` and `MIN_DRIFT_EVENTS`, the same constants that fire the
refusal.

*A gap with no threshold has no value, and that is a refusal.* EVPI needs a
decision boundary; without one there is nothing to be uncertain *about*, and
reporting a large number for it would rank a gap that closing cannot change.

**Served since 2026-10-13.** `GET /api/v1/data-gaps` in the derived family, over
`src/data-gaps.js` — the store adapter that reads the refusals and hands them to
the estimator. `test/data-gaps-route.test.js`.

**ENH-55 — Scenario comparison workbench.** Side-by-side interventions with their
uncertainty, over the same region and window, so a coordinator compares rather
than reads one number at a time.

> **Shipped 2026-10-12 — IMPLEMENTED.** `src/scenario-compare.js` compares two
> interventions over the same ground and carries each one's uncertainty rather
> than a point difference — a comparison of two numbers without their intervals
> is a comparison of two draws. 20 tests.
>
> **Served since 2026-10-14.** `POST /api/v1/scenario-comparisons` in the compute
> family. Two scenarios whose intervals overlap come back as an unresolved order
> with a reason rather than resolved by the means, which is the property the
> module exists for and which no test could reach through the product until now.
> `test/compute-route-module.test.js`.

**ENH-56 — Compound-hazard risk model.** Flood, conflict and disease interact
(`computeClimateConflictRisk` exists in isolation). A joint model with explicit
dependence beats three independent scores a planner must combine by hand.

> **Shipped 2026-10-11, for two of the three hazards — PARTIAL.** `src/compound-hazard.js`
> counts the joint contingency over calendar months: flood-months, conflict-months,
> and the months that are both, in one radius. Dependence is stated as a **lift**
> — the joint rate over the product of the marginals — which is the number the two
> independent scorers discard. Two regions with identical marginals but different
> lift get different scores, and a test asserts exactly that, because a joint model
> that agrees with the marginals is a weighted sum wearing a joint model's name.
>
> **The refusals are the substance.** A window shorter than `MIN_COMPOUND_MONTHS`
> (12) returns `score: null` and a sentence naming the count, not a modelled number:
> a copula fitted to eight months is a curve drawn through noise and it would carry
> the authority of a probability. A window in which one hazard never occurred also
> refuses, because the joint rate is then undefined rather than zero, and a zero
> would read as "safe" when it means "this window contains no instance of one of
> the two". Lift is null rather than a number when a marginal is zero — `0/0` is no
> denominator, not "no dependence".
>
> Three things the entry does not get, recorded rather than glossed:
>
> 1. **Disease is not in it.** The entry names three hazards; this counts two. The
>    disease observations are not scored in this shape and no dependence between
>    them and the other two is measured. The module's joint rate is flood × conflict.
> 2. **Consecutive months are not independent draws.** They share a season, so the
>    window is named on every record rather than assumed representative. The
>    envelope says so under `notIncluded`.
> 3. **The hazard family is a judgment, stated.** GDACS emits flood, storm,
>    landslide, drought, earthquake, fire, volcano and a `disaster` bucket for codes
>    it cannot map. `FLOOD_FAMILY` counts flood, storm and disaster. A drought-month
>    is the opposite of a flood-month and a fire has no water in it, so counting
>    either would inflate the joint rate with months that share nothing but a
>    calendar.
>
> Served at `GET /api/v1/compound-risk` beside `/api/v1/conflict-risk` and
> `/api/v1/flood-risk`, not in place of them — the marginals answer "how bad is the
> flood", the joint answers "how bad is the convoy that cannot move", and a planner
> needs both. 15 tests; the full suite is 3591 passing.

**Shipped 2026-10-12, closing the third hazard — IMPLEMENTED.** The note above
listed disease as the first of three things the entry does not get.
`compoundHazardScoreThree` counts flood, conflict and disease jointly and reports
the whole contingency — all seven month-classes — with the triple lift against the
product of the three marginals and the pairwise lifts beside it, because a planner
acting on this needs to know *which* pair drives the excess.

*A separate function, not a third optional argument.* Making disease optional
would leave every existing two-hazard caller with `p_disease === 0`, which is
exactly the condition that already refuses with "no disease-month in this window"
— so all 15 existing tests would have gone from a score to a refusal. A second
entry point keeps the two-hazard contract intact; those 15 pass unchanged.

*The disease input is shaped differently, and both differences are silent.*
Disease records carry `observed_at` where hazards and conflicts carry
`occurred_at`, so a reader that reads only the latter counts zero disease-months
and reports the hazard absent — a refusal that looks like a finding about the data
and is a bug in the reader. Canaried: reverting it produced 6 failures. And
WHO-GHO rows are national *annual* aggregates stamped `YYYY-01-01`; counting them
manufactures a January disease-month in every year of the series. They are
excluded by the marker `who-gho.js` already sets, and the exclusion count is
returned rather than dropped silently, because a dropped input is a denominator
nobody can check.

Each absent hazard is named separately: with three, "no hazard-month" would not
say which, and the three have different remedies — no disease is a surveillance
gap, no flood is a dry record.

**ENH-57 — Scheduled multi-audience briefing.** `src/narrator.js` audits its own
output against the fact set. Extend it to scheduled generation of role-specific
briefings (district officer, national coordinator, partner) from the same grounded
fact set, so the narrative cannot invent a figure for any audience.

> **Shipped 2026-10-12 — IMPLEMENTED.** `src/briefing.js` builds three audiences
> (district officer 90 words, national coordinator 140, partner 110) from one
> report's own sections. The audience changes what is said, never what is true: a
> briefing is a **selection** over the fact set, declared rather than written into
> a prompt, because a rule expressed as prose is a rule the model may follow or
> not. Two mechanisms keep an unentitled figure out, deliberately separate — the
> fact set handed to the model is already narrowed, so a withheld figure is absent
> from `allowedNumbers` and restating it is caught by the existing figure audit
> (the same refusal path, not a second one); and an audience with no permitted
> facts is refused `no_permitted_facts` rather than written short, because an
> empty briefing reads as "nothing to report" — a claim about the situation when
> the truth is a claim about entitlement. The section names are `reports.js`'s own
> `SECTION_LIBRARY`, checked at import: I first wrote `hazards`/`access`/`actions`,
> which match nothing, and every briefing would have refused
> `no_permitted_facts` — a refusal an operator reads as "no data". `narrateReport`
> accepted `maxWords` and never passed it, so the per-audience lengths would have
> been dropped; fixed, and canaried. Scheduling is a function of an injected clock,
> keyed per period so re-running a day is a no-op rather than a second email; an
> unreadable instant is due for nobody, not for everyone. 21 tests, canaried three
> ways.
>
> **The caller, added 2026-10-15.** The module was complete and reached by nothing:
> `narrateBriefings` had no route, so no audience was ever briefed. `POST
> /api/v1/reports/{id}/briefings` (`src/routes/reporting.js`) now generates one
> briefing per audience from a report's own sections and records them on the report
> beside `narrative`, which is a field the normalizer owns, rather than in
> `metadata`, which is a free-form bag a client may overwrite. Two failures the
> route had to be written around, both of which the module could not see: a body
> carrying `env` or `http` must not reach `narrateReport`, which takes both as
> injectable transports — a test seam, and from a route an exfiltration path that
> posts the report's own sections to a host the caller chose, so nothing from the
> body is spread into those options and the test asserts the model call goes to the
> environment's base URL; and an unknown audience name must be a 400, not a 500,
> because `narrateBriefings` indexes the registry and throws a TypeError, so a
> misspelled field was answered as a server fault. A refusal stays a 200 — it is a
> statement about entitlement, not about whether the request was well formed.
> 10 tests, two canaried.

**ENH-58 — Counterfactual impact evaluation.** Given a dispatch and a matched
comparison set, estimate what the intervention changed. This is what turns the
platform from a reporting tool into an accountability one.

**Shipped 2026-10-12.** `src/counterfactual.js` — pooled difference-in-differences,
`ATT = (mean_after − mean_before)_treated − (mean_after − mean_before)_comparison`,
with a unit bootstrap (2000 seeded `mulberry32` draws, default seed `0x9e3779b9`)
for the interval.

*The counterfactual is the comparison arm's own change, which is the whole
method.* Subtracting the comparison arm's before-and-after removes whatever moved
both arms — a seasonal flood peak, a reporting change, a national campaign — that
a before-and-after of the treated arm alone would attribute to the dispatch. The
entry's claim that this is what makes the platform accountable is exactly this
distinction: an unadjusted difference is a number that flatters every
intervention.

*Five refusals, and each names a way the estimate would be an artefact.*
`thin_comparison_arm` and `thin_treated_arm` (`MIN_ARM_UNITS` 3) — a difference of
means over two units is noise with a sign. `mismatched_comparison_set` — the arms
must cover the same period or the difference includes the mismatch.
`baseline_imbalance` (`BASELINE_TOLERANCE` 0.5) — arms that did not start
comparable cannot be differenced. `no_variation` — a field that never moved
cannot carry an effect. A sixth condition, `RADIUS_RATIO_MAX` 1.5, rejects a
comparison set drawn from a materially different catchment.

---

## Group K — Platform substrate (throughput, concurrency, observability)

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-59 | Single route-table generator | 5 | 3 | 4.2 |
| ENH-60 | Router extraction from the god object | 5 | 4 | 3.4 |
| ENH-61 | Streaming cursor reads | 5 | 3 | 4.2 |
| ENH-62 | Content-addressed derived cache | 4 | 3 | 3.6 |
| ENH-63 | Durable cross-replica idempotency + outbox lock | 5 | 3 | 4.2 |
| ENH-64 | End-to-end request/correlation id | 4 | 2 | 4.0 |
| ENH-65 | Per-server state, not module globals | 4 | 2 | 4.0 |
| ENH-66 | Backpressure and admission control | 4 | 3 | 3.6 |
| ENH-67 | Read-replica split with a query budget | 4 | 4 | 3.2 |

**ENH-59 — Single route-table generator.** Five tables describe the routes and
drift: `src/server.js` (68 literal conditions + 16 helpers), `src/route-manifests.js`
(183 entries), `docs/openapi.yaml` (150 paths), `src/auth.js` scopes (91 entries)
and the client's 29 endpoints. Generate all five from one declaration. Adding a
route then touches one file, and "nine live routes went undocumented" cannot recur.

> **PARTIAL — still no generator, and the reason is worth stating.** The five
> tables still exist and are still hand-kept. What landed instead (ARC-02, and the
> same entry's remedy is *not* what shipped) is the repair of the cross-checks:
> every existing check had the same blind spot, and it was that blind spot rather
> than the duplication that let `/api/v1/districts/{id}` be served, fetched by the
> district portal on every page, and documented nowhere. `check-openapi.mjs` now
> reads the dispatcher body as a third route family, so an inline `.match()`
> written directly in the request handler is no longer invisible.
>
> A generator is a larger change than it reads as: it has to own `docs/openapi.yaml`
> (1,000+ lines with prose descriptions that no declaration carries), the auth
> scopes, and the client's endpoint list — and the client's 29 endpoints are
> *call sites*, not declarations, so generating them means rewriting the callers.
> That is the honest reason it is still partial rather than an oversight.
>
> **2026-10-12, and the blind spot had a twin.** The paragraph above is about the
> *documented-and-unserved* direction. Chasing the tile proxy found the mirror:
> a route served by the server, called by the console on every map render, and
> absent from every table — invisible to `check-openapi` from both sides at once,
> so the check reported a clean `174 documented, 174 served` straight over it. The
> cause was a spelling, `/(\/a\/b)/.exec(url.pathname)` against the
> `pathname.match(/…/)` the parser read, and the consequence was larger than a
> missing document entry: the route also sat *below* the dispatcher's store read,
> so every tile of every pan materialised the whole store to answer a request that
> reads no collection. The parser reads both spellings in both families now, the
> family is `src/routes/basemap-tiles.js` above the read, and the table named it
> unmapped the moment the parser could see it. Recorded in full under ARC-02; the
> lesson for this entry is that the cross-checks are only as wide as the parser,
> and a route the parser cannot read is a route no check built on it can find —
> which is the argument for one declaration rather than five tables, made from the
> other end.
>
> **The fifth table is now checked too, 2026-10-12.** ARC-02 names five
> descriptions of the route surface; four had a cross-check and the client's call
> sites had none. `scripts/check-client-endpoints.mjs` is the eighteenth gate: it
> reads the client's `/api/v1/…` literals out of `public/` — 143 of them — and
> asks the same `route-surface.mjs` derivation the document check uses, so a
> family that moves out of the dispatcher needs no edit in it. The failure it
> prevents is the console swallowing a 404 into an empty panel, which reads as
> "no data" rather than "no route" — QUA-07's silent-empty class reached from the
> caller's end instead of the route's.
>
> Its scope took one correction worth recording, because the first draft had
> exactly one finding on a clean tree and it was wrong. The finding was
> `/api/v1/readyz` in `public/sw.js` — inside the comment explaining that the
> entry was removed for being a route the server has never served. A gate whose
> only finding on known-good input is a sentence about its own subject is a gate
> that gets deleted, and this repository has that lesson written down four times
> over. It strips comments now, and accepts a literal that is a proper prefix of a
> served path, because the client completes built paths at call time
> (`/api/v1/basemap/tiles/osm` + `/{z}/{x}/{y}.png`).
>
> So the position on this entry is now: **five tables, five cross-checks, still
> five tables.** That is the honest state. A generator would replace the tables;
> what has been built is the network that keeps them from disagreeing silently,
> which is a strictly weaker property and a strictly cheaper one to reach. ENH-59
> stays PARTIAL for the reason it always had.
>
> **The reason, measured rather than argued, 2026-10-15.** The paragraphs above
> say a generator is larger than it reads as. That is a claim about how much of
> each table is a function of a route declaration, and it can be counted. It was
> counted, with `route-surface.mjs`'s own derivation over all 37 sources:
>
> | Table | Entries | Derivable from the route declaration? |
> |---|---|---|
> | Matcher paths (exact `pathname === '…'`) | **115** distinct (122 occurrences) | Yes — this is the declaration, and it is already machine-readable |
> | Matcher paths (regex `.match(/…/)`) | **35** | No. The path structure lives in a pattern, not in a value: `/(\/a\/b)/` and `/a/:id` are different objects and only one of them is a declaration |
> | `docs/openapi.yaml` | **188** paths, ~261 prose lines | Partly. The path keys derive; the descriptions are sentences no declaration carries |
> | `src/auth.js` scope rows | **130** | No. A scope is a *policy* about a path, not a property of it — the same path takes `read:x` on GET and `admin:x` on POST, and `role:chw\|write:incidents` has no representation in a path at all |
> | `src/route-manifests.js` | **235** | No, and by design: the file says its lists are *measured*, by driving each route against a real server with the read instrumented. A generator would replace a measurement with a guess |
> | Client call sites (`public/`) | **135** literals, 74 distinct | No. These are call sites — the path is an argument at the point of use, and generating them means rewriting the callers |
>
> The count is the argument. **115 of 188 documented paths** (61%) could come from
> the matcher declaration today; the remaining 73 carry something a path literal
> does not — a regex's structure, a scope's policy, a manifest's measurement, or a
> caller's argument. A generator that produced only the derivable 61% would be a
> sixth table, which is the failure mode this entry exists to name.
>
> This is the same shape as the ENH-41 note: the conclusion was right and stated
> as an impression, and an impression is not reusable. The figure that matters is
> that the *imperative matcher* is the load-bearing obstacle — 35 regex matchers
> and 127 exact comparisons across 36 route modules, none of which exposes its
> path as a value a generator could read. Declaring the paths first is the
> prerequisite, and that is ENH-60's residue rather than a table to write.
>
> **The reason was wrong, 2026-10-15, and the conclusion survives it.** The
> paragraph above says a regex's structure "is not a value a generator could
> read". That is checkable, and it is false — `scripts/route-surface.mjs` has read
> exactly that since `6a5bf6f`, and it is the same derivation four gates already
> run on. Measured at HEAD:
>
> ```
> node --input-type=module -e "import {servedRoutePaths,routeSources} from
>   './scripts/route-surface.mjs'; const {paths,coverage}=servedRoutePaths('.');
>   console.log(paths.size, coverage.parsed.length, coverage.unparsed.length)"
> ```
>
> gives **193 paths, 37 matchers parsed, 0 unparsed**. Resolving the capture
> groups is not an approximation: `/(\/api\/v1\/(alert-rules|alert-events)(?:\/([^/]+))?)/`
> yields all four of `/api/v1/alert-rules`, `/api/v1/alert-events`, and both
> `/{id}` shapes, and **78 of the 193 served paths have no literal spelling
> anywhere in `src/`** — `/api/v1/alert-events/{id}.cap`,
> `/api/v1/trigger-protocols/{id}/backtest` — so those 78 are derived from regex
> and from nothing else. `check-openapi` compares against this set, which is why
> `/api/v1/alert-events/{id}.cap` is in `docs/openapi.yaml` at all: it could only
> have got there from the pattern.
>
> So the matcher is **not** the obstacle, and the "61% derivable" figure understates
> the derivable set for the same reason — it was counted from literal spellings,
> which is the subset, not the surface. The obstacle the entry is actually up
> against is the other three tables, and the reason they resist is in the table
> above and is sound: a scope is a policy about a path, a manifest is a
> measurement of what a handler reads, and a client literal is an argument at a
> call site. Those are not properties of a path, so no path declaration can carry
> them. That is a real argument for ENH-59 staying PARTIAL; "the matchers are
> imperative" was not, and it had the additional cost of naming a prerequisite
> (declare the paths first) that was already discharged. The conclusion held, the
> reason did not, and the reason is what the next reader reuses.
>
> **Shipped 2026-10-15, and the paragraph above is the one that was wrong.** Its
> closing sentence — "those are not properties of a path, so no path declaration
> can carry them" — is the whole error, and it is one word wide. A scope is not a
> *property* of a path; it is a *value* associated with one, and values live in a
> declaration. The three measurements that settle it were all run before this
> paragraph was written and none of them was read as an answer:
>
> - **The join is total.** The spec's 233 operations ≡ the manifest's 233 entries,
>   exact set equality on `(METHOD, path)`, zero duplicates on either side, zero
>   one-sided. A total join is what a generator needs; it was recorded as a
>   difficulty.
> - **The hardest block round-trips byte-exact.** The 3,931-line `paths:` block
>   reconstructs from a structured model to `BYTE EQUAL: true` — 193 paths, 233
>   operations, 11 true separators, every block scalar preserved.
> - **The matcher was never the obstacle**, which the paragraph above had already
>   conceded.
>
> So the difficulty was real but mis-stated: a scope is *policy*, a manifest is a
> *measurement*, prose is *text* — none is a function of the path, and all are
> values. `src/route-declaration.js` carries them: 233 frozen entries, each with
> `method`, `path` (the spec's spelling), `scope`, `reads`/`wide`, `history`, the
> 130 comment lines of reasoning, and the verbatim spec body. Two files are now
> outputs of it and two gates hold them:
>
> | Output | Generator | Held by |
> |---|---|---|
> | `docs/openapi.yaml` | `scripts/generate-openapi.mjs` | `check-route-drift.mjs` |
> | `src/route-manifests.js` | `scripts/generate-route-manifests.mjs` | `check-route-drift.mjs` |
> | the declaration itself | — | `check-route-reachability.mjs` |
>
> **Two tables are deliberately not generated — but the first reason given for
> that was backwards, and the measurement is below.**
>
> The claim was that the scope tables are "the one place where a mistake *opens*
> a route rather than closing one", so generating them would be the risky
> direction. Measured on 2026-10-15, it is the other way round:
>
> - **The two forms agree on every declared operation.** All 233 declared
>   operations resolve through the hand-kept prefix table to exactly the scope
>   the declaration names — **0 differences**. A per-operation generated table
>   would reproduce that set exactly.
> - **They differ on a route that is served but *not* declared**, and there the
>   prefix table is the one that opens the route. A new
>   `POST /api/v1/alert-events/acknowledge`, absent from the declaration, resolves
>   to `admin:alerts` under the prefix table and to `DENIED_SCOPE` under a
>   per-operation table. The hand-kept form **fails open by prefix**; the
>   generated form **fails closed**. So the argument that the hand-kept table is
>   the conservative choice is exactly inverted, and it is `check-route-reachability.mjs`
>   — not the table's form — that is doing the work of keeping the declared set
>   complete.
>
> What actually keeps the tables hand-kept is **comment density, not risk**. The
> two tables carry 187 comment lines against 128 rows: `READ_SCOPES` is 78 rows
> with 97 comments, `WRITE_SCOPES` 50 rows with 90. Those comments are the
> policy — why `/exchange` gets a scope of its own rather than
> `read:integrations` (ENH-80), why an annotation is `read:incidents` and not a
> scope of its own (ENH-74), why `field-reports/quality` needs a row when
> `/field-reports` already has one (ENH-44). A generator that emitted 226 rows
> would have to carry 187 lines of per-row rationale the declaration does not
> hold, or drop it. That is a reason to keep the file, and it is a different
> reason from the one written here first.
>
> The tables are proved rather than generated: every declared operation must
> resolve to the scope the declaration names (the 0-difference measurement above,
> asserted by `test/route-declaration.test.js`), and no row may match zero served
> routes. That second assertion found a real defect the day it was written —
> `['/api/v1/triggers', 'read:alerts']` and `['/api/v1/parametric', …]` in both
> tables matched nothing, because the routes are `/api/v1/trigger-protocols` and
> `/api/v1/parametric-rules` and a `/` boundary means the short form covers
> neither. Four rows that read as policy and decided nothing; removed. Client
> call sites stay *validated* by `check-client-endpoints.mjs` rather than
> generated, which is the correct relationship and was already true.
>
> **The open question this paragraph left was closed in the same commit that
> wrote it** (2026-10-15, `3715a05`). It said nothing asserts that a
> served-but-undeclared route is denied rather than granted, and that a test
> asserting the denial "is not in this item". The test is in the item:
> `test/route-declaration.test.js` *denies a served route that is not declared —
> the prefix table fails open, so this pins the pairing* pins
> `declaredScopeFor('POST', '/api/v1/alert-events/acknowledge')` to `admin:alerts`
> as the positive case, asserts that route is absent from the declaration, and
> then restates the reachability gate's own set equality through the gate's own
> `shape()` rather than a second normalisation — "a test that relies on a gate it
> does not run is a test that passes when the gate is deleted", which is why it
> imports `servedRoutePaths` and `shape` from the gate instead of trusting it.
> Canaried 2026-10-16 by planting `if (pathname ===
> '/api/v1/alert-events/canary-undeclared')` in `src/routes/alerting.js`: the test
> fails naming the path. The reason this paragraph is left standing rather than
> deleted is the register's own recurring one — the conclusion (a test was
> missing) was right and the state (it had just been written) was not.
>
> **The manifest values are still measured — generation distributes, it does not
> invent.** `collect-route-manifests.mjs` drives each route against a real server
> with the store instrumented and *prints* the closure; it never wrote the file.
> The declaration now stores that measurement and the generator emits it, so the
> "a generator would replace a measurement with a guess" objection in the table
> above is answered rather than ignored: the measurement is the input.
>
> **The check this item was written for is now automated.** `/api/v1/districts/{id}`
> was served, fetched by the console on every page, and in no table — invisible to
> every check built on the tables, because it was absent from all of them in the
> same way. `check-route-reachability.mjs` derives the served set from the
> imperative matchers through `scripts/route-surface.mjs` and requires set
> equality with the declaration, so the next route in that shape fails a gate
> instead of surviving four days of hand sweeps.
>
> **Two defects in the published spec, found while reading it as data.** Both are
> the item's own class — text that reads as documentation and reaches nobody —
> and both were invisible to every check because each one is a *string* the checks
> search for, and the string was there:
>
> - `GET /api/v1/calibration/by-region` carried a stray key
>   `summary_note_removed: true` — a note-to-self from `7be1df9` that leaked into
>   the published document, where a client reads it as an OpenAPI extension. No
>   tool in the tree reads the name.
> - `GET /api/v1/history/{id}` declared `description:` **twice**. YAML keeps the
>   last, so the first — the paragraph explaining that the path capture is the
>   collection name and the API reference spells it `:collection` — was
>   unreachable dead text that read as documentation. Its content is merged into
>   the surviving description rather than dropped, since the explanation was
>   right.
>
> `validate.mjs` string-matches the spec rather than parsing it, so neither
> could fail it. Reading the document as a data structure is what surfaced them,
> which is the same move the whole entry is about.
>
> **What it cost, recorded so the next estimate is better.** The bootstrap is 357
> lines, the two generators 286, the two gates 321, the three driving tests 514, and
> the declaration 5,710. The expensive part was not any of those: it was that three
> separate hand-kept tables had to be *joined* before they could be replaced, and
> the join was assumed hard because nobody had tried it. It took one query.
>
> **IMPLEMENTED 2026-10-15 — the verdict, said in the word the other fifty use.**
> Every paragraph above is dated history and the last of them still argues "ENH-59
> staying PARTIAL", so the entry read as open to anyone who stopped at its own
> heading while the verdict table two hundred lines up moved this item to
> IMPLEMENTED in the same commit. Nothing compared the two. This is the ENH-60
> failure one entry over, and it recurred because the fix was written into ENH-60's
> entry rather than into the shape of the register: a dated paragraph records what
> was true when it was written, and a *verdict* is a separate claim that has to be
> restated when it changes. What shipped is `src/route-declaration.js` (5,805 lines,
> one `(METHOD, path)`-keyed entry per operation), `scripts/generate-openapi.mjs`
> and `scripts/generate-route-manifests.mjs` emitting `docs/openapi.yaml` and
> `src/route-manifests.js` from it, and two registered gates —
> `check-route-drift.mjs` (a committed file differs from its regeneration) and
> `check-route-reachability.mjs` (a declared route is served by no matcher, or a
> matcher serves a route no declaration names). The scope tables stay hand-kept and
> that is a decision, not a residue: a scope is policy, and
> `test/route-declaration.test.js` proves the agreement instead. What remains open
> is a duplicate-key gate for the whole spec — the one live instance was fixed here,
> and a general check is a separate unit.

**ENH-60 — Router extraction.** `handleApiRequestInContext` was 1,597 lines
(`src/server.js:763–2360` <!-- line-drift-ok: the range as audited; ENH-60 is IMPLEMENTED and the dispatcher is 88 lines now, at `src/server.js:1000–1087` -->) and entangled routing, auth, validation, business logic
and serialisation. Behind the ENH-59 table it splits into ~15 modules, each
testable in isolation. This unblocks every other substrate item.

> **PARTIAL — 2026-10-12. Thirty-three families are out; the dispatcher is not
> gone.** Every route *family* now lives under `src/routes/` with its own
> matcher, its own test file, and a property that makes it a family rather than a
> set of blocks. The dispatcher went 1,903 → 411 lines and `server.js` 5,603 →
> 2,009. (The count is *matchers*, not files: 32 modules under `src/routes/`, one
> of which — `alerting.js` — carries two, `matchAlertingRoute` and the
> non-exported `matchTriggeringRoute`. An earlier version of this line recorded
> the file count as the matcher count, so it read one high for a day — the same
> off-by-one the 17-conditions figure had.)
> ENH-80 added the eighteenth family (`src/routes/federation.js`, 7 paths) and
> moved the line count up rather than down: that family is new surface, not an
> extraction. ENH-60 then took the **hazard-risk family**
> (`src/routes/risk.js`, 6 paths, 9 blocks, 146 lines) out — the two marginal
> rankings, the joint compound score, the model listing, the fit and the score —
> and the **district-and-equity family** (`src/routes/districts.js`, 5 paths) —
> the published registry, the per-district roll-up across eleven collections, and
> the three equity routes that compare places to each other. Both are
> extractions, and the first two since ENH-59's table landed. The **ambient-layer
> family** (`src/routes/ambient.js`, 3 paths) followed — the raw observation
> series, the per-district weather roll-up and the latest modelled discharge per
> region, which are the three routes a *partner* reads rather than the browser,
> so the band has to travel with the number in the JSON the overlay never sees.
> The **upload family** (`src/routes/upload.js`, 1 path, 2 routes, 124 lines)
> followed — the column contract a client reads before it sends anything, and the
> one validator all three content types converge on. It is the largest single
> block taken out so far and the one where a partial write is most tempting, so
> the three rules that prevent one now live together: a failed batch writes
> nothing, a dry run writes no rows but still logs what it would have done, and a
> malformed multipart body is a 400 rather than a 500. The **taxonomy-and-forms
> family** (`src/routes/forms.js`, 4 routes, 167 lines) closed the run: the
> vocabulary a client renders, the catalogue it picks a version from, the version
> itself, and the publish that adds one. They are one family because they are the
> *configuration* surface — everything else reads them — and because the same
> immutability rule appears three times: a published version is not overwritten
> (`409`, since submissions name it and editing one in place leaves every record
> stamped with it silently wrong, the same defect as rewriting an applied
> migration), a built-in is not replaced in place by a deployment but superseded
> by a higher version, and a version the deployment does not hold is a `404`
> naming the versions it does hold rather than a fallback to the newest. The
> move carried `activeForms` with it, which had no caller outside this family;
> `src/routes/chw.js` keeps its own copy of the same merge, a duplication this
> move records rather than fixes, because deduplicating it would touch the CHW
> family in the same commit and a move that also refactors is a move nobody can
> review.
>
> The **catalogue family** (`src/routes/catalogue.js`, 3 routes) followed: the
> source list, the connector registry, and the connector gate status. All three
> join a *static* catalogue — the source list compiled into `schema.js`, the
> connector list read from `connectors.registry.json` — against the *dynamic*
> run history in `source_runs`, and they are one family because they share the
> failure mode that shape produces: a catalogue is never empty, so a route that
> joins one against an empty history answers `200` with a full-looking list. The
> answer to be afraid of is not an error, it is a row that reads healthy because
> nothing was ever recorded. Every route here therefore resolves absence to a
> named state rather than to a default that looks like success — `never_run` for
> a source with no run, `unknown` for a connector with none, `enabled: false`
> with the variable to set for one that is gated off.
>
> The move also settled a small inconsistency between two routes that had been
> computing "the latest run" two different ways. `connectors` used
> `new Date(b.completed_at).getTime()`, which is `NaN` for a run still in
> flight — and `NaN` compares equal to everything, so a running run sorted
> unpredictably against finished ones instead of last. Both routes now share one
> `latestRunFor` helper that falls back to `started_at`, which is also what makes
> the per-connector attribution assertable. The family is dispatched in *two*
> places, not one: `connectors/status` sat far below its siblings in the
> dispatcher, and moving it up to join them would have reordered dispatch. The
> matcher takes the method, so a write verb falls through to the surface's own
> `404` rather than becoming this family's refusal — verified live.
>
> `getConnectorRegistry` and its `GATE_ENV` table moved with the family, along
> with `registryPath`: both routes that read the registry are in the new module
> and nothing outside it does, so the module-level memo now lives where its only
> reader is. Four orphans left `server.js` — the `ingestionStatus` import, the
> `GATE_ENV` table, `registryPath`, and the registry cache. The dispatcher went
> 863 → 795 lines and `server.js` 2,509 → 2,384.
>
> The **compute family** (`src/routes/compute.js`, 4 routes) closed the day's
> extractions: the four routes that run a model over the request's own
> arguments — `flood-depth` at a point or over a box, `routing/plan` between two
> service assets, `analytics/bias-correct` over supplied observations and
> stations, and `alerts/evaluate` over the rule engine. They are one family
> because they share a failure mode rather than a subject: the *input* is the
> thing most likely to be wrong, and a wrong input does not throw — it returns a
> confident answer to a question nobody asked. So the module is mostly refusals,
> and the refusals are the assertions. Its matcher is deliberately asymmetric:
> the two POST-only routes are narrowed, because for them a wrong verb is
> genuinely "no such route", while `flood-depth` and `alerts/evaluate` match on
> *any* verb because both handlers answer a wrong verb with a documented `405`
> and a narrowed matcher would turn that into a `404` — a different statement
> about a different thing. Four orphans came out with the move:
> `validateRouteEndpoints`, `parseLevels`, the three `bandedDepth*` helpers and
> `FLOOD_BAND_TABLE`, plus the four imports that existed only for them
> (`planDelivery`, `flood-depth.js`, `downscaling.js`, and the ARC-05
> `flood-bands.js` import whose comment now lives in the module).
>
> Its matcher was written first as a guard (`if (pathname !== '…') return null`)
> and `check-openapi` refused it: the gate parses the positive `===` form only, so
> a negated one is a family it reads as *no paths*, which passes the comparison by
> contributing nothing. That is the quietest failure the check has, and it is the
> second time this entry has recorded it — the matcher was rewritten positively
> and the gate now reads `parsed matchUploadRoute → handleUploadRoute: 1 paths`.
>
> That last move surfaced a live defect rather than only relocating code. The
> discharge roll-up's same-day tiebreak read `existing.date`, a field the object
> it stores has never had — the stored key is `as_of` — so both date comparisons
> were against `undefined`, always false, and the map kept whichever record for a
> region arrived first. `test/river-discharge.test.js:94` asserts "the highest
> value for the latest date wins" and passed anyway, because its two Mandera
> records are ordered 250 then 180: the bug and the fixture agreed by luck, and
> the assertion was true of the fixture rather than of the route. The comparison
> now reads the field the map stores, and a canary restoring `existing.date` fails
> it.
>
> The moves deleted four orphans as well as moving them: `contingencyByFeature`
> (22 lines) and the `flood-probability.js` import existed for the risk group and
> nothing else, and then both the `./districts.js` and `./equity.js` import lines,
> whose five symbols the district family now reaches through its own module; the
> ambient move took three more (`open-meteo-forecast.js`, `discharge-bands.js`,
> `weather-bands.js`). A stale duplicate of the "route planning requires a POST
> body" comment sat between two of the risk blocks describing a route handled a
> hundred lines below.
> `check-openapi` reads each family as a third route source with no second list to
> keep in step — `parsed matchRiskRoute → handleRiskRoute: 6 paths`, `parsed
> matchDistrictRoute → handleDistrictRoute: 5 paths`, `parsed matchAmbientRoute →
> handleAmbientRoute: 3 paths`, `parsed matchUploadRoute → handleUploadRoute: 1
> paths`, `parsed matchFormsRoute → handleFormsRoute: 3 paths` and `parsed
> matchComputeRoute → handleComputeRoute: 4 paths`, still 174 documented and 174
> served.
>
> The **outbox family** (`src/routes/outbox.js`, 2 routes, 83 lines) came out
> next, and it is the exception to the paragraph below rather than an instance of
> it. The remaining literal conditions are one-off routes whose bodies *are* the
> business logic; the outbox pair is not. `GET /outbox` is one `collectionPage`
> call and `POST /outbox/dispatch` is one `dispatchPending` call, and both
> already lived in `src/outbox.js` — the dispatcher held two lines that named a
> module it had imported for its driver item. What makes it a family rather than
> a pair of blocks is that the two routes are the two halves of one question: a
> queue you can see and a queue you can drain. The move records the one property
> worth keeping, that the listing is **not** soft-delete filtered — `failed` is
> terminal in the outbox and the dead letter is the record of what stopped
> getting through (R-47), so the filter every sibling collection list carries
> would hide the one row that matters. Canaried: planting that filter fails the
> test with `a failed event was filtered out of the outbox listing`.
>
> What is left is not more of the same. The dispatcher held **5 inline literal
> route conditions** at this point in the day (measured from the dispatcher's own
> line range; the 17 previously recorded here does not reproduce against the
> file). They were one-off routes whose bodies *are* the business logic:
> `demo/seed`, `maintenance/apply-retention`, the `events` read, and the
> `assessments` roll-up. A fifth literal, `/api/v1/rapidpro/field-report`, is an
> auth precondition rather than a route: it buffers the body and verifies the
> HMAC, then falls through to the family. The `events` and `assessments` pair
> came out later the same day — see the end of this entry — leaving three.
>
> **`service-assets` came off that list on 2026-10-12, and it was not a
> candidate — it was a live defect.** The list above named "the two
> `service-assets` verbs" as one-off logic with no family to join. Both were
> inline copies of routes the operational family already served, dispatched
> *above* it, so the family's own list branch had been dead code since the
> extraction. The copy had dropped `?include_deleted=true`, which the six sibling
> collections honour — a 200 with a shorter list, which reads as an empty result
> rather than a bug. Removed rather than reconciled: the family serves both verbs
> now, including the `POST` import, which is the one write that family performs
> that its builders cannot. Register entry **VER-18**, and
> `test/dispatch-shadow.test.js` guards the class — no family matcher's path may
> also be an inline dispatcher literal — because the set comparison in
> `check-openapi.mjs` cannot see a path served twice.
>
> **The liveness pair came out next, on 2026-10-12, and it is a family by the
> dispatcher's own words.** `/health` ("is this process running") and `/ready`
> ("can it serve a request right now") sat 200 lines apart in the function, on
> opposite sides of the store read — and the comments at each already stated that
> they are one question asked at two depths. The move is 205 lines into
> `src/routes/liveness.js` (11 tests), and it kept the property that made the
> split load-bearing: the dispatcher's read is passed as a **thunk**, so `/ready`
> still never materialises the store. Passing `data` directly instead put the
> binding in its own temporal dead zone for an undeclared verb, which answered
> **500** where the contract says the verb is not offered — caught by
> `check-route-methods`, which is the gate that exists for exactly this. Both
> halves are asserted: a verb guard before any work, and a test that the
> readiness probe triggers zero whole-store reads.
>
> The move had a cost the extraction pattern had not paid before, and it is the
> finding of this unit. Two guards derived "every path the server serves" from
> `src/server.js` **alone** — `test/sw-bootstrap-assets.test.js`, which checks
> that every `NEVER_CACHED` entry is a route the server actually serves, and
> `test/route-scope-coverage.test.js`, which asserts the health route still
> reports the auth posture. The moment `/api/v1/health` moved into the module,
> both went blind and reported the route as missing. Neither was wrong about its
> subject: the route moved, its contract did not. The first is the dangerous
> direction — it demanded deleting a *correct* entry from `NEVER_CACHED`, which
> would let an offline operator read a cached "healthy", the exact defect that
> list exists for. Register entry **VER-19**.
>
> Fixed by extracting the derivation rather than patching two readers:
> `scripts/route-surface.mjs` now owns the three-family parser and reads
> `src/routes/` by directory, so a family extracted tomorrow is covered without
> an edit. `check-openapi.mjs` went 338 → 101 lines with **byte-identical**
> output. Canaried by renaming the matcher's literal: `check-openapi` exits 1
> naming the missing route and the service-worker guard fails 1 of 15.
>
> **The auth-info family came out on 2026-10-12, and it is the VER-18 shape in
> its purest form: one path, written twice.** `GET /api/v1/auth-info` was
> answered from two places in the dispatcher — on the 401 path, so a console
> with no key can learn it needs one, and on the authenticated path, where the
> caller's identity is known. Two copies of one response is exactly what VER-18
> recorded, and here the two copies agreed only by coincidence: the 401-path
> copy hardcoded `auth_configured: true`, which happens to be what
> `isAuthConfigured()` returns inside the branch guarding it. Agreement by
> coincidence is not a contract, so the family is **one handler called at both
> points**, with `auth` null at the first. The two answers are now one
> expression rather than two that currently match.
>
> It qualifies as a family by the same test `ingest/run` did — *is there a
> family for it to be the missing member of* — and the answer is that the two
> copies are the same route at two depths of one question. `src/routes/
> auth-info.js` is 62 lines; the dispatcher went 561 → 543 and `server.js` 2,150
> → 2,133, with `publicReadsOpen` orphaned from the `server.js` import as the
> move's only casualty. Canaried by dropping the identity from the handler: two
> tests fail, one in the module's own file and one in `auth-bootstrap`, which is
> the pair that proves both call sites go through the handler rather than one
> through each.
>
> **`ingest/run` came off that list on 2026-10-12, and its removal corrects the
> paragraph it left.** The entry above said extracting the remainder is "a move
> only after ENH-59 has a route table to declare them in". `ingest/run` was a
> counterexample already in the file: it is the immediate sibling of `run-due`,
> both are the ingestion family's own clock, and `matchIngestionRoute` named
> every other path under `/ingest/` and not this one. The family had a hole
> exactly where the route was, so the extraction was a move — the module already
> imported `runIngestion`, `refreshAnalytics`, `actionLog` and `readRequestJson`,
> and the diff of the moved body is the old block verbatim. What remains is
> genuinely different: those bodies are one-off logic with no sibling to join,
> which is the argument for ENH-59 rather than against extracting them. The
> distinction is *is there a family for it to be the missing member of*, and
> `ingest/run` answered yes.
>
> Its one behaviour worth naming is the status: **200, not the 201 `run-due`
> answers.** `run-due` creates schedule state; this route creates nothing and
> reports what the sources returned, so 201 would be a claim it does not make.
> Canaried by changing the literal to 201 and watching the test fail on that
> line.
>
> The move itself is verified rather than asserted, and the three checks are in
> ARC-01's entry.
>
> **The events-and-assessments family came out next, and it takes two of the five
> literals at once because they were one expression written twice.**
> `/api/v1/events` *is* the merged hazard-and-conflict list, and
> `/api/v1/assessments` publishes that same list as `recent_events` beside the
> risk roll-ups derived from it — so the union
> `[...data.hazard_events, ...data.conflict_events]` appeared in the dispatcher
> twice, which is the VER-18 shape at the level of an expression rather than a
> route. `src/routes/events.js` (2 paths, 11 tests) is now the one place that
> answers "what counts as an event": `recentEvents(data)` is called by both
> routes, so a change to the union is a change in one place rather than two that
> currently agree.
>
> The assessments roll-up is where the move earned its keep. Two of its members
> carried a defect the extraction made visible by putting them side by side:
> `recent_events` was the one list on the route that did not thread `auth`, so a
> partner token asking for `/api/v1/assessments` received **every hazard and
> conflict event in the platform** while the four lists beside it were filtered —
> a per-object authorization gap of exactly the kind VUL-03 recorded; and
> `calibration` was exported, documented in the JTBD catalogue as evidence this
> route "includes calibration metadata", and **called from nowhere**. A claim in
> a catalogue is not a feature. Both are asserted through the handler now:
> `recent_events` is scoped like its siblings, and `calibration` is published
> over the scoped score list, so a partner token learns mean confidence only over
> scores it can see. Canaried both ways — dropping the scope fails with "orgA
> must see only its own events", dropping `calibration` fails with "the route
> must publish calibration, not merely export it".
>
> The family dispatches **once**, where the `/events` block was, so
> `/assessments` is now tried earlier than it was. That is order-preserving in
> effect and only because no family between the two sites names either path —
> verified by grepping the dispatcher for both literals rather than by reading
> the blocks, which is how the claim is checked rather than asserted. Two imports
> left `server.js` as orphans (`calibrationReport`, `collectionPage`). The
> dispatcher went 543 → 526 lines and `server.js` 2,133 → 2,117.
>
> **Three inline literal route conditions remained at this point**, and the
> paragraph above is now wrong about two of them: `demo/seed` and
> `maintenance/apply-retention`. Both are POST mutations, and the claim that
> neither "has a sibling to join" did not survive being checked — see the
> operator-maintenance family below, which is the two of them. The test is not
> *is the body small* but *is there a family for it to be the missing member
> of*, and `src/auth.js` had already answered it: both prefixes resolve to the
> one scope `admin:maintenance`. The third literal,
> `/api/v1/rapidpro/field-report`, is the auth precondition rather than a route
> and stays.
>
> **The tile proxy followed on 2026-10-12, and it is the one that paid for
> itself.** `src/routes/basemap-tiles.js` is the thirty-second family — the raster
> basemap proxy (ADR-013), 1 route over 2 literal paths because the source is an
> alternation in the route regex. What makes it more than a move is where the
> block *was*: below `const data = await store.read(readRequest)`, in a route that
> reads no collection at all. Every tile of every pan materialised the whole store
> — the map is the console's default view — and it had done so since it shipped.
> The dispatcher went 526 → 511 lines and `server.js` 2,117 → 2,102; the family is
> dispatched above the read beside the tile-pack pair, which was hoisted for the
> same reason under ENH-42.
>
> It was found by widening the route-surface parser, not by reading the
> dispatcher: the route was written `/<literal>/.exec(url.pathname)`, a spelling
> the parser did not read, so it was absent from the manifest table, the document
> and every check at once. The moment the parser read the spelling,
> `test/route-manifests.test.js` reported it unmapped and the missing document
> entry followed. Recorded in full under ARC-02; the extraction is ENH-60's, the
> finding is ARC-02's, and neither would have happened without the other.
>
> **The operator-maintenance family came out next, and it takes the last two
> literals that are actually routes.** `src/routes/maintenance.js` is the
> thirty-third family: `POST /api/v1/maintenance/apply-retention` and
> `POST /api/v1/demo/seed`. They are one family because `src/auth.js` already
> said so — both prefixes resolve to the single scope `admin:maintenance`, and a
> route group the authorization table treats as one privilege is one group
> whatever the dispatcher's line numbering says.
>
> It carried a live defect, and the defect is the reason they belong in one
> file. The route and the driver's `retention` item
> (`applyScheduledRetention`, 1,200 lines away in the same file) are two
> implementations of one operation, and they **disagreed about which window
> decides a refusal**. The route read `retentionWindowDays` — the *general*
> window — and 400'd when it was unset. The driver read
> `retentionWindowFor(policy, collection)` per collection. So a deployment that
> configured only `communityFeedbackDays`, the more sensitive of the two, and
> left `retentionDays` at zero got:
>
> ```
> POST /api/v1/maintenance/apply-retention
> → 400 "retentionDays is not a positive number ... Nothing was deleted."
> ```
>
> while the scheduled driver had been expiring `community_feedback` on every
> tick. The operator reads "nothing was deleted" and is exactly wrong; the one
> collection being purged is the one carrying a member of the public's own
> words. The route now applies each collection's own window the way the driver
> does, refuses only when *no* collection has a window — the condition the
> message was always about — and reports a collection with no rule as
> `window_days: null` beside its counts rather than refusing the whole request
> and lying about the other two.
>
> The two implementations still exist, deliberately: the driver takes the `data`
> a tick already read and must not read the store again inside it, while the
> route answers one request. Unifying them fully is a larger change than an
> extraction. What this unit fixes is that they no longer *disagree*, and what
> it makes possible is that the next reader finds both in one file.
>
> The test is the shape the defect needs: the route and the driver are run
> against the same process policy and asserted to agree about which collections
> have a window and how many records each expires. A test of either call site
> alone cannot see this — the divergence is *between* two call sites, so the
> assertion has to be between two call sites too. Canaried by restoring the
> pre-extraction body (one window for everything, refusal read off it): the
> HTTP test fails with "the route refused a policy that the driver acts on".
>
> The dispatcher went 511 → 411 lines and `server.js` 2,102 → 2,009; the family
> is dispatched where the retention block was, so dispatch order is unchanged.
> `DEMO_SEED_BUDGET_MS` moved with the seed and is re-exported from `server.js`,
> because `test/` and `scripts/` read it off that module.
>
> **The authentication gate came out last, and it takes the final literal with
> it.** The block it replaces was the 48-line preamble every API request passes
> through before any route is matched: buffer a signed webhook's bytes and verify
> its HMAC, let a public *read* through, authenticate everything else, answer
> `/auth-info` for a caller who has no key, then scope-check the identity that
> resolved. `src/routes/auth-gate.js` is the thirty-fourth module under
> `src/routes/` and the only one that exports no `match*Route`, because there is
> nothing to match — it runs at a fixed point above every matcher and returns a
> **verdict** rather than a boolean: `{ outcome: 'continue', auth }` or
> `{ outcome: 'handled' }`. A boolean would lose the identity, which is the whole
> reason the dispatcher had three things to do with the answer.
>
> **The dispatcher now carries no inline route literal at all** — the first time
> that has been true. `functionBody('handleApiRequestInContext', src)` then
> matching `url\.pathname\s*===\s*'…'` returns **zero**, where it returned one
> before. The paragraph this replaces said what to do at exactly this moment:
> "When it too is gone, replace this with an assertion about `families`, not with
> `>= 0`." `test/dispatch-shadow.test.js` now asserts `inline.size === 0` and
> carries a **canary that reads `src/routes/auth-gate.js` with the same regex**,
> because `0` is also what a regex that matches nothing returns — a scan that
> cannot find a literal known to be present cannot certify a dispatcher that has
> none. The canary fires when the gate's own literal is renamed.
>
> Two of the gate's four decisions were verified rather than moved. The
> `/auth-info` branch and the public-read branch each have a live-server test
> already (`auth-bootstrap`, `auth-public-reads`), so the module's own test file
> asserts the *shape* no live test can express: that `handled` and `continue` are
> distinct outcomes, and that the identity the gate resolved is the one it
> *returns* rather than one it mutates into a parameter. Its nine tests cover all
> four decisions and the auth-free deployment, and each was canaried: deleting
> the body-buffering line fails exactly the two tests that assert it, and nothing
> else.
>
> The move cost three imports (`requireScope`, `scopeForRoute`,
> `verifyRapidProWebhook` left `server.js` as orphans, caught by
> `test/unused-imports.test.js` — which is the gate that exists for exactly
> this), and it needed a real test file rather than an allowlist entry for
> `check-module-coverage`: an allowlist is a place to hide, and this module is
> reachable on every request.
>
> The dispatcher went 411 → **367 lines** and `server.js` 2,009 → **1,964**.
> Thirty-four modules under `src/routes/`, thirty-three matchers. ENH-60 stays
> PARTIAL — the dispatcher is smaller but it is not gone, and what remains is the
> 367 lines of dispatch entries themselves, which is ENH-59's problem rather than
> another extraction.
>
> **2026-10-12 — the last routes written inline, and four routes no table could
> see.** `handleStacRoute` was the one route block still written out in
> `server.js` rather than under `src/routes/`, and it was left there for a
> reason that turned out to be the defect: it matched with inline `.match()`
> calls inside a plain helper, and `scripts/route-surface.mjs` reads inline
> matches only in the dispatcher body and in a named `match*Route` function. So
> `/stac/collections/{id}`, `/stac/collections/{id}/items`,
> `/stac/collections/{id}/items/{itemId}` and `/ogc/collections/{id}/items` were
> served, called by no client, and present in **no** manifest, document or
> check — while `check-openapi` reported a clean *176 documented, 176 served*.
> Agreement by mutual blindness, which is the tile-proxy defect's exact shape,
> found this time by asking the parser what it could see rather than by a
> symptom. `src/routes/stac.js` carries both families now; the document gained
> the four paths, `ROUTE_MANIFESTS` gained the four entries against
> `STAC_READ_COLLECTIONS`, and `check-openapi` reports **180 documented, 180
> served**. Thirteen tests in `test/stac-route-module.test.js`, one of which
> asserts against the parser's own output, because the failure mode here is not
> a wrong answer — it is a route no check can find.
>
> *Writing the matcher found a second bug in the parser.* `uniqueParams` renames
> repeated parameters so OpenAPI can declare them — `{id}`, then `{id2}` — and it
> was applied to a path's base but not to its optional tail. A route with a
> parameter *and* a parameterised optional tail emitted
> `/stac/collections/{id}/items/{id}`: the same parameter name twice, which the
> spec forbids and no document could match. It went unnoticed because the first
> optional-tail route in the tree was the tile proxy, whose parameters are all in
> the base. Canaried by reverting the one line and watching the new test fail
> 12/13.
>
> The dispatcher is unchanged at 367 lines because this was not a dispatcher
> extraction — the block sat in `handleApi`, above it. What moved is
> `server.js` 1,964 → **1,910** and `src/routes/` 33 → **34 modules, 34
> matchers** (`auth-gate.js` is still the only one without a matcher, because it
> runs before matching).
>
> Two stale figures in the paragraph above are corrected here rather than
> silently replaced. It said "eight literal conditions exist in `server.js` as a
> whole" and then named four plus "one more" — the eight does not reproduce
> against the file under either spelling. Measured: **4** `url.pathname === '…'`
> (`/metrics`, `/api/v1/metrics`, `/stac/catalog.json`, the rapidpro
> precondition) and **2** bare `pathname === '…'` (`/docs` twice, in the static
> handler and the doc-target resolver), **5 distinct**. That is the fifth
> carried-forward number in this entry, which is why every figure here now names
> the expression that produces it.

> **2026-10-13 — the ordering claim became a guard, and the guard found its own
> jurisdiction.** Every extraction note in this entry ends with "dispatched here,
> where the block was, so the order the dispatcher tries its routes in is
> unchanged", and the events family's note records how that was ever checked:
> "verified by grepping the whole dispatcher for both literals, not by reading the
> blocks". A grep run once by a person is a fact that was true when it was typed.
> `test/dispatch-order.test.js` (12 tests) makes it checkable: it reads the 32
> `const X = matchYRoute(…)` statements out of `handleApiRequestInContext` in
> order, asserts the sequence against a table recorded in the test, and asserts
> the four-above / twenty-eight-below split of `store.read(readRequest)`.
>
> The table is **ENH-59's missing declaration in miniature** — the dispatcher's
> own order, in one place, checked against the source rather than produced from
> it. It is kept in the test rather than in `src/` because it must not change
> behaviour: it records the order, it does not generate it. When ENH-59's generator
> lands the generator reads this table and the dispatcher's statements become a
> loop over it; until then the two are compared, so a reorder is a failure naming
> the diff. Two canaries: moving `matchTileRoute` below the store read fails 2/7
> (the split assertion), and swapping two families within one phase fails 2/7 (the
> sequence assertion).
>
> The orphan check was scoped to the dispatcher body first and **reported two
> correct families as orphans** — `matchStacRoute` and `matchOgcRoute` are
> dispatched from `handleApi`, above the function. A check scoped narrower than
> its subject names a defect that is not there, which is the same error as one
> scoped wider, and it is why the check now reads the whole server source while
> the *order* check stays on the dispatcher body: the two questions have different
> jurisdictions and one scope cannot serve both.
>
> **2026-10-13 — two comments outlived their blocks.** The removal is five lines
> and the finding is that neither comment was wrong when written. `// Field
> outcomes: the confirmations a responder sends with DONE` sat directly above
> `// Parametric disbursement routes`, and both had lost their code: the
> field-outcome pair moved to `src/routes/field-signals.js` and the `DONE` merge
> to `src/routes/rapidpro.js`, while the parametric family carries its own ARC-01
> header on the line below. A comment whose block has moved is worse than no
> comment — it names the routes handled *here*, so the reader who trusts it looks
> for `field-outcomes` in the dispatcher and finds `matchFieldSignalRoute`
> instead. Measured after the removal: the dispatcher is **362 lines**
> (`functionBody('handleApiRequestInContext', src)`, line 1004 to 1365),
> `server.js` **1,905**. The 367 recorded above is that figure before this
> removal, left standing as the before-state rather than overwritten.
>
> **2026-10-13 — the order table recorded the sequence and not the wiring.** The
> guard above asserts that `matchKpiRoute` runs sixth; it did not assert that
> `matchKpiRoute` is paired with `handleKpiRoute`. Those are two facts about one
> line — `if (kpiRoute && await handleKpiRoute(kpiRoute, { … }))` — and a matcher
> wired to the wrong handler, with the same dependency shape, passed all seven
> tests. The table is `BINDINGS` now: 32 `[matcher, handler, keys]` rows, the keys
> a sorted set because their order in the object literal is unobservable (the
> handler destructures by name) while a key added, dropped or misspelled is
> exactly what a missing `loadData` thunk or a lost `vintageIndex` would be. Three
> more tests, canaried both ways: pairing `matchKpiRoute` with `handleExposureRoute`
> fails the binding assertion alone (9/10), and dropping `readRequestJson` from the
> maintenance call fails the key assertion alone (9/10).
>
> Building it found a defect in the table before it found one in the code, which
> is the useful direction. `handleParametricRoute` takes **no `url`** — five keys,
> not six — and the first draft of `BINDINGS` recorded six from the reading rather
> than from the source. The parser that reads the dispatcher disagreed, and it was
> right: `if (parametricRoute && await handleParametricRoute(parametricRoute, {
> store, data, req, res, jsonResponse }))`. A hand-written table is a claim about
> the source, and this one was wrong in the same commit that introduced it, which
> is the case for the parser checking the table rather than a person maintaining
> it. Two smaller self-inflicted ones on the way: a global `, key` match that
> *consumed* the separating comma and so read every other key, and a window that
> ended at the first `} return` and truncated the four-key families that wrap
> their literal across lines. Both were the parser being wrong about a shape the
> source uses, not the source being wrong.
>
> The keys are still not a declaration the source is generated from — the
> dispatcher writes them, and this reads them back. But `BINDINGS` is now the whole
> of what a loop over the dispatcher needs: matcher, handler, and the bag each
> handler is handed. ENH-59's generator has one table to read rather than three
> conventions to re-derive.
>
> **2026-10-13 — the statements became a loop, and the table moved into `src/`.**
> The paragraph above ended with the shape the residue had: thirty-two
> `const X = matchYRoute(…)` blocks written out in the dispatcher, read back by a
> test. That is a declaration wearing statements' clothes, and it is what both this
> entry's "the dispatcher is smaller but it is not gone" and ENH-59's "no single
> declaration" were pointing at. `src/route-families.js` is now the declaration:
> `ROUTE_FAMILIES`, 33 entries (32 families, `matchCatalogueRoute` twice because it
> is dispatched at two points split by a `kind` guard), each carrying its matcher,
> its handler, its dependency keys, whether its matcher takes the verb, whether its
> handler is async, and which side of `store.read(readRequest)` it sits on.
> `handleApiRequestInContext` iterates it in two loops — `pre` above the read,
> `post` below — and the dispatcher went **367 → 80 lines**; `server.js`
> **1,926 → 1,613**.
>
> **The table is checked, not trusted.** `test/dispatch-order.test.js` keeps its
> frozen recordings — the 33-row sequence, the four-above/29-below split, the
> `[matcher, handler, keys]` bindings — and now reads the table at runtime instead
> of regexing statements out of `server.js`, so there is no parser left to drift
> from the code it reads. Two new checks make it non-circular, because a table that
> certified itself would be the "gate scoped to its own input" failure: every key a
> family is handed must be one its handler **actually destructures** (parsed from
> `src/routes/`), and every key must be one the dispatcher's context **actually
> provides** (parsed from `src/server.js`). Canaried three ways: planting a
> `noSuchKey` fails both cross-checks; flipping `matchTilePackRoute` to `post`
> fails the split; replacing `postCtx` with `familyCtx` in the second loop fails the
> "the dispatcher actually loops over the table" assertion. A fourth asserts both
> loops exist and filter on `family.pre` in opposite directions — a table that is
> imported and never iterated would satisfy every other assertion and serve
> nothing, which is the "mechanism shipped, caller missing" shape this register
> catalogues.
>
> **What this does not do.** It is ENH-60's residue removed and ENH-59's *first*
> table generated-in-spirit, not ENH-59 finished. The other four tables —
> `docs/openapi.yaml`, `src/route-manifests.js`, `src/auth.js` scopes, and the
> client's 29 call sites — are still hand-kept, and this table does not yet produce
> them. What changed is that the dispatcher's own declaration now exists in one
> place and is enforced, so a generator for the other four has something to read
> that is not a person's memory of the order.
>
> Three findings came out of the move rather than the code. Removing the 32 blocks
> left `refreshAnalytics` imported in `server.js` and used nowhere — its only
> non-import mention was a comment the splice deleted, and the three route modules
> that need it import it themselves; the dead binding was deleted, not
> re-commented into life to satisfy `unused-imports`. That test's own canary named
> `refreshAnalytics` as a known-bound anchor and had to be repointed at a real
> dependency (`filterRecords`), which is the canary doing its job — a known-present
> string that stops being present should fail loudly, not silently widen. And seven
> register citations to `src/server.js` lines past the new EOF (`1652`, `1694`,
> `1832`, `1649-1661`, `1637`, `1714`) failed `check-doc-citations`; each was
> re-anchored to the route module the code moved to, or marked `line-drift-ok:`
> where the entry means to quote the tree as audited. The citation gate caught the
> move, which is the second time this session it has earned its keep.
>
> **IMPLEMENTED 2026-10-13 — the verdict, said in the word the other fifty use.**
> Every paragraph above is dated history and the last of them still opens
> "PARTIAL", so the entry read as open to anyone who stopped at its own heading
> while the verdict table two hundred lines up moved this item to IMPLEMENTED in
> the same commit (`be2f4d3`). Nothing compared the two: the table is guarded
> against itself and the note was guarded against nothing. The claim the row
> states is met and measured — the dispatcher is 88 lines of table iteration with
> zero inline route conditions, and the 32 hand-written `match`/`handle` pairs are
> `src/route-families.js`'s table. What remains is ENH-59's, not this entry's: the
> dispatcher is short and it is no longer a list of routes.

**ENH-61 — Streaming cursor reads.** `PostgresStore.read()` issues
`SELECT collection, body FROM lite_records WHERE …` with no `LIMIT`
(`src/postgres-store.js:267`) and materialises every row into the heap. A cursor
API bounded by request keeps memory flat and makes ENH-37 possible.

**Fixed 2026-10-11.** `iterateRecords(options, { batchSize })` on both adapters:
`DECLARE lindela_stream NO SCROLL CURSOR` → repeated `FETCH n` → `CLOSE` in a
`finally` that also releases the client, so an abandoned stream (the ordinary
case — a partner closes the socket mid-export) does not bleed a pool connection
per export. `readPredicate(options)` was extracted and is now shared by `#readWith`
and the cursor, because the partner clause is a visibility boundary and a second
copy would be a second answer to "which rows may this caller see". The batch
default is 1,000 and the walk is verified at 2,500 rows in batches of 1,000.
Tests: `test/streaming-export.test.js` (3 of the 9).

**ENH-62 — Content-addressed derived cache.** `refreshAnalytics` recomputes eight
derived collections on every run and reads the store twice
(`src/analytics.js:226`, `:283`). Key each derived value by the digest of its
inputs (`inputDigestFor` exists) and skip recomputation when nothing changed.

**Shipped 2026-10-12.** Each derived collection is keyed on the digest of its own
inputs, computed with `canonicalHash` rather than `inputDigestFor` — the latter
counts thirteen collections and would miss every non-count input. Only the
collections whose digest moved are recomputed.

*Two collections are always recomputed, and naming them is the point.*
`road_access` reads `new Date()` for hazard recency and `data_quality` reads
`Date.now()` through the freshness penalty. Hashing a clock would miss on every
run anyway; saying so in `CLOCK_DEPENDENT` is the honest version, and the
alternative — a hole a reader takes for a hit — is how a cache silently serves
stale numbers.

*The cache cannot hit across a changed engine.* It is a `WeakMap` keyed by store
identity and the digest is recomputed from a fresh read each run, so a hit means
the inputs are *currently* identical rather than that they once were. A persisted
digest could outlive the code that reads the inputs. An undigestible input
(`BigInt`, a cycle) throws inside `canonicalHash`, which returns `null` and forces
a miss — never a false hit. `planDerivedRefresh` also recomputes when a matching
digest has no rows behind it, which is the guard against "skipped 8, recomputed 0
on a cold cache": a skip that measures nothing must not report success.

14 tests, including stale-hit impossibility — a covered field changes while the row
count does not, and the digest must catch it.

**ENH-63 — Durable cross-replica idempotency and outbox lock.** The dispatch lock
is an in-process `WeakMap` (`src/outbox.js:129`) and the idempotency store is
in-process (`src/server.js:637`). Two replicas both POST the same outbox row.
`pg_advisory_lock` plus a durable key table makes exactly-once real across a fleet.

> **Shipped — verified 2026-10-12; the note was missing.** The shape is **claim-deliver-record**, not lock-deliver-record: under `store.withLock` the due rows are read and marked `dispatching` with a timestamp, delivery happens outside the lock (a webhook POST is network I/O with a 5 s timeout, and holding a global write lock across it would serialise every write behind the slowest subscriber), then the outcomes are written under the lock again. A second replica's read, taken after the claim commits, no longer sees the rows as pending — that is the whole cross-replica guarantee. `src/postgres-store.js:220` takes the session-scoped `pg_advisory_lock`; `src/outbox.js:218` records that the comment there used to say this was *not* done.

**ENH-64 — End-to-end request/correlation id.** No request id exists anywhere
(`grep request_id|correlation src/` is empty). Mint one at ingress, put it on every
log line and every response, and propagate it into the ingestion run id — so a 500
returned to a client joins to the log entry for that request.

> **Shipped — verified 2026-10-12; the note was missing.** `src/server.js:591` mints the id: an inbound `x-request-id` is sanitised and reused where present, otherwise `randomUUID()`, and it is set on the response as `x-request-id`, put on `res.locals`, and installed for the dispatch through `runWithRequestId`.

**ENH-65 — Per-server state.** `idempotency` (`src/server.js:637`), the driver
timers (`:225`) and the metrics registry are module-global, so two servers in one
test process share them and tests are order-dependent. Threading them through
`createServer` makes isolation the default.

> **Shipped — verified 2026-10-12; the note was missing.** `createServer` (`src/server.js:519`) owns the state: `idempotencyFor` is a per-server `let` built from `options.idempotencyOptions`, and the periodic driver is owned by whoever creates it rather than by a module-level timer. `test/server-isolation.test.js` asserts the property directly — two drivers tick their own stores and stopping one leaves the other armed, one server's failures do not appear in another's uptime, and the process ring is not consulted when a server has its own.

**ENH-66 — Backpressure and admission control.** The outbound rate-limit queue is
unbounded (`src/rate-limit.js:213`) and the store read is unbounded (SCL-01).
Bounded queues with a 503 + `Retry-After` under sustained load convert a
memory-exhaustion failure into a refusal, which is the platform's own idiom.

> **Shipped — verified 2026-10-12; the note was missing.** `src/rate-limit.js`'s `maxQueue` is the bound, and past it `acquire` rejects with `RateLimitQueueFullError` carrying `retryAfterMs` and `statusCode: 503` — a refusal, never a drop, because a dropped waiter is a silently missing country. The default of 1,000 is deliberately generous: the point is to bound the pathological case (a connector fanning out over 46 countries while the provider stalls), not to ration normal fan-out.

**ENH-67 — Read-replica split with a query budget.** Analytical reads
(`filterRecords`, `refreshAnalytics`, `/ready`) go to a replica; writes stay on the
primary. A per-request query budget fails a route that scans the whole store rather
than letting it degrade every other caller.

**Shipped 2026-10-12, as the mechanism — not yet wired.** `src/read-replica.js`
routes a read to the replica and everything else to the primary from one store
object, so a caller cannot get the direction wrong. `src/query-budget.js` fails a
route whose read scans the whole store.

*The read set is enumerated from the store, not hardcoded.* `read()` and
`iterateRecords()` go to the replica; every other method is forwarded, and the list
is walked off the prototype chain so a store method added later is routed without
an edit. A hardcoded list is a method that silently reaches the wrong connection
the day someone adds one. Writes are never retried on the replica — a retry there
is silent divergence. With no replica configured the wrapper returns the primary
object *itself*, the same reference, so a deployment without one has no
indirection and no behaviour change.

*The budget counts two axes the store actually reports* — rows handed back and
store operations — never a planner's estimate. A whole-store read is caught by the
row axis without a special case, because its row count is the size of the store.
It lives in an `AsyncLocalStorage`, so it is per-request by construction and two
concurrent requests cannot spend each other's. A cost that is not a finite
non-negative number is **refused, never charged as zero**: a budget that measures
nothing must fail rather than report success. A metered read with no budget in
scope is likewise refused, so wiring is a deliberate act rather than a silent pass.

Replica failure defaults to falling back to the primary, counted and logged — the
read returns the same rows, only slower — with `onReplicaFailure: 'fail'` for a
deployment that would rather shed load. The `iterateRecords` fallback is taken only
before the first record is yielded; after that the error propagates, because a
mid-stream restart risks a duplicated or skipped record.

**Wired 2026-10-12.** `server.js` establishes the budget around the dispatch and
chooses the allowance per route: `WIDE_ROUTES` gets the store's own ceiling, a
manifest gets the narrow default.

*The replica half of this paragraph was not true when it was written, and the
date above belongs to the budget.* `createReplicaFromEnv` reads
`LINDELA_LITE_REPLICA_URL`; unset, `readReplicaStore` returns the primary itself,
so a deployment without one is unchanged. **But nothing called it.** Every
`createServer()` in the tree passed no `replica` — the entry point at
`src/server.js` calls `createServer()` bare — so `options.replica` was always
`undefined`, `readReplicaStore` always returned the primary, and a deployment
that set the variable read its primary while the register said it read a
replica. `scripts/check-dead-exports.mjs` reported the export with no caller,
which is how this was found.

**Wired 2026-10-16.** `createServer` resolves `options.replica ??
createReplicaFromEnv()`, so the environment is the default and an explicit
argument still wins — a test or embedder passing `replica` is not overridden.
Unset is `null`, which is the value the default already was, so a deployment
without a replica is byte-for-byte unchanged.

*Wiring the budget exposed a defect that had been invisible while a whole-store
read cost only bandwidth.* `collectionsForRequest` blanked the first two path
segments with a single regex before looking the route up — right for
`incidents/123`, wrong three ways, each answering `null`, which is the
whole-store read the table exists to replace:

- a *fixed* second segment is not an id: `calibration/by-region`, `audit/head`,
  `kpi/quarterly`, `ingest/status`, `rapidpro/escalations` — **27 entries** were
  shadowed by their own `:id` sibling;
- a *deeper* id is not the second segment: `/api/v1/ingest/schedules/:id` puts
  its record one level further down, so `schedules/abc` rewrote to
  `schedules/:id/abc` and matched nothing;
- a *suffix on the id* is not a separate segment: `:id.cap` is a wildcard within
  a segment.

Measured: `GET /api/v1/calibration/by-region` enumerated all 64 collections
through the budget while its handler reads `region_trust`. The matcher is now
segment-wise — `:name` matches one segment, `:name.suffix` a suffixed one, fewest
wildcards wins and a constrained suffix breaks the tie — and all 200 keys in
`ROUTE_MANIFESTS` and `WIDE_ROUTES` round-trip through it.

`measureRead` counts a scoped read by the collections it named rather than by
enumerating the result. Same number — a scoped read returns the whole declared
shape with the unnamed collections empty — different act, because enumerating is
indistinguishable from having read them wherever the result is instrumented.

Also fixed on the way: `src/routes/chw.js` read the entire store to compare a
double submission against `field_reports` — 48,473 rows to look at 169, a 287×
over-read on the route a health worker's phone hits.

*Canaries, each watched to fail.* Restoring the single-regex matcher puts
by-region and ingest/schedules back to `null` (14/15); removing the scoped-count
branch trips the manifest-drift gate the same way (14/15). 4159 tests pass, 15/15
gates ok.

---

## Group L — Cognitive efficacy (order-of-magnitude user cost)

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-68 | Grounded natural-language query | 5 | 4 | 3.4 |
| ENH-69 | Expected-value alert triage | 5 | 3 | 4.2 |
| ENH-70 | Uncertainty-first map | 4 | 2 | 4.0 |
| ENH-71 | Intent-driven progressive disclosure | 4 | 3 | 3.6 |
| ENH-72 | Explainable ranking everywhere | 4 | 2 | 4.0 |
| ENH-73 | Time-to-decision instrumentation | 4 | 2 | 4.0 |
| ENH-74 | Collaborative annotation threads | 3 | 3 | 3.0 |

**ENH-68 — Grounded natural-language query.** "Which districts crossed the flood
threshold last week and have no dispatch?" answered over the store, grounded in the
same fact set `narrator.js` audits against, refusing when it cannot ground. The
console's 144 controls exist because the operator must assemble the query by hand;
this collapses that.

> **Shipped 2026-10-12 — IMPLEMENTED.** `src/nl-query.js`, 15 tests. Grounding is
> enforced in three separate places. The **parse**: a declared vocabulary, never
> stemmed or fuzzy-matched — an unknown subject, an ambiguous region naming two
> districts, and an empty question each refuse and name the term, and a country
> two-letter code is deliberately not a region because `so` is a word. The
> **resolution**: `no_data`, `unknown_field`, and `unmeasured` — a "no dispatch"
> question against a store that records no dispatches at all is refused rather
> than answered "undispatched", because an absence that cannot be told from a gap
> is not a finding. And **the answer itself**: every value read goes into a fact
> set and narrator.js's `allowedNumbers` rule is applied to the rendered sentence,
> so a digit the facts do not state is an `invented_figure` refusal naming the
> number. A `flood_probability` question with no trained fit returns the model
> registry's own `refusalSentence` verbatim plus `floorsMissed` against the store's
> archive months, the two floors this layer cannot observe reported as unverified
> rather than met, and the test asserts the sentence is identical to the
> registry's so it cannot drift into a paraphrase.
>
> **One honest limit, stated in the module rather than papered over:** the store
> holds the latest value per district, not a history, so "crossed the threshold
> last week" is answered as "is above the threshold now" and the answer says so.
> The window genuinely scopes the event collections, whose records carry
> timestamps. A per-record history was not invented to make the question's wording
> come true.
>
> **Widened 2026-10-13 — a model for recall, not for truth.** The parser's one
> real cost is recall: a question phrased outside the seven subject phrases
> refuses, correctly but unhelpfully. `src/needle.js` adds Cactus Needle 3
> (121M params, 8-29 MB, Apache-2.0, no Node binding — so a sidecar over HTTP,
> the `narrator.js` shape) asked for one grammar-constrained `parse_question`
> tool call whose argument enums are *generated from* `SUBJECTS`, `PREDICATES`,
> `WINDOWS` and the district list. Every returned slot is then re-validated
> against that same vocabulary by code, and a proposal below the confidence
> floor is refused whole. The disposal stays deterministic: the model widens
> recall and cannot invent a subject. `parseQueryWithModel` consults it only
> where `parseQuery` already refused with `unknown_subject`, so off,
> unreachable or unconfident leaves the deterministic refusal byte-identical.
> Opt-in via `LINDELA_LITE_NEEDLE=1`. Research and the archived model card:
> `docs/research/needle3/`.
>
> **And the limit that was already true, now written down:** ENH-68 was marked
> IMPLEMENTED while `nl-query.js` was reached by nothing — no route, no console
> control, no caller outside its own test. The parser was real, tested and
> grounded; the surface that would expose it was a product decision this entry
> did not make. Recorded here rather than implied, because "IMPLEMENTED" on a
> module with zero callers reads as a live feature and is not one.
>
> **Wired 2026-10-13 — the surface.** `src/routes/ask.js` serves
> `POST /api/v1/ask`, declared in `src/route-families.js`, scoped
> `admin:analytics` in `src/auth.js`, and wide in `src/route-manifests.js`
> (the collection is chosen by the question, so no static manifest can be
> narrower than the union of the seven subjects). The route calls
> `answerQueryWithModel`, which runs the *same* resolve-render-audit tail as
> `answerQuery` — a subject Needle proposed is held to the same fact set, and
> the handler cannot tell the two apart. **A refusal is a 200**, because a
> question the layer cannot ground is an answer about the data and not a fault
> in the request; the one 400 is a body with no question in it. The console
> reaches it through `public/workflow/ask.js`, mounted by one `lazy()` line in
> `app.js` so the panel stays off the first-load graph.

**ENH-69 — Expected-value alert triage.** Rank alerts by cost-weighted expected
loss, not recency. The alert engine raises events; the triage surface should order
them by what acting now is worth, using the severity weights (currently three
inconsistent implementations — ARC-04) and the exposure of what is downstream.

**Shipped 2026-10-11.** `src/triage.js`, served at `GET /api/v1/alert-events/triage`.
The quantity is `severity_weight × population_exposed`, and the payload calls it a
*proxy* in `method` rather than an expected value: no hazard probability and no
cost per person enters it, so it ranks alerts against each other and does not
price them. Calling it an expected value without that sentence is the overclaim
this audit spent its length removing.

Exposure comes from the hazard the alert's own derivation names, or failing that
from the nearest scored hazard within 250 km, and `exposure_basis` says which —
an attribution must be labelled as one. An alert with no measurable exposure is
ranked after the measured set with `expected_loss: null`, never 0: a zero would
place an unmeasured alert below a measured trivial one.

Two properties stated on the payload rather than left for a reader to discover.
The populations are **per hazard and overlap** — a facility within the radius of
two hazards is counted in both — so no total is offered and `exposure_overlap`
says why. And the severity weight is read from `src/schema.js`, the one the
engine stamps onto the event, so the ranking and the event cannot disagree about
what "high" means (ARC-04).

**ENH-70 — Uncertainty-first map.** The map shows what is known; what is *not*
known (records outside the frame, areas too large to place, undetermined
classifications — already computed in `public/app.js`) should be as prominent as
the data. An operator reading a clean map should see the gaps in it.

**Shipped 2026-10-12.** The accounting was already computed on every render and
written only to the record count's `title` and `aria-label` — a tooltip, which
needs a hover a touch device does not have, so a map drawn from 40 of 67 records
was indistinguishable from one drawn from 67. It is now a `<details>` panel on the
map itself: `mapCoverage` (pure, exported) plus `renderMapCoverage` and
`.map-coverage-overlay` in `public/index.html` / `public/styles.css`.

*Two numbers the module's shape exists to keep apart.* `unplaced` is a record the
map **holds** and could not draw; `filtered` is a record the map never held because
a filter excluded it. Adding them reports "not on the map" for a record that is not
the map's to show — a wrong number in the direction of alarm, which is worse than a
missing one. The panel keeps them in separate rows for the same reason: each has a
different fix, so a lumped total is a number nobody can act on.

*Zero is a count, not an absent reason.* A reason with `count: 0` is dropped rather
than rendered as "0 areas too large to place" — a strip the operator learns to skip,
which is how a panel that reports gaps stops being read. Two canaries watched the
tests fail before they were believed: conflating `unplaced` with `filtered` → 1
failure; dropping the zero filter → 3.

The first-load budget moved 229 → 230 KB for this (`scripts/check-budget.mjs`),
leaving 0.5 KB — deliberately less headroom than the raise it follows. 1.4 KB was
trimmed first: the duplicated tooltip string was deleted rather than kept beside
the panel that replaced it, and the coverage panel reuses the legend's own rule.

**ENH-71 — Intent-driven progressive disclosure.** HX-05 counted 144 controls above
the fold; the command band reclaimed the pixels. The deeper fix is to show controls
for the task the operator is doing, not all controls at once — a role-and-intent
driven surface rather than a layout one.

**Shipped 2026-10-12, wired to the console.** HX-05 counted
144 controls above the fold; the command band reclaimed the pixels, and this is the
deeper fix. `public/shared/intent.js` maps a (role, intent) pair to the controls a
surface shows, over the 39 interactive elements `public/index.html` actually
declares rather than an invented set. Roles borrow `shared/view-state.js`'s
`ROLE_DEFAULTS` vocabulary so a shared link and this model agree on who an operator
is.

*Reachability is structural, which is deliberate.* `manage` shows every group,
excludes nothing and is not role-gated, so every control is shown for every role by
construction. `reachability()` then checks the whole 5 × 7 matrix anyway, and two
tests assert both result lists are empty — one over the registry, one over the ids
read from `index.html`, so a registry that drifted from the console cannot satisfy
it. A disclosure model whose failure mode is "the control is unreachable for
everyone" is a bug wearing the feature's clothes; the canary — dropping `palette`
from `manage.show` — fired that assertion.

*An unknown input shows everything.* An unrecognised role or intent returns
`mode: 'fallback'` with every control shown and a header saying so. Hiding on an
input the model does not recognise is how a control disappears for the one operator
who needed it, and the failure is invisible to everyone else. A hidden control
carries the reason it is hidden and, when it is the only route to a capability, the
way back.

**Wired 2026-10-12 — IMPLEMENTED.** The module is no longer inert.
`public/shared/intent-console.js` is the surface: it injects its own `#intentBar`
section and stylesheet, renders a picker built from the module's own
`INTENT_OPTIONS`, the header `decideSurface` returns, and the hidden controls with
the reason each is hidden — an only-route control's reason carries the way back.
The picker is the only thing that may hide a control. `public/app.js` reaches it
with one line, `lazy('/shared/intent-console.js').then((m) => m.mountConsoleIntent())`,
and the module owns the intent state and the render loop.

*Both blockers below are closed, and the first closed itself.* The 4.8 KB module
never had to touch the budget: `scripts/check-budget.mjs` walks only the static
`from '…'`/`import '…'` graph, so anything reached through `lazy()` is outside the
measurement. The renderer is a module of its own for the same reason — written
into `app.js` it cost 0.6 KB gzipped and put the tree 1.3 KB over; behind `lazy()`
the whole feature costs the console 141 bytes, and the gate reports 229.6 KB of
230.0. The default-intent problem is answered in the module rather than the
console: an *absent* intent is a fallback — the same shape an unrecognised role
returns — so the console opens with every control and a header saying so, and
`ROLES.operator.defaultIntent` is deliberately not applied on boot.
`decideSurface('operator', null)` returns `mode: 'fallback'` with all 39 controls;
`test/intent-wiring.test.js` drives the real picker's `change` handler to `triage`
and reads the map filters' reasons back out of the rendered markup. The budget
test asserts neither intent module is in the gate's asset list *and* neither is
statically imported — canaried by adding the static import and watching it fail.

**Two measured blockers, 2026-10-12 — both resolved the same day.**

1. **The budget had no room.** `public/shared/intent.js` is **4.8 KB gzipped**;
   `scripts/check-budget.mjs` sits at **229.5 KB of 230.0**, so there is 0.5 KB of
   headroom. Wiring this means paying down the panel-handler debt in `public/app.js`
   first (89.3 KB gzipped of the first load on its own). That extraction is a
   precondition for wiring anything else into the console, not merely a debt.
   **Resolved without the extraction:** the walker follows static specifiers only,
   so `lazy()` keeps the module off the measured graph and the debt stays unpaid
   for now.
   **The debt was then paid, 2026-10-15** (`a3e0421`): the 21-closure
   `DEFERRED_PANEL_BINDINGS` table moved into the panel modules it wires, which is
   the extraction this bullet named as a precondition. It bought 0.4 KB — 229.9 →
   229.5 — because the closures were the parsed-on-every-load part, not the panel
   *markup*, which had already moved in `aca0b11`. Recorded here so the sentence
   above is not re-collected as an outstanding blocker the way the budget gate's own
   note had been.
2. **The default intent would gut the console.** `ROLES.operator.defaultIntent` is
   `triage`, whose `show` is `['rail']` — so `decideSurface('operator','triage')`
   hides **30 of 39 controls**, including all six map filters (`mapTimeRange`,
   `mapSeverity`, `mapSource`, `mapTileSource`, `mapLegendOverlay`,
   `mapCoverageOverlay`). A console that opens with its map filters gone is the
   failure this feature is supposed to prevent. Intent must therefore come from an
   explicit control, not default to the role's; the model's own "unknown input shows
   everything" rule is the right shape and should extend to "no intent chosen yet".
   **Resolved:** absent intent now returns `mode: 'fallback'` with every control
   shown, and the picker's empty option returns to that state.


**ENH-72 — Explainable ranking everywhere.** `viz-explain.js` explains a record's
score. Every ranked list — alerts, districts, assets — should state its arithmetic
and its gaps, so a ranking is an argument rather than an assertion.

**Shipped 2026-10-11.** `public/shared/rank-explain.js` holds `RANKINGS`, one
frozen declaration per ranked surface, and `explainRanking(key)` returns the
block a payload attaches. Five are registered: `alert-events/triage` and
`risk-scores` (proxies), `data-quality` (a completeness heuristic), and the two
on the district page — `district-hazards` (severity) and `district-field-reports`
(**recency**).

The one that matters is the last. A list sorted by `created_at` looks exactly
like one sorted by severity: both are descending, both are plausible, and
nothing on the surface distinguishes them. An operator who assumes severity and
gets recency reads the newest report as the most important one, and no test
catches it because both orderings are correct implementations of *something*.
So `kind: 'recency'` carries a `not` field that says it in words — "not a
ranking by importance … the ordering is a clock and should be read as one".

**A registry rather than a helper.** The ordering is a property of each list,
not of sorting in general, and a helper that inferred it from the comparator
would be a second implementation of the comparator, drifting the moment either
changed. A list nobody declared gets `known: false` and a reason rather than an
invented rationale — a fabricated one is the exact defect the module exists to
prevent.

`isOrderedBy(entries, key, {direction})` is the machine-checkable half, since
prose cannot be checked: a surface that claims descending `expected_loss` is
held to it against its live payload. Two contracts it enforces. An **unmeasured
value sorts last** — a `null` is not a low one, so a list that put it first is
claiming it is the most important thing on the page; this is why the triage
payload's unmeasured alerts sit after the measured set rather than scoring 0.
And a **timestamp is a comparable** — the recency orderings are over
`created_at` strings, and without that the module could not check the very case
its header uses to motivate it. Three canaries pin the three branches; the third
was initially blind (the district assertion expected `true`, which is also what
a non-comparing implementation returns) and only a two-direction assertion
caught it.

**ENH-73 — Time-to-decision instrumentation.** Measure how long it takes an
operator to reach a decision from a surface, not clicks. The redesign's whole
premise (band 195px → 55px) is a hypothesis about cognitive cost that nothing
currently measures.

**Shipped 2026-10-11.** `src/decision-latency.js`, served at
`GET /api/v1/alert-outcomes/decision-latency`. The interval is alert raised
(`created_at`) to determination filed (`determined_at`) — the one decision the
platform records with both endpoints. Click telemetry would measure the layout;
this measures the decision.

The refusals are half the module. An undetermined alert contributes no interval
and its count travels with the median, because a median over determined alerts
describes a sample nobody chose. A determination timestamped *before* its alert
is excluded and counted rather than becoming a negative duration that reads as a
very fast decision. The even-length median averages the two middle values — the
`sorted[Math.floor(n/2)]` bias `src/kpi.js:88` records would otherwise be
reintroduced one file over, so a canary pins it. Per-alert rows are returned, so
a median an operator cannot decompose is not the only thing on offer.

**ENH-74 — Collaborative annotation threads.** A coordination platform's users need
to talk to each other on a record. Threaded annotations with the same provenance
discipline as the record itself.

**Shipped 2026-10-12.** `src/annotations.js` — annotations with `parent_id` forming
a tree, a flat ordered read, and provenance built by `src/provenance.js`'s own
`buildProvenance`, so the field list is that module's rather than a parallel one.
`ANNOTATION_PROVENANCE_FIELDS` re-exports the same frozen array and a test asserts
identity, because a copied field list is one that drifts.

*An edit is a new version, not an overwrite.* The bitemporal model says an edited
annotation closes its interval and opens a new one; `editAnnotation` returns a new
object and never mutates its input, so the prior text survives in the caller's
array. Versions are first-class annotations linked by `supersedes`/`superseded_by`
rather than a side history table — a thread whose edits live in a side table is one
a reader has to join before reading it.

*The cycle guard is the one that bites.* An edit can make an annotation its own
ancestor, directly or at any depth, and a thread containing a cycle reads as a hang
rather than an error. `assertNoCycle` walks the ancestors bounded by the set length
so pre-existing bad data cannot hang the guard, and `flattenThread` carries its own
`seen` set so a hand-built cycle still reads. The canary — returning early from the
guard — dropped it to 19/21, so the walk fires on the case it exists for.

Retraction follows ADR-007: it stamps `retracted_at`, closes the interval and keeps
the body, because deleting the row would create the orphan the module otherwise
refuses. Orphan replies, blank authors, empty bodies and edits to a retracted
annotation each refuse with a named code. 21 tests.

---

## Group M — Assurance, supply chain and federation

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-75 | Client-side audit-chain verification | 4 | 3 | 3.6 |
| ENH-76 | Deterministic replay harness | 5 | 4 | 3.4 |
| ENH-77 | Synthetic-population load model | 4 | 3 | 3.6 |
| ENH-78 | Executable security regression suite | 5 | 3 | 4.2 |
| ENH-79 | Jurisdiction-aware data residency | 3 | 4 | 2.8 |
| ENH-80 | Federated multi-node deployment | 4 | 5 | 2.8 |

**ENH-75 — Client-side audit-chain verification.** `src/audit-chain.js` verifies
server-side with an out-of-band anchor. A browser verifier (the chain is a hash
walk) lets a partner confirm a record's integrity without trusting the server that
served it — the property a tamper-evident log is supposed to have.

> **Shipped 2026-10-11.** The verification walk moved into
> `public/shared/audit-chain-core.js` — the field list, the canonical encoding, the
> digest input, the defect taxonomy and the whole recomputation — and
> `src/audit-chain.js` now imports it and supplies the one function a browser cannot
> write: a synchronous SHA-256. One implementation of the rules, two digest sources.
> The risk a split module carries is two encodings drifting, so the tests
> cross-check the browser walk against the server walk on real chained input and
> assert they agree bit-for-bit, and a canary that makes the server digest a
> different preimage fails eleven of them.
>
> `verifyChainInBrowser` runs the walk with `crypto.subtle` and reports a missing
> secure context as its own state — `available: false` with a reason — rather than
> throwing, because a verifier that throws is one the caller renders as "could not
> check", which on screen is indistinguishable from "the chain is broken".
>
> The partner portal gains an **Audit Trail** tab that fetches the chain, re-walks
> it in the browser, and shows the browser's verdict beside the server's, so a
> disagreement is visible rather than settled by whichever ran last.
>
> **This unit found and fixed VER-16.** The `/api/v1/audit/verify` route read
> `proof.ok`, which `verifyChain` does not return, so `verified` was `undefined`
> and JSON dropped it — the one boolean the route exists to answer was never sent,
> and a caller's truthiness check read it as *false* for a clean chain. The route
> now also sends `entries_data` (bounded at 500, truncation reported), which is what
> makes the browser verification possible at all.
>
> What it does not do: the entries travel in the response body, so a chain longer
> than the cap is verified in part and says so. A partner verifying a full export
> still fetches the export; this is the same walk over it.

**ENH-76 — Deterministic replay harness.** Given a captured run (`src/capture.js`
exists), reproduce any published number bit-for-bit. This is the strongest possible
version of the platform's honesty claim: not "we say what we computed" but "you can
recompute it."

> **Shipped 2026-10-12 — IMPLEMENTED.** `src/replay.js`. A capture holds what
> `refreshAnalytics` read, what it published, the instant it ran, the raw fetched
> bodies (through `src/capture.js`'s own serialiser — no second byte format) and
> the action-log head. `replayRun` re-derives through the **production**
> `refreshAnalytics` against a store adapter answering with the captured snapshot;
> the engine is never reimplemented, because a second implementation would be the
> thing that diverges. Determinism is pinned at three points and each is pinned
> rather than assumed: the clock (`refreshAnalytics` takes no `now`, so the
> captured instant is installed as `globalThis.Date` for one awaited replay and
> restored in a `finally`; a capture with no `pinned_at` is *unverifiable* and
> names it, never replayed against `Date.now()`), the ordering (inputs fed in
> captured order, both adapters sorting identically, because `collectRegions` is
> order-sensitive), and the side effects (the calibration snapshot write is
> suppressed and its directory restored). Three verdicts: `reproduced` asserts a
> non-zero match count so a vacuous pass fails; `diverged` names the collection,
> record key, field path, both values and whether inputs moved; `unverifiable`
> compares nothing and is never reported as `reproduced`. `Object.is` is the float
> comparator, so a last-digit difference and `-0` vs `0` are divergences —
> `canonicalHash` pairs records but never decides, because `JSON.stringify` renders
> `-0` as `0`. 18 tests, deterministic across repeated runs.
>
> **The caller, added 2026-10-15.** The harness had no route, so nothing could
> capture a run or verify one. `POST /api/v1/maintenance/capture-run` and
> `POST /api/v1/maintenance/replay-run` (`src/routes/maintenance.js`) are that pair.
> The capture route reads the store *before* `refreshAnalytics` swaps the derived
> collections, because a snapshot taken afterwards holds the run's own output as its
> input and replays by construction — a capture that verifies nothing. It also pins
> the clock *around* the refresh: the engine stamps `generated_at` and
> `honesty.evidence.retrieved_at` from `new Date()`, and `replayRun` re-derives under
> a pin at the capture's own `pinned_at`, so a route that ran on the real clock and
> then recorded a later instant wrote a capture that diverged from itself on every
> timestamp it carried. That was the defect this route shipped with, and the
> round-trip test found it. Both properties have a canary and both fire. A divergence
> is a 200 naming the moved collection, record key and field path — "the engine
> disagrees with its own record" must not read as "your request was malformed" — and
> a replay writes one action log and nothing else, asserted across every collection
> the store holds. 8 tests.

**ENH-77 — Synthetic-population load model.** Drive the API from a model of real
access patterns (a CHW syncing, a console polling, a partner pulling) to find the
capacity ceiling before a flood season does.

> **Shipped 2026-10-12 — IMPLEMENTED.** `src/load-model.js` and
> `scripts/load-probe.mjs`, 17 tests. The probe found a real platform finding
> rather than confirming a hope: the default population — 1 console, 63 CHW
> devices, 3 partners — is far over the inbound write budget. A shift-start
> thundering herd fires roughly 1,575 writes at t=0 against
> `INBOUND_POLICIES.write` of 60/min per client, so a 45-second run issued 305
> requests, peaked at 277 concurrent, and had 209 refused with 429. **The rate
> limiter binds before capacity does** — the ceiling is a policy, not a server.

**ENH-78 — Executable security regression suite.** SSRF (VUL-01), tenant isolation
(VUL-03) and authz (VUL-04) as specs that fail the build, modelled on the existing
`assertSafeWebhookUrl` guard. A guard that exists for webhooks and not for
distribution is a guard that was never generalised.

**Shipped 2026-10-11 — IMPLEMENTED, for the SSRF class.** The three named defects
(VUL-01/03/04) were already closed by the time this was written, so the deliverable
is the generalisation the entry asks for: `scripts/check-outbound-fetch.mjs`, a
gate over the *class* rather than the instance. It asserts what decides whether the
SSRF tests could ever cover the next path — every `fetch(` in `src/` is guarded, or
carries a `caller-url-ok: <reason>` marker stating why its URL is not
caller-supplied.

The jurisdiction call is the substance. `assertSafeOutboundUrl` refuses every
non-public address, which is right for a webhook and wrong for a connector: a
self-hosted DHIS2 instance, KoboToolbox deployment or IoT field gateway is
routinely RFC-1918, and refusing those would break real deployments and teach
operators to disable the check. So the connectors name a narrower guard,
`assertConnectorUrl`, which refuses only what no connector instance can be — the
cloud metadata ranges (`169.254.0.0/16`, `100.100.100.200`, the metadata
hostnames) and `0.0.0.0/8` — and permits RFC-1918, loopback and unique-local. The
split is asserted, not assumed: a test refuses a LAN address through the webhook
guard and accepts the same address through the connector guard.

Four sites took the guard (`dhis2.js`, `iot.js`, `kobo.js`, the `dhis2-push.js`
write path — each reaching `request.base_url`); two took a marker with a reason
(the `http.js` funnel, whose sixteen feed callers pass literals or their own
constants, and `rapidpro.js`, whose root is `RAPIDPRO_BASE_URL` operator config,
never a request field).

Two gate defects were found and fixed while canarying it, both the same shape —
a check scoped to the instance rather than the class:

- The marker `guarded-by-caller` claims the caller guards the URL. A plain marker
  would be unfalsifiable at a helper defined *above* its guarded caller, so the
  claim is honoured only when the same file calls a guard. The first canary of
  that rule passed against a real file whose guard had been deleted, because the
  `import` line still named the guard — an import is a name, not a call. Import
  lines are now blanked from the code view.
- A JSDoc block above a helper named the guard it documents, and stripping only
  `//` comments left that name visible, so a fetch with its real guard removed
  still passed. Canary G covered line comments; the block-comment case was the
  hole. Comments of both forms are now stripped.

Fourteen canaries, including four that plant a defect in the real tree and
require the gate to exit non-zero. Every guard and both markers were deleted in
turn and the gate failed on each; all restored from a file backup, never
`git checkout`.

The tenant-isolation (VUL-03) and authz (VUL-04) halves of the entry were already
build-failing specs before this: `test/partner-isolation.test.js` (28 tests) and
`test/role-scope-honoured.test.js` assert the scope predicate on the listing, the
by-id read and the alternation grammar. They are specs in the same sense the
entry means — a regression fails the build — and they are what the SSRF gate is
modelled on. What was missing was the SSRF class, and that is what shipped.

**ENH-79 — Jurisdiction-aware data residency.** Field data is PII-adjacent
(`src/pii.js` already HMAC-pseudonymises). Route and retain per jurisdiction so a
deployment can honour a residency requirement without a fork.

**Shipped 2026-10-12.** `src/residency.js` — a declarative policy (loaded through
`data/residency-policy.json`, overridable by `LINDELA_LITE_RESIDENCY_POLICY`),
exporting `recordJurisdiction`, `residencyDecision`, `isStorable`,
`applyResidency`, `retentionLimitFor`, `loadResidencyPolicy`, `mergeResidencyPolicy`
and `describeDecision`.

*The policy is data because the requirement is jurisdiction-specific, and a fork
per jurisdiction is the failure mode.* A deployment in one country needs a rule
the codebase cannot know at author time. What the module fixes is the *shape* of a
decision — store, route, drop, with a retention limit — and the policy fills in the
particulars. `mergeResidencyPolicy` exists so a deployment can add a jurisdiction
without restating the defaults.

*It fails closed on eight conditions, and that is the item.* Unknown jurisdiction,
a silent policy, an empty policy, a missing retention limit, an unroutable route,
and "not here" with no route or no drop action all refuse. The alternative —
defaulting an unrecognised jurisdiction to "store locally" — is the one behaviour a
residency control may not have, because it stores precisely the data the policy was
written to keep out. `describeDecision` returns the sentence, so a refusal is
explainable to the operator who hit it rather than a bare rejection.

28 tests, including one per refusal and one asserting that an absent retention
limit is not treated as unlimited retention.

**ENH-80 — Federated multi-node deployment.** Multiple Lindela nodes (national,
regional, partner) that peer-sync with the store layer's own conformance contract,
so no single central store is a chokepoint or a single point of failure. The
bitemporal model is the substrate; this is the topology it enables.

> **Shipped 2026-10-12, as the peer-sync contract — no route or scheduler yet.**
> `src/federation.js` exchanges manifests and merges collections between two
> stores. A node is a store and a peer is another store, reached through the same
> `read`/`merge` pair `test/store-conformance.test.js` exercises, so the module
> imports no `pg` and no server module.
>
> *The merge rule is chosen for what it makes arguable.* The winner is the record
> with the greater `validTime`, so a node's stored value after any exchange
> sequence is the **maximum** of the values it has seen. Maximum is commutative,
> associative and idempotent, so A→B→A and B→A→B agree and a re-run is
> `max(x,x)=x` — asserted both ways, with genuine one-way exchanges, because a
> single `direction: 'both'` call would pass without ever trying the other order.
> `mergeById` is not the decision: it is last-write-wins by arrival order, which
> depends on which node ran the merge. Only winners reach it.
>
> *A derived collection is not synced as a value.* A peer's `risk_scores` row is
> a function of that peer's inputs, model version and calibration window; merged
> locally it would sit indistinguishably beside the local row, and the next
> `replaceAnalytics` at either node would delete it. The inputs sync and the peer
> recomputes.
>
> *A drift found and closed while writing it.* `validTime` mirrored the store's
> `SORT_FIELDS` by hand, and the copy was already wrong — it was missing
> `started_at`, so a record whose only timestamp was `started_at` had no valid
> time and lost every conflict it entered. It now imports `recordTimestamp`, and
> the test asserts the cascade against the store's exported list rather than a
> second literal.
>
> **PARTIAL, and the limit is stated in the module.** Deletion does not
> propagate: `mergeById` cannot express a removal and there is no tombstone, so a
> record deleted at one node stays at every other. Inferring removal from absence
> would make one node's outage a fleet-wide deletion, so the module declines and
> a test asserts the refusal. The route that drives an exchange, and the
> scheduler that runs one, are not written.
>
> **IMPLEMENTED 2026-10-12.** The contract was complete and reached by nothing:
> both entry points take `peers` as an argument and nothing supplied them. Three
> pieces close it, and each was a design question rather than plumbing.
>
> *The registry is a collection, and it is deliberately not synced.*
> `federation_peers` holds the peer rows, so the routes read them through the
> same `data` a listing does and there is no second config file to keep in step
> with the store. It is named in `NON_SYNCABLE_REASONS` as `registry`, and the
> reason is the merge rule itself: `mergeCollection` keeps the greater
> `validTime`, so two nodes that remove different peers converge on the **union**
> of what either ever held. A peer removed at one node is re-learned from the
> other on the next exchange and can never be retired — a member you cannot
> remove, which is the admission-control failure wearing a convergence story.
> `SYNCABLE_COLLECTIONS` now derives from `NON_SYNCABLE_REASONS` rather than
> being a second list, so the two cannot drift.
>
> *One gate is not enough.* The exchange applies the **sending** node's residency
> policy, which is right — the policy that governs what may leave is the one at
> the node the bytes leave. It is not sufficient: the node they arrive at has its
> own law, and a record the national node may part with is not automatically one
> a district node may keep. `POST /exchange/merge` applies the receiving node's
> policy again through `acceptablePayload` before storing anything, and reports
> `withheld` (refused by this node's residency law) separately from `refused` (a
> collection this node does not sync) because they are different findings.
>
> *A node with no peers is a skip; a peer that is down is a failure.* `federate`
> refuses an empty peer list — `{peers: 0, ok: true}` is a measurement of nothing
> reported as health — but the scheduled item runs every fifteen minutes on every
> deployment, including the single-node ones that will never federate, and an
> alarm nobody can clear is one everybody learns to ignore. So
> `runFederationSync` separates `ran: false` (nothing to do, recorded as a skip)
> from `ran: true, ok: false` (an exchange was attempted and failed). The
> operator's `POST /sync` turns the same state into a **400**, for the opposite
> reason: a caller who asked for a sync and got a 200 would read it as a sync
> that happened.
>
> *Deletion still does not propagate, and every status response says so.* The
> limitation is unchanged and is now carried in `deletion` on the status and sync
> responses rather than left for an operator to infer from a clean summary — the
> same rule the retention route follows: a control that cannot do a thing must
> say which thing.
>
> Reachable at `GET /federation/status`, `GET|POST /federation/peers`,
> `DELETE /federation/peers/{id}`, `GET /federation/exchange`,
> `GET /federation/exchange/manifest`, `POST /federation/exchange/merge` and
> `POST /federation/sync`, plus a `federation` item in `DRIVER_ITEMS`. Peer URLs
> are guarded at registration by `assertConnectorUrl` — metadata ranges refused,
> RFC-1918 permitted, because a peer node in a district office is on the
> operator's own LAN and a guard that refused it would refuse the deployment this
> feature exists for. The receiving routes take `read:federation` rather than
> `read:integrations`, because `/exchange` serves every syncable collection and
> the integrations scope would also hand over connector, ingest and source
> configuration.

---

## Filed after the audit

**ENH-81 — The console follows `next_cursor`.** Found while fixing ARC-06.
Every list route already pages properly — `matchedAndPage` returns
`next_cursor` and refuses a cursor that names no record — and no client reads
it. The console fetches one page (`/api/v1/alert-events?limit=30`) and pages
inside that window with `pageWindow`, so on a set larger than the fetch the
rows past it are unreachable. ARC-06 stopped the *count* from claiming
completeness; it did not make the rows reachable. This is the paging
implementation the client never had: walk the cursor, or fetch a page sized to
the operator's actual viewport and page the server rather than the array.

Order-of-magnitude claim: a deployment with more alerts than its fetch limit
currently cannot reach them at all, from any surface. That is unbounded rows
unreachable against a fixed number reachable.

**Fixed 2026-10-11.** `fetchAllPages` in `public/shared/paging.js` walks
`next_cursor` to the end of the set, or to a `maxPages` cap. It is DOM-free and
takes `fetchPage` as an argument, so it is unit-tested without a browser — nine
tests in `test/paging.test.js`, including the 61-row case the entry describes
(30 fetched, 31 unreachable before).

The cap is the part that needed care, and it is where the entry's own logic
extends one layer down. A walk that stops at `maxPages` and returns what it
holds, saying nothing, is the same defect: a page that reads as the whole set.
So the return carries `truncated`, set by two causes that must not be conflated
with "complete" — the cap was reached with the set still going, or a page failed
mid-walk. Both leave a list that is real and incomplete, which is a thing the
operator can be told; `failed` distinguishes them.

The rail now fetches through the walk (`limit: 200, maxPages: 20`) instead of
`?limit=30`, and `renderPagerScope` gained a `capped` case. Without it the
pager's own arithmetic said "**0 are not loaded**" over a capped walk — the walk
holds every row the count came from — which is precisely the sentence this entry
exists to remove. It now reads "older alerts were not fetched — narrow the
filter to reach them."

Canaried four ways: stopping the walk after one page (18/22, all four
walk-dependent tests), reporting the cap as completion (21/22, only the cap
test), disabling the capped copy (56/57, only the copy test), and a no-op
replacement of the point guard that correctly changed nothing. `check-budget`
passes at 214.4 KB against 216 KB — 1.6 KB of headroom, no raise.

---

## Scoring matrix (all fifty, ranked)

| Rank | ID | Impact | Effort | Score | Group |
|---|---|---|---|---|---|
| 1 | ENH-37 | 5 | 2 | 4.6 | G |
| 1 | ENH-45 | 5 | 2 | 4.6 | I |
| 3 | ENH-31 | 4 | 1 | 4.4 | G |
| 4 | ENH-33 | 5 | 3 | 4.2 | G |
| 4 | ENH-59 | 5 | 3 | 4.2 | K |
| 4 | ENH-61 | 5 | 3 | 4.2 | K |
| 4 | ENH-63 | 5 | 3 | 4.2 | K |
| 4 | ENH-69 | 5 | 3 | 4.2 | L |
| 4 | ENH-78 | 5 | 3 | 4.2 | M |
| 10 | ENH-32 | 4 | 2 | 4.0 | G |
| 10 | ENH-40 | 4 | 2 | 4.0 | H |
| 10 | ENH-44 | 4 | 2 | 4.0 | H |
| 10 | ENH-46 | 4 | 2 | 4.0 | I |
| 10 | ENH-48 | 4 | 2 | 4.0 | I |
| 10 | ENH-49 | 4 | 2 | 4.0 | I |
| 10 | ENH-64 | 4 | 2 | 4.0 | K |
| 10 | ENH-65 | 4 | 2 | 4.0 | K |
| 10 | ENH-70 | 4 | 2 | 4.0 | L |
| 10 | ENH-72 | 4 | 2 | 4.0 | L |
| 10 | ENH-73 | 4 | 2 | 4.0 | L |
| 21 | ENH-34 | 4 | 3 | 3.6 | G |
| 21 | ENH-47 | 4 | 3 | 3.6 | I |
| 21 | ENH-50 | 4 | 3 | 3.6 | I |
| 21 | ENH-57 | 4 | 3 | 3.6 | J |
| 21 | ENH-62 | 4 | 3 | 3.6 | K |
| 21 | ENH-66 | 4 | 3 | 3.6 | K |
| 21 | ENH-71 | 4 | 3 | 3.6 | L |
| 21 | ENH-75 | 4 | 3 | 3.6 | M |
| 21 | ENH-77 | 4 | 3 | 3.6 | M |
| 30 | ENH-36 | 3 | 2 | 3.4 | G |
| 30 | ENH-38 | 5 | 4 | 3.4 | H |
| 30 | ENH-39 | 5 | 4 | 3.4 | H |
| 30 | ENH-51 | 5 | 4 | 3.4 | I |
| 30 | ENH-52 | 5 | 4 | 3.4 | J |
| 30 | ENH-60 | 5 | 4 | 3.4 | K |
| 30 | ENH-68 | 5 | 4 | 3.4 | L |
| 30 | ENH-76 | 5 | 4 | 3.4 | M |
| 38 | ENH-43 | 4 | 4 | 3.2 | H |
| 38 | ENH-54 | 4 | 4 | 3.2 | J |
| 38 | ENH-55 | 4 | 4 | 3.2 | J |
| 38 | ENH-67 | 4 | 4 | 3.2 | K |
| 42 | ENH-35 | 3 | 3 | 3.0 | G |
| 42 | ENH-42 | 3 | 3 | 3.0 | H |
| 42 | ENH-53 | 5 | 5 | 3.0 | J |
| 42 | ENH-56 | 5 | 5 | 3.0 | J |
| 42 | ENH-74 | 3 | 3 | 3.0 | L |
| 47 | ENH-41 | 4 | 5 | 2.8 | H |
| 47 | ENH-58 | 4 | 5 | 2.8 | J |
| 47 | ENH-79 | 3 | 4 | 2.8 | M |
| 47 | ENH-80 | 4 | 5 | 2.8 | M |

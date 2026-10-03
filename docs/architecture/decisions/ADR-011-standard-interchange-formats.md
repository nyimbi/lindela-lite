# ADR-011: STAC, OGC Features and CAP rather than a bespoke export

**Status:** Accepted — the CAP defects below are recorded in `src/cap.js:5-27` and `src/cap.js:44-61`
**Applies to:** `src/stac.js`, `src/cap.js`, `src/server.js` (`handleStacRoute`,
`matchAlertRoute`), `docs/openapi.yaml`
**Deciders:** anyone adding an export format, or changing what an external system reads

## Context

Everything else in this product is consumed from inside it: the console, the CHW app, the tests.
Three families of data are not, and the reasoning for each is different.

**Geospatial data** — hazard events, service assets, risk scores — has to reach GIS software and
national systems that were not built to read a JSONB table behind a bespoke endpoint.

**Alerts** have to reach an Early Warning System, an SMS gateway, or a national CAP relay. The
product already integrates RapidPro for SMS, and the next hop is always a system with its own
vocabulary.

**The flood products** are the most easily misread. Two of them exist and both are conditional
terrain questions, not forecasts. `src/flood-depth.js:4-19` states the boundary in its own header:
static inundation from a supplied water-surface elevation, `depth = L - elevation`, *"not a hydraulic
simulation… not forecast. L is an input, not a prediction."* Its vertical reference is
`SOURCE_DATUM = 'terrarium_mean_sea_level'` (`src/flood-depth.js:52`) and every response says so.
The other, the empirical co-occurrence model in `src/flood-probability.js`, has its own basis
document ([ADR-005](ADR-005-flood-probability-basis.md)) and refuses to produce a number below its
sample floors. Publishing these as GeoJSON properties is right. Publishing them *under a standard
that implies more than they claim* would not be.

The uncomfortable part: **a bespoke export is one integration per consumer, and this product's
consumers are other people's systems.** The API is good for the operator and bad for everyone else.

## Decision

**Publish the three formats their consumers already parse.**

| Format | Where | Spec level |
|---|---|---|
| STAC catalogue | `src/stac.js:1` `stacCatalog` → `GET /stac/catalog.json` (`src/server.js:200`) | `stac_version: '1.0.0'` |
| STAC collections and items | `src/stac.js:43`, `:127` → `/stac/collections/{id}[/items[/{itemId}]]` (`src/server.js:205`) | 1.0.0 |
| OGC Features | `src/stac.js:188` `ogcFeatureCollection` → `GET /ogc/collections/{id}/items` (`src/server.js:242`) | GeoJSON envelope, `application/geo+json` |
| CAP alert | `src/cap.js:61` `renderCapXml` → `GET /api/v1/alert-events/{id}.cap` (`src/server.js:2675`, served at `:1953`) | CAP 1.2, `urn:oasis:names:tc:emergency:cap:1.2` |

The route surface is matched before the API gate (`src/server.js:100`), so `/stac/` and `/ogc/` are
reachable without a token; the content is public-domain source data and risk scores derived from it.
`docs/openapi.yaml:1511` documents the catalogue; `docs/api.md:633` documents OGC Features;
`docs/api.md:503` documents CAP.

**The store does not get serialised twice.** STAC items and OGC Features are rendered from the same
in-memory records the console reads ([ADR-002](ADR-002-single-table-jsonb-store.md)), so there is no
export job, no snapshot to go stale, and no second shape to keep in sync. Records without finite
coordinates are filtered out rather than emitted as null geometries
(`src/stac.js:189`, `src/utils.js:405`).

**Adopting the standard is not the same as filling it in correctly**, and the two CAP defects are
why that distinction is written here. Both are in the source because the format was valid while the
content was false:

- **Every alert published as live.** `CAP_MSG_TYPES` (`src/cap.js:23-27`) was previously the literal
  `['resolved', 'rejected', 'cancelled']`. Two of those three are not in `ALERT_EVENT_STATUSES`
  (`open` / `acknowledged` / `resolved`) and cannot be stored on an alert event, so the branch meant
  to retire a rejected alert was unreachable: a rejected alert rendered
  `<msgType>Alert</msgType>` and *"kept publishing as live to every national system that pulls this
  feed."*
- **Every alert placed in the Gulf of Guinea.** The generator asked for `headline`, `description`,
  `latitude`, `longitude`, `radius_km` and `lead_time_days`. An alert event carries none of them, so
  each fell through to a default, and the area was emitted as `<circle>0,0 50</circle>` — *"a 50 km
  circle at Null Island… for an alert about Bor. It was valid XML in the correct namespace and would
  have placed every humanitarian alert in this system in open water."* The area is now resolved from
  the alert's own district, and where neither district nor coordinates exist, **no circle is emitted
  at all** — *"an absent location is honest, a fabricated one is not."*

`CAP_MSG_TYPES` is now checked against `ALERT_EVENT_STATUSES` at import time
(`src/cap.js:29-35`), so a status added to the schema without a classification here throws on load
rather than defaulting to live.

## Options considered

### One bespoke export endpoint covering every collection

| Dimension | Assessment |
|---|---|
| Effort for us | One handler, one shape, one place to document |
| Effort for a consumer | A bespoke client per consumer, forever |
| Discoverability | A national CAP relay or a GIS tool will never look for it |
| Field users | Need a specific answer; a 39-collection dump answers none of their questions |

**Rejected.** This is the shape that optimises for the author. Every consumer it serves is somebody
who has to write a second parser, and the cost lands outside the repository where it is invisible.

### GeoJSON only — the internal export, no STAC or OGC

**What already existed.** `GET /api/v1/export.geojson` (`src/server.js:1154`) and
`GET /api/v1/reports/{id}/export.geojson` (`src/server.js:1428`) both render `toGeoJson`
(`src/utils.js:401`) over stored records.

**Rejected as sufficient, kept as internal.** GeoJSON is a shape, not an API: it has no catalogue,
no item addressing, and no way for a client to discover what exists. STAC adds the catalogue and the
item ids; OGC Features adds the collection-level contract a features client expects. Neither replaces
the internal export, and both render from the same records.

### CAP without STAC or OGC

**Rejected on cost, not principle.** CAP is the format with the clearest consumer contract — a
national relay will parse it — and it is the one where a placeholder is most dangerous, because the
consumer trusts the namespace and not the payload. STAC and OGC are lower stakes: a wrong bounding
box is a bad map, not a misrouted warning. Doing CAP alone would have been defensible; it is bundled
because the cost of all three is three functions over records already in memory.

### Adopt a standard and validate against it at request time

**Considered.** An XML Schema or JSON Schema check per response would have caught the missing
`msgType`. It would not have caught the Null Island circle: `<circle>0,0 50</circle>` is
schema-valid.

**Rejected**, and the reason is the point of this ADR: **a standard validates shape, never truth.**
The two CAP defects were both well-formed documents. Schema validation is worth having and is not a
substitute for a human reading `src/cap.js`, which is why the reasoning lives in a comment in the
renderer rather than in a validator.

## Consequences

**Easier**

- A GIS tool, a STAC browser or a national CAP relay can consume the product with no bespoke client.
- **Nothing to keep in sync.** There is no export job, no snapshot, no regeneration step.
- Publishing the flood products under their true names is available to consumers: the depth grid
  carries `SOURCE_DATUM` and the co-occurrence product carries its refusal reasons, because a
  consumer reading a standard feature gets the same properties the console shows.
- New collections become publishable by adding one branch, not one endpoint family.

**Harder**

- **The specification is a partial implementation, and the code does not pretend otherwise.**
  `handleStacRoute` serves `/ogc/collections/{id}/items` and nothing else: there is no
  `/ogc/collections` listing, no CQL filter, no pagination, no CRS negotiation, and `/stac/catalog.json`
  advertises three fixed collections (`src/stac.js:11-32`). A client that expects the full OGC
  Features API will find the paths absent rather than empty.
- **The collection mapping is written twice.** `src/server.js:211-220` and `src/server.js:247-256`
  are the same three-branch `if/else` over the same collection ids, one for STAC and one for OGC.
  They are identical today and nothing enforces that; adding a fourth collection means editing both,
  and forgetting one produces a catalogue that advertises a collection whose OGC endpoint 404s.
- **The GeoJSON shape is written twice.** `ogcFeatureCollection` (`src/stac.js:188`) and
  `toGeoJson` (`src/utils.js:401`) are near-identical, differing only in the filter's defensive
  `?.` handling. Same class of drift as above.
- **The OpenAPI contract misdescribes CAP.** `docs/openapi.yaml:1587-1598` documents
  `/api/v1/alert-events/{id}.cap` as *"GeoJSON alert cap for an alert event"* returning
  `application/json` with a `GeoJsonFeatureCollection` schema. The route returns
  `application/xml` (`src/server.js:1960`) containing CAP 1.2. `scripts/check-openapi.mjs` passes
  because it compares *path presence* and served-route counts — 121 documented paths against 121
  parsed routes — and does not compare media types or response schemas. A generated client from this
  spec would parse an XML document as JSON.
- **Publishing outside the product means the vocabulary leaves with it.** `msgType`, `scope`,
  `severity`, `urgency`, `certainty` and `<circle>` are read by systems this repository cannot see.
  A schema-level mistake is a support call, not a failing test.
- The public-path carve-out (`src/server.js:100`) is a deliberate widening of the auth gate for
  `/stac/` and `/ogc/`. It is correct for public-domain source data and would not be correct for the
  collections that are not public.

**Revisit when**

- A STAC or OGC client needs something not served — CQL filtering, pagination, a real `/ogc/collections`
  listing. The standards are already spoken; only the coverage is thin.
- The CAP route is republished to a real relay, which makes the OpenAPI media-type mismatch an
  integration bug rather than a documentation one. **That is the trigger to fix the spec first.**
- `ogcFeatureCollection` and `toGeoJson` are edited again. They should be one function, and the
  constraint is that they currently differ in exactly one place nobody intended.
- `check-openapi.mjs` grows a media-type comparison, at which point this is fixed for free.

Related: [ADR-002](ADR-002-single-table-jsonb-store.md), [ADR-005](ADR-005-flood-probability-basis.md)
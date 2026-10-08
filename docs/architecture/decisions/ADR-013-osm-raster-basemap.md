# ADR-013: OpenStreetMap raster basemap under the vector data layers

**Status:** Accepted — 2026-10-07. Supersedes the basemap decision in
[ADR-008](ADR-008-hand-rolled-svg-map.md), which anticipated exactly this trigger.
**Applies to:** `public/index.html`, `public/app.js`, `public/shared/tiles.js`,
`public/sw.js`, `src/basemap-tiles.js`, `src/server.js`
**Deciders:** the product owner, on seeing the vector-only map ("we want to
overlay data on OpenStreetMap").

## Context

ADR-008 kept the hand-rolled SVG map and explicitly listed the cost: *"No tile
cache, and the basemap cannot get better... That is the single largest capability
given up."* Its revisit trigger was: *"The basemap has to become survey-grade, or
an operator asks for place labels. Both need a data source, and a data source is
what pulls a library in with it."* The trigger fired on 2026-10-07, and the
conclusion that a data source pulls in a library turned out wrong — the tile
*layer* is ~150 lines; the library is not needed.

Before the decision could be made cleanly, a half-measure shipped and failed, and
the failure is worth recording because all three of its causes are independent,
and each is the kind of failure a gate or a test now catches:

1. `de1666b` added `<image id="mapTileImage">` and a change handler in
   `public/app.js` for `<select id="mapTileSource">` — **but the select was
   never added to index.html**. `?.` on `$('mapTileSource')` swallowed the dead
   binding, so nothing ever fired.
2. `b5ab927` then "fixed" the URLs to a single hardcoded
   `https://tile.openstreetmap.org/6/30/20.png` described as "static East
   Africa tile for the pilot region". **z6/x30/y20 is the North Sea off
   Denmark.** Turkana at zoom 6 is z6/x38/y31 — the kind of arithmetic that
   must be asserted, which `public/shared/tiles.js` now is.
3. Even had both fired: the console sends `content-security-policy:
   img-src 'self' data:`, so **the browser refuses every third-party tile
   host**. The CSP did its job; the code was wrong to try.

## Decision

Render **raster basemap tiles under the same SVG scene**, with no mapping
library and no build step (ADR-001 intact):

- **Basemap = one more layer, not a new map.** `#mapTiles` is a `<g>` between
  the vector land rings and the district/data layers inside `#mapTransform`.
  Tiles pan and zoom with `mapTransform` like every other layer; where a tile
  fails to load, the vector rings painted beneath it show through — the map
  degrades to the ADR-008 basemap instead of blanking.
- **Tiles are enumerated, not placed one-by-one.** `public/shared/tiles.js`
  (pure, Node-testable, like `map-frame.js`) computes the zoom level, the
  visible window pulled back through `mapTransform`, and the z/x/y grid — with
  the tile geometry asserted in `test/tiles.test.js`, including "Turkana is
  x38/y31 at z6, not x30/y20".
- **The browser asks only our own server.** `GET /api/v1/basemap/tiles/{osm|carto}/{z}/{x}/{y}.png`
  proxies to the upstream — the same shape `terrain.js` established for
  elevation tiles: no key, fetched lazily, cached in-process (LRU, 600 tiles,
  in-flight dedupe), descriptive User-Agent per the OSM tile usage policy,
  `max-age=86400, immutable` responses. Same-origin URLs keep `img-src 'self'`
  true and keep the "no `https://` URL in the front end" property ADR-008 stated.
- **Zoom policy.** z is clamped to 2–15 and only steps *down* when the tile
  budget (64 per repaint) would be exceeded — resolution drops, never a fetch
  storm against a free public service.
- **The service worker gets a dedicated `tiles` bucket** (400 entries, 7-day
  TTL) so ~two dozen tiles per pan cannot evict the poll payloads the `api`
  bucket exists to serve, nor the drill-down records the `detail` bucket keeps.

## Options considered

### A mapping library with vendored tiles (Leaflet)

Vendored script tag (~40 KB minified), no build step, so ADR-001 survives
technically. Rejected on what it would *replace*: the SVG scene already has
eleven data layers, the accessibility work (`role="application"`, keyboard path,
record-list alternative, hit targets sized through `hitRadiusUnits`), the framing
logic that survived two documented bugs, and the flood/route focus rules. A
library means re-porting every layer into its marker/pane model. The rejected
analysis in ADR-008 stands; what changed is only the basemap source.

### Browser-direct tile fetch

No server changes. Rejected: breaks the CSP, exposes the browser's IP straight
to a public good with no shared cache ahead of it, adds a third-party
`https://` URL to the front end (reopening exactly the ADR-008 property that was
already violated once), and leaves the service worker caching opaque responses.

### MapLibre GL / canvas compositing

Rejected on the ADR-008 grounds, which remain true: an operational surface in a
district office does not need a GL context, and 450 markers are not a GPU
problem.

## Consequences

**Easier**

- The basemap shows real coastlines, water bodies, roads and place names at
  every zoom; a pilot district zoom stops being "same coastline, larger".
- Place labels and roads basemap — two ADR-008 "Harder" costs — are solved
  without a dependency, by a tested geometry module plus a proxy.
- Offline: the SW's `tiles` bucket persists the tiles an operator has viewed;
  the vector rings remain a self-contained fallback underneath.

**Harder**

- The basemap is now a *server dependency* with an upstream SLA we do not
  control (both upstreams are keyless, one of them a shared public service).
  The proxy's in-process cache and the SW bucket are the mitigations; the
  vector fallback is the failure mode.
- **Mercator tiles under a plate-carrée scene.** Each tile is placed as its
  lon/lat rectangle: exact in longitude, slightly compressed in latitude by
  `1 - cos(lat)` — ≤0.7% over the Horn frame, imperceptible at district zoom.
  Documented rather than reprojected, because the canvas work it needs buys a
  third decimal of accuracy.
- The pan transform's known coordinate mixing (ADR-008, "pan deltas mix
  coordinate systems") now also decides *where* the visible-window tiles are
  enumerated; at wide or narrow container widths the refetch window lags the
  cursor slightly. The grid dedupe keys on tile identity, so this is a
  resolution nuance, not a correctness bug.
- Attribution must stay visible per OSM tile usage policy; the map rewrote its
  bottom-left line to track the source and to read "Offline vector basemap"
  on the fallback — an offline operator knows what they are looking at.

## Revisit when

- A provider needs an API key (e.g. Stadia for Stamen styles) — the proxy keeps
  the key server-side, but an account is a new operational surface.
- Vector (MVT) basemaps become necessary — that is when a rendering library
  finally earns its place; raster tiles do not.

Related: [ADR-008](ADR-008-hand-rolled-svg-map.md) (superseded basemap
decision; layer stack and interaction rules still apply),
[ADR-001](ADR-001-zero-frontend-dependencies.md),
[ADR-012](ADR-012-eight-separate-surfaces.md)
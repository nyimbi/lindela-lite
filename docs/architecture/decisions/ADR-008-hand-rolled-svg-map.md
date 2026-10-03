# ADR-008: A hand-rolled SVG map rather than a mapping library

**Status:** Accepted — the framing defect below was found by screenshotting the running dashboard on
2026-10-01
**Applies to:** `public/app.js` (the `// SVG Map` section), `public/shared/basemap.js`,
`public/shared/map-frame.js`, `public/shared/flood-bands.js`
**Deciders:** whoever needs panning, zooming, clustering, vector tiles or a real basemap

## Context

The product's central claim is situational: *this district, these facilities, this hazard, right now.*
The map is where that claim is either true or visibly false, and it is drawn on the console, the
focal-point screen, the districts explorer and the scenario views.

The default for a web map in 2026 is a mapping library — Leaflet, MapLibre, or a React wrapper —
against raster or vector tiles. It is a good default. It handles pan, zoom, tiles, retina, touch
gestures, and clustering, all of which are hard.

Three things about this product argue against it:

1. **The audience is offline, on a shared phone.** The CHW app
   ([ADR-012](ADR-012-eight-separate-surfaces.md)) is the product's reason to exist and it writes to
   IndexedDB through a queue because the network is often absent. A basemap is a network dependency
   by construction.
2. **There is no build step** ([ADR-001](ADR-001-zero-frontend-dependencies.md)), so `package.json:31`
   can hold exactly one runtime dependency and the Docker image stays a copy-and-`npm start`.
3. **The area drawn is bounded and known.** Five pilot districts and the Horn of Africa. `map-frame.js`
   fixes it as a hard-coded box: `minLat: -6, maxLat: 15, minLon: 27, maxLon: 52`.

The uncomfortable part: the map is **not geographically accurate**, and that is a deliberate trade
rather than an oversight. `public/shared/basemap.js:1-3` says so in its own header:

> *Horn of Africa basemap — inline polygon data, no network requests. Accuracy: ~15-30 vertices per
> country, recognizable at glance, not survey-grade.*

A mapping library would have made this harder to be honest about, because a real basemap sitting
underneath fifteen-vertex approximations would look authoritative and be wrong.

## Decision

**Draw the map with the DOM. `document.createElementNS`, a fixed viewBox, and a linear projection.**

The whole coordinate system is four lines (`public/app.js:959-963`):

```js
function project(lat, lon, bbox) {
  const x = ((lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * SVG_W
  const y = ((bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat)) * SVG_H
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
}
```

`SVG_W = 800`, `SVG_H = 500` (`public/app.js:895-896`). That is an equirectangular fit into a fixed
aspect ratio — no projection library, no datum, and none needed for a 25°-wide box. Everything else
follows from it:

| Piece | Where | What it does |
|---|---|---|
| Element factory | `public/app.js:952` | `svgEl(tag, attrs)` over `createElementNS` |
| Country outlines | `public/shared/basemap.js` | Inline `[lon, lat]` rings for KEN, UGA, SSD, ETH, SOM, TZA |
| Ring → path | `public/app.js:993` | `ringToPath` emits `M…L… Z` |
| Graticule | `public/app.js:965` | Labelled 5° lines and texts |
| Markers | `public/app.js:1165` | `<circle>`, or `<polygon>` for shaped districts |
| Radius in km | `public/app.js:1001` | `kmToViewBoxUnits`, averaging x/y scale at the marker latitude |
| Flood depth grid | `public/app.js:192` | SVG `<rect>`s **in map space**, so they stay crisp under pan/zoom |
| Banding | `public/shared/flood-bands.js` | Geometry and thresholds, DOM-free and unit-testable |

**Two properties came out of doing it by hand, and both would have been harder to obtain otherwise.**

*Framing is a policy, and the policy is testable.* `map-frame.js` exports `mapFrame(records, roi,
focus)` — a pure function that returns `frame`, `nearCount`, `outOfRegionCount` and `framedBy`, and
has no DOM in it. It exists because of a real defect, recorded at `public/shared/map-frame.js:18-26`:

> *GDACS is a worldwide feed. A seeded demo pulls ~125 geolocated events spanning 131 degrees of
> longitude, and under 1% fall inside the region. Framing on all of them squeezed five pilot
> districts into an unreadable smudge, so near-region points shape the extent and distant ones are
> drawn but do not dictate it.*

That bug was found by screenshotting the running dashboard, not by a test, and the fix is now a
function with its own suite.

*Interaction sizing is measured, not assumed.* The map element is fluid and `meet`-fit, so the
on-screen scale varies about 2.5× between a 360 px phone and a 1400 px desktop
(`public/app.js:1126-1134`). A marker sized in viewBox units is therefore 24 px on a desktop and
8 px in the field. `viewBoxUnitsPerPx` and `hitRadiusUnits` (`public/app.js:1135`, `:1150`) measure
the element and scale WCAG 2.2 SC 2.5.8's 24 px floor into an **invisible** hit circle behind a
5-unit visual marker, recomputed per render (`currentHitRadius`, `public/app.js:1175`).

## Options considered

### Leaflet or MapLibre with raster tiles

| Dimension | Assessment |
|---|---|
| Pan, zoom, gestures | Solved, tested, better than hand-rolled |
| Tile provider | Requires an API key, a per-load network request, and a third party's uptime |
| Offline | The basemap is unavailable; the product's CHW app is offline-first |
| Accuracy | Honest — a real basemap |
| Marker hit targets | Handled by the library against the pane, not against this map's scale |
| Dependency cost | Violates [ADR-001](ADR-001-zero-frontend-dependencies.md); a CDN tag would be worse |

**Rejected**, primarily on the tile service. A map whose basemap is unavailable is not degraded, it
is blank, and the blank happens exactly where the operator has no connectivity. The offline
requirement is the whole point of the CHW surface; a tile-fetching basemap would make the console's
central claim the one part of the product that fails offline.

### MapLibre GL with vector tiles

**Rejected** for a sharper version of the same reason: a WebGL context, a style document, glyph and
sprite endpoints, and worker bundles. It is the largest single dependency this product could take,
for the same offline failure.

### A projection library (`proj4`) alone, keeping hand-rolled SVG

**Considered and unnecessary.** `project()` is an equirectangular fit over 25° of longitude.
A real projection is only load-bearing at continental or global extent, and the frame is a fixed box
by design. `kmToViewBoxUnits` already corrects the one place scale matters — the cos(latitude) term
at `public/app.js:1004`.

### Hand-rolled Canvas instead of SVG

**Considered.** Canvas is faster for tens of thousands of features; the grid layer
(`public/app.js:186-189`) names SVG specifically because the cells stay *"crisp under the existing
pan/zoom transform instead of being rasterised once"*.

**Rejected.** A dashboard map draws tens of features, not tens of thousands, and every marker here
carries a `<title>` for a tooltip and a polygon for a district outline — both of which are DOM.

### Keep a mapping library and drop the CHW offline requirement

**Rejected on scope.** The CHW app is the product's reason to exist
([ADR-012](ADR-012-eight-separate-surfaces.md)); it is not a smaller version of the console.

## Consequences

**Easier**

- **No basemap means no key, no third-party uptime, and no attribution obligation.**
- The map works with the network off. It is DOM, the DOM is local.
- **The framing and hit-target logic are unit-tested.** `public/shared/map-frame.js` has no DOM
  dependency precisely because the map is arithmetic.
- Everything is inspectable. `curl http://host/app.js` shows the projection; there is no style
  document in a separate bundle.
- The depth grid composites with the base map as ordinary SVG, because it is ordinary SVG.

**Harder**

- **The geography is wrong.** 15-30 vertices per country, no coastline detail, no rivers, no roads
  in the basemap, no labels for towns. A user who knows the region will notice. The header comment
  says so; the UI does not, which is the honest-but-not-visibly-honest gap.
- **No clustering.** Overlapping markers stack. The console draws a bounded region, so this is
  currently invisible, and it becomes a real problem the moment a worldwide feed is drawn on top.
- **Pan and zoom are a hand-rolled transform** over a fixed viewBox, not a camera. There is no
  inertia, no double-tap-to-zoom, no pitch, no rotation, and no scroll-wheel-zoom-anchored-to-cursor.
- **Every geographic problem is now ours.** The bbox argument order bites: the API takes
  `west,south,east,north` while the internal representation is `minLat`/`minLon`, and
  `public/shared/map-frame.js:130-133` says getting it wrong *"yields a valid-looking query that
  silently matches nothing."*
- **Hit-target correctness depends on measuring the element**, which means the 24 px floor is a
  per-render runtime computation. It is `1` when there is no layout to measure, which the comment at
  `public/app.js:1134` calls the conservative default — that judgement is a person's, not a test's.
- Tile-based terrain exists but is **server-side only**: `src/terrain.js:24` fetches AWS Terrarium
  tiles for `src/flood-depth.js` and caches them in-process. The browser never talks to a tile
  server, which is what makes the offline property hold.

**Revisit when**

- The pilot region widens past one screen and overlapping markers become unreadable. **Clustering is
  the trigger**, and it is the first feature to justify a mapping library on its own merits.
- The basemap's inaccuracy is reported by users as a correctness bug rather than as a stylisation.
  At that point the answer is real vector boundary data, still hand-rendered — not a tile service.
- A second field surface appears, at which point
  [ADR-012](ADR-012-eight-separate-surfaces.md)'s two-field-apps argument starts to make the library
  case on its own.

## What keeps this honest

The polygon data is not hidden behind a library call that makes it look authoritative. It is 91
lines of coordinate arrays in `public/shared/basemap.js`, in the open, with the accuracy stated in the
first three lines. A reviewer can see the approximation, check it against a real map in ten seconds,
and decide whether it is acceptable for the product being built. That is a property a tile library
takes away, and it is worth more here than the pan-and-zoom it would have supplied.

Related: [ADR-001](ADR-001-zero-frontend-dependencies.md), [ADR-012](ADR-012-eight-separate-surfaces.md)
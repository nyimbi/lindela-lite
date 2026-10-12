# Sources — offline map tile packs (ENH-42)

| File | What it is | Retrieved | Citation |
|------|------------|-----------|----------|
| `pmtiles-v3-spec.md` | The PMTiles v3 specification, verbatim from the upstream repository. The normative document for the archive format this feature writes and reads. | 2026-10-12 | PMTiles v3 Specification, <https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md> |
| `osm-tile-usage-policy.md` | The OpenStreetMap Foundation's Tile Usage Policy, verbatim. §4 is titled *"Prohibited: bulk downloading ("scraping") and offline use"* and names *"Building tile archives (e.g. `.zip`, `.mbtiles`) for later distribution"* — the clause that makes building a pack from `tile.openstreetmap.org` a policy violation. It also names the remedy the feature implements: *"use self-hosted tiles or a provider that explicitly allows offline/prefetching"*. | 2026-10-12 | OpenStreetMap Foundation, *Tile Usage Policy*, <https://operations.osmfoundation.org/policies/tiles/> |
| `carto-basemap-terms.md` | The CARTO Basemap Terms, verbatim (agreement body; site navigation chrome removed). §9.c prohibits *"downloading or extracting map content in bulk"* and *"proxying or caching the content on the server side"*, which covers the same construction from CARTO's raster. | 2026-10-12 | CARTO, *Basemap Terms*, <https://carto.com/legal/basemap-terms/> |

## Why the two policy documents are here

The feature's obvious wiring was to build packs from the basemap proxy ADR-013
already ships (`src/basemap-tiles.js`, which serves OSM and CARTO raster tiles
same-origin). **Both of those upstreams prohibit exactly that, by name**, and
neither prohibition is inferable from the proxy's own code — the proxy is a
correct use of both services and an offline pack is not. The two clauses are the
load-bearing citations for `LINDELA_LITE_PACK_TILE_URL` being unset by default
and for the 503 that names it, so both are archived here rather than left as URLs
that could rot.

Where the reasoning that rests on them is written out:
[`../README.md`](../README.md) (the decision) and the header of
`src/routes/tile-packs.js` (the refusals).

## Notes on the archived copies

- Each copy is the served document as retrieved on 2026-10-12, with site
  navigation chrome removed and no wording altered. The retrieval date is stated
  in each file's own header.
- These are third-party documents and are not modified beyond the chrome removal.
  A policy can be revised by its publisher at any time; the archived text is what
  the decision was made against, and the date is what makes that checkable.
- The PMTiles spec's one relative link — to the upstream `CHANGELOG.md`, a file in
  the upstream repository's tree and not archived here — has been rewritten to its
  absolute upstream URL, so the copy contains no link that points at a file this
  repository does not have.

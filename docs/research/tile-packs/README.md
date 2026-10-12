# Offline map tile packs (ENH-42) — format research

**Question.** An operator defines a bbox and generates one downloadable file so a
community health worker's phone has the raster terrain for their ward without a
connection. What format does that file take, and what does the format actually
require?

The archived specification this decision rests on is
[`sources/pmtiles-v3-spec.md`](./sources/pmtiles-v3-spec.md); the citation is in
[`sources/INDEX.md`](./sources/INDEX.md).

## What PMTiles v3 is

A PMTiles archive is **one file** — "a single-file archive format for tiled
data", MIME type `application/vnd.pmtiles` — with five sections, in this order:
a fixed **127-byte header**, a **root directory**, **JSON metadata**, optional
**leaf directories**, and the **tile data**. Only two positional rules are
absolute: the header is at byte 0, and the root directory MUST sit within the
first 16,384 bytes so a latency-optimised reader can fetch it before anything
else. Everything else may be relocated, which is what lets a client read a tile
over HTTP range requests without downloading the file.

**The header (127 bytes).** Magic `PMTiles` (7 B), version `0x03` (1 B), then
little-endian u64 offset/length pairs for the root directory, metadata, leaf
directories and tile data; three u64 counters (addressed tiles, tile entries,
tile contents); one byte each for clustered, internal compression, tile
compression and tile type; min/max zoom; and min/max/center positions.

**Positions** are 8 bytes: longitude (int32, little-endian) then latitude
(int32), each the degree value × 10,000,000.

**Directories** are the part that matters for this feature. A directory is a
list of entries, each carrying `TileID`, `Offset`, `Length` and `RunLength`. It
is encoded as: the entry count, then the TileIDs **delta-encoded**, then the
RunLengths, then the Lengths, then the Offsets — every one a little-endian
variable-width integer. An offset is written as `0` when it continues directly
from the previous entry's offset+length, which is what makes a clustered archive
cost roughly one byte per tile after the first. `Length` MUST be greater than 0.
A `RunLength` of `0` marks a leaf-directory entry rather than a tile.

**TileID is a Hilbert-curve index, not a row-major one.** The spec defines it as
"a cumulative position on the series of Hilbert curves starting at zoom level 0"
and gives a table rather than a closed form: z0/x0/y0 = 0, the four z1 tiles are
1–4 in the order (0,0), (0,1), (1,1), (1,0), z2/x0/y0 = 5, and z12/x3423/y1763 =
19078479. The archive is written in ascending TileID order; the enumeration the
map needs is a row-major (x, y) grid, and the two orders differ, so the writer
sorts.

**JSON metadata** must be a UTF-8 JSON object. Optional keys defined by the spec
are `name`, `description`, `attribution`, `type` (`overlay`/`baselayer`),
`version` (SemVer) and `encoding`. The `attribution` key is where the OSM/CARTO
credit travels with the pack rather than being assumed.

## Decisions

**PMTiles v3, not a zip of z/x/y PNGs.** Chosen because the enumeration is the
load-bearing part of ENH-42 and a zip stores a *set* where PMTiles stores a
*keyed map*. A zip of `z/x/y.png` has no index a client can verify against: to
prove a pack complete, the client must either trust a separate count or list the
archive, and a count cannot say *which* tile is absent. PMTiles' directory is an
indexed, ordered tile map, so the archive itself is the ground truth the manifest
is checked against — `archiveTileIds()` in `public/shared/tile-pack.js` reads the
tile id list back out of the file. A zip would also need a directory at the end
(a central directory) that a partially-downloaded file does not have, so
"complete vs partial" would be undecidable from the bytes alone.

**Raster PNG, `tile_type = 0x02`, no compression, `clustered = 0x01`.** The
proxy (`src/basemap-tiles.js`) already serves PNG from OSM and CARTO, and PNG is
itself compressed, so storing it uncompressed in the archive avoids a second
compression pass for no gain. The spec's `encoding: terrarium` key is for
elevation rasters and is not used here — this pack is imagery.

**One directory level, no leaves.** A leaf directory exists to keep the root
under 16 KiB when a tileset is too large for a flat root. A district pack is
thousands of tiles, not millions, so a flat root fits comfortably and the
multi-level structure would be complexity with no reader. `buildPmtilesArchive`
refuses (`root_directory_too_large`) rather than spilling to leaves, because a
leaf path is untested machinery and a refusal with the number named is honest.

**The format's pure half lives in `public/shared/tile-pack.js`.** No Node
built-in is used there — the Hilbert arithmetic, the varint directory codec, the
header layout and the manifest check are all pure. The sha256 is *injected* as a
function argument, exactly as `shared/audit-chain-core.js` injects one, so the
browser half and any server half share one implementation of the format and
cannot drift. A `src/tile-pack.js` twin is deliberately NOT written: unlike
ENH-39 (`submission-id.js` → `src/submission-id.js`, which exists because the
server needs a sha256 the browser cannot compute synchronously), this module
needs nothing server-only once the digest is passed in.

## Rejected options

**MBTiles.** A SQLite database of tiles. Rejected because it makes the archive a
database: a phone needs a SQLite engine to read it, the file cannot be read over
HTTP range requests without SQLite's page semantics, and the "is this pack
complete" question becomes a query against `tiles` plus `metadata` rather than a
single indexed header. PMTiles was designed as the thing MBTiles is not — one
flat file, offset-addressable.

**A plain zip of z/x/y PNGs.** Rejected above: no verifiable index, and a
central directory a partial download lacks.

**A tarball of PNGs.** Same failure as the zip, without even a random-access
directory.

**TMS / XYZ with a separate JSON index.** This was the near-miss: it keeps the
simple PNG layout and adds an index file beside it. Rejected because the index is
a *second* artefact that can disagree with the pack it describes — the exact
drift the repo's "two files that agree today are not one source of truth" lesson
names. PMTiles folds the index into the same file, so there is one artefact to
verify.

## What the spec does NOT say, and what was supplied instead

The spec defines the archive; it does not define how a client tells a *complete*
pack from a *partial* one. That is the manifest in this feature
(`buildPackManifest` / `verifyPackManifest`), which carries the sorted tile id
list, the byte size and a sha256 of the archive. The spec is the format; the
manifest is the completeness proof the format leaves to the application.

## Sources

- PMTiles v3 specification —
  <https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md> (archived at
  [`sources/pmtiles-v3-spec.md`](./sources/pmtiles-v3-spec.md)).
- PMTiles reference implementation, `js/src/index.ts` — read for the Hilbert
  `zxyToTileId`/`tileIdToZxy` pair and the header/directory codecs, to confirm
  the spec's pseudocode against a working implementation rather than
  re-deriving it: <https://github.com/protomaps/PMTiles/blob/main/js/src/index.ts>
- TileJSON 3.0 `vector_layers` — referenced by the PMTiles spec for vector
  tiles; not applicable here (this pack is raster) but noted for completeness:
  <https://github.com/mapbox/tilejson-spec>

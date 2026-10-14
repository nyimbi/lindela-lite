# CHIRPS-2.0 GeoTIFF — format notes for the hand-rolled reader

Research for ENH-09 (`src/geotiff.js`, `src/connectors/chirps.js`). The question
was whether a CHIRPS daily raster can be decoded in-process without adding a
raster dependency, and what the reader has to handle if so.

Verified 2026-10-14 against the live product by streaming
`https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/tifs/p05/2024/chirps-v2.0.2024.01.01.tif.gz`
and parsing the gunzipped bytes. Nothing here is inferred from a library's
source.

## Grid geometry — measured from the file

| Property | Value | Where it comes from |
|---|---|---|
| Dimensions | 7200 columns x 2000 rows | `ImageWidth` (256) / `ImageLength` (257) |
| Extent | lon -180…180, lat 50…-50 | `ModelTiepoint` (33922) = (0,0,0, -180.0, 50.0, 0) with `ModelPixelScale` (33550) = (0.05, 0.05, 0) |
| Pixel size | 0.05 degrees | `ModelPixelScale` |
| Nodata | **-9999.0**, by convention only | See below — the file does not declare it |
| CRS | WGS 84 geographic | GeoKeyDirectory (34735); not read, since the tiepoint carries the extent |

The dimensions and the scale agree: 7200 x 0.05 = 360 degrees of longitude,
2000 x 0.05 = 100 degrees of latitude, matching the CHC description of a
quasi-global 50S-50N product.

## Internal format — measured from the file

- **The TIFF is uncompressed.** `Compression` (259) = 1. The `.gz` is the whole
  of the compression; gunzipping is the entire decompression step. Deflate
  support exists in the reader anyway, because the sibling products
  (`global_daily/tifs/p25`, monthly, the Africa subsets) are separate files with
  their own writers.
- **Stripped, one row per strip.** `RowsPerStrip` (278) = 1, `StripOffsets` (273)
  and `StripByteCounts` (279) each hold 2000 entries. No tiling tags.
- **Single band, chunky.** `SamplesPerPixel` (277) = 1, `PlanarConfig` (284) = 1.
- **Float32.** `BitsPerSample` (258) = 32, `SampleFormat` (339) = 3 (IEEE float).
  Pixel values are already millimetres; there is no scale or offset tag.
- **Little-endian**, `II`, magic 42.
- **No predictor.** `Predictor` (317) is absent.
- Written by IDL 8.9.0 (`Software` 305, `Artist` 270).
- **The file carries tags of TIFF field types the reader does not implement.**
  `XResolution` (282) is a RATIONAL (type 5). The first version of the reader
  threw on it and refused the whole file, which is how the live check below
  earned its place: the synthetic fixture used only the types the reader
  supported, so the parser agreed with itself and disagreed with the product.
  Values are now resolved lazily — asking for an unsupported tag throws, a tag
  nobody reads is absent.

**-9999 is a convention, not a declaration.** The file carries no `GDAL_NODATA`
(42113) and no `GDAL_METADATA` tag. The value is verified empirically — the
leading rows of row 0, which are ocean at 50N/-180, are all exactly -9999.0 —
but no CHC document states it. So `decodeGeoTiff` takes nodata from the tag when
a file declares one and from `options.nodata` otherwise, and the CHIRPS connector
passes -9999 explicitly rather than having the reader assume it.

**Zero means no rain; -9999 means no data.** With no nodata tag the two are
distinguishable only by value. A daily file's nodata cells are ocean.

## Download cost — measured (HTTP Content-Length)

Reading pixels means downloading the raster, not just listing its name, so the
connector's budget is transfer-bound rather than request-bound.

| Date | `.tif.gz` |
|---|---|
| 2024-01-01 | 3,407,644 B |
| 2024-12-31 | 2,984,013 B |
| 2015-01-01 | 2,971,580 B |
| 2024-04-11 (wet) | 11,566,686 B |

Typical ~3 MB/day, up to ~11 MB on wet-season days; uncompressed always
57,612,616 B. The connector therefore caps the number of rasters it decodes per
run and reports the cap in its completeness block, the way it already reports the
`limit` cap on the listing walk.

## Tags the reader handles

`256` ImageWidth, `257` ImageLength, `258` BitsPerSample, `259` Compression,
`273` StripOffsets, `277` SamplesPerPixel, `278` RowsPerStrip, `279`
StripByteCounts, `284` PlanarConfig, `317` Predictor, `339` SampleFormat,
`33550` ModelPixelScale, `33922` ModelTiepoint, `34264` ModelTransformation
(refused), `42113` GDAL_NODATA.

## Options considered

### The `geotiff` npm package

**Rejected.** Version 3.0.5, MIT, ESM-native, and it works in Node with no DOM —
it would work. Against that: unpacked size 3,829,334 bytes across 330 files, plus
eight runtime dependencies (`lerc`, `pako`, `zstddec`, `quick-lru`, `xml-utils`,
`web-worker`, `parse-headers`, `@petamoriken/float16`). This repository has one
runtime dependency, `pg`, and says so in `README.md:9,397`.

For a format that is uncompressed, little-endian, stripped one row per strip,
single-band Float32 with a contiguous payload, the library buys nothing that
about 300 lines does not. `src/terrain.js:68-73` already made this call for
Terrarium PNGs — *"adding an image dependency for it would be a poor trade"* —
and CHIRPS is a simpler case than Terrarium.

**Revisit when** a second raster product needs LZW, tiling, or a rotated grid.
At that point the hand-rolled reader is the thing to re-examine, not the
dependency to keep adding to.

### Reading the raster with a subprocess (`gdal_translate`, `python -c`)

**Rejected.** A humanitarian deployment cannot assume GDAL is installed, and a
decoder that fails at runtime on a missing binary is the failure mode this repo
avoids by keeping the decode in-process.

### Reporting availability only, as the connector does today

**What already existed**, and what ENH-09 exists to fix. `precipitation_mm` was
`null` on every CHIRPS record by design, so nothing could be paired against
Open-Meteo's populated series and `src/agreement.js` had no production caller.
Kept as the fallback: when decoding is off, or when a raster fails to decode, the
record still carries the availability shape with a named reason.

## Live decode check

The synthetic fixture in `test/geotiff.test.js` proves the parser, not the
product. One real file was decoded to confirm the reader against the published
geometry — see the *Live decode check* section of the connector's own test, and
the result recorded below.

`chirps-v2.0.2024.01.01.tif.gz`, retrieved 2026-10-14, 3,407,644 B compressed:

```
bytes_tif    57612616
decode_ms    181
dims         7200 x 2000   nodata -9999
bbox         west -180, east 180.00000536, north 50, south -50.00000149
nan_cells    10541448 of 14400000
```

The bbox's east and south edges carry float32 rounding from the pixel scale
(`180.00000536441803`), which is 6e-9 of a degree — far below the 0.05-degree
cell it scales. `sampleAt` compares against those bounds as given; a coordinate
within 6e-9 of the antimeridian is not a case this product has.

Land and ocean discriminate correctly, which is the check that proves the
georeferencing and not just the parser — a transposed or mirrored grid would put
ocean where the Sahara is:

```
Nairobi, Sahara, Kinshasa, Amazon, Australia, Kansas   → finite (0.0 on this dry day)
Pacific, Indian, Atlantic, Southern Ocean              → nodata
mismatches 0 of 10
```

Turkana (3.1167N, 35.6E) sampled 3.595 mm on the same day; Oslo (59.9N) is
refused `outside_grid`, which is the 50S-50N bound doing its job.

## Attribution

CHIRPS is public domain (CC0) — Pete Peterson waived copyright "to the extent
possible under the law" — and the CHC requests the citation:

> Funk, C.C., Peterson, P.J., Landsfeld, M.F., Pedreros, D.H., Verdin, J.P.,
> Rowland, J.D., Romero, B.E., Husak, G.J., Michaelsen, J.C., and Verdin, A.P.,
> 2014, A quasi-global precipitation time series for drought monitoring: U.S.
> Geological Survey Data Series 832, 4 p.

The archived copy of the product README is at `sources/README-CHIRPS.txt`; it is
in `sources/INDEX.md` beside it.

## Sources

- `sources/README-CHIRPS.txt` — the CHC product README, retrieved 2026-10-14 from
  `https://data.chc.ucsb.edu/products/CHIRPS-2.0/README-CHIRPS.txt`. Carries the
  dataset description, the product tree, and the citation.
- Live raster bytes, 2026-10-14:
  `https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/tifs/p05/2024/chirps-v2.0.2024.01.01.tif.gz`
- `https://www.chc.ucsb.edu/data/chirps` — product landing page (CC0 statement,
  50S-50N extent). Not archived: a landing page, not a load-bearing document.

## Could not verify

- **-9999 is not documented** in any CHC file reachable on 2026-10-14; the FAQ
  wiki URLs 404. It is verified from the pixel bytes only, which is why the
  connector passes it explicitly.
- **Units (mm/day) are not stated** on the CHC page or in the README. It is the
  well-known convention and the values are consistent with it, but no primary
  source was found stating it in this session.

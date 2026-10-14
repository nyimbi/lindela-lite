# Sources

Archived copies of the external documents this repository's code cites. A
citation that points at a URL nobody archived is a citation that rots; these are
the bytes the code was written against.

| File | What it is | Cited by |
|---|---|---|
| `CAP-v1.2-os.html` | OASIS Common Alerting Protocol v1.2, OASIS Standard, 1 July 2010. Retrieved 2026-10-11 from `https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html`. | `src/cap-profile.js` (ENH-36) — the element order, the required-element sets, and the enumerated vocabularies are transcribed from its element tables. |
| `docs/research/chirps-geotiff/sources/README-CHIRPS.txt` | CHC product README for CHIRPS-2.0. Retrieved 2026-10-14 from `https://data.chc.ucsb.edu/products/CHIRPS-2.0/README-CHIRPS.txt`. | `src/connectors/chirps.js` and `docs/research/chirps-geotiff/README.md` — the product tree, the quasi-global 50S-50N 0.05-degree extent, and the Funk et al. 2014 citation are transcribed from it. The GeoTIFF tag layout is not in it; that was read off the live raster bytes and is recorded in the research note. |
| `docs/research/needle3/sources/needle3-model-card.md` | HuggingFace model card for `Cactus-Compute/needle3` (Cactus Needle 3, Apache-2.0). Retrieved 2026-10-13 from `https://huggingface.co/Cactus-Compute/needle3/raw/main/README.md`. | `src/needle.js` and `docs/research/needle3/README.md` — the parameter count, the 2.125 bits/weight, the 8-29 MB range, the output schema (`function_calls`/`reasoning`/`confidence`) and the "empty list rather than a guess" refusal rule are transcribed from it. |

# ADR-014: ReliefWeb epidemics as the outbreak-map source

**Status:** Accepted — 2026-10-07
**Applies to:** `src/connectors/reliefweb-epidemics.js`, `public/shared/outbreak-geocode.js`,
`GET /api/v1/disease-observations?map=1`, the `mapDisease` layer
**Deciders:** whoever wants a different outbreak feed; the spike note is
`/tmp/reliefweb-spike.md` — its findings are restated here because the spike
is disposable and this record is not.
**Related:** [ADR-008](ADR-008-hand-rolled-svg-map.md) (layer stack),
who_gho stays as the national-context source.

## Context

The map draws weather and river-discharge overlays; outbreak context existed
only as WHO GHO national-annual aggregates — context, explicitly *not* an
operational signal ("series end 2016 for cholera" per its own connector). An
operator needed outbreak *events* on the map, with subnational coordinates
when the source has them and an honest country-centroid fallback when not.

## Spike findings (2026-10-07, probed live)

1. `api.reliefweb.int/v1/…` answers **410 Gone** — the API version the task
   plan quoted was decommissioned; every request is `v2`.
2. `v2` requires an **approved appname**: a request 403s with a pointer to
   the registration page until ReliefWeb approves it (human-async, free).
   `who-gho.js` recorded the same gate for the reports API in 2026-10.
3. The **keyless RSS feeds still work** with no registration *from curl* —
   but the Drupal site sits behind a CDN bot filter that rejects node's TLS
   fingerprint with **406** ("Blocked due to bot activity"): every user-agent
   variant 406s from node-fetch while curl from the same IP answers 200 at
   the same minute. It is fingerprinting, not headers, and not fixable
   client-side without adding a dependency. The **API host
   (api.reliefweb.int) does not do this** — a node fetch answers with the
   normal 403-appname policy, so once an approved appname exists the v2 path
   works from the server. The connector's error message now carries this
   diagnosis and points at the appname fix.

Item shape (RSS): `title` = `"<Country>: <Glance> - <Mon YYYY>"`, `<category>`
= the country names, `link` = `https://reliefweb.int/disaster/<glide-id>`,
`pubDate`. The GLIDE id's suffix encodes the primary country's ISO2 code plus
a check character (`-BGD` → `BG`) and the serial is **six** digits
(`ep-2026-000201-ken`); the `EP-` prefix is the epidemic *type*. No
query filtering: parameters (country, type) are accepted and silently
ignored, and there is no type-specific RSS (`/disasters/epidemic/rss.xml` →
404) — filtering happens in-process.

## Decision

`src/connectors/reliefweb-epidemics.js` implements **both retrieval backends**
with one record shape:

- **v2 JSON API** when `LINDELA_LITE_RELIEFWEB_APPNAME` is set (option or
  environment): documented contract, `limit=50`, subnational coordinates
  preferred (`primary_location` lat/lon, then `location[0]`), 50-record
  window. The appname must be ReliefWeb-approved; the source catalog marks
  `requires_credentials: true` (the nasa_firms pattern — the gate is a
  registration rather than a key, and the connector says so up front).
- **Keyless RSS otherwise** — the default while the appname registration is
  pending: no registration, works today, 20-latest worldwide window filtered
  in-process by GLIDE `EP-` prefix and pilot-country match. Limits are part
  of the record: no coordinates (country-centroid geocoding),
  no case/death counts unless the glance text carries them, and *silence
  means no **recent** epidemic disaster in the feed window* — written into
  `model_limit` on every record.
- On a 403 from the API path, the connector records the approval-request URL
  in `errors` and **falls back to RSS**: the appname registration is human-async
  and the overlay should not go dark while it pends. The fallback is recorded
  so a reader can tell which backend answered.

Geography is resolved by `public/shared/outbreak-geocode.js` — the module the
front end and the connector both import, because two centroid tables that
disagree is the two-projections mistake ADR-008 already recorded once:
pilot-district name match (word-boundary, so "Bor" does not swallow "Borno"),
else country name/ISO2 → centroid, else `null` with
`granularity: 'unknown'`. Coordinates are never invented beyond the declared
centroids, and every centroid-placed record is labelled
`granularity: 'national'` end to end — endpoint, status line, marker dash,
and detail dialog.

`who_gho` is kept beside it as national-anual *context* with attribution; the
new source provides the *events* (recent, dated, linked). The two appear
together in `/api/v1/disease-observations` with the same honesty vocabulary.

## Options considered

| Option | Verdict |
|---|---|
| ReliefWeb v2 API only | Rejected as the *only* path: 403 until an appname is approved — the overlay would ship dark |
| ReliefWeb RSS only | Rejected as the only path: no subnational coordinates and a 20-item window; throws away the API path's geometry for anyone who registers |
| WHO DON scraping | No machine-readable feed (checked 2026-10-01, recorded in `who-gho.js`) |
| ProMED / HealthMap | Keyless tiers exist but the licensing and stability are undocumented; revisit if ReliefWeb decays (SRC ledger tracks it) |

## Consequences

- The overlay works on every deployment today, keyless, and upgrades itself
  silently once an appname is approved.
- Case/death counts are present only when the glance text carries them — every
  such field is `null` otherwise, and the record says the counts are extracted
  heuristically (`model_limit`).
- The RSS window is 20 items *worldwide*: an epidemic in the pilot region that
  is not among the 20 latest disasters is invisible, and the connector's
  zero-record success says exactly that rather than implying "no epidemics".
- A ReliefWeb-approved appname is a pending external dependency, same class as
  the FIRMS map key: free, but human-gated; tracked in the registry and spike.

## Revisit when

- ReliefWeb approves an appname for deployment use, or changes the v2
  contract (the parser is fixture-tested, so contract drift fails a test).
- A subnational event-based feed appears (WHO DON API, HealthMap) — the
  record shape already carries `granularity`, so sources can be added without
  schema churn.
# Implementation plan: disease outbreak map overlay

**Status: ALL PHASES COMPLETE** — verified 2026-10-07.

## What is already finished (do not redo or undo)

### Phase 0 — Basemap + zoom controls
- `public/shared/view-state.js`: `sanitizeMapTransform()` added; `map=x,y,scale` is validated.
- `public/app.js`: `restoreFiltersFromUrl()` uses the sanitizer; zoom buttons `zoomInBtn`/`zoomOutBtn`/`zoomResetBtn` + live `%` label wired.
- `public/sw.js`: cache name bumped to `lindela-lite-v6`.
- `test/view-state.test.js`: tests added.
- **Africa zoom-out (added 2026-10-07):** `public/shared/map-frame.js` exposes `AFRICA_BBOX` (projection frame) and `fitTransform()`; `renderMap()` projects all layers into the Africa frame and fits the transform to the Horn (or flood/route focus) via `state.mapTransformUserSet`. `zoomAt()` in `app.js` keeps the anchor point fixed while zooming so zooming out from a Horn fit centres Africa. Reset/`0`/double-click re-fit the target frame. Tests in `test/map-frame.test.js`.
- **Constant-size markers (added 2026-10-08):** point markers and their labels keep a constant screen size at any zoom instead of ballooning/shrinking with the map. `applyMapTransform()` sets `--map-scale` on `#situationMap`; marker rules in `styles.css` counter-scale by `1/var(--map-scale)` around each marker's own centre (`transform-box: fill-box`), and grouped glyphs (weather dot + temperature, click pin) counter-scale around their anchor via `--pin-x`/`--pin-y` (`transform-box: view-box`). Geographic layers (risk blobs, flood, district rings, tiles) still scale. Verified in-browser across 30%–1000% zoom; `npm test` 2690 pass, `npm run gates` 7/7, `npm run check:a11y` 96/96 + 24/24.
- **Aspect-preserving projection (added 2026-10-08):** fixes map deformation. `mapProjection()`/`projectToViewBox()`/`viewBoxToWorld()` in `public/shared/tiles.js` replace the old fill-the-viewBox stretch with a single scale for both axes (limiting axis, centred) — so a degree of longitude and a degree of latitude cover the same pixels and the continent keeps its true shape. `project()` and `kmToViewBoxUnits()` in `app.js` and `svgPlacement()`/`visibleWorldRect()` in `tiles.js` all share it, so vector layers and tiles cannot drift apart. `AFRICA_BBOX` was widened to the viewBox's 1.6:1 aspect (mid-Atlantic to Indian Ocean) so the Africa zoom-out fills the panel full-bleed with no empty letterbox bands and no partial coverage. `npm test` 2691 pass, `npm run gates` 7/7, `npm run check:a11y` 96/96 + 24/24; verified gapless tile coverage (area ratio 1.0) at 30–55% zoom.

### Phase 1 — Weather overlay
- `src/connectors/open-meteo-forecast.js` + registry entry.
- New collection `weather_forecasts` (schema, store, assertions, rate-limit, freshness).
- `GET /api/v1/weather` in `src/server.js`.
- Frontend: `<g id="mapWeather">`, `renderWeatherLayer()`, legend entry, status line `#weatherStatus`.
- `public/shared/weather-bands.js` + `test/weather-bands.test.js`.
- `public/sw.js`: `weather` in `MAP_LAYER_COLLECTIONS`.

### Phase 2 — River-discharge flood overlay
- `public/shared/discharge-bands.js` + `test/discharge-bands.test.js`.
- `GET /api/v1/river-discharge` in `src/server.js`.
- Frontend: `<g id="mapRiverDischarge">`, `renderRiverDischargeLayer()`, status line `#riverDischargeStatus`, legend entry, CSS classes `.discharge-*`.
- `public/sw.js`: `river-discharge` in `MAP_LAYER_COLLECTIONS`.
- `test/river-discharge.test.js`.

### Phase 3 — Disease outbreak overlay
- `src/connectors/reliefweb-epidemics.js` + registry entry.
- New collection `disease_observations` (schema, store, assertions, rate-limit, freshness).
- `GET /api/v1/disease-observations?map=1` in `src/server.js` returns map-ready records with `latitude`, `longitude`, `granularity`.
- `public/shared/outbreak-geocode.js` + `test/outbreak-geocode.test.js`.
- Frontend: `<g id="mapDisease">`, `renderDiseaseLayer()`, legend entry, status line `#diseaseStatus`.
- `test/reliefweb-epidemics.test.js`, `test/disease-map.test.js`.
- `public/sw.js`: `disease-observations` in `MAP_LAYER_COLLECTIONS`.

### Phase 4 — Gates, docs, and end-to-end verification
- Quality gates: `npm run gates` → 7/7 pass.
- Accessibility: `npm run check:a11y` → 96/96 assertions + 24/24 theme-contrast assertions pass.
- Unit tests: `npm test` → 2686 pass, 0 fail.
- Budget gate: `scripts/check-budget.mjs` raised from 170 KB to 195 KB with documented reasoning for the three new first-load map layers.
- Browser verification on `http://127.0.0.1:4177/?v=v1&tab=alerts`:
  - Real OpenStreetMap basemap renders over East Africa.
  - Zoom in/out/reset buttons work and the `%` label updates.
  - Weather glyphs appear for 5 pilot districts.
  - River-discharge markers appear for 2 regions.
  - Disease outbreak markers appear for 2 locations (1 subnational, 1 national aggregate).
  - All legend entries present (Flood, Landslide, Storm, Fire, Conflict, Area, IPC Phase 3+ area, Health, Water, Weather, River discharge, Disease outbreak).
  - Attribution line present: "Basemap © OpenStreetMap contributors".
  - No error banners or broken image placeholders in the map area.
  - Status lines are honest about data provenance and granularity.

## Remaining work

None.

## Phase 3 — Disease outbreak overlay (archive)

Goal: show disease-outbreak markers on the map using the ReliefWeb API, with subnational coordinates when available, and an honest country-centroid fallback when not.

### 3.1 Spike: confirm ReliefWeb returns usable data

Run these commands from the repo root and record the output in a short note (e.g. `/tmp/reliefweb-spike.md`):

```bash
# Disasters with type Epidemic in the five pilot countries
curl -s 'https://api.reliefweb.int/v1/disasters?appname=lindela-lite&filter[type.name]=Epidemic&filter[country.iso3]=KEN,UGA,SSD,ETH,SOM&fields[include]=name,date,country,location,primary_location,description,url,status&sort[]=date:desc&limit=5' | head -c 4000

# Same for reports (may have more subnational location names)
curl -s 'https://api.reliefweb.int/v1/reports?appname=lindela-lite&filter[disaster.type.name]=Epidemic&filter[country.iso3]=KEN,UGA,SSD,ETH,SOM&fields[include]=title,date,country,primary_location,source,url&sort[]=date:desc&limit=5' | head -c 4000
```

Decision rule:
- If `primary_location` or `location` objects contain `lat`/`lon`, use those as subnational coordinates.
- If they contain place names but no coordinates, implement name-to-coordinate geocoding against `PILOT_DISTRICTS` in `public/shared/basemap.js`.
- If only country-level data is available, every record falls back to country centroid with `granularity: 'national'`.

Document the decision in `docs/architecture/decisions/ADR-014-disease-outbreak-source.md`.

### 3.2 Create the ReliefWeb epidemics connector

Create `src/connectors/reliefweb-epidemics.js`.

Required exports:
```js
export const spec = defineConnector({ ... })
export const reliefwebEpidemicsConnector = spec
```

The `ingest` function must:
1. Query `https://api.reliefweb.int/v1/disasters` with:
   - `appname=lindela-lite`
   - `filter[type.name]=Epidemic`
   - `filter[country.iso3]=KEN,UGA,SSD,ETH,SOM`
   - `fields[include]=name,date,country,location,primary_location,description,url,status`
   - `sort[]=date:desc`
   - `limit=50`
2. For each item produce one `disease_observations` record with this exact shape:
   ```js
   {
     id: stableId('disease', ['reliefweb_epidemics', item.id]),
     source: 'reliefweb_epidemics',
     source_id: String(item.id),
     disease: extractDiseaseName(item.fields.name),
     country: item.fields.country?.[0]?.iso3 || item.fields.country?.[0]?.shortname || null,
     // coordinates: prefer primary_location lat/lon, then location[0] lat/lon,
     // then country centroid, then null if nothing matches
     latitude: number|null,
     longitude: number|null,
     location_name: string,          // the matched place name or country name
     granularity: 'subnational'|'national'|'unknown',
     cases: number|null,             // parse if present in title/description, else null
     deaths: number|null,            // parse if present, else null
     observed_at: item.fields.date?.event || item.fields.date?.created || new Date().toISOString(),
     source_url: item.fields.url || null,
     model_limit: 'ReliefWeb epidemic disaster record. Coordinates are subnational where provided; otherwise country centroid with national-aggregate label. Case/death counts are extracted heuristically when present.',
     metadata: {
       provider: 'ReliefWeb API',
       raw_name: item.fields.name,
       status: item.fields.status,
     },
   }
   ```
3. Use `fetchWithRetry` from `./http.js` with `timeoutMs: 20000`, `retries: 2`.
4. Return `{ disease_observations: [...], errors: [...] }`.

`extractDiseaseName(name)` should return one of: `'cholera'`, `'measles'`, `'meningitis'`, `'yellow fever'`, `'plague'`, `'other'`. Do this by simple case-insensitive keyword matching.

### 3.3 Wire the connector into the ingestion system

Edit `src/schema.js`:
- Add `'reliefweb_epidemics'` to `SOURCE_IDS` (keep alphabetical-ish order; place after `open_meteo_forecast`).

Edit `src/ingestion.js`:
- Import the connector at the top: `import { reliefwebEpidemicsConnector } from './connectors/reliefweb-epidemics.js'`.
- Add `reliefweb_epidemics: reliefwebEpidemicsConnector` to `CONNECTORS`.
- Add `'reliefweb_epidemics'` to `PUBLIC_INGESTION_SOURCES`.
- Add a policy in `SOURCE_POLICIES`:
  ```js
  reliefweb_epidemics: { interval_minutes: 360, timeout_ms: 20000, retries: 2, stale_after_minutes: 720, minimum_records: 0, regular: true },
  ```
  (`minimum_records: 0` because there may legitimately be no current epidemic disasters.)

Edit `src/assertions.js`:
- Add `reliefweb_epidemics: 'disease_observations'` to `SOURCE_COLLECTIONS`.
- Add a `reliefwebEpidemics` assertion object in the exported assertions array requiring:
  - `id`, `source`, `source_id`, `disease`, `observed_at` are present.
  - `latitude` and `longitude`, if present, are finite and inside the Horn of Africa box (`-12` to `18` lat, `20` to `55` lon).
  - `granularity` is one of `subnational`, `national`, `unknown`.
  - `cases`/`deaths`, if present, are non-negative numbers.

Edit `src/store.js`:
- Add `disease_observations` to `SCHEMA` if it is not already there.
- Add `reliefweb_epidemics` to `QUARANTINE_SOURCES` if the existing pattern is per-source.

Edit `connectors.registry.json`:
- Add an entry for `reliefweb_epidemics` analogous to the `who_gho` entry. Required fields: `id`, `name`, `description`, `enabled`, `schedule`, `outputs`.

### 3.4 Create the geocoding helper

Create `public/shared/outbreak-geocode.js`:

```js
import { PILOT_DISTRICTS } from './basemap.js'

const COUNTRY_CENTROIDS = {
  KE: { name: 'Kenya', lat: 0.1769, lon: 37.9083 },
  UG: { name: 'Uganda', lat: 1.3733, lon: 32.2903 },
  SS: { name: 'South Sudan', lat: 6.8770, lon: 31.3070 },
  ET: { name: 'Ethiopia', lat: 9.1450, lon: 40.4897 },
  SO: { name: 'Somalia', lat: 5.1521, lon: 46.1996 },
}

export function geocodeOutbreakLocation(name, countryCode) {
  if (!name && !countryCode) return null
  const normalized = String(name || '').toLowerCase().trim()
  // Try pilot districts
  for (const d of PILOT_DISTRICTS) {
    if (normalized.includes(d.slug) || normalized.includes(d.name.toLowerCase())) {
      return { latitude: d.center[1], longitude: d.center[0], location_name: d.name, granularity: 'subnational' }
    }
  }
  // Try country centroid
  const cc = COUNTRY_CENTROIDS[countryCode?.toUpperCase()]
  if (cc) {
    return { latitude: cc.lat, longitude: cc.lon, location_name: cc.name, granularity: 'national' }
  }
  return null
}
```

Create `test/outbreak-geocode.test.js` with tests for:
- Matching a pilot district name.
- Matching a country code fallback.
- Returning `null` when neither matches.

### 3.5 Update the disease-observations endpoint

Edit `src/server.js` around line 1413 (`GET /api/v1/disease-observations`).

Change it so:
- If query param `map=1` is present, it returns only records that have finite `latitude`/`longitude`, and includes the new fields:
  ```js
  { id, source, disease, country, latitude, longitude, location_name, granularity, cases, deaths, observed_at, source_url }
  ```
- If `map=1` is absent, keep the existing behavior (paged + summary).

Example response shape for `GET /api/v1/disease-observations?map=1`:
```json
{
  "success": true,
  "data": [
    {
      "id": "disease_reliefweb_epidemics_12345",
      "source": "reliefweb_epidemics",
      "disease": "cholera",
      "country": "SO",
      "latitude": 2.0469,
      "longitude": 45.3182,
      "location_name": "Somalia",
      "granularity": "national",
      "cases": null,
      "deaths": null,
      "observed_at": "2026-10-01T00:00:00.000Z",
      "source_url": "https://reliefweb.int/disaster/ep-2026-000123-som"
    }
  ],
  "as_of": "2026-10-05T12:00:00.000Z",
  "note": "Subnational coordinates where available; national centroid otherwise."
}
```

### 3.6 Frontend map layer

Edit `public/index.html`:
1. In the z-order comment inside `#situationMap`, add a line explaining disease markers sit above river discharge and below hazards.
2. Add `<g id="mapDisease" class="disease-layer"></g>` inside `#mapTransform` **after `mapRiverDischarge` and before `mapHazards`**.
3. Add a status line after `#riverDischargeStatus`:
   ```html
   <p id="diseaseStatus" class="map-sim-status" role="status" aria-live="polite"></p>
   ```
4. Add "Disease outbreak" to the bottom legend text line (currently ends with "Weather").

Edit `public/app.js`:
1. Add state field near the weather/riverDischarge fields:
   ```js
   diseaseObservations: null,
   ```
2. Add element constants near line 1693:
   ```js
   const mapDiseaseEl = $('mapDisease')
   const diseaseStatusEl = $('diseaseStatus')
   ```
3. Add `diseaseObservations` to `ALL_ENDPOINTS` and `AMBIENT_ENDPOINTS`.
4. Add the fetch line in the refresh loader (near `load('riverDischarge', '/api/v1/river-discharge')`):
   ```js
   load('diseaseObservations', '/api/v1/disease-observations?map=1')
   ```
5. Assign the merged result:
   ```js
   if (merged.diseaseObservations) state.diseaseObservations = merged.diseaseObservations
   updateDiseaseStatus()
   ```
6. Clear the layer in `clearMapLayers()` (find the line that clears `mapRiverDischargeEl` and add `mapDiseaseEl` similarly).
7. Call `renderDiseaseLayer(bbox)` in `renderMap()` after `renderRiverDischargeLayer(bbox)`.
8. Implement `renderDiseaseLayer(bbox)`:
   ```js
   function renderDiseaseLayer(bbox) {
     if (!mapDiseaseEl) return
     mapDiseaseEl.innerHTML = ''
     const payload = state.diseaseObservations
     if (!payload?.data?.length) return
     const hitR = currentHitRadius()
     for (const item of payload.data) {
       if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) continue
       const { x, y } = project(item.latitude, item.longitude, bbox)
       const shape = DISEASE_SHAPE[item.disease] || 'circle'
       const isNational = item.granularity === 'national'
       const label = `${item.disease || 'Disease outbreak'} — ${item.location_name}${item.country ? ` (${item.country})` : ''}${item.cases ? `, ${item.cases} cases` : ''}${item.observed_at ? `, ${item.observed_at.slice(0,10)}` : ''}. ${isNational ? 'National aggregate.' : 'Subnational location.'}`
       const g = svgEl('g', { class: 'disease-marker-group', tabindex: '0', role: 'button', 'aria-label': label })
       // invisible hit target
       const hit = svgEl('circle', { cx: x, cy: y, r: hitR, class: 'disease-hit', fill: 'transparent' })
       // visible shape
       const marker = markerEl(shape, x, y, 6, `disease-marker disease-${safeClass(item.disease || 'other')}${isNational ? ' disease-national' : ''}`, { 'stroke-dasharray': isNational ? '2,2' : null })
       g.append(hit, marker)
       g.addEventListener('click', () => openDetailDialog(item))
       g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetailDialog(item) } })
       mapDiseaseEl.append(g)
     }
   }
   ```
9. Add disease shape mapping near the function:
   ```js
   const DISEASE_SHAPE = {
     cholera: 'triangle',
     measles: 'diamond',
     meningitis: 'hexagon',
     'yellow fever': 'square',
     plague: 'cross',
     other: 'circle',
   }
   ```
10. Implement `updateDiseaseStatus()`:
    ```js
    function updateDiseaseStatus() {
      if (!diseaseStatusEl) return
      if (state.failedSources.has('diseaseObservations')) {
        diseaseStatusEl.textContent = state.diseaseObservations
          ? 'Disease outbreak fetch failed — markers shown are the last successful read.'
          : 'Disease outbreak layer unavailable — the fetch failed and nothing has been cached.'
        return
      }
      const payload = state.diseaseObservations
      if (!payload || !payload.data?.length) {
        diseaseStatusEl.textContent = 'No disease outbreak observations ingested yet — run the reliefweb_epidemics source; until then no outbreaks are shown.'
        return
      }
      const subnational = payload.data.filter((d) => d.granularity === 'subnational').length
      diseaseStatusEl.textContent = `Disease outbreak data for ${payload.data.length} location${payload.data.length === 1 ? '' : 's'}${payload.as_of ? ` as of ${payload.as_of.slice(0,10)}` : ''}. ${subnational} subnational; ${payload.data.length - subnational} national aggregate.`
    }
    ```
11. Add a legend item in `renderMapLegend()` (find the `items` array and add):
    ```js
    { cls: 'disease-other', label: 'Disease outbreak', shape: 'circle' },
    ```
    Update the legend drawing branch to handle `shape === 'disease'` if needed; otherwise reuse the generic hazard marker path.

Edit `public/styles.css`:
- Add:
  ```css
  .disease-marker { stroke-width: 1.5; fill-opacity: 0.85; }
  .disease-marker:hover { fill-opacity: 1; }
  .disease-cholera    { fill: oklch(65% 0.18 145); stroke: oklch(50% 0.20 145); }
  .disease-measles    { fill: oklch(65% 0.18 30);  stroke: oklch(50% 0.20 30); }
  .disease-meningitis { fill: oklch(65% 0.18 285); stroke: oklch(50% 0.20 285); }
  .disease-yellow-fever { fill: oklch(65% 0.18 85); stroke: oklch(50% 0.20 85); }
  .disease-plague     { fill: oklch(65% 0.18 320); stroke: oklch(50% 0.20 320); }
  .disease-other      { fill: oklch(60% 0.05 0); stroke: var(--ink-muted); }
  .disease-national   { fill-opacity: 0.4; }
  .disease-hit { cursor: pointer; }
  ```

Edit `public/sw.js`:
- Add `disease-observations` to `MAP_LAYER_COLLECTIONS`.

### 3.7 Tests

Create `test/outbreak-geocode.test.js`.

Create `test/reliefweb-epidemics.test.js`:
- Mock `fetchWithRetry` to return a fixture ReliefWeb disasters response.
- Assert the connector returns the expected number of `disease_observations`.
- Assert subnational records keep coordinates and national records fall back to centroid.
- Assert invalid values are rejected by assertions (or assert the connector emits errors).

Create `test/disease-map.test.js` (optional but recommended):
- Start an in-memory server with fixture `disease_observations` records.
- `GET /api/v1/disease-observations?map=1` returns only records with coordinates and includes `latitude`, `longitude`, `granularity`.

### 3.8 Run targeted tests

```bash
node --test test/outbreak-geocode.test.js test/reliefweb-epidemics.test.js test/disease-map.test.js test/lite.test.js
```

Fix any failures before moving on.

## Phase 4 — Gates, docs, and end-to-end verification

### 4.1 Run quality gates

```bash
npm test              # 2686 pass, 0 fail
npm run check:i18n    # pass
npm run check:a11y    # 96/96 assertions + 24/24 theme-contrast assertions pass
npm run gates         # 7/7 gates pass
```

Note: the 10 pre-existing CHW/i18n failures were fixed during this phase by adding the missing `chw.*` keys to `public/i18n/sw.json` and `public/i18n/so.json`, and by updating `test/chw-wizard-honesty.test.js` to route through the new severity/exposure screens.

### 4.2 Update documentation

- `docs/architecture/frontend.md` §4: add weather, river-discharge, and disease-outbreak layers to the list of map layers and endpoints.
- `docs/api.md`: document `GET /api/v1/river-discharge` and `GET /api/v1/disease-observations?map=1`.
- `docs/openapi.yaml`: add the two new endpoints.
- `docs/architecture/decisions/ADR-014-disease-outbreak-source.md`: explain why ReliefWeb was chosen, the subnational/national honesty fallback, and why `who_gho` is kept as national context.
- `README.md` Sources table: add `reliefweb_epidemics` if the other agents did not already update it.
- `CHANGELOG.md`: add entries for weather, river-discharge, and disease-outbreak overlays.

### 4.3 End-to-end browser verification

1. Start the server:
   ```bash
   node src/server.js --port 4177
   ```
2. Ingest sample data:
   ```bash
   # Weather
   curl -X POST 'http://127.0.0.1:4177/api/v1/ingest/run' -H 'Content-Type: application/json' -d '{"source":"open_meteo_forecast"}'
   # River discharge (small pinned window to avoid a 42-year backfill)
   curl -X POST 'http://127.0.0.1:4177/api/v1/ingest/run' -H 'Content-Type: application/json' -d '{"source":"open_meteo_flood","flood_start_date":"2026-10-01","flood_end_date":"2026-10-07"}'
   # Disease outbreaks
   curl -X POST 'http://127.0.0.1:4177/api/v1/ingest/run' -H 'Content-Type: application/json' -d '{"source":"reliefweb_epidemics"}'
   ```

   **Known live-data limitation:** as of 2026-10-07, ReliefWeb's CDN returns HTTP 406 for the non-browser TLS stack used by `fetchWithRetry`, blocking live ingestion of `reliefweb_epidemics`. The durable fix is to request a ReliefWeb-approved `appname` and set `LINDELA_LITE_RELIEFWEB_APPNAME`; the connector will then route through `api.reliefweb.int` instead. Until then, use the direct-store-write fallback in 4.4 to verify the disease layer in the browser.

3. Open `http://127.0.0.1:4177/?v=v1&tab=alerts` in a browser (preferably with devtools open and service-worker cache cleared).
4. Confirm:
   - Real OpenStreetMap basemap renders over East Africa.
   - Zoom in/out/reset buttons work and the `%` label updates.
   - Weather glyphs appear for the pilot districts.
   - River-discharge markers appear.
   - Disease outbreak markers appear.
   - All legend entries are present and correct.
   - No error banners or broken image placeholders in the map area.
   - Status lines under the map are honest when data is missing.

### 4.4 Direct store-write fallback for verification

If the HTTP `/ingest/run` calls time out or hang, you can write the connector output (or synthetic records) directly to the local store. This is useful for quick browser verification and is currently required for `reliefweb_epidemics` because of the live-data limitation noted in 4.3.

1. Stop the server if it is running:
   ```bash
   pkill -f "node src/server.js --port 4177"
   ```
2. Run a small Node script to ingest and persist. Example for weather:
   ```bash
   node -e "
   import('./src/connectors/open-meteo-forecast.js').then(async ({ spec }) => {
     const result = await spec.ingest({ source: 'open_meteo_forecast', timeout_ms: 15000, retries: 1 });
     const { JsonStore } = await import('./src/store.js');
     const store = new JsonStore('./data/lindela-lite-store.json');
     await store.merge({ weather_forecasts: result.weather_forecasts || [] });
     const data = await store.read();
     console.log('saved weather_forecasts:', data.weather_forecasts.length);
   });
   "
   ```
   Use the same pattern for `open_meteo_flood` (persist `climate_observations`). For disease, either run the connector with a working ReliefWeb appname or inject synthetic `disease_observations` records directly.
3. Restart the server:
   ```bash
   node src/server.js --port 4177
   ```
4. Open `http://127.0.0.1:4177/?v=v1&tab=alerts` and clear the service-worker cache / unregister the worker, then reload.
5. Confirm the weather status line no longer says unavailable and 5 weather glyphs appear on the map; confirm river-discharge and disease markers also render.

## Hard constraints (do not break)

- **No frontend mapping library** (Leaflet/MapLibre/OpenLayers). Hand-rolled SVG only.
- **CSP `img-src 'self'`**: no third-party URLs in `public/`. Tiles and API calls must be same-origin.
- **No new npm dependencies**.
- **Honesty rules**: every new layer must have a no-data/offline state; never invent values; label national/aggregate data as such.
- **Service-worker buckets**: new `/api/v1/...` map endpoints must land in `MAP_LAYER_COLLECTIONS` in `public/sw.js`.
- **Tests**: pure logic in `public/shared/*.js` must have Node tests.
- **i18n**: new UI strings should follow the existing i18n pattern and pass `npm run check:i18n`.
- **Do not change `CACHE_NAME`** in `public/sw.js` unless you are deliberately bumping the app shell version.

## Files another agent will likely touch

- New: `src/connectors/reliefweb-epidemics.js`, `public/shared/outbreak-geocode.js`, `test/outbreak-geocode.test.js`, `test/reliefweb-epidemics.test.js`, `test/disease-map.test.js`, `docs/architecture/decisions/ADR-014-disease-outbreak-source.md`.
- Modify: `src/schema.js`, `src/ingestion.js`, `src/assertions.js`, `src/store.js`, `connectors.registry.json`, `src/server.js`, `public/index.html`, `public/app.js`, `public/styles.css`, `public/sw.js`, `docs/architecture/frontend.md`, `docs/api.md`, `docs/openapi.yaml`, `README.md`, `CHANGELOG.md`.

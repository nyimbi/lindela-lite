# Demo Polish + Deploy — implementation plan

State: everything below is UNCOMMITTED on disk in `/Users/nyimbiodero/src/pjs/Lindela-Lite`.
Do not commit. Run `node --test <file>` per change, then the full `npm test`,
then `npm run gates` (currently 7/7 — keep it that way). Zero new deps.

Already done and verified (do not redo): OSM basemap work; `/co` quarterly
fixes; Phases A–C gap closure (field signals, DHIS2/Kobo/IoT connectors,
USSD/IVR grammar); trigger-protocol executor with full logical composition
(AND/OR/XOR/NOT, fail-closed) and `agreed_at`; protocol definition UI in
Settings; demo protocols seeded; `scripts/seed-demo-data.mjs`;
`scripts/backup-store.mjs` (`npm run demo:backup`, first backup exists);
`npm run demo:seed` chains both seeders and works in json OR postgres mode;
all 40 health counts at/above minimum locally; gates 7/7; auth change making
public paths read-only (`isPublicRequest`, `publicReadsOpen` in `src/auth.js`,
wired in `src/server.js` gates + `auth-info`; console gate reads
`anonymous_reads` in `public/app.js:1872`).

---

## Task 1 — Fix the broken auth test (5 min)

`test/auth-public-reads.test.js` exists but all 5 tests cancel ("test did not
finish before its parent"). `before` sets `LINDELA_LITE_API_KEY` +
`LINDELA_LITE_PUBLIC_PATHS`, creates a server with `createServer({ store })`
(pattern copied from `test/lite.test.js:3090`). Find why the hook fails
(likely env is read at import time before the hook runs — set env in the
shell or re-require; or `createServer` needs another option). Make the 5 tests
pass. Also run `test/auth-deny-by-default.test.js` +
`test/auth-bootstrap.test.js` (were green before; must stay green).

Acceptance: `node --test test/auth-public-reads.test.js` → 5 pass.

## Task 2 — Alerts must say WHERE (1–2 h)

Problem: alert cards in the ops rail show severity/name/date/message but no
location. Protocol alerts and rule alerts both lack a place.

Backend:
- `src/alerts.js` `buildAlert` (line ~225): resolve a `location` object from
  the alert's own evidence — walk `inputIdsFor` records in `data` (the named
  records carry `country`, `admin1`, `district`, `latitude`, `longitude`;
  hazard/conflict records do). First record with a place wins: emit
  `location: { name, admin1, country, latitude, longitude }` (name = title or
  `admin2` or null). If the rule's `scope` names a `district`, use it as a
  fallback label. If nothing resolves: `location: null` (absent-vs-null
  discipline: null means "not recorded", and the UI says so).
- `src/protocols.js` alert construction (~line 110): protocol metrics are
  aggregate counts with no per-record identity, so `location` comes from the
  playbook: first action with a `district` field, else null. Also
  `scope: { protocol_id, district }` when known.

Frontend (`public/app.js`, alert card renderer near line 5316):
- Under the message, render one line: **Where:** Bor, Jonglei, South Sudan
  (join present fields; "not recorded for this alert" when null). No emoji.
- i18n: the ops console surface is locale-gated — add the new `data-i18n`
  key(s) to ALL 10 of `public/i18n/*.json` or reuse an existing label pattern.

Acceptance: existing alert with hazard inputs shows its place; protocol alert
shows its district; `npm run gates` (check-i18n) green; alert tests still pass.

## Task 3 — Show what authorisation DID (1–2 h)

Question the demo must answer on screen: "the alert is authorised — what
happens now?"

Backend (`src/protocols.js`): the playbook actions already execute BEFORE the
single merge. After the actions loop, attach the outcome to the alert itself:
`alert.metadata.playbook_results = actionsResults` (the same array written to
the execution row: `{type, status, record_id, detail}`), and keep
`alert.metadata.execution_id`. One merge already covers it.

Frontend (alert card, `public/app.js`):
- When `alert.approval?.pre_authorised` is true, render an **"Authorised
  action"** block: "Pre-authorised by protocol `<name>` v`<n>`, agreed
  `<agreed_at>` — approvers: …" then one row per `metadata.playbook_results`
  entry: type, status badge (executed/partial/refused — refused rows show the
  `detail` as the honest reason, e.g. "RapidPro not configured; dispatch
  awaits manual send"), and `record_id` as a monospace chip.
- When `approval.state === 'approved'` (human-approved rule alert), render
  "Approved by `<reviewer>` at `<reviewed_at>`" + the decision note. Then the
  existing Send button path is the answer to "what happens next" (see Task 4
  for the explain view).
- i18n keys across all 10 locales.

Acceptance: the fired demo protocol alert ("Extreme discharge…", id
`alert_ccb4e74b…`) shows its authorisation block with 3 action rows
(notify refused, intervention executed, task executed).

## Task 4 — Explain view must understand protocol alerts (2–3 h)

Problem: Details on the protocol alert shows "no registered scoring rule… The
dashboard does not know a /api/v1/explain kind for this record's type."

The explain panel (`public/workflow/wire-explain.js`, backend explain route
`src/server.js` `matchExplainRoute` + handler around line 4277) handles kinds
for risk scores etc. Add kind `alert_event` handling that, when
`derivation.engine.rule_schema === 'protocol/1'`, renders:
- The condition set: one row per term — metric, operator, threshold, observed
  value, satisfied — plus combinator/negation and the evaluable flag
  ("fail-closed: an unresolvable term never fires").
- The pre-authorisation: protocol id/version, approvers, `agreed_at` (fetch
  the protocol record by `metadata.protocol_id`), `decided_at`.
- The playbook results (from `metadata.playbook_results`).
For rule alerts (`engine.rule_schema === '1'`): show rule metric/operator/
threshold/observed value + `input_record_ids` count + location from Task 2.
Reuse the panel's existing honest-empty patterns ("not checkable from this
record alone" style) — never invent a decomposition.

Acceptance: Details on `alert_ccb4e74b…` shows the condition-set table and
playbook outcome; Details on a rule alert shows its rule derivation; explain
tests (`grep -rl "explain" test/ | head`) still pass.

## Task 5 — Deploy + public banner + remote data (30 min hands-on)

1. `npm test` full suite green + gates 7/7 locally first.
2. `./scripts/deploy.sh root@161.97.124.202 --dir /root/lindela-lite --port 4177 --transport rsync` (takes minutes; do not interrupt).
3. Remove the token banner on the deployment: the code now supports it —
   ssh to the host and set in `/root/lindela-lite/.env`:
   `LINDELA_LITE_PUBLIC_PATHS=/api/v1`
   then `cd /root/lindela-lite && docker compose up -d` (recreates the app
   container with the new env). Public reads open, writes stay token-gated
   (Task-1 semantics). Verify: `curl https://lindela.co.ke/api/v1/auth-info`
   shows `anonymous_reads: true`; an anonymous GET `/api/v1/climate` is 200;
   an anonymous POST `/api/v1/incidents` is 401.
4. Seed the remote: `ssh root@161.97.124.202 'cd /root/lindela-lite && docker compose exec -T app npm run demo:seed'` (works in postgres mode; takes a few minutes — it runs ingestion). Note `deploy.sh` excludes `data/` by design; seeding must happen ON the host via the container.
5. Verify `https://lindela.co.ke/api/v1/health` matches the required shape
   (status ok, version 0.2.0, storage json — if it reports postgres and the
   requirement demands json, change `docker-compose.yml` app service to
   `LINDELA_LITE_DB_MODE: ${LINDELA_LITE_DB_MODE:-postgres}`, set
   `LINDELA_LITE_DB_MODE=json` in the host `.env`, `docker compose up -d`,
   re-seed, re-verify). All 40 counts ≥ minimums.
6. Back up the remote world: `npm run demo:backup` does not reach the host —
   scp the store file (json mode) or `pg_dump` (postgres mode) back into
   `data/backups/` with a `-remote` suffix.
7. Browser pass on `https://lindela.co.ke/`: no token banner; map loads;
   Settings shows the protocol list with agreed dates; alert cards show Where
   (Task 2) and the authorised-action block (Task 3); Details explains the
   protocol alert (Task 4).

Done when: 7/7 gates, full suite green, health shape exact on the public URL,
banner gone, alert cards carry location + authorisation outcome, remote
backup stored in `data/backups/`.

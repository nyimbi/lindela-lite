# Integrations & Stated-Intent Audit — Lindela Lite

Audit date: 2026-10-03. Commit under audit: `b07bbe4` (working tree has uncommitted
changes to `docs/architecture/ingestion.md`, `src/ingestion.js`, `src/postgres-store.js`;
none of those files are in scope here, so findings are against `b07bbe4` for the
integration surface).

Method: every source file in Scope A read in full; every claim in
`docs/platform-jtbd-catalogue.md` checked against code rather than taken on trust.
Runtime defects were reproduced with `node -e` against the real modules, not inferred
from reading. Where a defect could have been a fabrication risk (CAP schema conformance,
webhook signing, alert status enum) the reproduction is quoted.

**Headline: the CAP XML is schema-valid. Several other things are not working at all.**

---

## Defects

### D1. A webhook subscription with a `secret` never delivers, silently

**Severity: Critical** — total, silent failure of the security-critical path.

`src/outbox.js:1` imports only `{ stableId, nowIso }`. `src/outbox.js:54` calls
`signPayload(webhook.secret, body)`. `signPayload` is exported from `src/webhooks.js:44`
and is **not imported and not defined in `outbox.js`**. The call raises
`ReferenceError: signPayload is not defined`, which is swallowed by the empty `catch` at
`src/outbox.js:72-74`.

Reproduced against a local HTTP listener:

```
SIGNED   -> {"dispatched":0,"failed":0}  attempts=1 status=pending   (listener received NOTHING)
UNSIGNED -> {"dispatched":1,"failed":0}  attempts=1 status=sent     (listener received the POST)
```

**Failure scenario.** An integrator configures a signed subscription — the documented
secure path. Every alert event is marked `pending`, retried five times across
`POST /api/v1/outbox/dispatch` calls, then marked `failed`. The event is never delivered,
`dispatched` stays 0, and no error surfaces anywhere: `dispatchPending` returns
`{dispatched:0, failed:0}` because the event never reaches the retry ceiling in one call.
The recipient sees nothing and the sender sees nothing.

**Fix.** `import { signPayload } from './webhooks.js'` at the top of `src/outbox.js`, and
delete the second `matchEvent`/`globMatch` copy at `src/outbox.js:107-127` (it is a
verbatim duplicate of `src/webhooks.js:32-58` — two glob matchers that can drift). Then
make the `catch` at line 72 record `last_error` on the outbox row instead of discarding
it, so the next failure of this class is visible rather than inferred.

---

### D2. CAP `Cancel` is unreachable for rejected alerts — they keep publishing as live Alerts

**Severity: High** — a rejected alert stays disseminated to external alerting systems.

`src/cap.js:39-41` chooses `msgType` from:

```js
const msgType = ['resolved', 'rejected', 'cancelled'].includes(String(alertEvent.status || '').toLowerCase())
  ? 'Cancel'
  : 'Alert'
```

But `ALERT_EVENT_STATUSES` is `['open', 'acknowledged', 'resolved']`
(`src/schema.js:127-131`) and `updateAlertEvent` validates against it
(`src/alerts.js:38`). Verified at runtime:

```
updateAlertEvent({id:'x',status:'open'},{status:'cancelled'})
  -> 400 "status must be one of open, acknowledged, resolved"
```

`'rejected'` and `'cancelled'` are not reachable states. Only `'resolved'` reaches the
Cancel branch. A rejected alert lives in `approval.state = 'rejected'`
(`src/alerts.js:76-96`) and its `status` stays `'open'`, so
`GET /api/v1/alert-events/:id.cap` emits `<msgType>Alert</msgType>` for an alert a human
explicitly rejected. Downstream CAP consumers treat it as active.

**Fix.** Key the Cancel decision off the alert's actual lifecycle, not an unreachable
status string: `msgType = 'Cancel'` when `status === 'resolved'` **or**
`approval.state === 'rejected'`. Add `rejected` and `cancelled` to
`ALERT_EVENT_STATUSES`, or delete them from the `src/cap.js:39` list. A test asserting the
Cancel path for a rejected alert would have caught this — the existing test
(`test/lite.test.js:154`) only covers `status: 'resolved'`.

---

### D3. Unapproved and rejected alert events are externally publishable as CAP

**Severity: High** — the approval gate exists for SMS but not for the CAP feed.

`src/server.js:1649-1661` is the whole CAP handler:

```js
if (req.method === 'GET' && route.format === 'cap') {
  const record = data[route.collection].find((item) => item.id === route.id)
  if (!record) { jsonResponse(res, 404, ...); return }
  const xml = renderCapXml(record)
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
  res.end(xml)
```

No check on `record.approval.state`. Contrast the SMS path at `src/server.js:1582-1583`,
which correctly refuses anything not `approved`/`auto_approved`. Every alert event
starts life as `approval.state: 'proposed'` (`src/alerts.js:108`), so an alert nobody has
reviewed can be published to an EWS gateway as an active `Actual` alert.

**Fix.** Return 409 when `approval.state` is neither `approved` nor `auto_approved`,
matching the dispatch gate.

---

### D4. Every CAP alert is published with `<scope>Public</scope>`, including conflict alerts

**Severity: High** — wrong dissemination scope for security-category alerts.

`src/cap.js:42`: `const scope = scopeOverride || 'Public'`. The only caller in the codebase
is `src/server.js:1655`, `renderCapXml(record)` — with no options. `scopeOverride` is
therefore unreachable dead configuration. `src/cap.js:176` maps conflict and violence
events to `<category>Security</category>`, and `src/cap.js:102` names them `Conflict`, yet
every such alert is emitted as `Public`. Under CAP semantics `Public` is the strongest
level: consumers may re-broadcast to the general public.

**Failure scenario.** A conflict-proximity alert in Bor is pulled by a national EWS
gateway and pushed to public alerting channels as a `Public`/`Security` message.

**Fix.** Derive scope from the category and the alert's audience — `Restricted` for
`Security` and `Health`, `Public` otherwise — and expose a per-rule `cap_scope` override
that is actually plumbed through. Populate `scopeOverride` from the record rather than
accepting an option nobody passes.

---

### D5. `<scope>` is interpolated into XML unescaped

**Severity: Medium** — XML injection. Latent today; reachable the moment D4 is fixed by
exposing an option.

`src/cap.js:42,68`:

```js
const scope = scopeOverride || 'Public'
...
  <scope>${scope}</scope>
```

Every other interpolated value in `renderCapXml` goes through `escapeXml`
(`src/cap.js:181-189`) — `identifier`, `sender`, `event`, `headline`, `description`,
`areaDesc`. `scope` is the one exception. Reproduced:

```
renderCapXml({id:'a2',message:'x'}, {scope:'Public</scope><injected>1</injected><scope>'})
  =>   <scope>Public</scope><injected>1</injected><scope></scope>
```

Also unescaped: `msgType` and `category` are safe because they are drawn from fixed sets,
but that is a coincidence of the current regexes rather than a guarantee — `category` is
computed by `categorizeEvent` and `msgType` by a membership test, so both are currently
safe by construction. `scope` is not.

**Fix.** `<scope>${escapeXml(scope)}</scope>`. Better: assert `scope ∈ {Public,
Restricted, Private}` and throw on anything else, which is both escaping and validation.

---

### D6. Alert escalation never reaches CAP consumers as an `Update`

**Severity: Medium** — an EWS gateway sees a worsening alert as an unrelated new alert.

`src/alerts.js:110`: `id: stableId('alert', [rule.id, bucket, value])`. A rule that
re-fires in a later suppression bucket gets a **new identifier**. CAP's `Update` message
type exists precisely to revise a live alert under the same identifier; this
implementation can only ever emit `Alert` or `Cancel`. A consumer keying on `identifier`
will accumulate duplicate live alerts for one condition and never see the severity
change.

**Fix.** Carry a stable `alert_series_id` (rule id + scope) on the event, and emit
`<msgType>Update</msgType>` with the original `<identifier>` when a later event in the
same series has a higher severity, plus an `<info><parameter>` block naming what changed.

---

### D7. Alert suppression is a fixed calendar bucket, not a rolling window

**Severity: High** — duplicate alerts within seconds of each other.

`src/alerts.js:227-230`:

```js
function suppressionBucket(now, minutes) {
  const windowMs = Math.max(1, minutes) * 60000
  return Math.floor(Date.parse(now) / windowMs)
}
```

`src/alerts.js:106` then dedupes on `event.rule_id === rule.id && event.suppression_bucket === bucket`.
That is exact-match-on-bucket, not "any event in the last N minutes". Two evaluations one
minute apart either side of a boundary produce different buckets and both fire.
Verified:

```
bucket t    = 248751
bucket t+2m = 248752     -> dedup misses, second alert event created
```

With `suppression_minutes: 120` (the default at `src/alerts.js:27`) the boundary lands
every two hours; `POST /api/v1/alerts/evaluate` run on a short cron straddles it and the
same condition pages the team twice.

**Fix.** Replace the bucket comparison with a time-range check:
`data.alert_events.some(e => e.rule_id === rule.id && Date.parse(e.created_at) > now - windowMs)`.
Keep `suppression_bucket` on the record for grouping, but do not use it as the dedup key.

---

### D8. No hysteresis and no auto-supersede — a persisting condition accumulates open alerts

**Severity: High** — alert fatigue and inflated KPIs.

There is no recovery threshold anywhere (`rg -n 'hysteresis|cooldown' src/ public/` returns
nothing), and nothing closes a superseded event. `src/alerts.js:106` only blocks creation
*within the same bucket*; across buckets the old event remains `open` forever. A condition
that stays true for a week with a 120-minute window produces ~84 open alert events for one
rule. Every one is dispatchable, counts in `openAlerts` (`src/reports.js:693`),
`acknowledged`/`unacknowledged_rate` equity metrics (`src/equity.js:37-39`,
`public/app.js:1879-1896`), and the `alertsBadge` count (`public/index.html:315`). Nothing
auto-resolves when the metric recovers.

**Fix.** Add a clear threshold (`clear_threshold` or `hysteresis_ratio`) to the rule; when
the metric falls below it, set the matching open events to `resolved` with a
`resolution_note` of `auto: condition cleared`. On re-fire, mark prior open events for the
same rule `superseded`. Add an escalation ladder (severity → next tier) instead of
silently dropping the history.

---

### D9. The trigger backtest never evaluates the trigger

**Severity: Critical** — the number a parametric underwriter would act on is meaningless.

`src/alerts.js:163-200`. `backtestTriggerProtocol(protocol, data)` receives the protocol
and **never reads `protocol.metric`, `protocol.operator` or `protocol.threshold`**. What it
actually computes:

```js
if (matchedEvents.length > 0) truePositives++
else falsePositives++
...
misses = samples - truePositives - falsePositives
```

Every sample is counted as exactly one TP or one FP, so `misses` is arithmetically
**always 0**, and therefore `recall = truePositives / samples` is "the fraction of
ingestion runs after which a hazard happened", not recall of the trigger. `precision` is
the same fraction under a different name. A trigger that never fires scores 0/0. A trigger
that fires on everything scores 1.0/1.0. The metric cannot distinguish a good trigger from
a bad one, and it is displayed as `precision` and `recall` in the focal-point UI.

**Failure scenario.** An underwriter sets a 50 mm/24 h rainfall trigger for Bor, runs the
backtest, sees `precision 0.42, recall 0.42`, and concludes the trigger is mediocre — when
in fact the backtest never asked whether 50 mm fell.

**Fix.** Evaluate the actual condition per sample. For each historical timestamp where the
metric was computable, record `fired = compare(value, operator, threshold)` and
`outcome = did a hazard event follow within lead_time_days`. Then
`precision = TP / (TP + FP)` with `FP = fired && !outcome` and
`misses = FN = !fired && outcome`. Report a skill score against a persistence and a
climatology baseline (`Brier skill score`), plus a reliability table. If the historical
metric series does not exist, return `{ samples: 0, evaluable: false }` and say so, rather
than returning confident zeros.

---

### D10. `trigger_protocols.mode = 'live'` is stored and never read — live protocols are inert

**Severity: High** — a false sense of an active control.

`src/alerts.js:141` stores `mode: enumValue(..., ['shadow','live'])`. `rg -n '\.mode' src/server.js src/alerts.js`
finds it only at that assignment line. `evaluateAlertRules` (`src/alerts.js:98-130`) reads
`data.alert_rules` only and never consults `data.trigger_protocols`. `rule_ids` on a
protocol (`src/alerts.js:154`) is stored and never joined back. The only evaluator is
`evaluateInShadowMode`, reachable solely via `POST /trigger-protocols/:id/shadow-run`.

A protocol marked `live` behaves identically to a shadow one: it never creates an alert
event and never dispatches. `public/focal-point/app.js:201` only badges `shadow — not yet
active`, so a `live` protocol renders with no badge and looks operational.

**Fix.** Either honour `mode` in `evaluateAlertRules` (evaluate protocols with
`mode === 'live'`, resolve `rule_ids` to rules, emit events with
`protocol_id`), or remove `live` from `TRIGGER_MODES` and rename the collection field to
something that cannot be read as "this is switched on". A mode flag that does nothing is
worse than no mode flag.

---

### D11. The two trigger evaluators run on different context objects

**Severity: Medium** — shadow mode can disagree with production on the same data.

`POST /alerts/evaluate` builds `context = { counts, operations, data_quality }`
(`src/server.js:1628-1632`). `POST /trigger-protocols/:id/shadow-run` builds
`context = { counts, data_quality }` (`src/server.js:1797-1800`) — **no `operations`**. Any
rule or protocol whose metric path starts `operations.` resolves to `undefined` under
shadow-run, `Number.isFinite` fails, and the shadow result is `would_fire: false` with
`computed_value: undefined`. The focal point sees "no trigger condition met" for a rule
that fires in production.

**Fix.** Extract one `buildEvaluationContext(data)` used by both, and return the metric
paths that could not be resolved alongside the verdict so a silent miss is visible.

---

### D12. RapidPro dispatch has no retry, no timeout, and blocks the request

**Severity: High** — a hung RapidPro hangs the operator's HTTP request indefinitely.

`src/rapidpro.js:29-37` is a bare `fetch` with no `signal`, no timeout, no retry, no
backoff. Compare `src/connectors/http.js:1-21` (`fetchWithRetry`, 2 retries, 20 s
timeout) and `src/outbox.js:57-58` (5 s AbortController). Every other outbound call in the
codebase has a timeout; this one does not.

**Failure scenario.** RapidPro returns 429 (broadcast rate limit) — common, since RapidPro
throttles bulk sends. `src/rapidpro.js:54-57` marks the dispatch `failed` and the caller
gets a 502. The alert is simply lost; there is no retry, no queue, and no backoff. On a
network blackhole the operator's POST hangs with no timeout at all.

**Fix.** Use `fetchWithRetry` with an explicit `429`/`5xx` retry policy honouring
`Retry-After`, and wrap the dispatch in the outbox so a send is asynchronous and durable
rather than inline in the request path (`src/server.js:1588` awaits it).

---

### D13. No delivery-status tracking, and no endpoint for RapidPro delivery reports

**Severity: High** — the system reports "sent" and never learns whether the SMS arrived.

`src/rapidpro.js:54-57` treats HTTP 2xx as `status: 'sent'`. RapidPro's 2xx means *accepted
for delivery*, not delivered. RapidPro separately reports per-message delivery status
(`delivered` / `failed` / `errored`) via a results callback; there is no endpoint that
accepts it. `matchRapidProRoute` (`src/server.js:2356-2364`) matches only `status`,
`response-metrics`, `dispatches`, `inbound` (bare) and `field-report`. Dispatch records are
never updated after creation — `responseMetrics` (`src/rapidpro.js:181-227`) counts
*dispatches* and *inbound messages*, and returns `dispatched_count`, never a recipient
count.

Compounding: `response_rate_pct` at `src/rapidpro.js:214` divides inbound responses by
**dispatch count**, not recipient count. A broadcast to 500 people is one dispatch, so a
district with three replies reports 300% — or, in practice, `Math.round(30000)/100` and a
silently nonsense KPI on the equity dashboard.

**Fix.** Add `POST /api/v1/rapidpro/delivery-report` (webhook-authenticated like
`field-report`) updating per-recipient status on the dispatch. Expand recipients at
dispatch time and record `recipient_count`. Compute the response rate against recipients,
and rename the metric if recipients cannot be known.

---

### D14. RapidPro dispatch has no idempotency key — a retry double-texts the community

**Severity: Medium** — duplicate SMS to people in a humanitarian response.

`src/rapidpro.js:313`: `id: stableId('rapidpro_dispatch', [alert.id, mode, recipients, startedAt])`.
`startedAt` is `new Date().toISOString()`, so every attempt produces a fresh id and
nothing prevents a second identical broadcast. Given D12 (a request that hangs, then an
operator retry, or a scheduled re-run), the same alert goes out twice. RapidPro's
`restart_participants: true` default (`src/rapidpro.js:277`) compounds this for flow
starts.

**Fix.** Derive an idempotency key from `(alert.id, mode, sorted recipients)` without the
timestamp, and short-circuit if a non-failed dispatch with that key exists inside the
suppression window.

---

### D15. Webhook subscriptions accept `http://` and internal addresses — SSRF

**Severity: Medium**.

`src/webhooks.js:7`: `if (!url || !url.startsWith('http'))`. That accepts `http://`,
`http://127.0.0.1:4177/`, `http://169.254.169.254/latest/meta-data/`, `http://[::1]/`. The
dispatcher then `fetch`es it from the server (`src/outbox.js:60`), and the response body is
stored on the outbox record. Combined with the retry-forever behaviour at
`src/outbox.js:81-97`, this is an unauthenticated read-primitive against anything the
server can reach.

The error message says "url must be an HTTPS or HTTP URL", so this reads as deliberate. It
should at least be default-deny for loopback, link-local, and RFC-1918 ranges, with
default-allow only for public HTTPS.

---

### D16. Webhook signatures have no timestamp or nonce — replayable

**Severity: Medium**.

`src/outbox.js:54`: `headers['x-signature'] = signPayload(webhook.secret, body)`. The HMAC
covers only the body; there is no `t=` timestamp and no delivery id, so a captured request
can be replayed verbatim at any time. There is also no delivery-id header for the consumer
to dedupe on.

Separately, the header name is the bare `x-signature`. The near-universal convention
(GitHub, Stripe, Slack) is `X-Hub-Signature-256: sha256=<hex>` or
`t=<ts>,v1=<hex>`. An integrator writing a verifier from the docs will look for the
standard header, find nothing, and either skip verification or guess.

**Fix.** Send `x-lindela-signature: t=<unix>,v1=<hex>` where the HMAC covers
`"${t}.${body}"`, plus an `x-lindela-delivery-id` (the outbox event id) for consumer-side
dedup. Document the verification recipe, including a 5-minute tolerance window.

---

### D17. Outbox marks an event `sent` if *any* subscriber succeeded — failures are never retried

**Severity: Medium**.

`src/outbox.js:77-89`:

```js
const isSuccess = successCount > 0
...
status: isSuccess ? 'sent' : 'failed',
```

With two subscribers where one returns 200 and one returns 500, `successCount` is 1,
`isSuccess` is true, and the event is marked `sent`. The failing subscriber is never
retried and there is no per-subscriber delivery record — `dispatchPending` returns only
`{dispatched, failed}` and the outbox row has no per-subscriber status field at all.

**Fix.** Record one delivery row per `(event, subscription)` with status, attempt count,
and last error; treat the event as complete only when all subscribers have succeeded or
exhausted their retries. Expose a `GET /api/v1/outbox/deliveries` view.

---

### D18. Report-distribution webhooks are unsigned and untimed, unlike subscription webhooks

**Severity: Medium** — two webhook paths with opposite security properties.

`src/server.js:1380-1383`:

```js
const response = await fetch(required(channel.url, 'url'), {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(channel.headers || {}) },
  body: JSON.stringify({ report, markdown: renderReportMarkdown(report) }),
})
```

No HMAC, no timeout, no retry, no backoff. The report body — narrative, warnings, source
counts — is POSTed to an operator-supplied URL with no signature and no bound on how long
the request can hang. This is the *only* outbound webhook path that carries report content,
and it is the least protected one.

**Fix.** Route distribution channels through the same signed, timed, retried sender as
`src/outbox.js`, and add an allow-list of schemes/hosts as in D15.

---

### D19. Parametric focal-point approval is self-asserted from the request body

**Severity: High** — the human gate that makes autonomous disbursement defensible is a
boolean the caller sets.

`src/parametric.js:59-65`:

```js
if (rule.requires_focal_point_approval && !focal_point_approved) {
  throw Object.assign(new Error('Focal point approval required before simulation can proceed'), { statusCode: 409 })
}
```

and `src/server.js:2160`: `focal_point_approved: Boolean(body.focal_point_approved)`. The
"approval" is a field in the same request that asks for the money. Anyone who can call the
endpoint can satisfy the gate. Meanwhile the platform *has* a real focal-point approval
workflow — `src/workflows.js` with `parametric_disbursement` workflow type,
`pendingForFocalPoint`, and 409-on-illegal-transition — and the parametric path does not
use any of it.

**Fix.** Require an actual focal-point approval record id (from the workflow instance),
verify its state and that its subject matches the disbursement rule, and record the
approver's identity and timestamp on the disbursement. Keep the body boolean only as a
`simulation` affordance, clearly labelled.

---

### D20. Parametric rules store a trigger and a payout amount that nothing evaluates or uses

**Severity: Critical** — for an insurance product, the trigger is decorative.

`src/parametric.js:41-56` normalises `trigger_metric`, `trigger_threshold`,
`disbursement_amount_local_currency`, `currency`, `recipient_group_id`. Neither is
required, neither is type-checked (a threshold can be the string `"banana"`), and
**neither is ever read**. `simulateDisbursement` (`src/parametric.js:59-99`) takes
`rule.disbursement_amount_local_currency` and copies it into `amount`. There is no payout
function, no severity-band payout table, no cap, no partial payout on partial exceedance,
and no evaluation of the trigger against any metric. A "parametric insurance" module with
no trigger evaluation is a payment-record generator.

**Fix.** Implement `evaluateParametricTrigger(rule, context)`: resolve
`trigger_metric` through the same `resolveMetric` path used by alerts, compare against
`trigger_threshold`, and only then produce a disbursement — amount derived from a payout
schedule on the rule (`payout_bands: [{ above, amount }]`), not a static field. Return
`trigger_evaluated_at`, `metric_value`, and `threshold` on the disbursement so the record
says why it fired. Reject rules at creation time that lack a metric or threshold, the way
`normalizeAlertRule` does (`src/alerts.js:11-14`).

---

### D21. Parametric writes have no audit trail and use full-snapshot `store.write`

**Severity: High** — the one module that moves money is the one with no action log.

Every other mutating path in `src/server.js` pairs its write with
`actionLog(...)`. All three parametric writes do not:

- `src/server.js:2073-2074` — rule create: `await store.write({ ...data, parametric_rules: [...] })`, no `action_logs`
- `src/server.js:2094-2095` — rule patch: same
- `src/server.js:2161-2162` — simulate: `await store.write({ ...data, parametric_disbursements: disbursements })`, no `action_logs`

Compare `src/server.js:1637`: `await store.merge({ alert_events: events, action_logs: logs })`.
`docs/platform.md:616` claims action logs cover "creates, updates, ingestion actions,
alert evaluation, report generation, distribution, and schedule runs" — parametric is
absent from that sentence, and absent from the code.

The `store.write({ ...data })` full-snapshot pattern is also a lost-update race: any
concurrent ingest that merges between the `data` read and this write is silently
discarded. `src/postgres-store.js` is the production backend.

**Fix.** Add `action_logs` to all three writes and use `store.merge`, which every other
handler already uses.

---

### D22. `isAdmin` / `isOperator` are computed in the parametric handler and never used

**Severity: High** — dead authorisation code next to live endpoints.

`src/server.js:2059-2060`:

```js
const isAdmin = auth.scope === 'admin:*' || (Array.isArray(auth.scopes) && auth.scopes.includes('admin:*'))
const isOperator = isAdmin || auth.scope === 'role:operator' || (Array.isArray(auth.scopes) && auth.scopes.includes('role:operator'))
```

`rg -n 'isOperator|isAdmin' src/server.js` returns exactly those two lines. Nothing in
`handleParametricRoute` (`src/server.js:2057-2188`) references either. There is no role
gate on creating, editing, or simulating a disbursement.

Compounding: `scopeForRoute` (`src/auth.js:66-79`) has no branch for
`/api/v1/parametric-*`, so `POST /api/v1/parametric-rules/:id/simulate` falls through to
the default `'read:hazards'`.

---

### D23. Seven mutating endpoints require only `read:hazards`

**Severity: Critical** — a read-only token can send SMS to field teams and register
webhooks.

`scopeForRoute` (`src/auth.js:66-79`) enumerates specific prefixes and then returns
`'read:hazards'` as the default for **every** other POST. The unlisted mutating endpoints:

| Endpoint | What it does | Required scope |
|---|---|---|
| `POST /api/v1/alerts/evaluate` | Creates alert events + action logs (`src/server.js:1637`) | `read:hazards` |
| `POST /api/v1/rapidpro/alert-events/:id/send` | Sends SMS to every configured group (`src/server.js:1588`) | `read:hazards` |
| `POST /api/v1/webhooks` | Registers an outbound webhook to an arbitrary URL (`src/server.js:2004`) | `read:hazards` |
| `POST /api/v1/parametric-rules` | Creates disbursement rules (`src/server.js:2073`) | `read:hazards` |
| `POST /api/v1/parametric-rules/:id/simulate` | Simulates a disbursement (`src/server.js:2161`) | `read:hazards` |
| `POST /api/v1/scenarios` | Full-dataset recompute | `read:hazards` |
| `POST /api/v1/community-feedback` | Injects community feedback | `read:hazards` |

**Failure scenario.** A district analyst is issued a read-only token for the dashboard. It
is sufficient to POST to `/api/v1/rapidpro/alert-events/:id/send` and SMS every number in
`RAPIDPRO_ALERT_GROUPS`. The default-allow fallback is the bug: an unlisted route should be
denied, not granted read.

**Fix.** Invert the default. `scopeForRoute` should return `null` for unlisted mutating
paths and `requireScope` should reject on `null`. Add explicit scopes for each of the seven
above, e.g. `admin:alerts` for evaluate, `admin:dispatch` for the SMS send,
`admin:integrations` for webhooks, `admin:parametric` for the money paths. Add a test that
enumerates all POST routes and asserts none of them resolve to `read:hazards`.

---

### D24. Multi-tenancy is a provable no-op — a partner org sees the whole store

**Severity: Critical** for any NGO running several districts or partner organisations.

Three independent breaks, any one of which is fatal:

1. `scopeToPartnerOrg` (`src/auth.js:85-88`) is exported and **never called**. `rg -n 'scopeToPartnerOrg' src/` returns the definition only; the only other hit is `test/lite.test.js`. No route, no handler, no filter calls it.
2. Even if it were called, it early-returns on every request: `if (!auth?.partner_org) return records`. But `authenticate()` (`src/auth.js:20-39`) returns `{ token, scopes, subject }` and **never sets `partner_org`**. There is no code path that populates it.
3. `filterRecords` (`src/utils.js:125-165`) does not read a `partner_org` parameter at all.

Meanwhile `public/portal/app.js:96-99` appends `?partner_org=` to every single load the
partner portal makes, from `localStorage.getItem('lindela_lite_partner_org')`
(`public/portal/app.js:9`). A partner org sets its name, sees a filter chip applied, and
receives **every record in the deployment**.

The project's own docs already diagnosed it — `docs/architecture/request-lifecycle.md:351-354`
records that the guard "always takes the early return" — and it shipped anyway.

**Fix.** Populate `partner_org` from the token definition in `parseTokens()`, call
`scopeToPartnerOrg` on every collection read in `handleApi`, and have `filterRecords`
honour `partner_org` as a real predicate. Until all three land, remove the parameter and
the portal's tenant selector rather than shipping a filter that provably does nothing.

---

### D25. Scenario tokens inject arbitrary objects into the evaluation dataset

**Severity: Low** — low impact, but it is an unvalidated trust boundary.

`src/scenarios.js:36-42`:

```js
if (perturbation.added_hazard_events && Array.isArray(perturbation.added_hazard_events)) {
  cloned.hazard_events = [...(cloned.hazard_events || []), ...perturbation.added_hazard_events]
}
```

`decodeScenarioUrl` (`src/scenarios.js:132-140`) parses attacker-supplied base64 straight
into that path. The entries are never validated against the hazard-event schema, have no
`occurred_at` bounds, and no count limit, so a crafted share URL can inject arbitrary
objects into the dataset and force a full recompute of every risk score and service impact
on every load of the link. `Buffer.from(..., 'base64')` also silently discards invalid
characters, so malformed tokens decode to surprising values rather than failing.

**Fix.** Validate injected events against `normalizeHazardEvent` (or reject unknown keys),
cap the array length, and reject any perturbation key not on an allow-list.

---

### D26. `==` and `!=` are strict comparisons against float metrics

**Severity: Low** — a footgun in the rule DSL.

`src/alerts.js:222-223`: `if (operator === '==') return value === threshold` and
`if (operator === '!=') return value !== threshold`. `OPERATORS` (`src/alerts.js:4`) offers
both. Metric values here are floats from `open_meteo`, CHIRPS, and GloFAS. `== 50` against
a continuous precipitation value never fires; `!= 50` always fires. Neither error is raised
at rule-creation time.

**Fix.** Drop `==`/`!=` from `OPERATORS` (no legitimate EWS rule needs exact float
equality), or implement them with an explicit tolerance band and require the band to be
declared.

---

### D27. Three mutually incompatible trigger-protocol dialects ship side by side

**Severity: Medium** — the examples cannot be loaded by the module that claims to model
them.

Three shapes coexist:

| Dialect | Metric form | Condition form | Suppression form |
|---|---|---|---|
| `examples/trigger-protocols/*.json` | `when.field` + `when.value` (scalar or array) | `when.all: [...]`, `operator: "in"` | `dedupe_key`, `repeat_after_minutes` |
| `normalizeTriggerProtocol` (`src/alerts.js:132-161`) | `metric` path + `operator` + `threshold` | none | `suppression_minutes` on the *rule*, not the protocol |
| `intervention-response-watch.json` | none | free-text string `"critical_open_incidents > 0"` | `window: "2h"`, `key: "trigger.id"` |

The operators used in the examples (`in`, and the `all` array combinator) are not
supported by `compare()` (`src/alerts.js:217-225`), which handles six scalar operators and
returns `false` for anything else. `intervention-response-watch.json` is a fourth dialect
again: no `schema_version`, `poll.cadence: "15m"` instead of `interval_minutes`, and a
string DSL that nothing parses.

Nothing reads these files. `scripts/validate.mjs:3-11` only `JSON.parse`s them — there is no
schema check, so the drift is invisible. `freshness_warning_minutes` and
`repeat_after_minutes`, documented in `examples/trigger-protocols/README.md:20`, are not
implemented anywhere.

**Fix.** Pick one shape, write a JSON Schema for `lindela-lite.trigger-protocol.v1`, and
make `scripts/validate.mjs` validate every example against it. Add the example files as
fixture input to `normalizeTriggerProtocol` so the shape cannot drift again. Implement
`freshness_warning_minutes` and `repeat_after_minutes` or remove them from the README.

---

### D28. CAP omits `<language>`, which IPAWS and Google Public Alerts require

**Severity: Medium** — schema-valid, profile-invalid.

CAP 1.2 base schema makes `language` optional in `<info>`, so the output is valid. But the
IPAWS CAP profile and Google Public Alerts both expect it. The renderer emits
category → event → urgency → severity → certainty → headline → description → area with no
`<language>`, even though the product ships ten locales
(`src/i18n.js:9`: `['en','sw','ar','so','din','km','nk','fr','pt','am']`) and CAP alerts
target exactly the multilingual population those locales cover.

Related: no `<effective>`, `<onset>` or `<expires>`. Several downstream profiles require
`<expires>`. And `msgType: Cancel` messages carry no `<code>` or `<references>` pointing
at the original alert.

**Fix.** Emit `<language>` from the alert's locale (default `en-US`), add `<effective>` and
`<expires>` (default: alert expiry or `created_at + 24h`), and on Cancel add
`<info><code><valueName>CAPReference</valueName><value>{original identifier}</value></code>`.

---

### D29. CAP sender is hardcoded to `lindela-lite@example.org`

**Severity: Medium** — every deployment claims the same non-existent identity.

`src/cap.js:27`: `sender = 'lindela-lite@example.org'`, and `src/server.js:1655` calls
`renderCapXml(record)` with no options, so the default always wins. CAP requires `sender`
to identify the alerting authority, and its `Recall`/`Update` semantics depend on the
recipient being able to attribute and contact the sender. `example.org` is reserved
precisely to mean "this is a placeholder".

**Fix.** Read `LINDELA_CITE_SENDER` / `LINDELA_CITE_SENDER_NAME` from the environment (add
to `docs/configuration.md:83`'s table), pass them at `src/server.js:1655`, and fail the
CAP route with 503 if unset rather than emitting a placeholder identity.

---

### D30. The CAP circle materially over-approximates the district it claims to describe

**Severity: Medium** — the geometry contradicts the text.

`src/cap.js:57-59` emits `<circle>{center.lat},{center.lon} {radius_km}</circle>`, and
`src/cap.js:128` puts "Area: Bor district extent, 150 km from the district centroid" in
the description. A circle is a **valid** CAP geometry (CAP 1.2 permits `polygon`, `circle`
or `geocode` under `<area>`, unioned if multiple — so the circle is not itself a schema
error). The problem is that the text asserts an *extent* while the geometry asserts a
disc. For Turkana (`src/districts.js:2`, `radius_km: 200`) the circle covers roughly
125,000 km² against an actual county area near 80,000 km² — a 200 km radius is not a
district boundary. A consumer that activates by circle will alert people well outside the
district.

**Fix.** Ship real district boundary polygons (the repo already ingests per-country GeoJSON
— `docs/ingestion.md:112` "Area polygons come from per-country GeoJSON") and emit
`<polygon>` under `<area>`. Reserve the circle for genuinely circular hazards. Until then,
change `areaDesc` to "approximate: 200 km radius around the district centroid" so the
geometry and the prose agree about their own uncertainty.

---

### D31. Nothing validates the CAP output against the CAP schema

**Severity: Medium** — the tests assert substrings, not conformance.

`test/lite.test.js:83-160` checks for `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">`,
`<event>Flood</event>`, the absence of `<circle>0,0`, and one regex for the Bor circle.
None of it is schema validation, and no XSD is present in the repo. A change that dropped
`<certainty>`, reordered `<info>` children, or emitted an invalid `<urgency>` would pass
every existing test.

**Fix.** Vendor `CAP-v1.2-os.xsd` (or add it as a devDependency-free fixture), validate
every `renderCapXml` case in `test/lite.test.js` against it, and add the same validation to
`scripts/validate.mjs` over the five stored demo alert events.

---

### D32. `din` is not a valid language code

**Severity: Low**.

`src/i18n.js:9` lists `din`. Dimli/Dina is ISO 639-2/T `dim`, ISO 639-3 `din`, and
BCP-47 **`diq`**. `din` is not a well-formed language tag, so no browser will ever
negotiate it from `Accept-Language` and no `lang="din"` resolves. The locale is reachable
only by explicit selection.

**Fix.** Rename to `diq` (keep `din` as an alias for existing bookmarks) and update
`public/i18n/din.json` and the check scripts.

---

## Enhancements

### E1. Escalation trees with acknowledgement SLAs

**Value.** When a critical alert is not acknowledged within N minutes, escalate to the
on-call lead, then the country office, then SMS the duty roster — so an alert that lands
at 02:00 in a phone that nobody is holding still reaches a human. Today the entire
lifecycle is `open → acknowledged → resolved` (`src/schema.js:127-131`) with no timer and
no owner default; an alert can sit `open` forever and only show up as a count on a badge
(`public/index.html:315`).

**Evidence.** `src/alerts.js:34-56` (`updateAlertEvent` sets only `status`, `owner`,
`resolution_note`, `false_alert`); no `acknowledged_deadline` or escalation string exists
in `src/`, `public/`, or `test/`.

**Sketch.** `alert_rules.escalation: [{ after_minutes: 15, target_role: 'district_officer' },
{ after_minutes: 60, target_role: 'country_lead' }]`. Stamp `acknowledged_at` and
`acknowledged_by` on the event; a scheduled sweep (`runDueIngestionSchedules` already
provides the cron pattern, `src/server.js:962-986`) promotes unacknowledged events and
records each hop in `action_logs`. Extend `equity.js` to report median
time-to-acknowledge alongside `unacknowledged_rate`.

### E2. Two-way SMS: acknowledge, escalate, and close from a handset

**Value.** The field team already has a working inbound SMS path
(`parseRapidProFieldReport`, `src/rapidpro.js:100-179`) — extend it to accept `ACK
<alert_id>`, `STATUS <text>`, and `NEED <x>` and the entire alert lifecycle completes
without anyone opening a laptop. Today a field officer's only way to close an alert is the
web console, which `docs/rapidpro.md` does not mention is unavailable offline.

**Evidence.** `src/rapidpro.js:339-367` already parses a free-text grammar
(`incident_…`, `needs: …`, coordinates) from inbound SMS; `parseReportText` is a
command parser that only handles one command type.

**Sketch.** Extend `parseReportText` into a keyword dispatch table, add
`acknowledgeAlertEvent(existing, actor, note)` to `src/alerts.js`, and route
`/api/v1/chw/reply` (`src/server.js:2189+`) and the RapidPro field-report webhook into it.
Return a confirmation SMS so the sender knows it registered.

### E3. Delivery tracking with delivery reports fed back into the app

**Value.** Turns "we sent it" into "it arrived", which is the only way to compute a
response rate honestly — currently a broadcast to 500 people counts as one dispatch, so
`response_rate_pct` (`src/rapidpro.js:214`) can exceed 100% and is displayed on the equity
dashboard.

**Evidence.** `src/rapidpro.js:54-57` sets `status: 'sent'` on HTTP 2xx and never updates;
`matchRapidProRoute` (`src/server.js:2356-2364`) has no delivery-report route;
`rapidproDispatchRecord` (`src/rapidpro.js:310-332`) stores `recipients` as opaque arrays
with no per-recipient expansion.

**Sketch.** Expand recipients at dispatch time into `dispatch_recipients[]` with
`{urn, status: 'queued', message_id}`. Add `POST /api/v1/rapidpro/delivery-report`
(webhook-authenticated as at `src/server.js:1594`) that updates per-recipient status. Compute
`responseMetrics` against recipients, and add a delivery-funnel panel to the alert detail.

### E4. Alert acknowledgement workflow in the UI

**Value.** Closes the loop between "we sent SMS" and "somebody acted", which the equity
dashboard already tries to measure but cannot: `unacknowledged_rate`
(`public/index.html:370-378`) is computed from `status === 'acknowledged' || 'resolved'`
(`public/app.js:1881`), and nothing in the UI ever *sets* `acknowledged`.

**Evidence.** `src/equity.js:37-39` and `public/app.js:1879-1896` read the status;
`public/app.js` has no acknowledge control. Approve/reject exists
(`public/index.html:644` `<dialog id="dispatchGateDialog">`, `src/alerts.js:76-96`) but is
gated on *dispatch*, not on *acknowledgement*.

**Sketch.** Add an Acknowledge action per alert row posting
`PATCH /api/v1/alert-events/:id` with `{status:'acknowledged', owner, resolution_note}`,
plus an owner picker from the workflow principals. Show `acknowledged_by` and
`acknowledged_at` in the alert detail and thread it into the KPI snapshot.

### E5. A rule builder UI

**Value.** An alert rule today is `POST /api/v1/alert-rules` with a hand-written
`metric` path, and there is no form for it — `public/app.js:2604` posts a fixed payload
rather than exposing one. A district officer cannot author a rule, and cannot see the
metric namespace they would be authoring against.

**Evidence.** `src/alerts.js:7-32` (`normalizeAlertRule`) validates metric/operator/
threshold and nothing surfaces the valid `metric` paths; the catalogue itself notes at
`docs/platform-jtbd-catalogue.md:63` that the "metric namespace [is] documented in schema".

**Sketch.** Publish `GET /api/v1/alert-metrics` derived from the same context object
`evaluateAlertRules` receives (`src/server.js:1628-1632`) plus `data_quality`, listing each
resolvable path, its type, and its recent range. Build a form with a metric picker,
operator select, threshold with a histogram of recent values, severity, scope district,
suppression window, and a dry-run preview against the last 30 days.

### E6. Multilingual alert templates, per recipient language

**Value.** Alert SMS currently goes out in exactly one language
(`text: { [config.baseLanguage]: message }`, `src/rapidpro.js:301`) with
`RAPIDPRO_BASE_LANGUAGE` defaulting to `eng` (`src/rapidpro.js:246`). A Bor alert SMS
reaches a community in a language most of them do not read, on the one channel the
platform has proven works offline.

**Evidence.** `src/rapidpro.js:246,301-302`; `docs/rapidpro.md:23`; ten locales already
exist at `public/i18n/` but none are wired to alert copy.

**Sketch.** Add `alert_templates[]` keyed by locale with a required `en` fallback;
resolve per-recipient language from the RapidPro contact, falling back to district
language then `en`. RapidPro's broadcast endpoint already accepts a full
`{lang: text}` map — send the translations together. Add the template catalogue to
`scripts/check-i18n.mjs` so a missing translation is a build failure, as it already is for
the UI surfaces.

### E7. Alert timeline and "why did this alert fire" explainability

**Value.** When a duty officer gets paged at 02:00, the first question is "why is this
firing and is it real?" — and today the answer lives only in
`descriptionFor` (`src/cap.js:118-137`), a single sentence inside the CAP payload, with no
UI. `rg -n 'why did|explain|rationale' public/app.js` returns nothing.

**Evidence.** `src/cap.js:118-137` is the only place the reasoning is assembled;
`src/alerts.js:109-127` records `value`, `threshold`, `operator`, `metric` but nothing
about the contributing inputs.

**Sketch.** Record an `explain` block on each alert event at creation: the metric path,
the resolved value, the comparison, the source run and observation ids behind the value,
data freshness at evaluation time, and the rule's suppression window. Render it as a
timeline (evaluated → created → approved/rejected → dispatched → delivery → inbound →
acknowledged → resolved → false_alert) on the alert detail, and reuse it for the CAP
`<info><parameter>` block (see D28).

### E8. Webhook signing v1 with timestamp, delivery id, and a delivery log UI

**Value.** Turns the webhook surface from "a signed delivery that silently never happens"
(D1) into a verifiable, replay-resistant, inspectable channel — and gives an integrator
something to build a retry consumer against.

**Evidence.** `src/outbox.js:54` (bare `x-signature`, no timestamp); `src/webhooks.js:44-48`
(the HMAC itself is correct); `GET /api/v1/outbox` exists (`src/server.js:310-313`) but has
no UI, and `public/` has no outbox view.

**Sketch.** Adopt the GitHub/Stripe convention as in D16, add per-subscriber delivery rows
as in D17, expose `GET /api/v1/outbox/deliveries?status=failed` with retry-from-button, and
document the verification recipe in `docs/platform.md` including clock-skew tolerance.

### E9. Channels beyond RapidPro SMS

**Value.** SMS is right for the 3G edge and wrong for a district office with a laptop;
email and WhatsApp carry the same alert to donors, NGOs, and coordination centres without
a second deployment.

**Evidence.** The distribution channel enum at `src/server.js:1399` already generalises
over `markdown_download | json | csv | geojson | webhook | rapidpro_sms` — the abstraction
exists and only two real transports are implemented. `src/rapidpro.js:20-98` shows the
dispatch-record shape a second channel would reuse.

**Sketch.** Implement `email` (SMTP or a transactional API) and `whatsapp` (Cloud API)
as distribution channels against the existing `normalizeDistributionRun` interface at
`src/server.js:1387-1397`. Push (`web-push`/FCM) against the service worker already
installed at `public/sw.js:219-287` for operators who want the alert without the tab open.

### E10. CAP delivery push, not poll

**Value.** The catalogue itself flags this at `docs/platform-jtbd-catalogue.md:68` — "No
push mechanism; consumer must poll for new CAP events." An EWS gateway that has to poll
`GET /api/v1/alert-events/:id.cap` per known id learns about a new alert only if it
already knows the id exists.

**Evidence.** `docs/platform-jtbd-catalogue.md:68` (catalogue's own P2 note);
`src/server.js:1655` is the only CAP path and it is GET-by-id.

**Sketch.** Emit `alert_event.created` / `alert_event.updated` outbox events (the emit
call already exists at `src/server.js:1641`) carrying the rendered CAP body, so a
subscriber receives `<alert>` XML over a signed webhook. Keep the GET-by-id route as the
pull fallback and document both.

### E11. A backtest that tests the trigger

**Value.** Replaces the currently meaningless precision/recall pair (D9) with a number an
underwriter can defend, and makes trigger authoring an empirical act rather than a guess.

**Evidence.** `src/alerts.js:163-200`; the UI surfaces the result as
`protocol.backtest` via `src/server.js:1783-1786`.

**Sketch.** As in D9, plus: persist per-sample rows (`protocol_id, evaluated_at, metric,
value, fired, outcome, lead_time_days`) so a donor or underwriter can inspect individual
calls, not just an aggregate; add a skill score against persistence and climatology
baselines; and gate activation on it — a protocol cannot move `mode` from `shadow` to
`live` without a backtest whose recall clears a declared floor.

### E12. Bulk upload for non-technical staff

**Value.** The single largest blocker to real district adoption. Today there is no file
picker and no multipart handling on any of the eight surfaces (`rg -n 'multipart|form-data|type="file"|FormData'`
over `src/server.js` and `public/` returns nothing). A district officer with a 4 MB ACLED
export has no path in; `src/connectors/uploads.js:52-57` expects
`options.service_assets_csv` as a **string pasted into a JSON body**.

**Evidence.** `src/connectors/uploads.js:52-57`; absence of any multipart parser in
`src/server.js`; `readRequestJson` (`src/utils.js:272`) is JSON-only.

**Sketch.** Add `POST /api/v1/ingest/upload` accepting `multipart/form-data`, writing to a
temp file, and feeding it to the existing `parseCsv` (`src/utils.js:177`) and
`parseGeoJson` paths. Return a **validation report before committing** — row count,
rejected rows with line numbers and reasons, coordinate bounds check, duplicate detection
— because a silent partial import of a district asset file is worse than a refusal. Pair
with a fix for the portal tenancy no-op (D24) so uploads are org-scoped from day one.

### E13. Spatial and tabular export in the formats analysts actually open

**Value.** GeoJSON and CSV are implemented; KMZ and XLSX are not, and those are what a
district GIS officer and a programme manager actually open. `rg -n 'kmz|xlsx|excel'` over
`src/` and `public/` returns nothing.

**Evidence.** `src/utils.js:212` (`toCsv`) and `:242` (`toGeoJson`) are the only
serialisers; `src/server.js:853-889` the only two export routes; `package.json` has one
dependency (`pg`), so both would be hand-rolled as CSV/GeoJSON were.

**Sketch.** KMZ is a zip of a KML file and `node:zlib` is already imported
(`src/server.js:6`) — the deflate half is available, only the zip container needs writing.
XLSX is a zip of XML sheets; a minimal single-sheet writer is ~120 lines and no
dependency. Note that `GET /export.csv` and `/export.geojson` currently export only the
report's *source-record appendix* (`src/server.js:1129-1137`) — the report narrative and
warnings reach the user only via `export.md`, and nothing says so. Whichever formats are
added should state which of the two they carry.

### E14. An audit trail a donor can actually inspect

**Value.** `action_logs` is a real, append-only, actor-stamped table — but the
parametric money path is excluded from it (D21), `GET /api/v1/action-logs` has no UI, and
there is no export. A donor reviewing a quarterly report cannot answer "who approved this
disbursement" or "who changed this incident".

**Evidence.** `src/server.js:1637` and ~40 other call sites write `action_logs` correctly;
`src/server.js:2073-2162` do not; `rg -n 'action-logs' public/*.js public/*/app.js`
returns nothing.

**Sketch.** Close the three write paths that skip it, add an action-log view with
actor/collection/action/time filters, and an `export.audit.csv` covering every mutating
endpoint. This is a small amount of work for a disproportionate compliance payoff.

### E15. An explicit "what this does NOT tell me" surface

**Value.** The codebase is unusually honest about limits in prose — `src/cap.js:135` puts
"not an official forecast" in every CAP description, `src/scenarios.js:121` carries a
`model_limit` string, `docs/outbreak-and-food-security-scoping.md:92-99` states that
national cholera totals cannot drive district response. None of that is visible *in the
product*. An operator looking at a risk score sees a number and a bar, not the caveat.

**Evidence.** `src/scenarios.js:121` (`model_limit`, returned in the API, rendered
nowhere); `src/parametric.js:92` (`sanctions_status` distinguishes not-screened from
screened, and is surfaced only in the API response); `public/index.html:366-370` carries
the caveats in `title=` attributes — hover-only, inaccessible on touch, invisible in print.

**Sketch.** A persistent, dismissible limitations strip on each surface — not a tooltip —
carrying the surface's own `model_limit` strings: uncalibrated scores, coverage sensitivity,
data freshness, keyless-data boundaries, and what the tool explicitly does not model. Reuse
the strings already in the code so the caveat on screen and the caveat in the payload are
the same text.

---

## JTBD roadmap verification

Every P0/P1/P2 item in `docs/platform-jtbd-catalogue.md` was checked against code. The
catalogue is roughly two months stale and **wrong in both directions**: it lists four gaps
that are shipped, and it misses modules and surfaces that did not exist when it was written.

| Catalogue claim | Implemented? | Evidence | Verdict |
|---|---|---|---|
| **P0-A** Incident lifecycle: transition table, `closed_at`, reason code, outbox on status change | **partial** | `src/operations.js:134` validates `status` via `enumValue(..., INCIDENT_STATUSES, ...)` — enum landed. No transition graph: `buildUpdate` at `src/operations.js:59-68` re-normalises with no `previous_status` check. No `closed_at` in `normalizeIncident` (`:128-152`). No reason field. `src/server.js:1835-1839` emits `incident.created` on POST only; the PATCH branch at `:1846-1864` emits nothing. | **Not stale — bypassed.** The machinery exists in `src/workflows.js` (frozen transition table `:25-79`, `closed_at` on terminal states `:137`, mandatory `reason`+`evidence` `:154-155`, 409 on illegal transitions `:126`, `workflow.transitioned` outbox event) for 8 *other* workflow types (`anticipatory_alert`, `parametric_disbursement`, `chw_outbreak_triage`, …) the catalogue never mentions. Incidents remain the ungoverned subject. 12 tests at `test/lite.test.js:2099-2362`. |
| **P0-B** Alert acknowledgement SLA + escalation | **no** | No `acknowledged_deadline` or escalation string in `src/`, `public/`, `test/`. `src/alerts.js:34-56` sets only `status`, `owner`, `resolution_note`, `false_alert`. | Genuinely absent. Catalogue correct. → E1 |
| **P0-C** Report approval blocked by stale/low-confidence data | **no** | `src/reports.js:167-176` — `approveReport` checks only `report.sections?.length` and `['ready','approved'].includes(report.status)`. No `data_quality` reference; no `force_approve` anywhere in `src/`. | Genuinely absent. Warnings advisory only, as claimed. |
| **P0-D** Human dispatch gate for high-severity SMS | **YES — catalogue is wrong** | `src/server.js:1582-1583` — `if (approvalState !== 'approved' && approvalState !== 'auto_approved') { jsonResponse(res, 409, { success:false, error:'Alert not approved', current_state: approvalState }) }`. State set at `src/alerts.js:108` — `rule.severity === 'low' ? 'auto_approved' : 'proposed'`. Decision API `approveAlertEvent` at `src/alerts.js:76-96` records `reviewer`, `reviewed_at`, `decision_note`. Route `/alert-events/:id/(approve\|reject)` at `src/server.js:2334`. UI dialog at `public/index.html:644`. Tests: `test/lite.test.js:2413`, `:2606`. | **Shipped.** Different field names (`approval.state` + `/approve`, not `approved_for_dispatch` + `/approve-dispatch`), identical semantics. Do not re-propose. **But note D23** — this gate is reachable with a read-only token. |
| **P1-A** Source failure-streak notification outbox event | **no** | `src/ingestion.js:295` computes `failure_streak` for the status endpoint only. No `emit(` in `src/ingestion.js`. `run-due` at `src/server.js:962-986` writes action logs but emits no event. | Genuinely absent. |
| **P1-B** Trigger protocol lifecycle, backtest-before-activation, persisted shadow-run | **partial** | `src/alerts.js:146` (`version`), `:156` (`approvers`), `:159` (`backtest`) exist. No `lifecycle_status`. `src/server.js:1794-1806` — shadow-run returns the result and **discards it**, no `store.merge`. Backtest at `:1782-1792` is persisted but gates nothing. | `approvers` and backtest persistence landed; activation lifecycle and shadow-run persistence did not. **Deeper problem the catalogue misses: the backtest itself is meaningless (D9) and `mode: 'live'` is never read (D10).** → E11 |
| **P1-C** `PATCH /api/v1/rapidpro/inbound/:id` re-linkage | **no** | `src/server.js:2355-2364` — `matchRapidProRoute` matches `/inbound` (bare) and `/field-report` only; no `:id` pattern. | Genuinely absent. |
| **P1-D** `report_schedule.run_failed` outbox event | **no** | `src/server.js:1444` — `normalizeScheduleRun({ status:'failed', ..., error:'Template not found' }, nextSchedule)`; `runReportSchedule` writes `action_logs` only. Sibling `emit()` calls exist at `:1163` and `:1222`, so the pattern is known and simply not applied. | Genuinely absent. |
| **P1-E** `GET /api/v1/work-queue` | **no** | No `work-queue`/`work_queue`/`workqueue` string in `src/`, `public/`, `test/`. Closest is `operationalSummary` at `src/operations.js:29` (`overdueTasks`), surfaced only as a count at `src/server.js:655`. | Genuinely absent — but the aggregate already exists, so this is a thin read endpoint over computed state. |
| **P2-A** `GET /api/v1/search?q=…` | **no** | `src/utils.js:125-165` — `filterRecords` has 13 named equality filters, no `q`, no substring match, no `to_tsvector`. No `searchParams.get('q')` in `src/`. No search input in `public/app.js`. | Genuinely absent. |
| **P2-B** `dry_run=true` on `apply-retention` | **no — and `docs/api.md` falsely advertises it** | `src/server.js:373-393` reads only `loadPolicy()` then `applyRetention(...)`. No `dry_run`, no action log; response is `{field_reports:{kept,expired}, rapidpro_inbound_messages:{…}}`, not the documented `{success, affected, dry_run}`. But `docs/api.md:567-573` documents `Body: { dry_run?: bool, actor?: string }`, `Response: { success, affected: int, dry_run: bool }`, and "Writes an action_log entry per affected collection." | **Worse than the catalogue's framing.** An admin trusting `dry_run: true` gets a destructive purge with no log. Documentation is the defect here. |
| **P2-C** `bias_correct` wired into `POST /api/v1/ingest/run` | **no** | `src/analytics/downscaling.js:53-54` still exports `biasCorrectClimate`; `src/ingestion.js` contains no call. Consumers read the stored field if present — `src/analytics.js:52`. | Genuinely absent, but the analytics side is already bias-correction-aware, so the ingestion hook is the only missing piece. |
| **Strategic-A** Multi-user RBAC with named principals | **partial** | `src/auth.js:3-11` (`LINDELA_LITE_TOKENS` env JSON), `:66-79` (`scopeForRoute`), `:81-84` (`hasRole`), wired at `src/server.js:243`. No issuance API or identity store; issuance is a hand-edited env var. | Roles/scopes real; named principals absent, as claimed. **But D23 and D24 show the scope layer itself is unsound** — fixing strategic-A is a prerequisite, not a parallel workstream. |
| **Strategic-B** Signed public report links | **no** | No `/share` or `reports/shared/` route; `matchReportingRoute` at `src/server.js:2305-2329` has no such pattern. | Genuinely absent. |
| **Strategic-C** `POST /stac/search` + conformance declaration | **no** | `src/server.js:162` handles only `/stac/catalog.json`; `:167` only `/stac/collections/:id(/items/:itemId)?`; `:204` only `/ogc/collections/:id/items`. No `/stac/search`, no `/stac/conformance`. | Genuinely absent. |
| **Strategic-D** Connector contribution pipeline with CI gate | **partial** | `CONTRIBUTING.md:44` — "Before adding a connector, confirm:" is a human checklist. `.github/workflows/ci.yml:18` runs `npm test` (so spec validation is implicitly exercised). No job requiring OpenAPI/doc updates for a new source id. | Checklist landed; CI gate did not. |

### Catalogue claims that are wrong in the *other* direction

| Catalogue claim | Reality | Evidence |
|---|---|---|
| **P0-D** dispatch gate is "planned" | Shipped and tested | `src/server.js:1582`, `src/alerts.js:76-96`, `public/index.html:644`, `test/lite.test.js:2413` |
| **JTBD-073** PII redaction "not confirmed" | Wired on the RapidPro inbound path | `src/server.js:1601-1614` — `loadPolicy()` then `redactPii(parsed.inbound, policy)` / `redactPii(parsed.report, policy)`. Tested `test/lite.test.js:2740` |
| **JTBD-087** i18n "only `en.json` confirmed" | 10 locales, RTL handled | `src/i18n.js:9` — `['en','sw','ar','so','din','km','nk','fr','pt','am']`; `src/i18n.js:33-34` `isRtl` → `'ar'`. **But see D32** (`din` is not a valid tag) and the catalogue-missed gap: `parametric`, `scenarios`, and `districts` have **no locale picker** at all (`scripts/check-i18n-offers.mjs`) |
| **JTBD-086** offline "not verified" | Substantially built, including writes | `public/sw.js:4` `CACHE_NAME`, `:5` separate `API_CACHE_NAME`, `:11` `API_TTL_MS = 24h`, `:147` injects `x-lindela-offline: 1` so UI distinguishes offline from empty, `:219-287` IndexedDB write queue with `lindela-queue` sync tag and replay. 8 surfaces in `SURFACES` (`:32-42`). Banner `public/app.js:835-844` |
| **JTBD-052** report detail UI "unverified" | Built | `public/app.js:2256-2305` — per-report MD/CSV/JSON/GeoJSON export buttons plus approve and distribute |
| **JTBD-096** PDF "planned, no implementation exists" | A dependency-free PDF 1.4 writer exists | `src/pdf.js` (168 lines, built-in Helvetica), served at `src/server.js:755-768`, tested `test/lite.test.js:2933`. **But** it renders KPI snapshots only — `GET /reports/:id/export.pdf` does not exist (`src/server.js:2309` accepts only `md\|json\|csv\|geojson`). The catalogue was right about reports, wrong about "no implementation". |
| "incident status is a free string" (asserted twice) | Enum-validated, 400 on unknown | `src/operations.js:134`, `src/schema.js:91` |
| "incident creation emits no event" | It does | `src/server.js:1838-1839` — `await emit(store, 'incident.created', record)` |
| print stylesheets — never mentioned | Two exist | `public/styles.css:2097`, `public/components.css:762` — inverts the dark-only token layer to light and hides 14 screen-only elements |
| 15+ modules and 8 front-end surfaces — never mentioned | All exist | `src/road-access.js`, `src/routing.js`, `src/equity.js`, `src/terrain.js`, `src/kpi.js`, `src/flood-probability.js`, `src/workflows.js`, `src/flood-depth.js`; surfaces `console`, `chw`, `co`, `portal`, `focal-point`, `districts`, `scenarios`, `parametric` |

---

## Gaps the catalogue missed

Answering the question the catalogue was written to answer — *who is the user in the
district office, what is their week like, and what does this tool still not let them do?*
The user is a district information officer or a programme manager. Their week is Monday:
read the alerts left open over the weekend, chase the three field teams who did not
acknowledge, produce the situation report for the country office by Thursday, and hand
the asset spreadsheet to the logistics team. Five things stop them.

### G1. They cannot get their own data into the tool

There is **no bulk upload anywhere** — no `multipart`, no `FormData`, no `type="file"` on
any of the eight surfaces (`rg -n 'multipart|form-data|type="file"|FormData' src/server.js
public/` returns nothing). Imports go through JSON body fields that the caller must paste:
`src/connectors/uploads.js:52-57` expects `options.service_assets_csv` and
`service_assets_geojson` as strings. A district officer with a 4 MB ACLED export or a
facilities spreadsheet from the ministry has no path in — the browser cannot read the file
and `readRequestJson` (`src/utils.js:272`) will not carry it. This is the hardest blocker
to adoption and the catalogue does not list it. → E12

### G2. The partner portal's tenancy filter is provably inert, and says so on screen

`public/portal/app.js:96-99` appends `?partner_org=` to every load. Three independent
breaks mean the filter does nothing (D24): `scopeToPartnerOrg` (`src/auth.js:85-88`) is
never called from `src/server.js`; `authenticate()` (`src/auth.js:20-39`) never sets
`auth.partner_org`, so the guard would early-return even if it were; and `filterRecords`
(`src/utils.js:125-165`) does not read the parameter. The project's own architecture doc
diagnosed this — `docs/architecture/request-lifecycle.md:351-354` — and it shipped anyway.

The failure is not just technical: a partner organisation sets its name, sees the filter
applied, and receives the entire deployment's records. For an NGO running several districts
under one instance this is the difference between a partner portal and a data breach. → D24

### G3. There is no export in the format a humanitarian analyst opens, and the CSV export silently drops the report

`src/utils.js:212` and `:242` give CSV and GeoJSON; no KMZ, no XLSX. A district GIS officer
opening flood assets in QGIS has GeoJSON but no KMZ. A programme manager has CSV but no
XLSX.

Worse: `GET /export.csv` and `/export.geojson` (`src/server.js:1129-1137`) export only
`recordsForReportSources(report, data)` — the **source-record appendix**. The report's
sections, narrative, and warnings reach the user only via `export.md`. Someone who clicks
CSV gets source rows with no report context and no indication that the summary is missing.
The same substitution repeats in the distribution channels at `src/server.js:1369-1374`
(`csv: { records: appendixRecords.length }`). → E13

### G4. Nothing records who did what on the money path, and the audit log has no UI

`action_logs` is real and append-only, and ~40 handlers use it correctly. But:

- The parametric module — the only code that produces a disbursement — writes **no**
  action logs at all (`src/server.js:2073`, `:2095`, `:2162`) and uses full-snapshot
  `store.write` instead of `store.merge`, so a concurrent ingest is silently discarded (D21).
- `GET /api/v1/action-logs` has no UI: `rg -n 'action-logs' public/*.js public/*/app.js`
  returns nothing. A response lead cannot answer "who changed this incident" from the console.
- There is no export. A donor reviewing a quarterly report cannot produce an audit trail.

The catalogue lists "audit log" as existing. It exists as a table and nothing more. → E14

### G5. The three surfaces a district officer actually uses are English-only

`scripts/check-i18n-offers.mjs` reports:

```
console     offered: en,sw,ar,so,din,km,nk,fr,pt,am   (10)
chw         offered: en,sw,so
focal-point offered: en,sw,so,ar,din,km,nk
co          offered: en,sw
portal      offered: en
parametric  (no locale picker)
scenarios   (no locale picker)
districts   (no locale picker)
```

`districts` is the district-office view. `scenarios` is the planning workbench.
`parametric` is the money surface. All three have no language picker and no translations,
in a deployment whose other surfaces ship Arabic and Somali. Meanwhile alert SMS —
the channel that works where the web does not — is monolingual at
`src/rapidpro.js:301`. An Arabic-speaking district officer in Bor reads a district view in
English and receives flood alerts in English. → E6

### Two more worth naming

**The action-log "audit trail" does not cover who *received* an alert.** There is no
record linking a dispatch to the human who owned it beyond the free-text `actor` on the
approve call. With broadcast SMS to a group, "who was notified and when" is not answerable
from the system — only "a dispatch to group X was accepted by RapidPro at time T" (D13).

**The product has no explicit statement of what it does not tell you.** The honesty is all
in prose: `src/scenarios.js:121` carries `model_limit`, `src/cap.js:135` appends "not an
official forecast" to every alert, `docs/outbreak-and-food-security-scoping.md:92-99` says
plainly that national cholera totals cannot drive district response, `public/index.html:366-378`
puts caveats in `title=` attributes. All of it is invisible in the product — hover-only,
which fails on touch and in print. The organisation clearly knows what the tool cannot do.
Nothing tells the person using it. → E15

---

## Rejected

Candidates considered and dropped, with reasons.

**Validate CAP output against the XSD as the *only* CAP finding.** Tempting — the prompt
suggested checking `urn:oasis:names:tc:emergency:1.1`. The implementation uses
`urn:oasis:names:tc:emergency:cap:1.2`, which is the correct CAP 1.2 namespace, and every
required element is present in the correct `xs:sequence` order: `alert` emits
identifier → sender → sent → status → msgType → scope → info; `info` emits category →
event → urgency → severity → certainty → headline → description → area. `status` stays
`Actual` on a Cancel, which CAP 1.2 permits. **The XML is schema-valid.** Reporting a
namespace or ordering violation would have been fabrication. The absence of XSD validation
is retained as D31, and the profile-level `<language>` gap as D28.

**Report "polygon is not valid CAP geometry."** Also wrong. CAP 1.2 permits `polygon`,
`circle`, and `geocode` under `<area>`, unioned if multiple are present. The existing
`<circle>` is valid. The real problem is semantic — a 200 km disc described as a district
*extent* (D30) — not a schema error.

**Flag `escapeXml` as broken.** It is not. `src/cap.js:181-189` escapes `&`, `<`, `>`, `"`,
and `'` in the correct order (`&` first), and the reproduction confirms
`<script> & "quotes"` comes out correctly escaped in `<headline>` and `<description>`.
User input cannot break the XML through the fields the server populates. Only `<scope>`
is unescaped (D5) and it is currently unreachable. Reported narrowly rather than as a
general XML-injection claim.

**Claim RapidPro secrets leak in dispatch records.** `src/rapidpro.js:317-323` stores
`endpoint` and `request_body` on the dispatch record. Checked: `request.body` contains
flow uuid, recipients, and message text — **not** the token, which lives only in the
`authorization` header (`src/rapidpro.js:33`) and is never recorded. `GET /rapidpro/dispatches`
is behind the read gate, so this is fine. No defect.

**Report `MAINNET_PATTERNS` as a mainnet-guard bypass.** `src/parametric.js:6` defines
`MAINNET_PATTERNS` and never uses it — dead code, worth deleting. But the actual guard
(`isMainnet`, `:8-14`, plus the `PARAMETRIC_CHAINS` membership test at `:28-33`) correctly
rejects every mainnet name, and `'ethereum-sepolia '` with a trailing space fails the
membership test. Not a bypass. The real parametric defects are D19-D22.

**Propose a bounded `decimal` type for thresholds.** `src/parametric.js:46-47` accepts
`trigger_threshold` as any JSON value and `disbursement_amount_local_currency` likewise.
A string threshold would fail closed at evaluation time (there is no evaluation time — D20),
so the practical exposure is nil today. Folded into D20's fix rather than raised
separately.

**Propose a rate limiter on `/alerts/evaluate` and `/scenarios`.** Both are unbounded
full-dataset recomputes reachable with `read:hazards` (D23), so there is a DoS surface.
But `LINDELA_LITE_TOKENS` is an env var of trusted operators, and the audit's remit is
integration correctness. Folded into D23's fix as a note rather than raised as its own
finding.

**Propose Bloom/Nowhere-double pii for `hashUrn`.** `src/community.js:7-10` hashes a URN
with unsalted SHA-256 truncated to 16 hex chars. For a phone number the space is small
enough that the hash is reversible by enumeration, which is a real weakness — but PII
handling is out of Scope A and `src/pii.js` exists for exactly this. Noted, not claimed.

**Claim the partner portal's `partner_org` is a security vulnerability *introduced* by the
portal.** No. The guard has never worked, `docs/architecture/request-lifecycle.md:351-354`
says so, and the finding is reported as an unfixed known-broken filter (G2/D24) rather than
a regression.

**Re-propose the human dispatch gate (catalogue P0-D).** It ships, with tests. Listed in
the table as a catalogue error and explicitly not re-proposed.
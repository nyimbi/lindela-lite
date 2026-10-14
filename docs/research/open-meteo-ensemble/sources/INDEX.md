# Sources — Open-Meteo ensemble wiring

| File | What it is | Retrieved | Citation |
|------|------------|-----------|----------|
| `open-meteo-ensemble-api-docs.txt` | The Open-Meteo Ensemble API documentation page, text only (scripts, styles and site navigation removed; no wording altered). Carries the `/v1/ensemble` endpoint, the `models` parameter and the fact that it is required, the per-model member-count table (ICON 40, GFS 31, ECMWF IFS 51, …), and the statement *"This API call is equivalent to 4.0 calls"*. | 2026-10-15 | Open-Meteo, *Ensemble API*, <https://open-meteo.com/en/docs/ensemble-api> |
| `open-meteo-pricing.txt` | The Open-Meteo pricing page, text only. Carries the free-tier terms — *"The free API is for non-commercial use, rate-limited to 10,000 calls/day, and carries no uptime guarantee"* — the statement that ensemble data needs the Professional plan for customer use, and the CC BY 4.0 attribution requirement. | 2026-10-15 | Open-Meteo, *Pricing*, <https://open-meteo.com/en/pricing> |

## Why these two are here

The connector's ensemble path rests on three facts that are not inferable from
the API's behaviour and not visible in its own code: that an ensemble request
costs **4x** a deterministic one, that the free tier is capped at 10,000 calls a
day **and restricted to non-commercial use**, and that the data is CC BY 4.0 with
**attribution required**. A deployment that turned the ensemble on without the
attribution line would be in breach of the licence it fetched under, and the
breach would be invisible in the payload.

The **response shape** is deliberately *not* cited to a document. Neither page
states the member-suffix convention or the control run, so those are recorded in
[`../README.md`](../README.md) as measurements against live responses, with the
requests that produced them. A shape read off the wire is evidence; a shape
inferred from a doc that does not describe it is a guess.

Where the reasoning that rests on them is written out:
[`../README.md`](../README.md) (the decision and the measurements), and the
header of `src/connectors/open-meteo.js` (the wiring).

## Notes on the archived copies

- Each copy is the served page as retrieved on 2026-10-15, with markup stripped
  to text and navigation chrome removed. No wording altered.
- These are third-party documents and can be revised by their publisher at any
  time. The archived text is what this decision was made against; a later
  revision is a reason to re-read the note, not evidence that the wiring is
  wrong.

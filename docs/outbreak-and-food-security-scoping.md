# Scoping: Epidemic/Outbreak and Food-Security Tracking

**Status: scoping only. Nothing implemented, deliberately.**

This document exists because both capabilities are explicitly *not* a
connector to add quietly. Outbreak surveillance is a UNICEF policy question,
and IPC data is licensed. This records what we verified, what is technically
possible, what is not, and the decisions required before any of it is built.

All availability checks below were run live on 2026-10-01.

---

## 1. Food security — IPC classification

### What IPC is

The IPC (Integrated Food Security Phase Classification) is a **five-phase
acute food insecurity scale** produced by a partnership of NGOs and institutions
co-led by FAO and WFP. It is an *analytical classification*, not an
observation: it summarises current and projected acute food insecurity over a
specified area and period.

### Availability as checked

| Endpoint | Result |
|---|---|
| `https://www.ipcinfo.org/` | **403** — blocks automated access, with or without a browser User-Agent |
| `https://www.ipcinfo.org/ipc-country-analysis/en/` | **403** |
| `https://www.fao.org/ipc/en/` | 200 (human-readable pages) |
| FENIX services (`fenixservices.fao.org/api/faostat/...`) | **unreachable** (000) |
| FENIX intelligence API (`api.fenix.intelligence.fao.org`) | **unreachable** (000) |

So: **no machine-readable keyless IPC feed was reachable.** That matches the
brief — IPC data requires registration and licensing through the FSIN partner
network, and the classification is produced through an analytical process we
could not replicate.

### Implications

- Implementing IPC ingestion requires a signed licence and an account. That is a
  procurement and legal step, not an engineering one.
- Reimplementing the classification ourselves is **out of scope and
  inappropriate**: IPC is a multi-criteria analysis with a defined protocol and
  its own validation. A home-grown version would produce numbers that look like
  IPC and are not, which is the failure mode this project avoids everywhere
  else.
- Phase thresholds (Phase 3+ etc.) carry specific triggering consequences in
  famine and anticipatory-action policy. Misclassifying a phase has real
  operational consequences for resource allocation.

### Decision required

1. **Does UNICEF have an existing IPC/FSIN data agreement we can join?** If yes,
   this becomes feasible. If no, IPC should be represented as an explicitly
   unavailable input rather than approximated.
2. **Is FENIX reachable from the deployment environment?** It failed from ours,
   but that may be network policy rather than the service being down. Worth
   re-checking from a deployment host before concluding.

---

## 2. Epidemic / outbreak surveillance

### What exists and is keyless

| Source | Availability | Granularity |
|---|---|---|
| WHO GHO OData (`ghoapi.azureedge.net`) | **200, fully keyless** | See below |
| WHO Disease Outbreak News (HTML) | 200 | Narrative; no machine-readable feed found |
| WHO DON RSS/Atom | **none found** on the page | — |

WHO GHO exposes **3,099 indicators**, of which **44** match cholera, malaria,
or measles. It is a complete, documented, keyless OData API.

### The finding that matters most

Cholera case counts (`CHOLERA_0000000001`) are returned with:

```
SpatialDimType: "COUNTRY"
SpatialDim:     "PHL"
TimeDimType:    "YEAR"
TimeDim:        1979
```

**Country-level, annual, aggregated.** Verified against the live API on
2026-10-01.

This is decisive on technical grounds before any policy question arises. A
humanitarian platform working at district level — the entire premise of the
flood, road-access, and routing work — cannot use a national annual total to
drive district response. "Kenya had N cholera cases in 2022" does not tell an
operator anything about whether a specific district's water point is at risk.

So the keyless data that *is* available does not match the operational need, and
the data that would match (subnational, near-real-time) is not available
keyless.

### Why this is also a policy question, not just a technical one

Even if suitable data existed, the objective flags this correctly:

- Outbreak data can affect **funding flows and movement decisions**. A district
  labelled as an active outbreak can affect donor perception and operational
  prioritisation.
- **Stigmatisation risk** is real. Case geography at district or facility level,
  published without context, can affect reporting behaviour and access to
  services — suppress community detection.
- WHO data carries a stated licence permitting use with attribution. It is
  *national aggregate*, so the individual-privacy exposure is low, but any move
  toward subnational or facility granularity raises it sharply.
- This is squarely a UNICEF policy judgement, not an engineering call. We should
  not be the party deciding it.

### What we have not done, deliberately

There is no outbreak connector, no outbreak collection, and no dashboard
surface. The seeded demo contains disease *incidents* and a MUAC/intervention
narrative, all of which are clearly marked as fictional demo data. Those are
operations-case-management records, not surveillance claims, and they must stay
distinguishable from anything representing observed disease.

## 3. Related but distinct: what we already consume

The project already reads **DF_CHOLERA** and related indicators through the
existing `dhis2` connector scaffold. That is configured by an operator who
supplies their own instance URL and token — the connector is inactive by
default and requires no bundled credentials. It is a data-sync mechanism the
operator controls, not surveillance instrumentation we introduced.

---

## 4. Decisions required before any implementation

1. **UNICEF policy approval** for outbreak data surfacing, at whatever
   granularity. Recommended: treat as a hard gate — no code without written
   policy, given the stigmatisation and funding-flow implications.
2. **Licence/access** for IPC. Without an FSIN agreement, IPC should appear in
   the product as explicitly unavailable, not approximated.
3. **Is country-aggregate outbreak data worth integrating at all?** On the
   evidence above, it would add little operational value while carrying policy
   cost. Our recommendation is **no**, unless a subnational, licence-compatible
   source is identified.
4. **What would count as sufficient granularity?** District, admin2? Near-real
   time or weekly? This determines whether any available feed is fit for purpose
   — and our assessment is that none currently reachable is.
5. **Attribution and licence display.** Any WHO-derived surface must carry
   attribution per the WHO terms. To be settled before, not after.

## 5. What is shipped today

- No outbreak surveillance connector, collection, or UI.
- No IPC integration.
- No food-security phase modelling.
- The DHIS2 scaffold is operator-configured and inactive by default; it is not
  outbreak instrumentation.

## References

- IPC official site (access restricted to registered users):
  https://www.ipcinfo.org/
- FAO IPC programme: https://www.fao.org/ipc/en/
- WHO Global Health Observatory OData API (keyless):
  https://ghoapi.azureedge.net/api/Indicator?$format=json
- WHO Disease Outbreak News: https://www.who.int/emergencies/disease-outbreak-news
/**
 * ENH-54 — the store side of the value-of-information ranking.
 *
 * `src/value-of-information.js` prices one gap at a time: a threshold, an
 * evidence shortfall and a loss weight in, an EVPI out. It knows nothing about
 * this store, and that is the whole reason it had no production caller — the
 * missing half is the part that knows *where the gaps come from*. They are
 * already published, in two places, and neither of them is a ranking:
 *
 *   - `model_drift` rows carry a per-region verdict, and the regions that came
 *     back `not_measurable` are the platform saying "we could not compute this"
 *     with the window that was too short to say anything.
 *   - `freshnessReport` carries a per-source verdict, and `never_run`,
 *     `broken` and `empty_response` are the platform saying a feed is not
 *     arriving.
 *
 * Both are honest refusals and both read as a catalogue. This module joins
 * them into one list ordered by what closing each would buy, which is the thing
 * a procurement officer actually needs and the thing no surface did.
 *
 * **The two sources of gap are priced on the same scale on purpose.** A refused
 * drift verdict and a silent feed are different kinds of absence, and an entropy
 * measure could not add them — bits over one alphabet are not bits over another.
 * EVPI is denominated in the decision's own loss, so a dollar of averted loss
 * from a district with no drift evidence is the same dollar as one from a feed
 * that stopped. That commensurability is why the ranking can exist at all, and
 * it is stated in `value-of-information.js` rather than assumed here.
 *
 * **A gap with no grounded threshold is refused, not ranked at zero.** The
 * ranking module already does this and this module does not soften it: the
 * refusal list travels beside the ranking in the payload. A zero EVPI and an
 * uncomputable EVPI are opposite claims about a gap, and a list that shows them
 * as one number is the defect the module exists to avoid.
 */

import { freshnessReport } from './freshness.js'
import { driftGaps, freshnessGaps, rankDataGaps } from './value-of-information.js'

/**
 * Every data gap this deployment currently carries, ranked by what closing it
 * would buy.
 *
 * `lossByRegion` and `lossBySource` are the caller's. With neither, every gap
 * is worth the same per unit of decision error and the ranking is driven by the
 * geometry of the gap against its threshold alone — which is the honest
 * statement that this module has no basis to weight one district's error above
 * another's. A caller holding population or a funding envelope passes them and
 * the ranking follows.
 */
export function dataGaps(data = {}, { now = Date.now(), lossByRegion = {}, lossBySource = {} } = {}) {
  const drift = driftGaps({ records: data.model_drift || [] }, { lossByRegion })
  const fresh = freshnessGaps(freshnessReport({ sourceRuns: data.source_runs || [], now }), { lossBySource })
  const ranking = rankDataGaps([...drift, ...fresh])
  return {
    ...ranking,
    // How many gaps went in, split by where they came from. A ranking that
    // considered none and a ranking whose every gap was refused both report
    // `ranked: 0`, and the two are different facts about the deployment.
    gaps_considered: drift.length + fresh.length,
    by_kind: { drift: drift.length, freshness: fresh.length },
    // The refusals the two gap builders produced, kept apart from the ranking
    // module's own. A drift record can be `not_measurable` with no signal
    // naming why, which is a gap `driftGaps` reports rather than one it drops.
    unpriceable: [...drift, ...fresh].filter((gap) => !gap.thresholdKey).map((gap) => ({
      id: gap.id ?? null,
      kind: gap.kind ?? null,
      reason: gap.reason || 'the gap names no decision threshold, so there is no action to price it against',
    })),
  }
}

// The `ads` tool package (tasks V09 read / V10 control) — Marketing API access,
// deliberately rescoped for 1.1 to READ plus status/budget CONTROL (doc 06,
// A12), with single-object archive/delete added in 2.0 (v2 ads §3). New objects
// come only from copying one the operator already created in Ads Manager
// (v2 ads §7) or from the narrow boost chain for one Page post (v2 ads §1,
// `./ads-create.ts`): always PAUSED and only when the campaign is capped within
// the configured maximums. A general ad create-chain stays out of scope.
//
//   * facebook_list_campaigns / _adsets / _ads — one cursor page of objects under
//     an ad account, at the level the tool name names.
//   * facebook_get_ad_object      — any campaign / ad set / ad by id.
//   * facebook_ads_insights       — sync insights with an automatic async
//     fallback for queries Graph refuses to answer synchronously.
//   * facebook_ads_report_status  — probe one async run and, on request, read its
//     rows once it is complete.
//   * facebook_get_ad_preview     — how an ad, a creative or a Page post as an
//     ad renders in one placement; creates nothing.
//   * facebook_update_ad_object   — pause/resume and budget changes, plan-gated.
//   * facebook_archive_ad_object / facebook_delete_ad_object — retire one
//     object (and, by inheritance, its children), plan-gated and irreversible.
//   * facebook_upload_ad_image    — add a local image to the account's image
//     library and return its hash; creates no ad.
//   * facebook_get_ad_set_targeting / facebook_update_ad_set_targeting — read
//     an ad set's audience; edit only its countries and age range.
//   * facebook_duplicate_ad_object — copy one object into a PAUSED copy.
//   * facebook_boost_post          — boost one Page post as a PAUSED campaign,
//     ad set, creative and ad, rolled back if a step fails.
//
// Division of labour with `../api/ads-read.js` and `../api/ads-control.js`
// follows the layer rule (core ← api ← mcp ← tools). The api modules own the
// Graph calls, the ad-account id normalisation, the `effective_status` truth
// (CC-ADS-2), minor-unit budgets (CC-ADS-3), the async report-run state machine
// (CC-ADS-5), ad-account health (CC-ADS-6), the ceiling refusal (CC-ADS-7) and
// the PURE planner. This module owns the zod schemas, the model-facing prose and
// the write-gate wiring — it re-derives none of that logic, so a refused budget
// or a read-only object produces the api module's one actionable message rather
// than a zod issue that disagrees with it.
//
// Three things worth knowing before reading further:
//
//   1. NO `profile` ARGUMENT. Ads objects hang off an AD ACCOUNT, not a Page, and
//      they are authorized by the user/system token rather than a Page token
//      (C1). The Page selector every other package carries would be a lie here,
//      so these tools take `ad_account_id` (defaulting to `FB_AD_ACCOUNT_ID`)
//      and nothing else.
//   2. THE PLAN IS BUILT BY THE API LAYER, PURELY. `planAdObjectUpdate` makes no
//      request, so the dry run classifies the tier, computes the warnings and
//      refuses over-ceiling budgets with no chance of a write reaching Graph.
//      The tier is the PLAN's tier, not a constant: pausing is `irreversible`,
//      resuming or raising a budget is `spend`.
//   3. THE PRE-READ IS REUSED AS THE DIVERGENCE SNAPSHOT. The handler must read
//      the object anyway (the planner needs the current values), so that same
//      read answers the gate's first `readState()` call instead of a second GET.
//      A later call — the gate comparing at apply time — re-reads for real.
//
// Layout of this directory (split from the former single `../ads.ts`, which is
// now a thin re-export facade so every importer keeps its path):
//
//   * common.ts    — annotation quadruples, shared input fields, ad-account
//                    ownership checks.
//   * read.ts      — listings, single-object read, placement preview.
//   * insights.ts  — insights and async report-run status.
//   * control.ts   — status / budget / spend-cap update, archive / delete.
//   * targeting.ts — ad-set targeting read and narrow edit.
//   * image.ts     — ad image upload.
//   * copy.ts      — paused duplicate of a campaign / ad set / ad.
//   * index.ts     — the package factory (this file).

import type { PackageSpec } from '../../core/index.js';
import { boostPostTool } from '../ads-create.js';
import { createReadTools } from './read.js';
import { createInsightsTools } from './insights.js';
import { createUpdateAdObjectTool, lifecycleTool } from './control.js';
import { getAdSetTargetingTool, updateAdSetTargetingTool } from './targeting.js';
import { uploadAdImageTool } from './image.js';
import { duplicateAdObjectTool } from './copy.js';

// ---------------------------------------------------------------------------
// Package factory
// ---------------------------------------------------------------------------

/**
 * Build the `ads` package: eight read tools and seven write tools. OFF by default
 * (doc 06 — `ads` is excluded from the `core` profile and reached through the
 * `ads`/`all` profiles or an explicit `FB_TOOL_PACKAGES`), because a server that
 * can move money should be opted into rather than out of.
 */
export function createAdsPackage(): PackageSpec {
  const { listCampaigns, listAdsets, listAds, getAdObjectTool, getAdPreview } =
    createReadTools();
  const { adsInsights, reportStatus } = createInsightsTools();
  const updateAdObject = createUpdateAdObjectTool();

  return {
    name: 'ads',
    title: 'Ads',
    description:
      'Marketing API access: campaign / ad-set / ad listings with delivery truth, ' +
      'single-object reads, placement previews, insights with async report runs, plan-gated ' +
      'status, budget and campaign spend-cap control, single-object archive/delete, ad image ' +
      'uploads, ad-set targeting reads with a narrow countries/ages edit, paused copies of ' +
      'campaigns, ad sets and ads, and paused boosts of Page posts. Off by default.',
    tools: [
      listCampaigns,
      listAdsets,
      listAds,
      getAdObjectTool,
      getAdPreview,
      adsInsights,
      reportStatus,
      updateAdObject,
      lifecycleTool('ARCHIVED'),
      lifecycleTool('DELETED'),
      uploadAdImageTool,
      getAdSetTargetingTool,
      updateAdSetTargetingTool,
      duplicateAdObjectTool,
      boostPostTool,
    ],
    enabledByDefault: false,
    // `writeModeDefault: 'plan'` is only the default for a server that did not
    // choose: an explicitly set `FB_WRITE_MODE=apply` overrides a package
    // default outright (see `effectiveWriteMode`). What makes the single write
    // here plan-first whatever the mode says is the tier it hands the gate —
    // `irreversible` for a pause, `spend` for a resume or a budget raise, never
    // `reversible` — because both of those ignore the mode entirely and always
    // demand the `plan_id` from a preceding preview. `FB_WRITE_MODE=apply` is a
    // convenience for cheap Page writes and must never silently promote a budget
    // change into a one-shot spend (doc 06). The default still earns its place
    // for the day a reversible ads write is added, which would otherwise inherit
    // the operator's global apply.
    writeModeDefault: 'plan',
  };
}

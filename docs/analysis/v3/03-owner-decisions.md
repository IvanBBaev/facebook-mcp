# 03 — Owner decisions (v3)

Each decision lists its options and a recommendation, plus the wave in
[doc 05](05-parallel-task-breakdown.md) that it blocks. A decision is taken by the owner only and
recorded here as **Decided YYYY-MM-DD: X**. No task that a decision blocks may be dispatched
before that decision is recorded.

On 2026-10-30 the owner delegated every open decision to the review round of 2026-10-29
([`docs/reviews/v3/`](../../reviews/v3/README.md)). Those decisions are recorded as **Decided
2026-10-30 (delegated by the owner)** and follow the review recommendation unless the entry
says otherwise. The owner can reopen any of them by recording a new decision here.

| ID | Question | Blocks | Recommendation |
|---|---|---|---|
| V3-D1 | Adoption checkpoint outcome | ambitious variant; waves 5–6 scope | Re-measure 30 days after 0.8 + listings — **Decided 2026-10-30: B, amended** (per server, clock from listings) |
| V3-D2 | Shared core with instagram-mcp | B-tasks for the monorepo | No before 3.0; revisit at the gate — **Decided 2026-10-30: no** |
| V3-D3 | Canonical write gate across sibling servers | none (docs only) | facebook-mcp's plan/apply is canonical — **Decided 2026-10-28** |
| V3-D4 | Remote (HTTP + OAuth) mode | wave 5 A-tasks | Not before 3.x; opt-in single operator only — **Decided 2026-10-30: A** |
| V3-D5 | Rename scope | wave 2 rename L-tasks | 3b: insights family + the v2 D5 set — **Decided 2026-10-30: 3b + args** |
| V3-D6 | Durable work (uploads, plans) | A-tasks for ports and durable uploads | 4a: durable uploads only; Tasks later — **Decided 2026-10-30: 4a** |
| V3-D7 | Threads | none | Never in this server — **Decided 2026-10-30: never** |
| V3-D8 | Skills and prompts | A-tasks for resources/prompts | Prompts + plugin skills in 2.x — **Decided 2026-10-30: amended** (A01 in 1.0, A03 in 1.x) |
| V3-D9 | Legacy-client support promise in 2.x | wave 6 | Support both eras for all of 2.x — **Decided 2026-10-30: A, removal major trigger-based** |
| V3-D10 | Stable insights schema: 1.0 or 3.0 | C05 and the insights lane | 1.0 — **Decided 2026-10-29: 1.0** |
| V3-D11 | Dispatch model | every wave from 0 | ≤ 4 parallel lanes, owner integrates — **Decided 2026-10-28: A** |
| V3-D12 | What 1.0 means | phase B/C gates | "Verified Pages core" — **Decided 2026-10-30: C** |
| V3-D13 | One breaking line or two majors | release labels of every wave | 0.9 contracts, 1.0 platform — **Decided 2026-10-30: B** |
| V3-D14 | Experimental tier outside the 1.0 contract | C06, D01, phase B gate | **Decided 2026-10-30: B** |
| V3-D15 | Owner tasks before wave 2 | wave 2 dispatch | **Decided 2026-10-30: B** |
| V3-D16 | Response to an official Meta MCP | U-A5 | **Decided 2026-10-30: B** |
| V3-D17 | Target segment | D01, U-A2c | Developer-operators — **Decided 2026-10-30: B** |

## V3-D1. Adoption checkpoint outcome

The v2 bar (≥ 100/week, ≥ 25 stars, ≥ 3 non-author issues) will be missed on 2026-11-25. But
the project has had no release since 0.7.0 and no directory presence beyond the official
registry and Glama, so the bar has not been tested yet.

| Option | Meaning |
|---|---|
| A. Personal tool now | Consolidate to core, reader, posts, insights. Lean 3.0 only |
| **B. Fair re-measure** | Ship 0.8.0, list on PulseMCP, Smithery, mcp.so and the GitHub MCP registry, submit the Claude plugin, answer PR #41. Measure 30 days later |
| C. Ignore the gate | Build the ambitious variant regardless |

New gate for option B (all measured across facebook-mcp and instagram-mcp):

- ≥ 3 non-author issues or PRs;
- npm median ≥ 100/week over 4 weeks;
- > 50 directory referrers or plugin installs;
- stars ≥ 25 (lagging; informative only).

**Recommendation: B.** On a fail, apply A. Waves 0–3 are right under both outcomes, because
they are contract work.

**Decided 2026-10-30 (delegated by the owner): B, amended.** (review PM-04) The gate is measured **per server**, not
across facebook-mcp and instagram-mcp combined. The 30-day clock starts on the day the listings
(U-A2a) are submitted, not on the release day. Issues, directory referrers and confirmed client
installs weigh more than npm downloads, which bots and CI inflate. The fail action is committed in
advance: on a fail, apply A and keep only the tools the dogfood log (U-A4) shows in use. The
earlier sentence "waves 0–3 are right under both outcomes" holds for waves 0–1 only; waves 2–3
follow V3-D15.

## V3-D2. Shared core with instagram-mcp

v2 D2 decided **B** (keep the sibling), and the 2026-10-28 doc update keeps it running
alongside. A `meta-mcp` monorepo with a shared `meta-core` would remove the duplication of HTTP,
auth, redaction and the write gate, but it makes a library API a contract.

**Recommendation:** no shared core before 3.0. Revisit only if V3-D1 passes **and** both
servers have non-author users. Until then, copy fixes across by hand and note them in both
CHANGELOGs.

**Decided 2026-10-30 (delegated by the owner): no shared core before 3.0**, as recommended.

## V3-D3. Canonical write gate

Recorded as decision D3 in the 2026-10-28 docs. facebook-mcp's plan-and-apply (tiers, `plan_id`,
confirm seam) is the reference design, and the sibling follows it. This is docs only and blocks
no task.

## V3-D4. Remote mode

| Option | Meaning |
|---|---|
| **A. Local-first only through 3.0** | stdio by default plus loopback HTTP; no OAuth |
| B. Opt-in remote single operator (2a) | OAuth facade for one Meta identity; persistent plan store; 3.x |
| C. Hosted multi-tenant (2b) | Never (see [02 §5](02-v3-scope.md)) |

**Recommendation: A**, with B allowed in 3.x only if V3-D1 passes. The ports introduced in
wave 5 (`PlanStore`, `TokenStore`) keep B cheap later without committing to it.

**Decided 2026-10-30 (delegated by the owner): A.** B stays possible in 3.x only if V3-D1 passes.

## V3-D5. Rename scope

| Option | Meaning |
|---|---|
| 3a. None | Record every odd name as an exception |
| **3b. Insights family + v2 D5 set** | `get_*_insights` family, `get_ads_report_status`, `send_private_reply`, `set_comment_visibility`, `ad_set` spelling, `boost_post` arg; old names stay as deprecated aliases in 1.x and are removed in 2.0 |
| 3c. Full verb/noun scheme | Every tool name follows one grammar; ~25 aliases for a whole major |

**Recommendation: 3b.** Each rename is lane-local in wave 2 (the lane owns its tool file and
its annotation fragment). The alias mechanism itself is task C06.

**Decided 2026-10-30 (delegated by the owner): 3b + args.** (review OD-1) Agents fail more often on argument
names than on tool names. The 3b tool set is extended with the argument lexicon from the Agent-UX
review (AUX-07: `object_id`, `comment_id(s)`, `page`/`profile`), and `post_insights` joins the
`get_*_insights` family. All of them go through the C06 alias mechanism.

## V3-D6. Durable work

| Option | Meaning |
|---|---|
| **4a. Durable uploads** | `UploadSessionStore` port with a file adapter; resumable video/reel uploads survive a restart |
| 4b. Tasks extension | Long uploads and report exports as MCP Tasks, with a synchronous fallback |
| 4c. Both | |

**Recommendation: 4a in 2.x; 4b only once Claude Code or another target client supports
Tasks.**

**Decided 2026-10-30 (delegated by the owner): 4a in 2.x**; 4b only when a target client supports Tasks.

## V3-D7. Threads

**Recommendation: never in this server.** If wanted, it is a third sibling server.

**Decided 2026-10-30 (delegated by the owner): never in this server.**

## V3-D8. Skills and prompts

Claude Code consumes MCP prompts and plugin skills, but it does not render MCP Apps.

**Recommendation:** 2–3 prompts (weekly report, comment triage, publish-and-boost) and
`facebook://reference/*` resources in 2.x, plus the Claude plugin with the same skills. No Apps
UI.

**Decided 2026-10-30 (delegated by the owner): amended.** (review OD-2) A01 (`instructions`) moves into 1.0 as a
wave 2 side task; it saves about 25 KB of repeated tool-description boilerplate. A03 (prompts and
`facebook://reference/*` resources) ships in the first 1.x minor. The plugin skills are generated
from the same prompt text so the two cannot drift. Still no Apps UI.

## V3-D9. Legacy-client support promise

Once the 2.0 server speaks both eras, going modern-only breaks every client still on a
2025-era protocol version.

| Option | Meaning |
|---|---|
| **A. Both eras for all of 2.x** | Modern-only is the 3.0 headline |
| B. Modern-only in a 2.x minor | Breaks semver for legacy clients; only defensible if their share is near zero |

**Recommendation: A.** This decision makes "3.0 = removals" coherent.

**Decided 2026-10-30 (delegated by the owner): A, with a trigger-based removal major.** (review
PM-11) Both protocol eras stay supported for the whole of the platform major. The removal major is
cut when a trigger fires (legacy-client share near zero, a forced SDK v3, or Node 24 EOL on
2028-04-30), not on a fixed Q4 2027 date. Under V3-D13 B this removal major is **2.0**.

## V3-D10. Stable insights schema timing

**Recommendation: 1.0.** Meta removes metric names across all versions without a version bump.
A server-owned schema (`views`, `viewers`, `engagements`, `follows`…, each with
`source_metric` and `status: ok | removed | empty`) absorbs that churn. Shipping it in 1.0
means later waves become a status change, not a breaking change. It is additive (new fields
alongside the raw `metrics`), so it does not have to wait for a major.

**Decided 2026-10-29: 1.0.** C05 is dispatched in wave 1.

## V3-D11. Dispatch model

| Option | Meaning |
|---|---|
| **A. ≤ 4 parallel lanes; the owner integrates** | Merge order from doc 05; one wave at a time |
| B. Up to 8 lanes | Maximum parallelism; integration becomes the bottleneck |
| C. Serial | No coordination cost; slowest |

**Recommendation: A.** The integrator is the owner, or one session with the I-tasks only.

**Decided 2026-10-28: A.** Wave A (U-A1) approved the same day.

## V3-D12. What 1.0 means

| Option | Meaning |
|---|---|
| A. Contract fixes | The current v3 meaning |
| B. Usage proven | Live pass, dogfood log and onboarding trials |
| **C. Verified Pages core** | B plus the breaking contracts plus the listings |

**Decided 2026-10-30 (delegated by the owner): C.** (review PM-02) 1.0 is the first release whose core behaviour has
been seen working on a real Page, by the owner and by at least two other people (U31). The
phase gates in [doc 04](04-roadmap-and-risks.md) carry the details. The README roadmap section is
updated in task D01.

## V3-D13. One breaking line

| Option | Meaning |
|---|---|
| A. Two majors | 1.0 in Jan 2027 (contracts), 2.0 in Apr 2027 (platform) |
| **B. One breaking line** | **0.9** carries the contracts (Jan 2027); **1.0** carries the platform and the verified contracts (before 2027-04-30) |
| C. 1.0 in Jan; 2.0 keeps every alias | Node and SDK change only |

**Decided 2026-10-30 (delegated by the owner): B.** (reviews PM-03, T9) Two breaking releases about ten weeks apart are
expensive for users and for one maintainer. Under 0.x semver the contract changes are allowed in
a minor. Fallback: if an SDK v1 security fix forces a stable release early, apply C.

The phase and wave structure does not change, only the release labels; the mapping is in
[doc 04 §1](04-roadmap-and-risks.md#1-phases). Older documents that say "1.0" for the contract
release mean **0.9** from now on; "2.0" means **1.0**; "3.0" means **2.0**.

## V3-D14. Experimental tier

| Option | Meaning |
|---|---|
| A. All 69 tools are contract | |
| **B. Experimental tier** | Ads writes beyond status and budget, `boost_post`, ad duplication, targeting edits, ad image upload, Messenger labels, message reactions and attachments, and Page profile edits are marked experimental; they may change in a minor |
| C. Remove them | |

**Decided 2026-10-30 (delegated by the owner): B.** (review PM-07) C is applied to a tool only if the adoption gate
fails **and** the dogfood log shows no use of it. The marking ships in C06 (metadata) and D01
(README).

## V3-D15. Owner tasks before wave 2

**Decided 2026-10-30 (delegated by the owner): B.** (reviews PM-01, PM-05, PM-15) Wave 2 is not dispatched until U-A2
(listings and announcement) and U-A3 (thin live pass) are done. Wave 1a and wave 1 are internal
and run in parallel with them.

## V3-D16. Response to an official Meta MCP

Meta has shipped official MCP servers for Ads (2026-04-29), Social Technologies (2026-06-30) and
WhatsApp (2026-09-15). A Pages MCP is the next likely one (risk R7).

**Decided 2026-10-30 (delegated by the owner): B.** (review PM-08) U-A5 writes, in 0.8.x, the survival list (the plan
and apply write gate, boost composability, local-first, the error matrix), the trigger (an
official Pages or Business Messaging MCP announced) and the pre-committed actions (re-run V3-D1,
README positioning, consider "personal tool").

## V3-D17. Target segment

**Decided 2026-10-30 (delegated by the owner): B, developer-operators.** (review PM-09) The README, the onboarding
runbook and the announcement address developers who run their own Meta app. Non-developers are
pointed to hosted options.

## Review-round decisions (2026-10-30)

Decisions raised by the role review round. Each one was **decided 2026-10-30 by owner
delegation**, following the review recommendation unless the "Decision" column says otherwise.
The ID points into the role document in `docs/reviews/v3/`.

| ID | Review | Question | Decision | Lands in |
|---|---|---|---|---|
| SD-1 | Security | How outbound-speech writes are confirmed | (b) taint latch, plus always out-of-band confirmation for `send_message` and `update_page_profile` | C08 |
| SD-2 | Security | Moderation apply-by-default | (b) apply only for text-free verbs (`hide`, `unhide`, `like`); free text is plan-first | R02 (0.8.1) |
| SD-3 | Security | Replacement for the static confirm token | (b) per-plan HMAC code through `facebook-mcp confirm`; static mode deprecated | C09 |
| SD-4 | Security | `FB_ADS_BUDGET_CEILING` | (b) required for spend-tier writes; reads work without it | C04 ext., L2.ads |
| SD-5 | Security | `FB_APP_SECRET` | (b) required, with the `FB_ALLOW_NO_APPSECRET` escape hatch | C04 ext. |
| SD-6 / D-OPS-2 | Security, DevOps | Release approval | `release` environment with the owner as required reviewer, plus tag and branch rulesets — **done 2026-10-30** | U-A7, `release.yml` |
| D-OPS-1 | DevOps | Public surface of the stable release | CLI and server only; no library `exports` | I31 |
| D-OPS-3 | DevOps | Marketplace source | A release ref, updated in the cut task | R15 |
| D-OPS-4 | DevOps | Bus factor | Documented solo plan with recovery codes in `SECURITY.md` and the release runbook; a co-maintainer is not required | R15, D04 |
| D-OPS-5 | DevOps | Owner of the release rail | Separate task R15 in wave 1a; I32 stays a pure cut | R15 |
| D-OPS-6 | DevOps | Merge method | Merge commits for task branches (the integrator protocol); squash only for external PRs | R15 |
| D-OPS-7 | DevOps | Release notes source | The CHANGELOG section plus an auto-generated contributor list | R15 |
| D-META-1 | Meta | When to fix `advantage_audience` | Hotfix now | R01 (0.8.1) |
| D-META-2 | Meta | Page video upload flow | Decide after live check C4; prefer the Resumable Upload API if C4 fails | L2.posts-upload |
| D-META-3 | Meta | Special ad categories in boost | Warn and refuse political or social-issue content in the stable release; accept the input in a later minor | L2.ads |
| D-META-4 | Meta | Thin early live pass | Approved: A1, A3, C4, D3 on the test ad account, spend cap at most 1 unit of the account currency | U-A3 |
| D-META-5 | Meta | Supported access level | Standard Access (single owner) is the primary mode; Advanced Access and App Review are optional | D02 |
| D-QA-1 | QA | Test-infrastructure mini-wave | Accepted as wave 1a; it gates C01 | doc 05 §12 |
| D-QA-2 | QA | Coverage gate | Per-PR ratchet against `main`, inside `npm run check` | R11 |
| D-QA-3 | QA | Ads write fixtures | Captured on the disposable ad account (PAUSED, zero delivery) | U30b |
| D-QA-4 | QA | Tier source of truth | Assert equality first (expand); derive from the spec in the C step | C11 |
| D-QA-5 | QA | Mutation-probe runner | Manual QA step per wave; not committed as a scheduled job | doc 05 DoD |
| D-ARC-1 | Architect | Home of the media-source code | (b) shared `src/api/media-source.ts`, C-owned | C07 |
| D-ARC-2 | Architect | `upload-session.ts` | (a) adopt in L2.posts-upload; revert X06 if not adopted by the wave 2 tag | L2.posts-upload |
| D-ARC-3 | Architect | Exact SDK pin | (a) now | R11 |
| D-ARC-4 | Architect | P01 freeze | (b) re-scoped file set, no code freeze | P01 |
| D-ARC-5 | Architect | HTTP deployment model of the platform release | (a) single process, documented; `PlanStore` port in wave 4 | P06 |
| D-ARC-6 | Architect | Write-gate typing | (b) `WriteGatePort` on `ToolContext` | I30 ext. |
| D-ARC-7 | Architect | File-size budget | (b) 1,200-line soft gate with a shrinking allowlist | R14 |
| OD-1 (AUX) | Agent UX | Argument renames | Yes — see V3-D5 | C06 |
| OD-2 (AUX) | Agent UX | A01 / A03 timing | Yes — see V3-D8 | A01, M07 |
| OD-3 (AUX) | Agent UX | One time-window contract (`until` exclusive, window echoed) | Yes | C02 ext. |
| OD-4 (AUX) | Agent UX | Schema-budget ratchet | Yes: default ≤ 90 KB, `all` ≤ 110 KB, persona ≤ 40 KB | R13 |
| OD-5 (AUX) | Agent UX | Single list-level taint envelope | Yes, with a Security co-sign | C02 ext. |
| OD-6 (AUX) | Agent UX | Apply by `plan_id` alone | Yes, bound to profile and tool | M01 |
| OD-7 (AUX) | Agent UX | `create_story` tier | Stays irreversible, with `destructiveHint: true` | L2.posts |
| OD-1 (DX) | DevRel | Pages site source of truth | The metadata generator | I-A4 |
| OD-2 (DX) | DevRel | Questions channel | GitHub Discussions (Q&A and Ideas) | U-A8 |
| OD-3 (DX) | DevRel | Contributor communication | Answer #40/#41 now; 7-day first-response target; human `Co-authored-by` trailers allowed, AI attribution still banned | U-A8, D04 |
| OD-4 (DX) | DevRel | Analysis corpus visibility | Stays public; moving it under `docs/internal/` is part of D07 | D07 |
| OD-5 (DX) | DevRel | Honesty framing | A dated per-package verification table replaces the banner | D01, D03 |
| OD-6 (DX) | DevRel | CHANGELOG policy | Summary first, detail collapsed, a line budget per fragment | I32 |
| OD-7 (DX) | DevRel | Demo assets | Recorded after the live pass, so they show verified behaviour | U-A2d |
| OD-8 (DX) | DevRel | Docs task type | Type **D** added to the board | doc 05 §12 |
| LEG-12 | Legal | Product name | Keep the package id `@ivanbaev/facebook-mcp` with a descriptive display name; a full rename only if the lawyer's answer to Q3 requires it | D01, D09 |
| LEG-03 | Legal | Logo | An original mark replaces the redrawn "f" | D09 |
| LEG-02 | Legal | Journal retention | 90 days by default, `FB_JOURNAL_RETENTION_DAYS`, `0` keeps forever | C14 |
| LEG-04 | Legal | Special ad category attestation | A required argument on spend-tier creates | L2.ads |
| LEG-05 | Legal | Privacy notice hosting | `PRIVACY.md` in the repo, served on the GitHub Pages site; the contact is GitHub issues and private security advisories, not a personal address | D08, I-A4 |

### Questions for a lawyer

The Legal review (§8) lists seven questions (Q1–Q7). Delegation cannot answer them; they stay
open for the owner. None blocks 0.8.x or 0.9. They must be answered before the stable release
(1.0 under V3-D13), before any remote mode, and Q3 before a full rename.

## Open v2 decisions carried over

| v2 ID | State on 2026-10-28 | v3 handling |
|---|---|---|
| D1 checkpoint | open | superseded by V3-D1 |
| D4 insights window | adopted de facto in PR #41's direction | confirm with the live gate before 1.0 |
| D5 renames | open | superseded by V3-D5 |
| D6 `outputSchema` on write previews | open | task C03 builds the envelope schema; recommendation unchanged (envelope only) |
| D7 PR #41 | closed 2026-10-28 | recorded as merged; its content landed in `c7ce5b8` |

# 02 — v3.0.0 scope

Inputs: `docs/ai/research/v3/{mcp-platform-horizon,meta-platform-horizon,architecture-options,market-adoption}.md`
(local), checked 2026-10-28.

## 1. Semver rule used here

A change is **3.0** only if it breaks a user of 2.x **and** cannot be done in 1.0 or 2.0 first.
A breaking change that could land before 1.0 belongs to 1.0. A break forced by the 2026-07-28
platform belongs to 2.0. Additive work belongs to a 2.x minor.

## 2. Forcing functions

### 2.1 MCP and runtime

| Event | Date | Class for facebook-mcp |
|---|---|---|
| Spec 2027-03-30 (SDK betas ~mid-Feb, soft freeze ~mid-Jan) | 2027-03-30 | 2.x minor, unless it ships a breaking result-shape or transport change (nothing public says it will) |
| Spec ~2027-09-28: first revision that may remove Roots, Sampling, Logging, DCR | ~2027-09-28 | Not a trigger by itself: none are used (verify MCP `logging/message` vs stderr in 2.x) |
| TS SDK v3 dropping the 2025-era path | not announced; earliest plausible with ~2027-09-28 **[UNVERIFIED]** | **3.0** if adopted |
| `tools/call` result-shape redesign (roadmap) | no SEP yet; earliest 2027-03-30 | **3.0** if it replaces rather than adds |
| HTTP-over-stdio single binding (roadmap) | no SEP yet; earliest ~2027-09 | **3.0** if launch config changes |
| Going modern-only (`legacy: 'reject'`, `legacyShim: false`) | config flip, any time | **3.0** (breaks legacy clients) |
| Node 22 EOL | 2027-04-30 | 2.0 floor `>=24` already covers it |
| Node 26 sole Active LTS | 2027-10-20 | 3.0 floor `>=26` justified from here |
| Node 24 EOL | **2028-04-30** | **3.0 hard deadline** |
| SDK 2.4.0 un-wraps `outputSchema` `{result}` on 2025-11-25 inside a minor | 2026-10-23 | 2.0 migration must pin and snapshot this |

### 2.2 Meta

| Event | Date | Class |
|---|---|---|
| Marketing v26 sunset → ads pin bump | ≈ Aug–Sep 2027 **[PROJECTED]** | 2.x minor (do it ≈ 2027-06) |
| Second ads pin bump | ≈ H1 2028 **[PROJECTED]** | 3.x minor |
| Explicit `advantage_audience` on all versions | 2027-02-23 | 1.x/2.x fix (duplicate and targeting-edit paths) |
| Next all-version insights wave (likely the "deprecated above v25" names) | unannounced, plausibly 2027 | **Contract**: stable insights output schema, placed in 1.0 |
| Graph v26 sunset | not before ≈ Dec 2028 **[PROJECTED]** | no forced action in 3.x |
| Official Meta Pages / Business Messaging MCP | medium-high within 12–18 months **[UNVERIFIED]** | positioning, not a version event |

## 3. Placement of every candidate

| # | Candidate | Lands in | Why there |
|---|---|---|---|
| 1 | Unified error envelope (one shape, typed `code`) | **1.0** | Breaking, but free before 1.0 |
| 2 | Tool renames with 1.x aliases (insights family, `ads_report_status`, `private_reply`, `ad_set`, `boost_post` arg) | **1.0** (aliases deprecated) → removed **2.0** | V3-D5 decides how many |
| 3 | `fields` as an array (CSV accepted, deprecated) | **1.0** | Additive-then-removal |
| 4 | Pagination: `nextCursor` omitted when done | **1.0** | |
| 5 | `notes[]` only | **1.0** (`note` deprecated) → removed **2.0** | |
| 6 | Env / token variable collapse (old names as aliases) | **1.0** → aliases removed **2.0** | |
| 7 | Profiles: `core` profile → `default`; re-home read tools | **1.0** | Collision with package `core` |
| 8 | `outputSchema` on every read tool | **1.0** for new contract tools; rest in 1.x | |
| 9 | Annotation / tier fixes | **1.0** | Client gating depends on them |
| 10 | `exports` map | **1.0** | |
| 11 | **Stable insights output schema** (`views`, `viewers`, `follows`… with `source_metric` and `status: ok \| removed \| empty`) | **1.0** | Meta waves would otherwise break callers repeatedly |
| 12 | Typed results for Meta-side refusals (ads breakdown enablement, ASC/AAC writes, Reels 30/24 h, thread ownership) | 1.x | Additive error codes under the unified envelope |
| 13 | SDK v2, zod 4, spec 2026-07-28 dual-era, stateless HTTP, MRTR confirm, Node `>=24` | **2.0** | [v2/03](../v2/03-v2-scope.md) |
| 14 | Removal of every 1.x deprecation (aliases, `note`, CSV `fields`, old env names) | **2.0** | |
| 15 | Server `instructions`, schema/description diet (`all` < ~110 KB), `facebook://reference/*` resources, 2–3 prompts | 2.x | Additive |
| 16 | Module splits and ports (`PlanStore`, `JournalSink`, `UploadSessionStore`, `TokenStore`), narrow `core` barrel | 0.8–2.x | Internal; the splits are wave 0 |
| 17 | Durable upload sessions (4a) | 2.x | Internal + additive resume |
| 18 | Claude plugin packaging (server + skills) | 0.8 / 1.x | Only Anthropic directory path for a local server |
| 19 | Page Integrity read tool; Messenger reactions / `reply_to`; boost objective `PROFILE_AND_PAGE_ENGAGEMENT`; creative-feature opt-outs | 2.x | Additive |
| 20 | Tasks dual-path, MCP Apps plan preview, Skills over MCP | 2.x, gated on client support | Negotiated extensions with fallback |
| 21 | **Modern-only** (drop 2025-era clients) | **3.0** | V3-D9 decides the 2.x promise |
| 22 | **Remove `FB_CONFIRM_TOKEN`** (elicitation/MRTR or deny) | **3.0** | Users rely on it in clients without elicitation |
| 23 | **Remove 2.x shims** (legacy transport paths, SDK compat) | **3.0** | |
| 24 | **Node `>=26`** | **3.0** | Node 24 EOL 2028-04-30 |
| 25 | **SDK v3 / result-shape redesign / HTTP-over-stdio**, if published | **3.0** | Conditional |
| 26 | Monorepo with instagram-mcp (shared `meta-core`) | ambitious 3.0 | V3-D2; npm names and bins unchanged |
| 27 | Opt-in remote single-operator mode (OAuth facade, persistent `plan_id`) | ambitious 3.x | V3-D4 |

## 4. Lean vs ambitious 3.0

**Lean 3.0 (recommended default).** Items 21–25, and nothing else breaking. The tool names
are stable since 1.0. It is still local-first: stdio by default, loopback HTTP, no OAuth.
Effort is **M** on top of a finished 2.x.

**Ambitious 3.0 (only if V3-D1 passes).** Lean, plus item 26 (monorepo) and item 27 as opt-in
3.x. Effort is **XL**: the monorepo merge and the OAuth facade are each **L** on their own.

## 5. Never list (for 3.x)

- Hosted, multi-tenant OAuth service (2b). It needs App Review, support and a different risk
  profile, against 25+ funded hosted entrants and a likely Meta-owned end state.
- Instagram or Threads tools inside this server (D2 = B stands; Threads is a sibling or never).
- Multi-network scheduling. Agency multi-Page tenancy without demand evidence.
- Ads breadth beyond boost, duplicate and narrow edits (Meta Ads MCP has 91 tools).
- Telemetry of any kind.

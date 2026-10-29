# 00 — Current-state baseline (2026-10-29)

The shared fact base that every role review in this round starts from. Every number
below was measured on `main` at commit `2c8d8bd` ("feat(api): add the stable
insights schema (expand only)") on 2026-10-29. Where a review disagrees with this
baseline, the review must say so and give its evidence.

## 1. What the product is

`@ivanbaev/facebook-mcp` **0.8.0** (npm, released 2026-10-28) is a local-first
TypeScript MCP server for the Meta Graph API. One operator runs it with their own
Meta Business app and token, on their own Pages and ad accounts. It has no telemetry
and no hosted component.

| Area | What ships |
|---|---|
| Publishing | Text, link, photo, album, video, Reels, Stories; scheduling; edit/delete |
| Reading | Posts, comments, page profile, conversations |
| Insights | Page/post/video insights, reports, CSV/JSON exports, stable insights schema (expand-only, C05) |
| Moderation | Comment hide/delete/reply, Messenger send/attachments/reactions, labels, saved replies |
| Ads | Read, insights, status control, budget, targeting edit, duplicate, boost post, image upload, archive/delete |
| Operator tooling | `setup-token` CLI, `doctor`, kill switch, journal of writes, smoke harness |

The surface is **69 tools** (`manifest.json`), grouped in packages/profiles. Every
write goes through a plan-and-apply gate (`src/mcp/write-mode.ts`,
`src/mcp/confirm.ts`) with a confirm token and elicitation. User-generated content
comes back in a taint envelope (`src/mcp/taint.ts`).

The server is distributed as:

- an npm package with OIDC provenance;
- a `.mcpb` bundle;
- an MCP registry entry, `io.github.IvanBBaev/facebook-mcp`;
- a Claude plugin manifest (`.claude-plugin/`).

## 2. Architecture

The code has six layers, and the dependency direction is enforced by ESLint zones
(`eslint.config.js`):

```
core ← api ← mcp ← tools ← cli ← server
```

| Layer | Production LOC | Test LOC | Role |
|---|---:|---:|---|
| `core` | 9,310 | 12,773 | HTTP client, auth, settings, errors, redaction, log |
| `api` | 23,789 | 24,749 | Graph endpoint wrappers |
| `mcp` | 7,548 | 14,448 | Registry, define, write gate, confirm, taint, journal |
| `tools` | 14,229 | 20,935 | Tool definitions (tools-as-data) |
| `cli` | 1,751 | 0 * | `setup-token`, `doctor` subcommands |
| `server` | 1,714 | 0 * | Entry point, transports wiring |
| `testing` | 598 | 470 | Network fence, helpers |
| **Total** | **~58.9k** | **~73.6k** | Test-to-production ratio ≈ 1.25 |

\* `cli` and `server` have no colocated tests. The root `index.test.ts` and
`doctor.test.ts` cover them.

### Largest production files (lines)

| File | Lines | File | Lines |
|---|---:|---|---:|
| `api/insights.ts` | 1763 | `api/messaging.ts` | 1351 |
| `api/media-reels.ts` | 1732 | `core/http-upload.ts` | 1056 |
| `api/media-photos.ts` | 1678 | `api/ads-create.ts` | 1000 |
| `api/ads-read.ts` | 1667 | `mcp/write-mode.ts` | 974 |
| `api/media-video.ts` | 1657 | `core/settings.ts` | 969 |
| `core/http.ts` | 1623 | `core/types.ts` | 937 |
| `api/posts-write.ts` | 1619 | `tools/core.ts` | 893 |
| `api/comments.ts` | 1525 | `mcp/transport.ts` | 893 |
| `tools/messages.ts` | 1352 | `cli/setup-token/flow.ts` | 825 |

### Largest test files (lines)

| File | Lines |
|---|---:|
| `posts.test` | 4622 |
| `index.test` | 3619 |
| `http.test` | 3417 |
| `moderation.test` | 3373 |
| `doctor.test` | 3274 |
| `ads.test` | 2942 |

## 3. Quality gate (measured 2026-10-29)

| Check | Result |
|---|---|
| `npm run check` (typecheck, lint, format, build, tests) | Pass |
| Tests | **3241 / 3241 pass**, 0 skipped, about 8 s |
| Coverage, statements | **99.67 %** (gate 95) |
| Coverage, branches | **95.93 %** (gate 85) |
| Coverage, functions | **99.64 %** (gate 95) |
| Coverage, lines | **99.67 %** (gate 95) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| CI on `2c8d8bd` (ci, CodeQL) | Green |

Coverage is measured over `build/**/*.js` (see `.c8rc.json`).

### `npm outdated`

| Package | Current | Wanted | Latest | Note |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.1 | 1.32.2 | 1.32.2 | Patch bump |
| `dotenv` | 18.0.8 | 18.0.9 | 18.0.9 | Patch bump |
| `typescript-eslint` | 8.72.0 | 8.72.1 | 8.72.1 | Patch bump |
| `@types/node` | 22.20.5 | 22.20.5 | 26.6.6 | Pinned to the Node 22 floor until 2.0 |
| `typescript` | 5.9.3 | 5.9.3 | 7.0.2 | Major, not yet planned |

**What the gate does not cover:** the server has **never been verified against the
live Graph API**. Live gate L1–L8 and boost gate P1–P7 are still pending. The smoke
harness (`scripts/smoke/`) has only been rehearsed against the fake graph.

## 4. Delivery state against the v3 roadmap

| Wave | Content | State |
|---|---|---|
| A | 0.8.0 release | Merged, released 2026-10-28 |
| 0 | Structural splits X01–X07, I00, I01, six-layer map | Merged |
| 1 | C01–C06 contract expansions | **C05 merged** (`2c8d8bd`); C01–C04 and C06 open |
| 2 | L2.* lane adoption | Open |
| 3 | U30 live gate, owner tasks | Open |
| 4 | P01–P05, SDK v2 / spec 2026-07-28 platform | Open |
| 5 | A01–A10 agent-UX additions | Open |
| 6 | B01–B04 removals (3.0) | Open |

Items deferred from wave 0 (from `WORKLOG.md`):

- split `cli/setup-token/flow.ts`;
- adopt `api/upload-session.ts` in the media upload paths;
- add a guard for unfolded changelog fragments;
- decide lane ownership of `annotations/messages.ts`;
- remove the setup-token facade and its ESLint override;
- split the large test files.

Release plan (from `docs/analysis/v3/04`):

| Release | Content | Timing |
|---|---|---|
| 1.0 | Contract fixes | Jan 2027 |
| 2.0 | SDK v2 platform, Node ≥24 | Before 2027-04-30 |
| 2.x | Additive features | — |
| Lean 3.0 | Removals | Q4 2027 – Q1 2028, before 2028-04-30 |

Owner decisions:

- V3-D10 = 1.0: the stable insights schema ships in 1.0.
- V3-D11 = A: at most 4 parallel lanes, and the owner integrates.
- V3-D1 (adoption gate) is still open, along with others.

### Dated forcing functions

| Date | Event |
|---|---|
| 2026-11-20 | Meta Commercial / Self-Serve Ad Terms update |
| 2026-11-25 | Adoption checkpoint (V3-D1) |
| 2027-02-23 | `advantage_audience` must be explicit |
| 2027-03-30 | Next MCP spec revision |
| 2027-04-30 | Node 22 end of life |
| 2028-04-30 | Node 24 end of life |

## 5. Adoption and community (2026-10-29)

| Signal | Value |
|---|---|
| GitHub stars / forks | 2 / 2 |
| npm downloads | about 270 last week (release bump), 440 last month |
| External contributors | 1 (PR #41 merged, #40 closed) |
| Non-author issues | 0 |
| Open Dependabot PRs | #42 (actions group), #38 (eslint 10.9, superseded by ^10.13 on main), #37 (`@types/node` 26) |
| Listings and announcement (U-A2) | Not done |
| README / CHANGELOG size | 76 KB / 256 KB |

## 6. Baseline observations (input to the role reviews)

1. **The engineering gate is strong; the evidence it is right is weak.** Coverage is
   near 100 % and the architecture is lint-enforced, yet no tool has ever touched the
   real Graph API. Every fixture and fake encodes an assumption that has not been
   checked against Meta.
2. **Size is concentrated.** Seventeen production files exceed 950 lines, and the
   three media upload paths are separate implementations next to an unused
   `upload-session.ts`.
3. **Adoption is the bottleneck, not features.** 69 tools and about 130k LOC sit
   behind 2 stars and 0 external issues. The v3 roadmap is still mostly engineering
   work (contract, platform, removals).
4. **Data protection has never been reviewed.** Private Messenger content and visitor
   UGC flow to the operator's LLM provider and to local artefacts (journal, exports),
   and no review round has covered legal, privacy or platform-policy questions.
5. **Calendar pressure is real.** The 2026-11-20 ad-terms change, the 2027-02-23
   `advantage_audience` deadline and Node 22 EOL on 2027-04-30 all land before or
   inside the 1.0 → 2.0 window.

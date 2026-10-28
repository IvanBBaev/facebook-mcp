# 03 — Owner decisions (v3)

Each decision lists its options and a recommendation, plus the wave in
[doc 05](05-parallel-task-breakdown.md) that it blocks. A decision is taken by the owner only and
recorded here as **Decided YYYY-MM-DD: X**. No task that a decision blocks may be dispatched
before that decision is recorded.

| ID | Question | Blocks | Recommendation |
|---|---|---|---|
| V3-D1 | Adoption checkpoint outcome | ambitious variant; waves 5–6 scope | Re-measure 30 days after 0.8 + listings |
| V3-D2 | Shared core with instagram-mcp | B-tasks for the monorepo | No before 3.0; revisit at the gate |
| V3-D3 | Canonical write gate across sibling servers | none (docs only) | facebook-mcp's plan/apply is canonical |
| V3-D4 | Remote (HTTP + OAuth) mode | wave 5 A-tasks | Not before 3.x; opt-in single operator only |
| V3-D5 | Rename scope | wave 2 rename L-tasks | 3b: insights family + the v2 D5 set |
| V3-D6 | Durable work (uploads, plans) | A-tasks for ports and durable uploads | 4a: durable uploads only; Tasks later |
| V3-D7 | Threads | none | Never in this server |
| V3-D8 | Skills and prompts | A-tasks for resources/prompts | Prompts + plugin skills in 2.x |
| V3-D9 | Legacy-client support promise in 2.x | wave 6 | Support both eras for all of 2.x |
| V3-D10 | Stable insights schema: 1.0 or 3.0 | C05 and the insights lane | 1.0 |
| V3-D11 | Dispatch model | every wave from 0 | ≤ 4 parallel lanes, owner integrates — **Decided 2026-10-28: A** |

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

## V3-D2. Shared core with instagram-mcp

v2 D2 decided **B** (keep the sibling), and the 2026-10-28 doc update keeps it running
alongside. A `meta-mcp` monorepo with a shared `meta-core` would remove the duplication of HTTP,
auth, redaction and the write gate, but it makes a library API a contract.

**Recommendation:** no shared core before 3.0. Revisit only if V3-D1 passes **and** both
servers have non-author users. Until then, copy fixes across by hand and note them in both
CHANGELOGs.

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

## V3-D5. Rename scope

| Option | Meaning |
|---|---|
| 3a. None | Record every odd name as an exception |
| **3b. Insights family + v2 D5 set** | `get_*_insights` family, `get_ads_report_status`, `send_private_reply`, `set_comment_visibility`, `ad_set` spelling, `boost_post` arg; old names stay as deprecated aliases in 1.x and are removed in 2.0 |
| 3c. Full verb/noun scheme | Every tool name follows one grammar; ~25 aliases for a whole major |

**Recommendation: 3b.** Each rename is lane-local in wave 2 (the lane owns its tool file and
its annotation fragment). The alias mechanism itself is task C06.

## V3-D6. Durable work

| Option | Meaning |
|---|---|
| **4a. Durable uploads** | `UploadSessionStore` port with a file adapter; resumable video/reel uploads survive a restart |
| 4b. Tasks extension | Long uploads and report exports as MCP Tasks, with a synchronous fallback |
| 4c. Both | |

**Recommendation: 4a in 2.x; 4b only once Claude Code or another target client supports
Tasks.**

## V3-D7. Threads

**Recommendation: never in this server.** If wanted, it is a third sibling server.

## V3-D8. Skills and prompts

Claude Code consumes MCP prompts and plugin skills, but it does not render MCP Apps.

**Recommendation:** 2–3 prompts (weekly report, comment triage, publish-and-boost) and
`facebook://reference/*` resources in 2.x, plus the Claude plugin with the same skills. No Apps
UI.

## V3-D9. Legacy-client support promise

Once the 2.0 server speaks both eras, going modern-only breaks every client still on a
2025-era protocol version.

| Option | Meaning |
|---|---|
| **A. Both eras for all of 2.x** | Modern-only is the 3.0 headline |
| B. Modern-only in a 2.x minor | Breaks semver for legacy clients; only defensible if their share is near zero |

**Recommendation: A.** This decision makes "3.0 = removals" coherent.

## V3-D10. Stable insights schema timing

**Recommendation: 1.0.** Meta removes metric names across all versions without a version bump.
A server-owned schema (`views`, `viewers`, `engagements`, `follows`…, each with
`source_metric` and `status: ok | removed | empty`) absorbs that churn. Shipping it in 1.0
means later waves become a status change, not a breaking change. It is additive (new fields
alongside the raw `metrics`), so it does not have to wait for a major.

## V3-D11. Dispatch model

| Option | Meaning |
|---|---|
| **A. ≤ 4 parallel lanes; the owner integrates** | Merge order from doc 05; one wave at a time |
| B. Up to 8 lanes | Maximum parallelism; integration becomes the bottleneck |
| C. Serial | No coordination cost; slowest |

**Recommendation: A.** The integrator is the owner, or one session with the I-tasks only.

**Decided 2026-10-28: A.** Wave A (U-A1) approved the same day.

## Open v2 decisions carried over

| v2 ID | State on 2026-10-28 | v3 handling |
|---|---|---|
| D1 checkpoint | open | superseded by V3-D1 |
| D4 insights window | adopted de facto in PR #41's direction | confirm with the live gate before 1.0 |
| D5 renames | open | superseded by V3-D5 |
| D6 `outputSchema` on write previews | open | task C03 builds the envelope schema; recommendation unchanged (envelope only) |
| D7 PR #41 | closed 2026-10-28 | recorded as merged; its content landed in `c7ce5b8` |

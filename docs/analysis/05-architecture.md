# 05 — Architecture

The architecture ports the proven servicenow-mcp blueprint (same author,
production npm package) with Graph-API-specific internals. Where this document
says "as in servicenow-mcp", the pattern is described in
`docs/ai/research/servicenow-mcp-architecture.md`.

## Stack

- **TypeScript ESM**, target ES2023, module/moduleResolution NodeNext, `strict` +
  `noUncheckedIndexedAccess`. Node ≥ 22 (`.nvmrc` 22), `engine-strict`.
- **Runtime deps (3):** `@modelcontextprotocol/sdk` ^1.29, `zod` ^3, `dotenv`.
  SDK v2 migration deferred until GA (codemod path exists).
- **Tests:** `node:test` + `node:assert/strict` against built output; `c8`
  coverage gates; `fast-check` for property tests where useful.
- **Lint/format:** ESLint 9 flat config + typescript-eslint 8 (type-checked),
  `no-floating-promises: error`, prettier.
- Entry: `src/index.ts` → `build/`; ESM `bin/facebook-mcp.mjs` launcher with a
  Node version guard.

## Layering (lint-enforced)

```
src/
  index.ts        # bootstrap + CLI subcommands (doctor, setup-token later)
  core/           # L0: config, settings, auth + per-page token resolver
                  #     (auth.ts, pages-registry.ts), http client (http.ts) +
                  #     upload protocols (http-upload.ts), host allowlist,
                  #     errors, logging, value-based redaction choke-point
  api/            # L1: Graph API domain functions — pages.ts, shared.ts
                  #     (pagination), posts-read.ts, posts-write.ts,
                  #     media-photos.ts, media-video.ts, media-reels.ts,
                  #     comments.ts, insights.ts, messaging.ts, ads-read.ts,
                  #     ads-control.ts
  mcp/            # L2: define/registry/packages, result shaper, write-mode +
                  #     journal, transport, taint/confirm seams
  tools/          # L3: ToolSpec[] per package — data, not code
```

`core ← api ← mcp ← tools` enforced via ESLint `no-restricted-imports`; tools
never import `core/http` directly.

## Key decisions (Graph-API-specific deltas from servicenow-mcp)

1. **Env prefix `FB_` uniformly** from day one (`FB_ACCESS_TOKEN`,
   `FB_APP_SECRET`, `FB_PAGE_ID`, `FB_API_VERSION`, `FB_TRANSPORT`,
   `FB_TOOL_PACKAGES`, …). Env-first config: client-passed env beats the env
   file; XDG config path; atomic 0600 writes.
2. **HTTP client** (`core/http.ts` + `core/http-upload.ts`): single
   `fbRequest<T>()` entry covering **three wire protocols** (C7) so no media
   code bypasses the seam:
   - **JSON / query-string** GETs and simple writes.
   - **multipart `FormData`** for direct binary uploads (photos, small video).
   - **raw-binary rupload** for chunked resumable uploads: header-based auth
     (`Authorization: OAuth <token>` + `file_offset`), offset-resume on
     interruption, chunk POSTs bypass the generic retry matrix (resume by
     re-reading the server offset instead), per-request timeout + `AbortSignal`.
   - Hosts: fixed host allowlist (graph, graph-video, rupload) — no
     user-configurable hosts; unlike ServiceNow there is exactly one vendor.
   - **Auth:** send the token via `Authorization: Bearer <token>` — **never** in
     the query string (Graph echoes query params into `paging.next` URLs, a leak
     vector, C3), except the rupload header form above and the rare endpoint that
     forces a query param. Attach `appsecret_proof`. One auth mode; keep the
     interface thin enough to add OAuth later.
   - **Retry matrix (table-driven, tested):** Graph delivers throttle codes as
     **HTTP 400 body codes**, not HTTP 429 — match on the body `{code,
     error_subcode}`, not the status line. Throttle families 4 / 17 / 32 / 613
     plus range 80000–80099 back off honoring
     `estimated_time_to_regain_access`; 5xx and transient network faults retry
     on GET only; exponential backoff + jitter, cap 60 s.
   - **Ambiguous writes are never auto-retried (C2):** Graph has no idempotency
     keys, so a publish/send/delete whose request body reached the wire may have
     succeeded even if the response was lost. Such POSTs are never replayed; the
     error result says "unknown outcome — do NOT retry blindly; verify via
     `facebook_list_posts` / `facebook_get_conversation`". Error 506 (duplicate
     post) is surfaced, not retried. Optional in-process dedupe for messaging.
   - **Usage tracking:** parse `X-App-Usage` + `X-Business-Use-Case-Usage` (+
     `x-fb-ads-insights-throttle` on ads insights) defensively (headers may be
     absent/malformed) on every response; expose via a `facebook_usage`
     tool/resource; proactive soft-backoff at ≥90%.
   - Graph error envelope: `{error: {message, type, code, error_subcode,
     fbtrace_id}}` → `GraphApiError` through the shared error→action matrix; no
     `{result}` unwrap (that was ServiceNow-specific).
   - Per-host concurrency semaphore (default 4).
3. **Pagination** (`api/shared.ts`): cursor-based helper — single page by
   default, `fetchAll` up to a hard cap with a `truncated` flag; cursors never
   persisted; `paging.next` absence = end.
4. **Multi-page support without `AsyncLocalStorage` (C14)** — ALS is the wrong
   idiom for a request-scoped MCP server, and a Page is a path parameter, not a
   connection profile. Instead an **explicit `profile` tool argument**
   (auto-injected, optional, renamed from `page`) accepts a profile key or a raw
   Page ID and is resolved by a trivial `resolvePage(name?) → { pageId,
   tokenOverride? }` registry (`core/pages-registry.ts`); `api/` functions take
   an **explicit `pageId`** parameter — no ambient context. Default Page from
   `FB_PAGE_ID`; additional profiles via `FB_PROFILE_<NAME>_PAGE_ID` (+ optional
   token override); an ambiguous profile name is refused rather than guessed;
   descriptions carry omit-by-default guidance (single-Page users never see it).
   Ads equivalent: `FB_AD_ACCOUNT_ID`.
   - **Per-page token resolver (C1)** in `core/auth.ts`: derive the Page token
     from the user/system-user token → cache it → on error **190** invalidate
     and **re-derive once** → then fail with actionable guidance. The long-lived
     Page token stays a first-class fallback (not a footnote); the doctor
     verifies the resolved topology empirically via `debug_token` type
     detection.
5. **Tools-as-data**: `defineTool()` + `ToolSpec` with name, title, description,
   `package`, MCP annotations, zod `input` (every field `.describe()`d,
   `.strict()` at registration), optional `output` shape +
   `structuredContent`, `logFields`, handler. Naming: `facebook_<verb>_<noun>`.
6. **Package registry** with a PACKAGES manifest; `FB_TOOL_PACKAGES` selects
   package sets, with `FB_PACKAGES_DENY` / `FB_PACKAGES_READONLY` overrides.
   Packages: `core`, `reader`, `posts` (text/link/carousel + the
   media-photos/video/reels create tools converge here), `insights`,
   `moderation`, `messages`, `ads`. **Default expansion (C5)** — the single
   line the corpus previously left undefined: `FB_TOOL_PACKAGES` unset ⇒
   **`core + posts + reader + insights + moderation + messages`** (≈27 tools),
   with **`ads` excluded by default** (Meta ships an official ads MCP; see 02);
   `all` adds `ads`. The expansion table is documented in 06 and
   **snapshot-tested** so the surface can never drift silently. A read-only
   profile (`FB_PACKAGES_READONLY`, or a reader-only `FB_TOOL_PACKAGES`) is the
   recommended posture for unattended untrusted-content ingestion (see 04).
7. **Tiered plan-and-apply write gating** (`mcp/write-mode.ts` +
   `mcp/journal.ts`): every write tool takes `apply?: boolean`; without
   `apply:true` it returns a **validating dry-run preview** — resolves the Page
   name/ID, checks publish state and the permission×package matrix, runs local
   constraint checks, emits warnings and the before-state for update/delete, and
   ends with an explicit anti-hallucination line ("The post was NOT published").
   Plan mode performs **zero network mutations**, enforced by a generic
   all-tools sweep test.
   - **Blast-radius tiers (C4):** the `FB_WRITE_MODE=apply` env bypass covers
     only low-consequence writes; **irreversible (delete) and spend (ads) tiers
     are never env-bypassed** — they always require a per-call `apply:true`.
   - **`plan_id` binding:** the highest-consequence tools bind `apply` to a
     short-lived `plan_id` returned by the preview step.
   - **Divergence semantics:** apply **re-validates** before mutating; if state
     changed since the preview it **fails with a diff** rather than proceeding.
   - **Per-package write-mode defaults** avoid confirmation stacking (moderation
     may default to apply; publishing and ads never do).
   - Applied writes are recorded to a **journal**: structured metadata only,
     passed through the redactor (no tokens/PII), 0600 under the XDG state dir,
     non-blocking, rotated at ~5 MB. Out-of-band confirmation for
     destructive/spend tools (elicitation-ready, operator-token fallback) is a
     separate seam (see 04). Publishing to a real audience is the most
     consequential action this server performs — safe-by-default is
     non-negotiable.
8. **Result shaping** (`mcp/result.ts`): compact JSON by default;
   `FB_MAX_RESULT_CHARS` structure-aware truncation with a `truncated` flag;
   `structuredContent` **only for server-owned envelopes** (`whoami`, `usage`),
   never for passthrough Graph payloads. **Token-leak invariant (C3):** the
   shaper **recursively strips every `paging` object and token-bearing URL**
   (Graph embeds `access_token` in `paging.next`, including nested
   field-expansion paging) before anything leaves the process. This complements
   the **value-based redaction choke-point** in `core` (`redact.ts`): a single
   function scrubs raw secret *values* (EAA tokens, 32-hex app secret,
   `appsecret_proof`, `FB_HTTP_TOKEN`, `{app-id}|{app-secret}`) across logs,
   errors, results, and the journal; pattern-scan is defense-in-depth only.
9. **Media handling** — the single `api/media.ts` is split for ownership and
   testability into **`api/media-photos.ts`, `api/media-video.ts`,
   `api/media-reels.ts`** (all riding the `core/http-upload.ts` protocols).
   Uploads accept either a public URL (passed to Meta verbatim — Meta fetches
   it) or a local file path. **`FB_MEDIA_DIR` is disabled by default (C11):**
   unset ⇒ local file access is **off** (URL-only); when set, paths are confined
   by **realpath containment** (symlink-safe) and remote fetches follow **no
   cross-host redirects** (the earlier "no local SSRF" claim in 04 is reworded
   accordingly). Video/Reels use a chunked resumable upload state machine;
   **resumable-session state is in-memory** ("resume within one server
   lifetime") — durable state via MCP Tasks is deferred. Long uploads emit
   progress via a `progressToken`; video creates return a `video_id` +
   `processing` state polled by `facebook_get_video_status` (**roadmap — not
   shipped**: `getVideoStatus` exists in `src/api/media-video.ts` but no
   `ToolSpec` exposes it).
10. **Transport**: stdio default; `FB_TRANSPORT=http` → Streamable HTTP that
    **fails closed** — it refuses to start without `FB_HTTP_TOKEN`, binds
    `127.0.0.1` only, validates the `Origin` header (DNS-rebinding guard), and
    constant-time-checks the bearer on every request. No SSE.
11. **Testing strategy**: `withEnv`/`withFetch` helpers (recording fetch mock),
    fixtures with real Graph API response shapes, a **tools-manifest snapshot
    test** guarding the whole surface, readme/env-docs sync tests. Coverage
    ratchet set just below actuals once the suite exists.
12. **Docs/distribution**: generated README tool tables from the manifest;
    `server.json` for the MCP registry; `.claude-plugin/` manifests; MCPB bundle.

## What we do NOT port from servicenow-mcp

- The dark second-system scaffold (its Jira) — no speculative abstractions.
- `SN_`-style historical naming inconsistencies.
- OAuth PKCE login CLI (v1: manual token acquisition is documented instead).
- ServiceNow response envelope/`sysparm_*`/offset-pagination specifics.

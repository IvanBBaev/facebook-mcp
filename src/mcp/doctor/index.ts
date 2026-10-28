// `facebook doctor` diagnostic (task F16).
//
// A single pre-flight command that answers "will my token actually let these
// tools work?" without touching a real Page. It produces three things:
//
//   1. A TOKEN report — type / validity / granted scopes / credential + expiry,
//      including never-expiring detection (Graph `expires_at` 0 ⇒ undefined,
//      the System-User signature — doc 04) and an "expiring soon" flag.
//   2. A PERMISSION x PACKAGE matrix — cross-references the granted scopes
//      against the LOADED packages (injected via `deps.packages`, not a
//      hard-coded import, so the matrix auto-expands when the Wave-4 verticals
//      land). Each package is usable / partially-usable (which tools blocked) /
//      blocked (missing scope) / unknown (no mapping). Granted scopes no loaded
//      package needs are flagged as over-scope (doc 04: business_management is
//      setup-only and should not ride on a runtime token).
//   3. An optional METRIC PROBE — a seam the insights package (V02) plugs into.
//      Absent ⇒ a plain "unavailable" line; this module never imports insights,
//      which would violate the layer rules and couple the doctor to a vertical.
//   4. An INSIGHTS METRIC-SET PROBE (C6 / CC-INS-1) — asks the live API, name by
//      name, whether the metric set this server documents still exists. Meta
//      renames and retires Page-insights metrics constantly and the failure mode
//      is SILENT: a retired name makes Graph fail the whole call, and a name
//      that survives but has no data returns an empty series that reads exactly
//      like "your Page is dead". The probe separates the three cases so the
//      operator learns which of them they are in. Unlike (3) it needs no
//      injection: it speaks Graph's `/insights` edge directly through the
//      injected `fbRequest`, so it stays free of api-layer imports.
//
// Layer 2 (`mcp`): imports the frozen `core` contracts + `core.debugToken`, and
// receives everything else (packages, fbRequest, clock, ...) injected. No
// runtime Zod here (quarantined to `define.ts`). No `tools` import.
//
// Layout: this file is the public entry and only re-exports. `runner.ts`
// orchestrates a run; `types.ts` holds the report shapes and injected deps;
// `permissions.ts`, `credentials.ts`, `probes.ts`, `findings.ts` and
// `render.ts` are shared; each lane's probe lives in `<lane>.ts`
// (`insights.ts`, `ads.ts`).

export {
  EXPIRY_SOON_MS,
  activeCredential,
  bindPageToken,
  classifyAssetAccess,
} from './credentials.js';
export { doctorExitCode, summarizeDoctor } from './findings.js';
export {
  METRIC_PROBE_LIKES_FLOOR,
  METRIC_PROBE_MAX_WINDOW_DAYS,
  METRIC_PROBE_PERIOD,
  METRIC_PROBE_WINDOW_DAYS,
  PROBED_PAGE_METRICS,
} from './insights.js';
export { PACKAGE_PERMISSIONS, TOOL_PERMISSIONS } from './permissions.js';
export { renderDoctorReport } from './render.js';
export { runDoctor } from './runner.js';
export type * from './types.js';

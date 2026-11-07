# Request: C04 → integrator — SEC-05 and the SEC-04 export

C04 (settings collapse) ships the env aliases, the deprecation note and the
multiple-token warning. Two parts of its extended scope (SUMMARY §5 "C04 ext.")
need files C04 does not own, so they are handed over here.

## 1. SEC-05 — `FB_APP_SECRET` required unless explicitly waived

**Files:** `src/core/settings.ts` (C04, small), plus the test and smoke fallout
outside C04: `src/index.process.test.ts` (http SIGTERM, EADDRINUSE),
`src/index.confirm.test.ts`, `src/index.doctor.test.ts`,
`src/core/settings.test.ts` (the no-app-secret cases), `scripts/smoke/*` env and
the smoke-rehearsal harness, and `scripts/metadata.config.mjs` (new
`FB_ALLOW_NO_APPSECRET` stanza).

**Change.** Turn the `no-app-secret` startup warning into an error unless
`FB_ALLOW_NO_APPSECRET=1` is set; the waiver itself stays a warning so `doctor`
keeps showing it. Every fixture that starts the server without `FB_APP_SECRET`
must either add one or set the waiver.

**Reason.** C04 implemented this and it broke 9 tests across the index and smoke
suites, all in files outside its ownership. It was reverted from C04 rather than
editing them; it is a behaviour change (an install that starts today would
refuse to start) and belongs in a release with a migration note.

## 2. SEC-04 — export `adsSpendCeilingProblem` for L2.ads

**File:** `src/core/index.ts` (X07 barrel).

**Change.** Add `adsSpendCeilingProblem` (and optionally `SETTING_ALIASES` /
`SettingAlias`) to the explicit named exports from `./settings.js`. L2.ads then
calls it before every spend-tier write and in the doctor's ads section when the
ads package is loaded.

**Reason.** SD-4: spend-tier ads writes are refused without
`FB_ADS_BUDGET_CEILING`. C04 owns the settings contract; the barrel and the ads
tools are owned elsewhere.

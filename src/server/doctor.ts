// The `doctor` subcommand as the bootstrap wires it: the loaded-package
// narrowing, the package-selection fault, and the api-backed ad-account and
// insights-metric probes that `mcp/doctor.ts` must not import itself.

import {
  errorMessageOf,
  type PackageSpec,
  type PageResolver,
  type Redactor,
  type Settings,
  type StartupReport,
} from '../core/index.js';
import {
  createRegistry,
  doctorExitCode,
  renderDoctorReport,
  runDoctor,
  type AdAccountProbe,
  type DoctorDeps,
  type DoctorReport,
  type MetricProbe,
} from '../mcp/index.js';
import { normalizeAdAccountId, readAdAccount } from '../api/ads-read.js';
import { fetchInsights, PAGE_INSIGHTS_LIKES_FLOOR } from '../api/insights.js';
import { ignoredDoctorArgsNote, isStrictFlag } from './cli-args.js';

/**
 * Narrow the built package array to the packages the registry will actually
 * LOAD — the set the doctor documents as its input (`DoctorDeps.packages`) and
 * the set `ToolRegistry.packageNames` exists to name.
 *
 * The array `main` assembles is everything the bootstrap CAN build; selection
 * happens later, inside the registry. Handing the whole array to the doctor
 * makes it judge packages that are not running, and both directions are wrong:
 * `ads` is off by default, so a correctly provisioned default install reports
 * `ads: BLOCKED - missing ads_read, ads_management` and turns `doctor --strict`
 * red over a package nobody enabled; and in reverse, the over-scope check counts
 * the ads permissions as "needed", so an `ads_management` scope riding on a
 * runtime token that cannot use it is never flagged.
 *
 * A selection fault (an unknown `FB_TOOL_PACKAGES` name) is not the doctor's
 * failure to report: fall back to the full array so the report still comes out,
 * and leave the error to the startup path, which is where the operator is told
 * about it.
 */
export function loadedPackages(
  packages: readonly PackageSpec[],
  settings: Settings,
): readonly PackageSpec[] {
  let loaded: ReadonlySet<string>;
  try {
    loaded = new Set<string>(createRegistry(packages, settings).packageNames);
  } catch {
    return packages;
  }
  return packages.filter((pkg) => loaded.has(pkg.name));
}

/**
 * Why the configured package selection does not resolve, if it does not.
 *
 * {@link loadedPackages} deliberately swallows this — it has a report to
 * produce and no channel to complain through. But swallowing it everywhere left
 * the doctor, of all commands, silently judging an install against every package
 * when the truth is that the server will not start at all. This is the channel:
 * the bootstrap asks, and the doctor turns the answer into a `fail` finding.
 */
export function packageSelectionFault(
  packages: readonly PackageSpec[],
  settings: Settings,
  redactor: Redactor,
): string | undefined {
  try {
    createRegistry(packages, settings);
    return undefined;
  } catch (err) {
    return redactor.redactString(errorMessageOf(err));
  }
}

/**
 * The whole `doctor` subcommand, minus the two things only `main` can do: write
 * to stderr and exit the process.
 *
 * It exists as its own function because the narrowing below is the kind of
 * defect that cannot be caught where it is written. `loadedPackages` is unit
 * tested, but a test that calls it itself proves only that the helper works —
 * delete the call from the command and every such test still passes, while a
 * default install goes back to being judged on a package it never loads. The
 * seam has to sit where the report is actually produced for a test to be able
 * to hold the command to it.
 *
 * `startup` is the report `loadSettings()` produced for the environment the
 * doctor runs in. It is required, not optional, for the same reason the
 * package fault is computed here: the doctor runs BEFORE `assertStartupOk`,
 * so this is the only place a startup error — a server that will not start —
 * can still reach the verdict, and a caller that forgets it would get a green
 * report on an install that throws on the real start.
 *
 * Returns the rendered report and the exit code rather than performing either:
 * `process.exit` in a tested path would take the test runner with it.
 */
export async function runDoctorCommand(
  deps: DoctorDeps,
  args: readonly string[],
  startup: StartupReport,
): Promise<{
  readonly report: DoctorReport;
  readonly text: string;
  readonly exitCode: number;
}> {
  const fault = packageSelectionFault(deps.packages, deps.settings, deps.redactor);
  const report = await runDoctor({
    ...deps,
    packages: loadedPackages(deps.packages, deps.settings),
    ...(fault !== undefined ? { packageSelectionError: fault } : {}),
    startupProblems: startup.problems,
  });
  const ignored = ignoredDoctorArgsNote(args);
  const rendered = renderDoctorReport(report);
  return {
    report,
    text: ignored === undefined ? rendered : `${rendered}\n${ignored}`,
    exitCode: doctorExitCode(report.summary.verdict, isStrictFlag(args)),
  };
}

/**
 * Ad-account health probe for the doctor (CC-ADS-6). Lives here rather than in
 * `mcp/doctor.ts` for the same reason the metric probe does: the doctor stays
 * free of api-layer imports and the bootstrap does the wiring.
 *
 * A disabled or unsettled ad account fails every ads write with an error that
 * reads like a permission problem but cannot be fixed from the API — so the
 * doctor reports it up front instead of leaving it to the first write.
 */
export function adAccountProbe(): AdAccountProbe {
  return async ({ fbRequest, settings, signal }) => {
    const configured = settings.adAccountId;
    if (configured === undefined || configured.trim() === '') {
      return {
        available: false,
        summary:
          'ad account: not configured (set FB_AD_ACCOUNT_ID to the act_<id> of the account the ads tools should use).',
      };
    }
    const info = await readAdAccount(fbRequest, {
      accountId: normalizeAdAccountId(configured),
      ...(signal !== undefined ? { signal } : {}),
    });
    // `available: false` alone reads the same as "not configured" to the
    // doctor, so a configured account that cannot serve says so explicitly —
    // that is the one answer this probe exists to give (CC-ADS-6), and it has
    // to move the verdict.
    return {
      available: info.serving,
      ...(info.serving ? {} : { degraded: true }),
      summary: `ad account ${info.id}: ${info.summary}${
        info.moneySummary !== undefined ? ` ${info.moneySummary}` : ''
      }`,
      details: {
        statusLabel: info.statusLabel,
        ...(info.currency !== undefined ? { currency: info.currency } : {}),
        ...(info.spendCapMinor !== undefined
          ? { spendCapMinor: info.spendCapMinor }
          : {}),
        ...(info.amountSpentMinor !== undefined
          ? { amountSpentMinor: info.amountSpentMinor }
          : {}),
        ...(info.headroomMinor !== undefined
          ? { headroomMinor: info.headroomMinor }
          : {}),
        ...(info.disableReasonLabel !== undefined
          ? { disableReason: info.disableReasonLabel }
          : {}),
      },
    };
  };
}

/**
 * Metric names the probe asks for. Both are the post-2025-11 survivors, chosen
 * so the probe never trips the api layer's own deprecation table — a probe that
 * queried a dead name would report a tooling bug as a Page problem.
 */
const PROBE_METRICS: readonly string[] = ['page_media_view', 'page_follows'];

/**
 * Insights-metric probe for the doctor (V02). Lives here for the same reason as
 * {@link adAccountProbe}: `mcp/doctor.ts` must not import the api layer, so the
 * bootstrap does the wiring and the doctor only folds the verdict in.
 *
 * It answers the question the insights package fails on most confusingly. Graph
 * accepts the call, returns an empty series, and says nothing about why — and
 * the two causes are indistinguishable at the tool layer: a Page under Meta's
 * eligibility floor, or a token without `read_insights` plus the ANALYZE task.
 * Asking once at startup turns that silence into a line an operator can act on.
 */
export function metricProbe(pages: PageResolver): MetricProbe {
  return async ({ fbRequest, clock, signal }) => {
    const resolved = await pages.resolvePage();
    const result = await fetchInsights(fbRequest, {
      scope: 'page',
      objectId: resolved.pageId,
      metrics: PROBE_METRICS,
      // Totals only: the probe cares whether data exists at all, and a series
      // would drag back up to 250 rows nobody reads.
      aggregate: true,
      token: resolved.token,
      ...(signal !== undefined ? { signal } : {}),
      nowMs: clock.now(),
    });

    const empty = new Set(result.emptyMetrics);
    const unavailable = new Set(result.unavailableMetrics);
    const answered = result.queriedMetrics.filter(
      (metric) => !empty.has(metric) && !unavailable.has(metric),
    );
    const details = {
      pageId: resolved.pageId,
      queried: result.queriedMetrics,
      answered,
      empty: result.emptyMetrics,
      unavailable: result.unavailableMetrics,
    };

    if (answered.length > 0) {
      return {
        available: true,
        summary: `metric probe: Page ${resolved.pageId} answers insights (${answered.join(', ')}).`,
        details,
      };
    }
    // Both remaining answers are `degraded`, not silent: Graph answered, and
    // either way this install cannot read insights as pinned. The "no entry"
    // case is a version problem the operator fixes with FB_API_VERSION or a
    // server upgrade rather than from `.env` scopes — but it is still theirs to
    // act on, and the summary already says the Page is not at fault. `warn`
    // (not `unknown`) keeps the ladder honest: the probe DID complete; it is
    // a probe that threw that established nothing.
    if (unavailable.size === result.queriedMetrics.length) {
      return {
        available: false,
        degraded: true,
        summary: `metric probe: Graph returned no entry for ${result.queriedMetrics.join(', ')} on Page ${resolved.pageId} — those names are not valid for the pinned API version, so the probe cannot judge the Page. Ask facebook_page_insights for a name Meta still serves.`,
        details,
      };
    }
    // A mix — some names accepted with no data, the rest never mentioned —
    // must not be summarised as "accepted the metrics": the operator would read
    // a name the pinned version does not serve as one Graph took.
    const floor = `Usually the eligibility floor (a Page under ~${String(PAGE_INSIGHTS_LIKES_FLOOR)} followers returns empty insights), otherwise a token missing read_insights or the ANALYZE Page task.`;
    if (unavailable.size > 0) {
      return {
        available: false,
        degraded: true,
        summary: `metric probe: Page ${resolved.pageId} returned no data for ${result.emptyMetrics.join(', ')} and no entry for ${result.unavailableMetrics.join(', ')} (not valid for the pinned API version). ${floor}`,
        details,
      };
    }
    return {
      available: false,
      degraded: true,
      summary: `metric probe: Page ${resolved.pageId} accepted the metrics and returned no data. ${floor}`,
      details,
    };
  };
}

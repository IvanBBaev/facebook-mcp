// API-version drift signals (doc 12 H1, runbook app-upkeep §2).
//
// Meta tells a client that the version it pinned is not the version it got in
// two response headers, and both used to pass through this server unread:
//
//   * `X-Ad-Api-Version-Warning` — the Marketing API auto-upgraded a call made
//     on a deprecated version ("The call has been auto-upgraded to vXX.X as
//     vYY.Y has been deprecated"). The call worked, but on a version nobody
//     tested, and an endpoint that changed between the two is rejected with
//     `#2635` instead — so the warning is the last notice before ads tools
//     start failing.
//   * `facebook-api-version` — the version Graph actually served. Graph
//     answers a call on a version that is no longer usable with the next
//     oldest usable one, so a value different from the requested version
//     means the pin has already aged out on that API.
//
// Both are ADVISORY: the response is already answered and correct as far as
// the server can tell, so a drift signal is logged, never thrown. One warn is
// written per (header, value) per monitor — a production process builds one
// monitor and shares it across every transport (`createTransport`), so a
// warning repeated on every ads call is logged once rather than per request.

import type { ApiFamily, FbResponseHeaders, Logger, Redactor } from './types.js';

/** Canonical (lowercased) names of the version headers Meta sends. */
export const VERSION_HEADERS = {
  /** Marketing API auto-upgrade notice on a deprecated version. */
  adApiVersionWarning: 'x-ad-api-version-warning',
  /** The Graph API version that actually served the call. */
  servedApiVersion: 'facebook-api-version',
} as const;

/** The structured log message every drift warn is written under. */
export const VERSION_DRIFT_LOG_MSG = 'fbRequest.versionDrift';

/** What a drift signal says. */
export type VersionDriftKind = 'ad-api-version-warning' | 'served-version-mismatch';

/** One observed version-drift signal (values redacted). */
export interface VersionDriftSignal {
  readonly kind: VersionDriftKind;
  /** The lowercased header that carried it. */
  readonly header: string;
  /** The header value, redacted and clipped. */
  readonly value: string;
  /** The version the request was sent on. */
  readonly requestedVersion: string;
  /** Which pin the request used (`marketing` ⇒ `FB_ADS_API_VERSION`). */
  readonly api: ApiFamily;
}

/** Collects drift signals, logging each distinct one once. */
export interface VersionDriftMonitor {
  /**
   * Inspect one response's headers. Never throws: a monitor fault must not
   * fail a request the server has already answered.
   */
  observe(
    headers: FbResponseHeaders,
    requestedVersion: string,
    api: ApiFamily | undefined,
  ): void;
  /** Every distinct signal seen so far, in first-seen order. */
  signals(): readonly VersionDriftSignal[];
}

/** Longest header value kept; Meta's notice is one sentence. */
const MAX_VALUE_LENGTH = 300;

/** `v23.0` / `23.0` / ` V23 ` → `v23.0`; anything else is returned trimmed. */
function normalizeVersion(raw: string): string {
  const match = /^v?(\d+)(?:\.(\d+))?$/i.exec(raw.trim());
  if (match === null) return raw.trim();
  return `v${match[1] ?? ''}.${match[2] ?? '0'}`;
}

/**
 * The version an edge path forces, if it carries one (`/v24.0/act_1/ads`).
 * Mirrors the prefix test in `buildUrl`: such a path is sent as written, so the
 * pin does not apply to it.
 */
export function pathApiVersion(path: string): string | undefined {
  const pathname = path.startsWith('/') ? path : `/${path}`;
  const match = /^\/(v\d+(?:\.\d+)?)(?:\/|$)/.exec(pathname);
  return match?.[1];
}

/**
 * Pure detection over one response's headers. An absent header is no signal;
 * a `facebook-api-version` equal to the requested version (after normalizing
 * `v23` vs `v23.0`) is no signal either. Values are returned raw — the monitor
 * redacts them before anything is logged or kept.
 */
export function detectVersionDrift(
  headers: FbResponseHeaders,
  requestedVersion: string,
  api: ApiFamily | undefined,
): VersionDriftSignal[] {
  const family: ApiFamily = api ?? 'graph';
  const out: VersionDriftSignal[] = [];
  const warning = headers[VERSION_HEADERS.adApiVersionWarning];
  if (warning !== undefined && warning.trim() !== '') {
    out.push({
      kind: 'ad-api-version-warning',
      header: VERSION_HEADERS.adApiVersionWarning,
      value: warning.trim(),
      requestedVersion,
      api: family,
    });
  }
  const served = headers[VERSION_HEADERS.servedApiVersion];
  if (
    served !== undefined &&
    served.trim() !== '' &&
    normalizeVersion(served) !== normalizeVersion(requestedVersion)
  ) {
    out.push({
      kind: 'served-version-mismatch',
      header: VERSION_HEADERS.servedApiVersion,
      value: served.trim(),
      requestedVersion,
      api: family,
    });
  }
  return out;
}

/** What each kind means for the operator, in one sentence. */
function adviceFor(signal: VersionDriftSignal): string {
  if (signal.kind === 'ad-api-version-warning') {
    return `Meta auto-upgraded a Marketing API call made on ${signal.requestedVersion}: that version is deprecated, and endpoints that changed will fail with #2635. Bump the ads pin, or set FB_ADS_API_VERSION to a supported version (see docs/runbooks/app-upkeep.md §2).`;
  }
  const knob = signal.api === 'marketing' ? 'FB_ADS_API_VERSION' : 'FB_API_VERSION';
  return `Graph served ${signal.value} for a call made on ${signal.requestedVersion}: the requested version is no longer usable and Meta substituted another. Move the pin (${knob}; see docs/runbooks/app-upkeep.md §2).`;
}

/**
 * Create a {@link VersionDriftMonitor}. Each distinct (header, value) is logged
 * once as a structured warn under {@link VERSION_DRIFT_LOG_MSG}, with the value
 * passed through the redactor first (C3) — a header is server-controlled text,
 * and nothing server-controlled reaches a log unredacted.
 */
export function createVersionDriftMonitor(deps: {
  readonly logger: Logger;
  readonly redactor: Redactor;
}): VersionDriftMonitor {
  const seen = new Map<string, VersionDriftSignal>();
  return {
    observe(headers, requestedVersion, api) {
      try {
        for (const raw of detectVersionDrift(headers, requestedVersion, api)) {
          const key = `${raw.header}\u0000${raw.value}`;
          if (seen.has(key)) continue;
          const signal: VersionDriftSignal = {
            ...raw,
            value: deps.redactor.redactString(raw.value).slice(0, MAX_VALUE_LENGTH),
          };
          seen.set(key, signal);
          deps.logger.warn(VERSION_DRIFT_LOG_MSG, {
            kind: signal.kind,
            header: signal.header,
            value: signal.value,
            requestedVersion: signal.requestedVersion,
            api: signal.api,
            advice: adviceFor(signal),
          });
        }
      } catch {
        // Advisory only: a logger or redactor fault must never fail the call.
      }
    },
    signals: () => [...seen.values()],
  };
}

/** One operator line for a signal (doctor report, smoke output). */
export function describeVersionDrift(signal: VersionDriftSignal): string {
  return `${signal.header}: "${signal.value}" (requested ${signal.requestedVersion}, ${signal.api === 'marketing' ? 'Marketing API' : 'Graph API'}) — ${adviceFor(signal)}`;
}

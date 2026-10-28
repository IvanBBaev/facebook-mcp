#!/usr/bin/env node
// record-fixture.mjs — record a REAL Graph API response as a REDACTED fixture (F03).
//
// Purpose
//   Capture one live Graph API response and save it as a redacted JSON fixture
//   under `test/fixtures/`, so the hermetic unit tests can be written against
//   response shapes Meta actually returns rather than shapes we imagined.
//
// Status
//   LIVE. This script performs REAL network I/O against the REAL Graph API with
//   REAL credentials. It therefore refuses to run unless `FB_RECORD_FIXTURE=1`
//   is set deliberately — the same discipline the live smoke harness applies
//   with `FB_SMOKE=1` (doc 08, C13). CI never sets it and never holds a token.
//   Reads only: the recorder issues GET requests and nothing else, so it can
//   never create, edit or delete anything on a Page. Recording a write response
//   is the smoke harness's job (`scripts/smoke/`), which has a sweeper to clean
//   up after itself; this script does not.
//
// Usage
//   FB_RECORD_FIXTURE=1 node scripts/record-fixture.mjs \
//     --endpoint "me?fields=id,name" --out graph-me.json
//
//   --endpoint   Graph edge path to fetch, with an optional query string, e.g.
//                "me?fields=id,name" or "{page-id}/feed?limit=5" (required).
//                Must be a RELATIVE edge path — an absolute URL is refused.
//   --out        Fixture file name written under test/fixtures/, e.g.
//                "graph-me.json" (required). A bare file name: no directory
//                separators, no traversal, and it must end in .json.
//   --method     HTTP method. GET only; any other value is refused (see Status).
//   --force      Overwrite an existing fixture. Without it an existing file is
//                left alone and the run refuses — re-recording over a fixture
//                other tests depend on has to be a deliberate act.
//   --ads        Record the ads (Marketing API) READ set instead of one
//                endpoint — see "Ads mode" below. Mutually exclusive with
//                --endpoint / --out.
//   --help       Show usage and exit 0. Needs no gate and no credential.
//
// Ads mode (--ads)
//   FB_RECORD_FIXTURE=1 node scripts/record-fixture.mjs --ads [--force]
//
//   Records the read edges the `ads` package uses, on the MARKETING API pin
//   (`FB_ADS_API_VERSION` / `DEFAULT_ADS_API_VERSION`, requests tagged
//   `api: 'marketing'`), into `test/fixtures/ads/<ads-version>/`:
//     ads-account.json     GET act_<id>?fields=<AD_ACCOUNT_FIELDS>
//     ads-campaigns.json   GET act_<id>/campaigns  (listing field set)
//     ads-adsets.json      GET act_<id>/adsets     (listing field set)
//     ads-ads.json         GET act_<id>/ads        (listing field set)
//     ads-campaign.json    GET <first campaign id> (detail field set)
//     ads-adset.json       GET <first ad set id>   (detail field set)
//     ads-ad.json          GET <first ad id>       (detail field set)
//     ads-insights.json    GET act_<id>/insights   (sync, default fields)
//   The field sets are imported from the compiled `build/api/ads-read.js`, so a
//   recording asks for exactly what the tools ask for. A detail read whose
//   listing came back empty is skipped (and said so), not faked. The async
//   report start (`POST /<id>/insights`) is NOT recorded: it is a POST, and the
//   recorder never issues anything but GETs.
//
//   The ad account is `FB_AD_ACCOUNT_ID` (env or env file, the same setting the
//   ads tools default to). When it is unset the run SKIPS cleanly: exit 0,
//   nothing fetched, nothing written. One directory per ads pin means a pin bump
//   is `--baseline test/fixtures/ads/<old> --candidate test/fixtures/ads/<new>`
//   for `scripts/fixture-shape-diff.mjs`, with no snapshot copy needed.
//
//   Ad data is business data, so on top of the secret redaction every fixture
//   gets, ads recordings are ANONYMISED before the lint and before the disk
//   (`createAdsAnonymizer`): ids become stable fake ids (the same real id maps
//   to the same fake one across every file, so the parent chain still lines
//   up), `name` values become placeholders, numeric strings (budgets, spend,
//   metrics) become fixed placeholders, and paging cursors / URLs are replaced.
//   JSON types are preserved exactly, which is all the shape-diff looks at.
//
// How it reaches Graph
//   By importing the COMPILED client from `build/` (`build/core/index.js`) and
//   calling the very same `createFbRequest` the server uses — the same import
//   convention `scripts/gen-metadata.mjs` uses for the compiled tool registry.
//   The alternative, a self-contained `fetch` in this file, would fork four
//   things that must not fork: the host allowlist (CC-NET-7), the pinned API
//   version (`FB_API_VERSION` / `DEFAULT_API_VERSION`), the Bearer-header-only
//   token placement plus `appsecret_proof` (C3), and the error/retry matrix. A
//   fixture recorded through a second, subtly different client would be a
//   fixture of code we do not ship. The cost is that a build is required, so
//   this script says so plainly instead of failing with ERR_MODULE_NOT_FOUND.
//
// Credentials
//   Environment only — `FB_SYSTEM_TOKEN`, `FB_ACCESS_TOKEN` or `FB_PAGE_TOKEN`,
//   resolved through the server's own `loadSettings` (so the operator's env file
//   counts too). There is deliberately no `--token` flag: a token on a command
//   line is visible to every process on the box via `ps` and is persisted into
//   shell history (see the warning in `src/cli/setup-token/`).
//
// Safety
//   Every recording is passed through `redactSecrets` before being written:
//   value-based scrubbing first (the exact configured token / app secret /
//   appsecret_proof, via the core `Redactor` — the repo's PRIMARY strategy, C3),
//   then a pattern pass for secret SHAPES we do not hold. `access_token` fields
//   are blanked outright. The result is then run through the committed
//   fixture-lint (`src/testing/fixtures.ts`) BEFORE anything touches the disk,
//   so a recording that would fail the test suite is never written at all.
//   Even so, ALWAYS eyeball the output before committing — redaction cannot know
//   that a post message or a Page name is something you did not mean to publish.
//
// Exit status (mirrors the smoke harness)
//   0  the fixture was recorded and written
//   1  the recording failed (Graph error, network fault, unwritable path)
//   2  refused to run — gate off, no credential, no build, bad arguments, or the
//      target fixture already exists. Nothing was written.

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = new URL('../test/fixtures/', import.meta.url);

/** Documented exit statuses (see the header). */
export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });

/**
 * The gate variable. Anything other than exactly "1" means "do not run" — the
 * same deliberately non-truthy check the smoke harness uses for `FB_SMOKE`.
 */
export const RECORD_GATE_VAR = 'FB_RECORD_FIXTURE';

/** Thrown for expected, operator-actionable failures: reported without a stack. */
export class RecordError extends Error {
  name = 'RecordError';

  constructor(message, exitCode = EXIT.refused) {
    super(message);
    this.exitCode = exitCode;
  }
}

const USAGE = `facebook-mcp Graph fixture recorder

  ${RECORD_GATE_VAR}=1 node scripts/record-fixture.mjs --endpoint <path> --out <name.json>
  ${RECORD_GATE_VAR}=1 node scripts/record-fixture.mjs --ads [--force]

Options
  --endpoint <path>   Graph edge path with an optional query string, e.g.
                      "me?fields=id,name" or "{page-id}/feed?limit=5". Relative
                      only — an absolute URL is refused.
  --out <name.json>   Fixture file name under test/fixtures/. Bare name, .json.
  --method <verb>     GET only (the default). Writes belong in the smoke harness.
  --ads               Record the ads (Marketing API) read set on the ads pin
                      into test/fixtures/ads/<ads-version>/ (needs
                      FB_AD_ACCOUNT_ID; skips cleanly without it). Not with
                      --endpoint / --out.
  --force             Overwrite an existing fixture instead of refusing.
  --help              Show this text and exit 0 (no gate, no credential needed).

Environment
  ${RECORD_GATE_VAR}=1   required — the recorder refuses without it
  FB_SYSTEM_TOKEN     preferred credential (or FB_ACCESS_TOKEN / FB_PAGE_TOKEN)
  FB_APP_SECRET       optional; when set, appsecret_proof is attached
  FB_API_VERSION      optional; defaults to the version pinned in settings.ts
  FB_AD_ACCOUNT_ID    --ads only; the ad account to record (act_<id> or digits)
  FB_ADS_API_VERSION  --ads only; defaults to the ads pin in settings.ts

Requires a build (\`npm run build\`): the recorder drives the same compiled Graph
client the server ships, never a second copy of the wire rules.
`;

/** The message shown when the gate is off — it must say exactly what to do. */
export function gateRefusalMessage() {
  return (
    `${RECORD_GATE_VAR} is not set to "1", so the fixture recorder refused to run.\n` +
    'This script talks to the real Graph API with real credentials. Nothing was\n' +
    'executed, no network call was made and no file was written. To record\n' +
    `deliberately:  ${RECORD_GATE_VAR}=1 node scripts/record-fixture.mjs --endpoint ` +
    '<path> --out <name.json>   (or --ads for the ads read set)'
  );
}

/** True only for `FB_RECORD_FIXTURE=1`. Deliberately not "truthy". */
export function gateEnabled(env = process.env) {
  return env[RECORD_GATE_VAR] === '1';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Bare `.json` file name: no directory separators, no traversal, no dotfile. */
const OUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/** Parse `--endpoint`, `--out`, `--method`, `--force`, `--help`. */
export function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        endpoint: { type: 'string' },
        out: { type: 'string' },
        method: { type: 'string', default: 'GET' },
        force: { type: 'boolean', default: false },
        ads: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new RecordError(
      `${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`,
    );
  }

  if (values.help) {
    return { help: true, ads: false, force: false, method: 'GET' };
  }

  const method = values.method.toUpperCase();
  if (method !== 'GET') {
    throw new RecordError(
      `--method ${method} is refused: the recorder only ever issues GETs, so it ` +
        'cannot mutate a Page. Recording a write response is the live smoke ' +
        "harness's job (scripts/smoke/), which sweeps up what it creates.",
    );
  }

  if (values.ads) {
    if (values.endpoint !== undefined || values.out !== undefined) {
      throw new RecordError(
        '--ads records a fixed set of ads read edges into ' +
          'test/fixtures/ads/<ads-version>/; it cannot be combined with ' +
          '--endpoint / --out.',
      );
    }
    return { help: false, ads: true, method, force: values.force };
  }

  if (!values.endpoint || !values.out) {
    throw new RecordError(
      'usage: record-fixture.mjs --endpoint <graph-path> --out <name.json> ' +
        '[--method GET] [--force]   (or: --ads [--force])',
    );
  }
  if (!values.out.endsWith('.json')) {
    throw new RecordError(`--out must end in .json (got "${values.out}")`);
  }
  if (!OUT_NAME_RE.test(values.out)) {
    throw new RecordError(
      `--out must be a bare file name written under test/fixtures/, not a path ` +
        `(got "${values.out}")`,
    );
  }

  return {
    help: false,
    ads: false,
    endpoint: values.endpoint,
    out: values.out,
    method,
    force: values.force,
  };
}

/**
 * Split `me?fields=id,name` into the edge path and its query params.
 *
 * The query string cannot ride along inside `path`: the client assigns it to
 * `URL.pathname`, which percent-encodes `?` into `%3F` and would request a
 * literally-named edge. Params therefore have to be handed over separately.
 * An absolute URL is refused here as well as in the client — the recorder should
 * say "relative edge path" rather than let a confusing error come back from two
 * layers down.
 */
export function parseEndpoint(endpoint) {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) {
    throw new RecordError('--endpoint is empty');
  }
  if (trimmed.includes('://') || trimmed.startsWith('//')) {
    throw new RecordError(
      `--endpoint must be a relative Graph edge path, not an absolute URL ` +
        `(got "${trimmed}"). The host comes from the client's fixed allowlist.`,
    );
  }

  const queryStart = trimmed.indexOf('?');
  const path = queryStart === -1 ? trimmed : trimmed.slice(0, queryStart);
  const params = {};
  if (queryStart !== -1) {
    for (const [key, value] of new URLSearchParams(trimmed.slice(queryStart + 1))) {
      params[key] = value;
    }
  }

  if (path.length === 0) {
    throw new RecordError(`--endpoint has no edge path (got "${trimmed}")`);
  }
  // A token in the URL is exactly the leak the Bearer-header rule exists to
  // prevent (C3); refuse rather than quietly forward it into the query string.
  if ('access_token' in params) {
    throw new RecordError(
      'refusing an access_token in --endpoint: the client sends the token as an ' +
        'Authorization header, never as a query param, because Graph echoes query ' +
        'params back in paging URLs. Configure the token in the environment.',
    );
  }

  return { path, params };
}

// ---------------------------------------------------------------------------
// Redaction (value-based first, then shapes — mirrors core/redact.ts, C3)
// ---------------------------------------------------------------------------

// Applied in this order so a composite form collapses to one placeholder before
// any of its sub-parts could match on its own.
//   1. `{app-id}|{app-secret}` app-access-token pipe form,
//   2. `EAA…` access tokens — `_` and `-` are in the character class (the
//      base64url alphabet) so a token containing a separator is masked whole
//      rather than leaving a live tail behind the first `-`,
//   3. 64-hex appsecret_proof, 4. 32-hex app secret. The hex lookarounds keep
//      the two mutually exclusive (a 64-run is never reported as a 32-run).
// Each pattern is at least as strict as the matching rule in the committed
// fixture-lint (src/testing/fixtures.ts), which is the backstop for this file.
const APP_ACCESS_TOKEN_PIPE = /\d{6,}\|[A-Za-z0-9_-]{10,}/g;
const EAA_TOKEN = /EAA[A-Za-z0-9_-]{16,}/g;
const HEX_64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const HEX_32 = /(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/g;

/**
 * Replace secret-shaped strings with visible placeholders (pattern pass).
 * Every placeholder is deliberately chosen so it does not itself match any lint
 * rule: `EAA_REDACTED_…` has a `_` right after `EAA`, and `APP_ID|…` has no
 * digits before the pipe.
 */
export function redactString(value) {
  return value
    .replace(APP_ACCESS_TOKEN_PIPE, 'APP_ID|REDACTED_APP_SECRET')
    .replace(EAA_TOKEN, 'EAA_REDACTED_ACCESS_TOKEN')
    .replace(HEX_64, 'REDACTED_APPSECRET_PROOF_64HEX')
    .replace(HEX_32, 'REDACTED_APP_SECRET_32HEX');
}

/**
 * Recursively redact a parsed JSON value: rewrite secret-shaped strings and
 * blank out any `access_token` field. Returns a NEW value; the input is never
 * mutated.
 *
 * `scrub` defaults to the pattern pass above and is overridden at runtime with
 * "core Redactor first, patterns second", so the exact configured secret VALUES
 * are removed by identity (no false negatives) before shape matching is asked
 * to guess.
 *
 * An `access_token` field becomes the EMPTY string, not a placeholder: the
 * fixture-lint fires on any NON-EMPTY string under that key, so a friendly
 * `"REDACTED_ACCESS_TOKEN"` marker would fail the suite it is meant to survive.
 */
export function redactSecrets(value, scrub = redactString) {
  if (typeof value === 'string') {
    return scrub(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, scrub));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[scrub(key)] =
        key === 'access_token' && typeof val === 'string'
          ? ''
          : redactSecrets(val, scrub);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The compiled client (single source of truth for the wire rules)
// ---------------------------------------------------------------------------

const buildPath = (...parts) => join(REPO_ROOT, 'build', ...parts);

/** Import one compiled module, with an actionable message when the build is absent. */
async function importBuilt(...parts) {
  const entry = buildPath(...parts);
  if (!existsSync(entry)) {
    throw new RecordError(
      `build/${parts.join('/')} is missing — run \`npm run build\` first. The ` +
        'recorder drives the SAME compiled Graph client the server ships (host ' +
        'allowlist, pinned API version, appsecret_proof, retry matrix), so it ' +
        'cannot run against source alone.',
    );
  }
  return import(pathToFileURL(entry).href);
}

/** System clock: real time + an abortable sleep (mirrors the server bootstrap). */
const systemClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((res, rej) => {
      if (signal?.aborted) {
        rej(new Error('aborted'));
        return;
      }
      const timer = setTimeout(res, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          rej(new Error('aborted'));
        },
        { once: true },
      );
    }),
};

/** The exact secret VALUES this process holds, for value-based scrubbing (C3). */
function collectSecrets(settings) {
  const secrets = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) secrets.push(value);
  };
  push(settings.accessToken);
  push(settings.systemToken);
  push(settings.pageToken);
  push(settings.appSecret);
  push(settings.httpToken);
  push(settings.confirmToken);
  if (settings.appId !== undefined && settings.appSecret !== undefined) {
    push(`${settings.appId}|${settings.appSecret}`);
  }
  for (const profile of Object.values(settings.profiles ?? {})) {
    push(profile.tokenOverride);
  }
  return secrets;
}

/**
 * Fetch a real Graph API response through the compiled `fbRequest` client and
 * return `{ data, scrub }` — the parsed body plus the composed scrubbing
 * function that knows this run's real secret values.
 */
export async function recordEndpoint(options) {
  const { fbRequest, scrub } = await createRecorderClient();

  const { path, params } = parseEndpoint(options.endpoint);
  const response = await fbRequest({
    protocol: 'json',
    host: 'graph',
    method: 'GET',
    path,
    params,
  });

  return { data: response.data, status: response.status, scrub };
}

/** Read the server's settings (env + env file) through the compiled core. No I/O beyond that. */
async function loadRecorderSettings() {
  const core = await importBuilt('core', 'index.js');
  const { settings, report } = core.loadSettings();
  return { core, settings, report };
}

/**
 * Build the recording client from the compiled core: settings (env + env file),
 * the value-based redactor, and the very `fbRequest` the server uses. Returns
 * `{ settings, fbRequest, scrub }`, where `scrub` is the composed "exact known
 * secrets first, secret shapes second" string scrubber. `loaded` lets a caller
 * that already read the settings (ads mode checks its account first) reuse them.
 */
async function createRecorderClient(loaded) {
  const { core, settings, report } = loaded ?? (await loadRecorderSettings());

  const token = settings.systemToken ?? settings.accessToken ?? settings.pageToken;
  if (token === undefined || token.length === 0) {
    throw new RecordError(
      'no access token configured. Set FB_SYSTEM_TOKEN (preferred), ' +
        'FB_ACCESS_TOKEN or FB_PAGE_TOKEN in the environment (or the env file). ' +
        'There is deliberately no --token flag: a token on a command line is ' +
        'visible via `ps` and is written to your shell history.',
    );
  }
  if (!report.ok) {
    throw new RecordError(
      `the configuration is not usable:\n${core.formatStartupReport(report)}`,
    );
  }

  const redactor = core.createRedactor({ secrets: collectSecrets(settings) });
  const logger = core.createLogger({
    clock: systemClock,
    redactor,
    level: settings.logLevel,
  });
  const fbRequest = core.createFbRequest({
    settings,
    clock: systemClock,
    redactor,
    logger,
  });

  // Value-based scrubbing first (exact known secrets), pattern pass second.
  const scrub = (text) => redactString(redactor.redactString(text));
  return { settings, fbRequest, scrub };
}

// ---------------------------------------------------------------------------
// Ads mode (--ads): the Marketing API read set, on the ads pin
// ---------------------------------------------------------------------------

/** Subdirectory of test/fixtures/ that holds one directory per ads pin. */
export const ADS_FIXTURES_SUBDIR = 'ads';

/** The setting the ads package defaults its ad account from. */
export const ADS_ACCOUNT_VAR = 'FB_AD_ACCOUNT_ID';

/** The listing levels, in recording order, with their edge and fixture names. */
export const ADS_LEVELS = Object.freeze([
  Object.freeze({
    level: 'campaign',
    edge: 'campaigns',
    listOut: 'ads-campaigns.json',
    detailOut: 'ads-campaign.json',
  }),
  Object.freeze({
    level: 'adset',
    edge: 'adsets',
    listOut: 'ads-adsets.json',
    detailOut: 'ads-adset.json',
  }),
  Object.freeze({
    level: 'ad',
    edge: 'ads',
    listOut: 'ads-ads.json',
    detailOut: 'ads-ad.json',
  }),
]);

/** Every file an ads run can write, so an overwrite is refused BEFORE any call. */
export const ADS_FIXTURE_FILES = Object.freeze([
  'ads-account.json',
  ...ADS_LEVELS.flatMap((l) => [l.listOut, l.detailOut]),
  'ads-insights.json',
]);

/** Page size for the recorded listings: enough to see variety, cheap on the score. */
export const ADS_LISTING_LIMIT = 5;

/** Window for the recorded sync insights read. */
export const ADS_INSIGHTS_DATE_PRESET = 'last_30d';

/** The line printed when no ad account is configured and the run skips. */
export function adsSkipMessage() {
  return (
    `${ADS_ACCOUNT_VAR} is not set, so the ads recording was skipped: no network ` +
    'call was made and no file was written. Set it (act_<id> or the bare digits, ' +
    'in the environment or the env file) to an ad account the token can read, ' +
    'then run --ads again.'
  );
}

/**
 * Resolve the configured ad account to `act_<digits>`. Returns `null` when none
 * is configured (the run skips); throws a refusal for a malformed value, so a
 * typo is reported before anything is spent on the account's rate-limit score.
 * The refusal never echoes the value.
 */
export function resolveAdsAccount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const trimmed = String(raw).trim();
  if (!/^(?:act_)?\d+$/.test(trimmed)) {
    throw new RecordError(
      `${ADS_ACCOUNT_VAR} must be act_<digits> or the bare digits ` +
        `(got a ${String(trimmed.length)}-character value that is neither)`,
    );
  }
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`;
}

/**
 * Directory (relative to test/fixtures/) for one ads pin. The version is
 * validated as `vNN.N` because it becomes a path segment.
 */
export function adsFixtureDir(version) {
  if (typeof version !== 'string' || !/^v\d+\.\d+$/.test(version)) {
    throw new RecordError(
      'the ads API version must look like v26.0 to name a fixture directory ' +
        `(got "${String(version)}")`,
    );
  }
  return `${ADS_FIXTURES_SUBDIR}/${version}/`;
}

/**
 * The account-level GETs of an ads run (the per-object detail reads depend on
 * what the listings return and are planned by {@link planAdsObjectRead}).
 * `fields` is the compiled `build/api/ads-read.js` module (or a stand-in in
 * tests), so a recording asks for exactly the field sets the tools ask for.
 * Every request is a GET tagged `api: 'marketing'`, so the client versions it
 * by the ads pin, never by the Graph pin.
 */
export function planAdsRecordings(accountId, fields) {
  const get = (out, path, params) =>
    Object.freeze({ out, method: 'GET', api: 'marketing', path, params });
  return [
    get('ads-account.json', `/${accountId}`, { fields: fields.AD_ACCOUNT_FIELDS }),
    ...ADS_LEVELS.map((l) =>
      get(l.listOut, `/${accountId}/${l.edge}`, {
        fields: fields.withPinnedAdFields(fields.AD_LEVEL_LIST_FIELDS[l.level]),
        limit: ADS_LISTING_LIMIT,
      }),
    ),
    get('ads-insights.json', `/${accountId}/insights`, {
      fields: fields.ADS_INSIGHTS_DEFAULT_FIELDS,
      date_preset: ADS_INSIGHTS_DATE_PRESET,
    }),
  ];
}

/**
 * The single-object read for one level, keyed off the first record of that
 * level's (raw, not yet anonymised) listing. Returns `null` when the listing is
 * empty or its first record carries no usable id — the detail fixture is then
 * skipped, never invented.
 */
export function planAdsObjectRead(levelSpec, listingBody, fields) {
  const first = Array.isArray(listingBody?.data) ? listingBody.data[0] : undefined;
  const id = first?.id;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) return null;
  return Object.freeze({
    out: levelSpec.detailOut,
    method: 'GET',
    api: 'marketing',
    path: `/${id}`,
    params: {
      fields: fields.withPinnedAdFields(fields.AD_LEVEL_DETAIL_FIELDS[levelSpec.level]),
    },
  });
}

/** Object keys whose value is an id: `id`, `account_id`, `campaign_id`, … */
const ADS_ID_KEY = /^(?:id|[a-z0-9]+(?:_[a-z0-9]+)*_id)$/;
/** An id-looking string: bare digits or the `act_` form. */
const ADS_ID_VALUE = /^(act_)?(\d+)$/;
/** A numeric string: budgets, spend, metrics, action values. */
const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;
/** A digit run long enough to be an id embedded in some other string. */
const EMBEDDED_ID = /\d{6,}/g;
/** Fake ids start above this: 10 digits, obviously synthetic, never hex-32/64 sized. */
const FAKE_ID_BASE = 9000000000;

/**
 * Anonymiser for ads recordings, shared across every file of one run so that a
 * real id maps to the SAME fake id everywhere (an ad set's `campaign_id` still
 * points at the campaign fixture's `id`). Pure and deterministic: the n-th
 * distinct id seen becomes `9000000000 + n`.
 *
 * Rules, applied to an already secret-redacted body, returning a NEW value with
 * the SAME JSON types (which is all the shape-diff compares):
 *   - a value under an id key (`id`, `*_id`) → fake id, `act_` prefix kept;
 *   - a `name` → `REDACTED_NAME_<n>`;
 *   - paging `next` / `previous` → a fixed placeholder URL, `before` / `after`
 *     cursors → `REDACTED_CURSOR` (cursors are base64 of real ids);
 *   - any other numeric string (budgets, spend, cpc, impressions, action
 *     values) → `"100"` for an integer, `"1.5"` for a decimal;
 *   - any other string → every embedded 6+ digit run replaced by its fake id;
 *   - object keys that are or embed ids (a `?ids=` map) → fake ids;
 *   - JSON numbers and booleans (enums such as `account_status`) are kept,
 *     except a number under an id key, which becomes a fake numeric id.
 */
export function createAdsAnonymizer() {
  const ids = new Map();
  const names = new Map();

  const fakeId = (digits) => {
    let fake = ids.get(digits);
    if (fake === undefined) {
      fake = String(FAKE_ID_BASE + ids.size + 1);
      ids.set(digits, fake);
    }
    return fake;
  };
  const embedded = (text) => text.replace(EMBEDDED_ID, (run) => fakeId(run));
  const isIdKey = (key) => key !== undefined && ADS_ID_KEY.test(key);

  const leaf = (key, value) => {
    if (isIdKey(key)) {
      const m = ADS_ID_VALUE.exec(value);
      return m ? `${m[1] ?? ''}${fakeId(m[2])}` : embedded(value);
    }
    if (key === 'name') {
      let fake = names.get(value);
      if (fake === undefined) {
        fake = `REDACTED_NAME_${String(names.size + 1)}`;
        names.set(value, fake);
      }
      return fake;
    }
    if (key === 'next' || key === 'previous') {
      return 'https://graph.facebook.com/REDACTED_PAGING_URL';
    }
    if (key === 'before' || key === 'after') return 'REDACTED_CURSOR';
    if (NUMERIC_STRING.test(value)) return value.includes('.') ? '1.5' : '100';
    return embedded(value);
  };

  const walk = (value, key) => {
    if (typeof value === 'string') return leaf(key, value);
    if (typeof value === 'number') {
      return isIdKey(key) && Number.isInteger(value)
        ? Number(fakeId(String(value)))
        : value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[embedded(k)] = walk(v, k);
      }
      return out;
    }
    return value;
  };

  return { anonymize: (value) => walk(value, undefined) };
}

/**
 * Record the ads read set. Returns `{ skipped: true }` when no ad account is
 * configured, else `{ dir, version, files: [{ out, status, data }],
 * skippedDetails }` with every body already secret-redacted AND anonymised.
 * Nothing is written here; overwrites are refused before the first call.
 */
export async function recordAdsSet(options) {
  // The account is checked BEFORE the credential: an operator without an ad
  // account gets a clean skip, not a token complaint about a run that would
  // never have happened.
  const loaded = await loadRecorderSettings();
  const accountId = resolveAdsAccount(loaded.settings.adAccountId);
  if (accountId === null) return { skipped: true };

  const client = await createRecorderClient(loaded);
  const version = client.settings.adsApiVersion;
  const dir = adsFixtureDir(version);
  if (!options.force) {
    const existing = ADS_FIXTURE_FILES.filter((name) =>
      existsSync(fileURLToPath(new URL(`${dir}${name}`, FIXTURES_DIR))),
    );
    if (existing.length > 0) {
      throw new RecordError(
        `test/fixtures/${dir} already holds ${existing.join(', ')} and was left ` +
          'untouched. Re-recording over committed fixtures has to be deliberate: ' +
          'pass --force (and diff the result before committing).',
      );
    }
  }

  const fields = await importBuilt('api', 'ads-read.js');
  const send = (plan) =>
    client.fbRequest({
      protocol: 'json',
      host: 'graph',
      method: plan.method,
      api: plan.api,
      path: plan.path,
      params: plan.params,
    });

  const raw = [];
  const skippedDetails = [];
  for (const plan of planAdsRecordings(accountId, fields)) {
    const response = await send(plan);
    raw.push({ out: plan.out, status: response.status, data: response.data });
    const levelSpec = ADS_LEVELS.find((l) => l.listOut === plan.out);
    if (levelSpec === undefined) continue;
    const detail = planAdsObjectRead(levelSpec, response.data, fields);
    if (detail === null) {
      skippedDetails.push(levelSpec.detailOut);
      continue;
    }
    const detailResponse = await send(detail);
    raw.push({
      out: detail.out,
      status: detailResponse.status,
      data: detailResponse.data,
    });
  }

  // Secrets first (exact values, then shapes), then the ads anonymiser — ONE
  // instance for the whole run, so ids stay consistent across the files.
  const anonymizer = createAdsAnonymizer();
  const files = raw.map((r) => ({
    out: r.out,
    status: r.status,
    data: anonymizer.anonymize(redactSecrets(r.data, client.scrub)),
  }));
  return { skipped: false, dir, version, files, skippedDetails };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Run the committed fixture-lint over the redacted body BEFORE it is written, so
 * a recording that would fail `npm test` never reaches the disk in the first
 * place. This is the same module the suite runs, not a second opinion.
 */
async function assertLintClean(redacted, out) {
  const fixtures = await importBuilt('testing', 'fixtures.js');
  const findings = fixtures.findSecrets(redacted, { file: out });
  if (findings.length > 0) {
    const lines = findings.map((f) => `  ${f.path}: ${f.rule} (${f.sample})`);
    throw new RecordError(
      `refusing to write ${out}: redaction did not clear the fixture-lint:\n` +
        `${lines.join('\n')}\n` +
        'This is a redaction gap, not a lint bug — fix redactString/redactSecrets ' +
        'in scripts/record-fixture.mjs before recording again.',
      EXIT.failed,
    );
  }
}

/**
 * `--ads`: record the ads read set, lint EVERY file, and only then write them
 * all — a lint failure on the last file leaves none of the set on disk.
 */
async function runAds(options) {
  const result = await recordAdsSet(options);
  if (result.skipped) {
    process.stdout.write(`skipped: ${adsSkipMessage()}\n`);
    return EXIT.ok;
  }

  for (const file of result.files) {
    await assertLintClean(file.data, `${result.dir}${file.out}`);
  }

  const dirUrl = new URL(result.dir, FIXTURES_DIR);
  await mkdir(dirUrl, { recursive: true });
  const lines = [];
  for (const file of result.files) {
    await writeFile(
      new URL(file.out, dirUrl),
      `${JSON.stringify(file.data, null, 2)}\n`,
      'utf8',
    );
    lines.push(
      `wrote test/fixtures/${result.dir}${file.out} (HTTP ${String(file.status)})`,
    );
  }
  for (const out of result.skippedDetails) {
    lines.push(
      `skipped test/fixtures/${result.dir}${out}: its listing came back empty, so ` +
        'there was no object to read',
    );
  }
  process.stdout.write(
    `${lines.join('\n')}\n` +
      `Recorded on the ads pin ${result.version}. Secrets were redacted, ids, names ` +
      'and amounts anonymised, and the fixture-lint passed, but READ THE FILES ' +
      'before you commit them.\n',
  );
  return EXIT.ok;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseCliArgs(argv);

  // `--help` answers before the gate: it makes no network call, reads no
  // credential and writes nothing (same rule as the smoke harness's --help).
  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }

  // ---- gate: nothing below this line may run without an explicit opt-in ----
  if (!gateEnabled(env)) {
    throw new RecordError(gateRefusalMessage());
  }

  if (options.ads) {
    return runAds(options);
  }

  const target = new URL(options.out, FIXTURES_DIR);
  const targetPath = fileURLToPath(target);
  if (existsSync(targetPath) && !options.force) {
    throw new RecordError(
      `${options.out} already exists in test/fixtures/ and was left untouched. ` +
        'Tests depend on committed fixtures, so re-recording over one has to be ' +
        'deliberate: pass --force (and diff the result before committing).',
    );
  }

  const { data, status, scrub } = await recordEndpoint(options);
  const redacted = redactSecrets(data, scrub);
  await assertLintClean(redacted, options.out);

  await writeFile(target, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `wrote ${targetPath} (HTTP ${String(status)})\n` +
      'Redaction ran and the fixture-lint passed, but READ THE FILE before you ' +
      'commit it — no pattern knows which Page names, messages or IDs you did not ' +
      'mean to publish.\n',
  );
  return EXIT.ok;
}

// Run only when this module is the process entry point, never on import — the
// unit tests import `parseCliArgs` / `redactSecrets` and must not trigger a run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      if (err instanceof RecordError) {
        process.stderr.write(`record-fixture: ${err.message}\n`);
        process.exitCode = err.exitCode;
        return;
      }
      process.stderr.write(
        `record-fixture: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = EXIT.failed;
    },
  );
}

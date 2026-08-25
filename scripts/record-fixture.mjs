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
//   --help       Show usage and exit 0. Needs no gate and no credential.
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
//   shell history (see the warning in `src/mcp/setup-token.ts`).
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
import { writeFile } from 'node:fs/promises';
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

Options
  --endpoint <path>   Graph edge path with an optional query string, e.g.
                      "me?fields=id,name" or "{page-id}/feed?limit=5". Relative
                      only — an absolute URL is refused.
  --out <name.json>   Fixture file name under test/fixtures/. Bare name, .json.
  --method <verb>     GET only (the default). Writes belong in the smoke harness.
  --force             Overwrite an existing fixture instead of refusing.
  --help              Show this text and exit 0 (no gate, no credential needed).

Environment
  ${RECORD_GATE_VAR}=1   required — the recorder refuses without it
  FB_SYSTEM_TOKEN     preferred credential (or FB_ACCESS_TOKEN / FB_PAGE_TOKEN)
  FB_APP_SECRET       optional; when set, appsecret_proof is attached
  FB_API_VERSION      optional; defaults to the version pinned in settings.ts

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
    '<path> --out <name.json>'
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
    return { help: true, force: false, method: 'GET' };
  }

  if (!values.endpoint || !values.out) {
    throw new RecordError(
      'usage: record-fixture.mjs --endpoint <graph-path> --out <name.json> ' +
        '[--method GET] [--force]',
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

  const method = values.method.toUpperCase();
  if (method !== 'GET') {
    throw new RecordError(
      `--method ${method} is refused: the recorder only ever issues GETs, so it ` +
        'cannot mutate a Page. Recording a write response is the live smoke ' +
        "harness's job (scripts/smoke/), which sweeps up what it creates.",
    );
  }

  return {
    help: false,
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
  const core = await importBuilt('core', 'index.js');
  const { settings, report } = core.loadSettings();

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

  const { path, params } = parseEndpoint(options.endpoint);
  const response = await fbRequest({
    protocol: 'json',
    host: 'graph',
    method: 'GET',
    path,
    params,
  });

  // Value-based scrubbing first (exact known secrets), pattern pass second.
  const scrub = (text) => redactString(redactor.redactString(text));
  return { data: response.data, status: response.status, scrub };
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

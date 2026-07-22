#!/usr/bin/env node
// record-fixture.mjs — SKELETON recorder for Graph API fixtures (task F03).
//
// Purpose
//   Document (and, once wired, perform) the flow for capturing a REAL Graph API
//   response and saving it as a REDACTED JSON fixture under `test/fixtures/`.
//
// Status
//   SKELETON ONLY. This script performs NO network I/O. The single spot that
//   would call the real `fbRequest` client is marked with a TODO and currently
//   throws. It exists so the recording procedure is documented and version-
//   controlled before the HTTP client (F07/F08) lands in Wave 2.
//
// Usage (once the TODO is wired)
//   node scripts/record-fixture.mjs --endpoint <graph-path> --out <name.json>
//
//   --endpoint   Graph path to fetch, e.g. "me?fields=id,name" (required)
//   --out        Fixture file name written under test/fixtures/, e.g.
//                "graph-me.json" (required)
//   --method     HTTP method (default: GET)
//
// Safety
//   Every recording is passed through `redactSecrets` before being written, so
//   access tokens, app secrets and appsecret_proofs are replaced with visible
//   placeholders. Even so, ALWAYS eyeball the output before committing — the
//   fixture-lint (src/testing/fixtures.ts) is the committed backstop and will
//   fail the test suite if any token-shaped value slips through.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const FIXTURES_DIR = new URL('../test/fixtures/', import.meta.url);

/** Parse `--endpoint`, `--out`, `--method` into a validated options object. */
function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      endpoint: { type: 'string' },
      out: { type: 'string' },
      method: { type: 'string', default: 'GET' },
    },
  });

  if (!values.endpoint || !values.out) {
    throw new Error(
      'usage: record-fixture.mjs --endpoint <graph-path> --out <name.json> [--method GET]',
    );
  }
  if (!values.out.endsWith('.json')) {
    throw new Error(`--out must end in .json (got "${values.out}")`);
  }
  return { endpoint: values.endpoint, out: values.out, method: values.method };
}

/**
 * Fetch a real Graph API response.
 *
 * TODO(F07/F08): wire this to the real `fbRequest` client once the HTTP layer
 * exists. It should build a `FbRequest`, read credentials from the environment
 * (never CLI args), issue the call, and return the parsed JSON body. Until then
 * this throws so the skeleton can never silently pretend to record.
 */
function recordEndpoint(options) {
  throw new Error(
    `record-fixture: live recording of "${options.method} ${options.endpoint}" is ` +
      'not wired yet (F03 skeleton). Wire recordEndpoint() to the real fbRequest ' +
      'client in Wave 2 (F07/F08).',
  );
}

const EAA_TOKEN = /EAA[A-Za-z0-9]{16,}/g;
const HEX_64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const HEX_32 = /(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/g;
const APP_ACCESS_TOKEN_PIPE = /\d{6,}\|[A-Za-z0-9_-]{10,}/g;

/** Replace secret-shaped strings with visible placeholders (value-based, C3). */
function redactString(value) {
  return value
    .replace(EAA_TOKEN, 'EAA_REDACTED_ACCESS_TOKEN')
    .replace(APP_ACCESS_TOKEN_PIPE, 'APP_ID|REDACTED_APP_SECRET')
    .replace(HEX_64, 'REDACTED_APPSECRET_PROOF_64HEX')
    .replace(HEX_32, 'REDACTED_APP_SECRET_32HEX');
}

/**
 * Recursively redact a parsed JSON value: rewrite secret-shaped strings and
 * blank out any `access_token` field. Returns a new value; input is untouched.
 */
function redactSecrets(value) {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] =
        key === 'access_token' && typeof val === 'string'
          ? 'REDACTED_ACCESS_TOKEN'
          : redactSecrets(val);
    }
    return out;
  }
  return value;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const raw = await recordEndpoint(options); // throws in the skeleton
  const redacted = redactSecrets(raw);
  const target = new URL(options.out, FIXTURES_DIR);
  await writeFile(target, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${fileURLToPath(target)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

export { parseCliArgs, redactSecrets, redactString };

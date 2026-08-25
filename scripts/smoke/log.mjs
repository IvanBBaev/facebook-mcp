// Terminal output for the smoke harness.
//
// Two rules govern everything in this file:
//
//   1. No secrets, ever. The server redacts its own logs at a value-based
//      choke-point (C3), but this harness prints things the server never saw:
//      its own error messages, captured child stderr, tool arguments. So every
//      line leaving here goes through `scrub()`, which replaces the literal
//      values of the secret-bearing environment variables of THIS process with
//      a placeholder, plus a few structural patterns (bearer tokens, Graph
//      `access_token=` query parameters).
//   2. Readable. A smoke run is watched by a human; the output is a short list
//      of lines, not a JSON stream.

import { markerFor } from './nonce.mjs';

/** Env vars whose literal value must never appear in output. */
const SECRET_ENV_VARS = [
  'FB_ACCESS_TOKEN',
  'FB_SYSTEM_TOKEN',
  'FB_PAGE_TOKEN',
  'FB_APP_SECRET',
  'FB_HTTP_TOKEN',
  'FB_OPERATOR_TOKEN',
  'FB_SMOKE_PAGE_TOKEN',
  'FB_SMOKE_TEST_PAGE_TOKEN',
];

const STRUCTURAL_PATTERNS = [
  /access_token=[^&\s"']+/gi,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\bEA[A-Za-z0-9]{20,}/g,
];

/**
 * Collect the literal secret values to scrub. Also picks up every
 * `FB_PROFILE_<NAME>_TOKEN`, since profiles are declared dynamically.
 */
function secretValues(env) {
  const values = new Set();
  for (const [key, value] of Object.entries(env)) {
    const isSecret =
      SECRET_ENV_VARS.includes(key) ||
      /^FB_PROFILE_.+_TOKEN$/.test(key) ||
      /TOKEN$/.test(key);
    if (isSecret && typeof value === 'string' && value.length >= 6) {
      values.add(value);
    }
  }
  return [...values];
}

/** Escape a literal string for use inside a RegExp. */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove secrets from an arbitrary string. Exported for tests and for callers
 * that build their own message before handing it to the logger.
 */
export function scrub(text, env = process.env) {
  let out = String(text);
  for (const value of secretValues(env)) {
    out = out.replace(new RegExp(escapeRe(value), 'g'), '[redacted]');
  }
  for (const pattern of STRUCTURAL_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

/** Shorten a long string for terminal output, keeping the head. */
export function clip(text, max = 500) {
  const value = String(text);
  return value.length <= max
    ? value
    : `${value.slice(0, max)}… (+${value.length - max} chars)`;
}

/**
 * Create the harness logger. Everything goes to stdout except `warn`/`error`,
 * which go to stderr so a caller can separate the report from the problems.
 */
export function createLogger({ env = process.env, verbose = false } = {}) {
  const write = (stream, prefix, message) => {
    stream.write(`${prefix}${scrub(message, env)}\n`);
  };
  return {
    verbose,
    line: (message = '') => write(process.stdout, '', message),
    info: (message) => write(process.stdout, '  ', message),
    step: (message) => write(process.stdout, '    · ', message),
    ok: (message) => write(process.stdout, '  ✔ ', message),
    fail: (message) => write(process.stdout, '  ✘ ', message),
    skip: (message) => write(process.stdout, '  – ', message),
    warn: (message) => write(process.stderr, 'warning: ', message),
    error: (message) => write(process.stderr, 'error: ', message),
    debug: (message) => {
      if (verbose) {
        write(process.stderr, 'debug: ', message);
      }
    },
  };
}

/** The banner printed once per run, so the nonce is visible before anything runs. */
export function runBanner(nonce, selected) {
  return [
    `facebook-mcp live smoke run`,
    `  marker   ${markerFor(nonce)}`,
    `  smokes   ${selected.length === 0 ? '(none selected)' : selected.map((s) => s.id).join(', ')}`,
  ].join('\n');
}

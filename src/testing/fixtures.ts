// Fixture loader + fixture-lint (task F03).
//
// Committed JSON fixtures live in `test/fixtures/` at the repo root and are
// resolved relative to this module's compiled location (`build/testing/`) via
// `import.meta.url`, so the same code works from source-mapped test runs.
//
// The fixture-lint is the C3 belt-and-braces guard for the repo: it scans every
// committed fixture for token-shaped secrets and FAILS the suite if any leak. It
// rejects four secret shapes (plus an app-access-token bonus rule):
//   * EAA-prefixed access tokens;
//   * 64-hex `appsecret_proof`-shaped strings;
//   * 32-hex app-secret-shaped strings;
//   * any `access_token` object key with a non-empty string value;
//   * `{app-id}|{app-secret}` app-access-token pipe form.
// Value-based redaction in `core` (F05) is the primary defense; this lint stops
// a raw recording from ever being committed in the first place.

import { readFile, readdir } from 'node:fs/promises';

/** Absolute URL of the committed fixtures directory (repo-root `test/fixtures/`). */
export const FIXTURES_DIR = new URL('../../test/fixtures/', import.meta.url);

/** Resolve a fixture file name to an absolute URL under {@link FIXTURES_DIR}. */
export function fixtureUrl(name: string): URL {
  return new URL(name, FIXTURES_DIR);
}

/** Load and JSON-parse a committed fixture by file name. */
export async function loadFixture<T = unknown>(name: string): Promise<T> {
  const text = await readFile(fixtureUrl(name), 'utf8');
  return JSON.parse(text) as T;
}

/** Which fixture-lint rule a finding fired. */
export type SecretRule =
  | 'eaa-access-token'
  | 'appsecret-proof-64hex'
  | 'app-secret-32hex'
  | 'access-token-field'
  | 'app-access-token-pipe';

/** One secret-shaped value found by the lint. */
export interface SecretFinding {
  /** Fixture file the value was found in, when scanning a directory. */
  readonly file?: string;
  /** JSON path to the offending value (e.g. `$.paging.next`). */
  readonly path: string;
  readonly rule: SecretRule;
  /** A non-leaking description of the value (never the secret itself). */
  readonly sample: string;
}

// EAA access token: the `EAA` prefix followed by a long run of token characters.
// The 16-char minimum avoids flagging ordinary words that merely start with EAA.
const EAA_TOKEN = /EAA[A-Za-z0-9]{16,}/;
// 64-hex appsecret_proof and 32-hex app secret, each bounded so a 64-run is not
// also reported as a 32-run.
const HEX_64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const HEX_32 = /(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/;
// `{app-id}|{app-secret}` app-access-token form.
const APP_ACCESS_TOKEN_PIPE = /\d{6,}\|[A-Za-z0-9_-]{10,}/;

function scanString(value: string): SecretRule[] {
  const hits: SecretRule[] = [];
  if (EAA_TOKEN.test(value)) {
    hits.push('eaa-access-token');
  }
  if (HEX_64.test(value)) {
    hits.push('appsecret-proof-64hex');
  } else if (HEX_32.test(value)) {
    hits.push('app-secret-32hex');
  }
  if (APP_ACCESS_TOKEN_PIPE.test(value)) {
    hits.push('app-access-token-pipe');
  }
  return hits;
}

function sampleOf(value: string): string {
  const head = value.slice(0, 4);
  return `${value.length} chars, starts "${head}"`;
}

/**
 * Recursively scan a parsed JSON value for secret-shaped strings and
 * `access_token` fields. Returns one {@link SecretFinding} per hit; an empty
 * array means the value is clean.
 */
export function findSecrets(
  value: unknown,
  options: { readonly file?: string } = {},
): SecretFinding[] {
  const findings: SecretFinding[] = [];

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const rule of scanString(node)) {
        findings.push({ file: options.file, path, rule, sample: sampleOf(node) });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, val] of Object.entries(node)) {
        if (key === 'access_token' && typeof val === 'string' && val.length > 0) {
          findings.push({
            file: options.file,
            path: `${path}.${key}`,
            rule: 'access-token-field',
            sample: sampleOf(val),
          });
        }
        walk(val, `${path}.${key}`);
      }
    }
  };

  walk(value, '$');
  return findings;
}

/** Error thrown by the assert helpers when secret-shaped values are present. */
export class FixtureSecretError extends Error {
  readonly findings: readonly SecretFinding[];

  constructor(findings: readonly SecretFinding[]) {
    const lines = findings.map(
      (f) => `  ${f.file ?? '<memory>'} ${f.path}: ${f.rule} (${f.sample})`,
    );
    super(
      `fixture-lint: ${findings.length} secret-shaped value(s) found:\n${lines.join('\n')}`,
    );
    this.name = 'FixtureSecretError';
    this.findings = findings;
    Object.setPrototypeOf(this, FixtureSecretError.prototype);
  }
}

/** Throw {@link FixtureSecretError} if `value` contains any secret-shaped data. */
export function assertNoSecrets(value: unknown, file?: string): void {
  const findings = findSecrets(value, { file });
  if (findings.length > 0) {
    throw new FixtureSecretError(findings);
  }
}

/** Scan every `*.json` file in `dir` (default: {@link FIXTURES_DIR}) for secrets. */
export async function lintFixtureDir(dir: URL = FIXTURES_DIR): Promise<SecretFinding[]> {
  const entries = await readdir(dir);
  const findings: SecretFinding[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const text = await readFile(new URL(entry, dir), 'utf8');
    findings.push(...findSecrets(JSON.parse(text) as unknown, { file: entry }));
  }
  return findings;
}

/** Throw {@link FixtureSecretError} if any committed fixture leaks a secret. */
export async function assertFixturesClean(dir?: URL): Promise<void> {
  const findings = await lintFixtureDir(dir);
  if (findings.length > 0) {
    throw new FixtureSecretError(findings);
  }
}

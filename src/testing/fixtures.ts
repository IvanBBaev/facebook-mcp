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
//
// The provenance lint (R16, QA-03) is the second half: every fixture carries a
// top-level `_meta` block saying where it came from (`recorded`, `synthetic` or
// `docs`), which Graph version and endpoint it stands for and, for recordings,
// when it was recorded. A fixture can therefore never claim to be a recording it
// is not, and a Graph URL inside a fixture cannot drift from the pinned version
// unnoticed. `loadFixture` strips `_meta`, so tests only ever see the body.

import { readFile, readdir } from 'node:fs/promises';
import { sep } from 'node:path';

import { DEFAULT_API_VERSION } from '../core/settings.js';

/** Absolute URL of the committed fixtures directory (repo-root `test/fixtures/`). */
export const FIXTURES_DIR = new URL('../../test/fixtures/', import.meta.url);

/** Resolve a fixture file name to an absolute URL under {@link FIXTURES_DIR}. */
export function fixtureUrl(name: string): URL {
  return new URL(name, FIXTURES_DIR);
}

/** Top-level key that holds a fixture's provenance block. */
export const FIXTURE_META_KEY = '_meta';

/** Where a fixture's body came from. */
export type FixtureSource = 'recorded' | 'synthetic' | 'docs';

/** The `_meta` provenance block every committed fixture carries. */
export interface FixtureMeta {
  /**
   * `recorded`: captured from the wire by `scripts/record-fixture.mjs`;
   * `synthetic`: hand-written to the documented field set;
   * `docs`: hand-written from an example in Meta's documentation.
   */
  readonly source: FixtureSource;
  /** Graph (or, under `ads/<version>/`, Marketing) API version it stands for. */
  readonly graph_version: string;
  /** `METHOD /path` with ids as placeholders, e.g. `GET /{page-id}/feed`. */
  readonly endpoint: string;
  /** The `fields` param the body answers, when the request had one. */
  readonly fields?: string;
  /** ISO-8601 capture time. Required for `recorded`, refused otherwise. */
  readonly recorded_at?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Split a parsed fixture into its body and its `_meta` block. The body is the
 * fixture without `_meta`; `meta` is whatever `_meta` held (unvalidated).
 */
export function splitFixture(value: unknown): { body: unknown; meta: unknown } {
  if (!isPlainObject(value) || !(FIXTURE_META_KEY in value)) {
    return { body: value, meta: undefined };
  }
  const { [FIXTURE_META_KEY]: meta, ...body } = value;
  return { body, meta };
}

/** Load and JSON-parse a committed fixture by file name, without its `_meta`. */
export async function loadFixture<T = unknown>(name: string): Promise<T> {
  const text = await readFile(fixtureUrl(name), 'utf8');
  return splitFixture(JSON.parse(text) as unknown).body as T;
}

/** Load a committed fixture's `_meta` provenance block (unvalidated). */
export async function loadFixtureMeta(name: string): Promise<FixtureMeta | undefined> {
  const text = await readFile(fixtureUrl(name), 'utf8');
  return splitFixture(JSON.parse(text) as unknown).meta as FixtureMeta | undefined;
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

/**
 * Scan every `*.json` file under `dir` (default: {@link FIXTURES_DIR}) for
 * secrets, RECURSIVELY: the ads fixtures live in `ads/<version>/` subdirectories
 * (see `scripts/record-fixture.mjs --ads`), and a fixture the lint never opens is
 * a fixture it cannot protect. Findings name the file by its path relative to
 * `dir`, always with `/` separators.
 */
export async function lintFixtureDir(dir: URL = FIXTURES_DIR): Promise<SecretFinding[]> {
  const entries = (await readdir(dir, { recursive: true })).sort();
  const findings: SecretFinding[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const name = entry.split(sep).join('/');
    const text = await readFile(new URL(name, dir), 'utf8');
    findings.push(...findSecrets(JSON.parse(text) as unknown, { file: name }));
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

// ---------------------------------------------------------------------------
// Provenance lint (R16, QA-03)
// ---------------------------------------------------------------------------

/** Which provenance rule a finding fired. */
export type ProvenanceRule =
  | 'meta-missing'
  | 'meta-unknown-key'
  | 'meta-source'
  | 'meta-graph-version'
  | 'meta-endpoint'
  | 'meta-fields'
  | 'meta-recorded-at'
  | 'graph-version-url';

/** One provenance problem found by the lint. */
export interface ProvenanceFinding {
  /** Fixture file the problem was found in, when scanning a directory. */
  readonly file?: string;
  /** JSON path to the offending value (e.g. `$._meta.source`). */
  readonly path: string;
  readonly rule: ProvenanceRule;
  /** What is wrong, in words. Never echoes a fixture value beyond a version tag. */
  readonly detail: string;
}

const FIXTURE_SOURCES: readonly FixtureSource[] = ['recorded', 'synthetic', 'docs'];
const META_KEYS = new Set([
  'source',
  'graph_version',
  'endpoint',
  'fields',
  'recorded_at',
]);
const VERSION_TAG = /^v\d+\.\d+$/;
// `METHOD /path`, ids as `{placeholders}`. A 6+ digit run is a real-looking id.
const ENDPOINT = /^(GET|POST|DELETE) \/\S*$/;
const REAL_ID = /\d{6,}/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// A versioned Meta API URL: graph / graph-video (`/vNN.N/…`) and the resumable
// upload host (`/video-upload/vNN.N/…`).
const VERSIONED_URL =
  /\bhttps?:\/\/(?:graph|graph-video|rupload)\.facebook\.com\/(?:[a-z-]+\/)?(v\d+\.\d+)(?=[/?#]|$)/g;
const ADS_DIR = /^ads\/(v\d+\.\d+)\//;

/**
 * The API version a fixture at `relPath` (relative to the fixtures root, `/`
 * separators) must stand for: the directory version under `ads/<version>/`
 * (several ads pins live side by side for the shape-diff), otherwise the pinned
 * {@link DEFAULT_API_VERSION}.
 */
export function expectedFixtureVersion(relPath: string): string {
  return ADS_DIR.exec(relPath)?.[1] ?? DEFAULT_API_VERSION;
}

/**
 * Check one parsed fixture's provenance: a valid `_meta` block, and no versioned
 * Graph URL in the body on a version other than `expectedVersion`. Returns one
 * {@link ProvenanceFinding} per problem; an empty array means the fixture is fine.
 */
export function findProvenanceIssues(
  value: unknown,
  options: { readonly file?: string; readonly expectedVersion: string },
): ProvenanceFinding[] {
  const { file, expectedVersion } = options;
  const findings: ProvenanceFinding[] = [];
  const add = (path: string, rule: ProvenanceRule, detail: string): void => {
    findings.push({ file, path, rule, detail });
  };

  const { body, meta } = splitFixture(value);
  const metaPath = `$.${FIXTURE_META_KEY}`;
  if (!isPlainObject(meta)) {
    add(
      metaPath,
      'meta-missing',
      'no `_meta` object: say whether the fixture is recorded, synthetic or docs',
    );
  } else {
    for (const key of Object.keys(meta)) {
      if (!META_KEYS.has(key)) {
        add(`${metaPath}.${key}`, 'meta-unknown-key', `unknown \`_meta\` key "${key}"`);
      }
    }
    const { source, graph_version: version, endpoint, fields } = meta;
    const recordedAt = meta['recorded_at'];
    if (
      typeof source !== 'string' ||
      !(FIXTURE_SOURCES as readonly string[]).includes(source)
    ) {
      add(
        `${metaPath}.source`,
        'meta-source',
        `source must be one of ${FIXTURE_SOURCES.join(', ')}`,
      );
    }
    if (typeof version !== 'string' || !VERSION_TAG.test(version)) {
      add(
        `${metaPath}.graph_version`,
        'meta-graph-version',
        'graph_version must look like v26.0',
      );
    } else if (version !== expectedVersion) {
      add(
        `${metaPath}.graph_version`,
        'meta-graph-version',
        `graph_version ${version} does not match the pinned ${expectedVersion}`,
      );
    }
    if (
      typeof endpoint !== 'string' ||
      !ENDPOINT.test(endpoint) ||
      REAL_ID.test(endpoint)
    ) {
      add(
        `${metaPath}.endpoint`,
        'meta-endpoint',
        'endpoint must be "METHOD /path" with ids as placeholders, e.g. "GET /{page-id}/feed"',
      );
    }
    if (fields !== undefined && (typeof fields !== 'string' || fields.length === 0)) {
      add(
        `${metaPath}.fields`,
        'meta-fields',
        'fields must be a non-empty string when present',
      );
    }
    if (source === 'recorded') {
      if (
        typeof recordedAt !== 'string' ||
        !ISO_INSTANT.test(recordedAt) ||
        Number.isNaN(Date.parse(recordedAt))
      ) {
        add(
          `${metaPath}.recorded_at`,
          'meta-recorded-at',
          'a recorded fixture needs recorded_at as an ISO-8601 instant',
        );
      }
    } else if (recordedAt !== undefined) {
      add(
        `${metaPath}.recorded_at`,
        'meta-recorded-at',
        'only a recorded fixture may carry recorded_at',
      );
    }
  }

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(VERSIONED_URL)) {
        const found = match[1];
        if (found !== undefined && found !== expectedVersion) {
          add(
            path,
            'graph-version-url',
            `URL on ${found}, but the fixture stands for ${expectedVersion}`,
          );
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(node)) {
      for (const [key, val] of Object.entries(node)) {
        walk(val, `${path}.${key}`);
      }
    }
  };
  walk(body, '$');
  return findings;
}

/** Error thrown by {@link assertFixturesProvenance} when provenance is wrong. */
export class FixtureProvenanceError extends Error {
  readonly findings: readonly ProvenanceFinding[];

  constructor(findings: readonly ProvenanceFinding[]) {
    const lines = findings.map(
      (f) => `  ${f.file ?? '<memory>'} ${f.path}: ${f.rule} (${f.detail})`,
    );
    super(
      `fixture-lint: ${findings.length} provenance problem(s) found:\n${lines.join('\n')}`,
    );
    this.name = 'FixtureProvenanceError';
    this.findings = findings;
    Object.setPrototypeOf(this, FixtureProvenanceError.prototype);
  }
}

/**
 * Check the provenance of every `*.json` file under `dir` (default:
 * {@link FIXTURES_DIR}), recursively. Each file is held to the version
 * {@link expectedFixtureVersion} derives from its path.
 */
export async function lintFixtureProvenance(
  dir: URL = FIXTURES_DIR,
): Promise<ProvenanceFinding[]> {
  const entries = (await readdir(dir, { recursive: true })).sort();
  const findings: ProvenanceFinding[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const name = entry.split(sep).join('/');
    const text = await readFile(new URL(name, dir), 'utf8');
    findings.push(
      ...findProvenanceIssues(JSON.parse(text) as unknown, {
        file: name,
        expectedVersion: expectedFixtureVersion(name),
      }),
    );
  }
  return findings;
}

/** Throw {@link FixtureProvenanceError} if any committed fixture has bad provenance. */
export async function assertFixturesProvenance(dir?: URL): Promise<void> {
  const findings = await lintFixtureProvenance(dir);
  if (findings.length > 0) {
    throw new FixtureProvenanceError(findings);
  }
}

// Fixture recorder (`scripts/record-fixture.mjs`).
//
// The recorder is the one tool in this repository that points a real credential
// at the real Graph API and then writes the answer to a file that gets
// committed. Two things therefore have to hold, and neither is checkable by
// reading the script:
//
//   1. it refuses to run unless the operator deliberately opened the gate, and
//      refuses a shape of argument that could send a token somewhere it should
//      not go (query string, absolute URL, a path outside `test/fixtures/`);
//   2. whatever it writes passes `findSecrets` — the SAME lint that guards the
//      committed fixture directory. A recorder whose output fails the fixture
//      lint is worse than no recorder: it produces files that look recorded and
//      break the suite, and the reflex fix is to weaken the lint.
//
// Point 2 is asserted as a round-trip property rather than by comparing
// placeholder strings, because the placeholders are only correct insofar as the
// lint accepts them. Nothing here touches the network: only the pure exports are
// exercised, and `recordEndpoint`/`main` are deliberately left alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findProvenanceIssues, findSecrets, splitFixture } from './testing/fixtures.js';

/** This file compiles to `build/record-fixture.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface ParsedArgs {
  readonly help: boolean;
  readonly endpoint?: string;
  readonly out?: string;
  readonly method: string;
  readonly force: boolean;
}

interface Recorder {
  readonly EXIT: {
    readonly ok: number;
    readonly failed: number;
    readonly refused: number;
  };
  readonly RECORD_GATE_VAR: string;
  // Function properties, not method signatures: these are plain module exports
  // with no `this`, and they are used detached below.
  readonly gateEnabled: (env?: NodeJS.ProcessEnv) => boolean;
  readonly gateRefusalMessage: () => string;
  readonly parseCliArgs: (argv: readonly string[]) => ParsedArgs;
  readonly parseEndpoint: (endpoint: string) => {
    path: string;
    params: Record<string, string>;
  };
  readonly redactString: (value: string) => string;
  readonly redactSecrets: (value: unknown, scrub?: (s: string) => string) => unknown;
  readonly endpointTemplate: (method: string, path: string) => string;
  readonly buildProvenance: (input: {
    method?: string;
    path: string;
    params?: Record<string, unknown>;
    version: string;
    recordedAt: Date;
  }) => Record<string, unknown>;
  readonly withProvenance: (body: unknown, meta: unknown) => Record<string, unknown>;
}

// A computed specifier on purpose: the script lives outside `rootDir`, so it is
// loaded the way Node loads it rather than pulled into the TypeScript program.
const recorderUrl = pathToFileURL(join(REPO_ROOT, 'scripts', 'record-fixture.mjs')).href;
const recorder = (await import(recorderUrl)) as Recorder;

const {
  EXIT,
  RECORD_GATE_VAR,
  gateEnabled,
  gateRefusalMessage,
  parseCliArgs,
  parseEndpoint,
  redactString,
  redactSecrets,
  endpointTemplate,
  buildProvenance,
  withProvenance,
} = recorder;

/** Assert `fn` throws a `RecordError` whose message mentions `expected`. */
function refuses(fn: () => unknown, expected: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, 'a non-Error was thrown');
    assert.equal(err.name, 'RecordError', `expected a RecordError, got ${err.name}`);
    assert.match(err.message, expected);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 1. The gate
// ---------------------------------------------------------------------------

test('the gate opens only for exactly "1"', () => {
  assert.equal(gateEnabled({ [RECORD_GATE_VAR]: '1' }), true);

  // Everything a shell might plausibly put there and a human might read as
  // "on". A truthy check here would let `FB_RECORD_FIXTURE=0` spend a real
  // credential, which is the failure mode the strict comparison exists for.
  for (const value of ['0', '', 'true', 'yes', 'on', ' 1', '1 ', '01']) {
    assert.equal(
      gateEnabled({ [RECORD_GATE_VAR]: value }),
      false,
      `${RECORD_GATE_VAR}="${value}" must not open the gate`,
    );
  }
  assert.equal(gateEnabled({}), false, 'an unset gate must not open');
});

test('the refusal message says what happened and how to proceed', () => {
  const message = gateRefusalMessage();

  assert.match(message, new RegExp(RECORD_GATE_VAR), 'does not name the gate variable');
  assert.match(
    message,
    /no file was written/i,
    'does not state that nothing was written',
  );
  assert.match(message, /--endpoint/, 'does not show the invocation to copy');
});

test('refusal is its own exit status, distinct from failure', () => {
  // An operator (and CI) must be able to tell "I declined to run" from "I ran
  // and it broke" — collapsing the two hides a misconfigured gate behind a
  // generic non-zero.
  assert.equal(EXIT.ok, 0);
  assert.notEqual(EXIT.refused, EXIT.failed);
  assert.notEqual(EXIT.refused, EXIT.ok);
});

// ---------------------------------------------------------------------------
// 2. Argument parsing
// ---------------------------------------------------------------------------

test('--help needs neither a gate nor a credential', () => {
  const parsed = parseCliArgs(['--help']);
  assert.equal(parsed.help, true);
});

test('a recording needs both an endpoint and an output name', () => {
  refuses(() => parseCliArgs([]), /usage:/);
  refuses(() => parseCliArgs(['--endpoint', 'me']), /usage:/);
  refuses(() => parseCliArgs(['--out', 'me.json']), /usage:/);
});

test('--out must be a bare .json name under test/fixtures/', () => {
  const parsed = parseCliArgs(['--endpoint', 'me', '--out', 'me-basic.json']);
  assert.equal(parsed.out, 'me-basic.json');
  assert.equal(parsed.method, 'GET');
  assert.equal(parsed.force, false);

  refuses(() => parseCliArgs(['--endpoint', 'me', '--out', 'me']), /must end in \.json/);

  // Traversal and absolute paths would write outside the fixtures directory —
  // the one place the lint actually scans.
  for (const out of [
    '../secrets.json',
    'nested/me.json',
    '/etc/me.json',
    '.hidden.json',
  ]) {
    refuses(() => parseCliArgs(['--endpoint', 'me', '--out', out]), /bare file name/);
  }
});

test('the recorder refuses any method that could mutate a Page', () => {
  for (const method of ['POST', 'post', 'DELETE']) {
    refuses(
      () => parseCliArgs(['--endpoint', 'me', '--out', 'x.json', '--method', method]),
      /only ever issues GETs/,
    );
  }
  // Case is normalised rather than rejected: `--method get` is unambiguous.
  assert.equal(
    parseCliArgs(['--endpoint', 'me', '--out', 'x.json', '--method', 'get']).method,
    'GET',
  );
});

// ---------------------------------------------------------------------------
// 3. Endpoint splitting
// ---------------------------------------------------------------------------

test('the query string is split off rather than left in the path', () => {
  // It cannot ride inside the path: the client assigns that to `URL.pathname`,
  // which would percent-encode `?` and request a literally-named edge.
  const { path, params } = parseEndpoint('123/feed?fields=id,message&limit=5');

  assert.equal(path, '123/feed');
  assert.deepEqual(params, { fields: 'id,message', limit: '5' });
});

test('an endpoint with no query yields no params', () => {
  assert.deepEqual(parseEndpoint('  me  '), { path: 'me', params: {} });
});

test('an absolute URL is refused, so the host stays the allowlist’s choice', () => {
  refuses(
    () => parseEndpoint('https://graph.facebook.com/me'),
    /relative Graph edge path/,
  );
  refuses(() => parseEndpoint('//evil.example/me'), /relative Graph edge path/);
  refuses(() => parseEndpoint('   '), /empty/);
  refuses(() => parseEndpoint('?fields=id'), /no edge path/);
});

test('an access_token in the endpoint is refused, not forwarded', () => {
  // Graph echoes query params back inside `paging.next`, so a token passed this
  // way would be recorded into the fixture by the API itself.
  refuses(
    () => parseEndpoint('me?access_token=EAAsomethingsecretvalue1234'),
    /refusing an access_token/,
  );
});

// ---------------------------------------------------------------------------
// 4. Redaction — the property that matters
// ---------------------------------------------------------------------------

/** A body shaped like a real Graph response, carrying every secret form. */
function pollutedBody(): unknown {
  return {
    data: [
      { id: '1', message: 'hello', access_token: 'EAABBBBccccDDDDeeeeFFFFgggg1234' },
      { id: '2', message: 'a-token-in-prose EAAxxxxYYYYzzzz00001111-2222_3333 trailing' },
    ],
    paging: {
      next: 'https://graph.facebook.com/v23.0/me/feed?access_token=EAAqqqqWWWWeeee5555rrrr',
    },
    app: {
      appsecret_proof: 'a'.repeat(64),
      client_secret: 'f'.repeat(32),
      app_access_token: '1234567890|AbCdEfGhIjKlMnOpQrSt',
    },
  };
}

test('redaction output passes the committed fixture lint', () => {
  // The round-trip property: whatever the recorder writes must survive the very
  // lint that guards `test/fixtures/`. Asserting against the lint rather than
  // against placeholder literals means a future lint rule cannot silently
  // outgrow the redactor.
  const before = findSecrets(pollutedBody());
  assert.ok(before.length > 0, 'the sample body is not actually polluted');

  const after = findSecrets(redactSecrets(pollutedBody()));
  assert.deepEqual(
    after,
    [],
    `redacted output still trips the fixture lint: ${JSON.stringify(after)}`,
  );
});

test('the placeholders do not themselves look like secrets', () => {
  // `EAA_REDACTED_…` keeps an underscore straight after `EAA`, and the app-token
  // placeholder has no digits before the pipe, precisely so the replacement text
  // cannot re-trip the rule that produced it.
  const placeholders = redactString(
    'EAABBBBccccDDDDeeeeFFFFgggg1234 1234567890|AbCdEfGhIjKlMnOpQrSt ' +
      `${'a'.repeat(64)} ${'f'.repeat(32)}`,
  );

  assert.deepEqual(findSecrets({ text: placeholders }), []);
  assert.deepEqual(
    findSecrets({ text: redactString(placeholders) }),
    [],
    'not idempotent',
  );
});

test('a token is masked whole, leaving no live tail behind a separator', () => {
  // The base64url alphabet includes `-` and `_`. A character class that stopped
  // at the first separator would leave the rest of a real token in the file.
  const redacted = redactString('EAAxxxxYYYYzzzz0000-1111_2222deadbeef');

  assert.ok(!/1111/.test(redacted), `a token fragment survived: ${redacted}`);
  assert.ok(!/deadbeef/.test(redacted), `a token tail survived: ${redacted}`);
});

test('an access_token field becomes empty, not a friendly placeholder', () => {
  // The lint fires on any NON-EMPTY string under that key, so a readable marker
  // like "REDACTED" would fail the suite this redaction exists to survive.
  const out = redactSecrets({
    access_token: 'EAABBBBccccDDDDeeeeFFFFgggg1234',
  }) as Record<string, unknown>;

  assert.equal(out['access_token'], '');
});

test('redaction rewrites keys as well as values', () => {
  // A secret can arrive as a property NAME — Graph does this in error payloads
  // that echo the request back.
  const out = redactSecrets({ EAABBBBccccDDDDeeeeFFFFgggg1234: 'value' }) as Record<
    string,
    unknown
  >;

  assert.deepEqual(Object.keys(out), ['EAA_REDACTED_ACCESS_TOKEN']);
});

test('redaction returns a new value and never mutates the input', () => {
  const input = pollutedBody() as Record<string, unknown>;
  const snapshot = JSON.stringify(input);

  const out = redactSecrets(input);

  assert.notEqual(out, input, 'the same object reference came back');
  assert.equal(JSON.stringify(input), snapshot, 'the input was mutated');
});

test('value-based scrubbing runs before shape matching', () => {
  // At runtime the scrub function is "core Redactor first, patterns second", so
  // the exact configured secret VALUES go by identity (no false negatives)
  // before pattern matching is asked to guess at a shape.
  const secret = 'not-token-shaped-at-all';
  const scrub = (s: string): string => redactString(s.split(secret).join('SECRET'));

  const out = redactSecrets({ note: `value ${secret} here` }, scrub) as Record<
    string,
    unknown
  >;

  assert.equal(out['note'], 'value SECRET here');
});

test('non-string leaves are passed through untouched', () => {
  const out = redactSecrets({ n: 1, b: true, nil: null, arr: [1, 'me'] }) as Record<
    string,
    unknown
  >;

  assert.deepEqual(out, { n: 1, b: true, nil: null, arr: [1, 'me'] });
});

// ---------------------------------------------------------------------------
// Provenance (R16, QA-03)
// ---------------------------------------------------------------------------

const RECORDED_AT = new Date('2026-10-31T09:15:00.000Z');

test('the endpoint template keeps the edge and drops real ids', () => {
  assert.equal(endpointTemplate('get', 'me'), 'GET /me');
  assert.equal(endpointTemplate('GET', '/123456789012345/feed'), 'GET /{id}/feed');
  assert.equal(
    endpointTemplate('GET', '/act_1234567/campaigns'),
    'GET /act_{id}/campaigns',
  );
  assert.equal(endpointTemplate('GET', '/1234567_7654321'), 'GET /{id}_{id}');
});

test('a recording is stamped recorded, with version, endpoint, fields and time', () => {
  const meta = buildProvenance({
    path: '/123456789012345/feed',
    params: { fields: 'id,message', limit: 5 },
    version: 'v26.0',
    recordedAt: RECORDED_AT,
  });
  assert.deepEqual(meta, {
    source: 'recorded',
    graph_version: 'v26.0',
    endpoint: 'GET /{id}/feed',
    fields: 'id,message',
    recorded_at: '2026-10-31T09:15:00.000Z',
  });
  assert.ok(
    !(
      'fields' in
      buildProvenance({ path: 'me', version: 'v26.0', recordedAt: RECORDED_AT })
    ),
  );
});

test('the stamped recording passes both committed lints', () => {
  // pollutedBody()'s paging URL is on v23.0, so the recording went out on v23.0.
  const redacted = redactSecrets(pollutedBody());
  const body = withProvenance(
    redacted,
    buildProvenance({ path: 'me', version: 'v23.0', recordedAt: RECORDED_AT }),
  );
  assert.equal(Object.keys(body)[0], '_meta', 'the provenance block leads the file');
  assert.deepEqual(findSecrets(body), []);
  assert.deepEqual(findProvenanceIssues(body, { expectedVersion: 'v23.0' }), []);
  // The body a test loads is exactly the redacted response.
  assert.deepEqual(splitFixture(body).body, redacted);
});

test('a pin-bump recording is consistent with its own version, not the pin', () => {
  const body = withProvenance(
    { paging: { next: 'https://graph.facebook.com/v27.0/1/feed' } },
    buildProvenance({ path: 'me', version: 'v27.0', recordedAt: RECORDED_AT }),
  );
  assert.deepEqual(findProvenanceIssues(body, { expectedVersion: 'v27.0' }), []);
  assert.ok(findProvenanceIssues(body, { expectedVersion: 'v26.0' }).length > 0);
});

test('only a JSON object can carry provenance', () => {
  const meta = buildProvenance({ path: 'me', version: 'v26.0', recordedAt: RECORDED_AT });
  for (const body of [[1], null, 'text', 3]) {
    refuses(() => withProvenance(body, meta), /not a JSON object/);
  }
  // A body that already has a `_meta` key gets the recorder's block, not Graph's.
  assert.deepEqual(withProvenance({ _meta: 'x', id: '1' }, meta), {
    _meta: meta,
    id: '1',
  });
});

// Guard manifest (R12, finding QA-06).
//
// The 2026-10-29 QA review probed 18 mutants on the critical paths; nine of the
// kills rested on a single test, in files that waves 1 and 2 rewrite. A rewritten
// test that drops a guard leaves coverage unchanged, so nothing else notices.
//
// This is a static scan: it reads the test sources and fails when a named guard
// test is gone or renamed. Every single-kill invariant has two entries, the
// original and its independent second kill (`src/guards.independent.test.ts`).
// Renaming a guard means updating its entry here in the same change; removing
// one means the review that removed it says why. Definition of done for every
// task: "guard manifest green, no guard removed".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This file compiles to `build/guards.manifest.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Guard {
  /** Probe mutant (`M01`–`M18`) or `Security #N` from the review. */
  readonly invariant: string;
  /** Test source, relative to `src/`. */
  readonly file: string;
  /** Exact test title. */
  readonly title: string;
}

const INDEPENDENT = 'guards.independent.test.ts';

const GUARDS: readonly Guard[] = [
  // M01: a 5xx on a write is never retried.
  {
    invariant: 'M01',
    file: 'core/http.retry.test.ts',
    title: 'C2 / CC-NET-5: a 5xx on a write is ambiguous and never retried',
  },
  // M03: a transient Graph code on a write is ambiguous.
  {
    invariant: 'M03',
    file: 'core/http.writes.test.ts',
    title:
      'C2: a transient Graph code (1/2, or is_transient) on a write is ambiguous at any HTTP status',
  },
  {
    invariant: 'M03',
    file: INDEPENDENT,
    title:
      'guard M03: a transient Graph code on an applied write journals attempted and never replays',
  },
  // M06: a plan is bound to its Page.
  {
    invariant: 'M06',
    file: 'mcp/write-mode.test.ts',
    title: 'an apply against a different Page than the plan is rejected as plan_mismatch',
  },
  {
    invariant: 'M06',
    file: INDEPENDENT,
    title: 'guard M06: a post planned on one profile cannot be applied through another',
  },
  // M07: the plan TTL boundary.
  {
    invariant: 'M07',
    file: 'mcp/write-mode.test.ts',
    title: 'regression: expiry is enforced on the apply itself, not merely recorded',
  },
  {
    invariant: 'M07',
    file: INDEPENDENT,
    title: 'guard M07: a tool call at exactly the plan TTL is refused as expired',
  },
  // M09: the budget ceiling boundary.
  {
    invariant: 'M09',
    file: 'api/ads-control.test.ts',
    title: 'CC-ADS-7: a budget exactly at the ceiling is allowed',
  },
  // M11: only a boolean true from elicitation approves.
  {
    invariant: 'M11',
    file: 'mcp/confirm.test.ts',
    title: 'only an explicit boolean true from elicitation is an approval',
  },
  {
    invariant: 'M11',
    file: INDEPENDENT,
    title: 'guard M11: a truthy non-boolean elicitation answer does not delete a post',
  },
  // M12: a supplied confirm_token never falls through to the resolver.
  {
    invariant: 'M12',
    file: 'mcp/confirm.test.ts',
    title:
      'a supplied-but-empty confirm_token is a refusal, not a licence to look elsewhere',
  },
  {
    invariant: 'M12',
    file: INDEPENDENT,
    title:
      'guard M12: a null confirm_token through the gate never reaches the token resolver',
  },
  // M13: the EAA redaction charset includes `_` and `-`.
  {
    invariant: 'M13',
    file: 'index.seams.test.ts',
    title: 'an allowlisted value is redacted before it reaches the log',
  },
  {
    invariant: 'M13',
    file: INDEPENDENT,
    title: 'guard M13: a token with `_` and `-` is masked whole in a Graph error message',
  },
  // M14: only paging.next means another page.
  {
    invariant: 'M14',
    file: 'api/albums.test.ts',
    title: 'listAlbums reads /{page-id}/albums with the field set and maps the fixture',
  },
  {
    invariant: 'M14',
    file: INDEPENDENT,
    title:
      'guard M14: a last page with cursors.after and no paging.next ends the listing',
  },
  // M15: the upload overrun boundary (R18).
  {
    invariant: 'M15',
    file: 'api/media-video.test.ts',
    title:
      'a server offset exactly at the file end completes the transfer (overrun boundary, QA-05)',
  },
  {
    invariant: 'M15',
    file: 'api/media-video.test.ts',
    title:
      'a server offset one byte past the file end is a desync (overrun boundary, QA-05)',
  },
  {
    invariant: 'M15',
    file: 'api/media-reels.test.ts',
    title:
      'uploadReelBinary completes when the server offset lands exactly on the file end (overrun boundary, QA-05)',
  },
  {
    invariant: 'M15',
    file: 'api/media-reels.test.ts',
    title:
      'uploadReelBinary refuses a server offset one byte past the file end (overrun boundary, QA-05)',
  },
  // M16: a refused chunk is never counted as landed.
  {
    invariant: 'M16',
    file: 'api/media-video.test.ts',
    title:
      'a chunk answered 2xx with success:false and no offset is not counted as landed',
  },
  {
    invariant: 'M16',
    file: 'api/media-video.test.ts',
    title: 'a chunk refused mid-file keeps the cursor on the refused window (guard M16)',
  },
  // M17: a targeting edit is a spend write.
  {
    invariant: 'M17',
    file: 'tools/ads.targeting.test.ts',
    title:
      'a targeting edit previews before → after as a spend write and changes nothing',
  },
  {
    invariant: 'M17',
    file: INDEPENDENT,
    title:
      'guard M17: FB_WRITE_MODE=apply does not push a targeting edit past the spend gate',
  },
  // Security #3: irreversible and spend writes ignore the env apply default.
  {
    invariant: 'Security #3',
    file: 'mcp/write-mode.test.ts',
    title:
      'authorize: irreversible/spend never honor the FB_WRITE_MODE=apply default (Security #3)',
  },
  // Security #4: the HTTP transport is loopback-only and authenticated.
  {
    invariant: 'Security #4',
    file: 'mcp/transport.test.ts',
    title: 'HTTP transport rejects a non-loopback bind host (Security #4)',
  },
  {
    invariant: 'Security #4',
    file: 'mcp/transport.test.ts',
    title:
      'HTTP transport rejects a DNS name that merely starts with "127." (Security #4)',
  },
  {
    invariant: 'Security #4',
    file: 'mcp/transport.test.ts',
    title: 'HTTP transport rejects a non-loopback IPv6 bind host (Security #4)',
  },
  {
    invariant: 'Security #4',
    file: 'mcp/transport.test.ts',
    title:
      'HTTP transport enforces bearer token + Origin and serves initialize (Security #4, CC-MCP-5)',
  },
  {
    invariant: 'Security #4',
    file: 'mcp/transport.test.ts',
    title:
      'HTTP transport rejects malformed, non-http and mismatched Origins (Security #4)',
  },
  {
    invariant: 'Security #4',
    file: 'mcp/transport.test.ts',
    title:
      'HTTP transport rejects a missing or non-Bearer Authorization header (Security #4)',
  },
  {
    invariant: 'Security #4',
    file: 'mcp/transport.test.ts',
    title:
      'a forged non-loopback Host is rejected even with the bearer token (Security #4)',
  },
  // Security #7: the journal is private on disk.
  {
    invariant: 'Security #7',
    file: 'mcp/journal.test.ts',
    title: 'the journal directory it creates is 0700 on POSIX (Security #7)',
  },
];

/** The invariants the review found resting on one test; each needs two kills. */
const SINGLE_KILL = [
  'M03',
  'M06',
  'M07',
  'M11',
  'M12',
  'M13',
  'M14',
  'M16',
  'M17',
] as const;

const sources = new Map<string, string>();

function source(file: string): string {
  let text = sources.get(file);
  if (text === undefined) {
    text = readFileSync(join(REPO_ROOT, 'src', file), 'utf8');
    sources.set(file, text);
  }
  return text;
}

/** Every `test('…'` title in a source, with the quote style the formatter picked. */
function titles(file: string): Set<string> {
  const found = new Set<string>();
  for (const m of source(file).matchAll(/^test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gms)) {
    found.add((m[2] ?? '').replace(/\\(.)/g, '$1'));
  }
  return found;
}

test('every guard in the manifest is still a test in its file', () => {
  const missing = GUARDS.filter((g) => !titles(g.file).has(g.title)).map(
    (g) => `${g.invariant} ${g.file}: ${g.title}`,
  );
  assert.deepEqual(
    missing,
    [],
    'a guard test was removed or renamed; restore it or update the manifest',
  );
});

test('each single-kill invariant has two distinct guards', () => {
  for (const id of SINGLE_KILL) {
    const pair = GUARDS.filter((g) => g.invariant === id);
    assert.ok(pair.length >= 2, `${id} has ${pair.length} guard(s), needs 2`);
    assert.equal(
      new Set(pair.map((g) => g.title)).size,
      pair.length,
      `${id} lists one test twice`,
    );
  }
});

test('every guard in guards.independent.test.ts is in the manifest', () => {
  const listed = new Set(
    GUARDS.filter((g) => g.file === INDEPENDENT).map((g) => g.title),
  );
  const unlisted = [...titles(INDEPENDENT)].filter((t) => !listed.has(t));
  assert.deepEqual(unlisted, [], 'add the new independent guard to GUARDS');
});

test('the manifest names no test twice', () => {
  const keys = GUARDS.map((g) => `${g.file}\u0000${g.title}`);
  assert.equal(new Set(keys).size, keys.length);
});

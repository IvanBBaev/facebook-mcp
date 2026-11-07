// Tests for the server bootstrap: CLI argument handling.
//
// Split out of `index.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/server.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageText } from './index.js';
import {
  DEFAULT_PROFILE_SCOPES,
  doctorOverBootstrapPackages,
} from './testing/harness/server.js';

// ---------------------------------------------------------------------------
// CLI argument handling (wave 15)
// ---------------------------------------------------------------------------

test('doctor names an argument it ignored instead of dropping it silently', async () => {
  // `--stric` is the typo a CI script acquires; the doctor must not gate on it
  // (see isStrictFlag), but the operator has to be able to SEE that it was
  // ignored, or a pipeline that meant to gate reads exit 0 as a pass.
  const { text, exitCode } = await doctorOverBootstrapPackages(DEFAULT_PROFILE_SCOPES, [
    '--stric',
  ]);
  assert.match(text, /Ignored unknown doctor argument "--stric"/);
  assert.match(text, /--strict/);
  assert.equal(exitCode, 0, 'a near-miss still never gates');
});

test('doctor never echoes the value of an ignored argument', async () => {
  const pasted = 'EAAB-pasted-into-argv-must-not-echo';
  const { text } = await doctorOverBootstrapPackages(DEFAULT_PROFILE_SCOPES, [
    `--token=${pasted}`,
    pasted,
  ]);
  assert.match(text, /"--token=\u2026"/);
  assert.match(text, /positional argument/);
  assert.equal(
    text.includes(pasted),
    false,
    'an ignored argument value reached the report',
  );
});

test('regression: a clean doctor argument list adds no ignored-argument line', async () => {
  const { text } = await doctorOverBootstrapPackages(DEFAULT_PROFILE_SCOPES, [
    '--strict',
  ]);
  assert.equal(/Ignored unknown doctor argument/.test(text), false);
});

test('--help prints usage and exits 0 without loading settings or starting a server', () => {
  // The only test here that runs the real entry point: `--help` is decided in
  // `main()`, before anything injectable exists. The child gets no FB_* env and
  // a cwd with no `.env`, so a build that ignores `--help` fails fast on the
  // missing token instead of waiting on stdin as a stdio server.
  const cwd = mkdtempSync(join(tmpdir(), 'facebook-mcp-help-'));
  try {
    // The subcommand forms are what a first-time operator types to learn the
    // flags; they used to run the flow (setup-token: a FAIL report, exit 2).
    for (const flag of ['--help', '-h', 'setup-token --help', 'doctor -h']) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./index.js', import.meta.url)), ...flag.split(' ')],
        {
          cwd,
          env: { PATH: process.env['PATH'] ?? '', HOME: cwd, USERPROFILE: cwd },
          input: '',
          encoding: 'utf8',
          timeout: 15_000,
        },
      );
      assert.equal(
        child.status,
        0,
        `${flag}: exit ${String(child.status)}; stderr: ${child.stderr}`,
      );
      // The child runs `build/index.js` directly, so the usage names that form.
      assert.match(
        child.stdout,
        /^Usage: node build\/index\.js \[command\]/m,
        `${flag}: no usage on stdout`,
      );
      for (const word of ['doctor', '--strict', 'setup-token', '--version']) {
        assert.ok(child.stdout.includes(word), `${flag}: usage does not mention ${word}`);
      }
      // The first-run hint names the npx form with the manifest's real package
      // name, so an npx user is not left typing a `facebook-mcp` that is not on PATH.
      assert.match(child.stdout, /First run/, `${flag}: no first-run hint`);
      // The exchange fails without the app pair, so the recipe must carry it.
      assert.match(
        child.stdout,
        /FB_APP_SECRET=/,
        `${flag}: first-run hint lacks app creds`,
      );
      assert.match(
        child.stdout,
        /FB_SETUP_TOKEN=/,
        `${flag}: first-run hint lacks the env var`,
      );
      assert.match(child.stdout, /npx -y @[\w-]+\/facebook-mcp/, `${flag}: no npx form`);
      assert.equal(child.stderr, '', `${flag}: unexpected stderr: ${child.stderr}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('--help renders every command in the launch form that started the process', () => {
  // The usage line and the first-run recipe used to say `facebook-mcp`, which is
  // only on PATH after a global install; an npx user copied a command their
  // shell does not know.
  const npx = 'npx -y @ivanbaev/facebook-mcp';
  const text = usageText('@ivanbaev/facebook-mcp', npx);
  assert.match(text, /^Usage: npx -y @ivanbaev\/facebook-mcp \[command\]$/m);
  assert.match(
    text,
    /FB_SETUP_TOKEN=<[^>]+> npx -y @ivanbaev\/facebook-mcp setup-token$/m,
  );
  assert.match(text, /^ {2}npx -y @ivanbaev\/facebook-mcp doctor$/m);
  assert.doesNotMatch(
    text,
    /^Usage: facebook-mcp|^ {2}facebook-mcp (doctor|setup-token)/m,
  );
  // The other launch forms are still listed, without repeating the current one.
  assert.match(text, /after a global install: +facebook-mcp$/m);
  assert.match(text, /from a source checkout: +node build\/index\.js$/m);
  assert.doesNotMatch(text, /through npx:/);
});

test('--help without a resolved launch form falls back to the binary name', () => {
  const text = usageText(undefined);
  assert.match(text, /^Usage: facebook-mcp \[command\]$/m);
  assert.match(text, /^ {2}facebook-mcp doctor$/m);
  assert.match(text, /through npx: +npx -y <npm package>$/m);
  assert.doesNotMatch(text, /after a global install:/);
});

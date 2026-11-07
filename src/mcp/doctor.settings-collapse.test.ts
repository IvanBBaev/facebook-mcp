// Settings collapse (C04): the doctor carries the deprecation note for a
// renamed variable, through the startup warnings it already reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings } from '../core/index.js';
import { doctorExitCode, summarizeDoctor } from './doctor.js';
import { healthyReport } from '../testing/harness/doctor.js';

test('C04: the doctor warns about a deprecated variable name, naming its replacement', async () => {
  const { report: startup } = loadSettings({
    platform: 'linux',
    homeDir: '/home/t',
    loadEnvFile: false,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PACKAGES_DENY: 'ads',
    },
  });
  const summary = summarizeDoctor({
    ...(await healthyReport()),
    startupProblems: startup.problems,
  });

  const notes = summary.findings.filter((f) => f.area === 'configuration');
  assert.equal(notes.length, 1);
  const [note] = notes;
  assert.ok(note);
  assert.equal(note.severity, 'warn');
  assert.match(
    note.detail,
    /FB_PACKAGES_DENY is deprecated; rename it to FB_TOOL_PACKAGES_DENY/,
  );
  assert.equal(summary.verdict, 'warn');
  assert.equal(doctorExitCode(summary.verdict, false), 0);
});

test('C04: conflicting old and new names fail the doctor', async () => {
  const { report: startup } = loadSettings({
    platform: 'linux',
    homeDir: '/home/t',
    loadEnvFile: false,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_TOOL_PACKAGES_READONLY: 'posts',
      FB_PACKAGES_READONLY: 'reader',
    },
  });
  const summary = summarizeDoctor({
    ...(await healthyReport()),
    startupProblems: startup.problems,
  });
  assert.equal(summary.verdict, 'fail');
  assert.ok(
    summary.findings.some(
      (f) => f.severity === 'fail' && /FB_PACKAGES_READONLY/.test(f.detail),
    ),
  );
});

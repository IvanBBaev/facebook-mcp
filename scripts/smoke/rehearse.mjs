#!/usr/bin/env node
// Offline end-to-end rehearsal of the live smoke harness.
//
//   npm run smoke:rehearse [-- <run.mjs flags>]
//
// Runs the REAL harness — run.mjs, every registered smoke including the budget
// ones and reels-lifecycle, and both sweeps — against a loopback fake Graph
// (rehearsal/fake-graph.mjs), with fake credentials and throwaway config/state
// directories. Nothing leaves 127.0.0.1: the redirect preload
// (rehearsal/fetch-redirect.mjs) refuses every other destination, in the harness
// AND in the server child it spawns.
//
// What it proves: the harness's plumbing — env validation, spawn, plan/apply,
// markers, sweeps, escape hatch, cleanup, verdicts, exit codes — works end to end
// against Graph-shaped answers. What it does NOT prove: anything about the real
// Graph. A green rehearsal is not a green smoke run.
//
// The fake answers anything it does not model with an error AND records it; a
// rehearsal with an unmodelled route fails even when run.mjs exits 0, so a smoke
// can never pass here by accident.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startFakeGraph } from './rehearsal/fake-graph.mjs';
import { REHEARSAL_GRAPH_VAR } from './rehearsal/fetch-redirect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const RUN = join(HERE, 'run.mjs');
const PRELOAD = pathToFileURL(join(HERE, 'rehearsal', 'fetch-redirect.mjs')).href;

/** Operator approval the server and the harness must agree on (≥16 chars). */
export const REHEARSAL_CONFIRM_TOKEN = 'rehearsal-confirm-token-0000';

/** The smallest bytes that look like an MP4 (an `ftyp` box) — the fake never decodes it. */
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'latin1'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom', 'latin1'),
  Buffer.alloc(1024),
]);

/**
 * Build the child environment from scratch: nothing of the caller's shell leaks
 * in (no real token, no real config dir), only what a run needs.
 */
export function rehearsalEnv({ origin, fake, dirs }) {
  const env = {
    PATH: process.env.PATH ?? '',
    FB_SMOKE: '1',
    FB_SYSTEM_TOKEN: fake.tokens.system,
    FB_SMOKE_TEST_PAGE_ID: fake.ids.testPageId,
    FB_SMOKE_TEST_PAGE_TOKEN: fake.tokens.testPage,
    FB_SMOKE_PAGE_ID: fake.ids.readPageId,
    FB_SMOKE_PAGE_TOKEN: fake.tokens.readPage,
    FB_CONFIRM_TOKEN: REHEARSAL_CONFIRM_TOKEN,
    FB_SMOKE_PHOTO_URL: 'https://example.com/rehearsal-photo.jpg',
    FB_SMOKE_REEL_PATH: dirs.reel,
    FB_MEDIA_DIR: dirs.media,
    FB_AD_ACCOUNT_ID: fake.ids.adAccountId,
    // Isolation: the server reads its .env and journal from these, never from
    // the operator's real ~/.config or ~/.local/state.
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_STATE_HOME: dirs.state,
    APPDATA: dirs.config,
    LOCALAPPDATA: dirs.state,
    TMPDIR: dirs.tmp,
    // The seam: every process in the tree preloads the redirect.
    NODE_OPTIONS: `--import ${PRELOAD}`,
    FB_SMOKE_REHEARSAL_PRELOAD: '1',
    [REHEARSAL_GRAPH_VAR]: origin,
  };
  for (const name of [
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

/**
 * Run one rehearsal. Resolves with the harness's exit code, its output and the
 * fake's request log; never throws for a failing smoke (that is data).
 *
 * @param {{ args?: string[], timeoutMs?: number, echo?: boolean }} [opts]
 */
export async function rehearse({ args = [], timeoutMs = 120_000, echo = false } = {}) {
  const fake = await startFakeGraph();
  const root = mkdtempSync(join(tmpdir(), 'fb-smoke-rehearsal-'));
  const dirs = {
    home: join(root, 'home'),
    config: join(root, 'config'),
    state: join(root, 'state'),
    media: join(root, 'media'),
    tmp: join(root, 'tmp'),
    reel: join(root, 'media', 'rehearsal-reel.mp4'),
  };
  for (const dir of [dirs.home, dirs.config, dirs.state, dirs.media, dirs.tmp]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(dirs.reel, FAKE_MP4);

  const env = rehearsalEnv({ origin: fake.origin, fake, dirs });
  const argv = [RUN, '--include-budget', '--timeout', '30000', ...args];

  try {
    const result = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, argv, {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (echo) process.stdout.write(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (echo) process.stderr.write(chunk);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        rejectRun(new Error(`rehearsal did not finish within ${timeoutMs} ms`));
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        rejectRun(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolveRun({ code: code ?? (signal === null ? 1 : 128), stdout, stderr });
      });
    });
    return {
      ...result,
      requests: [...fake.requests],
      unhandled: [...fake.unhandled],
      ids: fake.ids,
    };
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** One line per distinct `METHOD host path-shape`, digits collapsed. */
export function summarizeRequests(requests) {
  const counts = new Map();
  for (const request of requests) {
    const shape = `${request.method} ${request.host} ${request.path.replace(/\d{6,}/g, '<id>')}`;
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([shape, count]) => `${String(count).padStart(4)}  ${shape}`);
}

async function main() {
  const result = await rehearse({
    args: process.argv.slice(2),
    echo: true,
    timeoutMs: 600_000,
  });
  console.log('');
  console.log(`rehearsal: the fake Graph answered ${result.requests.length} request(s):`);
  for (const line of summarizeRequests(result.requests)) console.log(line);
  if (result.unhandled.length > 0) {
    console.log('');
    console.log(
      `rehearsal FAILED: ${result.unhandled.length} request(s) the fake does not model:`,
    );
    for (const line of summarizeRequests(result.unhandled)) console.log(line);
    return result.code === 0 ? 1 : result.code;
  }
  console.log(`rehearsal: run.mjs exited ${result.code}`);
  return result.code;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exitCode = 1;
    },
  );
}

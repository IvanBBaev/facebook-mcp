// Wait pacing for the smokes' eventual-consistency delays.
//
// Against the real Graph a smoke waits seconds between polls because Graph is
// read-your-writes only eventually. Against the rehearsal's fake Graph
// (rehearse.mjs) every write is visible immediately and the waits are pure dead
// time, so a rehearsal scales them to zero. The scale is 0 ONLY when BOTH
// rehearsal switches are set and the Graph origin is a loopback address — the
// same gate the redirect preload enforces — so a live run can never have its
// waits shortened by a stray variable.

import {
  parseRehearsalOrigin,
  REHEARSAL_GRAPH_VAR,
} from './rehearsal/fetch-redirect.mjs';

/**
 * 0 inside a gated rehearsal, 1 everywhere else. Pure over `env`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {0 | 1}
 */
export function delayScale(env = process.env) {
  if (env.FB_SMOKE_REHEARSAL_PRELOAD !== '1') return 1;
  try {
    parseRehearsalOrigin(env[REHEARSAL_GRAPH_VAR]);
  } catch {
    return 1;
  }
  return 0;
}

/**
 * A smoke's delay after pacing: `ms` on a live run, 0 in a rehearsal.
 *
 * @param {number} ms
 * @param {NodeJS.ProcessEnv} [env]
 */
export function paced(ms, env = process.env) {
  return ms * delayScale(env);
}

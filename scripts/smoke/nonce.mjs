// Run marker helpers for the live smoke harness (CC-LIFE-3).
//
// Every artifact a smoke creates on the test Page carries a visible marker of
// the form `[FBMCP-SMOKE <nonce>]` inside a field a human can read back from
// the Graph API (a post message, a comment body, an ad-set name, ...). The
// marker is what makes cleanup possible at all: the sweeper does not keep a
// local ledger of what was created — it re-reads the test Page and deletes
// whatever carries the marker. That survives a crashed run, a killed process
// and a smoke that never got to its own cleanup block.
//
// The nonce is per RUN, not per artifact, and is sortable: a leftover artifact
// tells you at a glance which run produced it and when.

import { randomBytes } from 'node:crypto';

/** Literal prefix every marker starts with. Never change it — old leftovers. */
export const MARKER_PREFIX = 'FBMCP-SMOKE';

/**
 * Matches a marker anywhere inside a string and captures the nonce.
 * Deliberately global-free so `.exec` stays stateless across calls.
 */
export const MARKER_RE = new RegExp(`\\[${MARKER_PREFIX} ([A-Za-z0-9-]{1,64})\\]`);

/**
 * Build a fresh run nonce, e.g. `20260802t2215z-a1b2c3`. Only characters that
 * are safe inside {@link MARKER_RE}, safe in a Graph API string field and safe
 * in a shell argument.
 */
export function createNonce(now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'z')
    .toLowerCase();
  return `${stamp.slice(0, 13)}z-${randomBytes(3).toString('hex')}`;
}

/** The exact marker string for a run nonce. */
export function markerFor(nonce) {
  return `[${MARKER_PREFIX} ${nonce}]`;
}

/**
 * Append the run marker to a piece of text. Smokes call this (via
 * `ctx.mark(...)`) for every human-visible string they send to the API.
 */
export function mark(text, nonce) {
  return `${text} ${markerFor(nonce)}`;
}

/**
 * Return the nonce carried by any marker found in `value`, or `undefined`.
 * Walks strings, arrays and plain objects so a caller can hand over a whole
 * Graph node without knowing which field the marker landed in.
 */
export function findMarkerNonce(value, depth = 0) {
  if (typeof value === 'string') {
    return MARKER_RE.exec(value)?.[1];
  }
  if (depth >= 6 || value === null || typeof value !== 'object') {
    return undefined;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findMarkerNonce(item, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** True when `value` carries any smoke marker (from this run or an older one). */
export function isMarked(value) {
  return findMarkerNonce(value) !== undefined;
}

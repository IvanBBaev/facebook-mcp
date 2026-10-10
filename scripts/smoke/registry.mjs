// The smoke registration API.
//
// A vertical owner (V01…V10) never edits the runner. They drop one file into
// `scripts/smoke/smokes/` that calls `registerSmoke({...})` at module scope,
// and — if their vertical can leave artifacts behind — one file into
// `scripts/smoke/sweepers/` that calls `registerSweeper({...})`. The runner
// discovers both directories, validates every registration, applies the CLI
// selection and executes what survives.
//
// Registration is validated eagerly and strictly: a malformed or unsafe
// registration is a hard error at load time, before the gate is even checked,
// so a typo can never silently downgrade write safety (e.g. a smoke that
// creates artifacts but forgets to declare `writes: true` and would therefore
// be pointed at the read Page).

import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Valid `phase` values — the roadmap's phase gates (doc 08). */
const PHASES = [0, 1, 2, 3, 4, 5];

/**
 * The roadmap phase that first ships each tool package (doc 08, "Phase N"
 * headings). A smoke cannot run before the package it loads exists, so this is
 * also the FLOOR for its `phase` tag — see the check in {@link registerSmoke}.
 *
 * `core` is phase 0 (the skeleton), `reader`/`insights` phase 1, `posts`
 * phase 2 (publishing, including `facebook_get_video_status` — CC-MEDIA-7),
 * `moderation`/`messages` phase 3, `ads` phase 5 (Phase 4 is distribution and
 * ships no tools of its own).
 */
const PACKAGE_PHASE = {
  core: 0,
  reader: 1,
  insights: 1,
  posts: 2,
  moderation: 3,
  messages: 3,
  ads: 5,
};

/** Valid `page` values: which Page the smoke is allowed to touch. */
const PAGES = ['none', 'read', 'test'];

/** Valid `budget` values: which finite live quota the smoke consumes. */
const BUDGETS = ['reels', 'ads'];

/** The keys of an `effects` declaration, in display order. */
export const EFFECT_KEYS = Object.freeze(['creates', 'cleansUp', 'leaves']);

/** The normalised `effects` of a smoke that changes no remote state. */
const NO_EFFECTS = Object.freeze({
  creates: Object.freeze([]),
  cleansUp: Object.freeze([]),
  leaves: Object.freeze([]),
});

const smokes = new Map();
const sweepers = new Map();

/** Raised for an invalid registration or an unknown CLI selector. */
export class SmokeRegistrationError extends Error {
  name = 'SmokeRegistrationError';
}

function requireString(spec, field, where) {
  const value = spec[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SmokeRegistrationError(`${where}: "${field}" must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(spec, field, where) {
  const value = spec[field];
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item === '')
  ) {
    throw new SmokeRegistrationError(
      `${where}: "${field}" must be an array of non-empty strings`,
    );
  }
  return [...value];
}

/**
 * Validate and normalise a smoke's `effects` declaration — the one place that
 * says, in words an operator can act on, what the smoke does to the REAL Page or
 * ad account. `--plan` prints it verbatim, so it is declared next to the code
 * that does the writing instead of in a parallel table that drifts.
 *
 *  - `'none'` — the smoke creates and changes nothing (required for, and only
 *    allowed on, `writes: false`);
 *  - `{ creates, cleansUp, leaves }` — three arrays of one-line strings, every
 *    key present (an empty array is a statement, a missing key is a typo).
 *    `creates` must name at least one artifact, and every run that creates
 *    something must say how it ends: cleaned up, left behind, or both.
 */
function normaliseEffects(spec, writes, where) {
  const value = spec.effects;
  const shape =
    `"effects" must be 'none' (creates nothing) or ` +
    `{ ${EFFECT_KEYS.join(', ')} } — arrays of one-line strings`;
  if (value === undefined) {
    throw new SmokeRegistrationError(`${where}: ${shape}; it is required`);
  }
  if (value === 'none') {
    if (writes) {
      throw new SmokeRegistrationError(
        `${where}: a smoke with writes:true cannot declare effects:'none' — say what it creates`,
      );
    }
    return NO_EFFECTS;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SmokeRegistrationError(`${where}: ${shape}`);
  }
  const extra = Object.keys(value).filter((key) => !EFFECT_KEYS.includes(key));
  if (extra.length > 0) {
    throw new SmokeRegistrationError(
      `${where}: unknown "effects" key(s) ${extra.join(', ')} — expected ${EFFECT_KEYS.join(', ')}`,
    );
  }
  const effects = {};
  for (const key of EFFECT_KEYS) {
    const list = value[key];
    if (
      !Array.isArray(list) ||
      list.some((item) => typeof item !== 'string' || item.trim() === '')
    ) {
      throw new SmokeRegistrationError(
        `${where}: "effects.${key}" must be an array of non-empty strings (use [] for none)`,
      );
    }
    effects[key] = Object.freeze(list.map((item) => item.trim()));
  }
  if (!writes) {
    throw new SmokeRegistrationError(
      `${where}: a smoke with writes:false must declare effects:'none' — if it creates ` +
        'something, it writes',
    );
  }
  if (effects.creates.length === 0) {
    throw new SmokeRegistrationError(
      `${where}: "effects.creates" is empty, but the smoke declares writes:true`,
    );
  }
  if (effects.cleansUp.length === 0 && effects.leaves.length === 0) {
    throw new SmokeRegistrationError(
      `${where}: "effects" names what the smoke creates but neither how it is cleaned up ` +
        'nor what is left behind',
    );
  }
  return Object.freeze(effects);
}

/**
 * Register one live smoke.
 *
 * ```js
 * registerSmoke({
 *   id: 'reader/timeline',        // required, unique, "<vertical>/<name>"
 *   phase: 1,                     // required, 0–5 — the roadmap phase gate
 *   title: 'Read the timeline',   // required, one line, shown in --list
 *   page: 'read',                 // 'none' | 'read' | 'test' (default: writes ? 'test' : 'read')
 *   writes: false,                // creates/changes remote state? (default false)
 *   budget: null,                 // null | 'reels' | 'ads' — opt-in via --include-budget
 *   packages: ['reader'],         // FB_TOOL_PACKAGES the server must load
 *   requires: [],                 // extra env var names that must be set
 *   run: async (ctx) => { ... },  // required
 * });
 * ```
 *
 * Invariants enforced here:
 *  - `writes: true` ⇒ `page: 'test'`. A smoke can never write to the read Page.
 *  - `effects` is declared by every smoke, and agrees with `writes` (see
 *    {@link normaliseEffects}) — it is what `--plan` tells the operator.
 *  - `budget` ⇒ the smoke is excluded from the default run (opt-in only) and
 *    labelled as quota-consuming everywhere it is printed.
 *  - ids are unique across all smoke files.
 */
export function registerSmoke(spec) {
  if (spec === null || typeof spec !== 'object') {
    throw new SmokeRegistrationError('registerSmoke(spec): spec must be an object');
  }
  const id = requireString(spec, 'id', 'registerSmoke');
  const where = `smoke "${id}"`;
  if (smokes.has(id)) {
    throw new SmokeRegistrationError(`${where}: duplicate id`);
  }
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new SmokeRegistrationError(
      `${where}: id must look like "<vertical>/<name>" (lowercase)`,
    );
  }
  if (!PHASES.includes(spec.phase)) {
    throw new SmokeRegistrationError(
      `${where}: "phase" must be one of ${PHASES.join(', ')}`,
    );
  }
  const title = requireString(spec, 'title', where);
  if (typeof spec.run !== 'function') {
    throw new SmokeRegistrationError(`${where}: "run" must be an async function`);
  }
  const writes = spec.writes === true;
  const page = spec.page ?? (writes ? 'test' : 'read');
  if (!PAGES.includes(page)) {
    throw new SmokeRegistrationError(
      `${where}: "page" must be one of ${PAGES.join(', ')}`,
    );
  }
  if (writes && page !== 'test') {
    throw new SmokeRegistrationError(
      `${where}: a smoke with writes:true must declare page:'test' — writes never go anywhere else`,
    );
  }
  const budget = spec.budget ?? null;
  if (budget !== null && !BUDGETS.includes(budget)) {
    throw new SmokeRegistrationError(
      `${where}: "budget" must be null or one of ${BUDGETS.join(', ')}`,
    );
  }
  const packages = optionalStringArray(spec, 'packages', where);
  for (const name of packages) {
    if (!(name in PACKAGE_PHASE)) {
      throw new SmokeRegistrationError(
        `${where}: unknown package "${name}" — expected one of ${Object.keys(PACKAGE_PHASE).join(', ')}`,
      );
    }
  }
  // The phase tag drives `--phase n`, so a stale one silently hides a smoke from
  // the gate that is supposed to run it: tagging a `posts` smoke phase 1 means
  // `--phase 2` — the publishing exit gate — never executes it, and `--phase 1`
  // runs a smoke against tools that phase has not shipped. The floor is
  // mechanical (a smoke cannot precede the package it loads), so it is checked
  // rather than trusted. A HIGHER tag is legitimate: a later phase may re-smoke
  // an earlier package as part of its own gate.
  const floor = Math.max(0, ...packages.map((name) => PACKAGE_PHASE[name]));
  if (spec.phase < floor) {
    const owner = packages.find((name) => PACKAGE_PHASE[name] === floor);
    throw new SmokeRegistrationError(
      `${where}: phase ${spec.phase} precedes package "${owner}", which ships in phase ${floor}`,
    );
  }
  const effects = normaliseEffects(spec, writes, where);
  const entry = Object.freeze({
    id,
    phase: spec.phase,
    title,
    page,
    writes,
    budget,
    packages,
    requires: optionalStringArray(spec, 'requires', where),
    effects,
    run: spec.run,
  });
  smokes.set(id, entry);
  return entry;
}

/**
 * Register one sweeper — the cleanup half of the contract (CC-LIFE-3).
 *
 * ```js
 * registerSweeper({
 *   id: 'posts',                       // required, unique
 *   title: 'Marked Page posts',        // required, one line
 *   packages: ['reader', 'posts'],     // FB_TOOL_PACKAGES the sweep needs
 *   sweep: async (ctx) => [ ... ],     // required → array of SweepItem
 * });
 * ```
 *
 * `sweep` re-reads the TEST Page, finds everything carrying any smoke marker
 * (not just this run's — an older leftover is exactly what we are hunting) and
 * tries to delete it. It returns one record per marked artifact it found:
 *
 * ```js
 * { kind: 'post', id: '123_456', nonce: '20260802t2215z-a1b2c3',
 *   deleted: true, reason: undefined, label: 'scheduled post' }
 * ```
 *
 * It must NOT throw for an artifact it could not delete — it records
 * `deleted: false` with a `reason`, so the run can report the leak precisely.
 */
export function registerSweeper(spec) {
  if (spec === null || typeof spec !== 'object') {
    throw new SmokeRegistrationError('registerSweeper(spec): spec must be an object');
  }
  const id = requireString(spec, 'id', 'registerSweeper');
  const where = `sweeper "${id}"`;
  if (sweepers.has(id)) {
    throw new SmokeRegistrationError(`${where}: duplicate id`);
  }
  if (typeof spec.sweep !== 'function') {
    throw new SmokeRegistrationError(`${where}: "sweep" must be an async function`);
  }
  const entry = Object.freeze({
    id,
    title: requireString(spec, 'title', where),
    packages: optionalStringArray(spec, 'packages', where),
    sweep: spec.sweep,
  });
  sweepers.set(id, entry);
  return entry;
}

/** Every registered smoke, in id order. */
export function listSmokes() {
  return [...smokes.values()].sort(
    (a, b) => a.phase - b.phase || a.id.localeCompare(b.id),
  );
}

/** Every registered sweeper, in id order. */
export function listSweepers() {
  return [...sweepers.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Test seam: forget every registration (the runner never needs this). */
export function resetRegistry() {
  smokes.clear();
  sweepers.clear();
}

/**
 * Import every `*.smoke.mjs` / `*.sweep.mjs` file under `dir`. Missing
 * directories are not an error — a fresh checkout may have no sweepers yet.
 */
export async function loadModules(dir, suffix) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
  for (const file of files) {
    await import(pathToFileURL(file).href);
  }
  return files;
}

/**
 * Apply the CLI selection to the registered smokes.
 *
 * Selection rules:
 *  - no `--only` and no `--phase` ⇒ every smoke,
 *  - `--only a,b` ⇒ exactly those ids (unknown id ⇒ hard error, never a silent
 *    empty run),
 *  - `--phase n` ⇒ every smoke of that phase,
 *  - budget-consuming smokes are dropped unless `--include-budget` is given,
 *    EXCEPT when named explicitly by `--only` (naming it is the opt-in).
 */
export function selectSmokes({ only = [], phases = [], includeBudget = false } = {}) {
  return selectFrom(listSmokes(), { only, phases, includeBudget });
}

/**
 * {@link selectSmokes} over an explicit list instead of the registry — the pure
 * core, shared with `--plan` so the plan and the run can never disagree about
 * what is selected.
 */
export function selectFrom(all, { only = [], phases = [], includeBudget = false } = {}) {
  const known = new Set(all.map((smoke) => smoke.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new SmokeRegistrationError(
      `unknown smoke id(s): ${unknown.join(', ')} — run with --list to see what exists`,
    );
  }
  const byPhase =
    phases.length === 0 ? all : all.filter((smoke) => phases.includes(smoke.phase));
  if (only.length > 0) {
    const wanted = new Set(only);
    return { selected: all.filter((smoke) => wanted.has(smoke.id)), skipped: [] };
  }
  const selected = [];
  const skipped = [];
  for (const smoke of byPhase) {
    if (smoke.budget !== null && !includeBudget) {
      skipped.push({
        smoke,
        reason: `consumes the live ${smoke.budget} budget — pass --include-budget or --only ${smoke.id}`,
      });
      continue;
    }
    selected.push(smoke);
  }
  return { selected, skipped };
}

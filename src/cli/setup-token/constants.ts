// Constants of the `setup-token` flow: the public env-var name, the required
// scope list, the System-User guidance text, and the internal time and paging
// limits shared by the flow and the report renderer.

import { DEFAULT_LAUNCH_COMMAND, subcommandHint } from '../../mcp/launch-command.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Env var carrying the pasted short-lived token (preferred over an argument). */
export const SETUP_TOKEN_ENV_VAR = 'FB_SETUP_TOKEN';

/**
 * The command the report ends with when the launch form is unknown. The real
 * report names the form the operator actually used (see
 * {@link SetupTokenDeps.launchCommand}): `facebook-mcp` is only on PATH after a
 * global install, and an npx user told to run it gets "command not found".
 */
export const SETUP_NEXT_COMMAND = subcommandHint(DEFAULT_LAUNCH_COMMAND, 'doctor');

/**
 * Scopes without which the flow cannot complete at all: `/me/accounts` needs
 * `pages_show_list`, so a token missing it can neither list Pages nor derive a
 * Page token. Package scopes (`pages_manage_posts`, `read_insights`, …) are NOT
 * in this list — a token missing them still yields a working install with a
 * smaller tool surface, so they are reported as warnings naming the exact scope
 * and the exact package, not as a refusal.
 */
export const REQUIRED_SETUP_SCOPES: readonly string[] = ['pages_show_list'];

/** How the operator mints the only genuinely non-expiring credential (doc 04). */
export const SYSTEM_USER_GUIDANCE =
  'A System-User token is the ONLY non-expiring option: claim the app into a ' +
  'Business portfolio, create an admin system user, assign the Page (and ad ' +
  'account) as assets, generate the token, then set FB_SYSTEM_TOKEN. Meta still ' +
  'recommends the 60-day expiring variant plus scheduled rotation.';

/**
 * The widest epoch (ms) a JavaScript `Date` can represent: ±100,000,000 days
 * from 1970. Beyond it `new Date(ms)` is an Invalid Date, so a value past this
 * bound is not a very distant expiry — it is not a date at all.
 */
export const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** `expires_in` Graph returns for a long-lived user token (~60 days), in seconds. */
export const LONG_LIVED_SECONDS = 60 * 24 * 60 * 60;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_MINUTE = 60 * 1000;

/**
 * `/me/accounts` page size. The flow reads exactly one page — no cursor is
 * followed — so this is also the hard ceiling on the Pages it can discover or
 * pin with `--page=<id>`; beyond it the operator is told the listing was cut,
 * never that their Page does not exist.
 */
export const PAGE_LIST_LIMIT = 100;

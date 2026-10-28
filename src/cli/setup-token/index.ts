// `facebook-mcp setup-token` — the guided onboarding subcommand (task R05).
//
// Meta onboarding is the single biggest drop-off in this project: create an app,
// tick the right scopes in the Graph API Explorer, exchange the short-lived user
// token server-side, walk `/me/accounts` to find the Page, derive a Page token,
// and finally put four secrets in a file with the right permissions. This module
// collapses that into one command — three Graph calls (`/debug_token`,
// `/oauth/access_token`, `/me/accounts`, plus a fourth only when the listing
// omits the Page token) and an atomic 0600 file write — and reports every step
// honestly.
//
// Shape mirrors `doctor.ts` deliberately:
//
//   * `runSetupToken(deps)` is PURE and dependency-injected. It reads no argv, no
//     env, no process streams, and it NEVER throws for a credential problem — a
//     dead token, a missing scope, a refused overwrite are all REPORTED in the
//     returned {@link SetupTokenResult}. A broken credential must still produce a
//     readable explanation.
//   * `renderSetupTokenReport(result)` turns that result into operator-readable
//     text ending with the concrete next command (`doctor`, under the launch form the operator used).
//   * `parseSetupTokenArgs(argv, env)` is the (equally pure) argument reader, so
//     the bootstrap's wiring stays three statements and the process concerns
//     (argv, stderr, exit codes) stay entirely in the bootstrap.
//
// Secret discipline (doc 04):
//   * The pasted token is registered with the value-based redactor the moment it
//     exists, before any Graph call or log, so it can never survive an error
//     message. Same for the long-lived token and every derived Page token.
//   * NO token value ever enters the result or the rendered report — only key
//     NAMES, the file path, and metadata. The only place a token value lands is
//     the env file itself, written through `core`'s atomic 0600 helper.
//   * Passing the token as a shell ARGUMENT makes it visible in the process list;
//     the parser flags that and points at `FB_SETUP_TOKEN` instead.
//
// Layer: `cli`. The implementation is split by responsibility —
// `constants.ts`, `types.ts`, `args.ts` (argument reader), `graph.ts` (Graph
// helpers), `env-file.ts` (persistence), `flow.ts` (`runSetupToken`) and
// `report.ts` (rendering). It imports the frozen `core` contracts and the
// `mcp` package/permission/launch-command tables. No `api` / `tools` import,
// no runtime Zod. `src/mcp/setup-token.ts` re-exports this module as a facade.

export { parseSetupTokenArgs } from './args.js';
export {
  REQUIRED_SETUP_SCOPES,
  SETUP_NEXT_COMMAND,
  SETUP_TOKEN_ENV_VAR,
  SYSTEM_USER_GUIDANCE,
} from './constants.js';
export { renderEnvFile } from './env-file.js';
export { runSetupToken } from './flow.js';
export { renderSetupTokenReport } from './report.js';
export type * from './types.js';

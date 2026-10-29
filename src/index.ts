// Server bootstrap (task I1) — the integration seam that ties the
// `core <- api <- mcp <- tools` stack into one runnable MCP server.
//
// Two entry points, kept apart so the wiring is unit-testable without a process:
//
//   * `buildServer(deps)` — a pure, dependency-injected builder. It resolves the
//     active tool set via the registry, registers a `tools/list` + `tools/call`
//     handler pair on a low-level MCP `Server`, assembles a per-call
//     `ToolContext` (plus the write-gate + confirmer seam), emits the one
//     allowlisted log line the called spec authorizes, invokes the matching tool
//     handler and maps any thrown error to an error `ToolResult` through the
//     redaction choke-point. It never reads env, never touches process streams,
//     never opens a transport — a test drives it over an in-memory transport.
//
//   * `main()` — the real bootstrap. It resolves `Settings` from the environment,
//     constructs the concrete `core` collaborators, assembles the package array
//     (Wave-4 verticals slot in at the marked insertion point), then either runs
//     the `doctor` subcommand (diagnostics to STDERR, never stdout) or starts the
//     selected transport with SIGINT/SIGTERM graceful shutdown. It runs only when
//     this module is the process entry point.
//
// stdout is reserved for the stdio JSON-RPC channel (CC-CFG-1): every diagnostic
// here goes to stderr (the injected Logger) or, for the doctor report, to
// `process.stderr` explicitly. No secret ever leaves un-redacted — the redactor
// is the single value-based choke-point (C3). No AsyncLocalStorage: every
// capability a handler may touch arrives through the explicit `ToolContext` (C14).
//
// Layout (task I01): this file is the thin process-entry facade. The code lives
// in `src/server/*` — `handlers.ts` (buildServer), `schema.ts`, `progress.ts`,
// `elicitation.ts`, `errors.ts`, `version.ts`, `cli-args.ts`, `doctor.ts` and
// `bootstrap.ts` (main / runCli). The public export set is unchanged.

import { fileURLToPath } from 'node:url';

import { runCli } from './server/index.js';

export * from './server/index.js';

// Run only when this module is the process entry point (not on import — tests
// import `buildServer` without ever triggering the bootstrap).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCli();
}

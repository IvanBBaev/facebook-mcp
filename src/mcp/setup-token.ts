// Facade: the `setup-token` subcommand (reads `FB_SETUP_TOKEN`) lives in
// `src/cli/setup-token/`. This path re-exports it unchanged so every importer
// keeps working.

export * from '../cli/setup-token/index.js';

// F01 placeholder — replaced by F02/I1.
// Minimal entry so the scaffold builds end-to-end and bin/facebook-mcp.mjs has
// something to import. The real bootstrap (config load, transport wiring, tool
// registration) arrives with the Wave 1–3 tasks.

import { fileURLToPath } from 'node:url';

/**
 * No-op entry point. Intentionally empty until the server bootstrap lands.
 * Exported so tests can import this module without triggering any side effect.
 */
export function main(): void {
  // Placeholder — no behavior yet.
}

// Only run when invoked directly (e.g. through the bin launcher), never on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

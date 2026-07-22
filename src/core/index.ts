// Public contract surface barrel for the `core` layer (tasks F02 + F04–F09).
//
// Re-exports every frozen contract from `./types.js`, plus the concrete core
// implementations (config/settings, logging/redaction, error mapping, the
// fbRequest HTTP client, auth + the pages registry). Downstream layers import
// from `../core/index.js` (or a specific module). The in-memory fakes live
// under `./fakes/` and are imported directly by tests only — they are
// intentionally NOT part of this production barrel. The `api`-layer pagination
// helper (`../api/shared.js`, task F10) is likewise not re-exported here.

export * from './types.js';

// F04 — configuration & settings resolution.
export * from './config.js';
export * from './settings.js';

// F05 — stderr JSON logging + value-based redaction choke-point (C3).
export { createRedactor } from './redact.js';
export { createLogger, type LoggerConfig } from './log.js';

// F06 — error→action matrix (C2/C9).
export * from './error-matrix.js';
export * from './errors.js';

// F07 — fbRequest JSON/query protocol (Bearer + appsecret_proof, retry matrix).
export * from './http.js';

// F09 — auth (debug_token, per-page token resolver) + pages registry (C1/C14).
export * from './auth.js';
export * from './pages-registry.js';

// Public barrel for the `tools` layer — the top of the DAG (core ← api ← mcp ← tools).
//
// Each package module exports a factory that returns a `PackageSpec` (tools-as-data).
// The server bootstrap (task I1, `../index.js`) imports these factories, assembles the
// package array, and hands it to the registry. This barrel is owned by the integrator
// (task I1); vertical tasks (Wave 4: V01–V08) add their package export lines here as
// their modules land.

// F16 — core package: whoami / list_pages / get_page / usage (read-only).
export { createCorePackage } from './core.js';

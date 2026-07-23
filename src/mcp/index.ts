// Public contract surface barrel for the `mcp` layer (tasks F11–F15).
//
// Re-exports the MCP-facing building blocks: the `defineTool` authoring helper,
// the package manifest + profile expansion, the tool registry, the result
// shaper, and the tainted-UGC / out-of-band confirmation seam. The `tools`
// layer and the server bootstrap import from `../mcp/index.js`. This barrel is
// owned by the integrator (task I1); vertical tasks add their export lines here
// as their modules land.

// F11 — defineTool authoring helper + package manifest + tool registry (C5).
export * from './define.js';
export * from './packages.js';
export * from './registry.js';

// F12 — MCP result shaper: recursive token/paging strip, structure-aware
// truncation, server-owned envelope shaping (C3/CC-MCP-4/CC-MCP-7).
export * from './result.js';

// F13 — tiered plan-and-apply write gating + non-blocking rotating journal (C4).
export {
  createWriteGate,
  authorize,
  computeDivergence,
  WriteGateError,
  PLAN_TTL_MS,
  type WriteGate,
  type WriteGateDeps,
  type WriteAction,
  type WriteOutcome,
  type GateDecision,
  type AuthorizeInput,
  type WriteGateErrorCode,
} from './write-mode.js';
export {
  createJournal,
  rotatedJournalPath,
  JOURNAL_MAX_BYTES,
  type JournalDeps,
} from './journal.js';

// F15 — tainted-UGC envelope + out-of-band confirmation seam (B1).
export * from './taint.js';
export * from './confirm.js';

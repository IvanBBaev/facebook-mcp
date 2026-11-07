// Public contract surface for facebook-mcp (task F02).
//
// This file is the single source of truth for the shared TypeScript contracts
// that every downstream task (F04–F16, V01–V10) builds against. After Wave 1
// merges these shapes are FROZEN — changes go through the integration owner.
//
// Only shapes live here: interfaces, type aliases, a handful of contract
// constants, and the one concrete class that a contract requires to exist
// (`GraphApiError`, since an Error subclass cannot be an interface). All real
// implementations arrive in later tasks (the file names they own are noted at
// each section). `core` is layer 0 — this file imports nothing from api/, mcp/
// or tools/, and depends only on external packages (zod types, node built-ins).
//
// X08 (ARC-07) split the contracts by concern into `./types/`:
//   runtime.ts   Clock, Redactor, Logger
//   settings.ts  Settings and its parts
//   graph.ts     GraphApiError, FbRequest/FbResponse, Page resolution, pagination
//   tool.ts      ToolAnnotations, ToolResult, ToolContext, ToolSpec
//   packages.ts  PackageSpec, PACKAGE_NAMES (integration-owned)
//   write.ts     write tiers, plan/apply, Journal, taint, Confirmer
//   stores.ts    ActivityCursorStore, SavedReplyStore
// This path stays as a thin facade so every importer is unchanged.

export * from './types/index.js';

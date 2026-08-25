// Public barrel for the `tools` layer — the top of the DAG (core ← api ← mcp ← tools).
//
// Each package module exports a factory that returns a `PackageSpec` (tools-as-data).
// The server bootstrap (task I1, `../index.js`) imports these factories, assembles the
// package array, and hands it to the registry. This barrel is owned by the integrator
// (task I1); vertical tasks (Wave 4: V01–V08) add their package export lines here as
// their modules land.

// Shared authoring helpers consumed by every vertical package (Wave 4).
export * from './shared.js';

// F16 — core package: whoami / list_pages / get_page / usage (read-only).
export { createCorePackage } from './core.js';

// V01 — reader package: list_posts / get_post / list_reels / get_reactions (read-only).
export { createReaderPackage } from './reader.js';

// V02 — insights package: page_insights / post_insights / reel_insights (read-only).
// Reels metrics live on their own Graph edge and take a bare video id, so they are a
// separate tool rather than a branch inside post_insights (G-TOOL-2, doc 10 §2).
export { createInsightsPackage } from './insights.js';

// V07 — moderation package: comment listing, replies, hide/delete, private reply, blocking.
export { createModerationPackage } from './moderation.js';

// V08 — messages package: conversation listing/reading and Messenger sends.
export { createMessagesPackage } from './messages.js';

// V03 — posts package: publishing (text/link/photo/video/Reel), post lifecycle
// and the scheduled-post queue. Write-gated, plan-first.
export { createPostsPackage } from './posts.js';

// V09/V10 — ads package: campaign/ad-set/ad reads, insights (sync + async report
// runs) and plan-gated status/budget control. Off by default.
export { createAdsPackage } from './ads.js';

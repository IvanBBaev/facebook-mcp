// The `moderation` tool package — a thin facade. The implementation lives in
// `./moderation/` (split by responsibility; see `./moderation/index.ts`). This
// path stays so `./index.ts` and every importer keep working unchanged.

export * from './moderation/index.js';

// Facade for the `ads` tool package. The implementation lives in `./ads/`
// (split by responsibility: read, insights, control, targeting, image, copy);
// this path stays so `./index.ts` and every other importer keep working
// unchanged.

export * from './ads/index.js';

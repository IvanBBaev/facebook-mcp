// The `posts` tool package (task V03) — a thin facade over `./posts/`.
//
// The package is split by responsibility under `./posts/` (publish, media,
// lifecycle, queue, video-status plus their shared args/errors/context/outcomes
// helpers). This path stays so `./index.ts` and every importer are unchanged.

export * from './posts/index.js';

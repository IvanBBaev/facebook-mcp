// Public contract surface barrel for the `core` layer (task F02).
//
// Re-exports every frozen contract from `./types.js`. Downstream layers import
// contracts from `../core/index.js` (or `../core/types.js`); the in-memory
// fakes live under `./fakes/` and are imported directly by tests only — they
// are intentionally NOT part of this production barrel.

export * from './types.js';

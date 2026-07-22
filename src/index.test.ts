// F01 placeholder — replaced by F02/I1.
// Trivial smoke: proves the placeholder entry compiles, loads, and exposes a
// callable no-op main, so `npm run check` (build + test) passes end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from './index.js';

test('placeholder entry loads and exposes a no-op main', () => {
  assert.equal(typeof main, 'function');
  assert.doesNotThrow(() => {
    main();
  });
});

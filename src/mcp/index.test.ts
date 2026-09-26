// The `mcp` barrel is a contract, not a convenience re-export.
//
// The `tools` layer imports from `../mcp/index.js` and nothing else — reaching
// into `../mcp/write-mode.js` directly would put a second, unreviewed door into
// the layer. That rule only holds if everything a tool author legitimately needs
// actually comes out of the barrel, and a missing line here does not fail loudly:
// it just quietly forces the next author to write around it. `bulkVerdict` in
// `tools/moderation.ts` is the evidence — it returns an inline structural type
// because `WriteResultVerdict` had no name on this side of the wall.
//
// These tests are mostly a TYPE assertion: the annotations below do not compile
// unless the barrel exports the types they name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLIED_VERDICT,
  ATTEMPTED_VERDICT,
  REFUSED_VERDICT,
  type WriteAction,
  type WriteResultVerdict,
} from './index.js';

test('the barrel exports the write-result verdict a tool needs to classify a batch', () => {
  const verdict: WriteResultVerdict = APPLIED_VERDICT;
  assert.deepEqual(verdict, { outcome: 'applied', applied: true });
  assert.equal(
    Object.isFrozen(APPLIED_VERDICT),
    true,
    'the default verdict is shared by every action that does not classify its own result, ' +
      'so a mutation would rewrite history for all of them at once',
  );
});

test('an action can name its own classifyResult return type through the barrel', () => {
  // The shape a real bulk verb builds (CC-MOD-5): nothing landed, so the gate must
  // journal `failed`, and this annotation is what proves the type is reachable.
  const nothingLanded: WriteResultVerdict = { outcome: 'failed', applied: false };
  const action: Pick<WriteAction<string>, 'tool' | 'classifyResult'> = {
    tool: 'facebook_delete_comment',
    classifyResult: () => nothingLanded,
  };
  assert.equal(action.classifyResult?.('anything').applied, false);
});

test('the barrel exports the refused and the attempted verdicts a tool classifies with', () => {
  // `tools/posts.ts` and `tools/ads.ts` reach these through the barrel; a tool
  // that had to spell `{ outcome: 'failed', applied: false }` itself would be
  // one typo away from journaling a refusal as a change.
  const refused: WriteResultVerdict = REFUSED_VERDICT;
  const attempted: WriteResultVerdict = ATTEMPTED_VERDICT;
  assert.deepEqual(refused, { outcome: 'failed', applied: false });
  assert.deepEqual(attempted, { outcome: 'attempted', applied: false });
  assert.equal(Object.isFrozen(REFUSED_VERDICT), true);
  assert.equal(Object.isFrozen(ATTEMPTED_VERDICT), true);
});

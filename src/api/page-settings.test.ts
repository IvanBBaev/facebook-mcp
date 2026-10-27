// Tests for the Page moderation-settings wire layer (v2 moderation F12): the
// `/{page}/settings` read shape, the blocked-word delta, the order-insensitive
// fingerprint and the one-option-per-POST write. Placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbOk } from '../core/fakes/index.js';
import {
  applyBlockedWordsDelta,
  moderationFingerprint,
  parseBlockedWords,
  readModerationSettings,
  settingOption,
  shapeModerationSettings,
  writeModerationSetting,
} from './page-settings.js';

const PAGE_ID = '111222333';
const TOKEN = 'EAA-PAGE-TOKEN-0123456789';

test('parseBlockedWords splits the comma list and drops blanks', () => {
  assert.deepEqual(parseBlockedWords(' spam, scam ,,  '), ['spam', 'scam']);
  assert.deepEqual(parseBlockedWords(['spam', ' ', 42, 'scam ']), ['spam', 'scam']);
  assert.deepEqual(parseBlockedWords(undefined), []);
});

test('shapeModerationSettings reads the three settings and ignores the rest', () => {
  const shaped = shapeModerationSettings({
    data: [
      { setting: 'PAGE_MODERATION_BLACKLIST', value: 'spam,scam' },
      { setting: 'PROFANITY_FILTER', value: 'medium' },
      { setting: 'USERS_CAN_MESSAGE', value: true },
      { setting: 'SOMETHING_ELSE', value: 'x' },
      'not a row',
    ],
  });
  assert.deepEqual(shaped, {
    blockedWords: ['spam', 'scam'],
    blockedWordsKnown: true,
    profanityFilter: 'MEDIUM',
    usersCanMessage: true,
  });

  const empty = shapeModerationSettings({ data: [] });
  assert.equal(empty.blockedWordsKnown, false);
  assert.equal(empty.profanityFilter, null);
  assert.equal(empty.usersCanMessage, null);
});

test('applyBlockedWordsDelta is case-insensitive, keeps order and reports no-ops', () => {
  const delta = applyBlockedWordsDelta(['Spam', 'scam', 'promo'], {
    add: ['SPAM', ' crypto ', 'crypto', 'giveaway'],
    remove: ['PROMO', 'missing'],
  });
  assert.deepEqual(delta.next, ['Spam', 'scam', 'crypto', 'giveaway']);
  assert.deepEqual(delta.added, ['crypto', 'giveaway']);
  assert.deepEqual(delta.removed, ['promo']);
  assert.deepEqual(delta.alreadyPresent, ['SPAM']);
  assert.deepEqual(delta.notPresent, ['missing']);
});

test('applyBlockedWordsDelta re-adds a word removed in the same call', () => {
  const delta = applyBlockedWordsDelta(['spam'], { add: ['spam'], remove: ['spam'] });
  assert.deepEqual(delta.next, ['spam']);
  assert.deepEqual(delta.removed, ['spam']);
  assert.deepEqual(delta.added, ['spam']);
});

test('the fingerprint ignores order and case but not content or the filter', () => {
  const base = {
    blockedWords: ['spam', 'Scam'],
    blockedWordsKnown: true,
    profanityFilter: 'MEDIUM' as const,
    usersCanMessage: true,
  };
  const same = moderationFingerprint({ ...base, blockedWords: ['scam', 'SPAM'] });
  assert.deepEqual(moderationFingerprint(base), same);
  assert.notDeepEqual(
    moderationFingerprint(base),
    moderationFingerprint({ ...base, blockedWords: ['spam'] }),
  );
  assert.notDeepEqual(
    moderationFingerprint(base),
    moderationFingerprint({ ...base, profanityFilter: 'STRONG' }),
  );
});

test('settingOption builds one option per setting', () => {
  assert.deepEqual(settingOption({ setting: 'blocked_words', words: ['a', 'b c'] }), {
    PAGE_MODERATION_BLACKLIST: 'a,b c',
  });
  assert.deepEqual(settingOption({ setting: 'profanity_filter', level: 'STRONG' }), {
    PROFANITY_FILTER: 'STRONG',
  });
});

test('read is a GET of /{page}/settings with the Page token', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ data: [{ setting: 'PROFANITY_FILTER', value: 'OFF' }] }));
  const settings = await readModerationSettings(fb.fn, { pageId: PAGE_ID, token: TOKEN });
  assert.equal(settings.profanityFilter, 'OFF');
  const req = fb.lastRequest();
  assert.equal(req?.method, 'GET');
  assert.equal(req?.path, `/${PAGE_ID}/settings`);
  assert.equal(req?.token, TOKEN);
});

test('write POSTs the option and reads the confirmation', async () => {
  const cases: readonly [unknown, boolean][] = [
    [{ success: true }, true],
    [true, true],
    [{}, true],
    [{ success: false }, false],
    ['ok', false],
  ];
  for (const [answer, confirmed] of cases) {
    const fb = createFakeFbRequest();
    fb.on(() => true, fbOk(answer));
    const option = { PROFANITY_FILTER: 'STRONG' };
    const got = await writeModerationSetting(fb.fn, {
      pageId: PAGE_ID,
      token: TOKEN,
      option,
    });
    assert.equal(got, confirmed, `answer ${JSON.stringify(answer)}`);
    const req = fb.lastRequest();
    assert.equal(req?.method, 'POST');
    assert.equal(req?.path, `/${PAGE_ID}/settings`);
    assert.equal(req?.protocol, 'json');
    assert.deepEqual(req.body, { option });
  }
});

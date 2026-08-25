import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbOk, fbErr } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, FbRequestFn, FbResponse, ParamValue } from '../core/index.js';

import {
  fetchAll,
  fetchPage,
  isCursorExpiryError,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_MAX_PAGES,
  CURSOR_EXPIRED_NOTE,
  LOOP_GUARD_NOTE,
  MISSING_CURSOR_NOTE,
  type EdgeRequest,
} from './shared.js';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const EDGE: EdgeRequest = { host: 'graph', path: '/123/feed' };

interface Item {
  readonly id: string;
}

function items(...ids: string[]): Item[] {
  return ids.map((id) => ({ id }));
}

/** A Graph list page whose `paging.next` carries the opaque `after` cursor. */
function pageWithNext(data: unknown[], after: string): unknown {
  return {
    data,
    paging: {
      next: `https://graph.facebook.com/v19.0/123/feed?after=${after}&limit=25`,
      cursors: { after },
    },
  };
}

/** A terminal page — no `paging.next`, so iteration ends here. */
function lastPage(data: unknown[]): unknown {
  return { data, paging: { cursors: { before: 'b0' } } };
}

function cursorExpiredWithAction(): GraphApiError {
  return new GraphApiError('Please provide a valid cursor', {
    code: 100,
    subcode: 33,
    httpStatus: 400,
    action: {
      category: 'cursor_expired',
      retryable: false,
      operatorText: 'restart the listing',
    },
  });
}

function cursorExpiredByMessage(): GraphApiError {
  return new GraphApiError('Cursor is no longer valid', { code: 1, httpStatus: 400 });
}

/** Narrow a captured request to a JSON request and read its query params. */
function paramsOf(call: FbRequest | undefined): Record<string, ParamValue> {
  assert.ok(call, 'expected a captured request');
  assert.equal(call.protocol, 'json');
  const params = 'params' in call ? call.params : undefined;
  return { ...(params ?? {}) };
}

// Deterministic PRNG (mulberry32) for the seeded termination property test.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Adversary {
  readonly fn: FbRequestFn;
  count(): number;
}

/**
 * A synthetic `FbRequestFn` that never consults the request — it manufactures an
 * endless (or scripted) stream of pages. Used to prove termination against page
 * sequences that would loop forever if the helper trusted the wire.
 */
function makeAdversary(config: {
  rng?: () => number;
  alwaysNext: boolean;
  emptyData?: boolean;
  repeatCursor?: boolean;
  expiryProb?: number;
}): Adversary {
  let n = 0;
  const fn: FbRequestFn = <T = unknown>(): Promise<FbResponse<T>> => {
    n += 1;
    const roll = config.rng ? config.rng() : 0.5;
    if (config.expiryProb !== undefined && roll < config.expiryProb) {
      return Promise.reject(cursorExpiredByMessage());
    }
    const dataLen = config.emptyData
      ? 0
      : Math.floor((config.rng ? config.rng() : 0.5) * 4);
    const data = Array.from({ length: dataLen }, (_v, i) => ({
      id: `p${String(n)}-${String(i)}`,
    }));
    const hasNext = config.alwaysNext ? true : config.rng ? config.rng() < 0.85 : true;
    const cursor = config.repeatCursor ? 'stuck' : `c${String(n)}`;
    const body = hasNext
      ? {
          data,
          paging: {
            next: `https://graph.facebook.com/e?after=${cursor}`,
            cursors: { after: cursor },
          },
        }
      : { data };
    return Promise.resolve({ data: body as unknown as T, headers: {}, status: 200 });
  };
  return { fn, count: () => n };
}

// ---------------------------------------------------------------------------
// isCursorExpiryError predicate
// ---------------------------------------------------------------------------

test('isCursorExpiryError: recognizes the F06 action category and a message heuristic', () => {
  assert.equal(isCursorExpiryError(cursorExpiredWithAction()), true);
  assert.equal(isCursorExpiryError(cursorExpiredByMessage()), true);
  // Not a cursor error.
  assert.equal(
    isCursorExpiryError(new GraphApiError('Rate limit', { code: 4, httpStatus: 400 })),
    false,
  );
  // Not a GraphApiError at all.
  assert.equal(isCursorExpiryError(new Error('cursor expired')), false);
  assert.equal(isCursorExpiryError('cursor expired'), false);
});

// ---------------------------------------------------------------------------
// fetchPage — single page (default), cursor in/out, defaults
// ---------------------------------------------------------------------------

test('fetchPage: returns one page with a nextCursor and applies the default limit', async () => {
  const fake = createFakeFbRequest();
  fake.enqueue(fbOk(pageWithNext(items('a', 'b'), 'CUR1')));

  const page = await fetchPage<Item>(fake.fn, EDGE);
  assert.deepEqual([...page.data], items('a', 'b'));
  assert.equal(page.truncated, false);
  assert.equal(page.nextCursor, 'CUR1');
  assert.equal(page.note, undefined);

  assert.equal(paramsOf(fake.calls[0]).limit, DEFAULT_PAGE_LIMIT);
  assert.equal(paramsOf(fake.calls[0]).after, undefined);
});

test('fetchPage: no paging.next ⇒ no nextCursor, not truncated', async () => {
  const fake = createFakeFbRequest();
  fake.enqueue(fbOk(lastPage(items('a'))));

  const page = await fetchPage<Item>(fake.fn, EDGE, { limit: 10 });
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.truncated, false);
  assert.equal(paramsOf(fake.calls[0]).limit, 10);
});

test('fetchPage: cursor in — page.after is forwarded as the after param', async () => {
  const fake = createFakeFbRequest();
  fake.enqueue(fbOk(lastPage(items('z'))));

  await fetchPage<Item>(fake.fn, EDGE, { after: 'RESUME_HERE' });
  assert.equal(paramsOf(fake.calls[0]).after, 'RESUME_HERE');
});

test('fetchPage: cursor expiry ⇒ empty partial + truncated + restart note (CC-PAGE-2)', async () => {
  const fake = createFakeFbRequest();
  fake.enqueue(fbErr(cursorExpiredWithAction()));

  const page = await fetchPage<Item>(fake.fn, EDGE);
  assert.equal(page.data.length, 0);
  assert.equal(page.truncated, true);
  assert.equal(page.note, CURSOR_EXPIRED_NOTE);
});

test('fetchPage: paging.next without an extractable cursor is truncated, not terminal', async () => {
  const fake = createFakeFbRequest();
  // Graph promised another page and handed back nothing to reach it: no `after`
  // in the next URL, no `cursors.after`.
  fake.enqueue(
    fbOk({ data: items('a'), paging: { next: 'https://graph.facebook.com/e?limit=25' } }),
  );

  const page = await fetchPage<Item>(fake.fn, EDGE);
  assert.deepEqual([...page.data], items('a'));
  // Reported as terminal, a caller would stop here and call the listing
  // complete while rows remain. `fetchAll` reads this exact wire shape the same
  // way — the two must not disagree about one response (CC-PAGE-3).
  assert.equal(page.truncated, true);
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.note, MISSING_CURSOR_NOTE);
});

test('fetchPage: a non-cursor error propagates', async () => {
  const fake = createFakeFbRequest();
  fake.enqueue(fbErr(new GraphApiError('boom', { code: 1, httpStatus: 500 })));
  await assert.rejects(fetchPage<Item>(fake.fn, EDGE), /boom/);
});

// ---------------------------------------------------------------------------
// CC-PAGE-1 — empty data with paging.next must CONTINUE
// ---------------------------------------------------------------------------

test('CC-PAGE-1: fetchAll continues past an empty page that still has paging.next', async () => {
  const fake = createFakeFbRequest();
  fake
    .enqueue(fbOk(pageWithNext([], 'c1'))) // empty, but more to come
    .enqueue(fbOk(pageWithNext(items('a'), 'c2')))
    .enqueue(fbOk(lastPage(items('b'))));

  const page = await fetchAll<Item>(fake.fn, EDGE);
  assert.deepEqual([...page.data], items('a', 'b'));
  assert.equal(page.truncated, false);
  assert.equal(page.nextCursor, undefined);
  assert.equal(fake.calls.length, 3, 'the empty-with-next page did not stop iteration');
});

// ---------------------------------------------------------------------------
// CC-PAGE-2 — cursor expiry mid-walk ⇒ partial results, never discarded
// ---------------------------------------------------------------------------

test('CC-PAGE-2: cursor expiry mid-fetchAll keeps prior items + truncated + note', async () => {
  const fake = createFakeFbRequest();
  fake
    .enqueue(fbOk(pageWithNext(items('a', 'b'), 'c1')))
    .enqueue(fbOk(pageWithNext(items('c'), 'c2')))
    .enqueue(fbErr(cursorExpiredWithAction())); // third page expires

  const page = await fetchAll<Item>(fake.fn, EDGE);
  assert.deepEqual([...page.data], items('a', 'b', 'c'), 'gathered items are preserved');
  assert.equal(page.truncated, true);
  assert.equal(page.note, CURSOR_EXPIRED_NOTE);
  assert.equal(page.nextCursor, undefined);
});

test('CC-PAGE-2: expiry detected via message heuristic too', async () => {
  const fake = createFakeFbRequest();
  fake
    .enqueue(fbOk(pageWithNext(items('a'), 'c1')))
    .enqueue(fbErr(cursorExpiredByMessage()));

  const page = await fetchAll<Item>(fake.fn, EDGE);
  assert.deepEqual([...page.data], items('a'));
  assert.equal(page.truncated, true);
  assert.equal(page.note, CURSOR_EXPIRED_NOTE);
});

test('fetchAll: a non-cursor error mid-walk propagates (retry lives in fbRequest)', async () => {
  const fake = createFakeFbRequest();
  fake
    .enqueue(fbOk(pageWithNext(items('a'), 'c1')))
    .enqueue(fbErr(new GraphApiError('rate limited', { code: 4, httpStatus: 400 })));

  await assert.rejects(fetchAll<Item>(fake.fn, EDGE), /rate limited/);
});

// ---------------------------------------------------------------------------
// CC-PAGE-3 — items shifting between pages: no server-side dedup promise
// ---------------------------------------------------------------------------

test('CC-PAGE-3: fetchAll does NOT dedup — duplicates across pages are preserved by id', async () => {
  const fake = createFakeFbRequest();
  fake
    .enqueue(fbOk(pageWithNext(items('a', 'b'), 'c1')))
    .enqueue(fbOk(lastPage(items('b', 'c')))); // 'b' repeats (item shifted)

  const page = await fetchAll<Item>(fake.fn, EDGE);
  assert.deepEqual([...page.data], items('a', 'b', 'b', 'c'));
  const ids = page.data.map((x) => x.id);
  assert.equal(ids.filter((id) => id === 'b').length, 2, 'downstream can dedup by id');
});

// ---------------------------------------------------------------------------
// CC-PAGE-4 — paging.next embeds the token; only the opaque after leaks out (C3)
// ---------------------------------------------------------------------------

test('CC-PAGE-4: token in paging.next never surfaces; only opaque after is used', async () => {
  const SECRET = 'EAASECRETTOKEN123';
  const fake = createFakeFbRequest();
  // First page has NO cursors.after — the cursor must be lifted from the URL,
  // and the URL carries a token that must never escape.
  fake
    .enqueue(
      fbOk({
        data: items('a'),
        paging: {
          next: `https://graph.facebook.com/v19.0/123/feed?access_token=${SECRET}&after=CUR1&pretty=0`,
        },
      }),
    )
    .enqueue(fbOk(lastPage(items('b'))));

  const page = await fetchAll<Item>(fake.fn, EDGE);
  assert.deepEqual([...page.data], items('a', 'b'));

  // The extracted cursor is the opaque value, not the URL.
  assert.equal(paramsOf(fake.calls[1]).after, 'CUR1');

  // Nothing we return or re-request contains the token.
  assert.doesNotMatch(JSON.stringify(page), new RegExp(SECRET));
  for (const call of fake.calls) {
    assert.doesNotMatch(JSON.stringify(paramsOf(call)), new RegExp(SECRET));
  }
});

test('CC-PAGE-4: fetchPage surfaces the after cursor lifted from a token-bearing next URL', async () => {
  const fake = createFakeFbRequest();
  fake.enqueue(
    fbOk({
      data: items('a'),
      paging: { next: 'https://graph.facebook.com/e?access_token=SEKRIT&after=NEXTCUR' },
    }),
  );
  const page = await fetchPage<Item>(fake.fn, EDGE);
  assert.equal(page.nextCursor, 'NEXTCUR');
  assert.doesNotMatch(JSON.stringify(page), /SEKRIT/);
});

// ---------------------------------------------------------------------------
// CC-PAGE-5 — unbounded listings: budgets cap the walk, keep the first items
// ---------------------------------------------------------------------------

test('CC-PAGE-5: maxItems slices mid-page, keeps the first items, drops resume cursor', async () => {
  const fake = createFakeFbRequest();
  fake
    .enqueue(fbOk(pageWithNext(items('a', 'b'), 'c1')))
    .enqueue(fbOk(pageWithNext(items('c', 'd'), 'c2')))
    .enqueue(fbOk(pageWithNext(items('e', 'f'), 'c3'))); // pushes total to 6 ≥ 5

  const page = await fetchAll<Item>(fake.fn, EDGE, { maxItems: 5 });
  assert.deepEqual([...page.data], items('a', 'b', 'c', 'd', 'e'));
  assert.equal(page.data.length, 5);
  assert.equal(page.truncated, true);
  assert.equal(page.nextCursor, undefined, 'mid-page slice cannot resume cleanly');
  assert.match(page.note ?? '', /budget/);
  assert.equal(fake.calls.length, 3);
});

test('CC-PAGE-5: maxItems on a clean page boundary keeps a resumable nextCursor', async () => {
  const fake = createFakeFbRequest();
  fake
    .enqueue(fbOk(pageWithNext(items('a', 'b'), 'c1')))
    .enqueue(fbOk(pageWithNext(items('c', 'd'), 'c2'))); // total 4 === maxItems, next exists

  const page = await fetchAll<Item>(fake.fn, EDGE, { maxItems: 4 });
  assert.deepEqual([...page.data], items('a', 'b', 'c', 'd'));
  assert.equal(page.truncated, true);
  assert.equal(page.nextCursor, 'c2', 'boundary stop is resumable');
  assert.equal(fake.calls.length, 2);
});

test('CC-PAGE-5: maxPages caps the walk and returns a resume cursor', async () => {
  const fake = createFakeFbRequest();
  fake
    .enqueue(fbOk(pageWithNext(items('a'), 'c1')))
    .enqueue(fbOk(pageWithNext(items('b'), 'c2')))
    .enqueue(fbOk(pageWithNext(items('c'), 'c3'))); // would continue, but budget = 3

  const page = await fetchAll<Item>(fake.fn, EDGE, { maxPages: 3 });
  assert.deepEqual([...page.data], items('a', 'b', 'c'));
  assert.equal(page.truncated, true);
  assert.equal(page.nextCursor, 'c3');
  assert.match(page.note ?? '', /page budget/);
  assert.equal(fake.calls.length, 3);
});

test('fetchAll: a complete walk within budget is not truncated', async () => {
  const fake = createFakeFbRequest();
  fake.enqueue(fbOk(pageWithNext(items('a'), 'c1'))).enqueue(fbOk(lastPage(items('b'))));

  const page = await fetchAll<Item>(fake.fn, EDGE, { maxItems: 100, maxPages: 100 });
  assert.deepEqual([...page.data], items('a', 'b'));
  assert.equal(page.truncated, false);
  assert.equal(page.nextCursor, undefined);
});

test('fetchAll: cursor in — page.after seeds the first request', async () => {
  const fake = createFakeFbRequest();
  fake.enqueue(fbOk(lastPage(items('a'))));
  await fetchAll<Item>(fake.fn, EDGE, {}, { after: 'SEED' });
  assert.equal(paramsOf(fake.calls[0]).after, 'SEED');
});

// ---------------------------------------------------------------------------
// Loop-safety guards (termination building blocks)
// ---------------------------------------------------------------------------

test('fetchAll: a non-advancing (repeated) cursor stops the walk (loop guard)', async () => {
  const adv = makeAdversary({ alwaysNext: true, repeatCursor: true });
  const page = await fetchAll<Item>(adv.fn, EDGE);
  assert.equal(page.truncated, true);
  assert.equal(page.note, LOOP_GUARD_NOTE);
  assert.equal(page.nextCursor, undefined);
  assert.equal(adv.count(), 2, 'stops on the first cursor repeat');
});

test('fetchAll: paging.next present but no extractable cursor stops with a note', async () => {
  const fake = createFakeFbRequest();
  // next URL has no `after` param and there is no cursors.after.
  fake.enqueue(
    fbOk({ data: items('a'), paging: { next: 'https://graph.facebook.com/e?limit=25' } }),
  );

  const page = await fetchAll<Item>(fake.fn, EDGE);
  assert.deepEqual([...page.data], items('a'));
  assert.equal(page.truncated, true);
  assert.equal(page.note, MISSING_CURSOR_NOTE);
  assert.equal(fake.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Termination PROPERTY test (dependency-free; fast-check NOT installed)
// ---------------------------------------------------------------------------

test('property: fetchAll terminates and respects budgets over 300 adversarial seeds', async () => {
  for (let seed = 0; seed < 300; seed++) {
    const pick = mulberry32(seed);
    const maxPages = 1 + Math.floor(pick() * 25); // 1..25
    const maxItems = pick() < 0.5 ? undefined : 1 + Math.floor(pick() * 40); // undefined or 1..40

    // Worst case for termination: the stream NEVER ends (always paging.next),
    // with fresh unique cursors and an occasional cursor-expiry.
    const adv = makeAdversary({
      rng: mulberry32(seed ^ 0x9e3779b9),
      alwaysNext: true,
      expiryProb: 0.08,
    });

    const budget = maxItems === undefined ? { maxPages } : { maxPages, maxItems };
    const page = await fetchAll<Item>(adv.fn, EDGE, budget);

    // Terminated (we got here) and never exceeded the page budget.
    assert.ok(
      adv.count() >= 1 && adv.count() <= maxPages,
      `seed ${String(seed)}: page budget respected`,
    );
    // Because the stream never ends, it must have stopped early.
    assert.equal(
      page.truncated,
      true,
      `seed ${String(seed)}: an endless stream must truncate`,
    );
    // Item budget respected after any slicing.
    if (maxItems !== undefined) {
      assert.ok(
        page.data.length <= maxItems,
        `seed ${String(seed)}: item budget respected`,
      );
    }
  }
});

test('property: an endless empty-page-with-next stream stops exactly at the default cap', async () => {
  // No budget ⇒ DEFAULT_MAX_PAGES is the sole termination guarantee, and empty
  // pages with `next` must be walked, not treated as end-of-data (CC-PAGE-1).
  const adv = makeAdversary({ alwaysNext: true, emptyData: true });
  const page = await fetchAll<Item>(adv.fn, EDGE);
  assert.equal(adv.count(), DEFAULT_MAX_PAGES);
  assert.equal(page.data.length, 0);
  assert.equal(page.truncated, true);
  assert.ok(page.nextCursor, 'a resume cursor is offered at the default cap');
});

test('property: an endless non-empty stream stops at an explicit finite maxPages', async () => {
  const adv = makeAdversary({ alwaysNext: true });
  const page = await fetchAll<Item>(adv.fn, EDGE, { maxPages: 250 });
  assert.equal(adv.count(), 250);
  assert.equal(page.truncated, true);
});

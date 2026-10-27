// Tests for the Messenger custom-label plumbing (v2 messaging F11, `api` layer).
//
// Every Graph call goes through `createFakeFbRequest`; tokens are placeholders.
// The load-bearing behaviours under test:
//   * the Page vs person listing paths, and that id-less rows are dropped and counted.
//   * assign is a POST with `user` in the body, unassign a DELETE with `user` in the query.
//   * a 2xx that does not say `success:true` is NOT a confirmed write.
//   * the Page Contact Terms refusal is remapped to a `permission` action (P-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, JsonRequest } from '../core/index.js';

import {
  CONTACT_TERMS_GUIDANCE,
  LABEL_FIELDS,
  createLabel,
  deleteLabel,
  getLabel,
  isContactTermsError,
  listLabels,
  setLabelAssigned,
} from './labels.js';

const PAGE_ID = '100';
const PAGE_TOKEN = 'EAA-PAGE-PLACEHOLDER';
const PSID = '2000';
const LABEL_ID = '777';

function jsonOf(req: FbRequest | undefined): JsonRequest {
  if (req === undefined || req.protocol !== 'json') {
    throw new Error(`expected a json request, got ${req?.protocol ?? 'none'}`);
  }
  return req;
}

function graphError(message: string, code = 100): GraphApiError {
  return new GraphApiError(message, { code, httpStatus: 400 });
}

test('listLabels reads the Page labels, or the labels on one person', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbOk({
      data: [{ id: '1', page_label_name: 'vip' }, { id: 2 }, { page_label_name: 'x' }],
    }),
  );

  const page = await listLabels(fb.fn, { pageId: PAGE_ID, token: PAGE_TOKEN });
  const req = jsonOf(fb.lastRequest());
  assert.equal(req.method, 'GET');
  assert.equal(req.path, `/${PAGE_ID}/custom_labels`);
  assert.equal(req.params?.fields, LABEL_FIELDS);
  assert.deepEqual(page.data, [{ id: '1', name: 'vip' }, { id: '2' }]);
  assert.ok(page.note?.includes('1'), 'the dropped id-less row is counted');

  await listLabels(fb.fn, { pageId: PAGE_ID, psid: PSID, token: PAGE_TOKEN });
  assert.equal(jsonOf(fb.lastRequest()).path, `/${PSID}/custom_labels`);
});

test('getLabel reads one label; a body without an id is undefined', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ id: LABEL_ID, page_label_name: 'vip' }));
  assert.deepEqual(await getLabel(fb.fn, { pageId: PAGE_ID, labelId: LABEL_ID }), {
    id: LABEL_ID,
    name: 'vip',
  });
  assert.equal(jsonOf(fb.lastRequest()).path, `/${LABEL_ID}`);

  const empty = createFakeFbRequest();
  empty.on(() => true, fbOk({}));
  assert.equal(
    await getLabel(empty.fn, { pageId: PAGE_ID, labelId: LABEL_ID }),
    undefined,
  );
});

test('createLabel posts page_label_name and returns the id when Graph gives one', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ id: LABEL_ID }));
  assert.deepEqual(await createLabel(fb.fn, { pageId: PAGE_ID, name: 'vip' }), {
    labelId: LABEL_ID,
  });
  const req = jsonOf(fb.lastRequest());
  assert.equal(req.method, 'POST');
  assert.equal(req.path, `/${PAGE_ID}/custom_labels`);
  assert.deepEqual(req.body, { page_label_name: 'vip' });

  const bare = createFakeFbRequest();
  bare.on(() => true, fbOk({ success: true }));
  assert.deepEqual(await createLabel(bare.fn, { pageId: PAGE_ID, name: 'vip' }), {});
});

test('assign POSTs user in the body; unassign DELETEs with user in the query', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ success: true }));

  const base = { pageId: PAGE_ID, labelId: LABEL_ID, psid: PSID };
  assert.equal(await setLabelAssigned(fb.fn, { ...base, assigned: true }), true);
  const assign = jsonOf(fb.lastRequest());
  assert.equal(assign.method, 'POST');
  assert.equal(assign.path, `/${LABEL_ID}/label`);
  assert.deepEqual(assign.body, { user: PSID });

  assert.equal(await setLabelAssigned(fb.fn, { ...base, assigned: false }), true);
  const unassign = jsonOf(fb.lastRequest());
  assert.equal(unassign.method, 'DELETE');
  assert.equal(unassign.path, `/${LABEL_ID}/label`);
  assert.deepEqual(unassign.params, { user: PSID });
  assert.equal(unassign.body, undefined);
});

test('deleteLabel deletes the node; only success:true (or no body) confirms', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ success: true }));
  assert.equal(await deleteLabel(fb.fn, { pageId: PAGE_ID, labelId: LABEL_ID }), true);
  const req = jsonOf(fb.lastRequest());
  assert.equal(req.method, 'DELETE');
  assert.equal(req.path, `/${LABEL_ID}`);

  for (const body of [{ success: false }, 'ok', 0]) {
    const other = createFakeFbRequest();
    other.on(() => true, fbOk(body));
    assert.equal(
      await deleteLabel(other.fn, { pageId: PAGE_ID, labelId: LABEL_ID }),
      false,
      `body ${JSON.stringify(body)} must not confirm`,
    );
  }
});

test('the Page Contact Terms refusal becomes a permission error with guidance', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbErr(graphError('(#200) The page has not accepted the Page Contact Terms.', 200)),
  );
  await assert.rejects(
    listLabels(fb.fn, { pageId: PAGE_ID }),
    (err: unknown) =>
      err instanceof GraphApiError &&
      err.code === 200 &&
      err.action?.category === 'permission' &&
      err.action.operatorText === CONTACT_TERMS_GUIDANCE &&
      isContactTermsError(err),
  );

  const other = createFakeFbRequest();
  const plain = graphError('(#100) Invalid parameter');
  other.on(() => true, fbErr(plain));
  await assert.rejects(
    deleteLabel(other.fn, { pageId: PAGE_ID, labelId: LABEL_ID }),
    (err) => {
      assert.equal(err, plain, 'every other failure passes through unchanged');
      return true;
    },
  );
});

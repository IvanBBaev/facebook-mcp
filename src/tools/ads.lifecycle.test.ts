// Tests for the `ads` tool package: the campaign spend cap, archive / delete and the ad
// image upload.
//
// Split out of `ads.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/ads.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fbOk, type FakeFbRequest } from '../core/fakes/index.js';
import {
  ACCOUNT_ID,
  ADSET_ID,
  CAMPAIGN_ID,
  arr,
  body,
  campaignNode,
  isJson,
  makeHarness,
  obj,
  str,
  stubWriteReads,
  tool,
  writes,
} from '../testing/harness/ads.js';

// ---------------------------------------------------------------------------
// Campaign spend cap (v2 ads §4)
// ---------------------------------------------------------------------------

test('a spend cap raise is a spend write that applies spend_cap and journals it', async () => {
  const { fb, ctx, journal } = makeHarness({ adsCampaignSpendCapMax: 100_000 });
  stubWriteReads(fb, { object: campaignNode({ spend_cap: '40000' }), currency: 'USD' });
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', spend_cap_minor: 60_000 };
  const preview = body(await update.handler(args, ctx));
  assert.equal(preview.status, 'preview');
  assert.equal(preview.tier, 'spend');
  assert.ok(
    str(preview.summary).includes('spend_cap: 40000 minor units of USD -> 60000'),
  );
  assert.equal(writes(fb).length, 0);

  const applied = body(
    await update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );
  assert.equal(applied.status, 'applied');
  const post = writes(fb)[0];
  assert.ok(post && isJson(post));
  assert.deepEqual(post.body, { spend_cap: 60_000 });
  const metadata = obj(journal.entries.at(-1)?.metadata);
  assert.deepEqual(metadata.changedFields, ['spend_cap']);
  assert.equal(metadata.increasesSpend, true);
});

test('a first spend cap is irreversible and refused when FB_ADS_CAMPAIGN_SPEND_CAP_MAX is unset', async () => {
  const set = makeHarness({ adsCampaignSpendCapMax: 100_000 });
  stubWriteReads(set.fb);
  const preview = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', spend_cap_minor: 50_000 },
      set.ctx,
    ),
  );
  assert.equal(preview.tier, 'irreversible');

  const unset = makeHarness();
  stubWriteReads(unset.fb);
  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', spend_cap_minor: 50_000 },
        unset.ctx,
      ),
    /needs FB_ADS_CAMPAIGN_SPEND_CAP_MAX/,
  );
  assert.equal(writes(unset.fb).length, 0);
});

test('a spend cap below the account minimum is refused before the wire', async () => {
  const { fb, ctx } = makeHarness({ adsCampaignSpendCapMax: 100_000 });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({
      id: ACCOUNT_ID,
      account_status: 1,
      currency: 'USD',
      min_campaign_group_spend_cap: '10000',
    }),
  );
  fb.on((r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`, fbOk(campaignNode()));
  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', spend_cap_minor: 5_000 },
        ctx,
      ),
    /below Meta's minimum campaign spend cap/,
  );
  assert.equal(writes(fb).length, 0);
});

test('a spend cap change made elsewhere between preview and apply diverges', async () => {
  const { fb, ctx } = makeHarness({ adsCampaignSpendCapMax: 100_000 });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR' }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ spend_cap: '40000' })),
    1,
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ spend_cap: '45000' })),
  );
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' };
  const preview = body(await update.handler(args, ctx));
  const result = body(
    await update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );
  assert.equal(result.status, 'diverged');
  assert.equal(writes(fb).length, 0);
});

test('spend_cap_minor must be a positive integer', () => {
  const schema = tool('facebook_update_ad_object').inputSchema;
  for (const bad of [0, -1, 1.5]) {
    assert.equal(
      schema.safeParse({ object_id: CAMPAIGN_ID, spend_cap_minor: bad }).success,
      false,
      String(bad),
    );
  }
});

// ---------------------------------------------------------------------------
// Lifecycle tools (v2 ads §3) — archive / delete
// ---------------------------------------------------------------------------

/** Serve the child counts and the 28-day spend the lifecycle preview reads. */
function stubLifecycleReads(
  fb: FakeFbRequest,
  opts: { readonly adsets?: number; readonly ads?: number; readonly spend?: string } = {},
): void {
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}/adsets`,
    fbOk({ data: [], summary: { total_count: opts.adsets ?? 2 } }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}/ads`,
    fbOk({ data: [], summary: { total_count: opts.ads ?? 5 } }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}/insights`,
    fbOk({ data: opts.spend !== undefined ? [{ spend: opts.spend }] : [] }),
  );
}

test('archive and delete are irreversible previews that change nothing', async () => {
  for (const name of ['facebook_archive_ad_object', 'facebook_delete_ad_object']) {
    const { fb, ctx, journal } = makeHarness();
    stubWriteReads(fb);
    stubLifecycleReads(fb);

    const result = body(
      await tool(name).handler({ object_id: CAMPAIGN_ID, level: 'campaign' }, ctx),
    );

    assert.equal(result.status, 'preview', name);
    assert.equal(result.tier, 'irreversible', name);
    assert.match(str(result.summary), /children affected: 7/, name);
    assert.ok(
      arr(result.warnings).some((w) => str(w).includes('2 ad sets and 5 ads under it')),
      name,
    );
    assert.equal(writes(fb).length, 0, `${name}: a dry run may not write`);
    assert.equal(journal.entries.length, 0, name);
  }
});

test('an applied archive POSTs status=ARCHIVED and journals from/to/childCount', async () => {
  const { fb, ctx, journal } = makeHarness();
  stubWriteReads(fb);
  stubLifecycleReads(fb);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const archive = tool('facebook_archive_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign' };
  const preview = body(await archive.handler(args, ctx));
  const applied = body(
    await archive.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );

  assert.equal(applied.status, 'applied');
  const result = obj(applied.result);
  assert.equal(result.toStatus, 'ARCHIVED');
  assert.equal(result.fromStatus, 'PAUSED');
  assert.equal(result.childrenAffected, 7);
  const post = writes(fb)[0];
  assert.ok(post && isJson(post));
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { status: 'ARCHIVED' });
  const entry = journal.entries.at(-1);
  assert.equal(entry?.outcome, 'applied');
  assert.deepEqual(
    {
      from: entry?.metadata?.from,
      to: entry?.metadata?.to,
      childCount: entry?.metadata?.childCount,
    },
    { from: 'PAUSED', to: 'ARCHIVED', childCount: 7 },
  );
});

test('an applied campaign delete uses DELETE /{id}; an ad set uses status=DELETED', async () => {
  const campaign = makeHarness();
  stubWriteReads(campaign.fb);
  stubLifecycleReads(campaign.fb);
  campaign.fb.on((r) => r.method === 'DELETE', fbOk({ success: true }));
  const del = tool('facebook_delete_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign' };
  const preview = body(await del.handler(args, campaign.ctx));
  const applied = body(
    await del.handler(
      { ...args, apply: true, plan_id: str(preview.planId) },
      campaign.ctx,
    ),
  );
  assert.equal(applied.status, 'applied');
  const sent = writes(campaign.fb);
  assert.equal(sent.length, 1);
  const deleted = sent[0];
  assert.ok(deleted && isJson(deleted));
  assert.equal(deleted.method, 'DELETE');
  assert.equal(deleted.path, `/${CAMPAIGN_ID}`);

  const adset = makeHarness();
  stubWriteReads(adset.fb);
  adset.fb.on(
    (r) => r.method === 'GET' && r.path === `/${ADSET_ID}`,
    fbOk({ id: ADSET_ID, status: 'PAUSED', effective_status: 'PAUSED' }),
  );
  adset.fb.on(
    (r) => r.method === 'GET' && r.path === `/${ADSET_ID}/ads`,
    fbOk({ data: [], summary: { total_count: 3 } }),
  );
  adset.fb.on(
    (r) => r.method === 'GET' && r.path === `/${ADSET_ID}/insights`,
    fbOk({ data: [] }),
  );
  adset.fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const adsetArgs = { object_id: ADSET_ID, level: 'adset' };
  const adsetPreview = body(await del.handler(adsetArgs, adset.ctx));
  await del.handler(
    { ...adsetArgs, apply: true, plan_id: str(adsetPreview.planId) },
    adset.ctx,
  );
  const post = writes(adset.fb)[0];
  assert.ok(post && isJson(post));
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { status: 'DELETED' });
});

test('delete warns about recent delivery from 28-day spend', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb);
  stubLifecycleReads(fb, { spend: '12.50' });
  const result = body(
    await tool('facebook_delete_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign' },
      ctx,
    ),
  );
  assert.ok(
    arr(result.warnings).some((w) => str(w).includes('delivered in the last 28 days')),
  );
});

test('an at-risk ad account may still archive (it stops delivery)', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, { accountStatus: 3 });
  stubLifecycleReads(fb);
  const result = body(
    await tool('facebook_archive_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', ad_account_id: ACCOUNT_ID },
      ctx,
    ),
  );
  assert.equal(result.status, 'preview');
});

test('an already deleted object is refused before the wire', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, {
    object: campaignNode({ status: 'DELETED', effective_status: 'DELETED' }),
  });
  stubLifecycleReads(fb);
  await assert.rejects(
    () =>
      tool('facebook_delete_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign' },
        ctx,
      ),
    /already deleted/,
  );
  assert.equal(writes(fb).length, 0);
});

test('a status change between archive preview and apply diverges', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR' }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode()),
    1,
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ status: 'ACTIVE', effective_status: 'ACTIVE' })),
  );
  stubLifecycleReads(fb);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const archive = tool('facebook_archive_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign' };
  const preview = body(await archive.handler(args, ctx));
  const result = body(
    await archive.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );
  assert.equal(result.status, 'diverged');
  assert.equal(writes(fb).length, 0);
});

// ---------------------------------------------------------------------------
// Ad image upload (v2 ads §2)
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7,
]);

async function withAdMedia(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fbmcp-ads-')));
  try {
    await writeFile(join(dir, 'banner.png'), PNG_BYTES);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const AD_IMAGE_RESPONSE = {
  images: {
    'banner.png': {
      hash: 'abc123hash',
      url: 'https://scontent.example/b.png',
      width: 10,
      height: 10,
      name: 'banner.png',
    },
  },
};

test('upload_ad_image previews the bound file and uploads nothing', async () => {
  await withAdMedia(async (dir) => {
    const { fb, ctx, journal } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);

    const result = body(
      await tool('facebook_upload_ad_image').handler({ file_path: 'banner.png' }, ctx),
    );

    assert.equal(result.status, 'preview');
    assert.equal(result.tier, 'reversible');
    assert.match(
      str(result.summary),
      /Upload banner\.png \(11 bytes, sha256 [0-9a-f]{12}\) to the image library of act_1234567890/,
    );
    assert.ok(
      arr(result.warnings).some((w) =>
        str(w).includes('does not create or change any ad'),
      ),
    );
    assert.ok(
      arr(result.warnings).some((w) => str(w).includes('re-running this upload is safe')),
    );
    assert.equal(writes(fb).length, 0);
    assert.equal(journal.entries.length, 0);
  });
});

test('an applied upload POSTs to adimages and journals account, hash and bytes', async () => {
  await withAdMedia(async (dir) => {
    const { fb, ctx, journal } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);
    fb.on((r) => r.method === 'POST', fbOk(AD_IMAGE_RESPONSE));
    const upload = tool('facebook_upload_ad_image');

    const preview = body(
      await upload.handler({ file_path: 'banner.png', name: 'Hero' }, ctx),
    );
    const applied = body(
      await upload.handler(
        {
          file_path: 'banner.png',
          name: 'Hero',
          apply: true,
          plan_id: str(preview.planId),
        },
        ctx,
      ),
    );

    assert.equal(applied.status, 'applied');
    assert.equal(obj(obj(applied.result).image).hash, 'abc123hash');
    const post = writes(fb)[0];
    assert.ok(post && post.protocol === 'multipart');
    assert.equal(post.path, `/${ACCOUNT_ID}/adimages`);
    assert.equal(post.files[0]?.filename, 'Hero');
    const entry = journal.entries.at(-1);
    assert.equal(entry?.outcome, 'applied');
    assert.deepEqual(entry?.metadata, {
      accountId: ACCOUNT_ID,
      bytes: 11,
      hash: 'abc123hash',
    });
  });
});

test('an upload answered without a hash is attempted, with the re-run note', async () => {
  await withAdMedia(async (dir) => {
    const { fb, ctx, journal } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);
    fb.on((r) => r.method === 'POST', fbOk({ images: {} }));
    const upload = tool('facebook_upload_ad_image');

    const preview = body(await upload.handler({ file_path: 'banner.png' }, ctx));
    const applied = body(
      await upload.handler(
        { file_path: 'banner.png', apply: true, plan_id: str(preview.planId) },
        ctx,
      ),
    );

    assert.equal(applied.status, 'not_applied');
    assert.equal(applied.outcome, 'attempted');
    assert.match(str(obj(applied.result).unconfirmed), /re-running this upload is safe/);
    assert.equal(journal.entries.at(-1)?.outcome, 'attempted');
  });
});

test('a file rewritten after the preview no longer matches the plan and is not uploaded', async () => {
  await withAdMedia(async (dir) => {
    const { fb, ctx } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);
    const upload = tool('facebook_upload_ad_image');

    const preview = body(await upload.handler({ file_path: 'banner.png' }, ctx));
    const changed = new Uint8Array(PNG_BYTES);
    changed[10] = 0;
    await writeFile(join(dir, 'banner.png'), changed);

    await assert.rejects(
      upload.handler(
        { file_path: 'banner.png', apply: true, plan_id: str(preview.planId) },
        ctx,
      ),
      /apply params differ from the planned params/,
    );
    assert.equal(writes(fb).length, 0);
  });
});

test('upload_ad_image refuses a non-image extension and a path outside FB_MEDIA_DIR', async () => {
  await withAdMedia(async (dir) => {
    await writeFile(join(dir, 'clip.mp4'), PNG_BYTES);
    const { fb, ctx } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);
    const upload = tool('facebook_upload_ad_image');

    await assert.rejects(
      upload.handler({ file_path: 'clip.mp4' }, ctx),
      /not an ad image format/,
    );
    await assert.rejects(upload.handler({ file_path: '../x.png' }, ctx));
    assert.equal(writes(fb).length, 0);
  });
});

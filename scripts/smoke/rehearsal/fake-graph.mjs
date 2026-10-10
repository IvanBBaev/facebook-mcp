// Offline rehearsal only: a stateful, loopback-only stand-in for the Graph API.
//
// It answers exactly the calls the live smoke harness (and the server it spawns)
// makes, with bodies shaped like the recorded fixtures in test/fixtures/ and the
// example responses in src/api/*.test.ts. It is NOT a Graph emulator: anything it
// does not recognise is answered with a Graph-style error AND recorded as
// unhandled, so `rehearse.mjs` fails loudly instead of letting a smoke pass on a
// route nobody modelled.
//
// Requests arrive through the redirect in fetch-redirect.mjs as
// `/__host/<graph-host>/<version>/<path>?<query>`. Every one is recorded (method,
// host, API version, path, query and body keys — never the token, which is only
// checked).
//
// State is kept per run so a create → read → delete lifecycle behaves like the
// real thing: a deleted object answers Graph's "does not exist" error, a hidden
// comment reads back hidden, a scheduled post shows up on `scheduled_posts`, a
// reel shows up on both listing edges, and a video's status is terminal at once
// (the real Graph takes minutes; the harness's wait loops are exercised by their
// own unit tests, not here).

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The fixture the fake's read Page is seeded from. */
function loadFixture(name) {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'test', 'fixtures', name), 'utf8'));
}

/** Fake identities. All digits, like real Graph ids; none of them is real. */
export const REHEARSAL_IDS = Object.freeze({
  testPageId: '900000000000101',
  readPageId: '900000000000202',
  userId: '900000000000303',
  appId: '900000000000404',
  adAccountId: 'act_900000000000505',
  visitorId: '900000000000606',
});

/** Fake credentials. Shaped like tokens (so the scrubber has something to do). */
export const REHEARSAL_TOKENS = Object.freeze({
  system: 'EAAREHEARSALsystemTOKEN0000000000000000',
  testPage: 'EAAREHEARSALtestPAGEtoken000000000000000',
  readPage: 'EAAREHEARSALreadPAGEtoken000000000000000',
});

const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_read_user_content',
  'pages_messaging',
  'read_insights',
  'ads_read',
  'ads_management',
];

const USAGE_HEADERS = {
  'x-app-usage': JSON.stringify({ call_count: 1, total_cputime: 1, total_time: 1 }),
};

/** Graph's error envelope. */
function graphError(status, code, message, extra = {}) {
  return {
    status,
    body: {
      error: {
        message,
        type: code === 190 ? 'OAuthException' : 'GraphMethodException',
        code,
        ...extra,
        fbtrace_id: 'RehearsalTrace',
      },
    },
  };
}

const notFound = (id) =>
  graphError(
    400,
    100,
    `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
    { error_subcode: 33 },
  );

function ok(body, headers = {}) {
  return { status: 200, body, headers };
}

/** Graph timestamps: `2026-01-15T10:00:00+0000`. */
function graphTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

function utcDayMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Opaque cursors are just base64 offsets here. */
const encodeCursor = (offset) => Buffer.from(`offset:${offset}`).toString('base64url');
function decodeCursor(raw) {
  if (typeof raw !== 'string' || raw === '') return 0;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const match = /^offset:(\d+)$/.exec(text);
  return match === null ? 0 : Number(match[1]);
}

/**
 * A Graph list page over `rows`, honouring `limit` / `after` and emitting a
 * `paging.next` only when more rows exist.
 */
function listPage(rows, query, { defaultLimit = 25, summary } = {}) {
  const limit = Math.max(1, Number(query.get('limit') ?? defaultLimit) || defaultLimit);
  const offset = decodeCursor(query.get('after'));
  const data = rows.slice(offset, offset + limit);
  const body = { data };
  const paging = {
    cursors: { before: encodeCursor(offset), after: encodeCursor(offset + data.length) },
  };
  if (offset + data.length < rows.length) {
    paging.next = `https://graph.facebook.com/next?after=${paging.cursors.after}&limit=${limit}`;
  }
  body.paging = paging;
  if (summary !== undefined) body.summary = summary;
  return ok(body);
}

/** Pick `fields` (top level only) from an object; `id` is always kept. */
function pick(obj, query) {
  const raw = query.get('fields');
  if (raw === null || raw === '') return { ...obj };
  const wanted = new Set(topLevelFields(raw));
  wanted.add('id');
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(key)) out[key] = value;
  }
  return out;
}

/** Split a Graph `fields` list on top-level commas only (nested `{...}` / `.x(y)` stay whole). */
function topLevelFields(raw) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of raw) {
    if (ch === '{' || ch === '(') depth += 1;
    if (ch === '}' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') out.push(current);
  return out.map((field) => field.trim().split(/[.{(]/)[0]).filter(Boolean);
}

/** Read the whole request body as text. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Form-urlencoded, JSON or multipart bodies — only the text fields matter here. */
function parseBody(buffer, contentType = '') {
  const params = new URLSearchParams();
  if (buffer.length === 0) return { params, bytes: 0 };
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return { params: new URLSearchParams(buffer.toString('utf8')), bytes: buffer.length };
  }
  if (contentType.includes('application/json')) {
    try {
      const json = JSON.parse(buffer.toString('utf8'));
      for (const [key, value] of Object.entries(json ?? {})) {
        params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    } catch {
      // Not JSON after all — fall through with no fields.
    }
    return { params, bytes: buffer.length };
  }
  if (contentType.includes('multipart/form-data')) {
    const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
    if (boundary !== undefined) {
      const text = buffer.toString('latin1');
      for (const part of text.split(`--${boundary}`)) {
        const name = /name="([^"]+)"/.exec(part)?.[1];
        if (name === undefined || /filename="/.test(part)) continue;
        const value = part
          .split('\r\n\r\n')
          .slice(1)
          .join('\r\n\r\n')
          .replace(/\r\n$/, '');
        params.set(name, value);
      }
    }
    return { params, bytes: buffer.length };
  }
  // A raw upload (rupload): no fields, just bytes.
  return { params, bytes: buffer.length };
}

/**
 * Start the fake. Resolves once it listens on 127.0.0.1 with an ephemeral port.
 *
 * Every Graph-host answer carries `facebook-api-version` equal to the version
 * the request named, as the real Graph does for a version it still serves — so
 * a rehearsal exercises the server's version-drift check and expects silence
 * from it. `adVersionWarning`, when set, is sent as `X-Ad-Api-Version-Warning`
 * on every ad-account (`/act_…`) answer: the test switch for the signal Meta
 * sends when it auto-upgrades a call on a deprecated Marketing API version.
 *
 * @param {{ now?: () => number, adVersionWarning?: string }} [opts]
 */
export async function startFakeGraph({ now = () => Date.now(), adVersionWarning } = {}) {
  const ids = REHEARSAL_IDS;
  const requests = [];
  const unhandled = [];
  let counter = 1000;
  const nextId = () => `9${String(++counter).padStart(14, '0')}`;

  /** Every Graph node, by id. `kind` drives the edges; `deleted` makes it vanish. */
  const nodes = new Map();
  const put = (node) => {
    nodes.set(node.id, node);
    return node;
  };
  const live = (id) => {
    const node = nodes.get(id);
    return node !== undefined && node.deleted !== true ? node : undefined;
  };

  const pageToken = new Map([
    [ids.testPageId, REHEARSAL_TOKENS.testPage],
    [ids.readPageId, REHEARSAL_TOKENS.readPage],
  ]);

  // ---- seed: two Pages, the read Page's timeline from the feed fixture -------
  const meFixture = loadFixture('graph-me.json');
  for (const [pageId, name] of [
    [ids.testPageId, 'Rehearsal Test Page'],
    [ids.readPageId, 'Rehearsal Read Page'],
  ]) {
    put({
      kind: 'page',
      id: pageId,
      fields: {
        id: pageId,
        name,
        category: meFixture.category,
        tasks: meFixture.tasks,
        fan_count: 10,
        followers_count: 12,
        link: `https://www.facebook.com/${pageId}`,
        verification_status: 'not_verified',
      },
    });
  }
  const feedFixture = loadFixture('graph-feed.json');
  const seedTime = now() - 3 * 86_400_000;
  feedFixture.data.forEach((row, index) => {
    const postId = `${ids.readPageId}_${nextId()}`;
    const post = put({
      kind: 'post',
      id: postId,
      pageId: ids.readPageId,
      published: true,
      fields: {
        ...row,
        id: postId,
        created_time: graphTime(seedTime - index * 3_600_000),
        from: { id: ids.readPageId, name: 'Rehearsal Read Page' },
        is_published: true,
      },
    });
    // One visitor comment per seeded post, so the comment reads have something.
    const commentId = `${nextId()}_${nextId()}`;
    put({
      kind: 'comment',
      id: commentId,
      parentId: post.id,
      pageId: ids.readPageId,
      hidden: false,
      fields: {
        id: commentId,
        message: 'Nice post — rehearsal visitor comment.',
        created_time: graphTime(seedTime),
        from: { id: ids.visitorId, name: 'Rehearsal Visitor' },
        like_count: 0,
        comment_count: 0,
        can_hide: true,
        can_remove: true,
        can_reply_privately: true,
        is_hidden: false,
      },
    });
  });

  // ---- seed: one Messenger conversation on the read Page -------------------
  const conversationId = `t_${nextId()}`;
  put({
    kind: 'conversation',
    id: conversationId,
    pageId: ids.readPageId,
    fields: {
      id: conversationId,
      updated_time: graphTime(now() - 10 * 86_400_000),
      message_count: 2,
      unread_count: 0,
      participants: {
        data: [
          { id: ids.visitorId, name: 'Rehearsal Visitor' },
          { id: ids.readPageId, name: 'Rehearsal Read Page' },
        ],
      },
    },
    messages: [
      {
        id: `m_${nextId()}`,
        message: 'Hello, is this open?',
        created_time: graphTime(now() - 10 * 86_400_000),
        from: { id: ids.visitorId, name: 'Rehearsal Visitor' },
        to: { data: [{ id: ids.readPageId, name: 'Rehearsal Read Page' }] },
      },
      {
        id: `m_${nextId()}`,
        message: 'Yes, we are open.',
        created_time: graphTime(now() - 10 * 86_400_000 + 60_000),
        from: { id: ids.readPageId, name: 'Rehearsal Read Page' },
        to: { data: [{ id: ids.visitorId, name: 'Rehearsal Visitor' }] },
      },
    ],
  });

  // ---- seed: three published Reels on the read Page ------------------------
  // Three, so reels/listing's limit-2 page has a next cursor to round-trip and
  // insights/reel-guardrail has a Reel to read. Reels live on /video_reels and
  // /videos only — never on the timeline edges (the contract reels/listing pins).
  for (let index = 0; index < 3; index += 1) {
    const videoId = nextId();
    put({
      kind: 'video',
      id: videoId,
      pageId: ids.readPageId,
      reel: true,
      published: true,
      postId: nextId(),
      bytesReceived: 1024,
      fields: {
        id: videoId,
        description: `Rehearsal seeded Reel ${index + 1}`,
        created_time: graphTime(seedTime - index * 86_400_000),
        updated_time: graphTime(seedTime - index * 86_400_000),
        from: { id: ids.readPageId, name: 'Rehearsal Read Page' },
        length: 12.5,
        permalink_url: `/reel/${videoId}`,
      },
    });
  }

  // ---- seed: one ad account with a campaign → ad set → ad chain -------------
  // Graph answers budgets as minor-unit STRINGS; the server must hand back
  // integers. One ad is configured ACTIVE under a paused campaign (the CC-ADS-2
  // trap) and one is under review, so both explanation paths have material.
  const accountDigits = ids.adAccountId.replace(/^act_/, '');
  put({
    kind: 'adaccount',
    id: ids.adAccountId,
    fields: {
      id: ids.adAccountId,
      account_id: accountDigits,
      name: 'Rehearsal Ad Account',
      account_status: 1,
      currency: 'USD',
      timezone_name: 'Etc/UTC',
    },
  });
  const campaignId = nextId();
  const adsetId = nextId();
  const adTimes = {
    created_time: graphTime(seedTime),
    updated_time: graphTime(seedTime),
  };
  put({
    kind: 'adobject',
    level: 'campaign',
    id: campaignId,
    fields: {
      id: campaignId,
      name: 'Rehearsal campaign',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      objective: 'OUTCOME_AWARENESS',
      buying_type: 'AUCTION',
      daily_budget: '5000',
      budget_remaining: '4200',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      start_time: graphTime(seedTime),
      account_id: accountDigits,
      ...adTimes,
    },
  });
  put({
    kind: 'adobject',
    level: 'adset',
    id: adsetId,
    fields: {
      id: adsetId,
      name: 'Rehearsal ad set',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      campaign_id: campaignId,
      daily_budget: '2000',
      budget_remaining: '1500',
      optimization_goal: 'REACH',
      billing_event: 'IMPRESSIONS',
      start_time: graphTime(seedTime),
      account_id: accountDigits,
      ...adTimes,
    },
  });
  for (const [name, status, effective] of [
    ['Rehearsal ad (under review)', 'ACTIVE', 'PENDING_REVIEW'],
    ['Rehearsal ad (paused parent)', 'ACTIVE', 'CAMPAIGN_PAUSED'],
  ]) {
    const adId = nextId();
    put({
      kind: 'adobject',
      level: 'ad',
      id: adId,
      fields: {
        id: adId,
        name,
        status,
        effective_status: effective,
        adset_id: adsetId,
        campaign_id: campaignId,
        account_id: accountDigits,
        ...adTimes,
      },
    });
  }

  // ---- request handling ----------------------------------------------------

  const commentsOf = (parentId) =>
    [...nodes.values()].filter(
      (node) =>
        node.kind === 'comment' && node.parentId === parentId && node.deleted !== true,
    );

  const descendantsOf = (parentId) =>
    commentsOf(parentId)
      .flatMap((child) => [child, ...descendantsOf(child.id)])
      .sort((a, b) => (a.fields.created_time < b.fields.created_time ? -1 : 1));

  const commentView = (node) => ({
    ...node.fields,
    is_hidden: node.hidden === true,
    comment_count: commentsOf(node.id).length,
  });

  const postsOf = (pageId, predicate) =>
    [...nodes.values()]
      .filter(
        (node) =>
          node.kind === 'post' &&
          node.pageId === pageId &&
          node.deleted !== true &&
          predicate(node),
      )
      .sort((a, b) => (a.fields.created_time < b.fields.created_time ? 1 : -1));

  const videosOf = (pageId) =>
    [...nodes.values()]
      .filter(
        (node) =>
          node.kind === 'video' && node.pageId === pageId && node.deleted !== true,
      )
      .reverse();

  function handle({ method, host, segments, query, form, bytes }) {
    const [first, second, third] = segments;

    // --- rupload: the byte transfer of a reel / video upload ---------------
    if (host === 'rupload.facebook.com') {
      const videoId = segments.at(-1);
      const video = live(videoId);
      if (method !== 'POST' || video === undefined) return undefined;
      video.bytesReceived = bytes;
      return ok({ success: true });
    }

    // --- identity ----------------------------------------------------------
    if (method === 'GET' && first === 'debug_token' && segments.length === 1) {
      return ok({
        data: {
          app_id: ids.appId,
          type: 'SYSTEM_USER',
          application: 'Rehearsal App',
          data_access_expires_at: 0,
          expires_at: 0,
          is_valid: true,
          scopes: SCOPES,
          granular_scopes: SCOPES.map((scope) => ({ scope })),
          user_id: ids.userId,
        },
      });
    }
    if (method === 'GET' && first === 'me' && segments.length === 1) {
      return ok(
        pick({ id: ids.userId, name: 'Rehearsal System User' }, query),
        USAGE_HEADERS,
      );
    }
    if (
      method === 'GET' &&
      first === 'me' &&
      second === 'accounts' &&
      segments.length === 2
    ) {
      const rows = [ids.testPageId, ids.readPageId].map((pageId) => ({
        ...pick(live(pageId).fields, query),
        access_token: pageToken.get(pageId),
      }));
      return listPage(rows, query);
    }

    const node = live(first);

    // --- nodes -------------------------------------------------------------
    if (segments.length === 1) {
      if (node === undefined) {
        return notFound(first);
      }
      if (method === 'GET') return ok(nodeView(node, query));
      if (method === 'DELETE') {
        node.deleted = true;
        return ok({ success: true });
      }
      if (method === 'POST') return updateNode(node, form);
      return undefined;
    }

    if (node === undefined) return notFound(first);
    const edge = second;

    // --- Page edges --------------------------------------------------------
    if (node.kind === 'page' && segments.length === 2) {
      if (method === 'GET' && ['published_posts', 'feed', 'posts'].includes(edge)) {
        return listPage(
          postsOf(node.id, (post) => post.published === true).map((post) =>
            pick(postView(post), query),
          ),
          query,
        );
      }
      if (method === 'GET' && edge === 'scheduled_posts') {
        return listPage(
          [
            ...postsOf(node.id, (post) => post.published === false).map((post) =>
              pick(postView(post), query),
            ),
            ...videosOf(node.id)
              .filter((video) => video.fields.scheduled_publish_time !== undefined)
              .map((video) => pick(scheduledReelView(video), query)),
          ],
          query,
        );
      }
      if (method === 'POST' && edge === 'feed') return createPost(node, form);
      if (method === 'POST' && edge === 'photos') return createPhoto(node, form);
      if (edge === 'video_reels') {
        if (method === 'POST') return reelPhase(node, form);
        if (method === 'GET') {
          return listPage(
            videosOf(node.id)
              .filter((video) => video.reel === true)
              .map((video) => pick(videoView(video), query)),
            query,
          );
        }
      }
      if (method === 'GET' && edge === 'videos') {
        return listPage(
          videosOf(node.id).map((video) => pick(videoView(video), query)),
          query,
        );
      }
      if (method === 'GET' && edge === 'conversations') {
        return listPage(
          [...nodes.values()]
            .filter((conv) => conv.kind === 'conversation' && conv.pageId === node.id)
            .map((conv) => pick(conv.fields, query)),
          query,
        );
      }
      if (edge === 'insights') return pageInsights(node, query);
    }

    // --- ad account edges -------------------------------------------------
    if (node.kind === 'adaccount' && segments.length === 2 && method === 'GET') {
      const level = { campaigns: 'campaign', adsets: 'adset', ads: 'ad' }[edge];
      if (level !== undefined) {
        return listPage(
          [...nodes.values()]
            .filter((obj) => obj.kind === 'adobject' && obj.level === level)
            .map((obj) => pick(obj.fields, query)),
          query,
        );
      }
      if (edge === 'insights') {
        return ok({
          data: [
            {
              account_id: node.fields.account_id,
              account_currency: 'USD',
              spend: '12.34',
              impressions: '1000',
              reach: '800',
              clicks: '25',
              ctr: '2.5',
              date_start: graphTime(now() - 7 * 86_400_000).slice(0, 10),
              date_stop: graphTime(now()).slice(0, 10),
            },
          ],
        });
      }
    }

    // --- post / comment / video edges --------------------------------------
    if (segments.length === 2 && edge === 'comments') {
      if (method === 'GET') {
        // `filter=stream` flattens every descendant into one chronological list;
        // the default (`toplevel`) returns direct children only.
        const source =
          query.get('filter') === 'stream' ? descendantsOf(node.id) : commentsOf(node.id);
        const rows = source.map((comment) => pick(commentView(comment), query));
        const wantsSummary =
          /summary\(true\)|summary=true/.test(query.get('fields') ?? '') ||
          query.get('summary') === 'true' ||
          query.get('summary') === '1';
        return listPage(rows, query, {
          summary: wantsSummary
            ? { order: 'chronological', total_count: rows.length, can_comment: true }
            : undefined,
        });
      }
      if (method === 'POST') return createComment(node, form);
    }
    if (segments.length === 2 && edge === 'reactions' && method === 'GET') {
      return listPage([], query, {
        summary: { total_count: 3, viewer_reaction: 'NONE' },
      });
    }
    if (segments.length === 2 && edge === 'messages' && node.kind === 'conversation') {
      if (method === 'GET')
        return listPage(
          node.messages.map((m) => pick(m, query)),
          query,
        );
    }
    if (segments.length === 2 && (edge === 'insights' || edge === 'video_insights')) {
      return objectInsights(node, edge, query);
    }
    void third;
    return undefined;
  }

  // ---- views ---------------------------------------------------------------

  function nodeView(node, query) {
    switch (node.kind) {
      case 'post':
        return pick(postView(node), query);
      case 'comment':
        return pick(commentView(node), query);
      case 'video':
        return pick(videoView(node), query);
      default:
        return pick(node.fields, query);
    }
  }

  function postView(post) {
    return {
      ...post.fields,
      is_published: post.published === true,
      comments: { data: [], summary: { total_count: commentsOf(post.id).length } },
      reactions: { data: [], summary: { total_count: 3 } },
    };
  }

  function videoView(video) {
    return {
      ...video.fields,
      status: {
        video_status: 'ready',
        uploading_phase: {
          status: 'complete',
          bytes_transferred: video.bytesReceived ?? 0,
        },
        processing_phase: { status: 'complete' },
        publishing_phase: {
          status: video.published ? 'complete' : 'not_started',
          ...(video.fields.scheduled_publish_time !== undefined
            ? {
                publish_status: 'scheduled',
                publish_time: video.fields.scheduled_publish_time,
              }
            : {}),
        },
      },
    };
  }

  function scheduledReelView(video) {
    return {
      id: `${video.pageId}_${video.postId}`,
      message: video.fields.description,
      created_time: video.fields.created_time,
      scheduled_publish_time: video.fields.scheduled_publish_time,
      is_published: false,
    };
  }

  // ---- writes --------------------------------------------------------------

  function createPost(page, form) {
    const postId = `${page.id}_${nextId()}`;
    const scheduled = form.get('published') === 'false';
    const scheduledAt = form.get('scheduled_publish_time');
    put({
      kind: 'post',
      id: postId,
      pageId: page.id,
      published: !scheduled,
      fields: {
        id: postId,
        message: form.get('message') ?? '',
        created_time: graphTime(now()),
        from: { id: page.id, name: page.fields.name },
        ...(form.get('link') ? { link: form.get('link') } : {}),
        ...(scheduledAt ? { scheduled_publish_time: Number(scheduledAt) } : {}),
      },
    });
    return ok({ id: postId });
  }

  function createPhoto(page, form) {
    const photoId = nextId();
    const published = form.get('published') !== 'false';
    const postId = `${page.id}_${nextId()}`;
    put({
      kind: 'photo',
      id: photoId,
      pageId: page.id,
      fields: {
        id: photoId,
        name: form.get('caption') ?? form.get('message') ?? '',
        created_time: graphTime(now()),
        from: { id: page.id, name: page.fields.name },
        images: [{ height: 1, width: 1, source: 'https://scontent.example/photo.jpg' }],
      },
    });
    if (published) {
      put({
        kind: 'post',
        id: postId,
        pageId: page.id,
        published: true,
        photoId,
        fields: {
          id: postId,
          message: form.get('caption') ?? form.get('message') ?? '',
          created_time: graphTime(now()),
          from: { id: page.id, name: page.fields.name },
        },
      });
      return ok({ id: photoId, post_id: postId });
    }
    return ok({ id: photoId });
  }

  function createComment(parent, form) {
    const commentId = `${parent.id.split('_').at(-1)}_${nextId()}`;
    put({
      kind: 'comment',
      id: commentId,
      parentId: parent.id,
      pageId: parent.pageId,
      hidden: false,
      fields: {
        id: commentId,
        message: form.get('message') ?? '',
        created_time: graphTime(now()),
        from: { id: parent.pageId, name: 'Rehearsal Test Page' },
        like_count: 0,
        can_hide: false,
        can_remove: true,
        can_reply_privately: false,
      },
    });
    return ok({ id: commentId });
  }

  function updateNode(node, form) {
    if (node.kind === 'comment' && form.has('is_hidden')) {
      node.hidden = form.get('is_hidden') === 'true';
      return ok({ success: true });
    }
    if (form.has('message')) node.fields.message = form.get('message');
    if (node.kind === 'post' && form.get('is_published') === 'true')
      node.published = true;
    return ok({ success: true });
  }

  function reelPhase(page, form) {
    const phase = form.get('upload_phase');
    if (phase === 'start') {
      const videoId = nextId();
      put({
        kind: 'video',
        id: videoId,
        pageId: page.id,
        reel: true,
        published: false,
        fields: {
          id: videoId,
          created_time: graphTime(now()),
          from: { id: page.id, name: page.fields.name },
          updated_time: graphTime(now()),
        },
      });
      return ok({
        video_id: videoId,
        upload_url: `https://rupload.facebook.com/video-upload/v23.0/${videoId}`,
      });
    }
    if (phase === 'finish') {
      const video = live(form.get('video_id') ?? '');
      if (video === undefined) return notFound(form.get('video_id'));
      const state = form.get('video_state') ?? 'PUBLISHED';
      video.fields.description = form.get('description') ?? '';
      video.postId = nextId();
      video.published = state === 'PUBLISHED';
      if (state === 'SCHEDULED') {
        video.fields.scheduled_publish_time = Number(form.get('scheduled_publish_time'));
      }
      return ok({ success: true, ...(video.published ? { post_id: video.postId } : {}) });
    }
    return undefined;
  }

  // ---- insights ------------------------------------------------------------

  const DAY = 86_400_000;

  function pageInsights(page, query) {
    const metrics = (query.get('metric') ?? '').split(',').filter(Boolean);
    const since = Number(query.get('since') ?? 0) * 1000;
    const until = Number(query.get('until') ?? 0) * 1000;
    const known = new Set([
      'page_media_view',
      'page_follows',
      'page_impressions',
      'page_post_engagements',
    ]);
    const data = [];
    for (const metric of metrics) {
      if (!known.has(metric)) continue;
      const values = [];
      const start = since > 0 ? utcDayMs(since) : utcDayMs(now()) - 7 * DAY;
      const end = until > 0 ? utcDayMs(until) : utcDayMs(now());
      for (let t = start; t < end; t += DAY) {
        values.push({ value: 5, end_time: graphTime(t + DAY + 7 * 3_600_000) });
      }
      data.push({
        name: metric,
        period: query.get('period') ?? 'day',
        values,
        title: metric,
        description: `Rehearsal ${metric}`,
        id: `${page.id}/insights/${metric}/${query.get('period') ?? 'day'}`,
      });
    }
    return ok({ data });
  }

  function objectInsights(node, edge, query) {
    const metrics = (query.get('metric') ?? '').split(',').filter(Boolean);
    return ok({
      data: metrics.map((metric) => ({
        name: metric,
        period: 'lifetime',
        values: [{ value: 7 }],
        title: metric,
        description: `Rehearsal ${metric}`,
        id: `${node.id}/${edge}/${metric}/lifetime`,
      })),
    });
  }

  // ---- HTTP ----------------------------------------------------------------

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const buffer = await readBody(req);
    const { params: form, bytes } = parseBody(buffer, req.headers['content-type'] ?? '');
    // Graph paths start with the API version; a rupload path is whatever the
    // start phase's `upload_url` named (`/video-upload/<version>/<video-id>`), so
    // it is kept whole and only a graph host must carry a leading version.
    // The version is recorded too, so a rehearsal can prove the ads tools reach
    // the Marketing API pin and everything else stays on the Graph pin.
    const rupload = /^\/__host\/(rupload\.facebook\.com)(\/.*)$/.exec(url.pathname);
    const graph =
      rupload === null
        ? /^\/__host\/(graph(?:-video)?\.facebook\.com)\/(v\d+\.\d+)(\/.*)?$/.exec(
            url.pathname,
          )
        : null;
    const match = rupload ?? graph;
    const host = match?.[1];
    const version = graph?.[2] ?? null;
    const pathAfterVersion = (rupload !== null ? rupload[2] : graph?.[3]) ?? '/';
    const segments = pathAfterVersion.split('/').filter(Boolean).map(decodeURIComponent);
    const auth = String(req.headers.authorization ?? '');
    // Graph takes `Bearer <token>`; rupload is documented as `OAuth <token>`.
    const scheme = /^(Bearer|OAuth) (.+)$/.exec(auth);
    const token = scheme !== null ? scheme[2] : url.searchParams.get('access_token');

    const record = {
      method: req.method,
      host: host ?? '(none)',
      version,
      path: `/${segments.join('/')}`,
      query: [...url.searchParams.keys()].filter((key) => key !== 'access_token').sort(),
      form: [...form.keys()].sort(),
      bytes,
      status: 0,
    };
    requests.push(record);

    let answer;
    if (match === null) {
      answer = graphError(
        400,
        100,
        `the fake Graph only serves /__host/<host>/<version>/…, got ${url.pathname}`,
      );
      unhandled.push(record);
    } else if (!Object.values(REHEARSAL_TOKENS).includes(token ?? '')) {
      answer = graphError(
        401,
        190,
        'Invalid OAuth access token - Cannot parse access token',
      );
    } else {
      try {
        // The server sends a POST's `params` in the QUERY and its `body` as a
        // form (src/core/http.ts); Graph reads both, so the fake merges them,
        // body winning.
        const params = new URLSearchParams(req.method === 'POST' ? url.searchParams : '');
        for (const [key, value] of form) params.set(key, value);
        answer = handle({
          method: req.method,
          host,
          segments,
          query: url.searchParams,
          form: params,
          bytes,
        });
      } catch (err) {
        answer = graphError(
          500,
          1,
          `fake Graph crashed: ${err instanceof Error ? err.stack : String(err)}`,
        );
        unhandled.push({ ...record, crash: String(err) });
      }
      if (answer === undefined) {
        answer = graphError(
          400,
          100,
          `(#100) the rehearsal fake does not model ${req.method} ${record.path}`,
        );
        unhandled.push(record);
      }
    }

    record.status = answer.status;
    const versionHeaders = {};
    if (version !== null) versionHeaders['facebook-api-version'] = version;
    if (
      adVersionWarning !== undefined &&
      version !== null &&
      segments[0]?.startsWith('act_') === true
    ) {
      versionHeaders['x-ad-api-version-warning'] = adVersionWarning;
    }
    res.writeHead(answer.status, {
      'content-type': 'application/json; charset=UTF-8',
      ...versionHeaders,
      ...(answer.headers ?? {}),
    });
    res.end(JSON.stringify(answer.body));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    ids,
    tokens: REHEARSAL_TOKENS,
    requests,
    unhandled,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// Graph-shaped READ helpers for Page posts, Reels and reactions (task V01,
// `api` layer). Everything here is plumbing + pure data shaping: edge-name
// validation, the documented default field sets, the pagination hand-off to
// `fetchPage`, and the normalisation of Graph's nested count objects into flat
// scalars. No zod, no `defineTool`, no result shaping — those live in
// `src/tools/reader.ts` (layer 3).
//
// Design decisions (justified against the corpus):
//   * FOUR listing edges, validated by name (`published_posts` default, plus
//     `feed`, `posts`, `tagged`). `/published_posts` is the canonical "list my
//     posts" edge; `/feed` additionally contains VISITOR posts, so the caller
//     can tell the model whether what it is reading is attacker-authorable
//     (doc 03 §Reading, security review finding 1).
//   * Every listing goes through `fetchPage` — the single pagination path. The
//     token-bearing `paging.next` URL is never followed or surfaced; only the
//     opaque `after` cursor crosses this boundary (C3 / CC-PAGE-4).
//   * HONESTY NOTES ARE DATA, NOT PROSE. The ~600-ranked-posts-per-year cap
//     (CC-PUB-3) and the Reels invisibility of the post edges (doc 03 §Reels)
//     are emitted as an in-band `note` on the RESULT, not only in the tool
//     description: a model that paginates to the end must not read "no
//     nextCursor" as "this is the complete history" (UX #4).
//   * Reaction TOTALS come from ONE field-expansion call on the post node
//     (`reactions.type(LOVE).limit(0).summary(total_count).as(love)`, doc 03
//     §reactions) rather than N calls; the per-USER list is a separate
//     paginated edge read, because Graph withholds most reactor identities from
//     third-party apps and the list length is therefore NOT the count.
//   * Field sets are DEFAULTS, not whitelists: each function takes a `fields`
//     override so a Graph-side rename cannot brick the tool (doc 03's
//     pass-through philosophy). Unknown keys in a response pass through
//     normalisation untouched.

import type { Cursor, FbRequestFn, PageRequest, ParamValue } from '../core/index.js';
import { CURSOR_EXPIRED_NOTE, fetchPage, type EdgeRequest } from './shared.js';

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * The four Page post listing edges (doc 06 `facebook_list_posts`). They differ
 * in authorship, not just ordering:
 *
 *   * `published_posts` — posts the PAGE published (the canonical listing).
 *   * `feed`            — the Page timeline INCLUDING posts visitors wrote.
 *   * `posts`           — the Page's own posts as shown on the timeline.
 *   * `tagged`          — content in which the Page is tagged (visitor-authored).
 */
export const POST_LIST_EDGES = ['published_posts', 'feed', 'posts', 'tagged'] as const;

export type PostListEdge = (typeof POST_LIST_EDGES)[number];

/** The default listing edge — Page-authored posts only (doc 06). */
export const DEFAULT_POST_LIST_EDGE: PostListEdge = 'published_posts';

/**
 * The edges that can contain content written by ARBITRARY Facebook users. A
 * caller surfacing these must mark the result as untrusted UGC (B1 / security
 * review finding 1) — a visitor post is attacker-controllable input.
 */
export const VISITOR_CONTENT_EDGES: readonly PostListEdge[] = ['feed', 'tagged'];

/** The `/video_reels` edge — the ONLY place Page Reels are readable (doc 03 §Reels). */
export const REELS_EDGE = 'video_reels';

/** Type guard for a post listing edge name. */
export function isPostListEdge(value: string): value is PostListEdge {
  return (POST_LIST_EDGES as readonly string[]).includes(value);
}

/** True when the edge can return visitor-authored (untrusted) content. */
export function isVisitorContentEdge(edge: PostListEdge): boolean {
  return VISITOR_CONTENT_EDGES.includes(edge);
}

/**
 * Validate an optional edge name, defaulting to {@link DEFAULT_POST_LIST_EDGE}.
 * Defence in depth: the tool layer constrains this with a zod enum, so a bad
 * value can only arrive from a direct `api`-layer caller — which should fail
 * loudly rather than build a request against a made-up edge.
 *
 * @throws RangeError when `value` is not one of {@link POST_LIST_EDGES}.
 */
export function resolvePostListEdge(value: string | undefined): PostListEdge {
  if (value === undefined) return DEFAULT_POST_LIST_EDGE;
  if (!isPostListEdge(value)) {
    throw new RangeError(
      `unknown post listing edge "${value}" — expected one of ${POST_LIST_EDGES.join(', ')}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Default field sets
// ---------------------------------------------------------------------------

/**
 * Fields requested per item of a post LISTING. Deliberately lean — a listing
 * multiplies every field by `limit`, and the result budget is shared
 * (CC-PAGE-5). `from{id,name}` is included so the caller can tell Page-authored
 * from visitor-authored items on the `feed`/`tagged` edges.
 */
export const POST_LIST_FIELDS =
  'id,created_time,message,story,permalink_url,status_type,is_published,' +
  'is_hidden,from{id,name}';

/**
 * Fields requested for a SINGLE post (doc 06: `permalink_url`, `attachments`,
 * `shares`, reactions summary). The `.limit(0).summary(total_count)` expansions
 * fetch counts without dragging in comment/reaction bodies.
 */
export const POST_DETAIL_FIELDS =
  'id,created_time,updated_time,message,story,permalink_url,status_type,' +
  'is_published,is_hidden,scheduled_publish_time,full_picture,from{id,name},' +
  'attachments{media_type,type,title,description,unshimmed_url},shares,' +
  'comments.limit(0).summary(total_count),reactions.limit(0).summary(total_count)';

/**
 * Fields requested per Reel on `/video_reels`. Reels are VIDEO nodes, so this
 * is the video field set, not the post one. Best-effort and overridable: the
 * Reels read surface is pending live Phase-2 verification (doc 10), and an
 * invalid field is recoverable by passing an explicit `fields` override.
 */
export const REEL_LIST_FIELDS =
  'id,created_time,updated_time,title,description,length,permalink_url,' +
  'published,status{video_status}';

/** Fields requested per reacting user on `/{post-id}/reactions`. */
export const REACTION_USER_FIELDS = 'id,name,type';

// ---------------------------------------------------------------------------
// Reaction types
// ---------------------------------------------------------------------------

/**
 * The reaction types Graph exposes on Page content. CARE is accepted as a
 * filter but Graph FOLDS CARE into the LIKE total (doc 03 §reactions), so the
 * per-type numbers do not necessarily sum to the overall total.
 */
export const REACTION_TYPES = [
  'LIKE',
  'LOVE',
  'CARE',
  'HAHA',
  'WOW',
  'SAD',
  'ANGRY',
] as const;

export type ReactionType = (typeof REACTION_TYPES)[number];

/** Type guard for a reaction type name. */
export function isReactionType(value: string): value is ReactionType {
  return (REACTION_TYPES as readonly string[]).includes(value);
}

/**
 * Validate an optional reaction-type filter (`undefined` ⇒ no filter, i.e. all
 * types). Same defence-in-depth rationale as {@link resolvePostListEdge}.
 *
 * @throws RangeError when `value` is not one of {@link REACTION_TYPES}.
 */
export function resolveReactionType(value: string | undefined): ReactionType | undefined {
  if (value === undefined) return undefined;
  if (!isReactionType(value)) {
    throw new RangeError(
      `unknown reaction type "${value}" — expected one of ${REACTION_TYPES.join(', ')}`,
    );
  }
  return value;
}

/**
 * Build the field-expansion string that returns every requested per-type total
 * (plus the overall total) in a SINGLE request:
 * `reactions.limit(0).summary(total_count).as(total),reactions.type(LOVE)…as(love)`.
 * `limit(0)` keeps the user arrays empty — only the summaries are wanted.
 */
export function reactionSummaryFields(types: readonly ReactionType[]): string {
  const parts = [`reactions.limit(0).summary(total_count).as(${TOTAL_ALIAS})`];
  for (const type of types) {
    parts.push(
      `reactions.type(${type}).limit(0).summary(total_count).as(${aliasFor(type)})`,
    );
  }
  return parts.join(',');
}

/** Alias carrying the all-types total in a {@link reactionSummaryFields} response. */
const TOTAL_ALIAS = 'total';

/** Per-type alias: lowercased type name (`LOVE` ⇒ `love`). */
function aliasFor(type: ReactionType): string {
  return type.toLowerCase();
}

// ---------------------------------------------------------------------------
// Model-facing honesty notes (in-band, not just in the tool description)
// ---------------------------------------------------------------------------

/**
 * Emitted when a post listing yields no forward cursor. Deliberately worded as
 * "no cursor came back", NOT as "there are no further pages" — those are two
 * different facts and this layer cannot tell them apart:
 *
 *   * Graph RANKS these edges and serves only roughly the most recent ~600 posts
 *     per year (CC-PUB-3), so even a genuinely terminal page is not a full
 *     history (UX #4); and
 *   * a walk also ends without a forward cursor when `paging.next` carried no
 *     extractable `after` (Graph paginates some edges by `until` /
 *     `__paging_token`), where a further page demonstrably exists but cannot be
 *     resumed. `fetchPage` marks that shape `truncated`, so the two ARE
 *     distinguishable here — but the rows past it are unreachable either way,
 *     and the ~600/year cap is a fact about both.
 *
 * Claiming completeness in either case would be a false statement to the model,
 * which is exactly the failure this note exists to prevent.
 */
export const RANKING_CAP_NOTE =
  'No forward cursor came back, which does NOT establish that you have the ' +
  'whole history: the Graph post edges are ranked and serve only roughly the ' +
  'most recent ~600 posts per year, and Graph sometimes ends a walk without a ' +
  'resumable cursor while older posts still exist. Report this as a partial ' +
  'listing, never as the complete post history.';

/** Emitted on every post listing: the post edges never contain Reels (doc 03 §Reels). */
export const REELS_NOT_LISTED_NOTE =
  'Reels are never returned by the post edges — list them with facebook_list_reels.';

/** Emitted on every reactions read: identities are permission-limited (doc 03). */
export const REACTION_IDENTITY_NOTE =
  'Reactor identities are permission-limited for third-party apps, so `users` is ' +
  'usually far shorter than the totals — report the totals, never the list length.';

/** Emitted whenever a LIKE total is part of the answer (UX #20a). */
export const CARE_FOLDED_NOTE =
  'Graph folds CARE reactions into the LIKE total, so per-type totals need not ' +
  'sum to the overall total.';

/** Join the present note fragments into one model-facing sentence run. */
function composeNote(parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => p !== undefined && p.length > 0);
  return kept.length > 0 ? kept.join(' ') : undefined;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * A normalised Graph node: Graph's own snake_case keys pass through verbatim
 * (so a `fields` override keeps working), with `id` guaranteed present and the
 * nested count objects flattened to scalars (`share_count`, `comment_count`,
 * `reaction_count`).
 */
export interface GraphRecord {
  /** Composite post id (`{page-id}_{post-id}`) or object id, exactly as Graph returned it. */
  readonly id: string;
  readonly [key: string]: unknown;
}

/** One reacting user, as far as the token's permissions allow (usually very few). */
export interface ReactionUser {
  readonly id?: string;
  readonly name?: string;
  readonly type?: string;
}

/** Keys replaced by flat scalars during normalisation (their nested form is dropped). */
const FLATTENED_KEYS: ReadonlySet<string> = new Set([
  'shares',
  'comments',
  'reactions',
  // Nested edge paging carries the access token; the shaper strips it too, but
  // dropping it here means it never travels through the api layer at all (C3).
  'paging',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Read `{ summary: { total_count } }` off an expanded edge, defensively (CC-NET-2). */
function summaryTotal(node: unknown): number | undefined {
  if (!isRecord(node)) return undefined;
  const summary = node.summary;
  return isRecord(summary) ? readNumber(summary.total_count) : undefined;
}

/**
 * Normalise one Graph node: pass unknown fields through, guarantee a string
 * `id` (empty only when the caller's `fields` override omitted it), and flatten
 * `shares.count` / `comments.summary.total_count` /
 * `reactions.summary.total_count` into `share_count` / `comment_count` /
 * `reaction_count`. The input is never mutated.
 */
export function normalizeNode(raw: unknown): GraphRecord {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (FLATTENED_KEYS.has(key)) continue;
    out[key] = src[key];
  }
  out.id = readString(src.id) ?? '';

  const shareCount = isRecord(src.shares) ? readNumber(src.shares.count) : undefined;
  if (shareCount !== undefined) out.share_count = shareCount;
  const commentCount = summaryTotal(src.comments);
  if (commentCount !== undefined) out.comment_count = commentCount;
  const reactionCount = summaryTotal(src.reactions);
  if (reactionCount !== undefined) out.reaction_count = reactionCount;

  return out as GraphRecord;
}

/** Normalise one reacting user, keeping only the three documented fields. */
export function normalizeReactionUser(raw: unknown): ReactionUser {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  const id = readString(src.id);
  const name = readString(src.name);
  const type = readString(src.type);
  return {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(type !== undefined ? { type } : {}),
  };
}

// ---------------------------------------------------------------------------
// Option shapes
// ---------------------------------------------------------------------------

/** Per-page credential + abort seam every read carries (never a global token). */
export interface RequestOptions {
  /** Page token resolved by the caller (`ResolvedPage.token`) — C1. */
  readonly token?: string;
  readonly signal?: AbortSignal;
}

/** A read that walks one cursor page of an edge. */
export interface PagedOptions extends RequestOptions {
  readonly limit?: number;
  readonly after?: Cursor;
}

export interface ListPostsOptions extends PagedOptions {
  readonly pageId: string;
  /** Edge name; validated by {@link resolvePostListEdge}. Omitted ⇒ `published_posts`. */
  readonly edge?: string;
  /** Overrides {@link POST_LIST_FIELDS}. */
  readonly fields?: string;
}

export interface ListReelsOptions extends PagedOptions {
  readonly pageId: string;
  /** Overrides {@link REEL_LIST_FIELDS}. */
  readonly fields?: string;
}

export interface GetPostOptions extends RequestOptions {
  /** Composite post id (`{page-id}_{post-id}`) as returned by a listing. */
  readonly postId: string;
  /** Overrides {@link POST_DETAIL_FIELDS}. */
  readonly fields?: string;
}

export interface GetReactionsOptions extends PagedOptions {
  readonly postId: string;
  /** Single reaction type to restrict to; validated by {@link resolveReactionType}. */
  readonly type?: string;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** Cursor-pagination fields shared by every listing result. */
interface PagedResult {
  /** Opaque forward cursor for the next page; absent ⇒ no further page. */
  readonly nextCursor?: Cursor;
  /** True when the page is PARTIAL (cursor expiry) rather than complete. */
  readonly truncated: boolean;
  /** Model-facing guidance: cursor expiry, ranking cap, Reels invisibility. */
  readonly note?: string;
}

export interface PostListResult extends PagedResult {
  readonly pageId: string;
  readonly edge: PostListEdge;
  /** True when this edge can contain visitor-authored (untrusted) content. */
  readonly visitorContent: boolean;
  readonly posts: readonly GraphRecord[];
  readonly count: number;
}

export interface ReelListResult extends PagedResult {
  readonly pageId: string;
  readonly reels: readonly GraphRecord[];
  readonly count: number;
}

export interface PostDetailResult {
  readonly postId: string;
  readonly post: GraphRecord;
}

export interface ReactionsResult extends PagedResult {
  readonly postId: string;
  /** The applied type filter, absent ⇒ all types. */
  readonly type?: ReactionType;
  /** Overall reaction total across all types, when Graph reported it. */
  readonly total?: number;
  /** Per-type totals, keyed by reaction type (only the requested types). */
  readonly totals: Readonly<Record<string, number>>;
  /** The permission-limited reactor list — almost always shorter than `total`. */
  readonly users: readonly ReactionUser[];
  readonly userCount: number;
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

/** Build the `fetchPage` edge descriptor (the helper owns `limit`/`after`). */
function edgeOf(
  path: string,
  params: Readonly<Record<string, ParamValue>>,
  opts: RequestOptions,
): EdgeRequest {
  return {
    host: 'graph',
    path,
    params,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

/** Build the `fetchPage` page descriptor from the caller's paging arguments. */
function pageOf(opts: PagedOptions): PageRequest {
  return {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.after !== undefined ? { after: opts.after } : {}),
  };
}

/** Issue a single non-paginated GET on a node. */
async function getNode(
  fbRequest: FbRequestFn,
  path: string,
  fields: string,
  opts: RequestOptions,
): Promise<unknown> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path,
    params: { fields },
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  return res.data;
}

/**
 * Project a `fetchPage` result onto the cursor-pagination fields of a
 * {@link PagedResult}, optionally replacing the note with a composed one (the
 * helper's own expiry note is then expected to be folded into `noteOverride`).
 */
function pagedFields(
  page: {
    readonly nextCursor?: Cursor;
    readonly truncated: boolean;
    readonly note?: string;
  },
  noteOverride?: string,
): PagedResult {
  const note = noteOverride ?? page.note;
  return {
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    truncated: page.truncated,
    ...(note !== undefined ? { note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/**
 * List one cursor page of a Page's posts from the selected edge. Emits the
 * ranking-cap note whenever no forward cursor comes back (CC-PUB-3) and the
 * Reels-invisibility note always (UX #4); a cursor-expiry note from `fetchPage`
 * is preserved ahead of both (CC-PAGE-2).
 *
 * @throws RangeError for an unknown `edge` name; Graph errors propagate.
 */
export async function listPosts(
  fbRequest: FbRequestFn,
  opts: ListPostsOptions,
): Promise<PostListResult> {
  const edge = resolvePostListEdge(opts.edge);
  const page = await fetchPage<unknown>(
    fbRequest,
    edgeOf(`/${opts.pageId}/${edge}`, { fields: opts.fields ?? POST_LIST_FIELDS }, opts),
    pageOf(opts),
  );
  const posts = page.data.map(normalizeNode);
  // No forward cursor means the walk stops here — it does NOT mean the history
  // ends here, and it does not even mean Graph reported no next page. See
  // RANKING_CAP_NOTE. The single shape that skips the cap note is an expired
  // cursor: its rows are gone entirely and "restart the listing" is the whole
  // story, so the cap warning would only add noise. A page that ended without a
  // usable `after` still keeps it — `truncated` says the rows are unreachable,
  // the cap note says how much history was never in reach to begin with.
  const noForwardCursor =
    page.nextCursor === undefined && page.note !== CURSOR_EXPIRED_NOTE;
  const note = composeNote([
    page.note,
    noForwardCursor ? RANKING_CAP_NOTE : undefined,
    REELS_NOT_LISTED_NOTE,
  ]);
  return {
    pageId: opts.pageId,
    edge,
    visitorContent: isVisitorContentEdge(edge),
    posts,
    count: posts.length,
    ...pagedFields(page, note),
  };
}

/**
 * Fetch one post node by its composite id. Returns the normalised node; Graph
 * errors (missing permission, unknown id) propagate to the error matrix.
 */
export async function getPost(
  fbRequest: FbRequestFn,
  opts: GetPostOptions,
): Promise<PostDetailResult> {
  const data = await getNode(
    fbRequest,
    `/${opts.postId}`,
    opts.fields ?? POST_DETAIL_FIELDS,
    opts,
  );
  return { postId: opts.postId, post: normalizeNode(data) };
}

/**
 * List one cursor page of a Page's Reels via `/video_reels` — the only edge
 * that returns them (doc 03 §Reels). No ranking-cap note: the ~600/year cap is
 * a property of the post edges, not this one.
 */
export async function listReels(
  fbRequest: FbRequestFn,
  opts: ListReelsOptions,
): Promise<ReelListResult> {
  const page = await fetchPage<unknown>(
    fbRequest,
    edgeOf(
      `/${opts.pageId}/${REELS_EDGE}`,
      { fields: opts.fields ?? REEL_LIST_FIELDS },
      opts,
    ),
    pageOf(opts),
  );
  const reels = page.data.map(normalizeNode);
  return {
    pageId: opts.pageId,
    reels,
    count: reels.length,
    ...pagedFields(page),
  };
}

/**
 * Read reactions on a post: per-type totals plus the (permission-limited)
 * reactor list. Two requests, deliberately:
 *
 *   1. ONE field-expansion GET on the post node yielding every requested
 *      per-type total and the overall total (doc 03 §reactions).
 *   2. ONE paginated GET on `/{post-id}/reactions` for the reactor list, which
 *      third-party apps mostly cannot see — hence the identity note.
 *
 * @throws RangeError for an unknown `type`; Graph errors propagate.
 */
export async function getReactions(
  fbRequest: FbRequestFn,
  opts: GetReactionsOptions,
): Promise<ReactionsResult> {
  const type = resolveReactionType(opts.type);
  const types: readonly ReactionType[] = type === undefined ? REACTION_TYPES : [type];

  const summary = await getNode(
    fbRequest,
    `/${opts.postId}`,
    reactionSummaryFields(types),
    opts,
  );
  const node: Record<string, unknown> = isRecord(summary) ? summary : {};
  const totals: Record<string, number> = {};
  for (const candidate of types) {
    const count = summaryTotal(node[aliasFor(candidate)]);
    if (count !== undefined) totals[candidate] = count;
  }
  const total = summaryTotal(node[TOTAL_ALIAS]);

  const page = await fetchPage<unknown>(
    fbRequest,
    edgeOf(
      `/${opts.postId}/reactions`,
      {
        fields: REACTION_USER_FIELDS,
        ...(type !== undefined ? { type } : {}),
      },
      opts,
    ),
    pageOf(opts),
  );
  const users = page.data.map(normalizeReactionUser);
  const note = composeNote([
    page.note,
    REACTION_IDENTITY_NOTE,
    types.includes('LIKE') || type === 'CARE' ? CARE_FOLDED_NOTE : undefined,
  ]);

  return {
    postId: opts.postId,
    ...(type !== undefined ? { type } : {}),
    ...(total !== undefined ? { total } : {}),
    totals,
    users,
    userCount: users.length,
    ...pagedFields(page, note),
  };
}

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

import { GraphApiError } from '../core/index.js';
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

/**
 * Emitted on every post listing: what the post edges never contain. Reels live
 * only on `/video_reels` (doc 03 §Reels); scheduled posts sit on
 * `/scheduled_posts` until their publish time, and unpublished drafts are on no
 * listing this server reads. Naming Reels alone implies everything else is
 * here, so a scheduled post missing from the page would read as "never created"
 * — the conclusion the write tools' verify notes exist to prevent (CC-PUB-1).
 */
export const REELS_NOT_LISTED_NOTE =
  'Reels are never returned by the post edges — list them with facebook_list_reels. ' +
  'Scheduled posts are not returned either until their publish time (list them with ' +
  'facebook_list_scheduled_posts), and unpublished drafts are on no listing this ' +
  'server reads, so a post missing here may still exist as a scheduled post or a draft.';

/**
 * Emitted on an EMPTY post page that still hands back a forward cursor. Graph
 * can answer a slice with `data: []` next to `paging.next` (CC-PAGE-1); bare,
 * `count: 0` beside {@link REELS_NOT_LISTED_NOTE} reads as "this Page has no
 * posts" when the next page is one call away.
 */
export const EMPTY_POSTS_PAGE_MORE_FOLLOWS_NOTE =
  'No posts on this page, but Graph returned a forward cursor — more pages ' +
  'follow. Resume with `nextCursor` before concluding anything about how many ' +
  'posts this Page has.';

/**
 * The Reels counterpart of {@link EMPTY_POSTS_PAGE_MORE_FOLLOWS_NOTE}: an empty
 * `/video_reels` slice next to a forward cursor is not "this Page has no Reels".
 */
export const EMPTY_REELS_PAGE_MORE_FOLLOWS_NOTE =
  'No Reels on this page, but Graph returned a forward cursor — more pages ' +
  'follow. Resume with `nextCursor` before concluding anything about how many ' +
  'Reels this Page has.';

/**
 * Emitted on a default-field post read that carries `comment_count`. The default
 * set asks for `comments.limit(0).summary(total_count)` with no `filter`, i.e.
 * Graph's `toplevel` view, whose `total_count` leaves replies out — so the bare
 * number is smaller than the thread a person sees whenever anyone replied.
 */
export const TOPLEVEL_COMMENT_COUNT_NOTE =
  '`comment_count` counts top-level comments only — replies are not included. For a ' +
  'count that includes replies use facebook_list_comments with filter "stream" and ' +
  'include_summary true.';

/** Emitted on every reactions read: identities are permission-limited (doc 03). */
export const REACTION_IDENTITY_NOTE =
  'Reactor identities are permission-limited for third-party apps, so `users` is ' +
  'usually far shorter than the totals — report the totals, never the list length.';

/** Emitted whenever a LIKE total is part of the answer (UX #20a). */
export const CARE_FOLDED_NOTE =
  'Graph folds CARE reactions into the LIKE total, so per-type totals need not ' +
  'sum to the overall total.';

/**
 * Operator/model guidance on the error thrown when a node read comes back 200
 * with no node in it (a bare `false`, `null`, an empty body, a string or an
 * array). Graph answers some reads of an object the token cannot see with a
 * bare `false`; normalising that into `{ id: "" }` would report a successful
 * read of an empty post instead of a failed lookup.
 */
export const NODE_NOT_RETURNED_TEXT =
  'Graph answered 200 but returned no object for this id — it does not exist, ' +
  'was deleted, or is not visible to this Page token. Nothing was read: do not ' +
  'report it as an empty post or as having no reactions. Re-check the id with ' +
  'facebook_list_posts.';

/**
 * Emitted when a reaction total that was asked for did not come back. An absent
 * total next to a short (usually empty) reactor list otherwise reads as "nobody
 * reacted" — a claim nothing on the wire made.
 */
export function reactionTotalsUnknownNote(missing: readonly string[]): string {
  return (
    `Graph did not report ${missing.join(', ')}: those figures are UNKNOWN, not ` +
    'zero — say they are unavailable, never report them as 0.'
  );
}

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

/**
 * Keys whose flat scalar (`share_count`, …) replaces the nested object — but
 * only when that object is JUST the count. The default field sets ask for these
 * as `.limit(0).summary(total_count)`, so their `data` is empty and the summary
 * is the whole payload; dropping it then is the point of normalisation. A
 * `fields` OVERRIDE (`comments{message,from}`) asks for the rows themselves,
 * and those are the caller's answer — dropping them would report a post as
 * having no comments moments after Graph handed them over.
 */
const COUNT_KEYS: ReadonlySet<string> = new Set(['shares', 'comments', 'reactions']);

/** The Graph key whose value embeds the live access token (C3 / CC-PAGE-4). */
const PAGING_KEY = 'paging';

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
 * Drop every `paging` object from a passed-through value, at ANY depth. A
 * `fields` expansion (`attachments{...}`, `likes{...}`) returns the edge as
 * `{ data, paging }`, so the token-bearing `paging.next` sits BELOW the node's
 * top level — where the key loop in {@link normalizeNode} never reaches it. The
 * value is rebuilt, never mutated.
 */
/**
 * Assign a shaped field. `JSON.parse` creates `__proto__` as an OWN property, so
 * a Graph node can carry one and `Object.keys` hands it straight to the shaper —
 * where a plain `out[key] = value` runs the inherited `__proto__` setter and
 * re-parents the record instead of defining a field, silently losing it. Mirrors
 * `setOwn` in `src/mcp/result.ts`.
 */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  out[key] = value;
}

/** Whether an expansion actually returned rows, as opposed to only a summary. */
function hasRows(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.data) && value.data.length > 0;
}

/**
 * Marker set on an expanded edge whose `paging` advertised a further page. The
 * paging object itself must go (C3), but it was also the only evidence that the
 * rows shown are Graph's FIRST page of that edge, not all of it.
 */
export const EXPANSION_HAS_MORE_KEY = 'has_more';

/** Whether a Graph `paging` object advertises a further page. */
function advertisesNext(paging: unknown): boolean {
  return isRecord(paging) && typeof paging.next === 'string' && paging.next.length > 0;
}

function stripNestedPaging(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNestedPaging);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === PAGING_KEY) continue;
    setOwn(out, key, stripNestedPaging(value[key]));
  }
  // Dropping the paging silently would hand the caller the first page of an
  // expansion (`comments{message}` ⇒ 25 comments) as if it were the whole edge.
  if (advertisesNext(value[PAGING_KEY])) out[EXPANSION_HAS_MORE_KEY] = true;
  return out;
}

/** Top-level fields of a normalised node holding an expansion marked as cut short. */
function partialExpansions(node: GraphRecord): string[] {
  const hit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hit);
    if (!isRecord(value)) return false;
    if (value[EXPANSION_HAS_MORE_KEY] === true) return true;
    return Object.values(value).some(hit);
  };
  return Object.keys(node).filter((key) => hit(node[key]));
}

/**
 * Emitted when an expanded field returned only Graph's first page of rows. The
 * row count of such an expansion is NOT its total.
 */
export function partialExpansionNote(fields: readonly string[]): string {
  return (
    `The expanded field(s) ${fields.join(', ')} returned only Graph's first page of ` +
    `rows (marked ${EXPANSION_HAS_MORE_KEY}: true); more exist that this read does not ` +
    'include. Never report the rows shown as the full set or count them as the total.'
  );
}

/** The partial-expansion note for a set of nodes, or `undefined` when none was cut. */
function partialExpansionNoteFor(nodes: readonly GraphRecord[]): string | undefined {
  const fields = new Set<string>();
  for (const node of nodes) for (const key of partialExpansions(node)) fields.add(key);
  return fields.size > 0 ? partialExpansionNote([...fields]) : undefined;
}

/**
 * Normalise one Graph node: pass unknown fields through, guarantee a string
 * `id` (empty only when the caller's `fields` override omitted it), and flatten
 * `shares.count` / `comments.summary.total_count` /
 * `reactions.summary.total_count` into `share_count` / `comment_count` /
 * `reaction_count`. Those three keys are dropped only when they carried nothing
 * but the count; an expansion that returned rows is kept, because the rows are
 * what the caller's `fields` override asked for. Nested edge `paging` is
 * dropped at every depth, so no token-bearing URL travels on through the api
 * layer (C3). The input is never mutated.
 */
export function normalizeNode(raw: unknown): GraphRecord {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    // Top-level `paging` carries the access token; the shaper strips it too, but
    // dropping it here means it never travels through the api layer at all (C3).
    if (key === PAGING_KEY) continue;
    if (COUNT_KEYS.has(key) && !hasRows(src[key])) continue;
    setOwn(out, key, stripNestedPaging(src[key]));
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
  /** Model-facing guidance on what a flattened count does and does not include. */
  readonly note?: string;
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
 * Require a node-shaped (non-array object) body from a node read, else throw a
 * not-found {@link GraphApiError} naming the id (see {@link NODE_NOT_RETURNED_TEXT}).
 */
function requireNode(data: unknown, id: string): Record<string, unknown> {
  if (isRecord(data) && !Array.isArray(data)) return data;
  throw new GraphApiError(
    `no object returned for id '${id}' — ${NODE_NOT_RETURNED_TEXT}`,
    {
      code: 0,
      httpStatus: 200,
      action: {
        category: 'not_found',
        retryable: false,
        nextTool: 'facebook_list_posts',
        operatorText: NODE_NOT_RETURNED_TEXT,
      },
    },
  );
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
  const emptyWithCursor = posts.length === 0 && page.nextCursor !== undefined;
  const note = composeNote([
    page.note,
    emptyWithCursor ? EMPTY_POSTS_PAGE_MORE_FOLLOWS_NOTE : undefined,
    partialExpansionNoteFor(posts),
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
  const post = normalizeNode(requireNode(data, opts.postId));
  // Only the default field set is known to ask for the top-level view; an
  // override chose its own comments expansion, whose filter this layer cannot see.
  const toplevelCount = opts.fields === undefined && post.comment_count !== undefined;
  // The default set asks for both summaries, and Graph reports a post nobody
  // commented on or reacted to as `total_count: 0` — so a missing count was not
  // reported (typically withheld from this token), never "none". Omitted
  // silently, the post reads as having no comments / no reactions.
  const unreported =
    opts.fields === undefined
      ? (['comment_count', 'reaction_count'] as const).filter(
          (key) => post[key] === undefined,
        )
      : [];
  const note = composeNote([
    toplevelCount ? TOPLEVEL_COMMENT_COUNT_NOTE : undefined,
    unreported.length > 0 ? reactionTotalsUnknownNote(unreported) : undefined,
    partialExpansionNoteFor([post]),
  ]);
  return {
    postId: opts.postId,
    post,
    ...(note !== undefined ? { note } : {}),
  };
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
  const emptyWithCursor = reels.length === 0 && page.nextCursor !== undefined;
  const note = composeNote([
    page.note,
    emptyWithCursor ? EMPTY_REELS_PAGE_MORE_FOLLOWS_NOTE : undefined,
    partialExpansionNoteFor(reels),
  ]);
  return {
    pageId: opts.pageId,
    reels,
    count: reels.length,
    ...pagedFields(page, note),
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
  const node = requireNode(summary, opts.postId);
  const totals: Record<string, number> = {};
  const missing: string[] = [];
  const total = summaryTotal(node[TOTAL_ALIAS]);
  // The all-types figure is only the answer on an unfiltered read; under a
  // filter its absence is no gap in what was asked.
  if (type === undefined && total === undefined) missing.push('the overall total');
  for (const candidate of types) {
    const count = summaryTotal(node[aliasFor(candidate)]);
    if (count !== undefined) totals[candidate] = count;
    else missing.push(candidate);
  }

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
    missing.length > 0 ? reactionTotalsUnknownNote(missing) : undefined,
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

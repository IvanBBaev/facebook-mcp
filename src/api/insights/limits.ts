// Documented limits and window constants of the insights read (X09 split of `insights.ts`).

// ---------------------------------------------------------------------------
// 1. Documented limits
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of per-point rows a single insights read emits. Sized
 * so a full result (rows + summaries + notes) stays well inside the default
 * ~25k `FB_MAX_RESULT_CHARS` budget, leaving the shaper's structure-aware
 * truncation as a backstop rather than the primary defense (CC-INS-4).
 */
export const INSIGHTS_MAX_ROWS = 250;

/**
 * Longest `since`..`until` window this server reads per insights query. Graph
 * itself accepts up to 93 days; 90 keeps a margin inside that maximum (doc 03).
 */
export const INSIGHTS_MAX_WINDOW_DAYS = 90;

/** Follower/like floor below which a Page returns empty insights (CC-INS-2). */
export const PAGE_INSIGHTS_LIKES_FLOOR = 100;

/** `YYYY-MM-DD` — the only date form these tools accept for `since`/`until`. */
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Leading calendar date of a Graph `end_time` (`2026-07-01T07:00:00+0000`). */
export const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

export const MS_PER_DAY = 86_400_000;

/**
 * Facebook Page Insights daily buckets are defined in Pacific Time, not the
 * operator's local timezone and not a Page-node timezone field. Using the IANA
 * zone rather than a fixed UTC offset keeps DST boundaries correct.
 */
export const META_INSIGHTS_TIMEZONE = 'America/Los_Angeles';

/** The literal `window.boundary`: `since` is inclusive, `until` exclusive. */
export const INSIGHTS_WINDOW_BOUNDARY = '[since, until)';

/** Top-level `contractVersion` of every insights result (F1, 2.0.0). */
export const INSIGHTS_CONTRACT_VERSION = 2;

/** Deepest breakdown nesting flattened into `breakdown` paths before giving up. */
export const MAX_BREAKDOWN_DEPTH = 3;

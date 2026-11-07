// Local stores (X08 split of `core/types.ts`): activity high-water marks and
// operator-curated saved replies.

/**
 * Per-Page high-water marks of `facebook_get_activity_since` (ISO instants).
 * One mark per section, so a truncated or failed section can stay behind while
 * the healthy one advances. Holds Page ids and timestamps only — no tokens, no UGC.
 */
export interface ActivityMarks {
  readonly commentsSeenAt?: string;
  readonly conversationsSeenAt?: string;
  readonly updatedAt?: string;
}

/**
 * Local store of {@link ActivityMarks}. Like the {@link Journal} it NEVER
 * throws: a state failure must not fail a read. `get` answers `undefined` for
 * "nothing stored" and `'unreadable'` when the file exists but cannot be used;
 * `set` merges the given marks into the Page's entry.
 */
export interface ActivityCursorStore {
  get(pageId: string): Promise<ActivityMarks | undefined | 'unreadable'>;
  set(pageId: string, marks: ActivityMarks): Promise<'ok' | 'failed'>;
}

/**
 * One operator-curated reply template (v2 messaging F10). The text is authored
 * by the operator, not by a Facebook user, so it is trusted content; the only
 * placeholder is `{{page_name}}`, filled from the resolved Page.
 */
export interface SavedReply {
  /** Slug `^[a-z0-9][a-z0-9-]{0,47}$`, unique per Page. */
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
  /** ISO instant of the last save. */
  readonly updatedAt: string;
}

/** What {@link SavedReplyStore.save} did. */
export interface SavedReplyWrite {
  readonly reply: SavedReply;
  /** True when the id was new; false when an existing reply was overwritten. */
  readonly created: boolean;
  /** The record that was replaced, so an overwrite can be undone. */
  readonly previous?: SavedReply;
}

/**
 * Local store of {@link SavedReply} records, keyed by Page id. Unlike the
 * journal it DOES throw (`SavedRepliesError`): the data is operator-owned, so
 * a corrupt file is reported, never silently replaced.
 */
export interface SavedReplyStore {
  /** Absolute path of the backing file, for messages and the doctor. */
  readonly path: string;
  list(pageId: string): Promise<readonly SavedReply[]>;
  get(pageId: string, id: string): Promise<SavedReply | undefined>;
  save(
    pageId: string,
    reply: Omit<SavedReply, 'updatedAt'>,
    options: { readonly overwrite: boolean },
  ): Promise<SavedReplyWrite>;
  /** Remove one reply and return it; throws `not_found` when absent. */
  remove(pageId: string, id: string): Promise<SavedReply>;
}

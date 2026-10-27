// Page moderation settings for the `moderation` package (v2 moderation F12, `api` layer).
//
// Wire facts encoded here (V16):
//   * read  — `GET /{page-id}/settings` answers `data[].{setting, value}`.
//   * write — `POST /{page-id}/settings` with ONE `option` object per call:
//       `{"PAGE_MODERATION_BLACKLIST":"w1,w2,..."}` (the FULL comma-separated list)
//       `{"PROFANITY_FILTER":"OFF"|"MEDIUM"|"STRONG"}`
//   * `USERS_CAN_MESSAGE` is read-only here.
//
// The blocked-word list is written whole, so the tool layer computes it from a
// delta against a fresh read and binds the read's fingerprint to the plan.
//
// Open probe P-7: whether the write works on a New Page Experience Page, and with
// which scope. Reads are documented for NPE Pages.

import { createHash } from 'node:crypto';

import type { FbRequestFn } from '../core/index.js';

export const BLOCKED_WORDS_SETTING = 'PAGE_MODERATION_BLACKLIST';
export const PROFANITY_FILTER_SETTING = 'PROFANITY_FILTER';
export const USERS_CAN_MESSAGE_SETTING = 'USERS_CAN_MESSAGE';

export const PROFANITY_LEVELS = ['OFF', 'MEDIUM', 'STRONG'] as const;
export type ProfanityLevel = (typeof PROFANITY_LEVELS)[number];

export interface ModerationSettings {
  /** The blocked words, in Graph's order. Empty when the list is empty or unread. */
  readonly blockedWords: readonly string[];
  /** False when Graph did not return the blocked-word setting at all. */
  readonly blockedWordsKnown: boolean;
  readonly profanityFilter: ProfanityLevel | null;
  readonly usersCanMessage: boolean | null;
}

interface SettingsScope {
  readonly pageId: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowsOf(body: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(body)) return [];
  const data: unknown = body['data'];
  if (!Array.isArray(data)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const row of data as readonly unknown[]) {
    if (isRecord(row)) rows.push(row);
  }
  return rows;
}

/** Split Graph's comma-separated list; blanks are dropped. */
export function parseBlockedWords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return (value as readonly unknown[])
      .filter((w): w is string => typeof w === 'string')
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

function parseProfanity(value: unknown): ProfanityLevel | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return (PROFANITY_LEVELS as readonly string[]).includes(upper)
    ? (upper as ProfanityLevel)
    : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return null;
}

/** Shape a `/{page}/settings` body; unknown settings are ignored. */
export function shapeModerationSettings(body: unknown): ModerationSettings {
  let blockedWords: string[] = [];
  let blockedWordsKnown = false;
  let profanityFilter: ProfanityLevel | null = null;
  let usersCanMessage: boolean | null = null;
  for (const row of rowsOf(body)) {
    const setting = row['setting'];
    const value = row['value'];
    if (setting === BLOCKED_WORDS_SETTING) {
      blockedWords = parseBlockedWords(value);
      blockedWordsKnown = true;
    } else if (setting === PROFANITY_FILTER_SETTING) {
      profanityFilter = parseProfanity(value);
    } else if (setting === USERS_CAN_MESSAGE_SETTING) {
      usersCanMessage = parseBoolean(value);
    }
  }
  return { blockedWords, blockedWordsKnown, profanityFilter, usersCanMessage };
}

/**
 * A fingerprint of the state a plan is bound to: a hash of the case-folded,
 * sorted word list plus the filter level. Order-insensitive, so Graph returning
 * the same words in another order is not a divergence.
 */
export function moderationFingerprint(settings: ModerationSettings): {
  readonly blockedWordsHash: string;
  readonly blockedWordsKnown: boolean;
  readonly profanityFilter: ProfanityLevel | null;
} {
  const sorted = settings.blockedWords.map((w) => w.toLowerCase()).sort();
  return {
    blockedWordsHash: createHash('sha256')
      .update(JSON.stringify(sorted), 'utf8')
      .digest('hex')
      .slice(0, 16),
    blockedWordsKnown: settings.blockedWordsKnown,
    profanityFilter: settings.profanityFilter,
  };
}

export interface BlockedWordsDelta {
  /** The full list to write: the current words, minus `removed`, plus `added`. */
  readonly next: readonly string[];
  /** Words actually added (new to the list), as given. */
  readonly added: readonly string[];
  /** Words actually removed (were on the list), as they were stored. */
  readonly removed: readonly string[];
  /** Requested additions already on the list. */
  readonly alreadyPresent: readonly string[];
  /** Requested removals not on the list. */
  readonly notPresent: readonly string[];
}

/**
 * Apply an add/remove delta. Words are trimmed and compared case-insensitively;
 * the current list keeps its order and spelling, additions go at the end.
 */
export function applyBlockedWordsDelta(
  current: readonly string[],
  delta: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
): BlockedWordsDelta {
  const key = (w: string): string => w.trim().toLowerCase();
  const removeKeys = new Set((delta.remove ?? []).map(key));
  const currentKeys = new Set(current.map(key));

  const removed = current.filter((w) => removeKeys.has(key(w)));
  const notPresent = dedupe((delta.remove ?? []).map((w) => w.trim())).filter(
    (w) => !currentKeys.has(key(w)),
  );
  const kept = current.filter((w) => !removeKeys.has(key(w)));
  const keptKeys = new Set(kept.map(key));

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const word of dedupe((delta.add ?? []).map((w) => w.trim()))) {
    if (keptKeys.has(key(word))) alreadyPresent.push(word);
    else {
      added.push(word);
      keptKeys.add(key(word));
    }
  }
  return { next: [...kept, ...added], added, removed, alreadyPresent, notPresent };
}

function dedupe(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const k = word.toLowerCase();
    if (word.length === 0 || seen.has(k)) continue;
    seen.add(k);
    out.push(word);
  }
  return out;
}

function scopeFields(input: SettingsScope): { token?: string; signal?: AbortSignal } {
  return {
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
}

/** Read the Page's moderation settings. */
export async function readModerationSettings(
  fbRequest: FbRequestFn,
  input: SettingsScope,
): Promise<ModerationSettings> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${input.pageId}/settings`,
    ...scopeFields(input),
  });
  return shapeModerationSettings(res.data);
}

/** The `option` body of one settings write. */
export function settingOption(
  write:
    | { readonly setting: 'blocked_words'; readonly words: readonly string[] }
    | { readonly setting: 'profanity_filter'; readonly level: ProfanityLevel },
): Record<string, string> {
  return write.setting === 'blocked_words'
    ? { [BLOCKED_WORDS_SETTING]: write.words.join(',') }
    : { [PROFANITY_FILTER_SETTING]: write.level };
}

/**
 * Write one setting (one option per POST, V16). Returns whether the answer
 * confirms it: a bodiless 2xx or `true` confirms, a record unless its `success`
 * flag is anything but `true`.
 */
export async function writeModerationSetting(
  fbRequest: FbRequestFn,
  input: SettingsScope & { readonly option: Readonly<Record<string, string>> },
): Promise<boolean> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${input.pageId}/settings`,
    body: { option: input.option },
    ...scopeFields(input),
  });
  const body: unknown = res.data;
  if (body === undefined || body === true) return true;
  if (!isRecord(body)) return false;
  const flag: unknown = body['success'];
  return flag === undefined || flag === true;
}

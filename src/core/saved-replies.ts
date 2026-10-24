// Local saved replies (v2 messaging F10).
//
// One operator-curated JSON file — `{version:1, profiles:{<pageId>: SavedReply[]}}`
// — holds reply templates the agent can send verbatim instead of re-wording the
// same policy answer every time. No Graph call is involved. The rules differ
// from the activity state on purpose, because this data is owned, not derived:
//
//   * LOUD, NOT SELF-HEALING. A corrupt or foreign-shaped file is a
//     `config_error` naming the file, and it is never overwritten: replacing it
//     would silently delete the operator's templates.
//   * ATOMIC + 0600. Writes go through `atomicWriteFile` (temp file + rename,
//     owner-only), so a reader never sees half a file.
//   * SERIALIZED. Read-modify-write cycles in this process run one at a time on
//     a FIFO, so two concurrent saves cannot lose each other's record.
//   * TRUSTED TEXT, ONE PLACEHOLDER. `{{page_name}}` is the only placeholder and
//     it is filled from the resolved Page. Nothing is ever filled from user data
//     (a commenter's name and so on): tainted text must not flow silently into
//     an outbound message, so the agent writes such details itself.
//
// Records are keyed by Page id rather than by profile alias, so a Page reached
// through its alias and through its id sees the same set.

import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from './config.js';
import { errorMessageOf } from './errors.js';
import type { Clock, SavedReply, SavedReplyStore, SavedReplyWrite } from './types.js';

/** The on-disk format version this module reads and writes. */
export const SAVED_REPLIES_VERSION = 1;

/** Most replies one Page may hold. */
export const MAX_SAVED_REPLIES = 200;

/** Longest template text: the Messenger cap, so a template fits every channel. */
export const MAX_SAVED_REPLY_CHARS = 2000;

/** Longest title. */
export const MAX_SAVED_REPLY_TITLE_CHARS = 100;

/** Most tags on one reply. */
export const MAX_SAVED_REPLY_TAGS = 10;

/** A reply id: a lowercase slug of at most 48 characters. */
export const SAVED_REPLY_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** A tag: a lowercase slug of at most 32 characters. */
export const SAVED_REPLY_TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The placeholders a template may use, filled from trusted values only. */
export const SAVED_REPLY_PLACEHOLDERS: readonly string[] = ['page_name'];

const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Why a saved-reply operation was refused. */
export type SavedRepliesErrorCode = 'config_error' | 'conflict' | 'not_found' | 'limit';

/** A refusal from the saved-replies store, with a machine-readable code. */
export class SavedRepliesError extends Error {
  readonly code: SavedRepliesErrorCode;

  constructor(code: SavedRepliesErrorCode, message: string) {
    super(message);
    this.name = 'SavedRepliesError';
    this.code = code;
    Object.setPrototypeOf(this, SavedRepliesError.prototype);
  }
}

/** The whole file. */
export interface SavedRepliesData {
  readonly version: number;
  readonly profiles: Readonly<Record<string, readonly SavedReply[]>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyData(): SavedRepliesData {
  return { version: SAVED_REPLIES_VERSION, profiles: {} };
}

function corrupt(filePath: string, why: string): SavedRepliesError {
  return new SavedRepliesError(
    'config_error',
    `The saved replies file ${filePath} is not usable (${why}). It was left untouched; ` +
      'fix or move it, then retry.',
  );
}

/** Validate one stored record, or say what is wrong with it. */
function parseReply(raw: unknown): SavedReply | string {
  if (!isRecord(raw)) return 'a reply is not an object';
  const { id, title, text, tags, updatedAt } = raw;
  if (typeof id !== 'string' || !SAVED_REPLY_ID_RE.test(id))
    return 'a reply has an invalid id';
  if (typeof title !== 'string' || title.length === 0) return `reply ${id} has no title`;
  if (typeof text !== 'string' || text.length === 0) return `reply ${id} has no text`;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
    return `reply ${id} has invalid tags`;
  }
  if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) {
    return `reply ${id} has an invalid updatedAt`;
  }
  return { id, title, text, tags, updatedAt };
}

/** Parse the file text; throws a `config_error` naming the file when unusable. */
export function parseSavedReplies(filePath: string, text: string): SavedRepliesData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw corrupt(filePath, 'not valid JSON');
  }
  if (!isRecord(parsed)) throw corrupt(filePath, 'not a JSON object');
  if (parsed.version !== SAVED_REPLIES_VERSION) {
    throw corrupt(
      filePath,
      `unsupported version ${JSON.stringify(parsed.version) ?? 'none'}`,
    );
  }
  if (!isRecord(parsed.profiles)) throw corrupt(filePath, '`profiles` is not an object');
  const profiles: Record<string, readonly SavedReply[]> = Object.create(null) as Record<
    string,
    readonly SavedReply[]
  >;
  for (const [key, list] of Object.entries(parsed.profiles)) {
    if (!Array.isArray(list)) throw corrupt(filePath, `profile ${key} is not a list`);
    const replies: SavedReply[] = [];
    for (const raw of list) {
      const reply = parseReply(raw);
      if (typeof reply === 'string') throw corrupt(filePath, reply);
      replies.push(reply);
    }
    profiles[key] = replies;
  }
  return { version: SAVED_REPLIES_VERSION, profiles };
}

/** Read the file; an absent file is an empty set, anything unusable throws. */
export async function loadSavedReplies(filePath: string): Promise<SavedRepliesData> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyData();
    throw new SavedRepliesError(
      'config_error',
      `Could not read the saved replies file ${filePath}: ${errorMessageOf(err)}`,
    );
  }
  return parseSavedReplies(filePath, text);
}

/** Write the whole file atomically with mode 0600. */
export async function writeSavedReplies(
  filePath: string,
  data: SavedRepliesData,
): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/** The placeholders in `text` this build does not fill, in order of appearance. */
export function unknownPlaceholders(text: string): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] ?? '';
    if (!SAVED_REPLY_PLACEHOLDERS.includes(name) && !unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return unknown;
}

/** Fill the trusted placeholders of a template. */
export function fillSavedReply(
  text: string,
  values: { readonly pageName: string },
): string {
  return text.replace(PLACEHOLDER_RE, (whole, name: string) =>
    name === 'page_name' ? values.pageName : whole,
  );
}

/** Derive a reply id from a title: lowercase ASCII slug, at most 48 characters. */
export function slugifyTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug;
}

/** Construction dependencies for {@link createSavedReplyStore}. */
export interface SavedReplyStoreDeps {
  /** Absolute path of the file (`savedRepliesPath()` by default). */
  readonly filePath: string;
  readonly clock: Clock;
}

/** Create the file-backed {@link SavedReplyStore}. */
export function createSavedReplyStore(deps: SavedReplyStoreDeps): SavedReplyStore {
  const { filePath, clock } = deps;
  let queue: Promise<unknown> = Promise.resolve();

  /** Run one read-modify-write after every earlier one has settled. */
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function update<T>(
    pageId: string,
    change: (current: readonly SavedReply[]) => { next: readonly SavedReply[]; out: T },
  ): Promise<T> {
    return serialized(async () => {
      const data = await loadSavedReplies(filePath);
      const { next, out } = change(data.profiles[pageId] ?? []);
      const profiles: Record<string, readonly SavedReply[]> = { ...data.profiles };
      if (next.length === 0) {
        delete profiles[pageId];
      } else {
        profiles[pageId] = next;
      }
      await writeSavedReplies(filePath, { version: SAVED_REPLIES_VERSION, profiles });
      return out;
    });
  }

  return {
    path: filePath,
    list: async (pageId) => (await loadSavedReplies(filePath)).profiles[pageId] ?? [],
    get: async (pageId, id) =>
      ((await loadSavedReplies(filePath)).profiles[pageId] ?? []).find(
        (r) => r.id === id,
      ),
    save: (pageId, input, { overwrite }) =>
      update<SavedReplyWrite>(pageId, (current) => {
        const reply: SavedReply = {
          ...input,
          updatedAt: new Date(clock.now()).toISOString(),
        };
        const index = current.findIndex((r) => r.id === input.id);
        if (index >= 0) {
          if (!overwrite) {
            throw new SavedRepliesError(
              'conflict',
              `A saved reply with id "${input.id}" already exists. Pass overwrite:true to ` +
                'replace it, or choose another id.',
            );
          }
          const previous = current[index] as SavedReply;
          const next = current.map((r, i) => (i === index ? reply : r));
          return { next, out: { reply, created: false, previous } };
        }
        if (current.length >= MAX_SAVED_REPLIES) {
          throw new SavedRepliesError(
            'limit',
            `This Page already has ${String(MAX_SAVED_REPLIES)} saved replies, the maximum. ` +
              'Delete one with facebook_delete_saved_reply first.',
          );
        }
        return { next: [...current, reply], out: { reply, created: true } };
      }),
    remove: (pageId, id) =>
      update<SavedReply>(pageId, (current) => {
        const found = current.find((r) => r.id === id);
        if (found === undefined) {
          throw new SavedRepliesError(
            'not_found',
            `No saved reply with id "${id}" for this Page. List them with ` +
              'facebook_list_saved_replies.',
          );
        }
        return { next: current.filter((r) => r.id !== id), out: found };
      }),
  };
}

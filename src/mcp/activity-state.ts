// Local high-water marks for facebook_get_activity_since (v2 insights F3).
//
// One small JSON file — `{version:1, pages:{<pageId>:{commentsSeenAt,
// conversationsSeenAt, updatedAt}}}` — remembers, per Page, the horizon of the
// last read that was allowed to advance it. It follows the journal's rules:
//
//   * NEVER THROWS. A state failure must not fail a Graph read: `get` answers
//     `'unreadable'` and `set` answers `'failed'`, and the caller turns either
//     into a note.
//   * NO SECRETS, NO UGC. Page ids and ISO instants only; nothing a redactor
//     needs to see.
//   * ATOMIC + 0600. A write goes to a temp file in the same directory and is
//     renamed over the live one, so a reader never sees half a file. The temp
//     file is created 0600 and chmod-ed again (umask-proof); the state dir is
//     created 0700. On Windows the parent-directory ACL governs instead
//     (`describeFileProtection`).
//   * SELF-HEALING. A corrupt or foreign-shaped file reads as `'unreadable'`
//     and the next successful `set` replaces it with a valid one.
//   * SERIALIZED. Writes in this process run one at a time on a FIFO, so two
//     concurrent calls cannot lose each other's Page entry. Separate server
//     processes may still race (last rename wins); losing a mark costs one
//     re-read window, never data.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessageOf } from '../core/index.js';
import type { ActivityCursorStore, ActivityMarks } from '../core/index.js';

/** The on-disk format version this module reads and writes. */
export const ACTIVITY_STATE_VERSION = 1;

/** Construction dependencies for {@link createActivityStateStore}. */
export interface ActivityStateDeps {
  /** Absolute path of the state file (`Settings.activityStatePath`). */
  readonly statePath: string;
  /**
   * Sink for a failure note. Defaults to a `console.error` line on stderr —
   * never stdout, which is the stdio JSON-RPC channel.
   */
  readonly onError?: (message: string) => void;
}

interface StateFile {
  readonly version: number;
  readonly pages: Record<string, ActivityMarks>;
}

const MARK_KEYS = ['commentsSeenAt', 'conversationsSeenAt', 'updatedAt'] as const;

/** Graph Page ids are digit strings; anything else is never a key on disk. */
const PAGE_ID_RE = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep only well-formed ISO marks; anything else is dropped, not trusted. */
function cleanMarks(raw: unknown): ActivityMarks {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const key of MARK_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
      out[key] = value;
    }
  }
  return out;
}

/** Parse the file text, or `undefined` when it is not a version-1 state file. */
function parseState(text: string): StateFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== ACTIVITY_STATE_VERSION) return undefined;
  if (!isRecord(parsed.pages)) return undefined;
  const pages: Record<string, ActivityMarks> = Object.create(null) as Record<
    string,
    ActivityMarks
  >;
  for (const [pageId, marks] of Object.entries(parsed.pages)) {
    if (PAGE_ID_RE.test(pageId)) pages[pageId] = cleanMarks(marks);
  }
  return { version: ACTIVITY_STATE_VERSION, pages };
}

/** Create the file-backed {@link ActivityCursorStore}. */
export function createActivityStateStore(deps: ActivityStateDeps): ActivityCursorStore {
  const filePath = deps.statePath;
  const dir = path.dirname(filePath);
  const isPosix = process.platform !== 'win32';
  const reportError =
    deps.onError ??
    ((message: string): void => {
      console.error(`[facebook-mcp] activity state: ${message}`);
    });
  let queue: Promise<unknown> = Promise.resolve();

  function note(message: string): void {
    try {
      reportError(message);
    } catch {
      // Deliberately empty: there is no sink left to report through.
    }
  }

  /** The whole file: `undefined` when absent, `'unreadable'` when unusable. */
  async function readState(): Promise<StateFile | undefined | 'unreadable'> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      note(`could not read ${filePath}: ${errorMessageOf(err)}`);
      return 'unreadable';
    }
    const state = parseState(text);
    if (state === undefined) {
      note(`${filePath} is not a valid activity state file; it will be replaced`);
      return 'unreadable';
    }
    return state;
  }

  async function writeState(state: StateFile): Promise<void> {
    await mkdir(dir, { recursive: true, ...(isPosix ? { mode: 0o700 } : {}) });
    const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      if (isPosix) await chmod(tmp, 0o600);
      await rename(tmp, filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  return {
    get: async (pageId) => {
      try {
        if (!PAGE_ID_RE.test(pageId)) return undefined;
        const state = await readState();
        if (state === undefined || state === 'unreadable') return state;
        const marks = state.pages[pageId];
        return marks !== undefined && Object.keys(marks).length > 0 ? marks : undefined;
      } catch (err) {
        note(`read failed: ${errorMessageOf(err)}`);
        return 'unreadable';
      }
    },
    set: (pageId, marks) => {
      const run = async (): Promise<'ok' | 'failed'> => {
        try {
          if (!PAGE_ID_RE.test(pageId)) {
            note(`refusing to store marks for a non-numeric Page id`);
            return 'failed';
          }
          const current = await readState();
          const pages: Record<string, ActivityMarks> = Object.create(null) as Record<
            string,
            ActivityMarks
          >;
          if (current !== undefined && current !== 'unreadable') {
            Object.assign(pages, current.pages);
          }
          pages[pageId] = { ...pages[pageId], ...cleanMarks(marks) };
          await writeState({ version: ACTIVITY_STATE_VERSION, pages: { ...pages } });
          return 'ok';
        } catch (err) {
          note(`write failed: ${errorMessageOf(err)}`);
          return 'failed';
        }
      };
      const next = queue.then(run, run);
      queue = next;
      return next;
    },
  };
}

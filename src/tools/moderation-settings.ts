// Page moderation settings (v2 moderation F12) — two tools of the `moderation`
// package that let Meta auto-hide recurring spam instead of handling it comment
// by comment:
//
//   * facebook_get_moderation_settings — blocked words, profanity filter, and
//     whether people can message the Page.
//   * facebook_set_moderation_settings — add / remove blocked words and set the
//     profanity filter (tier: reversible, plan_id required).
//
// The blocked-word list is written WHOLE (Graph has no add/remove), so the input
// is a delta the tool resolves against a fresh read; a model cannot wipe the list
// by passing a short one. The read's fingerprint binds the plan: a list or filter
// changed by someone else between preview and apply makes it diverge instead of
// clobbering their edit. Each setting is its own POST (V16), so a change of both
// reports one outcome per step.
//
// Blocked words are Page-authored, so they are returned as plain strings. The
// before-state is kept in the journal metadata and the applied result, which is
// what undoing the change needs.
//
// Open probe P-7: whether the write works on a New Page Experience Page, and with
// which scope. Until then a Graph refusal is reported with the Business Suite
// fallback.

import { z } from 'zod';

import type { ToolAnnotations, ToolContext, ToolSpec } from '../core/index.js';
import { GraphApiError, classifyGraphError, errorMessageOf } from '../core/index.js';
import {
  PROFANITY_LEVELS,
  applyBlockedWordsDelta,
  moderationFingerprint,
  readModerationSettings,
  settingOption,
  writeModerationSetting,
  type BlockedWordsDelta,
  type ModerationSettings,
  type ProfanityLevel,
} from '../api/page-settings.js';
import {
  APPLIED_VERDICT,
  ATTEMPTED_VERDICT,
  REFUSED_VERDICT,
  defineTool,
} from '../mcp/index.js';
import { executeWrite, gateArgs, profileArg, shapeFor, writeArgs } from './shared.js';

export const TOOL_GET_MODERATION_SETTINGS = 'facebook_get_moderation_settings';
export const TOOL_SET_MODERATION_SETTINGS = 'facebook_set_moderation_settings';

const TIER = 'reversible';

const MAX_WORD_CHARS = 80;
const MAX_WORDS_PER_CALL = 100;
/** How many words a summary names before it says "and N more". */
const SUMMARY_WORDS = 10;

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Reversible (the before-state restores it) and idempotent (same delta, same list). */
const SET_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const NPE_GUIDANCE =
  'If this Page type does not allow changing the setting through the API, change it in ' +
  'Meta Business Suite (Settings → Moderation).';

const wordArg = z
  .string()
  .trim()
  .min(1)
  .max(MAX_WORD_CHARS)
  .refine((w) => !w.includes(','), 'A blocked word cannot contain a comma.');

const wordListArg = z.array(wordArg).min(1).max(MAX_WORDS_PER_CALL).optional();

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

/**
 * A rejected POST that Graph refused changed nothing (`failed`); a transport
 * fault after the bytes left, a 5xx or an `ambiguous` error may have landed.
 */
function classifyFailure(err: unknown): 'attempted' | 'failed' {
  if (!(err instanceof GraphApiError)) return 'attempted';
  if (err.action?.category === 'ambiguous') return 'attempted';
  return err.httpStatus === 0 || err.httpStatus >= 500 ? 'attempted' : 'failed';
}

function wordsLine(words: readonly string[]): string {
  const shown = words.slice(0, SUMMARY_WORDS).join(', ');
  const more = words.length - SUMMARY_WORDS;
  return more > 0 ? `${shown}, and ${String(more)} more` : shown;
}

type StepName = 'blocked_words' | 'profanity_filter';

interface StepResult {
  readonly setting: StepName;
  readonly outcome: 'applied' | 'failed' | 'attempted' | 'skipped';
  readonly error?: string;
  readonly note?: string;
}

interface SetOutcome {
  readonly steps: readonly StepResult[];
  readonly before: {
    readonly blockedWords: readonly string[];
    readonly profanityFilter: ProfanityLevel | null;
  };
  readonly blockedWords?: readonly string[];
  readonly profanityFilter?: ProfanityLevel;
  readonly note?: string;
}

/** Every step applied ⇒ applied; nothing applied and nothing open ⇒ refused; else attempted. */
function setVerdict(outcome: SetOutcome) {
  const ran = outcome.steps.filter((s) => s.outcome !== 'skipped');
  if (ran.length > 0 && ran.every((s) => s.outcome === 'applied')) return APPLIED_VERDICT;
  if (ran.every((s) => s.outcome === 'failed')) return REFUSED_VERDICT;
  return ATTEMPTED_VERDICT;
}

interface PlannedChange {
  readonly delta?: BlockedWordsDelta;
  readonly profanity?: {
    readonly from: ProfanityLevel | null;
    readonly to: ProfanityLevel;
  };
}

function summaryOf(change: PlannedChange, pageId: string, pageName: string): string {
  const parts: string[] = [];
  if (change.delta !== undefined) {
    const d = change.delta;
    const bits = [
      ...(d.added.length > 0
        ? [`+${String(d.added.length)} (${wordsLine(d.added)})`]
        : []),
      ...(d.removed.length > 0
        ? [`−${String(d.removed.length)} (${wordsLine(d.removed)})`]
        : []),
    ];
    parts.push(
      `Blocked words: ${bits.join(', ')}, resulting list ${String(d.next.length)} words`,
    );
  }
  if (change.profanity !== undefined) {
    parts.push(
      `Profanity filter ${change.profanity.from ?? '(unknown)'} → ${change.profanity.to}`,
    );
  }
  return `Update the moderation settings of Page ${pageId} (${pageName}). ${parts.join('. ')}.`;
}

function warningsOf(
  current: ModerationSettings,
  change: PlannedChange,
  requested: { readonly add: boolean; readonly remove: boolean },
): string[] {
  const warnings: string[] = [
    'These settings apply Page-wide, to every post and comment.',
  ];
  if (change.delta !== undefined) {
    warnings.push(
      'Blocked words hide matching comments AUTOMATICALLY — the commenter and their ' +
        'friends still see them, everyone else does not.',
    );
    if (!current.blockedWordsKnown) {
      warnings.push(
        'Facebook did not return the current blocked-word list; the write REPLACES ' +
          'whatever list the Page has with the resulting list shown.',
      );
    }
    if (change.delta.alreadyPresent.length > 0 && requested.add) {
      warnings.push(
        `Already blocked, not added: ${wordsLine(change.delta.alreadyPresent)}.`,
      );
    }
    if (change.delta.notPresent.length > 0 && requested.remove) {
      warnings.push(
        `Not on the list, nothing to remove: ${wordsLine(change.delta.notPresent)}.`,
      );
    }
  }
  if (change.profanity?.to === 'OFF') {
    warnings.push(
      'The profanity filter will be OFF: Meta hides no profanity automatically.',
    );
  }
  warnings.push(
    'Keep the current values (facebook_get_moderation_settings): a second call with them ' +
      'undoes the change.',
  );
  return warnings;
}

function scopeOf(
  ctx: ToolContext,
  pageId: string,
  token: string,
): { pageId: string; token: string; signal?: AbortSignal } {
  return { pageId, token, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) };
}

export function createModerationSettingsTools(): readonly ToolSpec[] {
  const getTool = defineTool({
    name: TOOL_GET_MODERATION_SETTINGS,
    title: 'Get moderation settings',
    description:
      "Read the Page's moderation settings: the blocked-word list (comments containing " +
      'one are hidden automatically), the profanity filter level (OFF, MEDIUM, STRONG) ' +
      'and whether people can message the Page. Needs a PAGE token.',
    inputSchema: z.object({
      profile: profileArg,
    }),
    annotations: READ_ONLY,
    logFields: ['profile'],
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const settings = await readModerationSettings(
        ctx.fbRequest,
        scopeOf(ctx, resolved.pageId, resolved.token),
      );
      return shapeFor(ctx, {
        pageId: resolved.pageId,
        blockedWords: settings.blockedWords,
        blockedWordsCount: settings.blockedWords.length,
        profanityFilter: settings.profanityFilter,
        usersCanMessage: settings.usersCanMessage,
        ...(settings.blockedWordsKnown
          ? {}
          : { notes: ['Facebook did not return the blocked-word setting.'] }),
      });
    },
  });

  const setTool = defineTool({
    name: TOOL_SET_MODERATION_SETTINGS,
    title: 'Set moderation settings',
    description:
      "Change the Page's blocked words and profanity filter. blocked_words is a DELTA " +
      '(add / remove) against the current list — the tool computes and writes the full ' +
      'list, so nothing you do not name is dropped. Words are trimmed, compared ' +
      'case-insensitively and cannot contain commas. Applies Page-wide: matching comments ' +
      'are hidden automatically. The preview shows the change and the resulting list ' +
      'size; apply needs its plan_id, and a list changed by someone else in between makes ' +
      'the plan diverge. Needs a PAGE token (scope still being confirmed, probe P-7).',
    inputSchema: z.object({
      ...writeArgs,
      blocked_words: z
        .object({
          add: wordListArg.describe('Words to block (1–80 chars each, at most 100).'),
          remove: wordListArg.describe('Words to unblock (at most 100).'),
        })
        .strict()
        .optional()
        .describe(
          'Delta against the current list; the tool computes and writes the full list.',
        ),
      profanity_filter: z
        .enum(PROFANITY_LEVELS)
        .optional()
        .describe('OFF, MEDIUM or STRONG.'),
    }),
    annotations: SET_ANNOTATIONS,
    writeTier: TIER,
    // The words are Page-authored but free text; the plan carries them, the log
    // keeps the gating fields and the filter level.
    logFields: ['profile', 'apply', 'plan_id', 'profanity_filter'],
    handler: async (input, ctx) => {
      const add = input.blocked_words?.add;
      const remove = input.blocked_words?.remove;
      if (
        add === undefined &&
        remove === undefined &&
        input.profanity_filter === undefined
      ) {
        throw validationError(
          'Nothing to change: pass blocked_words.add, blocked_words.remove or profanity_filter.',
        );
      }

      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved.pageId, resolved.token);
      const read = () => readModerationSettings(ctx.fbRequest, scope);
      const current = await read();

      const rawDelta =
        add !== undefined || remove !== undefined
          ? applyBlockedWordsDelta(current.blockedWords, {
              ...(add !== undefined ? { add } : {}),
              ...(remove !== undefined ? { remove } : {}),
            })
          : undefined;
      const delta =
        rawDelta !== undefined &&
        (rawDelta.added.length > 0 || rawDelta.removed.length > 0)
          ? rawDelta
          : undefined;
      const profanity =
        input.profanity_filter !== undefined &&
        input.profanity_filter !== current.profanityFilter
          ? { from: current.profanityFilter, to: input.profanity_filter }
          : undefined;
      if (delta === undefined && profanity === undefined) {
        throw validationError(
          'Nothing to change: the blocked words and the profanity filter already hold the requested values.',
        );
      }
      const change: PlannedChange = {
        ...(delta !== undefined ? { delta } : {}),
        ...(profanity !== undefined ? { profanity } : {}),
      };
      const before = {
        blockedWords: current.blockedWords,
        profanityFilter: current.profanityFilter,
      };

      // The first fingerprint is the pre-read itself; the gate's divergence
      // re-read before the plan-bound apply goes back to Facebook.
      let preflight: ModerationSettings | undefined = current;
      return executeWrite(ctx, {
        tool: TOOL_SET_MODERATION_SETTINGS,
        tier: TIER,
        // A full-list write over an unseen concurrent edit would clobber it, and
        // the package default is apply: bind every apply to a previewed state.
        requirePlanId: true,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: {
          ...(add !== undefined ? { add } : {}),
          ...(remove !== undefined ? { remove } : {}),
          ...(input.profanity_filter !== undefined
            ? { profanity_filter: input.profanity_filter }
            : {}),
        },
        ...gateArgs(input),
        summary: summaryOf(change, resolved.pageId, resolved.name),
        warnings: warningsOf(current, change, {
          add: add !== undefined,
          remove: remove !== undefined,
        }),
        notPerformedNotice:
          'This was a dry run — the moderation settings were NOT changed.',
        readState: async () => {
          const snapshot = preflight ?? (await read());
          preflight = undefined;
          return moderationFingerprint(snapshot);
        },
        perform: async (): Promise<SetOutcome> => {
          const steps: StepResult[] = [];
          const planned: {
            readonly setting: StepName;
            readonly option: Record<string, string>;
          }[] = [
            ...(delta !== undefined
              ? [
                  {
                    setting: 'blocked_words' as const,
                    option: settingOption({
                      setting: 'blocked_words',
                      words: delta.next,
                    }),
                  },
                ]
              : []),
            ...(profanity !== undefined
              ? [
                  {
                    setting: 'profanity_filter' as const,
                    option: settingOption({
                      setting: 'profanity_filter',
                      level: profanity.to,
                    }),
                  },
                ]
              : []),
          ];
          let stopped = false;
          for (const step of planned) {
            if (stopped) {
              steps.push({
                setting: step.setting,
                outcome: 'skipped',
                note: 'Not attempted because the previous step did not apply.',
              });
              continue;
            }
            try {
              const confirmed = await writeModerationSetting(ctx.fbRequest, {
                ...scope,
                option: step.option,
              });
              steps.push(
                confirmed
                  ? { setting: step.setting, outcome: 'applied' }
                  : {
                      setting: step.setting,
                      outcome: 'failed',
                      error: 'Facebook answered without confirming the change.',
                    },
              );
              if (!confirmed) stopped = true;
            } catch (err) {
              // A first step that fails outright is the whole call's failure.
              if (steps.length === 0 && planned.length === 1) throw err;
              steps.push({
                setting: step.setting,
                outcome: classifyFailure(err),
                error: `${errorMessageOf(err)} ${NPE_GUIDANCE}`,
              });
              stopped = true;
            }
          }
          const applied = (name: StepName): boolean =>
            steps.some((s) => s.setting === name && s.outcome === 'applied');
          const ranAll = steps.every((s) => s.outcome === 'applied');
          return {
            steps,
            before,
            ...(delta !== undefined && applied('blocked_words')
              ? { blockedWords: delta.next }
              : {}),
            ...(profanity !== undefined && applied('profanity_filter')
              ? { profanityFilter: profanity.to }
              : {}),
            ...(ranAll
              ? {}
              : {
                  note:
                    'Not every step applied; read the per-step outcomes and check the ' +
                    'current state with facebook_get_moderation_settings before retrying.',
                }),
          };
        },
        classifyOutcome: classifyFailure,
        classifyResult: setVerdict,
        metadata: {
          before,
          ...(delta !== undefined
            ? {
                added: delta.added,
                removed: delta.removed,
                resultingCount: delta.next.length,
              }
            : {}),
          ...(profanity !== undefined ? { profanityFilter: profanity } : {}),
        },
      });
    },
  });

  return [getTool, setTool];
}

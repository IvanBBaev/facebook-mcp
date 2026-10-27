// The `page_admin` tool package (organic F8) — editing the Page itself rather
// than its content. Opt-in: it is off by default and needs a scope
// (`pages_manage_metadata`) the content packages do not, so enabling it is an
// explicit operator decision.
//
//   * facebook_update_page_profile — about, description, website, phone, hours,
//     is_always_open, temporary_status (tier: reversible, plan_id required).
//
// Why a reversible tool still demands a plan_id: the profile is the Page's
// public storefront, and a wrong `temporary_status` or opening hours misleads
// every visitor at once. The preview carries the before-values, so an applied
// edit can be undone by a second call with those values.
//
// Layer 3 (`tools`): the Graph plumbing, the diff and the hours conversion live
// in `../api/page-profile.js`; the write gate in `./shared.js`.

import { z } from 'zod';

import type { PackageSpec, ToolAnnotations, ToolContext } from '../core/index.js';
import { GraphApiError, classifyGraphError } from '../core/index.js';
import {
  PROFILE_DAYS,
  TEMPORARY_STATUSES,
  diffProfile,
  hasOvernightRange,
  profileMismatches,
  readProfileSnapshot,
  updatePageProfile,
  validateHours,
  type ProfileChange,
  type ProfileSnapshot,
  type ProfileUpdate,
  type ProfileWriteField,
} from '../api/page-profile.js';
import { APPLIED_VERDICT, ATTEMPTED_VERDICT, defineTool } from '../mcp/index.js';

import { executeWrite, writeArgs } from './shared.js';

const TOOL = 'facebook_update_page_profile';
const TIER = 'reversible';

/** Reversible (the before-values restore it) and idempotent (same values, same state). */
const ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const hoursRangeArg = z
  .object({
    day: z
      .enum(PROFILE_DAYS)
      .describe('Day of the week: mon, tue, wed, thu, fri, sat, sun.'),
    open: z.string().describe('Opening time, 24-hour "HH:MM".'),
    close: z
      .string()
      .describe(
        'Closing time, 24-hour "HH:MM". Earlier than `open` means the range runs past midnight; that is allowed only up to 06:00.',
      ),
  })
  .strict();

/** Fields every request names at least one of. */
const PROFILE_INPUT_FIELDS = [
  'about',
  'description',
  'website',
  'phone',
  'hours',
  'is_always_open',
  'temporary_status',
] as const;

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

/** What an applied update reports. */
interface ProfileUpdateOutcome {
  readonly changed: readonly ProfileWriteField[];
  /** The re-read profile; absent when Graph declined or the re-read failed. */
  readonly after?: ProfileSnapshot;
  /** Fields Graph accepted but now shows with a different value. */
  readonly mismatched?: readonly ProfileWriteField[];
  readonly confirmed: boolean;
  readonly note?: string;
}

const DECLINED_NOTE =
  'Graph answered the profile update with success:false, so the profile was NOT changed. ' +
  "Read it with facebook_get_page field_set:'profile' before trying again.";

const UNVERIFIED_NOTE =
  'Graph confirmed the update, but the profile could not be read back to verify it. ' +
  "Check it with facebook_get_page field_set:'profile'.";

function mismatchNote(fields: readonly ProfileWriteField[]): string {
  return (
    `Graph accepted the update but the value differs for: ${fields.join(', ')}. ` +
    'Graph may have normalized or rejected it silently — compare `after` with what you sent.'
  );
}

/** Declined ⇒ failed; accepted but a field reads back differently ⇒ attempted. */
function profileVerdict(outcome: ProfileUpdateOutcome) {
  if (!outcome.confirmed) return { outcome: 'failed' as const, applied: false };
  return (outcome.mismatched?.length ?? 0) > 0 ? ATTEMPTED_VERDICT : APPLIED_VERDICT;
}

/**
 * A rejected POST that never reached Graph, or that Graph refused, changed
 * nothing (`failed`); a transport fault after the bytes left, a 5xx or an
 * `ambiguous` error may have landed (`attempted`).
 */
function classifyFailure(err: unknown): 'attempted' | 'failed' {
  if (!(err instanceof GraphApiError)) return 'attempted';
  if (err.action?.category === 'ambiguous') return 'attempted';
  return err.httpStatus === 0 || err.httpStatus >= 500 ? 'attempted' : 'failed';
}

function changeLine(change: ProfileChange): string {
  const show = (value: string | boolean | null): string =>
    value === null
      ? '(empty)'
      : typeof value === 'string'
        ? JSON.stringify(value)
        : String(value);
  return `${change.field}: ${show(change.before)} → ${show(change.after)}`;
}

/** The requested values, with the absent fields left out. */
function requestedUpdate(input: Record<string, unknown>): ProfileUpdate {
  return Object.fromEntries(
    PROFILE_INPUT_FIELDS.filter((field) => input[field] !== undefined).map((field) => [
      field,
      input[field],
    ]),
  );
}

export function createPageAdminPackage(): PackageSpec {
  const updateProfileTool = defineTool({
    name: TOOL,
    title: 'Update Page profile',
    description:
      "Change the Page's public business fields: about, description, website, phone, " +
      'opening hours, is_always_open and temporary_status. Only the fields you pass are ' +
      'touched, and only those that differ from the current profile are sent. The ' +
      'preview shows each field before → after (keep it: the before-values undo the ' +
      'edit), and apply needs its plan_id; a profile changed by someone else after the ' +
      'preview makes the plan diverge. Needs a PAGE token with pages_manage_metadata ' +
      'and the EDIT_PROFILE task.',
    inputSchema: z.object({
      ...writeArgs,
      about: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Short "About" text, 1-100 characters.'),
      description: z
        .string()
        .min(1)
        .max(5000)
        .optional()
        .describe('Long description, 1-5000 characters.'),
      website: z
        .string()
        .url()
        .regex(/^https?:\/\//i, 'website must be an http:// or https:// URL.')
        .optional()
        .describe('Website URL (http or https).'),
      phone: z
        .string()
        .min(3)
        .max(40)
        .optional()
        .describe('Phone number as shown on the Page, 3-40 characters.'),
      hours: z
        .array(hoursRangeArg)
        .min(1)
        .max(14)
        .optional()
        .describe(
          'The FULL weekly opening hours, replacing the current ones: up to 2 ranges per day, 14 in all. A day you leave out is shown as closed. Cannot be combined with is_always_open.',
        ),
      is_always_open: z
        .boolean()
        .optional()
        .describe('true ⇒ the Page shows "Always open". Cannot be combined with hours.'),
      temporary_status: z
        .enum(TEMPORARY_STATUSES)
        .optional()
        .describe(
          'OPERATING_AS_USUAL, TEMPORARILY_CLOSED, DIFFERENTLY_OPEN or NO_DATA. TEMPORARILY_CLOSED tells every visitor the business is closed.',
        ),
    }),
    annotations: ANNOTATIONS,
    writeTier: TIER,
    // Which Page and how the call was armed; the field values are in the plan.
    logFields: ['profile', 'apply', 'plan_id'],
    handler: async (input, ctx: ToolContext) => {
      const update = requestedUpdate(input);
      if (Object.keys(update).length === 0) {
        throw validationError(
          `Nothing to update: pass at least one of ${PROFILE_INPUT_FIELDS.join(', ')}.`,
        );
      }
      if (update.hours !== undefined && update.is_always_open !== undefined) {
        throw validationError(
          'Pass either hours or is_always_open, not both: "Always open" replaces the opening hours.',
        );
      }
      if (update.hours !== undefined) validateHours(update.hours);

      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = {
        pageId: resolved.pageId,
        token: resolved.token,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      };
      const read = () => readProfileSnapshot(ctx.fbRequest, scope);
      const current = await read();
      const { changes, unchanged } = diffProfile(current, update);
      if (changes.length === 0) {
        throw validationError(
          `Nothing to update: ${unchanged.join(', ')} already hold the requested values.`,
        );
      }
      const fields = changes.map((change) => change.field);

      // The first snapshot is the pre-flight itself; the gate's divergence
      // re-read before the plan-bound apply goes back to Facebook.
      let preflight: ProfileSnapshot | undefined = current;
      return executeWrite(ctx, {
        tool: TOOL,
        tier: TIER,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: update as Readonly<Record<string, unknown>>,
        ...(input.apply !== undefined ? { apply: input.apply } : {}),
        ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
        requirePlanId: true,
        summary: `Update the profile of Page ${resolved.pageId}: ${changes.map(changeLine).join('; ')}.`,
        warnings: [
          'The profile is PUBLIC — every visitor sees the new values. Keep the before-values: a second call with them undoes the edit.',
          ...(update.temporary_status === 'TEMPORARILY_CLOSED' &&
          fields.includes('temporary_status')
            ? [
                'TEMPORARILY CLOSED: the Page will tell every visitor the business is closed until the status is changed back.',
              ]
            : []),
          ...(update.hours !== undefined && hasOvernightRange(update.hours)
            ? ['Some hours run past midnight; the close time is on the next day.']
            : []),
          ...(unchanged.length > 0
            ? [`Already set, not sent: ${unchanged.join(', ')}.`]
            : []),
        ],
        notPerformedNotice: 'This was a dry run — the Page profile was not changed.',
        readState: async () => {
          const snapshot = preflight ?? (await read());
          preflight = undefined;
          return snapshot;
        },
        perform: async (): Promise<ProfileUpdateOutcome> => {
          const confirmed = await updatePageProfile(ctx.fbRequest, {
            ...scope,
            update,
            fields,
          });
          if (!confirmed) return { changed: [], confirmed, note: DECLINED_NOTE };
          let after: ProfileSnapshot;
          try {
            after = await read();
          } catch {
            return { changed: fields, confirmed, note: UNVERIFIED_NOTE };
          }
          const mismatched = profileMismatches(after, changes);
          return {
            changed: fields,
            after,
            confirmed,
            ...(mismatched.length > 0
              ? { mismatched, note: mismatchNote(mismatched) }
              : {}),
          };
        },
        classifyOutcome: classifyFailure,
        classifyResult: profileVerdict,
        metadata: { changes },
      });
    },
  });

  return {
    name: 'page_admin',
    title: 'Page administration',
    description:
      'Edit the Page itself: its public profile (about, description, website, phone, hours, temporary status). Opt-in; needs pages_manage_metadata.',
    tools: [updateProfileTool],
    enabledByDefault: false,
    writeModeDefault: 'plan',
  };
}

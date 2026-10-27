// Custom labels on Messenger conversations (v2 messaging F11) — four tools of the
// `messages` package that tag a customer's thread so it shows in the Page inbox
// label view:
//
//   * facebook_list_labels  — the Page's labels, or the labels on one person.
//   * facebook_create_label — create a Page label (reversible: delete removes it).
//   * facebook_assign_label — put a label on one person, or take it off.
//   * facebook_delete_label — delete a label; it leaves EVERY person it was on.
//
// The spec's single `facebook_manage_label` with an `action` union is split into
// three tools, as the spec allows: each verb then carries its own write tier
// and annotations instead of a union that would have to be as strict as its
// most destructive member.
//
// Labels are invisible to the person, so create and assign are not plan-bound;
// delete is `irreversible` and goes through the full confirmation gate. A PSID
// is personal: it is bound to the plan but never logged, journaled or echoed in
// a summary. A label name is Page-authored, so it is not taint-wrapped.

import { z } from 'zod';

import type {
  PageRequest,
  ResolvedPage,
  ToolAnnotations,
  ToolContext,
  ToolSpec,
} from '../core/index.js';
import { errorMessageOf } from '../core/index.js';
import {
  createLabel,
  deleteLabel,
  getLabel,
  listLabels,
  setLabelAssigned,
} from '../api/labels.js';
import {
  APPLIED_VERDICT,
  ATTEMPTED_VERDICT,
  REFUSED_VERDICT,
  defineTool,
} from '../mcp/index.js';
import {
  confirmableWriteArgs,
  executeWrite,
  gateArgs,
  graphNodeIdArg,
  listArgs,
  shapeFor,
  writeArgs,
} from './shared.js';

export const TOOL_LIST_LABELS = 'facebook_list_labels';
export const TOOL_CREATE_LABEL = 'facebook_create_label';
export const TOOL_ASSIGN_LABEL = 'facebook_assign_label';
export const TOOL_DELETE_LABEL = 'facebook_delete_label';

const MAX_LABEL_NAME_CHARS = 64;

const PSID_SHAPE = /^\d{1,32}$/;

const LABEL_ID_HINT = 'facebook_list_labels returns it as `id`.';

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Each call creates a new label, and facebook_delete_label removes it again. */
const CREATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Assigning twice leaves one label on the person, and `remove:true` undoes it. */
const ASSIGN_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** The label and every assignment of it are gone for good. */
const DELETE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const LABEL_UNREAD_WARNING =
  'The label could not be read, so its name is not shown; check label_id with ' +
  'facebook_list_labels before applying.';

const psidArg = z.string().regex(PSID_SHAPE, 'psid must be a PSID (digits only).');

function labelIdArg(description: string): z.ZodString {
  return graphNodeIdArg({ hint: LABEL_ID_HINT, description });
}

function pageRequestFrom(input: {
  readonly limit?: number;
  readonly after?: string;
}): PageRequest {
  return {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
  };
}

function signalOf(ctx: ToolContext): { signal?: AbortSignal } {
  return ctx.signal !== undefined ? { signal: ctx.signal } : {};
}

interface LabelPreview {
  /** `label <id> ("name")`, or `label <id>` when the name is unknown. */
  readonly described: string;
  readonly warnings: readonly string[];
}

/**
 * Read the label so the preview can name it. Fails open: an unreadable label
 * still previews, with a warning, because Graph judges the id at apply time.
 */
async function describeLabel(
  ctx: ToolContext,
  resolved: ResolvedPage,
  labelId: string,
): Promise<LabelPreview> {
  try {
    const label = await getLabel(ctx.fbRequest, {
      pageId: resolved.pageId,
      labelId,
      token: resolved.token,
      ...signalOf(ctx),
    });
    if (label?.name !== undefined) {
      return { described: `label ${labelId} ("${label.name}")`, warnings: [] };
    }
    return { described: `label ${labelId}`, warnings: [LABEL_UNREAD_WARNING] };
  } catch (err) {
    return {
      described: `label ${labelId}`,
      warnings: [`${LABEL_UNREAD_WARNING} (${errorMessageOf(err)})`],
    };
  }
}

interface ConfirmedOutcome {
  readonly confirmed: boolean;
  readonly note?: string;
}

const UNCONFIRMED_NOTE =
  'Facebook answered without confirming the change; check it with facebook_list_labels.';

function confirmedOutcome(confirmed: boolean): ConfirmedOutcome {
  return confirmed ? { confirmed } : { confirmed, note: UNCONFIRMED_NOTE };
}

export function createLabelTools(): readonly ToolSpec[] {
  const listTool = defineTool({
    name: TOOL_LIST_LABELS,
    title: 'List labels',
    description:
      'List the Page’s custom Messenger labels (id and name), or — with psid — the ' +
      'labels on one person. Labels tag a thread in the Page inbox label view. Needs ' +
      'a Page token with pages_manage_metadata and the MESSAGING task, and accepted ' +
      'Page Contact Terms.',
    inputSchema: z.object({
      ...listArgs,
      psid: psidArg
        .optional()
        .describe('Only the labels on this person (their PSID, from a conversation).'),
    }),
    annotations: READ_ONLY,
    // Deliberately no `logFields`: the only argument that says anything is the
    // PSID, which identifies a person and stays off stderr.
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const page = await listLabels(ctx.fbRequest, {
        pageId: resolved.pageId,
        ...(input.psid !== undefined ? { psid: input.psid } : {}),
        token: resolved.token,
        ...signalOf(ctx),
        page: pageRequestFrom(input),
      });
      return shapeFor(ctx, {
        pageId: resolved.pageId,
        scope: input.psid !== undefined ? 'person' : 'page',
        labels: page.data,
        count: page.data.length,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        truncated: page.truncated,
        ...(page.note !== undefined ? { notes: [page.note] } : {}),
      });
    },
  });

  const createTool = defineTool({
    name: TOOL_CREATE_LABEL,
    title: 'Create label',
    description:
      'Create a custom Messenger label on the Page (for example "vip" or ' +
      '"refund-pending") and return its id, to put on people with ' +
      'facebook_assign_label. Each call creates a NEW label, so check ' +
      'facebook_list_labels first. Nobody is notified. Dry run by default; ' +
      'apply:true creates it.',
    inputSchema: z.object({
      ...writeArgs,
      name: z
        .string()
        .trim()
        .min(1)
        .max(MAX_LABEL_NAME_CHARS)
        .describe('The label name, 1–64 characters.'),
    }),
    annotations: CREATE_ANNOTATIONS,
    writeTier: 'reversible',
    // The name is Page-authored and harmless, but it is free text; the log keeps
    // only the gating fields.
    logFields: ['profile', 'apply', 'plan_id'],
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      return executeWrite(ctx, {
        tool: TOOL_CREATE_LABEL,
        tier: 'reversible',
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: { name: input.name },
        ...gateArgs(input),
        summary:
          `Create the Messenger label "${input.name}" on Page ${resolved.pageId} ` +
          `(${resolved.name}). Nobody is notified.`,
        warnings: [
          'A label with the same name may already exist — facebook_list_labels shows them.',
        ],
        notPerformedNotice: 'This was a dry run — NO label was created.',
        metadata: { action: 'create' },
        perform: async () => {
          const result = await createLabel(ctx.fbRequest, {
            pageId: resolved.pageId,
            name: input.name,
            token: resolved.token,
            ...signalOf(ctx),
          });
          return result.labelId !== undefined
            ? { labelId: result.labelId, name: input.name }
            : {
                name: input.name,
                note:
                  'Facebook accepted the request but returned no label id; check ' +
                  'facebook_list_labels before creating it again.',
              };
        },
        classifyResult: (outcome) =>
          'labelId' in outcome ? APPLIED_VERDICT : ATTEMPTED_VERDICT,
      });
    },
  });

  const assignTool = defineTool({
    name: TOOL_ASSIGN_LABEL,
    title: 'Assign label',
    description:
      'Put a custom label on one person (their PSID from a conversation), so the ' +
      'thread shows in the Page inbox label view; remove:true takes it off. The ' +
      'person is not notified. Dry run by default; apply:true changes it.',
    inputSchema: z.object({
      ...writeArgs,
      label_id: labelIdArg(
        'Label id from facebook_list_labels or facebook_create_label.',
      ),
      psid: psidArg.describe(
        'The person (PSID) to label, from facebook_get_conversation.',
      ),
      remove: z
        .boolean()
        .default(false)
        .describe('true takes the label off the person instead.'),
    }),
    annotations: ASSIGN_ANNOTATIONS,
    writeTier: 'reversible',
    // The PSID identifies a person and stays off the log, as it stays out of
    // the journal; the label id and the direction are enough to audit.
    logFields: ['profile', 'apply', 'plan_id', 'label_id', 'remove'],
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const preview = await describeLabel(ctx, resolved, input.label_id);
      const action = input.remove ? 'unassign' : 'assign';
      return executeWrite(ctx, {
        tool: TOOL_ASSIGN_LABEL,
        tier: 'reversible',
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: { labelId: input.label_id, psid: input.psid, action },
        ...gateArgs(input),
        summary: input.remove
          ? `Take ${preview.described} off one person on Page ${resolved.pageId} ` +
            `(${resolved.name}). The person is not notified.`
          : `Put ${preview.described} on one person on Page ${resolved.pageId} ` +
            `(${resolved.name}). The person is not notified.`,
        warnings: preview.warnings,
        notPerformedNotice: 'This was a dry run — NO label was changed.',
        metadata: { action, labelId: input.label_id },
        perform: async () =>
          confirmedOutcome(
            await setLabelAssigned(ctx.fbRequest, {
              pageId: resolved.pageId,
              labelId: input.label_id,
              psid: input.psid,
              assigned: !input.remove,
              token: resolved.token,
              ...signalOf(ctx),
            }),
          ),
        classifyResult: (outcome) =>
          outcome.confirmed ? APPLIED_VERDICT : REFUSED_VERDICT,
      });
    },
  });

  const deleteTool = defineTool({
    name: TOOL_DELETE_LABEL,
    title: 'Delete label',
    description:
      'PERMANENTLY delete a custom label from the Page. It disappears from EVERY ' +
      'person it was on, and the assignments cannot be restored — to take it off ' +
      'one person, use facebook_assign_label with remove:true. Always requires ' +
      'apply:true together with the plan_id from a dry run.',
    inputSchema: z.object({
      ...confirmableWriteArgs,
      label_id: labelIdArg('Label id from facebook_list_labels.'),
    }),
    annotations: DELETE_ANNOTATIONS,
    writeTier: 'irreversible',
    // Never `confirm_token`.
    logFields: ['profile', 'apply', 'plan_id', 'label_id'],
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const preview = await describeLabel(ctx, resolved, input.label_id);
      return executeWrite(ctx, {
        tool: TOOL_DELETE_LABEL,
        tier: 'irreversible',
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: { labelId: input.label_id },
        ...gateArgs(input),
        summary:
          `PERMANENTLY delete ${preview.described} from Page ${resolved.pageId} ` +
          `(${resolved.name}). It leaves every person it was on.`,
        warnings: [
          'Deletion is PERMANENT — the label and all its assignments cannot be restored.',
          ...preview.warnings,
        ],
        notPerformedNotice: 'This was a dry run — NO label was deleted.',
        metadata: { action: 'delete', labelId: input.label_id },
        perform: async () =>
          confirmedOutcome(
            await deleteLabel(ctx.fbRequest, {
              pageId: resolved.pageId,
              labelId: input.label_id,
              token: resolved.token,
              ...signalOf(ctx),
            }),
          ),
        classifyResult: (outcome) =>
          outcome.confirmed ? APPLIED_VERDICT : REFUSED_VERDICT,
      });
    },
  });

  return [listTool, createTool, assignTool, deleteTool];
}

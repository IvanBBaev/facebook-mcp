// Messenger custom labels for the `messages` package (v2 messaging F11, `api` layer).
//
// Wire facts encoded here (V12, doc 06 messages rows):
//   * Page labels   — `GET /{page-id}/custom_labels?fields=id,page_label_name`.
//   * person labels — `GET /{psid}/custom_labels?fields=id,page_label_name`.
//   * create        — `POST /{page-id}/custom_labels` with `page_label_name`, answers `{id}`.
//   * assign        — `POST /{label-id}/label` with `user=<psid>`, answers `{success}`.
//   * unassign      — `DELETE /{label-id}/label` with `user=<psid>`, answers `{success}`.
//   * delete        — `DELETE /{label-id}`, answers `{success}`; the label leaves
//     every person it was assigned to.
//
// A label name is Page-authored (an admin typed it), so it is returned as a plain
// string, like a saved-reply template, not as user-generated content. The PSID
// is personal: it travels in the request only and is never part of a result.
//
// Open probe P-6: the exact scope (`pages_messaging` vs `pages_manage_metadata`)
// and the error code Graph uses when the Page has not accepted the Page Contact
// Terms. Until it is known, the Contact Terms refusal is recognised by its wording.

import { GraphApiError } from '../core/index.js';
import type { ErrorAction, FbRequestFn, Page, PageRequest } from '../core/index.js';
import { fetchPage, malformedRowsNote, type EdgeRequest } from './shared.js';

/** The fields every label read asks for. */
export const LABEL_FIELDS = 'id,page_label_name';

/** The guidance for a call refused because the Page Contact Terms are not accepted. */
export const CONTACT_TERMS_GUIDANCE =
  'Facebook refused the label call because this Page has not accepted the Page Contact ' +
  'Terms. A Page admin must accept them in Meta Business Suite (Inbox settings); nothing ' +
  'changed. Retry after that.';

export interface LabelRecord {
  readonly id: string;
  /** The label name as the Page admin typed it; absent when Graph omitted it. */
  readonly name?: string;
}

interface RawLabel {
  readonly id?: unknown;
  readonly page_label_name?: unknown;
}

interface LabelScope {
  readonly pageId: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A Graph id arrives as a string, occasionally as a number; anything else is absent. */
function labelId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return nonEmptyString(value);
}

function shapeLabel(raw: RawLabel): LabelRecord | undefined {
  const id = labelId(raw.id);
  if (id === undefined) return undefined;
  const name = nonEmptyString(raw.page_label_name);
  return name !== undefined ? { id, name } : { id };
}

function scopeFields(input: LabelScope): {
  pageId: string;
  token?: string;
  signal?: AbortSignal;
} {
  return {
    pageId: input.pageId,
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
}

/**
 * Whether a 2xx body confirms a label write: a bodiless 2xx and a bare `true`
 * confirm, a record confirms unless its `success` flag is anything but `true`,
 * and every other body is Facebook NOT saying yes (the moderation rule).
 */
function confirmsWrite(body: unknown): boolean {
  if (body === undefined || body === true) return true;
  if (!isRecord(body)) return false;
  const flag: unknown = body['success'];
  return flag === undefined || flag === true;
}

/** Whether a Graph failure is the "Page Contact Terms not accepted" refusal (P-6). */
export function isContactTermsError(err: unknown): err is GraphApiError {
  return err instanceof GraphApiError && /contact terms/i.test(err.message);
}

function contactTermsAction(): ErrorAction {
  return {
    category: 'permission',
    retryable: false,
    operatorText: CONTACT_TERMS_GUIDANCE,
  };
}

/** Swap in the Contact Terms guidance; every other failure passes through unchanged. */
function explainLabelFailure(err: unknown): unknown {
  if (!isContactTermsError(err)) return err;
  return new GraphApiError(`Label call refused — Page Contact Terms. ${err.message}`, {
    code: err.code,
    ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
    ...(err.type !== undefined ? { type: err.type } : {}),
    ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
    httpStatus: err.httpStatus,
    action: contactTermsAction(),
    ...(err.userTitle !== undefined ? { userTitle: err.userTitle } : {}),
    ...(err.userMessage !== undefined ? { userMessage: err.userMessage } : {}),
    cause: err,
  });
}

async function explained<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw explainLabelFailure(err);
  }
}

/** Shape one listing page; a row without an id is dropped and counted in the note. */
function shapeLabelPage(page: Page<RawLabel>): Page<LabelRecord> {
  const data: LabelRecord[] = [];
  for (const raw of page.data) {
    const label = isRecord(raw) ? shapeLabel(raw) : undefined;
    if (label !== undefined) data.push(label);
  }
  const dropped = page.data.length - data.length;
  const notes = [
    ...(page.note !== undefined ? [page.note] : []),
    ...(dropped > 0 ? [malformedRowsNote(dropped)] : []),
  ];
  return {
    data,
    truncated: page.truncated,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

export interface ListLabelsInput extends LabelScope {
  /** Only the labels on this person (their PSID); absent ⇒ every Page label. */
  readonly psid?: string;
  readonly page?: PageRequest;
}

/** One page of the Page's labels, or of the labels on one person. */
export async function listLabels(
  fbRequest: FbRequestFn,
  input: ListLabelsInput,
): Promise<Page<LabelRecord>> {
  const edge: EdgeRequest = {
    host: 'graph',
    path: `/${input.psid ?? input.pageId}/custom_labels`,
    params: { fields: LABEL_FIELDS },
    ...scopeFields(input),
  };
  return explained(async () =>
    shapeLabelPage(await fetchPage<RawLabel>(fbRequest, edge, input.page ?? {})),
  );
}

/** Read one label, for the name a preview shows. Undefined when the body has no id. */
export async function getLabel(
  fbRequest: FbRequestFn,
  input: { readonly labelId: string } & LabelScope,
): Promise<LabelRecord | undefined> {
  return explained(async () => {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      path: `/${input.labelId}`,
      params: { fields: LABEL_FIELDS },
      ...scopeFields(input),
    });
    return isRecord(res.data) ? shapeLabel(res.data) : undefined;
  });
}

/** Create a Page label. The id is absent when Facebook acknowledged without one. */
export async function createLabel(
  fbRequest: FbRequestFn,
  input: { readonly name: string } & LabelScope,
): Promise<{ readonly labelId?: string }> {
  return explained(async () => {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'POST',
      host: 'graph',
      path: `/${input.pageId}/custom_labels`,
      body: { page_label_name: input.name },
      ...scopeFields(input),
    });
    const id = isRecord(res.data) ? labelId(res.data['id']) : undefined;
    return id !== undefined ? { labelId: id } : {};
  });
}

/**
 * Put a label on one person, or take it off (`assigned:false`). Returns whether
 * the acknowledgement confirms the write.
 */
export async function setLabelAssigned(
  fbRequest: FbRequestFn,
  input: {
    readonly labelId: string;
    readonly psid: string;
    readonly assigned: boolean;
  } & LabelScope,
): Promise<boolean> {
  return explained(async () => {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: input.assigned ? 'POST' : 'DELETE',
      host: 'graph',
      path: `/${input.labelId}/label`,
      ...(input.assigned
        ? { body: { user: input.psid } }
        : { params: { user: input.psid } }),
      ...scopeFields(input),
    });
    return confirmsWrite(res.data);
  });
}

/** Delete a label; it leaves every person it was on. Returns whether it is confirmed. */
export async function deleteLabel(
  fbRequest: FbRequestFn,
  input: { readonly labelId: string } & LabelScope,
): Promise<boolean> {
  return explained(async () => {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'DELETE',
      host: 'graph',
      path: `/${input.labelId}`,
      ...scopeFields(input),
    });
    return confirmsWrite(res.data);
  });
}

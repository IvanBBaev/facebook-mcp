// The frozen annotation manifest, assembled from one fragment per tool package,
// plus the rule that derives `destructiveHint` from a tool's write tier (AUX-04).
//
// Each `<pkg>.ts` file in this directory holds the rows of exactly one package
// and is owned by that package's lane, so lanes working in parallel never edit
// the same list. This loader only concatenates the fragments, in canonical
// package order; `../annotations.test.ts` asserts the result against the live
// registry and `./index.test.ts` asserts every row against the derivation rule.
// No production module imports this directory.

import type { WriteTier } from '../../core/index.js';
import { ANNOTATIONS_ADS } from './ads.js';
import { ANNOTATIONS_CORE } from './core.js';
import { ANNOTATIONS_INSIGHTS } from './insights.js';
import { ANNOTATIONS_MESSAGES } from './messages.js';
import { ANNOTATIONS_MODERATION } from './moderation.js';
import { ANNOTATIONS_PAGE_ADMIN } from './page-admin.js';
import { ANNOTATIONS_POSTS } from './posts.js';
import { ANNOTATIONS_READER } from './reader.js';
import type { AnnotationRow } from './row.js';

export type { AnnotationRow } from './row.js';

/**
 * Every registered tool's annotation row, grouped by package in canonical
 * order for reading only — the assertions compare by name, not by position.
 */
export const ANNOTATION_MANIFEST: readonly AnnotationRow[] = [
  ...ANNOTATIONS_CORE,
  ...ANNOTATIONS_READER,
  ...ANNOTATIONS_POSTS,
  ...ANNOTATIONS_INSIGHTS,
  ...ANNOTATIONS_MODERATION,
  ...ANNOTATIONS_MESSAGES,
  ...ANNOTATIONS_ADS,
  ...ANNOTATIONS_PAGE_ADMIN,
];

// ---------------------------------------------------------------------------
// destructiveHint derivation (AUX-04)
// ---------------------------------------------------------------------------

/**
 * The rule: a write is destructive when its tier is `irreversible` or `spend`,
 * or when it overwrites or removes state that already exists. A read-only tool
 * (no tier) is never destructive.
 *
 * Clients gate confirmation prompts on `destructiveHint`, so the hint must not
 * advertise a money-spending or unrecoverable write as safe to auto-approve.
 */
export function deriveDestructiveHint(
  tier: WriteTier | undefined,
  overwritesExistingState: boolean,
): boolean {
  if (tier === undefined) return false;
  return tier === 'irreversible' || tier === 'spend' || overwritesExistingState;
}

/**
 * Write tools that replace or remove existing state in place (an edit, a
 * settings write, a local delete), whatever their tier. Adding a name here is a
 * claim about the tool's effect, reviewed like an annotation row.
 */
export const OVERWRITES_EXISTING_STATE: ReadonlySet<string> = new Set([
  'facebook_update_post',
  'facebook_edit_comment',
  'facebook_set_moderation_settings',
  'facebook_save_reply', // `overwrite: true` replaces a saved reply with the same id
  'facebook_delete_saved_reply',
  'facebook_update_ad_object',
  'facebook_update_ad_set_targeting',
  'facebook_update_page_profile',
]);

/** A permanent exception to the rule; allowed only with a recorded reason. */
export interface DestructiveOverride {
  readonly destructiveHint: boolean;
  readonly reason: string;
}

export const DESTRUCTIVE_OVERRIDES: Readonly<Record<string, DestructiveOverride>> = {
  facebook_duplicate_ad_object: {
    destructiveHint: false,
    reason:
      'Only adds a new PAUSED copy and overwrites nothing; the irreversible tier is about minting ' +
      'objects on the account (CC-ADS-6), not about destroying state.',
  },
};

/** A row that breaks the rule today and is scheduled to be fixed by its lane. */
export interface PendingDestructiveFix {
  /** The doc 05 task that owns the fragment row and fixes it. */
  readonly owner: string;
  readonly finding: string;
}

/**
 * Rows that still contradict the rule. The fragments are owned by the wave 2
 * lanes, and changing a hint changes `tools/list`, so the fix lands with the
 * lane, not here. The list is a ratchet: `./index.test.ts` fails once a row is
 * fixed and its entry is still here, and nothing may be added to it.
 */
export const PENDING_DESTRUCTIVE_FIXES: Readonly<Record<string, PendingDestructiveFix>> =
  {
    facebook_boost_post: { owner: 'L2.ads', finding: 'AUX-04' },
    facebook_create_story: { owner: 'L2.posts', finding: 'AUX-04, OD-7' },
    facebook_edit_comment: { owner: 'L2.moderation', finding: 'AUX-04 (derivation)' },
    facebook_set_moderation_settings: { owner: 'L2.moderation', finding: 'AUX-04' },
    facebook_send_message: {
      owner: 'L2.messages',
      finding: 'AUX-04, doc 05 L2.messages',
    },
    facebook_save_reply: { owner: 'L2.messages', finding: 'AUX-04 (derivation)' },
    facebook_delete_saved_reply: { owner: 'L2.messages', finding: 'AUX-04' },
    facebook_update_page_profile: { owner: 'L2.page-admin', finding: 'AUX-04' },
  };

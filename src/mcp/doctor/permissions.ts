// Permission tables and the permission x package matrix (shared, not a lane).

import { type PackageName, type PackageSpec } from '../../core/index.js';
import { type PackageMatrixRow, type PackageUsability } from './types.js';

// ---------------------------------------------------------------------------
// Static permission tables (the corpus's permission -> capability map, doc 04/06)
// ---------------------------------------------------------------------------

/**
 * The Meta permissions each PACKAGE requires (union across its tools) — the
 * headline scope list the doctor cross-references. A package absent from this
 * table renders as `unknown`. `business_management` is deliberately NOT here:
 * it is a setup-only permission that should not ride on a runtime token (doc
 * 04), so a granted `business_management` surfaces as over-scope instead.
 */
export const PACKAGE_PERMISSIONS: Partial<Record<PackageName, readonly string[]>> = {
  core: ['pages_show_list', 'pages_read_engagement'],
  reader: ['pages_read_engagement', 'pages_read_user_content', 'pages_show_list'],
  posts: ['pages_manage_posts', 'pages_read_engagement'],
  // pages_read_engagement is facebook_get_page_report's published_posts scan.
  insights: ['read_insights', 'pages_read_engagement'],
  // pages_read_engagement is facebook_list_comments' own requirement and
  // pages_messaging facebook_private_reply's; without them a row blocked only by
  // one of those read "missing: (none)" and named nothing to grant.
  moderation: [
    'pages_read_engagement',
    'pages_read_user_content',
    'pages_manage_engagement',
    'pages_messaging',
    // facebook_{get,set}_moderation_settings (`/{page-id}/settings`).
    'pages_manage_metadata',
  ],
  // pages_read_engagement + pages_read_user_content are
  // facebook_get_activity_since's comment scan.
  messages: [
    'pages_messaging',
    'pages_manage_metadata',
    'pages_read_engagement',
    'pages_read_user_content',
  ],
  // pages_read_engagement is facebook_boost_post's read of the post it promotes.
  ads: ['ads_read', 'ads_management', 'pages_read_engagement'],
  page_admin: ['pages_manage_metadata', 'pages_read_engagement'],
};

/**
 * Finer per-TOOL permission requirements, keyed by tool name, refining the
 * package-level table so the matrix can report exactly which tools are blocked
 * (doc 06 "reports exactly which tools will and won't work"). A tool absent
 * from this table inherits its package's full required set. Entries beyond the
 * `core` tools are inferred from the doc 04/06 capability map for the Wave-4
 * verticals so the matrix is meaningful the moment those packages are injected.
 */
export const TOOL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  // core (this task)
  facebook_whoami: [],
  facebook_list_pages: ['pages_show_list'],
  facebook_get_page: ['pages_read_engagement'],
  facebook_usage: [],

  // reader (V01)
  facebook_list_posts: ['pages_read_engagement'],
  facebook_get_post: ['pages_read_engagement'],
  facebook_list_reels: ['pages_read_engagement'],
  facebook_get_reactions: ['pages_read_engagement'],
  facebook_list_stories: ['pages_read_engagement', 'pages_show_list'],
  facebook_list_albums: ['pages_read_engagement'],
  facebook_list_photos: ['pages_read_engagement', 'pages_show_list'],

  // posts (V03/V04)
  facebook_create_post: ['pages_manage_posts'],
  facebook_create_photo_post: ['pages_manage_posts'],
  facebook_create_video_post: ['pages_manage_posts'],
  facebook_create_reel: ['pages_manage_posts'],
  facebook_create_story: ['pages_manage_posts'],
  facebook_update_post: ['pages_manage_posts'],
  facebook_delete_post: ['pages_manage_posts'],
  facebook_list_scheduled_posts: ['pages_read_engagement'],
  // A read of the Page's own video (`/{video-id}?fields=status`, doc 04 "read own
  // posts"): unmapped, it inherited pages_manage_posts and read as blocked.
  facebook_get_video_status: ['pages_read_engagement'],

  // insights (V02)
  facebook_page_insights: ['read_insights'],
  facebook_post_insights: ['read_insights'],
  facebook_reel_insights: ['read_insights'],
  // v2 F2: Page insights plus the published_posts scan for the top posts.
  facebook_get_page_report: ['read_insights', 'pages_read_engagement'],
  // v2 F4: post insights, plus the published_posts read behind `latest`.
  facebook_get_posts_insights: ['read_insights', 'pages_read_engagement'],

  // moderation (V05/V06) — the delete/private-reply split (doc 04, CC-AUTH-4)
  // The tool's description: pages_read_engagement, plus pages_read_user_content
  // for visitor content.
  facebook_list_comments: ['pages_read_engagement', 'pages_read_user_content'],
  // Same read as the listing: pages_read_engagement, plus pages_read_user_content
  // for a visitor's comment (the tool's description).
  facebook_get_comment: ['pages_read_engagement', 'pages_read_user_content'],
  facebook_triage_comments: ['pages_read_engagement', 'pages_read_user_content'],
  facebook_reply_to_comment: ['pages_manage_engagement'],
  facebook_comment_on_post: ['pages_manage_engagement'],
  facebook_edit_comment: ['pages_manage_engagement'],
  facebook_hide_comment: ['pages_manage_engagement'],
  facebook_reply_and_hide_comment: ['pages_manage_engagement', 'pages_read_engagement'],
  facebook_like_comment: ['pages_manage_engagement'],
  facebook_delete_comment: ['pages_manage_engagement', 'pages_read_user_content'],
  // Meta's Private Replies doc: sending needs pages_messaging (+ MESSAGING task),
  // not pages_manage_engagement; the pre-flight comment GET that checks the
  // 7-day window needs the facebook_get_comment set.
  facebook_private_reply: [
    'pages_messaging',
    'pages_read_engagement',
    'pages_read_user_content',
  ],
  // `/{page-id}/blocked` needs only pages_manage_engagement (the tools' own
  // descriptions say so); unmapped, they inherited pages_read_user_content too.
  facebook_block_user: ['pages_manage_engagement'],
  facebook_unblock_user: ['pages_manage_engagement'],
  // `/{page-id}/settings` (V16). The write scope on a New Page Experience Page is
  // still probe P-7; pages_manage_metadata is the documented one.
  facebook_get_moderation_settings: ['pages_manage_metadata'],
  facebook_set_moderation_settings: ['pages_manage_metadata'],

  // messages (V07)
  facebook_list_conversations: ['pages_messaging', 'pages_manage_metadata'],
  facebook_get_conversation: ['pages_messaging', 'pages_manage_metadata'],
  facebook_send_message: ['pages_messaging'],
  // v2 F2: the same POST edge and thread probe as a send.
  facebook_react_to_message: ['pages_messaging'],
  facebook_upload_message_attachment: ['pages_messaging'],
  // Comments on the recent posts plus the Messenger inbox.
  facebook_get_activity_since: [
    'pages_read_engagement',
    'pages_read_user_content',
    'pages_messaging',
  ],
  // v2 F11 custom labels: pages_manage_metadata per Meta's docs (scope still probe P-6).
  facebook_list_labels: ['pages_manage_metadata'],
  facebook_create_label: ['pages_manage_metadata'],
  facebook_assign_label: ['pages_manage_metadata'],
  facebook_delete_label: ['pages_manage_metadata'],
  // Local saved replies: a file on this machine, no Graph call.
  facebook_list_saved_replies: [],
  facebook_save_reply: [],
  facebook_delete_saved_reply: [],

  // ads (V08/V09/V10)
  facebook_list_campaigns: ['ads_read'],
  facebook_list_adsets: ['ads_read'],
  facebook_list_ads: ['ads_read'],
  facebook_get_ad_object: ['ads_read'],
  facebook_get_ad_preview: ['ads_read'],
  facebook_ads_insights: ['ads_read'],
  facebook_ads_report_status: ['ads_read'],
  facebook_update_ad_object: ['ads_management'],
  facebook_archive_ad_object: ['ads_management'],
  facebook_delete_ad_object: ['ads_management'],
  facebook_upload_ad_image: ['ads_management'],
  facebook_get_ad_set_targeting: ['ads_read'],
  facebook_update_ad_set_targeting: ['ads_management'],
  facebook_duplicate_ad_object: ['ads_management'],
  facebook_boost_post: ['ads_management', 'pages_read_engagement'],

  // page_admin (organic F8): the profile POST, plus its snapshot read.
  facebook_update_page_profile: ['pages_manage_metadata', 'pages_read_engagement'],
};

/**
 * Cross-reference every loaded package against the granted scopes.
 *
 * `scopesObserved` is false when the token check never got an answer. The
 * granted set is then the empty default, not a fact from the wire, and a row
 * judged against it would name every permission as missing — so each mapped
 * package is reported `unverified` with nothing missing and nothing blocked.
 */
export function buildMatrix(
  packages: readonly PackageSpec[],
  granted: ReadonlySet<string>,
  scopesObserved: boolean,
): PackageMatrixRow[] {
  return packages.map((pkg) => {
    const required = PACKAGE_PERMISSIONS[pkg.name as PackageName];
    if (required === undefined) {
      return {
        package: pkg.name,
        status: 'unknown',
        requiredPermissions: [],
        missingPermissions: [],
        blockedTools: [],
      };
    }
    if (!scopesObserved) {
      return {
        package: pkg.name,
        status: 'unverified',
        requiredPermissions: required,
        missingPermissions: [],
        blockedTools: [],
      };
    }
    const missingPermissions = required.filter((perm) => !granted.has(perm));
    const blockedTools = pkg.tools
      .filter((tool) => {
        const toolReq = TOOL_PERMISSIONS[tool.name] ?? required;
        return toolReq.some((perm) => !granted.has(perm));
      })
      .map((tool) => tool.name);

    const total = pkg.tools.length;
    const blocked = blockedTools.length;
    let status: PackageUsability;
    if (total === 0) {
      status = missingPermissions.length === 0 ? 'usable' : 'blocked';
    } else if (blocked === 0) {
      status = 'usable';
    } else if (blocked === total) {
      status = 'blocked';
    } else {
      status = 'partial';
    }
    return {
      package: pkg.name,
      status,
      requiredPermissions: required,
      missingPermissions,
      blockedTools,
    };
  });
}

export function computeOverScope(
  packages: readonly PackageSpec[],
  granted: ReadonlySet<string>,
): string[] {
  const needed = new Set<string>();
  for (const pkg of packages) {
    for (const perm of PACKAGE_PERMISSIONS[pkg.name as PackageName] ?? []) {
      needed.add(perm);
    }
    for (const tool of pkg.tools) {
      for (const perm of TOOL_PERMISSIONS[tool.name] ?? []) {
        needed.add(perm);
      }
    }
  }
  return [...granted].filter((scope) => !needed.has(scope)).sort();
}

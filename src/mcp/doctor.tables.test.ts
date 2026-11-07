// Tests for the doctor (`mcp/doctor.ts`): tool mapping, data-access expiry and the
// permission tables.
//
// Split out of `doctor.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/doctor.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr } from '../core/fakes/index.js';
import { GraphApiError, classifyNetworkError } from '../core/index.js';
import type { PackageSpec } from '../core/index.js';
import {
  PACKAGE_PERMISSIONS,
  TOOL_PERMISSIONS,
  renderDoctorReport,
  runDoctor,
} from './doctor.js';
import {
  CORE_TOOLS,
  makeDeps,
  pkg,
  row,
  withDebugToken,
} from '../testing/harness/doctor.js';

// ---------------------------------------------------------------------------
// Wave 14: every shipped tool is mapped, and data-access expiry is judged
// ---------------------------------------------------------------------------

/**
 * The concrete tool surface, loaded through a computed specifier for the same
 * reason `annotations.test.ts` does: `src/mcp` may not statically import the
 * tools layer, but this guard needs the real tool names.
 */
const TOOLS_BARREL = new URL('../tools/index.js', import.meta.url).href;

async function loadShippedPackages(): Promise<readonly PackageSpec[]> {
  const barrel = (await import(TOOLS_BARREL)) as Record<string, unknown>;
  const specs: PackageSpec[] = [];
  for (const [name, value] of Object.entries(barrel)) {
    if (!/^create[A-Za-z0-9]*Package$/.test(name) || typeof value !== 'function')
      continue;
    const factory = value as (opts: {
      serverVersion: string;
      sdkVersion?: string;
    }) => PackageSpec;
    specs.push(factory({ serverVersion: '0.0.0-test', sdkVersion: '0.0.0-test' }));
  }
  assert.ok(specs.length > 0, 'no package factories found in src/tools/index.ts');
  return specs;
}

test('TOOL_PERMISSIONS maps every shipped tool, so none inherits its whole package set (wave 14)', async () => {
  const unmapped = (await loadShippedPackages())
    .flatMap((spec) => spec.tools.map((tool) => tool.name))
    .filter((name) => !Object.hasOwn(TOOL_PERMISSIONS, name))
    .sort();
  assert.deepEqual(unmapped, []);
});

test('block/unblock need only pages_manage_engagement and are not reported blocked without pages_read_user_content (wave 14)', async () => {
  const { fb, deps } = makeDeps({
    packages: [
      pkg('moderation', [
        'facebook_hide_comment',
        'facebook_block_user',
        'facebook_unblock_user',
        'facebook_list_comments',
      ]),
    ],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_manage_engagement'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  // Only the read that genuinely needs pages_read_user_content is blocked.
  assert.deepEqual([...moderation.blockedTools], ['facebook_list_comments']);
});

test('facebook_get_video_status is a read and is not blocked by a missing pages_manage_posts (wave 14)', async () => {
  const { fb, deps } = makeDeps({
    packages: [
      pkg('posts', [
        'facebook_create_post',
        'facebook_list_scheduled_posts',
        'facebook_get_video_status',
      ]),
    ],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_read_engagement'],
  });

  const posts = row((await runDoctor(deps)).matrix, 'posts');
  assert.equal(posts.status, 'partial');
  assert.deepEqual([...posts.blockedTools], ['facebook_create_post']);
});

test('a never-expiring token whose DATA ACCESS lapses within the window warns (wave 14)', async () => {
  const now = 1_000_000_000_000;
  const { fb, deps } = makeDeps({ nowMs: now });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0, // the token itself never expires...
    data_access_expires_at: now / 1000 + 2 * 86_400, // ...but data access ends in 2 days
  });

  const report = await runDoctor(deps);
  assert.equal(report.token.neverExpiring, true);
  assert.equal(report.summary.verdict, 'warn');
  assert.equal(report.token.dataAccessExpiringSoon, true);
  assert.ok(
    report.summary.findings.some(
      (f) => f.severity === 'warn' && /data access/i.test(f.detail),
    ),
    'expected a data-access expiry finding',
  );
  assert.match(renderDoctorReport(report), /data access: {2}\S+ \(EXPIRING SOON/);
});

test('a data access that has already lapsed warns; one far away does not (wave 14)', async () => {
  const now = 1_000_000_000_000;
  const lapsed = makeDeps({ nowMs: now });
  withDebugToken(lapsed.fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: now / 1000 + 50 * 86_400,
    data_access_expires_at: now / 1000 - 86_400,
  });
  const lapsedReport = await runDoctor(lapsed.deps);
  assert.equal(lapsedReport.summary.verdict, 'warn');
  assert.equal(lapsedReport.token.dataAccessExpiringSoon, true);

  const far = makeDeps({ nowMs: now });
  withDebugToken(far.fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: now / 1000 + 50 * 86_400,
    data_access_expires_at: now / 1000 + 60 * 86_400,
  });
  const farReport = await runDoctor(far.deps);
  assert.equal(farReport.token.dataAccessExpiringSoon, false);
  assert.equal(farReport.summary.verdict, 'ok');
});

// ---------------------------------------------------------------------------
// Wave 15: permission tables agree with the tools, and an unchecked token is
// not rendered as a checked one
// ---------------------------------------------------------------------------

test('facebook_list_comments is blocked without pages_read_engagement, as its description says (wave 15)', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('moderation', ['facebook_list_comments', 'facebook_hide_comment'])],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_read_user_content', 'pages_manage_engagement'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  assert.deepEqual([...moderation.blockedTools], ['facebook_list_comments']);
  assert.ok(moderation.missingPermissions.includes('pages_read_engagement'));
});

test('a moderation row blocked only by pages_messaging names that permission as missing (wave 15)', async () => {
  const { fb, deps } = makeDeps({
    packages: [
      pkg('moderation', [
        'facebook_list_comments',
        'facebook_hide_comment',
        'facebook_private_reply',
      ]),
    ],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: [
      'pages_read_engagement',
      'pages_read_user_content',
      'pages_manage_engagement',
      'pages_manage_metadata',
    ],
  });

  const report = await runDoctor(deps);
  const moderation = row(report.matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  assert.deepEqual([...moderation.blockedTools], ['facebook_private_reply']);
  // The row used to read "missing: (none); blocked tools: facebook_private_reply",
  // leaving the operator no permission to go and grant.
  assert.deepEqual([...moderation.missingPermissions], ['pages_messaging']);
  assert.match(
    renderDoctorReport(report),
    /\[PARTIAL\] moderation\s+missing: pages_messaging; blocked tools: facebook_private_reply/,
  );
});

test("PACKAGE_PERMISSIONS is the union of its shipped tools' TOOL_PERMISSIONS (wave 15)", async () => {
  const gaps: string[] = [];
  for (const spec of await loadShippedPackages()) {
    const required = new Set(
      PACKAGE_PERMISSIONS[spec.name as keyof typeof PACKAGE_PERMISSIONS] ?? [],
    );
    for (const tool of spec.tools) {
      for (const perm of TOOL_PERMISSIONS[tool.name] ?? []) {
        if (!required.has(perm)) gaps.push(`${spec.name}: ${tool.name} needs ${perm}`);
      }
    }
  }
  assert.deepEqual(gaps.sort(), []);
});

test('TOOL_PERMISSIONS carries no stale entry for a tool that is not shipped (wave 15)', async () => {
  const shipped = new Set(
    (await loadShippedPackages()).flatMap((spec) => spec.tools.map((tool) => tool.name)),
  );
  const stale = Object.keys(TOOL_PERMISSIONS)
    .filter((name) => !shipped.has(name))
    .sort();
  assert.deepEqual(stale, []);
});

test('an expiring token that is also missing a permission reports both findings (wave 15)', async () => {
  const now = 1_000_000_000_000;
  const { fb, deps } = makeDeps({
    nowMs: now,
    packages: [pkg('core', CORE_TOOLS), pkg('posts', ['facebook_create_post'])],
  });
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: now / 1000 + 86_400,
  });

  const report = await runDoctor(deps);
  assert.equal(report.summary.verdict, 'warn');
  const details = report.summary.findings.map((f) => `${f.area}: ${f.detail}`);
  assert.ok(details.some((d) => /^token: The token expires within 7 days/.test(d)));
  assert.ok(details.some((d) => /^packages: posts: .*pages_manage_posts/.test(d)));
});

test('an unchecked token is rendered as unknown, not as invalid with no scopes (wave 15)', async () => {
  const { fb, deps } = makeDeps();
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError(
        'network request failed: getaddrinfo ENOTFOUND graph.facebook.com',
        {
          code: 0,
          httpStatus: 0,
          action: classifyNetworkError({ phase: 'connect', isWrite: false }),
        },
      ),
    ),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_check_failed');
  const text = renderDoctorReport(report);
  // debug_token never answered: "valid: no" / "scopes: (none)" / "not reported
  // by Graph" each state something Graph was never asked.
  assert.doesNotMatch(text, /^ {2}valid: +no$/m);
  assert.doesNotMatch(text, /^ {2}scopes: +\(none\)$/m);
  assert.doesNotMatch(text, /asset access: +not reported by Graph/);
  assert.match(text, /^ {2}valid: +unknown \(not checked\)$/m);
  assert.match(text, /^ {2}scopes: +unknown \(not checked\)$/m);
  assert.match(text, /^ {2}granular: +unknown \(not checked\)$/m);
  assert.match(text, /^ {2}asset access: +unknown \(not checked\)$/m);
});

// ---------------------------------------------------------------------------
// Wave 17: the moderation rows match the tools' own stated requirements
// ---------------------------------------------------------------------------

test('facebook_private_reply is usable with the documented set and no pages_manage_engagement (wave 17)', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('moderation', ['facebook_get_comment', 'facebook_private_reply'])],
  });
  // Exactly what the tool description names: pages_messaging to send, and
  // pages_read_engagement + pages_read_user_content for the pre-flight read.
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_messaging', 'pages_read_engagement', 'pages_read_user_content'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.deepEqual([...moderation.blockedTools], []);
  assert.equal(moderation.status, 'usable');
});

test('facebook_private_reply is blocked without pages_read_engagement for its pre-flight comment read (wave 17)', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('moderation', ['facebook_hide_comment', 'facebook_private_reply'])],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_messaging', 'pages_manage_engagement', 'pages_read_user_content'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  assert.deepEqual([...moderation.blockedTools], ['facebook_private_reply']);
});

test('facebook_get_comment is blocked without pages_read_engagement, as its description says (wave 17)', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('moderation', ['facebook_get_comment', 'facebook_hide_comment'])],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_read_user_content', 'pages_manage_engagement'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  assert.deepEqual([...moderation.blockedTools], ['facebook_get_comment']);
  assert.ok(moderation.missingPermissions.includes('pages_read_engagement'));
});

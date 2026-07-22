// Contract-shape tests: prove the one concrete contract (GraphApiError) behaves,
// the contract constants are correct, and a ToolSpec can be authored against the
// frozen shapes (compiles + runs end-to-end through a handler).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  GraphApiError,
  PACKAGE_NAMES,
  USAGE_HEADERS,
  type ErrorAction,
  type PackageSpec,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
} from './index.js';

test('GraphApiError carries the envelope fields and is a real Error subclass', () => {
  const action: ErrorAction = {
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText: 'Token expired — refresh FB_ACCESS_TOKEN and run facebook_whoami.',
  };
  const err = new GraphApiError('Invalid OAuth access token.', {
    code: 190,
    subcode: 460,
    type: 'OAuthException',
    fbtraceId: 'Abc123',
    httpStatus: 400,
    action,
  });

  assert.ok(err instanceof GraphApiError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'GraphApiError');
  assert.equal(err.message, 'Invalid OAuth access token.');
  assert.equal(err.code, 190);
  assert.equal(err.subcode, 460);
  assert.equal(err.type, 'OAuthException');
  assert.equal(err.fbtraceId, 'Abc123');
  assert.equal(err.httpStatus, 400);
  assert.equal(err.action?.category, 'auth');
  assert.equal(err.action?.retryable, false);
});

test('GraphApiError supports an error cause and minimal construction', () => {
  const root = new Error('socket hang up');
  const err = new GraphApiError('Network failure', {
    code: -1,
    httpStatus: 0,
    cause: root,
  });
  assert.equal(err.cause, root);
  assert.equal(err.subcode, undefined);
  assert.equal(err.action, undefined);
});

test('PACKAGE_NAMES lists the seven canonical packages', () => {
  assert.deepEqual(
    [...PACKAGE_NAMES],
    ['core', 'reader', 'posts', 'insights', 'moderation', 'messages', 'ads'],
  );
});

test('USAGE_HEADERS are the lowercased Graph usage header names', () => {
  assert.equal(USAGE_HEADERS.appUsage, 'x-app-usage');
  assert.equal(USAGE_HEADERS.businessUseCaseUsage, 'x-business-use-case-usage');
  assert.equal(USAGE_HEADERS.adsInsightsThrottle, 'x-fb-ads-insights-throttle');
});

test('a ToolSpec + PackageSpec can be authored against the frozen shapes', async () => {
  const spec: ToolSpec = {
    name: 'facebook_get_page',
    description: 'Read Page metadata.',
    package: 'core',
    inputSchema: z
      .object({ profile: z.string().optional().describe('Profile key or Page ID.') })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: (input: unknown, ctx: ToolContext): Promise<ToolResult> =>
      Promise.resolve({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { echo: input, hasCtx: ctx !== undefined },
      }),
  };

  const pkg: PackageSpec = {
    name: 'core',
    tools: [spec],
    enabledByDefault: true,
  };

  assert.equal(pkg.tools.length, 1);
  assert.equal(spec.annotations.readOnlyHint, true);
  assert.equal(spec.writeTier, undefined);

  // The handler is callable and returns a well-formed ToolResult.
  const ctx = { settings: {} } as unknown as ToolContext;
  const result = await spec.handler({}, ctx);
  assert.equal(result.content[0]?.text, 'ok');
  assert.equal(result.isError, undefined);
});

// The MCP client the smokes talk through.
//
// The whole point of a live smoke is that it exercises the SHIPPED server the
// way a real MCP host does: a spawned `node build/index.js` speaking JSON-RPC
// over stdio, driven by the official `@modelcontextprotocol/sdk` client — the
// same client `src/index.test.ts` uses, just over a real stdio transport
// instead of the in-memory pair. Nothing about the protocol is reimplemented
// here; this module only adds the three things a smoke needs on top:
//
//   1. payload parsing — tools return a JSON document in a text content block,
//      so `callTool` hands the smoke a parsed object, and a tool error becomes
//      a thrown `SmokeToolError` carrying the server's own error `code`;
//   2. the write-safety envelope — `applyWrite` refuses to send a mutating call
//      anywhere except the configured test Page, and refuses to create an
//      artifact that does not carry this run's marker;
//   3. child stderr capture — the server logs JSON to stderr; the harness keeps
//      the tail and prints it (scrubbed) only when something fails.

import { realpathSync, statSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { clip, scrub } from './log.mjs';
import { findMarkerNonce } from './nonce.mjs';

/** The server returned `isError: true` for a tool call. */
export class SmokeToolError extends Error {
  name = 'SmokeToolError';

  constructor(tool, payload) {
    const code = typeof payload?.code === 'string' ? payload.code : 'unknown';
    super(`${tool} failed [${code}]: ${payload?.error ?? JSON.stringify(payload)}`);
    this.tool = tool;
    this.code = code;
    this.payload = payload;
  }
}

/** A write was about to go somewhere it must never go. Always fatal. */
export class SmokeSafetyError extends Error {
  name = 'SmokeSafetyError';
}

/** The server build is missing or unusable. */
export class SmokeSetupError extends Error {
  name = 'SmokeSetupError';
}

const STDERR_TAIL_BYTES = 8000;

/**
 * Unwrap the canonical taint envelope (`{__tainted, source, content, warning}`)
 * that visitor-authorable payloads travel in (B1 / CC-MOD-8). A smoke asserting
 * on the DATA calls this; a smoke asserting that the envelope EXISTS must not.
 */
export function unwrapTainted(value) {
  return value !== null && typeof value === 'object' && value.__tainted === true
    ? value.content
    : value;
}

/** Pull the first JSON document out of a `CallToolResult`'s content blocks. */
function parsePayload(tool, result) {
  if (result?.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  const block = (result?.content ?? []).find((item) => item?.type === 'text');
  if (block === undefined) {
    throw new SmokeToolError(tool, { error: 'tool returned no text content block' });
  }
  try {
    return JSON.parse(block.text);
  } catch {
    throw new SmokeToolError(tool, {
      error: `tool returned non-JSON text: ${clip(block.text, 300)}`,
    });
  }
}

/**
 * Spawn the built server and connect an SDK client to it.
 *
 * @param {object} opts
 * @param {string} opts.serverPath  absolute path to `build/index.js`
 * @param {Record<string,string>} opts.env  the child environment (see env.mjs)
 * @param {string} opts.cwd  repository root
 * @param {number} opts.timeoutMs  per-request timeout handed to the SDK
 * @param {string} opts.nonce  this run's nonce (marker enforcement)
 * @param {{profile: string, pageId: string|undefined}} opts.writeTarget
 * @param {ReturnType<import('./log.mjs').createLogger>} opts.log
 */
export async function startSmokeClient(opts) {
  const { serverPath, env, cwd, timeoutMs, nonce, writeTarget, log } = opts;

  // The out-of-band operator approval for `irreversible` applies. The harness
  // never MINTS one — it only forwards a value a human deliberately configured,
  // so the gate keeps its human-in-the-loop property. Absent, irreversible
  // applies are denied by the server and the sweeper reports leaks (see the
  // "Confirmation" section of scripts/smoke/README.md).
  const confirmToken =
    typeof env.FB_CONFIRM_TOKEN === 'string' && env.FB_CONFIRM_TOKEN !== ''
      ? env.FB_CONFIRM_TOKEN
      : undefined;

  let resolved;
  try {
    resolved = realpathSync(serverPath);
    if (!statSync(resolved).isFile()) {
      throw new Error('not a file');
    }
  } catch {
    throw new SmokeSetupError(
      `server entry point not found: ${serverPath} — build it first with \`npm run build\``,
    );
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolved],
    env,
    cwd,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'facebook-mcp-smoke', version: '0.0.0' });

  let stderrBuffer = '';
  const stderrTail = () => scrub(stderrBuffer).trimEnd();

  await client.connect(transport);

  if (transport.stderr !== null && transport.stderr !== undefined) {
    transport.stderr.setEncoding('utf8');
    transport.stderr.on('data', (chunk) => {
      stderrBuffer = (stderrBuffer + chunk).slice(-STDERR_TAIL_BYTES);
      log.debug(`server: ${String(chunk).trimEnd()}`);
    });
  }

  const callToolRaw = async (tool, args = {}) => {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: timeoutMs,
    });
    return {
      result,
      payload: parsePayload(tool, result),
      isError: result.isError === true,
    };
  };

  const callTool = async (tool, args = {}) => {
    const { payload, isError } = await callToolRaw(tool, args);
    if (isError) {
      throw new SmokeToolError(tool, payload);
    }
    return payload;
  };

  /**
   * Perform a write: dry run, verify, then apply with the plan id.
   *
   * Safety, in order, all of it BEFORE the first call leaves the process:
   *  - the call is forced onto the test profile; a smoke that passes a
   *    different `profile` is a bug and fails hard (never silently rewritten);
   *  - `marker: 'require'` (the default) demands that this run's marker appear
   *    somewhere in the arguments, so anything created is sweepable;
   *  - the returned preview must report `pageId === <the test Page>`. If the
   *    preview carries no page, or a different one, the apply never happens.
   *    There is no fallback path.
   *
   * An `irreversible` apply also forwards the operator's `FB_CONFIRM_TOKEN`, if
   * one is configured; `spend` never does. See the branch below.
   *
   * @returns {{preview: object, applied: object}}
   */
  const applyWrite = async (tool, args = {}, { marker = 'require' } = {}) => {
    if (writeTarget.pageId === undefined) {
      throw new SmokeSafetyError(
        `${tool}: no test Page is configured, so no write may be attempted`,
      );
    }
    if (args.profile !== undefined && args.profile !== writeTarget.profile) {
      throw new SmokeSafetyError(
        `${tool}: writes are only allowed on profile "${writeTarget.profile}", got "${args.profile}"`,
      );
    }
    if (args.apply !== undefined || args.plan_id !== undefined) {
      throw new SmokeSafetyError(
        `${tool}: do not pass apply/plan_id yourself — applyWrite owns the plan→apply handshake`,
      );
    }
    const planArgs = { ...args, profile: writeTarget.profile };
    if (marker === 'require' && findMarkerNonce(planArgs) !== nonce) {
      throw new SmokeSafetyError(
        `${tool}: refusing to create an unmarked artifact — put ctx.mark(...) in a visible field, ` +
          "or pass { marker: 'none' } when the call only references an existing object",
      );
    }

    const preview = await callTool(tool, planArgs);
    if (preview.status !== 'preview' || preview.applied !== false) {
      throw new SmokeSafetyError(
        `${tool}: expected a dry-run preview, got ${JSON.stringify(preview.status)}`,
      );
    }
    if (preview.pageId !== writeTarget.pageId) {
      throw new SmokeSafetyError(
        `${tool}: preview targets Page ${String(preview.pageId)}, but the only Page this harness ` +
          `may write to is ${writeTarget.pageId} — nothing was applied`,
      );
    }
    if (typeof preview.planId !== 'string' || preview.planId === '') {
      throw new SmokeSafetyError(`${tool}: preview carried no planId, cannot apply`);
    }

    const applyArgs = { ...planArgs, apply: true, plan_id: preview.planId };

    // `irreversible` applies (deleting a post, deleting a comment) additionally
    // consult the out-of-band gate. Forward the operator's token so a write
    // smoke can actually clean up after itself.
    //
    // `spend` is deliberately NOT included: no amount of harness configuration
    // may auto-approve a write that moves money. A spend-tier apply stays a
    // separate, deliberate human act — which is also why the ads smokes read
    // only and never reach this branch.
    if (preview.tier === 'irreversible') {
      if (confirmToken === undefined) {
        log.warn(
          `${tool}: FB_CONFIRM_TOKEN is not set, so this irreversible apply will be ` +
            'denied by the server and the artifact will be reported as a leak',
        );
      } else {
        applyArgs.confirm_token = confirmToken;
      }
    }

    const applied = await callTool(tool, applyArgs);
    if (applied.status === 'diverged') {
      throw new SmokeSafetyError(
        `${tool}: remote state diverged between preview and apply — nothing was written`,
      );
    }
    if (applied.status !== 'applied' || applied.applied !== true) {
      throw new SmokeSafetyError(
        `${tool}: apply did not report success: ${clip(JSON.stringify(applied), 300)}`,
      );
    }
    return { preview, applied };
  };

  return {
    client,
    callTool,
    callToolRaw,
    applyWrite,
    listTools: () => client.listTools(undefined, { timeout: timeoutMs }),
    stderrTail,
    close: async () => {
      try {
        await client.close();
      } catch (err) {
        log.debug(
          `client close failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

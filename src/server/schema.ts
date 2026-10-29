// The MCP wire shapes the server speaks: the tolerant `tools/call` request
// schema, and the projections from a frozen ToolSpec / ToolResult onto the
// SDK's `tools/list` Tool and `tools/call` CallToolResult shapes.

import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import {
  CallToolRequestParamsSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

import type { ToolResult, ToolSpec } from '../core/index.js';

/**
 * The `tools/call` request schema the handler is registered with: the SDK's own,
 * except that `arguments` of the wrong shape is moved aside instead of failing
 * the parse.
 *
 * The SDK parses a request against the registered schema before any handler
 * runs, and a parse failure there is not an `McpError` — so `arguments: null`
 * (which some clients send for a tool without parameters), an array or a scalar
 * was answered with JSON-RPC -32603, "internal error": the server blamed itself
 * for a malformed call and gave the model nothing to correct. The transform
 * drops the bad value and records its shape on `invalidArguments`, which the
 * handler answers as a tool error. The SDK re-validates the transformed request
 * against its strict schema; an absent `arguments` passes that, and the extra
 * key is ignored by it (not stripped from what the handler receives).
 */
export const TolerantCallToolRequestSchema = CallToolRequestSchema.extend({
  params: CallToolRequestParamsSchema.extend({
    arguments: z.unknown().optional(),
  }).transform(({ arguments: raw, ...params }) => {
    const valid = raw === undefined || isArgumentsObject(raw);
    return {
      ...params,
      arguments: valid ? raw : undefined,
      invalidArguments: valid ? undefined : shapeOf(raw),
    };
  }),
});

/** Whether a `tools/call` `arguments` value is the object the protocol requires. */
function isArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A malformed `arguments` value, named by its shape and never by its content. */
function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** Convert a frozen {@link ToolSpec} into the SDK's `tools/list` `Tool` shape. */
export function toMcpTool(spec: ToolSpec): Tool {
  const inputSchema = toJsonSchemaCompat(spec.inputSchema, {
    strictUnions: true,
    pipeStrategy: 'input',
  }) as Tool['inputSchema'];
  return {
    name: spec.name,
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    description: spec.description,
    inputSchema,
    ...(spec.outputSchema !== undefined
      ? {
          outputSchema: toJsonSchemaCompat(spec.outputSchema, {
            strictUnions: true,
            pipeStrategy: 'output',
          }) as Tool['outputSchema'],
        }
      : {}),
    annotations: spec.annotations,
  };
}

/**
 * Project a lean {@link ToolResult} onto the SDK's `CallToolResult`. `content` is
 * copied into a FRESH mutable array (the frozen result's array is `readonly`);
 * `structuredContent` / `isError` ride along only when present.
 */
export function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: result.content.map((block) => ({ type: 'text' as const, text: block.text })),
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

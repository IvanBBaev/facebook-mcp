// The row shape of the frozen annotation manifest (see `./index.ts`).

import type { WriteTier } from '../../core/index.js';

/**
 * One row per registered tool:
 * `[name, readOnlyHint, destructiveHint, idempotentHint, openWorldHint, writeTier]`.
 * `writeTier` is `undefined` for a read-only tool (the `ToolSpec` contract).
 */
export type AnnotationRow = readonly [
  name: string,
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
  writeTier: WriteTier | undefined,
];

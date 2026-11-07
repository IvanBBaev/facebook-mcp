// Ad node and insights row normalisation, minor-unit budgets (CC-ADS-3) (X11 split of `ads-read.ts`).

import { SPEND_CAP_REMOVAL_SENTINEL } from '../ads-money.js';
import { describeEffectiveStatus, isDelivering } from './effective-status.js';

// ---------------------------------------------------------------------------
// 4. Node normalisation (minor-unit budgets — CC-ADS-3)
// ---------------------------------------------------------------------------

/** One ads object, unknown fields passed through, `id` guaranteed present. */
export interface AdRecord {
  readonly id: string;
  /** Configured status, as Graph returned it. */
  readonly status?: string;
  /** Real delivery state (CC-ADS-2). */
  readonly effective_status?: string;
  /** Derived: whether Meta can deliver this object right now. */
  readonly delivering: boolean;
  /** Derived: what the effective status means, in one line. */
  readonly status_explanation: string;
  readonly [key: string]: unknown;
}

/**
 * A campaign's Advantage+ state (backlog A5), read-only. `state` is the
 * campaign-wide verdict (`ADVANTAGE_PLUS_SALES`, `ADVANTAGE_PLUS_APP`,
 * `ADVANTAGE_PLUS_LEADS`, `GENERAL`, …); the other three say whether each
 * Advantage+ lever is on.
 */
export interface AdvantageState {
  readonly state?: string;
  readonly budget?: string;
  readonly audience?: string;
  readonly placement?: string;
}

/**
 * Normalise `advantage_state_info` to {@link AdvantageState}. A value that is
 * not an object, or carries none of the known keys, returns undefined so the
 * caller keeps Graph's value verbatim instead of an empty shape.
 */
export function normalizeAdvantageState(raw: unknown): AdvantageState | undefined {
  if (!isRecord(raw)) return undefined;
  const state = readString(raw.advantage_state);
  const budget = readString(raw.advantage_budget_state);
  const audience = readString(raw.advantage_audience_state);
  const placement = readString(raw.advantage_placement_state);
  if ([state, budget, audience, placement].every((v) => v === undefined))
    return undefined;
  return {
    ...(state !== undefined ? { state } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...(placement !== undefined ? { placement } : {}),
  };
}

/** Budget keys Graph returns as minor-unit strings; rewritten to `<key>_minor`. */
export const BUDGET_KEYS = [
  'daily_budget',
  'lifetime_budget',
  'budget_remaining',
  'spend_cap',
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Assign a shaped field. `JSON.parse` creates `__proto__` as an OWN property,
 * so a Graph node can carry one and `Object.keys` hands it straight to the
 * shaper — where a plain `out[key] = value` runs the inherited `__proto__`
 * setter instead of defining a field. The key would then vanish from the output
 * and every value on the injected object would start answering property reads on
 * a record this shaper never validated. Defining it is the only assignment that
 * means what it says. Mirrors `setOwn` in `src/mcp/result.ts`.
 */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  out[key] = value;
}

/**
 * A node id off the wire. Graph is not consistent about id encoding — the same
 * field arrives as a JSON string on one build and as a bare number on another,
 * which is why {@link readReportRunId} exists. A number that is exactly
 * representable IS the id and is worth keeping; one that is not has already
 * been rounded by `JSON.parse`, and `String(n)` would mint a plausible id for an
 * object that does not exist. Refusing beats inventing (CC-NET-2).
 */
function readNodeId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  return readString(value);
}

/**
 * Parse a minor-unit amount Graph sent as a decimal string (or, rarely, a
 * number). Returns `undefined` for anything that is not a safe integer, so a
 * surprising value is passed through untouched instead of being rounded.
 */
export function parseMinorUnits(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Drop every `paging` object from a passed-through value, at ANY depth. `fields`
 * is caller-supplied and supports expansions (`ads{id,name}`,
 * `adcreatives{...}`), and an expanded edge comes back as `{ data, paging }` —
 * so the token-bearing `paging.next` sits BELOW the node's top level, where a
 * top-level key loop never reaches it. The value is rebuilt, never mutated.
 */
function stripNestedPaging(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNestedPaging);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === 'paging') continue;
    setOwn(out, key, stripNestedPaging(value[key]));
  }
  return out;
}

/**
 * Normalise one ads node: pass unknown fields through, guarantee a string `id`,
 * add the derived delivery truth (CC-ADS-2), and replace minor-unit budget
 * strings with integer `*_minor` fields (CC-ADS-3). `paging` is dropped at EVERY
 * depth — nested edge paging carries the access token and must never travel
 * further (C3). The input is never mutated.
 */
export function normalizeAdNode(raw: unknown): AdRecord {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (key === 'paging') continue;
    if ((BUDGET_KEYS as readonly string[]).includes(key)) continue;
    if (key === 'advantage_state_info') {
      const advantage = normalizeAdvantageState(src[key]);
      if (advantage !== undefined) {
        out.advantage = advantage;
        continue;
      }
    }
    setOwn(out, key, stripNestedPaging(src[key]));
  }
  out.id = readNodeId(src.id) ?? '';

  for (const key of BUDGET_KEYS) {
    if (!(key in src)) continue;
    const minor = parseMinorUnits(src[key]);
    const beyondSafe =
      minor === undefined && /^\d{16,}$/.test(readString(src[key])?.trim() ?? '');
    if (
      key === 'spend_cap' &&
      (beyondSafe || (minor !== undefined && minor >= SPEND_CAP_REMOVAL_SENTINEL))
    ) {
      // Meta's "no cap" sentinel (or a wider integer form of it) is not an
      // amount: `null` means the campaign has none.
      out.spend_cap_minor = null;
    } else if (minor !== undefined) {
      out[`${key}_minor`] = minor;
    } else {
      // Not an integer string — keep Graph's value verbatim rather than invent one.
      out[key] = src[key];
    }
  }

  const effective = readString(src.effective_status);
  const configured = readString(src.status);
  out.delivering = isDelivering(effective);
  out.status_explanation = describeEffectiveStatus(effective, configured);

  return out as AdRecord;
}

/**
 * Normalise one INSIGHTS row. An insights row is a bag of metrics, not an ads
 * object: it has no `id`, no `status` and no `effective_status`, so running it
 * through {@link normalizeAdNode} would stamp it with `id: ''` and
 * `delivering: false` — labelling a row that is itself proof of delivery
 * ("12000 impressions, 48.10 spent") as not delivering. Metrics pass through
 * untouched; only `paging` is dropped — at every depth, because an expanded edge
 * nests it below the row's top level and it carries the access token (C3).
 */
export function normalizeInsightsRow(raw: unknown): AdRecord {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (key === 'paging') continue;
    setOwn(out, key, stripNestedPaging(src[key]));
  }
  return out as AdRecord;
}

/**
 * Fields this module's own contract depends on, whatever the caller asked for.
 * `effective_status` is declared non-negotiable on every level (CC-ADS-2) and
 * every record is documented as carrying a derived `delivering` flag — but
 * `fields` is caller-supplied, so without pinning, `fields:'id,name,status'`
 * silently strips the evidence and every record comes back `delivering: false`.
 * Reporting a running ad as stopped is the exact failure CC-ADS-2 exists to
 * prevent, so the field is pinned on the request rather than hoped for. `status`
 * rides along because the explanation needs the configured value to call out the
 * ACTIVE-but-not-delivering trap, and `id` because the record guarantees one.
 */
export const PINNED_AD_FIELDS = ['id', 'status', 'effective_status'] as const;

/**
 * The top-level field names of a Graph `fields` list, each with its nested
 * selection (`{...}`) and modifiers (`.limit(5)`, `(...)`) removed. Commas at
 * any brace/paren depth other than zero are part of a nested value, not a
 * separator.
 */
export function topLevelFieldNames(fields: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  const flush = (): void => {
    const name = current.trim().split('.')[0]?.trim() ?? '';
    if (name !== '') names.push(name);
    current = '';
  };
  for (const ch of fields) {
    if (ch === '{' || ch === '(') {
      depth += 1;
    } else if (ch === '}' || ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (ch === ',') flush();
      else current += ch;
    }
  }
  flush();
  return names;
}

/** Union a caller-supplied `fields` list with {@link PINNED_AD_FIELDS}. */
export function withPinnedAdFields(fields: string): string {
  const pinned = [...PINNED_AD_FIELDS];
  if (fields.trim() === '') return pinned.join(',');
  // Only TOP-LEVEL names count: an inner `id` in `creative{id,name}` is not the
  // record's own. Nesting is tracked by depth rather than stripped with a regex,
  // because selections nest (`ads{creative{id},effective_status}`) and modifiers
  // carry commas and braces (`insights.time_range({...}){spend}`) — a strip that
  // stops at the first `}` leaks the inner fields to the top level.
  const present = new Set(topLevelFieldNames(fields));
  const missing = pinned.filter((field) => !present.has(field));
  return missing.length === 0 ? fields : `${fields},${missing.join(',')}`;
}

/**
 * Emitted on an EMPTY listing page that still hands back a forward cursor.
 * Graph can answer a slice with `data: []` next to `paging.next` (CC-PAGE-1) —
 * most often under a server-side `effective_status` filter — so "no objects"
 * would be false while the next page is one call away.
 */
export const EMPTY_ADS_PAGE_MORE_FOLLOWS_NOTE =
  'No objects on this page, but Graph returned a forward cursor — more pages follow. ' +
  'Resume with `nextCursor` before concluding anything about how many objects the account has.';

/** The insights counterpart of {@link EMPTY_ADS_PAGE_MORE_FOLLOWS_NOTE}. */
export const EMPTY_INSIGHTS_PAGE_MORE_FOLLOWS_NOTE =
  'No insights rows on this page, but Graph returned a forward cursor — more pages follow. ' +
  'Resume with `nextCursor` before concluding whether the object delivered in the window.';

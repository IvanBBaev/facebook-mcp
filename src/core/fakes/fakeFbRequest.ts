// In-memory FbRequestFn fake (test-only).
//
// Programmable two ways:
//   * `enqueue(...)` — a FIFO sequence consumed in call order (for tests that
//     drive a scripted exchange, e.g. retry/resume sequences).
//   * `on(matcher, ...)` — matcher rules consulted when the queue is empty.
// Every call is captured in `calls` for assertions. An unmatched request rejects
// with a clear "unexpected request" error so gaps in a test's programming fail
// loudly instead of silently returning undefined.

import type { FbRequest, FbRequestFn, FbResponse, FbResponseHeaders } from '../types.js';

/** Predicate selecting which requests a rule applies to. */
export type FbMatcher = (req: FbRequest) => boolean;

/** A canned outcome: either a successful response body or a thrown error. */
export type FbStubResult =
  | {
      readonly data: unknown;
      readonly headers?: Readonly<Record<string, string>>;
      readonly status?: number;
    }
  | { readonly error: Error };

interface Rule {
  match: FbMatcher;
  result: FbStubResult;
  remaining: number;
}

/** Build a success outcome. */
export function fbOk(
  data: unknown,
  headers?: Readonly<Record<string, string>>,
  status = 200,
): FbStubResult {
  return { data, headers, status };
}

/** Build an error outcome. */
export function fbErr(error: Error): FbStubResult {
  return { error };
}

/** The programmable fake and its captured state. */
export interface FakeFbRequest {
  /** The `FbRequestFn` to inject where a real client is expected. */
  readonly fn: FbRequestFn;
  /** Every request received, in order. */
  readonly calls: readonly FbRequest[];
  /** The most recent request, or undefined if none yet. */
  lastRequest(): FbRequest | undefined;
  /** Register a matcher rule; `times` limits how often it applies (default: unlimited). */
  on(match: FbMatcher, result: FbStubResult, times?: number): FakeFbRequest;
  /** Queue a sequential outcome consumed FIFO before any matcher rules. */
  enqueue(result: FbStubResult): FakeFbRequest;
  /** Clear queue, rules, and captured calls. */
  reset(): void;
}

function lowercaseHeaders(headers?: Readonly<Record<string, string>>): FbResponseHeaders {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function isError(result: FbStubResult): result is { readonly error: Error } {
  return 'error' in result;
}

/** Create a programmable fake FbRequest client. */
export function createFakeFbRequest(): FakeFbRequest {
  const calls: FbRequest[] = [];
  const queue: FbStubResult[] = [];
  const rules: Rule[] = [];

  const apply = <T>(result: FbStubResult): Promise<FbResponse<T>> => {
    if (isError(result)) {
      return Promise.reject(result.error);
    }
    return Promise.resolve({
      data: result.data as T,
      headers: lowercaseHeaders(result.headers),
      status: result.status ?? 200,
    });
  };

  const fn: FbRequestFn = <T = unknown>(req: FbRequest): Promise<FbResponse<T>> => {
    calls.push(req);

    const queued = queue.shift();
    if (queued !== undefined) {
      return apply<T>(queued);
    }

    const rule = rules.find((r) => r.remaining > 0 && r.match(req));
    if (rule) {
      if (rule.remaining !== Number.POSITIVE_INFINITY) {
        rule.remaining -= 1;
      }
      return apply<T>(rule.result);
    }

    return Promise.reject(
      new Error(
        `fakeFbRequest: unexpected request ${req.method} ${req.protocol} ${req.host}${req.path} ` +
          `(no queued response and no matching rule)`,
      ),
    );
  };

  const self: FakeFbRequest = {
    fn,
    get calls() {
      return calls;
    },
    lastRequest: () => calls[calls.length - 1],
    on: (
      match: FbMatcher,
      result: FbStubResult,
      times = Number.POSITIVE_INFINITY,
    ): FakeFbRequest => {
      rules.push({ match, result, remaining: times });
      return self;
    },
    enqueue: (result: FbStubResult): FakeFbRequest => {
      queue.push(result);
      return self;
    },
    reset: (): void => {
      calls.length = 0;
      queue.length = 0;
      rules.length = 0;
    },
  };

  return self;
}

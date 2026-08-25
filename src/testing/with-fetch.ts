// Recording fake global `fetch` for the scope of a callback (task F03).
//
// `withFetch` installs a fake `fetch` that (a) records every outgoing request —
// method, URL, headers, redirect policy, and a structured capture of the body
// across all shapes `fbRequest` emits (JSON string, URLSearchParams, multipart
// FormData, and raw binary / ArrayBuffer / Uint8Array rupload chunks) — and
// (b) answers each call
// with a programmed `Response` selected from a FIFO queue, then matcher rules,
// then an optional fallback. On exit it restores the previous global `fetch`
// (the C13 network fence when that is installed), even if the callback throws.
//
// This is LOWER-LEVEL than the contract-level `fakeFbRequest` fake: it mocks the
// wire (global `fetch`) so the real `core/http.ts` / `core/http-upload.ts`
// clients (F07/F08) can be tested end to end, whereas `fakeFbRequest` stubs the
// `FbRequestFn` contract for layers above the HTTP client.

// The global `fetch` typings shipped with @types/node (undici) do not export
// `RequestInfo` / `BodyInit` as standalone global names, so derive the shapes we
// need directly from the global `fetch` and `Response` types.
type FetchInput = Parameters<typeof fetch>[0];
type FetchBody = RequestInit['body'] | undefined;
type FetchRedirect = RequestInit['redirect'];
type ResponseBody = ConstructorParameters<typeof Response>[0];

/** A single captured file part of a multipart FormData body. */
export interface CapturedFilePart {
  /** The form field name the part was sent under. */
  readonly field: string;
  readonly filename?: string;
  readonly contentType?: string;
  /** A defensive copy of the part's bytes. */
  readonly bytes: Uint8Array;
  readonly size: number;
}

/** Structured capture of a request body, discriminated by `kind`. */
export type CapturedBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'json'; readonly text: string; readonly json: unknown }
  | {
      readonly kind: 'urlencoded';
      readonly text: string;
      readonly params: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'formData';
      readonly fields: Readonly<Record<string, string>>;
      readonly files: readonly CapturedFilePart[];
    }
  | { readonly kind: 'binary'; readonly bytes: Uint8Array; readonly byteLength: number };

/** One recorded outgoing request. Header keys are lowercased. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: CapturedBody;
  /**
   * The redirect policy the caller asked for; `undefined` means it asked for
   * nothing and would get the platform default (`'follow'`). Recorded because
   * `redirect: 'manual'` is the control that stops a 3xx from carrying the token
   * off an allowlisted host (CC-NET-7) — a fake cannot follow redirects, so
   * without this the setting is invisible to every test that programs a 3xx.
   */
  readonly redirect?: FetchRedirect;
}

/**
 * Declarative programming of a `Response`. Exactly one body form is used, tried
 * in order: `json` (serialized, `content-type: application/json` unless
 * overridden), then `text`, then `bytes`; otherwise the response has no body.
 */
export interface ResponseSpec {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly text?: string;
  readonly bytes?: Uint8Array | ArrayBuffer;
}

/** Predicate selecting which recorded requests a matcher rule answers. */
export type FetchMatcher = (req: RecordedRequest) => boolean;

/** The controller handed to a `withFetch` callback. */
export interface FetchMock {
  /** Every request received so far, in order. */
  readonly requests: readonly RecordedRequest[];
  /** The most recent request, or `undefined` if none yet. */
  lastRequest(): RecordedRequest | undefined;
  /** Queue a response consumed FIFO before any matcher rule. */
  enqueue(spec: ResponseSpec): FetchMock;
  /** Register a matcher rule; `times` limits how often it applies (default: unlimited). */
  on(match: FetchMatcher, spec: ResponseSpec, times?: number): FetchMock;
  /** Set a fallback used when neither the queue nor a rule matches (default: throw). */
  fallback(spec: ResponseSpec): FetchMock;
}

interface MatcherRule {
  match: FetchMatcher;
  spec: ResponseSpec;
  remaining: number;
}

async function captureBody(body: FetchBody): Promise<CapturedBody> {
  if (body === null || body === undefined) {
    return { kind: 'none' };
  }
  if (body instanceof URLSearchParams) {
    const params: Record<string, string> = {};
    for (const [key, value] of body) {
      params[key] = value;
    }
    return { kind: 'urlencoded', text: body.toString(), params };
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fields: Record<string, string> = {};
    const files: CapturedFilePart[] = [];
    for (const [field, value] of body.entries()) {
      if (typeof value === 'string') {
        fields[field] = value;
        continue;
      }
      const blob = value as Blob & { name?: string };
      const bytes = new Uint8Array(await blob.arrayBuffer());
      files.push({
        field,
        filename: blob.name,
        contentType: blob.type.length > 0 ? blob.type : undefined,
        bytes,
        size: bytes.byteLength,
      });
    }
    return { kind: 'formData', fields, files };
  }
  if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body.slice(0));
    return { kind: 'binary', bytes, byteLength: bytes.byteLength };
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    );
    return { kind: 'binary', bytes, byteLength: bytes.byteLength };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer());
    return { kind: 'binary', bytes, byteLength: bytes.byteLength };
  }
  if (typeof body === 'string') {
    try {
      return { kind: 'json', text: body, json: JSON.parse(body) as unknown };
    } catch {
      return { kind: 'text', text: body };
    }
  }
  // ReadableStream or another exotic shape: `fbRequest` never emits these, so we
  // record a marker rather than attempt to drain a one-shot stream.
  return { kind: 'text', text: '[unrecorded stream body]' };
}

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function requestMethod(input: FetchInput, init?: RequestInit): string {
  if (init?.method !== undefined) {
    return init.method.toUpperCase();
  }
  if (input instanceof Request) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

function mergeHeaders(input: FetchInput, init?: RequestInit): Record<string, string> {
  const headers = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value));
  }
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function resolveBody(input: FetchInput, init?: RequestInit): Promise<FetchBody> {
  if (init && 'body' in init) {
    return init.body;
  }
  if (input instanceof Request) {
    const buf = await input.clone().arrayBuffer();
    return buf.byteLength > 0 ? new Uint8Array(buf) : undefined;
  }
  return undefined;
}

function buildResponse(spec: ResponseSpec): Response {
  const headers = new Headers(spec.headers);
  let bodyInit: ResponseBody = null;
  if (spec.json !== undefined) {
    bodyInit = JSON.stringify(spec.json);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  } else if (spec.text !== undefined) {
    bodyInit = spec.text;
  } else if (spec.bytes !== undefined) {
    bodyInit = spec.bytes;
  }
  return new Response(bodyInit, {
    status: spec.status ?? 200,
    statusText: spec.statusText,
    headers,
  });
}

/**
 * Install a recording fake `fetch`, run `fn` with a {@link FetchMock}
 * controller, then restore the previous global `fetch`. The callback programs
 * responses on the controller (via `enqueue`/`on`/`fallback`) before triggering
 * the code under test. An unprogrammed request rejects with a clear error so
 * gaps in a test's programming fail loudly.
 */
export async function withFetch<T>(fn: (mock: FetchMock) => T | Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  const queue: ResponseSpec[] = [];
  const rules: MatcherRule[] = [];
  let fallbackSpec: ResponseSpec | undefined;

  const selectSpec = (record: RecordedRequest): ResponseSpec => {
    const queued = queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    const rule = rules.find((r) => r.remaining > 0 && r.match(record));
    if (rule) {
      if (rule.remaining !== Number.POSITIVE_INFINITY) {
        rule.remaining -= 1;
      }
      return rule.spec;
    }
    if (fallbackSpec !== undefined) {
      return fallbackSpec;
    }
    throw new Error(
      `withFetch: unexpected request ${record.method} ${record.url} ` +
        `(no queued response, no matching rule, no fallback)`,
    );
  };

  const mockFetch = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const record: RecordedRequest = {
      method: requestMethod(input, init),
      url: requestUrl(input),
      headers: mergeHeaders(input, init),
      body: await captureBody(await resolveBody(input, init)),
      redirect: init?.redirect ?? (input instanceof Request ? input.redirect : undefined),
    };
    requests.push(record);
    return buildResponse(selectSpec(record));
  };

  const controller: FetchMock = {
    get requests() {
      return requests;
    },
    lastRequest: () => requests[requests.length - 1],
    enqueue: (spec: ResponseSpec): FetchMock => {
      queue.push(spec);
      return controller;
    },
    on: (
      match: FetchMatcher,
      spec: ResponseSpec,
      times = Number.POSITIVE_INFINITY,
    ): FetchMock => {
      rules.push({ match, spec, remaining: times });
      return controller;
    },
    fallback: (spec: ResponseSpec): FetchMock => {
      fallbackSpec = spec;
      return controller;
    },
  };

  globalThis.fetch = mockFetch;
  try {
    return await fn(controller);
  } finally {
    globalThis.fetch = previous;
  }
}

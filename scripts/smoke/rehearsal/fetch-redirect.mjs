// Offline rehearsal only: a `--import` preload that points every Graph request
// at the loopback fake (fake-graph.mjs) and refuses everything else.
//
// `scripts/smoke/rehearse.mjs` injects this through NODE_OPTIONS into the
// harness process (run.mjs), which hands its whole environment to the server
// child (env.mjs, `buildChildEnv`) — so the harness's own escape hatch
// (graph-escape.mjs) and the shipped server are redirected by the SAME module,
// and neither of them carries a line of rehearsal-specific code. Both call the
// global `fetch` at request time (src/core/http.ts, src/core/http-upload.ts,
// graph-escape.mjs), which is the whole seam.
//
// The module is fail-closed by construction:
//
//   * loaded as the preload (FB_SMOKE_REHEARSAL_PRELOAD=1), it throws at import
//     when FB_SMOKE_REHEARSAL_GRAPH is unset or is not a loopback http origin —
//     a process that preloads it can never fall through to the real `fetch`;
//   * a request to one of the three Graph hosts is rewritten to
//     `<origin>/__host/<graph-host><path>?<query>`, so the fake can still tell
//     graph / graph-video / rupload apart;
//   * a request already aimed at the loopback origin passes unchanged;
//   * ANY other destination is refused with an error, never forwarded.
//
// It is never loaded by the server on its own and ships nowhere: `build/` does
// not contain it, and the npm package only publishes `build/` and `bin/`.

export const REHEARSAL_GRAPH_VAR = 'FB_SMOKE_REHEARSAL_GRAPH';

/** The three hosts the server allowlists (GRAPH_HOSTS in src/core/settings.ts). */
export const GRAPH_HOSTS = Object.freeze([
  'graph.facebook.com',
  'graph-video.facebook.com',
  'rupload.facebook.com',
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Printed at the start of every refusal, so a stray request is unmistakable. */
export const REDIRECT_REFUSAL = '[smoke rehearsal fence]';

/**
 * Validate the fake's origin. Pure; throws on anything that is not
 * `http://<loopback>:<port>`.
 */
export function parseRehearsalOrigin(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `${REDIRECT_REFUSAL} ${REHEARSAL_GRAPH_VAR} is not set — refusing to load a ` +
        'redirect with nowhere safe to send Graph traffic',
    );
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${REDIRECT_REFUSAL} ${REHEARSAL_GRAPH_VAR} is not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.port === '') {
    throw new Error(
      `${REDIRECT_REFUSAL} ${REHEARSAL_GRAPH_VAR} must be a loopback http origin with a ` +
        `port (http://127.0.0.1:<port>), got ${raw}`,
    );
  }
  return url.origin;
}

/**
 * Map one outgoing URL to where it may go, or throw. Pure.
 *
 * @param {string} target  the absolute URL the caller asked for
 * @param {string} origin  the validated fake origin
 * @returns {string} the URL to actually fetch
 */
export function redirectUrl(target, origin) {
  let url;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`${REDIRECT_REFUSAL} refused a non-absolute URL: ${String(target)}`);
  }
  if (url.origin === origin) {
    return url.href;
  }
  if (
    url.protocol === 'https:' &&
    GRAPH_HOSTS.includes(url.hostname) &&
    url.port === ''
  ) {
    return `${origin}/__host/${url.hostname}${url.pathname}${url.search}`;
  }
  throw new Error(
    `${REDIRECT_REFUSAL} refused ${url.protocol}//${url.host} — the rehearsal only ` +
      'lets requests reach the loopback fake Graph',
  );
}

/**
 * Wrap a `fetch` so every call goes through `redirectUrl`. The refusal is a
 * rejected promise, the same failure shape a network error has.
 */
export function createRedirectingFetch(origin, realFetch) {
  return async function rehearsalFetch(input, init) {
    if (input instanceof Request) {
      const next = redirectUrl(input.url, origin);
      return realFetch(new Request(next, input), init);
    }
    const target = input instanceof URL ? input.href : String(input);
    return realFetch(redirectUrl(target, origin), init);
  };
}

/** Install the redirect over `globalThis.fetch`. Throws when the origin is unusable. */
export function installRedirect(env = process.env) {
  const origin = parseRehearsalOrigin(env[REHEARSAL_GRAPH_VAR]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = createRedirectingFetch(origin, realFetch);
  return origin;
}

// Loaded as a preload (`--import`) ⇒ install immediately. Imported by a test
// with the variable deliberately unset ⇒ stay inert so the pure helpers above
// can be exercised; `installRedirect` is still exported for that case.
if (process.env.FB_SMOKE_REHEARSAL_PRELOAD === '1') {
  installRedirect();
}

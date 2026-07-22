// C13 network fence — the default test baseline.
//
// Importing this module (e.g. via `node --import ./build/testing/network-fence.js`
// or `NODE_OPTIONS=--import ...`) replaces the global `fetch` with a thrower, so
// any test that reaches the network by accident fails loudly instead of hitting
// the live Graph API. Tests that need to exercise HTTP code use `withFetch`
// (see ./with-fetch.ts), which temporarily swaps in a recording mock and
// restores this thrower when its scope exits.
//
// The fence throws SYNCHRONOUSLY (rather than returning a rejected promise) so
// even `fetch(...).then(...)` without an awaiting caller blows up immediately —
// exactly the loud failure a fence should produce.

const FENCE_MESSAGE =
  'network access is disabled in tests — use withFetch() to program fetch';

/** Error thrown by every `fetch` call while the fence is installed. */
export class NetworkFenceError extends Error {
  constructor(message: string = FENCE_MESSAGE) {
    super(message);
    this.name = 'NetworkFenceError';
    // Restore the prototype chain so `instanceof NetworkFenceError` holds.
    Object.setPrototypeOf(this, NetworkFenceError.prototype);
  }
}

/** The throwing `fetch` stand-in installed by the fence. */
export const fenceFetch: typeof fetch = () => {
  throw new NetworkFenceError();
};

/** (Re)install the fence as the current global `fetch`. Idempotent. */
export function installNetworkFence(): void {
  globalThis.fetch = fenceFetch;
}

// Side effect on import: install the fence as the default baseline. Kept last so
// the exports above are fully initialized first.
installNetworkFence();

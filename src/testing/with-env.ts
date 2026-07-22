// Scoped `process.env` mutation with guaranteed restore (task F03).
//
// `withEnv` applies a set of env overrides for the duration of a callback and
// restores the exact prior state on exit — including on throw. A key whose
// override value is `undefined` is DELETED for the scope (not set to the string
// "undefined"), then restored to whatever it was before. This is the low-level
// seam config/settings tests (F04) use to exercise the `FB_*` surface without
// leaking state between tests.

/** Overrides to apply; a value of `undefined` deletes the key for the scope. */
export type EnvOverrides = Readonly<Record<string, string | undefined>>;

/**
 * Run `fn` with `overrides` applied to `process.env`, then restore the original
 * values (set-or-delete) whether `fn` returns or throws. Always resolves to a
 * Promise so both sync and async callbacks are supported with the same
 * restore-on-throw guarantee.
 */
export async function withEnv<T>(
  overrides: EnvOverrides,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();

  for (const key of Object.keys(overrides)) {
    saved.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, original] of saved) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

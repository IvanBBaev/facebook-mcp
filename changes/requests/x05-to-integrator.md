# Request: X05 → integrator

From task X05. `src/metadata.test.ts` is integration-only, so X05 does not edit it.

## `src/metadata.test.ts` — scan the moved setup-token source

`setupEnvNames()` reads one file, `src/mcp/setup-token.ts`, and collects every
`FB_*` name in it. After X05 that path is a five-line facade; the code that
reads `FB_SETUP_TOKEN` lives in `src/cli/setup-token/*.ts`.

The test stays green today only because the facade's header comment mentions
`FB_SETUP_TOKEN` (the one setup-only name not already in
`src/core/settings.ts`). That is fragile: dropping the comment would make
`.env.example advertises nothing the server ignores` fail, and a new setup-only
variable added in `src/cli/setup-token/` would go undetected.

Change `setupEnvNames()` to read every `*.ts` file (excluding `*.test.ts`) under
`src/cli/setup-token/` and union the names, e.g.:

```ts
async function setupEnvNames(): Promise<ReadonlySet<string>> {
  const dir = join(ROOT, 'src', 'cli', 'setup-token');
  const files = (await readdir(dir)).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  const names = new Set<string>();
  for (const file of files) {
    for (const name of envNames(await readText('src', 'cli', 'setup-token', file))) {
      names.add(name);
    }
  }
  return names;
}
```

and update the header comment (`src/mcp/setup-token.ts` →
`src/cli/setup-token/`). The set of names is the same as before X05.

Also stale after X05 (comments only, no behaviour): `src/tools/core.ts:306`
and `scripts/record-fixture.mjs:89` mention `src/mcp/setup-token.ts`; the path
still resolves (facade), so this is cosmetic.

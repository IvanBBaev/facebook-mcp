import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/** The one mcp/ file allowed to import cli/: the setup-token facade. */
const SETUP_TOKEN_FACADE = 'src/mcp/setup-token.ts';

const LAYER_MESSAGES = {
  core: 'core is layer 0 — it must not import from api/, mcp/, tools/, cli/ or server/.',
  api: 'api is layer 1 — it must not import from mcp/, tools/, cli/ or server/.',
  mcp: 'mcp is layer 2 — it must not import from tools/, cli/ or server/.',
  tools: 'tools is layer 3 — it must not import from cli/ or server/.',
  cli: 'cli is layer 4 — it may import core/, api/ and mcp/ only, not tools/ or server/.',
};

/** import-x zones: each target directory may not import from the `from` list. */
const LAYER_ZONES = [
  {
    target: './src/core',
    from: ['./src/api', './src/mcp', './src/tools', './src/cli', './src/server'],
    message: LAYER_MESSAGES.core,
  },
  {
    target: './src/api',
    from: ['./src/mcp', './src/tools', './src/cli', './src/server'],
    message: LAYER_MESSAGES.api,
  },
  {
    target: './src/mcp',
    from: ['./src/tools', './src/cli', './src/server'],
    message: LAYER_MESSAGES.mcp,
  },
  {
    target: './src/tools',
    from: ['./src/cli', './src/server'],
    message: LAYER_MESSAGES.tools,
  },
  {
    target: './src/cli',
    from: ['./src/tools', './src/server'],
    message: LAYER_MESSAGES.cli,
  },
];

/** `LAYER_ZONES` with cli/ dropped from the mcp/ zone (setup-token facade only). */
const FACADE_ZONES = LAYER_ZONES.map((zone) =>
  zone.target === './src/mcp'
    ? { ...zone, from: zone.from.filter((dir) => dir !== './src/cli') }
    : zone,
);

/**
 * Matches a relative import that reaches into a `server/` directory — the
 * string-based twin of the server/ zone (see the note on the blocks below).
 */
const RELATIVE_SERVER_IMPORT = '^\\.{1,2}/(?:.*/)?server/';

/**
 * One string-based no-restricted-imports block: `globs` plus the relative
 * server/ regex, all reported with the layer's message. Every restricted layer
 * sits below server/, so every block forbids it.
 */
function restrictImports(files, message, globs) {
  return {
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: globs, message },
            { regex: RELATIVE_SERVER_IMPORT, message },
          ],
        },
      ],
    },
  };
}

export default tseslint.config(
  // `.claude/` is the local-only AI harness; agent worktrees checked out under
  // it carry their own build/ trees and must never fail this repo's lint.
  { ignores: ['build/', 'coverage/', 'node_modules/', 'docs/', '.claude/'] },

  js.configs.recommended,

  // Type-checked rules for the TypeScript source. Scoped to src/ so plain-JS
  // config/bin files stay on the syntax-only ruleset.
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // A forgotten await in an async handler silently drops errors.
      '@typescript-eslint/no-floating-promises': 'error',
      // stderr-only logging discipline: stdout is the stdio JSON-RPC channel,
      // so console.log/info/debug (which write to stdout) are forbidden in the
      // server source; console.warn/error (stderr) remain allowed.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // node:test's top-level test()/describe() return a promise the runner itself
  // manages; not awaiting them is the intended idiom, so this rule would only
  // produce noise in colocated *.test.ts files.
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // Layer boundaries — core <- api <- mcp <- tools <- cli <- server — as
  // import-x path zones: a target directory may not import *from* the listed
  // higher layers. server/ (the process entry and wiring) is the top layer and
  // is unrestricted. cli/ (operator subcommands such as setup-token) may import
  // core/, api/ and mcp/ only. The zones live in `LAYER_ZONES` so the
  // setup-token facade override below can reuse them.
  {
    files: ['src/**/*.ts'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ project: './tsconfig.json' }),
      ],
    },
    rules: {
      'import-x/no-restricted-paths': ['error', { zones: LAYER_ZONES }],
    },
  },

  // The facade exception (doc 05 §1 rule 6): `src/mcp/setup-token.ts` keeps the
  // old path of the setup-token CLI alive as `export * from
  // '../cli/setup-token/index.js'`, so it is the one mcp/ file allowed to import
  // cli/. Flat config replaces (does not merge) rule options per file, so this
  // object restates the full zone list with only mcp's cli entry removed. It goes
  // away with the facade, once the entry imports src/cli directly.
  {
    files: [SETUP_TOKEN_FACADE],
    rules: {
      'import-x/no-restricted-paths': ['error', { zones: FACADE_ZONES }],
    },
  },

  // The same layer map expressed with string-based no-restricted-imports, so
  // enforcement never depends on module resolution. server/ is unrestricted —
  // it may import from every lower layer. server/ is matched with a regex on
  // RELATIVE specifiers only, because mcp/ legitimately imports the SDK's
  // `@modelcontextprotocol/sdk/server/*`, which a `**/server/**` glob would hit.
  restrictImports(['src/core/**/*.ts'], LAYER_MESSAGES.core, [
    '**/api/**',
    '**/mcp/**',
    '**/tools/**',
    '**/cli/**',
  ]),
  restrictImports(['src/api/**/*.ts'], LAYER_MESSAGES.api, [
    '**/mcp/**',
    '**/tools/**',
    '**/cli/**',
  ]),
  restrictImports(['src/mcp/**/*.ts'], LAYER_MESSAGES.mcp, ['**/tools/**', '**/cli/**']),
  // The setup-token facade again: the same mcp/ restriction minus cli/.
  restrictImports([SETUP_TOKEN_FACADE], LAYER_MESSAGES.mcp, ['**/tools/**']),
  restrictImports(['src/tools/**/*.ts'], LAYER_MESSAGES.tools, ['**/cli/**']),
  restrictImports(['src/cli/**/*.ts'], LAYER_MESSAGES.cli, ['**/tools/**']),

  // Plain JS/MJS (this config, the bin launcher, future scripts): syntax-only.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },

  prettier,
);

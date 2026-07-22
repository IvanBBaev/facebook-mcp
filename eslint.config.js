import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['build/', 'coverage/', 'node_modules/', 'docs/'] },

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

  // Layer boundaries — core <- api <- mcp <- tools — as import-x path zones:
  // a target directory may not import *from* the listed higher layers.
  {
    files: ['src/**/*.ts'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ project: './tsconfig.json' }),
      ],
    },
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/core',
              from: ['./src/api', './src/mcp', './src/tools'],
              message: 'core is layer 0 — it must not import from api/, mcp/ or tools/.',
            },
            {
              target: './src/api',
              from: ['./src/mcp', './src/tools'],
              message: 'api is layer 1 — it must not import from mcp/ or tools/.',
            },
            {
              target: './src/mcp',
              from: ['./src/tools'],
              message: 'mcp is layer 2 — it must not import from tools/.',
            },
          ],
        },
      ],
    },
  },

  // The same layer map expressed with string-based no-restricted-imports, so
  // enforcement never depends on module resolution. tools/ (layer 3) is
  // unrestricted — it may import from every lower layer.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/**', '**/mcp/**', '**/tools/**'],
              message: 'core is layer 0 — it must not import from api/, mcp/ or tools/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/mcp/**', '**/tools/**'],
              message: 'api is layer 1 — it must not import from mcp/ or tools/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/mcp/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tools/**'],
              message: 'mcp is layer 2 — it must not import from tools/.',
            },
          ],
        },
      ],
    },
  },

  // Plain JS/MJS (this config, the bin launcher, future scripts): syntax-only.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },

  prettier,
);

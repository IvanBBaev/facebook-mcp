// Tests for the launch-form detection that every CLI hint is rendered with.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_HINT_LAUNCH_COMMAND } from '../core/errors.js';
import {
  DEFAULT_LAUNCH_COMMAND,
  resolveLaunchCommand,
  SOURCE_BIN_ENTRY,
  SOURCE_ENTRY,
  subcommandHint,
} from './launch-command.js';

const PKG = '@ivanbaev/facebook-mcp';
const NODE = '/usr/local/bin/node';

test('npx: npm_command=exec renders the npx form with the package name', () => {
  const launch = resolveLaunchCommand({
    env: { npm_command: 'exec' },
    argv: [NODE, '/home/u/.npm/_npx/abc/node_modules/.bin/facebook-mcp', 'doctor'],
    packageName: PKG,
  });
  assert.equal(launch, 'npx -y @ivanbaev/facebook-mcp');
  assert.equal(subcommandHint(launch, 'doctor'), 'npx -y @ivanbaev/facebook-mcp doctor');
});

test('npx: npm_lifecycle_event=npx alone is enough', () => {
  assert.equal(
    resolveLaunchCommand({
      env: { npm_lifecycle_event: 'npx' },
      argv: [NODE, '/somewhere/facebook-mcp'],
      packageName: PKG,
    }),
    `npx -y ${PKG}`,
  );
});

test('npx: the _npx cache path is enough when the client scrubbed the npm env', () => {
  assert.equal(
    resolveLaunchCommand({
      env: {},
      argv: [
        NODE,
        'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@ivanbaev\\facebook-mcp\\bin\\facebook-mcp.mjs',
      ],
      packageName: PKG,
    }),
    `npx -y ${PKG}`,
  );
});

test('npx without a readable package name falls back to the binary name', () => {
  assert.equal(
    resolveLaunchCommand({ env: { npm_command: 'exec' }, argv: [NODE, '/x/_npx/y'] }),
    DEFAULT_LAUNCH_COMMAND,
  );
});

test('source checkout: node build/index.js', () => {
  assert.equal(
    resolveLaunchCommand({
      env: {},
      argv: [NODE, '/home/u/src/facebook-mcp/build/index.js', 'doctor'],
      packageName: PKG,
    }),
    SOURCE_ENTRY,
  );
  assert.equal(SOURCE_ENTRY, 'node build/index.js');
});

test('source checkout: npm start (run-script) still reads as a source checkout', () => {
  assert.equal(
    resolveLaunchCommand({
      env: { npm_command: 'run-script', npm_lifecycle_event: 'start' },
      argv: [NODE, 'D:\\src\\facebook-mcp\\build\\index.js'],
      packageName: PKG,
    }),
    SOURCE_ENTRY,
  );
});

test('source checkout: the launcher shim run directly with node', () => {
  assert.equal(
    resolveLaunchCommand({
      env: {},
      argv: [NODE, '/home/u/src/facebook-mcp/bin/facebook-mcp.mjs'],
      packageName: PKG,
    }),
    SOURCE_BIN_ENTRY,
  );
});

test('global install (POSIX): the bin symlink on PATH', () => {
  assert.equal(
    resolveLaunchCommand({
      env: {},
      argv: [NODE, '/opt/homebrew/bin/facebook-mcp', 'doctor'],
      packageName: PKG,
    }),
    'facebook-mcp',
  );
});

test('global install (Windows): the shim inside node_modules', () => {
  assert.equal(
    resolveLaunchCommand({
      env: {},
      argv: [
        NODE,
        'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@ivanbaev\\facebook-mcp\\bin\\facebook-mcp.mjs',
      ],
      packageName: PKG,
    }),
    'facebook-mcp',
  );
});

test('an installed build/index.js inside node_modules is not a source checkout', () => {
  assert.equal(
    resolveLaunchCommand({
      env: {},
      argv: [NODE, '/usr/lib/node_modules/@ivanbaev/facebook-mcp/build/index.js'],
      packageName: PKG,
    }),
    'facebook-mcp',
  );
});

test('unknown launch: the npx form is the safe fallback', () => {
  assert.equal(
    resolveLaunchCommand({ env: {}, argv: [NODE, '/tmp/wrapper.js'], packageName: PKG }),
    `npx -y ${PKG}`,
  );
  assert.equal(resolveLaunchCommand({ env: {}, argv: [NODE] }), DEFAULT_LAUNCH_COMMAND);
  assert.equal(
    resolveLaunchCommand({ env: {}, argv: [], packageName: '  ' }),
    DEFAULT_LAUNCH_COMMAND,
  );
});

test('the core error hints default to the same launch form as the CLI hints', () => {
  // `core` cannot import this module, so it keeps its own copy of the default;
  // this pins the two together.
  assert.equal(DEFAULT_HINT_LAUNCH_COMMAND, DEFAULT_LAUNCH_COMMAND);
});

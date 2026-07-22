#!/usr/bin/env node
// Thin launcher: boots the built ESM server entry. The real bootstrap (config
// load, transport wiring, tool registration) lives in ../build/index.js. Kept
// deliberately small — its only extra job is a friendly Node-version message.
//
// Note: an .mjs launcher is only parseable on ESM-capable Node (>=14), so this
// guard catches Node 14–21; a truly ancient runtime fails to parse the module
// before the guard can run.

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(
    `facebook-mcp requires Node.js >= 22, but this is ${process.versions.node}.\n` +
      'Use a newer runtime, e.g.: nvm install 22 && nvm use 22\n',
  );
  process.exit(1);
}

try {
  await import('../build/index.js');
} catch (err) {
  process.stderr.write((err?.stack ?? String(err)) + '\n');
  process.exit(1);
}

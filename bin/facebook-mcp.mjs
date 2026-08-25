#!/usr/bin/env node
// Thin launcher: boots the built ESM server entry. The real bootstrap (config
// load, transport wiring, tool registration) lives in ../build/index.js. Kept
// deliberately small — its only extra job is a friendly Node-version message.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(
    `facebook-mcp requires Node.js >= 22, but this is ${process.versions.node}.\n` +
      'Use a newer runtime, e.g.: nvm install 22 && nvm use 22\n',
  );
  process.exit(1);
}

let runCli;
try {
  ({ runCli } = await import('../build/index.js'));
} catch (err) {
  process.stderr.write(
    'facebook-mcp: the compiled server could not be loaded. From a source ' +
      'checkout, run `npm run build` first.\n' +
      (err?.stack ?? String(err)) +
      '\n',
  );
  process.exit(1);
}

// Importing the entry module is not enough to start it: its self-run guard
// compares process.argv[1] against its own path, and here argv[1] is *this*
// shim. Invoke the exported entry point explicitly, or the binary exits 0
// having done nothing at all.
await runCli();

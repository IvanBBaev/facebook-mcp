# Contract goldens

The wire contract of this server, pinned as JSON. The tests that read these files
are in `src/contract/`; `wire.mjs` is what they share.

| Path                      | Pins                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `tools-list.all.json`     | `tools/list` with `FB_TOOL_PACKAGES=all`                                   |
| `tools-list.default.json` | `tools/list` with the default packages                                     |
| `results/<case>.json`     | One `tools/call` answer: reads, previews, errors, refusal, CSV export      |
| `baseline-0.8.0/`         | `tools/list` of the 0.8.0 release, frozen for comparison; no test reads it |

Keys are compared sorted, because their order means nothing to a client. Array and
tool order are compared as they are. In result goldens, plan ids become `<uuid>` and
the per-run export directory becomes `<export-dir>`.

## Changing the contract

A golden diff is a contract change, so it is reviewed, not just regenerated:

```sh
npm run build
UPDATE_CONTRACT=1 npm test
git diff test/contract
```

The update is refused when `CI` is set. Nothing writes to `baseline-0.8.0/`.

## Recording a baseline

`wire.mjs` records `tools/list` from any built tree, so a baseline comes from a tag
instead of from today's code:

```sh
node test/contract/wire.mjs --build <checkout-of-tag>/build --out <dir>
```

To compare a release with the current goldens:

```sh
diff test/contract/baseline-0.8.0/tools-list.all.json test/contract/tools-list.all.json
```

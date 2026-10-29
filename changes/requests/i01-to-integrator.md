# Request: I01 → integrator (docs)

From task I01 (`src/index.ts` split into `src/server/*`; `server` and `cli`
added to the ESLint layer map). I01 owns only `src/index.ts`, `src/server/*` and
`eslint.config.js`, so it does not edit the docs that still describe the old
four-layer stack or the old entry module.

## The layer map as `eslint.config.js` now enforces it

```
core ← api ← mcp ← tools ← cli ← server
```

- `server/` (process entry, bootstrap, request handlers) is the top layer and
  may import every lower layer. Nothing below may import `server/`.
- `cli/` (operator subcommands, today `setup-token`) may import `core/`, `api/`
  and `mcp/` only — not `tools/` or `server/`. `core/`, `api/`, `mcp/` and
  `tools/` must not import `cli/`.
- One exception: `src/mcp/setup-token.ts`, the facade kept by doc 05 §1 rule 6,
  may import `cli/`. It goes away when a contract task deletes the facade and
  the `src/mcp/index.ts` re-export and points `src/server/bootstrap.ts` at
  `src/cli/setup-token/index.js` directly; the override objects in
  `eslint.config.js` are removed in the same task.

## Files to update

| File                                                                | Change                                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTRIBUTING.md` ("Architecture rule: layers point leftward only") | six-layer stack above; `cli`/`server` rules; the facade exception; enforcement is `import-x/no-restricted-paths` plus `no-restricted-imports` |
| `README.md` (feature list, "Layered architecture")                  | `core ← api ← mcp ← tools ← cli ← server`                                                                                                     |
| `docs/analysis/05-architecture.md` (entry and layering lines)       | entry is `src/index.ts` (facade) → `src/server/*`; six layers                                                                                 |
| `docs/analysis/v3/05-parallel-task-breakdown.md` §2                 | "lint (layers `core ← api ← mcp ← tools ← cli ← server`)"                                                                                     |

Reason: the lint now enforces two more layers; the contributor docs should say
so before a lane task trips over a zone it was never told about.

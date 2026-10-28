# Request: I00 → integrator

From task I00 (fragments). These files are integration-only, so I00 does not edit
them.

## 1. `package.json` — npm script for the fold

Add one line to `scripts`:

```json
"changelog:fold": "node scripts/fold-changes.mjs",
```

Usage then: `npm run changelog:fold -- --dry-run` (preview) and
`npm run changelog:fold` (write `CHANGELOG.md`, delete the folded fragments).

Reason: the release I-task folds `changes/unreleased/*.md` into `CHANGELOG.md`
(doc 05 §1 rule 8); a named script makes the step discoverable.

## 2. `package.json` — keep the annotation manifest out of the published package

Add one line to `files`, next to the other test-only exclusions:

```json
"!build/mcp/annotations",
```

Reason: `src/mcp/annotations/*.ts` are test-only data (the frozen annotation
manifest split into per-package fragments, consumed only by
`src/mcp/annotations.test.ts`). They are not `*.test.ts`, so `tsc` emits them to
`build/mcp/annotations/` and today they would ship in the npm tarball and the
`.mcpb` bundle (which reuses the `files` surface). Nothing at runtime imports
them, so this is dead weight, not a behaviour change. The same pattern already
exists for `!build/testing`, `!build/core/fakes` and
`!build/mcp/transport.spawn-fixture.*`.

## 3. `docs/runbooks/release.md` — Step 2 (write the CHANGELOG entry)

Add before "Rename the existing `## [Unreleased]` section …":

```markdown
First fold the task fragments: `npm run changelog:fold -- --dry-run` to review,
then `npm run changelog:fold` — it merges `changes/unreleased/*.md` into
`## [Unreleased]` and deletes them (see changes/unreleased/README.md).
```

## 4. Optional — CI guard

If wanted, the release gate (`.github/workflows/release.yml`) can refuse a tag while
`changes/unreleased/` still holds fragments other than `README.md`, so a release
never ships with unfolded notes.

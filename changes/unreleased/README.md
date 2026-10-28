# Unreleased change fragments

`CHANGELOG.md` is an integration-only file: parallel tasks never edit it. Each task
describes its user-visible change in its own fragment instead, and the release
I-task folds all fragments into `CHANGELOG.md` in one step. Two tasks therefore
never conflict on the changelog.

## Writing a fragment

Create `changes/unreleased/<task-id>.md` on the task branch, named after the task
id in lower case (for example `c01.md`, `l-posts.md`). It holds only
[Keep a Changelog](https://keepachangelog.com/) sections, each with one or more
bullets, written exactly as they should read in `CHANGELOG.md`:

```markdown
### Added

- **`facebook_example` lists examples.** One paragraph a user can act on.

### Fixed

- **`facebook_other` no longer drops the cursor** on the last page.
```

Rules (the fold script enforces them and refuses the whole fold otherwise):

- Allowed sections: `### Added`, `### Changed`, `### Deprecated`, `### Removed`,
  `### Fixed`, `### Security`. Each at most once per fragment, none empty.
- No other headings (`#`, `##`) and no text before the first section — it would
  be lost.
- A task with no user-visible change writes no fragment.
- Mark breaking changes with a leading `**BREAKING: …**`, as in the existing
  changelog.

## Folding at release time

The release I-task runs:

```bash
node scripts/fold-changes.mjs --dry-run   # print the merged [Unreleased] block
node scripts/fold-changes.mjs             # write CHANGELOG.md, delete fragments
```

Fragments are read in file-name order. Their bullets are merged per section, in
canonical Keep-a-Changelog order (Added, Changed, Deprecated, Removed, Fixed,
Security), into the `## [Unreleased]` block of `CHANGELOG.md`; text already in that
block is kept and comes first. The folded fragment files are deleted. The I-task
then renames `## [Unreleased]` to `## [<version>] - <date>` as described in
[docs/runbooks/release.md](../../docs/runbooks/release.md).

This README is never folded and keeps the directory in git.

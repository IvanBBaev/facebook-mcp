<!--
Thanks for contributing! Keep PRs small and focused — one concern per PR.
See CONTRIBUTING.md for the dev workflow and the layer rule.
Do NOT include security fixes for undisclosed vulnerabilities here — see SECURITY.md.
-->

## Summary

What does this PR change, and why?

## Linked issue

Closes #<!-- issue number, or "N/A" with a one-line reason -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (pre-1.0: note it here)
- [ ] Docs only
- [ ] Refactor / internal (no behavior change)
- [ ] Tests / tooling / CI

## Checklist

- [ ] `npm run check` passes locally (typecheck → lint → format:check → build → test).
- [ ] Imports respect the layer rule (`core ← api ← mcp ← tools`, leftward only;
      `tools` never imports `core/http`).
- [ ] New/changed behavior is covered by colocated `*.test.ts` tests, and no test
      hits the network (the fence stays intact; live checks live under
      `scripts/smoke/`).
- [ ] No secrets in code, logs, fixtures, or the diff; nothing bypasses the
      redaction choke-point.
- [ ] Docs updated where behavior changed (README / `docs/` / tool descriptions).
- [ ] I performed a self-review of the diff.

## Notes for reviewers

Anything reviewers should focus on, trade-offs made, or follow-ups deferred.

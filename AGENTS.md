## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `Clay-Enterprises/drop`. See `docs/agents/issue-tracker.md`.

### Triage labels

The tracker uses the five canonical mattpocock/skills triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with a root glossary and system-wide ADRs. See `docs/agents/domain.md`.

## Delivery

Completed work ships directly to `main`. Rebase onto the latest `origin/main`, push with a fast-forward update, then close the completed issue. This repository does not use pull requests.

Pushes to `main` deploy the production Worker after every required check passes. Treat CI as the normal Worker deployment path and verify its production job after pushing.

Changes under `src/cli`, `src/shared`, `install.sh`, or `install.ps1` require a new unused semantic version in `package.json`. Accepted CI builds every platform asset and creates that GitHub Release. Worker-only changes keep the current CLI version.

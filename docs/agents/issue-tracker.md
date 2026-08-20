# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues under `Clay-Enterprises/drop`. Use the `gh` CLI for all operations.

Until the local checkout has an `origin` remote, pass `--repo Clay-Enterprises/drop` explicitly.

## Conventions

- Create an issue with `gh issue create`.
- Read an issue and its comments with `gh issue view`.
- List issues with `gh issue list`.
- Comment with `gh issue comment`.
- Apply or remove labels with `gh issue edit`.
- Close an issue with `gh issue close`.
- Use multiline issue bodies rather than escaped newline strings.
- Fetch labels and comments when a skill needs the complete issue state.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill operations

When a skill says to publish to the issue tracker, create a GitHub issue.

When a skill says to fetch the relevant ticket, read the GitHub issue and its comments.

For wayfinding, use a labelled map issue, GitHub sub-issues, and native issue dependencies. If those features are unavailable, use task lists and `Blocked by: #<issue>` lines as the fallback.

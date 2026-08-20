# Domain docs

This repository uses a single-context domain layout.

## Before exploring

Read:

- `CONTEXT.md`
- ADRs under `docs/adr/` that affect the area being changed

If either location does not exist, proceed silently. Domain documentation is created lazily when terms or decisions are resolved.

## Vocabulary

Use terms exactly as defined in `CONTEXT.md`, including in issues, test names, implementation plans, and reviews. Do not substitute synonyms that the glossary explicitly avoids.

If required language is absent, reconsider whether an existing term already covers it. Record a genuine gap through the domain-modeling flow.

## ADR conflicts

Surface any proposed change that contradicts an existing ADR instead of silently overriding it.

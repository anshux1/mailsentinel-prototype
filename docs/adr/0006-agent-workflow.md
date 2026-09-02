# ADR 0006: Agent workflow

## Context

Parallel agents must not mutate the same checkout or silently overwrite platform, contract or migration changes.

## Decision

Use one branch and worktree per workstream, with `integration` as the merge point and `main` as the stable branch. Platform owns shared root configuration; contract and migration changes require review from the relevant owners.

## Alternatives considered

Multiple terminals in one directory or independent repositories were considered and rejected because they make file races and integration drift likely.

## Consequences

History stays reviewable and agents can work in parallel, but contributors must create and clean up worktrees and push small commits.

## Migration and reversal path

The workflow is operational and can be changed without a data migration. If worktrees are replaced by another isolation mechanism, preserve branch ownership, review gates and the integration branch as the merge boundary.

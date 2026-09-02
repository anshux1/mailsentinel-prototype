# ADR 0005: Turborepo monorepo

## Context

The web runtime, shared TypeScript contracts, database/auth packages and Python analyzer need coordinated changes and repeatable CI without making Python dependencies part of pnpm resolution.

## Decision

pnpm workspaces and Turborepo orchestrate the TypeScript workspaces and the analyzer's package.json bridge scripts. uv owns the analyzer environment and lockfile. Shared root tasks include contract drift, migration and environment-documentation checks.

## Alternatives considered

Separate repositories, Nx and custom shell orchestration were considered. Separate repositories weaken contract review, while a second orchestrator or shell-only workflow would add setup complexity without improving the two-runtime boundary.

## Consequences

Cross-runtime changes have one reviewable history and cacheable quality checks, while Python remains independently reproducible. Contributors must respect workspace ownership and avoid committing generated or local environment files.

## Migration and reversal path

If the runtimes split into repositories, retain the generated contract publication and explicit API versioning before extraction. If Turborepo is replaced, preserve pnpm/uv lock boundaries, non-cacheable database tasks and the integration quality gate.

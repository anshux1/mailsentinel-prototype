# Setup checklist

Track each setup unit in commit order. A checked item means its implementation and verification were pushed.

- [x] Initial repository pushed (`main`)
- [x] Monorepo workspace, pnpm, Turbo tasks, and `@mailsentinel/*` package naming
- [x] Web Next.js 16, React, Tailwind 4, validated env, TanStack Query health call
- [x] Better Auth package boundary and Drizzle database foundation
- [x] FastAPI/Pydantic settings, protected intake, OpenAPI export, Dramatiq/Redis actor
- [x] PostgreSQL, Redis, MinIO Compose services and health checks
- [x] S3 server-only client and private evidence metadata adapter
- [x] Full Better Auth PostgreSQL adapter, demo session seed, sign-in/sign-out
- [x] Tenant-scoped repositories and cross-tenant test
- [x] Complete typed oRPC procedures: health, case shell, analysis status, report placeholder
- [x] Internal analyzer contract models and deterministic generated contract artifact
- [x] Contract valid/invalid examples and CI drift gate
- [ ] Infrastructure startup/readiness/reset scripts and runbook
- [ ] Root/web/analyzer environment validation tests and secret naming checks
- [x] Vitest, pytest, Ruff, and mypy baseline configuration (ESLint/Playwright remain)
- [x] GitHub Actions install, quality, and build jobs (migration/contracts/scans remain)
- [x] Threat model and security baseline documentation
- [x] Architecture, boundaries, queue, source-of-truth, monorepo and agent-workflow ADRs
- [x] Worktree documentation and demo runbook
- [ ] Setup gate: clean install, Compose, migrate, seed, runtimes, queue, checks, builds (Docker unavailable in this environment)
- [ ] Final setup completion commit: `chore(setup): complete project foundation`

No product analysis, verdict, enrichment, scoring, dashboard or reporting logic belongs in setup.

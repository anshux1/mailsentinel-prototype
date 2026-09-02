# Agent workflow

`main` is stable and `integration` is the shared merge branch. Confirm the worktree is clean before starting. Each agent uses its own worktree and branch:

```bash
git worktree add ../ms-web -b agent/web-setup integration
git worktree add ../ms-app -b agent/app-setup integration
git worktree add ../ms-analyzer -b agent/analyzer-setup integration
git worktree add ../ms-platform -b agent/platform-setup integration
```

Do not run multiple agents in one directory. Keep commits small, run the relevant checks before pushing, and remove a worktree only after its branch is merged.

## Ownership

| Workstream | Owned paths | Responsibility |
| --- | --- | --- |
| Web | `apps/web`, `packages/ui` | Next.js, Tailwind, oRPC client and TanStack Query |
| Application backend | `packages/auth`, `packages/db`, `apps/web/src/server` | Better Auth, Drizzle, repositories and oRPC server |
| Analyzer | `apps/analyzer` | FastAPI, Pydantic, Dramatiq and internal contracts |
| Platform | root config, `infra`, `.github`, `docs` | pnpm/Turbo, Compose, CI and documentation |

Only the platform owner changes shared root configuration unless explicitly approved. Contract changes need application-backend and frontend review. Migration changes need data-owner review. Security-boundary changes need lead review.

## Setup commit sequence

Use independently reviewable commits in this order when creating the foundation:

```text
chore(repo): create monorepo workspace
chore(web): configure next tailwind and client providers
chore(app): configure auth database and orpc foundation
chore(analyzer): configure fastapi and dramatiq foundation
chore(infra): add compose postgres redis and minio
chore(ci): add repository quality checks
chore(docs): add setup and agent workflow documentation
```

The integration lead creates `chore(setup): complete project foundation` only after the setup gate passes.

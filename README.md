# MailSentinel

MailSentinel is a pnpm/Turborepo monorepo for secure email-forensics workflows. Setup intentionally contains only foundation contracts, health endpoints and safe deferred jobs—no production verdict logic.

## Requirements

Node 22, pnpm 9, Python 3.12, uv, and Docker Compose. Copy the relevant `.env.example` files; never commit `.env` files.

## Commands

```bash
pnpm install --frozen-lockfile
uv sync --locked
cd apps/analyzer && uv sync --locked && cd ../..
pnpm infra:start           # Compose health, migrations, private bucket, seed
pnpm dev                 # web: 3000; analyzer is internal
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

OpenAPI contracts are exported from FastAPI and copied deterministically with `pnpm contracts:generate`. See [`TODO.md`](TODO.md), [`docs/demo-runbook.md`](docs/demo-runbook.md), and [`docs/agent-workflow.md`](docs/agent-workflow.md).

## Workspaces

- `apps/web` — Next.js 16, React 19, Tailwind 4 and TanStack Query
- `apps/analyzer` — FastAPI, Pydantic, Dramatiq and Redis
- `packages/db` / `packages/auth` / `packages/contracts` / `packages/ui`
- `infra` — PostgreSQL, Redis and private MinIO Compose stack

# MailSentinel

MailSentinel is a pnpm/Turborepo monorepo for secure email-forensics workflows. Setup intentionally contains only foundation contracts, health endpoints and safe deferred jobs—no production verdict logic.

## Requirements

Git 2.40+, Node 22 LTS, pnpm 9, Python 3.12, uv and Docker Compose. The Node and Python dependency lockfiles are committed. Do not bypass the pinned/project versions without recording the exception.

## Local setup

```bash
pnpm install --frozen-lockfile
uv sync --locked
cd apps/analyzer && uv sync --locked && cd ../..
cp apps/web/.env.example apps/web/.env
cp apps/analyzer/.env.example apps/analyzer/.env
pnpm infra:start
pnpm dev
```

The web application runs at `http://localhost:3000`. PostgreSQL, Redis, MinIO, the private analyzer and the worker run through Compose. FastAPI is not host-published. Demo sign-in is `demo@mailsentinel.local` / `MailSentinel-Demo-2026!`.

## Quality and contracts

```bash
pnpm contracts:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @mailsentinel/web test:e2e
```

`pnpm contracts:check` exports FastAPI OpenAPI, regenerates `packages/contracts/generated`, and fails if the committed artifact drifts. See [`TODO.md`](TODO.md), [`docs/demo-runbook.md`](docs/demo-runbook.md), [`docs/threat-model.md`](docs/threat-model.md) and [`docs/agent-workflow.md`](docs/agent-workflow.md).

## Workspaces

- `apps/web` — Next.js 16, React 19, Tailwind 4, oRPC and TanStack Query
- `apps/analyzer` — FastAPI, Pydantic, Dramatiq and Redis
- `packages/db` / `packages/auth` / `packages/contracts` / `packages/ui`
- `infra` — PostgreSQL, Redis and private MinIO Compose stack

Use separate worktrees for parallel agents. Setup decisions and ownership rules are documented in [`docs/agent-workflow.md`](docs/agent-workflow.md).

# MailSentinel AI — Project Setup Plan

> This document contains only the setup work required before building the real MailSentinel AI product features.
>
> Follow this document from a clean checkout. Do not begin the main forensic parser, dashboard features, enrichment, scoring or reporting implementation until the setup acceptance gate passes.

---

## 1. Setup objective

Create a reproducible development foundation containing the complete agreed technology stack:

```text
Next.js + React + TypeScript + Tailwind CSS
Node.js + oRPC + TanStack Query
Better Auth + Drizzle ORM
PostgreSQL
FastAPI + Pydantic
Dramatiq + Redis
MinIO/S3-compatible object storage
Turborepo + pnpm monorepo
Python uv environment
Vitest + pytest + Playwright
ESLint + TypeScript + Ruff + mypy
Docker Compose
GitHub Actions CI
```

At the end of setup:

- The web application starts.
- The FastAPI analyzer starts.
- The Dramatiq worker starts.
- PostgreSQL, Redis and MinIO are healthy.
- Better Auth can create and read a demo session.
- Drizzle migrations and seed scripts work.
- oRPC has a typed health/example procedure.
- FastAPI has a protected internal health/intake contract.
- TanStack Query can call an oRPC procedure.
- TypeScript can consume the generated internal analyzer contract.
- CI can lint, type-check, test and build both runtimes.
- Agents can work in separate worktrees without modifying the same files.

---

## 2. Setup completion rule

Setup is complete only when all of the following pass from a clean checkout:

```bash
pnpm install --frozen-lockfile
uv sync --locked
pnpm db:migrate
pnpm db:seed
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The setup phase must not contain real email analysis logic. It may contain typed interfaces, placeholder adapters and health/example endpoints, but no fake production verdicts.

---

## 3. Required tools

Install and verify:

- Git 2.40 or newer.
- Node.js 22 LTS.
- Corepack or the package-manager version pinned in `package.json`.
- pnpm version pinned by `packageManager`.
- Python 3.12.
- uv.
- Docker Desktop or Docker Engine with Compose.
- An editor with TypeScript and Python support.
- Optional: mkcert for local HTTPS.

Verify versions:

```bash
git --version
node --version
pnpm --version
python3 --version
uv --version
docker --version
docker compose version
```

Do not begin implementation when the local tool versions differ from the locked/project versions without recording the exception.

---

## 4. Git and multi-agent setup

### 4.1 Initial branches

Create a stable branch and an integration branch:

```bash
git switch -c main
git switch -c integration
```

If the repository already has these branches, do not recreate them. Confirm the current status first.

### 4.2 Worktrees

Each AI agent receives a separate worktree and branch:

```bash
git worktree add ../ms-web -b agent/web-setup integration
git worktree add ../ms-app -b agent/app-setup integration
git worktree add ../ms-analyzer -b agent/analyzer-setup integration
git worktree add ../ms-platform -b agent/platform-setup integration
```

Use separate worktrees, not separate terminals pointing to the same directory.

### 4.3 Setup ownership

| Workstream | Owned paths | Setup responsibility |
|---|---|---|
| Web | `apps/web`, `packages/ui` | Next.js, Tailwind, oRPC client, TanStack Query provider |
| Application backend | `packages/auth`, `packages/db`, `apps/web/src/server` | Better Auth, Drizzle, oRPC server/context |
| Analyzer | `apps/analyzer` | FastAPI, Pydantic, Dramatiq, internal contract |
| Platform | root config, `infra`, `.github`, `docs` | pnpm/Turbo, Compose, CI, environment documentation |

Only the platform agent changes shared root configuration unless another agent has explicit approval.

### 4.4 Setup commit order

Use these commits in order:

```text
chore(repo): create monorepo workspace
chore(web): configure next tailwind and client providers
chore(app): configure auth database and orpc foundation
chore(analyzer): configure fastapi and dramatiq foundation
chore(infra): add compose postgres redis and minio
chore(ci): add repository quality checks
chore(docs): add setup and agent workflow documentation
```

Each commit should be small and independently reviewable.

---

## 5. Final repository structure

Create this structure before product implementation:

```text
mailsentinel/
├── apps/
│   ├── web/
│   │   ├── src/app/
│   │   ├── src/components/
│   │   ├── src/features/
│   │   ├── src/server/
│   │   │   ├── auth/
│   │   │   ├── orpc/
│   │   │   ├── repositories/
│   │   │   ├── storage/
│   │   │   ├── analyzer-client/
│   │   │   └── reports/
│   │   ├── package.json
│   │   └── .env.example
│   └── analyzer/
│       ├── app/
│       │   ├── api/
│       │   ├── core/
│       │   ├── contracts/
│       │   ├── parsing/
│       │   ├── authentication/
│       │   ├── extraction/
│       │   ├── enrichment/
│       │   ├── scoring/
│       │   ├── persistence/
│       │   ├── tasks/
│       │   └── main.py
│       ├── scripts/
│       ├── tests/
│       ├── pyproject.toml
│       ├── uv.lock
│       ├── package.json
│       ├── Dockerfile
│       └── .env.example
├── packages/
│   ├── auth/
│   ├── db/
│   ├── contracts/
│   ├── ui/
│   ├── fixtures/
│   ├── eslint-config/
│   └── typescript-config/
├── infra/
│   ├── compose.yaml
│   ├── minio/
│   ├── postgres/
│   └── scripts/
├── docs/
│   ├── adr/
│   ├── api/
│   ├── threat-model.md
│   ├── agent-workflow.md
│   └── demo-runbook.md
├── .github/workflows/ci.yml
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── .env.example
├── PLAN.md
└── SETUP_PLAN.md
```

Do not create additional services just to satisfy the directory structure. The prototype has two runtime applications: the Node.js application and the FastAPI analyzer/worker.

---

## 6. Root pnpm and Turborepo configuration

### 6.1 Root package

Create a private root `package.json` that:

- pins Node/pnpm expectations;
- includes Turborepo as a development dependency;
- exposes `dev`, `build`, `lint`, `typecheck`, `test`, `format`, `clean`, `db:migrate`, `db:seed` and `contracts:generate` scripts;
- uses workspace filtering rather than custom shell logic where possible.

Example scripts:

```json
{
  "private": true,
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "format": "turbo run format",
    "clean": "turbo run clean && rm -rf node_modules",
    "db:migrate": "pnpm --filter @mailsentinel/db db:migrate",
    "db:seed": "pnpm --filter @mailsentinel/db db:seed",
    "contracts:generate": "pnpm --filter @mailsentinel/analyzer contracts:export && pnpm --filter @mailsentinel/contracts generate"
  }
}
```

Use a cross-platform implementation for cleanup if Windows support is required.

### 6.2 Workspace file

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### 6.3 Turbo tasks

Configure tasks for:

- `dev`: persistent and uncached.
- `build`: cache Next.js and Python build outputs where safe.
- `lint`.
- `typecheck`.
- `test`.
- `format`.
- `contracts:generate`.
- `db:generate`.
- `db:migrate`, never cached.
- `db:seed`, never cached.

Include these in task inputs where relevant:

```text
package.json
pnpm-lock.yaml
pyproject.toml
uv.lock
migrations/**
OpenAPI source
.env.example
```

### 6.4 Python workspace bridge

Add `apps/analyzer/package.json`:

```json
{
  "name": "@mailsentinel/analyzer",
  "private": true,
  "scripts": {
    "dev": "uv run uvicorn app.main:app --reload --port 8000",
    "worker": "uv run dramatiq app.tasks.broker",
    "lint": "uv run ruff check . && uv run ruff format --check .",
    "typecheck": "uv run mypy app",
    "test": "uv run pytest",
    "format": "uv run ruff format .",
    "contracts:export": "uv run python scripts/export_openapi.py"
  }
}
```

Turborepo invokes these commands but does not manage Python packages.

**Acceptance:** root commands discover both JavaScript and Python workspaces without requiring custom manual commands.

---

## 7. Web application setup

### 7.1 Next.js

Before configuring application code, read the T3 Env documentation: https://env.t3.gg/docs/introduction.

Use `@t3-oss/env-nextjs` with Zod for the Next.js environment schema. The schema is the single validation boundary for web runtime configuration; do not read `process.env` directly throughout the application.

Configure:

- Next.js 16.
- `@t3-oss/env-nextjs` and `zod` for validated environment access.
- React 19.
- TypeScript strict mode.
- App Router.
- Server and client component boundaries.
- Server-only imports for database, storage and secrets.
- No internal service secrets in browser bundles.

Read the installed Next.js version documentation before configuring route handlers, server actions, caching or request body handling.

### 7.2 Tailwind CSS

Retain Tailwind CSS as the project styling system.

Configure:

- Tailwind CSS 4.
- Existing project design tokens.
- shadcn/base-ui conventions if already selected.
- Shared components in `packages/ui` only when reused.
- Responsive breakpoints.
- Focus-visible styles.
- Dark mode policy, if required.
- Consistent status/risk colors with text and icons, not color alone.

Do not introduce MUI, Ant Design or another complete UI library.

### 7.3 TanStack Query

Install TanStack Query v5 and the official oRPC integration matching the installed oRPC version.

Create:

- A client-side `QueryClient` provider.
- Default stale time and retry policy.
- Query key conventions.
- Error boundary behavior.
- Polling policy for active analysis.
- Query invalidation policy after mutations.

TanStack Query calls oRPC procedures. It does not call FastAPI directly.

```text
React client
  → TanStack Query
  → oRPC client
  → Next.js/Node.js procedure
  → PostgreSQL or private FastAPI client
```

### 7.4 oRPC foundation

Create:

- oRPC server context.
- Session-aware request context.
- Typed error mapping.
- Example protected `system.health` procedure.
- Example tenant-scoped `case.list` placeholder procedure.
- Client/provider setup for React.
- Server-only procedure implementation boundary.

Browser-facing application APIs use oRPC. FastAPI OpenAPI is used only for the private analyzer contract.

**Acceptance:** a signed-in browser can call a typed oRPC example procedure and receive a typed response through TanStack Query.

---

## 8. Application backend setup

### 8.1 Better Auth

Use the installed Better Auth documentation and adapter guidance.

Configure:

- Email/password for the prototype.
- PostgreSQL adapter.
- Secure HTTP-only cookies.
- Session expiry.
- Sign-in/sign-out.
- Demo seed users.
- No public signup unless explicitly required.
- Server-side session helpers.
- Safe authentication audit events.

Never hand-design Better Auth tables from memory. Generate/review the schema for the installed version.

### 8.2 Drizzle

Configure `packages/db` with:

- PostgreSQL driver.
- Drizzle schema entrypoint.
- Migration directory.
- Database client.
- Environment validation.
- `db:generate` and `db:migrate` scripts.
- Seed script.
- Test database configuration.

At setup stage, create only identity, organization and minimal case-shell tables. Feature-specific evidence tables may be added during implementation if planned contract-first.

### 8.3 Repository boundaries

Create repository interfaces for:

- organizations;
- memberships;
- cases;
- evidence metadata;
- analysis runs;
- audit records.

Repositories must accept organization context explicitly:

```ts
getCase({ organizationId, caseId })
```

Do not create unscoped `getCase(caseId)` methods for tenant-owned records.

### 8.4 Object-storage client

Configure an S3-compatible client in a server-only module.

Requirements:

- MinIO local endpoint.
- S3/R2 deployment compatibility.
- Private bucket.
- Opaque object keys.
- No public read access.
- Health check.
- Object metadata support.
- Separate environment credentials.

**Acceptance:** seed script creates organization/users and an authenticated request can safely query an empty tenant-scoped case list.

---

## 9. Analyzer setup

### 9.1 Python project

Create `apps/analyzer/pyproject.toml` with:

- FastAPI.
- Uvicorn.
- Pydantic settings (`pydantic-settings`) for typed environment validation.
- Dramatiq.
- Redis client.
- boto3 or compatible S3 client.
- psycopg/SQLAlchemy according to the persistence choice.
- pytest and pytest-asyncio.
- Ruff.
- mypy.

Use uv to generate and lock dependencies:

```bash
cd apps/analyzer
uv sync
uv lock
```

Commit `uv.lock`.

### 9.2 FastAPI application

Create:

- `/health/live` — process liveness only.
- `/health/ready` — required DB/Redis/storage readiness.
- `/v1/analyses` — protected placeholder intake endpoint.
- `/openapi.json` — deterministic contract export.
- Request ID middleware.
- Safe exception handlers.
- Internal service-token middleware.
- Pydantic request/response models.

Do not expose the analyzer publicly in local Compose unless explicitly needed for debugging.

### 9.3 Internal token

Implement:

- `Authorization: Bearer ...` validation.
- Constant-time comparison.
- Startup validation outside test mode.
- No token logging.
- Separate tokens per environment.
- Rotation documentation.

### 9.4 Dramatiq and Redis

Select and document **Dramatiq + Redis**.

Configure:

- Broker connection.
- Worker command.
- Health/readiness behavior.
- Retry policy placeholder.
- Idempotency key convention using `analysisRunId`.
- Safe error serialization.

The setup actor may only update a run to a safe placeholder/deferred state. It must not create fake final verdicts.

**Acceptance:** FastAPI accepts a valid internal request with `202`, rejects an invalid token, and the worker can consume a setup job from Redis.

---

## 10. Shared contracts

### 10.1 Browser-facing contracts

Define oRPC schemas for:

```text
system.health
case.list
case.get
case.create
analysis.getStatus
report.generate
```

Only `system.health` and case-shell procedures need implementation during setup. The remaining procedures may be typed placeholders.

### 10.2 Internal analyzer contract

Define Pydantic models for:

```text
AnalysisIntakeRequest
AnalysisIntakeAccepted
AnalysisStatus
AnalysisFailure
```

Initial request:

```json
{
  "caseId": "case_01",
  "organizationId": "org_01",
  "analysisRunId": "run_01",
  "artifact": {
    "objectKey": "organizations/org_01/cases/case_01/artifacts/artifact_01.eml",
    "sha256": "...",
    "byteSize": 24831
  },
  "requestedAt": "2026-01-01T00:00:00Z"
}
```

### 10.3 Generated client

Create a deterministic process:

1. Start FastAPI.
2. Export `openapi.json`.
3. Validate the JSON.
4. Generate TypeScript types/client into `packages/contracts/generated`.
5. Fail CI if regeneration creates a diff.

Do not manually copy FastAPI response types into TypeScript.

### 10.4 Contract review gate

Before product agents begin:

- Freeze field names and casing.
- Freeze status enums.
- Freeze machine-readable errors.
- Freeze risk/confidence representation.
- Freeze organization/case/artifact relationships.
- Add one valid and one invalid example for each contract.

**Acceptance:** a clean contract generation command produces no uncommitted changes after generation.

---

## 11. Local infrastructure with Docker Compose

### 11.1 Services

Create `infra/compose.yaml` containing:

- PostgreSQL 17.
- Redis.
- MinIO.
- MinIO bucket initialization job.
- Analyzer API.
- Dramatiq worker.
- Optional web service profile.

Use named volumes and health checks.

### 11.2 Health checks

PostgreSQL:

```text
pg_isready
```

Redis:

```text
redis-cli ping
```

MinIO:

```text
curl http://minio:9000/minio/health/live
```

FastAPI:

```text
curl http://analyzer:8000/health/live
```

### 11.3 Startup scripts

Provide scripts for:

1. Starting infrastructure.
2. Waiting for readiness.
3. Applying migrations.
4. Creating the private evidence bucket.
5. Seeding demo organization/users.
6. Loading synthetic fixtures.
7. Resetting local data.
8. Stopping infrastructure.

Commands should be documented in `README.md` and `docs/demo-runbook.md`.

### 11.4 Network rules

- FastAPI is internal to the Compose network.
- PostgreSQL, Redis and MinIO are not publicly exposed in deployment.
- Host port mappings are for local development only.
- Do not use `localhost` for container-to-container communication.
- Use `analyzer`, `postgres`, `redis` and `minio` service names internally.

**Acceptance:** one documented command starts healthy PostgreSQL, Redis, MinIO, FastAPI and worker services.

---

## 12. Environment configuration and validation

Create root, web and analyzer `.env.example` files. Never commit actual `.env` files.

### 12.1 Validation architecture

Use the T3 Env approach documented at https://env.t3.gg/docs/introduction.

- **Next.js/web:** `@t3-oss/env-nextjs` + `zod`.
- **Node.js server packages:** use `@t3-oss/env-core` only if a schema is needed outside the Next.js runtime; keep server variables server-only.
- **FastAPI/analyzer:** `pydantic-settings`, because Zod is a TypeScript library and cannot validate Python process configuration.
- **Shared conventions:** variable names, required/optional behavior, modes and secret visibility are documented once, but schemas remain per application.

Do not scatter direct `process.env.X` access through the codebase. Import validated configuration from a server-only `env` module. Do not expose the complete environment schema to client bundles.

### 12.2 Web environment

```dotenv
DATABASE_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
ANALYZER_INTERNAL_URL=http://analyzer:8000
ANALYZER_SERVICE_TOKEN=
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=mailsentinel-evidence
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=true
MAX_EML_BYTES=26214400
APP_ENV=development
WEB_DATA_MODE=live
```

Create a web schema with:

- `server`: database, Better Auth, analyzer, storage and provider secrets.
- `client`: only genuinely browser-safe values, if any.
- `runtimeEnv`: explicit mappings for the installed `@t3-oss/env-nextjs` version.
- Zod coercion/transforms only where appropriate.
- URL validation for service endpoints.
- Positive integer validation for size limits.
- Minimum-length validation for secrets.
- Literal/enumerated validation for `APP_ENV` and `WEB_DATA_MODE`.

Only variables deliberately declared in the T3 `client` schema may use `NEXT_PUBLIC_`. Never put database URLs, auth secrets, analyzer tokens, S3 credentials or provider keys in client variables.

### 12.3 Analyzer environment

```dotenv
DATABASE_URL=
REDIS_URL=redis://localhost:6379/0
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=mailsentinel-evidence
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=true
ANALYZER_SERVICE_TOKEN=
MAX_EML_BYTES=26214400
MAX_MIME_PARTS=200
MAX_HEADER_COUNT=1000
MAX_URLS=500
MAX_ATTACHMENT_BYTES=10485760
MAXMIND_DB_PATH=
ABUSEIPDB_API_KEY=
ENRICHMENT_MODE=fixture
ANALYSIS_VERSION=prototype-1
RETENTION_DAYS=90
```

Create a typed `pydantic-settings` settings class with:

- startup validation;
- URL validation;
- positive integer limits;
- minimum secret length checks;
- enum validation for `ENRICHMENT_MODE`;
- conditional validation requiring provider configuration only in `live` mode;
- fixture mode as the default local mode;
- no external provider keys required for local setup.

### 12.4 Environment modes

| Mode | Required provider configuration | Expected behavior |
|---|---|---|
| `test` | Core test settings only | Deterministic tests and fake services |
| `development` + `fixture` | Core settings only | Synthetic provider responses; no external calls |
| `development` + `offline` | Core settings and local databases where applicable | Local-only enrichment |
| `demo` + `fixture` | Core settings only | Stable presentation fallback |
| `live` | Core settings plus approved provider credentials | Bounded external enrichment |

Provider credentials must be conditionally required only when the relevant adapter is enabled. Missing live-provider configuration must fail clearly at startup rather than silently producing misleading results.

### 12.5 Validation rules

- Validate configuration at application startup.
- Fail outside test mode when required core secrets are missing.
- Fail live mode when enabled provider credentials are missing.
- Enforce minimum secret lengths.
- Never use `NEXT_PUBLIC_` for secrets.
- Log enabled environment/provider modes, never values.
- Use fixture mode by default locally.
- Do not require external provider keys for local setup.
- Keep separate `.env.example` files for root, web and analyzer.
- Keep actual environment files ignored by Git.
- Do not pass the full environment into Docker images or browser bundles.

### 12.6 Environment tests

Add tests for:

- valid development fixture configuration;
- missing core secret;
- short secret;
- invalid URL;
- invalid numeric limit;
- invalid mode;
- missing live provider credential;
- accidental `NEXT_PUBLIC_` secret naming;
- analyzer settings loading independently from web settings.

CI must verify that every variable referenced by the web/analyzer schemas is documented in the corresponding `.env.example`, while allowing documented deployment-only variables through an explicit allowlist.

---

## 13. Quality tooling

### TypeScript

Configure:

- `strict: true`.
- Shared tsconfig package.
- ESLint flat/configured rules.
- No unresolved imports.
- No accidental server-only imports in client components.
- No `any` without an explicit review comment.

### Python

Configure:

- Ruff formatting and linting.
- mypy strictness appropriate to the initial codebase.
- pytest discovery.
- Async test support.
- Import checking.
- No raw email values in test logs.

### Formatting

Use one agreed formatter configuration per language. Do not run formatting across unrelated workspaces in a feature branch.

### Pre-commit

Optional after CI is stable:

- format check;
- lint changed files;
- secret scan;
- whitespace check.

Do not make hooks so slow that agents bypass them.

---

## 14. CI configuration

Create `.github/workflows/ci.yml` with jobs for:

1. Checkout.
2. Node/pnpm setup.
3. Python/uv setup.
4. Dependency caching.
5. `pnpm install --frozen-lockfile`.
6. `uv sync --locked`.
7. Migration validation with PostgreSQL.
8. OpenAPI generation and drift check.
9. ESLint.
10. TypeScript checks.
11. Ruff format/lint.
12. mypy.
13. Vitest.
14. pytest.
15. Playwright smoke tests where infrastructure is available.
16. Next.js build.
17. Analyzer container build.
18. Dependency/container scanning where practical.

Required CI rules:

- Lockfiles must be committed.
- Generated contracts must be clean.
- No secrets in repository files.
- Main branch requires successful checks.
- CI must run on pull requests and integration changes.

**Acceptance:** CI passes from a clean checkout without developer-machine-specific paths.

---

## 15. Security baseline before product work

Create `docs/threat-model.md` covering:

- Malicious MIME structures.
- Parser resource exhaustion.
- Stored XSS.
- SSRF.
- Path traversal.
- Decompression bombs.
- Cross-tenant access.
- Public object storage.
- Provider-key leakage.
- Queue request spoofing/replay.
- Report renderer network access.
- Prompt injection if an LLM is added later.
- Raw email content in logs.

Configure baseline controls:

- Private object bucket.
- Server-only secrets.
- Internal FastAPI token.
- Tenant-scoped repositories.
- Safe error mapping.
- Request IDs.
- Redacted structured logs.
- Upload size placeholder constants.
- No direct browser-to-FastAPI access.
- No raw HTML rendering.
- No URL fetching.
- No attachment execution.

Run a basic secret scan and dependency audit before the setup gate.

---

## 16. Documentation and ADRs

Create:

```text
docs/adr/0001-final-architecture.md
docs/adr/0002-orpc-and-fastapi-boundaries.md
docs/adr/0003-dramatiq-redis.md
docs/adr/0004-source-of-truth.md
docs/adr/0005-turborepo-monorepo.md
docs/adr/0006-agent-workflow.md
docs/threat-model.md
docs/agent-workflow.md
docs/demo-runbook.md
```

Each ADR must state:

- Context.
- Decision.
- Alternatives considered.
- Consequences.
- Migration/reversal path.

Document the following decisions explicitly:

- Tailwind remains the styling system.
- oRPC is the browser-facing contract.
- FastAPI OpenAPI is only the internal analyzer contract.
- FastAPI is not directly exposed to the browser.
- PostgreSQL is canonical.
- MinIO/S3 stores evidence.
- Dramatiq + Redis is the queue.
- Neo4j, ML, LLM, sandboxing and live integrations are not setup blockers.

---

## 17. Setup test matrix

### Repository

- [ ] Fresh clone succeeds.
- [ ] pnpm install succeeds with frozen lockfile.
- [ ] uv sync succeeds with locked dependencies.
- [ ] Workspace packages are discovered.
- [ ] No ignored secrets are tracked.

### Runtime

- [ ] Next.js starts on port 3000.
- [ ] FastAPI starts on port 8000.
- [ ] Dramatiq worker starts.
- [ ] PostgreSQL is healthy.
- [ ] Redis is healthy.
- [ ] MinIO is healthy.
- [ ] Private bucket exists.

### Authentication/data

- [ ] Migration succeeds on an empty database.
- [ ] Seed creates demo organization/users.
- [ ] Sign-in creates a session.
- [ ] Sign-out invalidates the session.
- [ ] Empty case list is tenant-scoped.
- [ ] Cross-tenant test is present.

### Contracts

- [ ] oRPC health procedure works.
- [ ] TanStack Query calls the oRPC procedure.
- [ ] FastAPI OpenAPI export is deterministic.
- [ ] Generated TypeScript contract is up to date.
- [ ] Invalid analyzer token is rejected.
- [ ] Valid analyzer request returns `202`.

### Quality

- [ ] ESLint passes.
- [ ] TypeScript passes.
- [ ] Ruff passes.
- [ ] mypy passes.
- [ ] Vitest passes.
- [ ] pytest passes.
- [ ] Build passes.
- [ ] CI passes.

---

## 18. Setup gate and handoff

The setup phase is accepted only after the lead/integration agent verifies:

```text
clean clone
→ install dependencies
→ start Compose
→ migrate database
→ seed demo users
→ start web/analyzer/worker
→ sign in
→ call typed oRPC health procedure
→ call protected FastAPI intake placeholder
→ consume a Redis setup job
→ run all quality checks
→ build containers
```

The lead then creates a setup completion commit:

```text
chore(setup): complete project foundation
```

After that commit:

- Feature agents may begin the main `PLAN.md` phases.
- Setup configuration changes require review from the platform owner.
- Contract changes require both application-backend and frontend review.
- Database migration changes require data-owner review.
- Security-boundary changes require lead review.

Do not mark the product implementation complete merely because this setup gate passes. It only means the foundation is ready.

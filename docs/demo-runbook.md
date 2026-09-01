# Local demo runbook

## Requirements

Git 2.40+, Node 22 LTS, pnpm 9, Python 3.12 through uv, and Docker Compose. Analyzer commands use the locked uv Python 3.12 environment.

## First start

```bash
pnpm install --frozen-lockfile
uv sync --locked
cd apps/analyzer && uv sync --locked && cd ../..
cp apps/web/.env.example apps/web/.env
cp apps/analyzer/.env.example apps/analyzer/.env
pnpm infra:start
pnpm dev
```

`infra:start` builds and waits for PostgreSQL, Redis, private MinIO, FastAPI and the Dramatiq worker, then migrates and seeds the demo identity. Web runs at `http://localhost:3000`. MinIO console is local-only at `http://localhost:9001`. FastAPI is intentionally not host-published.

Demo credentials default to:

```text
demo@mailsentinel.local
MailSentinel-Demo-2026!
```

Override `DEMO_USER_EMAIL` and `DEMO_USER_PASSWORD` when seeding outside disposable local development. Never commit either `.env` file.

## Verification

```bash
pnpm contracts:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @mailsentinel/web test:e2e
```

Sign in through the web UI, confirm the session indicator, and confirm the tenant-scoped case list returns an empty list. The browser health indicator is served through the typed oRPC procedure.

From the Compose network, the private analyzer can be checked without exposing its port:

```bash
docker compose -f infra/compose.yaml exec analyzer python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health/live').read().decode())"
```

The protected intake contract accepts only a valid Bearer token. Use the local token from `infra/compose.yaml` only for disposable local checks; never send it from browser code or log it. The worker is considered ready when `docker compose -f infra/compose.yaml ps` shows it running and the analyzer test suite confirms setup jobs use `analysisRunId` as their queue key.

## Operations

```bash
pnpm infra:wait               # wait and display health
./infra/scripts/migrate.sh    # migrations only
./infra/scripts/bucket.sh     # idempotent private bucket initialization
./infra/scripts/seed.sh       # idempotent organization/user seed
./infra/scripts/fixtures.sh   # validate synthetic setup fixtures
pnpm infra:reset              # destructive local volume reset and reseed
pnpm infra:stop               # retain local volumes
```

Token rotation: update the secret manager or local Compose environment for both web and analyzer/worker, restart all runtimes together, and invalidate the previous token. Never log either token.

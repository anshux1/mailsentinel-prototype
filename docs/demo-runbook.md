# Local demo runbook

## Requirements

Git 2.40+, Node 22 LTS, pnpm 9, Python 3.12 through uv, and Docker Compose. This machine may run a newer shell Python; analyzer commands always use the locked uv Python 3.12 environment.

## First start

```bash
pnpm install --frozen-lockfile
uv sync --locked
cd apps/analyzer && uv sync --locked && cd ../..
pnpm infra:start
pnpm dev
```

`infra:start` builds and waits for PostgreSQL, Redis, private MinIO, FastAPI and the Dramatiq worker, then migrates and seeds the demo identity. Web runs at `http://localhost:3000`. MinIO console is local-only at `http://localhost:9001`. FastAPI is intentionally not host-published.

Demo credentials default to:

```text
demo@mailsentinel.local
MailSentinel-Demo-2026!
```

Override `DEMO_USER_EMAIL` and `DEMO_USER_PASSWORD` when seeding outside disposable local development.

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

## Internal analyzer check

Run from the Compose network; the service token is never sent to a browser:

```bash
docker compose -f infra/compose.yaml exec analyzer python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health/live').read().decode())"
```

Token rotation: update the secret manager or local Compose environment for both web and analyzer/worker, restart all runtimes together, and invalidate the previous token. Never log either token.

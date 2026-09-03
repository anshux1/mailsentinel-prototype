# MailSentinel deployment guide

Everything required to run MailSentinel outside a developer laptop: the process
topology, the complete environment for each service, the values that must match
across services, what refuses to boot and why, and the gaps you must close before
exposing this to a network.

This describes the repository as it stands. Where something needed for deployment
does not exist yet, it is called out explicitly rather than glossed over.

---

## 1. Topology

MailSentinel is **four processes** in front of **three backing services**.

| # | Process | Runtime | Port | Exposure |
| --- | --- | --- | --- | --- |
| 1 | `web` — Next.js application server | Node 22 | 3000 | **Public** (behind TLS) |
| 2 | `analyzer` — FastAPI intake and status API | Python 3.12 | 8000 | **Private only** |
| 3 | `worker` — Dramatiq analysis consumer | Python 3.12 | — | Private, no listener |
| 4 | `migrate` — one-shot schema job | Node 22 | — | Run before `web` starts |

| Backing service | Version used | Purpose |
| --- | --- | --- |
| PostgreSQL | 17 | Identity, tenancy, cases, evidence metadata, runs, reports, audit |
| Redis | 7 | Dramatiq broker and the enrichment indicator cache |
| S3-compatible object storage | MinIO (or AWS S3) | Immutable evidence and report objects |

### Trust boundary

```text
browser ──TLS──> web (:3000) ──private──> analyzer (:8000)
                   │                          │
                   ├──> PostgreSQL            ├──> PostgreSQL
                   └──> S3 (private bucket)   ├──> S3 (read-only)
                                              └──> Redis ──> worker
```

**The analyzer must never be reachable from the internet.** It is protected by a
bearer token, but its threat model assumes a private network. The browser talks
to exactly one endpoint — `/api/rpc` on the web process — and never to the
analyzer, Redis, or object storage.

---

## 2. What exists, and what you must add

### Already in the repository

- `apps/analyzer/Dockerfile` — uv on Python 3.12 slim, runs uvicorn.
- `apps/web/Dockerfile` — multi-stage Node 22 build with standalone output, migrator target, and unprivileged runner.
- `apps/web/next.config.ts` — configured with `output: "standalone"` for lean container builds.
- `infra/compose.yaml` — complete local stack running web, analyzer, worker, PostgreSQL, Redis, MinIO, bucket initialization, migrations, and optional Cloudflare Tunnel.
- `infra/scripts/` — `start.sh`, `stop.sh`, `wait.sh`, `reset.sh`, `migrate.sh`, `seed.sh`, `bucket.sh`, `fixtures.sh`.
- `docs/LOCAL_DOCKER_INTERNET.md` — complete guide for local Docker Compose and Cloudflare Tunnel internet exposure.
- CI (`.github/workflows/ci.yml`) that builds and Trivy-scans the analyzer image and runs a Compose smoke test of the private stack.

### Production hardening gaps to consider for cloud deployments

| Area | Why it matters |
| --- | --- |
| **External TLS & reverse proxy** | In production, `BETTER_AUTH_URL` must be `https://`; session cookies require it. Cloudflare Tunnel or a reverse proxy (Caddy/Nginx) handles TLS termination. |
| **Platform secret management** | Inject secrets via platform environment variables or KMS rather than static files. |
| **Backup and restore procedure** | PostgreSQL holds the case record; object storage holds the evidence. Losing either breaks chain of custody. |

---

## 3. Runtime requirements

| Requirement | Value | Enforced by |
| --- | --- | --- |
| Node.js | `>=22 <23` | `package.json` `engines` |
| pnpm | 9.0.0 | `packageManager` field |
| Python | `>=3.12` | `pyproject.toml`, `.python-version` |
| uv | 0.6.14+ | analyzer Dockerfile base image |
| PostgreSQL | 17 (16 should work; untested) | `infra/compose.yaml` |
| Redis | 7 | `infra/compose.yaml` |

Node 24 *runs* but emits an unsupported-engine warning on every command. Match CI
and use Node 22.

---

## 4. Environment

There are **three separate environment sets**. They overlap but are validated by
different schemas, and neither service starts if its own validation fails.

`pnpm env:check` enforces that every variable referenced in code is documented in
the matching `.env.example` — add new variables to both or the gate fails.

### 4.1 Generate the secrets first

```bash
openssl rand -base64 48   # BETTER_AUTH_SECRET      (needs >= 32 chars)
openssl rand -hex 32      # ANALYZER_SERVICE_TOKEN  (needs >= 16 chars)
openssl rand -base64 32   # S3_SECRET_ACCESS_KEY    (needs >= 16 chars)
openssl rand -base64 32   # PostgreSQL password
```

### 4.2 `web` — Next.js application server

Validated by `apps/web/src/env.ts` at module load. An invalid value stops the
process at boot rather than failing later.

```dotenv
# --- Required, no defaults ---------------------------------------------------
DATABASE_URL=postgresql://mailsentinel:CHANGE_ME@postgres:5432/mailsentinel
BETTER_AUTH_SECRET=<openssl rand -base64 48>          # secret, min 32 chars
ANALYZER_SERVICE_TOKEN=<openssl rand -hex 32>         # secret, min 16 chars
S3_ACCESS_KEY_ID=mailsentinel                         # secret
S3_SECRET_ACCESS_KEY=<openssl rand -base64 32>        # secret, min 16 chars

# --- Required in production, have dev defaults -------------------------------
BETTER_AUTH_URL=https://mailsentinel.example.com      # MUST be the public https origin
ANALYZER_INTERNAL_URL=http://analyzer:8000            # private network address
S3_ENDPOINT=http://minio:9000                         # omit scheme mismatch; must be a URL

# --- Optional, defaults shown ------------------------------------------------
S3_REGION=us-east-1
S3_BUCKET=mailsentinel-evidence
S3_FORCE_PATH_STYLE=true                              # true for MinIO, false for AWS S3
MAX_EML_BYTES=26214400
APP_ENV=production                                    # development | test | demo | production
WEB_DATA_MODE=live                                    # live | fixture | offline
```

Notes:

- `APP_ENV` is consumed in `src/server/db/index.ts` — setting it to anything other
  than `development` disables the global database-client caching intended for hot
  reload. Set it to `production`.
- `WEB_DATA_MODE` is validated but currently has **no runtime consumer**. It is a
  reserved flag; set it to `live` for clarity.
- `NODE_ENV` is set by Next itself. Do not set it manually — `NODE_ENV=production`
  in the shell will break `vitest` and `pnpm install --dev`.

### 4.3 `analyzer` and `worker`

Both processes share one environment. Validated by
`apps/analyzer/app/core/settings.py` (Pydantic Settings, `env_ignore_empty=True`
— an empty string counts as unset, not as an empty value).

```dotenv
# --- Required ----------------------------------------------------------------
DATABASE_URL=postgresql://mailsentinel:CHANGE_ME@postgres:5432/mailsentinel
ANALYZER_SERVICE_TOKEN=<same value as the web process>   # secret, min 16 chars
S3_ACCESS_KEY_ID=mailsentinel                            # secret, min 1 char
S3_SECRET_ACCESS_KEY=<same value as the web process>     # secret, min 16 chars

# --- Infrastructure ----------------------------------------------------------
APP_ENV=production
REDIS_URL=redis://redis:6379/0
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=mailsentinel-evidence
S3_FORCE_PATH_STYLE=true

# --- Resource limits (all hard-capped by the schema) -------------------------
MAX_EML_BYTES=26214400          # <= 50000000
MAX_MIME_PARTS=200              # <= 200
MAX_MIME_DEPTH=30               # <= 100
MAX_HEADER_COUNT=1000           # <= 1000
MAX_URLS=500                    # <= 1000 (contract indicator limit)
MAX_ATTACHMENT_BYTES=10485760   # <= 50000000
EXECUTION_TIMEOUT_SECONDS=120   # 0 < x <= 3600

# --- Enrichment --------------------------------------------------------------
ENRICHMENT_MODE=offline                 # fixture | offline | live
ENRICHMENT_MAX_REQUESTS=10              # 0..1000
ENRICHMENT_CACHE_TTL_SECONDS=86400
ENRICHMENT_LIVE_CACHE_TTL_SECONDS=3600
ENRICHMENT_CONNECT_TIMEOUT_SECONDS=2    # 0 < x <= 2, hard ceiling
ENRICHMENT_READ_TIMEOUT_SECONDS=3       # 0 < x <= 3, hard ceiling
MAXMIND_DB_PATH=/data/GeoLite2-ASN.mmdb # required for meaningful offline mode
OFFLINE_REPUTATION_PATH=
ABUSEIPDB_API_KEY=                      # REQUIRED if ENRICHMENT_MODE=live

# --- Operational -------------------------------------------------------------
ANALYSIS_VERSION=prototype-1
RETENTION_DAYS=90                       # <= 3650
```

**Choose your enrichment mode deliberately:**

| Mode | Behaviour | Use when |
| --- | --- | --- |
| `fixture` | Deterministic canned data | CI and demos |
| `offline` | Local MaxMind / file-backed lookups, **zero network** | Air-gapped deployments — the default posture |
| `live` | Adds AbuseIPDB lookups over the internet | You accept outbound calls and have a key |

`ENRICHMENT_MODE=live` without `ABUSEIPDB_API_KEY` **fails validation at boot** —
a model validator enforces it. Analysis never fails because enrichment is
unavailable; it degrades to partial enrichment with reduced confidence.

### 4.4 Backing services

```dotenv
# PostgreSQL
POSTGRES_USER=mailsentinel
POSTGRES_PASSWORD=<openssl rand -base64 32>
POSTGRES_DB=mailsentinel

# MinIO (skip if using AWS S3)
MINIO_ROOT_USER=<same as S3_ACCESS_KEY_ID>
MINIO_ROOT_PASSWORD=<same as S3_SECRET_ACCESS_KEY>
```

---

## 5. Values that must match — the common failure

Four values appear in more than one place. A mismatch produces a confusing
runtime failure rather than a clear startup error, so verify these first when
something misbehaves.

| Value | Must be identical in | Symptom when mismatched |
| --- | --- | --- |
| `ANALYZER_SERVICE_TOKEN` | `web`, `analyzer`, `worker` | `analysis.start` fails with `BAD_GATEWAY`; the analyzer logs a 401 |
| `S3_ACCESS_KEY_ID` | `web`, `analyzer`, MinIO root user | Evidence upload fails at the storage write; the row is marked `failed` |
| `S3_SECRET_ACCESS_KEY` | `web`, `analyzer`, MinIO root password | Same as above |
| `S3_BUCKET` | `web`, `analyzer`, the bucket actually created | Uploads succeed, analysis cannot read the object |
| `DATABASE_URL` | `web`, `analyzer`, `worker`, migration job | Runs stay `queued` forever — the worker writes to a different database |

---

## 6. What refuses to boot, and why

Both services validate configuration at startup. This is deliberate: a
misconfigured deployment fails immediately and loudly rather than leaking or
silently degrading.

| Condition | Result |
| --- | --- |
| `BETTER_AUTH_SECRET` shorter than 32 characters | `web` exits — invalid environment variables |
| `ANALYZER_SERVICE_TOKEN` shorter than 16 characters | Both `web` and `analyzer` exit |
| `S3_SECRET_ACCESS_KEY` shorter than 16 characters | Both exit |
| `DATABASE_URL` not a valid Postgres DSN | Both exit |
| Any `NEXT_PUBLIC_*` variable whose name matches `SECRET\|TOKEN\|PASSWORD\|DATABASE\|ACCESS_KEY\|API_KEY\|PRIVATE\|CREDENTIAL` | `web` throws at import — a guard against leaking secrets into the client bundle |
| `MAX_MIME_PARTS > 200`, `MAX_HEADER_COUNT > 1000`, `MAX_URLS > 1000`, `MAX_EML_BYTES > 50000000` | `analyzer` exits — limits are capped by schema, not merely suggested |
| `ENRICHMENT_MODE=live` with no `ABUSEIPDB_API_KEY` | `analyzer` exits |

---

## 7. Deployment sequence

Depending on whether you are running a complete containerized stack (via Docker Compose) or deploying processes individually across container / server environments:

### 7.1 Containerized Compose Deployment (Recommended)

Docker Compose manages boot ordering, bucket initialization, migrations, and seeding automatically:

```bash
# Start all services (postgres, redis, minio, minio-init, migrate, analyzer, worker, web) and seed:
pnpm infra:start

# Or using docker compose commands directly:
docker compose -f infra/compose.yaml up -d --build --wait postgres redis minio analyzer worker web
docker compose -f infra/compose.yaml run --rm seed
```

### 7.2 Manual / Multi-Host Deployment Sequence

When running the Next.js web application directly on a Node 22 host or separate platform while backing services and analyzer run in containers:

```bash
# 1. Bring up backing services and wait for health
docker compose -f infra/compose.yaml up -d --wait postgres redis minio

# 2. Create the private evidence bucket (idempotent)
./infra/scripts/bucket.sh

# 3. Apply migrations — REQUIRED before web starts
pnpm db:migrate

# 4. Seed the first organization and owner account
pnpm db:seed

# 5. Start the private analysis stack
docker compose -f infra/compose.yaml up -d --wait analyzer worker

# 6. Build and start the host web application server
pnpm build
pnpm --filter @mailsentinel/web start
```

`pnpm db:seed` creates `demo@mailsentinel.local` with a default password. **Change
or remove that account before exposing the deployment** — it is a development
convenience, not an onboarding flow.

### Verifying a deployment

```bash
curl -fsS https://<host>/api/rpc/system/health          # public health
curl -fsS http://analyzer:8000/health/ready             # private, from inside the network
```

Then, through the UI: sign in, create a case, upload an `.eml`, confirm the
evidence reaches `verified`, dispatch an analysis, and confirm the run reaches
`completed`. A run stuck at `queued` means the worker cannot reach Redis or is
pointed at a different database.

---

## 8. Hardening required before exposure

The Compose file is a local harness. Before this faces a network:

1. **Replace every credential.** `infra/compose.yaml` contains
   `mailsentinel-local-secret` and `local-development-token-change-me` in plain
   text. Move them to a secret store and inject at runtime.
2. **Terminate TLS** in front of `web` and set `BETTER_AUTH_URL` to the `https://`
   origin. Session cookies depend on this being correct.
3. **Keep the analyzer private.** No ingress, no public port. Its bearer token is
   a second layer, not the first.
4. **Keep the bucket private.** `bucket.sh` sets `mc anonymous set none`; verify
   it, and never enable public read. Object keys are deliberately never returned
   to the browser.
5. **Restrict database access** to the three processes that need it.
6. **Set `APP_ENV=production`** on `web` and `analyzer` — it disables development
   caching and test-only code paths.
7. **Back up both stores.** PostgreSQL holds the case record and audit trail;
   object storage holds the evidence. A backup of one without the other cannot
   reconstruct a case.
8. **Ship the structured logs.** Both services emit one JSON object per line with
   `requestId`, `organizationId`, and resource ids, already redacted of bodies,
   keys, and credentials — safe to forward to any collector as-is.

---

## 9. Sizing

Prototype scale, for a single-node deployment:

| Component | CPU | Memory | Disk |
| --- | --- | --- | --- |
| `web` | 0.5 vCPU | 512 MB | — |
| `analyzer` | 0.5 vCPU | 512 MB | — |
| `worker` | 1 vCPU | 1 GB | — |
| PostgreSQL | 1 vCPU | 1 GB | 20 GB + growth |
| Redis | 0.25 vCPU | 256 MB | — |
| MinIO | 0.5 vCPU | 512 MB | Evidence volume × 2 |

**Total: roughly 4 vCPU / 4 GB** for a small deployment.

Memory is driven by `MAX_EML_BYTES` (26 MiB default): the web process holds the
decoded upload in memory during `completeUpload`, and the worker holds the message
while parsing. Concurrent large uploads are the thing that will move these
numbers — size the worker for peak concurrency × `MAX_EML_BYTES`.

Object storage should be sized at roughly twice the raw evidence volume: every
message is stored once, and each generated report is stored as its own immutable
versioned object.

---

## 10. Quick reference

| Task | Command |
| --- | --- |
| Start full Compose stack (with web) | `pnpm infra:start` |
| Start backing & analyzer services only | `docker compose -f infra/compose.yaml up -d --wait postgres redis minio analyzer worker` |
| Wait for health | `pnpm infra:wait` |
| Reset all local state | `pnpm infra:reset` |
| Stop everything | `pnpm infra:stop` |
| Apply migrations | `pnpm db:migrate` |
| Seed demo tenant | `pnpm db:seed` |
| Verify env documentation | `pnpm env:check` |
| Verify contract sync | `pnpm contracts:check` |
| Full verification gate | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` |

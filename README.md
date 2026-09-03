# MailSentinel

MailSentinel is a secure, high-assurance email forensics and threat-investigation platform. It combines a modern Next.js web application, a private Python FastAPI parsing/segmentation engine, an asynchronous Dramatiq worker queue, PostgreSQL persistence, Redis caching/broker, and S3-compatible evidence storage.

---

## Architecture

MailSentinel operates four application processes and three backing services within a strictly isolated trust boundary:

| Component | Technology | Role | Network Access |
|---|---|---|---|
| `web` | Next.js 16, React 19, Node.js 22 | User interface, Better Auth, oRPC API, evidence uploads, Gmail OAuth | **Public** (port 3000 / HTTPS) |
| `analyzer` | FastAPI, Python 3.12 | RFC 822 MIME parsing, container segmentation, indicator extraction | **Private** (`analyzer:8000`) |
| `worker` | Dramatiq, Python 3.12 | Background task worker consuming analysis jobs from Redis | **Private** (no listener) |
| `migrate` | Drizzle Kit, Node.js 22 | One-shot database schema migration runner | **Private** (exits on completion) |
| `postgres` | PostgreSQL 17 | Users, organizations, cases, runs, findings, audit events | **Private** (`postgres:5432`) |
| `redis` | Redis 7 | Dramatiq job broker and indicator enrichment cache | **Private** (`redis:6379`) |
| `minio` | MinIO | S3-compatible raw `.eml` and report object storage | **Private** (`minio:9000`) |

### Trust Boundary

```text
               Public Internet (Browser / Google OAuth)
                                  │
                       Cloudflare Tunnel / TLS
                                  │
                                  ▼
┌────────────────── Docker Bridge Network: mailsentinel ──────────────────┐
│                                                                        │
│   cloudflare-tunnel ───► web:3000 (Next.js server-side)                │
│                              │         │          │                    │
│             ┌────────────────┘         │          └──────────────┐     │
│             ▼                          ▼                         ▼     │
│       postgres:5432               minio:9000               analyzer:8000
│             ▲                          ▲                         ▲     │
│             │                          │                         │     │
│             │                          └──────────┐              │     │
│             │                                     │              │     │
│        worker (Dramatiq) ◄─── redis:6379 ─────────┴──────────────┘     │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

The browser communicates exclusively with `web:3000` via authenticated session cookies and typed oRPC procedures. Backend storage, Redis, database, and analyzer services remain completely isolated from public exposure.

---

## Quickstart with Docker Compose

To launch the complete MailSentinel stack locally in under two minutes:

### 1. Start the Stack

Using the repository helper script:
```bash
pnpm infra:start
```

Or using Docker Compose directly:
```bash
docker compose -f infra/compose.yaml up -d --build
docker compose -f infra/compose.yaml run --rm seed
```

Compose automatically initializes the MinIO evidence bucket, runs PostgreSQL migrations, boots the analyzer and worker, and launches the Next.js web application.

### 2. Access the Application

- **Web Application:** <http://localhost:3000>
- **Initial Seed Credentials:**
  - **Email:** `demo@mailsentinel.local`
  - **Password:** `MailSentinel-Demo-2026!`
- **MinIO Console:** <http://localhost:9001> (User: `mailsentinel`, Password: `mailsentinel-local-secret`)

### 3. Check Status & Logs

```bash
# View running container status
docker compose -f infra/compose.yaml ps

# Stream logs
docker compose -f infra/compose.yaml logs -f web
docker compose -f infra/compose.yaml logs -f analyzer worker
```

### 4. Stop or Reset

```bash
# Stop containers while preserving persistent database & storage volumes
pnpm infra:stop
# or: docker compose -f infra/compose.yaml down

# Destructive reset (wipes database and evidence volumes)
pnpm infra:reset
# or: docker compose -f infra/compose.yaml down --volumes --remove-orphans
```

---

## Exposing to the Internet

You can securely expose your local MailSentinel instance to the internet using **Cloudflare Tunnel** without port forwarding or exposing private backend ports:

- **Quick Ephemeral Tunnel:**
  ```bash
  docker compose -f infra/compose.yaml run --rm cloudflare-tunnel tunnel --url http://web:3000
  ```
- **Stable Named Tunnel (with custom domain & Google OAuth):**
  Add your `CLOUDFLARE_TUNNEL_TOKEN` to `.env` and start with the tunnel profile:
  ```bash
  docker compose -f infra/compose.yaml --profile cloudflare-tunnel up -d
  # (or shorthand: docker compose -f infra/compose.yaml --profile tunnel up -d)
  ```

For a comprehensive guide covering secret generation, environment configuration, Google/Gmail OAuth redirect URLs, and security checklists, see:
👉 **[`docs/LOCAL_DOCKER_INTERNET.md`](docs/LOCAL_DOCKER_INTERNET.md)**

---

## Local Development (Without Full Docker Stack)

If you are actively developing frontend or Python code and prefer running services directly on your host machine:

### Prerequisites

- Node.js `>=22 <23`
- `pnpm@9.0.0`
- Python 3.12 with `uv`
- Docker (for PostgreSQL, Redis, and MinIO backing services)

### Setup

1. Install dependencies:
   ```bash
   pnpm install --frozen-lockfile
   cd apps/analyzer && uv sync --locked && cd ../..
   ```
2. Start backing services and private analyzer stack:
   ```bash
   docker compose -f infra/compose.yaml up -d --wait postgres redis minio analyzer worker
   pnpm db:migrate
   pnpm db:seed
   ```
   *(Note: Do not run `pnpm infra:start` when running the host web dev server, as the containerized web service will occupy port 3000. If the full stack is already running, stop the web container first with `docker compose -f infra/compose.yaml stop web`.)*
3. Start the Next.js development server on your host:
   ```bash
   pnpm --filter @mailsentinel/web dev
   ```

---

## Repository Commands

| Command | Description |
|---|---|
| `pnpm infra:start` | Boot all Docker Compose services (including web), apply migrations, and seed demo user |
| `pnpm infra:wait` | Wait for all services (including web) to pass health checks |
| `pnpm infra:stop` | Stop Docker Compose services (preserves named volumes) |
| `pnpm infra:reset` | Destructive volume wipe and clean stack restart |
| `pnpm dev` | Run development servers on host (ensure containerized web is stopped) |
| `pnpm build` | Turbo build all packages and applications |
| `pnpm test` | Run test suites across the monorepo |
| `pnpm lint` | Run Biome and ESLint linters |
| `pnpm typecheck` | Run TypeScript type checking across all workspaces |
| `pnpm env:check` | Validate environment documentation coverage against schemas |
| `pnpm db:migrate` | Apply pending Drizzle migrations |
| `pnpm db:seed` | Seed the database with the initial demo account and organization |

---

## Documentation

- [`SIH_README.md`](SIH_README.md) — Detailed SIH judge Q&A, three-minute pitch, impact, feasibility, testing, limitations, and demo script.
- [`docs/LOCAL_DOCKER_INTERNET.md`](docs/LOCAL_DOCKER_INTERNET.md) — Comprehensive guide for local Docker Compose and Cloudflare Tunnel internet exposure.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Production architecture, topologies, and infrastructure notes.
- [`docs/threat-model.md`](docs/threat-model.md) — Security boundaries, authorization model, and threat considerations.
- [`docs/demo-runbook.md`](docs/demo-runbook.md) — Step-by-step walkthrough for investigation and analysis demos.
- [`CODEBASE_AUDIT.md`](CODEBASE_AUDIT.md) — Technical architecture review and verification status.

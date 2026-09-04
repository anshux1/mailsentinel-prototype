# Local Docker & Internet Access Guide

This guide details how to run the complete MailSentinel email forensics stack locally using Docker Compose, how each service communicates, and how to expose the web interface securely to the public internet using Cloudflare Tunnel.

---

## 1. Architecture & Process Topology

MailSentinel runs four application services and four support/backing services in a private Docker bridge network:

| Service | Container / Image | Purpose | Internal Address | Host Port | Publicly Exposed |
|---|---|---|---|---|---|
| `web` | Built from `apps/web/Dockerfile` (Node 22) | UI, authentication, oRPC API, evidence uploads, Gmail OAuth | `web:3000` | `127.0.0.1:3000` (loopback default) | **Yes** (via TLS tunnel / proxy) |
| `analyzer` | Built from `apps/analyzer/Dockerfile` (Python 3.12) | MIME parsing, segmentation, IOC enrichment | `analyzer:8000` | Docker internal only | **No** (private boundary) |
| `worker` | Same analyzer image (Python 3.12) | Dramatiq queue consumer for async analysis | No listener | None | **No** |
| `migrate` | Monorepo image target `migrator` | One-shot Drizzle schema migration container | Exits 0 | None | **No** |
| `seed` | Monorepo image target `migrator` | One-shot demo user/org seed container (runs automatically before `web`) | Exits 0 | None | **No** |
| `postgres` | `postgres:17-alpine` | Relational store for users, cases, runs, and reports | `postgres:5432` | `127.0.0.1:5432` | **No** |
| `redis` | `redis:7-alpine` | Dramatiq message broker and enrichment cache | `redis:6379` | `127.0.0.1:6379` | **No** |
| `minio` | `minio/minio:RELEASE.2025-07-18T21-56-31Z` | S3-compatible raw evidence storage | `minio:9000` | `127.0.0.1:9000` (API), `:9001` (Console) | **No** |
| `minio-init` | `minio/mc:RELEASE.2025-07-21T05-28-08Z` | One-shot bucket creator and privatizer | Exits 0 | None | **No** |
| `cloudflare-tunnel` | `cloudflare/cloudflared:2025.2.1` (profile `tunnel`) | Secure outbound TLS tunnel to the internet | Connects to `web:3000` | None | **Tunnel outbound** |

### Trust Boundary Diagram

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

> [!IMPORTANT]
> **Strict Trust Boundary:** The browser only ever interacts with `web` on port 3000 (or via HTTPS tunnel). Never expose ports 8000 (analyzer), 5432 (Postgres), 6379 (Redis), or 9000/9001 (MinIO) to the public internet.

---

## 2. Prerequisites

1. **Docker & Docker Compose**:
   - Docker Engine 24.0+ or Docker Desktop / OrbStack.
   - Verify: `docker compose version` (Compose v2).
2. **System Resources**:
   - At least 4 GB RAM allocated to Docker.
   - At least 10 GB free disk space for images and persistent volumes.
3. **Optional (Host Development)**:
   - Node.js `>=22 <23` and `pnpm@9.0.0` if you plan to run tests or migrations directly on your host machine.
   - `cloudflared` CLI installed locally if running a host-side tunnel instead of the Docker container.

---

## 3. Secret Generation

Before deploying or exposing to the internet, generate unique cryptographically strong secrets. Run the following commands in your terminal:

```bash
# Session signing secret for Better Auth (minimum 32 characters)
openssl rand -base64 48

# Internal service token shared between web and analyzer (minimum 16 characters)
openssl rand -hex 32

# AES-256-GCM encryption key for Gmail refresh tokens and OAuth state (exactly/min 32 bytes)
openssl rand -hex 32

# Strong password for PostgreSQL
openssl rand -base64 24

# Strong secret key for MinIO / S3
openssl rand -base64 32
```

---

## 4. Environment Configuration

Docker Compose reads variable overrides from a `.env` file at the repository root or shell environment variables. Compose provides safe local defaults so the stack runs out-of-the-box in development, but you should configure custom secrets for shared or internet-accessible instances.

Create `.env` at the root of the repository:

```dotenv
# Application Environment
APP_ENV=development
WEB_DATA_MODE=fixture

# Authentication & Origins
BETTER_AUTH_SECRET=REPLACE_WITH_GENERATED_48_CHAR_SECRET
BETTER_AUTH_URL=http://localhost:3000

# Web Published Port & Loopback Binding
# Kept loopback (127.0.0.1) so internet access occurs exclusively via Cloudflare Tunnel
WEB_BIND=127.0.0.1
WEB_PORT=3000

# Inter-service Authentication
ANALYZER_SERVICE_TOKEN=REPLACE_WITH_GENERATED_32_HEX_TOKEN

# Database Credentials
POSTGRES_USER=mailsentinel
POSTGRES_PASSWORD=REPLACE_WITH_GENERATED_DB_PASSWORD
POSTGRES_DB=mailsentinel

# S3 / MinIO Object Storage
S3_BUCKET=mailsentinel-evidence
S3_ACCESS_KEY_ID=mailsentinel
S3_SECRET_ACCESS_KEY=REPLACE_WITH_GENERATED_S3_SECRET

# Optional Mailbox Connector (Gmail OAuth)
MAILBOX_CONNECTORS_ENABLED=false
MAILBOX_TOKEN_ENCRYPTION_KEY=REPLACE_WITH_GENERATED_32_HEX_ENCRYPTION_KEY
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GMAIL_REDIRECT_URI=http://localhost:3000/api/mailbox/gmail/callback

# Analyzer Engine Runtime & Parser Limits (Optional Overrides)
MAX_EML_BYTES=26214400
MAX_CONTAINER_BYTES=104857600
MAX_CONTAINER_MESSAGES=500
MAX_NESTED_MESSAGE_DEPTH=3
MAX_NESTED_MESSAGES=10
MAX_MIME_PARTS=200
MAX_MIME_DEPTH=30
MAX_HEADER_COUNT=1000
MAX_URLS=500
MAX_ATTACHMENT_BYTES=10485760
EXECUTION_TIMEOUT_SECONDS=120
ANALYSIS_VERSION=prototype-1
RETENTION_DAYS=90

# Analyzer Enrichment & Threat Intelligence
ENRICHMENT_MODE=fixture
ENRICHMENT_MAX_REQUESTS=10
ENRICHMENT_CACHE_TTL_SECONDS=86400
ENRICHMENT_LIVE_CACHE_TTL_SECONDS=3600
ENRICHMENT_CONNECT_TIMEOUT_SECONDS=2
ENRICHMENT_READ_TIMEOUT_SECONDS=3
MAXMIND_DB_PATH=
OFFLINE_REPUTATION_PATH=
ABUSEIPDB_API_KEY=

# Optional Cloudflare Tunnel Token (for stable named tunnel)
CLOUDFLARE_TUNNEL_TOKEN=

# Optional container-only overrides. Leave these unset for the local stack.
# CONTAINER_DATABASE_URL=postgresql://user:password@external-db:5432/database
# CONTAINER_REDIS_URL=rediss://user:password@external-redis:6379
# S3_INTERNAL_ENDPOINT=http://minio:9000
# CONTAINER_ANALYZER_URL=http://analyzer:8000
```

The Compose file intentionally distinguishes host-facing settings from container-facing settings:

| Compose variable | Used by | Default | Set it when |
|---|---|---|---|
| `CONTAINER_DATABASE_URL` | web, analyzer, worker, migrate, seed | Built from `POSTGRES_*` and `postgres:5432` | PostgreSQL is outside this Compose network. |
| `CONTAINER_REDIS_URL` | analyzer and worker | `redis://redis:6379/0` | Redis is outside this Compose network. |
| `S3_INTERNAL_ENDPOINT` | web, analyzer, worker | `http://minio:9000` | Object storage is outside this Compose network. |
| `CONTAINER_ANALYZER_URL` | web | `http://analyzer:8000` | The analyzer is outside this Compose network. |

Do not set `CONTAINER_DATABASE_URL` to `localhost` when the application is inside a container unless PostgreSQL is running inside that same container (which is not recommended). In a container, `localhost` means that individual container, not the host or another Compose service.

### Analyzer Runtime & Threat Intelligence Configuration

The `x-analyzer-environment` block in `infra/compose.yaml` exposes all analyzer runtime options via environment interpolation with safe defaults matching `apps/analyzer/app/core/settings.py`:

| Variable | Default | Purpose / Safety Constraints |
|---|---|---|
| `MAX_EML_BYTES` | `26214400` (25 MB) | Maximum size of individual raw `.eml` uploads (max bound: 50 MB). |
| `MAX_CONTAINER_BYTES` | `104857600` (100 MB) | Maximum container archive size (ZIP, TAR, MBOX; max bound: 512 MB). |
| `MAX_CONTAINER_MESSAGES` | `500` | Maximum messages extracted from a container (max bound: 10,000). |
| `MAX_NESTED_MESSAGE_DEPTH` | `3` | Maximum recursion depth for nested `message/rfc822` (max bound: 10). |
| `MAX_NESTED_MESSAGES` | `10` | Maximum total nested messages processed per email (max bound: 100). |
| `MAX_MIME_PARTS` | `200` | Maximum MIME parts processed in a message tree (max bound: 200). |
| `MAX_MIME_DEPTH` | `30` | Maximum MIME hierarchy depth to prevent stack exhaustion (max bound: 100). |
| `MAX_HEADER_COUNT` | `1000` | Maximum header entries parsed per email (max bound: 1,000). |
| `MAX_URLS` | `500` | Maximum extracted URLs per email (bounded by indicator limit `500`). |
| `MAX_ATTACHMENT_BYTES` | `10485760` (10 MB) | Maximum individual attachment bytes parsed for indicators (max bound: 50 MB). |
| `EXECUTION_TIMEOUT_SECONDS` | `120` | Worker task timeout in seconds before aborting run (max bound: 3,600s). |
| `ANALYSIS_VERSION` | `prototype-1` | Version identifier stamped into analysis run results and reports. |
| `RETENTION_DAYS` | `90` | Forensic record retention duration in days (max bound: 3,650). |
| `ENRICHMENT_MODE` | `fixture` | Mode: `fixture` (offline, deterministic mock results), `offline` (local flat files/MaxMind), or `live` (external APIs). |
| `ABUSEIPDB_API_KEY` | *(empty)* | API key for live IP abuse reputation lookups. **Required only when `ENRICHMENT_MODE=live`**; omitted in `fixture` mode. |
| `MAXMIND_DB_PATH` | *(empty)* | Optional container filesystem path to a MaxMind `.mmdb` GeoIP database. |
| `OFFLINE_REPUTATION_PATH` | *(empty)* | Optional container filesystem path to offline reputation mapping file. |
| `ENRICHMENT_MAX_REQUESTS` | `10` | Maximum outbound enrichment queries per run (max bound: 1,000). |
| `ENRICHMENT_CACHE_TTL_SECONDS` | `86400` (24h) | Base cache duration in seconds for enrichment results. |
| `ENRICHMENT_LIVE_CACHE_TTL_SECONDS` | `3600` (1h) | Cache TTL for live threat provider lookups. |
| `ENRICHMENT_CONNECT_TIMEOUT_SECONDS` | `2` | Connection timeout for external threat API requests (max bound: 2.0s). |
| `ENRICHMENT_READ_TIMEOUT_SECONDS` | `3` | Read timeout for external threat API requests (max bound: 3.0s). |

> [!TIP]
> **Safe Local Default:** By keeping `ENRICHMENT_MODE=fixture` (the default) and leaving `ABUSEIPDB_API_KEY` empty, the local Compose stack runs completely offline without network dependencies or external API keys. Set `ENRICHMENT_MODE=live` and supply `ABUSEIPDB_API_KEY` only when live external reputation lookups are desired.

---

## 5. Startup Order & Lifecycle

The Compose stack uses explicit Docker health checks and dependencies to manage boot ordering:

1. **Backing Services Boot**: `postgres`, `redis`, and `minio` start simultaneously.
2. **Bucket Initialization**: `minio-init` waits for `minio` to become healthy (`mc ready local`), creates the `mailsentinel-evidence` bucket, applies private access policies, and exits `0`.
3. **Database Migration**: `migrate` waits for `postgres` to become healthy (`pg_isready`), executes `pnpm db:migrate` using Drizzle Kit against the container database, and exits `0`.
4. **Analyzer & Worker Startup**: `analyzer` and `worker` start once PostgreSQL, Redis, MinIO, bucket initialization, and database migrations have succeeded.
5. **Demo Seeding**: `seed` waits for `migrate`, runs `pnpm db:seed`, and exits `0`. It is idempotent, so it runs safely on every start and re-start.
6. **Web Service Startup**: `web` starts once `postgres`, `migrate`, `seed`, and `analyzer` have succeeded. It validates its health check at `http://127.0.0.1:3000/api/rpc/system/health`.
7. **Optional Tunnel**: `cloudflare-tunnel` runs when the `tunnel` profile is activated.

---

## 6. Quickstart Commands

### Option A: Using repository pnpm scripts

```bash
# Start all services, wait for health, apply migrations, and seed demo user
pnpm infra:start

# Check health and container status
pnpm infra:wait

# Stop all containers (preserves database and evidence volumes)
pnpm infra:stop

# Destructive reset: stops containers, deletes volumes, and starts fresh
pnpm infra:reset
```

### Option B: Using standard Docker Compose commands

```bash
# Build and start the entire stack in the background
docker compose -f infra/compose.yaml up -d --build

# Seeding already ran as a dependency of `web`. Re-run it explicitly only if
# you reset the database by hand (it is idempotent):
docker compose -f infra/compose.yaml run --rm seed

# View real-time container status
docker compose -f infra/compose.yaml ps

# Stream logs from all services
docker compose -f infra/compose.yaml logs -f

# Stream logs from the web service
docker compose -f infra/compose.yaml logs -f web

# Stream logs from the analyzer and worker
docker compose -f infra/compose.yaml logs -f analyzer worker

# Stop containers without losing data
docker compose -f infra/compose.yaml down

# Destructive teardown (deletes persistent volumes!)
docker compose -f infra/compose.yaml down --volumes --remove-orphans
```

---

## 7. Accessing Locally

Once the stack is started:

1. Open your browser to: **<http://localhost:3000>**
2. Sign in using the seeded demo credentials:
   - **Email:** `demo@mailsentinel.local`
   - **Password:** `MailSentinel-Demo-2026!`
3. Verify that the dashboard loads and evidence upload is available under Cases.
4. MinIO Console is available for administrative inspection at: **<http://localhost:9001>** (User: `mailsentinel`, Password: `mailsentinel-local-secret` or your configured credentials).

---

## 8. Internet Access via Cloudflare Tunnel

Cloudflare Tunnel creates an encrypted outbound-only connection between your local Docker environment and Cloudflare's global edge network. You do not need a public IP, dynamic DNS, or port forwarding on your router.

### Method 1: Ephemeral Quick Tunnel (No Account Required)

Quick Tunnels provide an instant, temporary HTTPS URL (e.g., `https://random-words.trycloudflare.com`). Ideal for quick demos or testing mobile devices.

Run a quick tunnel via Docker:

```bash
docker compose -f infra/compose.yaml run --rm cloudflare-tunnel \
  tunnel --no-autoupdate --url http://web:3000
```

Or run via local host CLI if you have `cloudflared` installed:

```bash
cloudflared tunnel --url http://localhost:3000
```

Inspect the terminal output for lines like:
```text
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:                                         |
|  https://some-unique-subdomain.trycloudflare.com                                           |
+--------------------------------------------------------------------------------------------+
```

> [!WARNING]
> **Quick Tunnel Caveats:**
> - The temporary URL changes each time the process restarts.
> - Because the URL is dynamic, it cannot be used for Google OAuth redirects.
> - If Better Auth requires origin matching, set `BETTER_AUTH_URL=https://some-unique-subdomain.trycloudflare.com` in your environment before starting `web`.

---

### Method 2: Stable Named Tunnel with Custom Domain (Recommended)

A named tunnel connects your own domain (e.g. `mail.yourdomain.com`) to your local stack with a persistent HTTPS address. This is required for Gmail / Google OAuth integrations.

#### Step 1: Create the Tunnel in Cloudflare

1. Log into your [Cloudflare Dashboard](https://dash.cloudflare.com/) and navigate to **Zero Trust** -> **Networks** -> **Tunnels**.
2. Click **Create a tunnel**, select **Cloudflared**, and name it (e.g. `mailsentinel-local`).
3. Under **Install and run a connector**, select **Docker**. Cloudflare will display a command containing a tunnel token:
   ```text
   docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJh...
   ```
4. Copy only the token string (`eyJh...`).

#### Step 2: Configure Public Hostname Routing

In the Cloudflare Tunnel configuration page:
1. Go to the **Public Hostname** tab.
2. Click **Add a public hostname**.
3. Fill in:
   - **Subdomain:** `mail` (or your chosen prefix)
   - **Domain:** `yourdomain.com`
   - **Service Type:** `HTTP`
   - **URL:** `web:3000`
4. Save the hostname.

> [!IMPORTANT]
> **Dashboard Routing to `http://web:3000`:**
> Setting Service Type to `HTTP` and URL to `web:3000` tells Cloudflare to route requests internally to `http://web:3000`.
> - Because the `cloudflare-tunnel` container runs within the same Docker Compose bridge network (`mailsentinel`) as the `web` container, Docker's embedded DNS automatically resolves the service hostname `web` to the `web` container IP.
> - **Do NOT use `localhost:3000` or `127.0.0.1:3000` in the Cloudflare dashboard when running the tunnel container in Docker.** Inside the `cloudflare-tunnel` container, `localhost` refers to the tunnel container itself, which would cause connection refused / HTTP 502 Bad Gateway errors.
> - Host loopback (`127.0.0.1:3000`) is reserved for developer access directly on the host machine.

#### Step 3: Configure MailSentinel `.env`

Update your `.env` file to use your public domain:

```dotenv
APP_ENV=production
BETTER_AUTH_URL=https://mail.yourdomain.com
CLOUDFLARE_TUNNEL_TOKEN=eyJh...your_token_here...
```

#### Step 4: Start Stack with Tunnel Profile

Start the entire stack including the background tunnel service using either the `--profile cloudflare-tunnel` or `--profile tunnel` flag:

```bash
docker compose -f infra/compose.yaml --profile cloudflare-tunnel up -d --build
```

*(Note: `--profile tunnel` is supported as an identical alias)*.

Verify that `cloudflare-tunnel` is connected:

```bash
docker compose -f infra/compose.yaml logs -f cloudflare-tunnel
```

Your web application is now securely accessible globally at `https://mail.yourdomain.com`!

---

## 9. Google / Gmail OAuth Setup

To enable the optional Gmail mailbox connector over your public tunnel:

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
   - Create an OAuth 2.0 Client ID (Application type: **Web application**).
   - In **Authorized redirect URIs**, add the exact HTTPS callback URL:
     ```text
     https://mail.yourdomain.com/api/mailbox/gmail/callback
     ```
     *(For local testing without tunnel: `http://localhost:3000/api/mailbox/gmail/callback`)*.
2. In your `.env` file, configure:
   ```dotenv
   MAILBOX_CONNECTORS_ENABLED=true
   MAILBOX_TOKEN_ENCRYPTION_KEY=YOUR_32_HEX_CHARACTER_KEY
   GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
   GMAIL_REDIRECT_URI=https://mail.yourdomain.com/api/mailbox/gmail/callback
   ```
3. Restart the web service:
   ```bash
   docker compose -f infra/compose.yaml restart web
   ```
4. In the MailSentinel UI, navigate to **Settings** -> **Mailbox Connections** to link a Gmail account.

---

## 10. Persistent Volumes & Data Management

Docker Compose provisions three named volumes:

| Volume Name | Target Path | Data Preserved |
|---|---|---|
| `mailsentinel_postgres-data` | `/var/lib/postgresql/data` | Database tables, users, cases, runs, and audit logs |
| `mailsentinel_redis-data` | `/data` | Dramatiq queue state and enrichment cache |
| `mailsentinel_minio-data` | `/data` | Raw uploaded `.eml` files and analysis artifacts |

### Checking Volume Usage

```bash
docker volume ls | grep mailsentinel
docker system df -v
```

### Backing up Volumes

To backup PostgreSQL data:
```bash
docker compose -f infra/compose.yaml exec postgres \
  pg_dump -U mailsentinel -d mailsentinel > backup_$(date +%F).sql
```

To restore PostgreSQL data:
```bash
docker compose -f infra/compose.yaml exec -T postgres \
  psql -U mailsentinel -d mailsentinel < backup_2026-09-04.sql
```

---

## 11. Troubleshooting & Diagnostics

### Analysis Runs Remain in `queued` Status
- **Cause:** The `worker` container is stopped or has crashed.
- **Check:** Run `docker compose -f infra/compose.yaml logs worker`. Verify that the worker connects to Redis and PostgreSQL without errors.

### Web Returns 502 / Bad Gateway on Analyzer Calls
- **Cause:** Service token mismatch or analyzer container not ready.
- **Check:** Verify that `ANALYZER_SERVICE_TOKEN` matches across `.env`. Check analyzer logs with `docker compose -f infra/compose.yaml logs analyzer`.

### Session Cookies or Sign-In Fails over Tunnel
- **Cause:** `BETTER_AUTH_URL` does not match the public HTTPS address.
- **Fix:** Set `BETTER_AUTH_URL=https://mail.yourdomain.com` in `.env` and restart `web`. Better Auth enforces secure cookies when the URL scheme is HTTPS.

### Inspecting Service Health
```bash
# Check web health check directly:
docker compose -f infra/compose.yaml exec web \
  node -e "fetch('http://127.0.0.1:3000/api/rpc/system/health').then(r => r.json()).then(console.log)"

# Check analyzer health:
docker compose -f infra/compose.yaml exec analyzer \
  python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health/ready').read().decode())"
```

---

## 12. Security Checklist for Internet-Facing Deployments

- [ ] Changed the default `demo@mailsentinel.local` password or deleted the demo user.
- [ ] Generated unique high-entropy values for all secrets (`BETTER_AUTH_SECRET`, `ANALYZER_SERVICE_TOKEN`, `MAILBOX_TOKEN_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `S3_SECRET_ACCESS_KEY`).
- [ ] Bound backend services to `127.0.0.1` only or left them private to the Docker network.
- [ ] Configured Cloudflare Tunnel to expose **only** `web:3000`.
- [ ] Enabled HTTPS and set `BETTER_AUTH_URL=https://...` with `APP_ENV=production`.
- [ ] Tested backup and restore procedures for `postgres-data` and `minio-data`.

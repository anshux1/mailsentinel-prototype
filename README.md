# MailSentinel

MailSentinel is a secure email-forensics monorepo. It provides a Next.js web/API application, a private Python analyzer, a Dramatiq worker, PostgreSQL persistence, Redis queues/cache, S3-compatible evidence storage, and an optional Gmail connector.

This README explains the architecture, local setup, deployment options, every environment variable, and the way the services communicate.

> **Important:** This is a prototype. Do not expose it to the public internet without TLS, secret management, backups, monitoring, rate limits, and a production deployment configuration. The checked-in Compose file is a development stack and contains local credentials.

---

## Contents

- [Architecture](#architecture)
- [How the services connect](#how-the-services-connect)
- [Free and low-cost hosting options](#free-and-low-cost-hosting-options)
- [Prerequisites](#prerequisites)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Production deployment](#production-deployment)
- [Google/Gmail setup](#googlegmail-setup)
- [Database migrations and seeding](#database-migrations-and-seeding)
- [Verification and troubleshooting](#verification-and-troubleshooting)
- [Backups and security](#backups-and-security)
- [Repository commands](#repository-commands)

---

## Architecture

MailSentinel has four application processes and three backing services:

| Component | Technology | Purpose | Publicly reachable? |
|---|---|---|---|
| `web` | Next.js 16, Node.js 22 | UI, authentication, oRPC API, uploads, reports, Gmail OAuth callback | **Yes**, through HTTPS |
| `analyzer` | FastAPI, Python 3.12 | Segmentation, parsing, enrichment, analysis intake and status API | **No** |
| `worker` | Dramatiq, Python 3.12 | Consumes analysis jobs from Redis and writes results | **No listener** |
| `migrate` | Drizzle Kit, Node.js 22 | Applies PostgreSQL migrations before application startup | One-shot command |
| PostgreSQL | PostgreSQL 17 | Users, organizations, cases, evidence metadata, runs, reports, audit events | Private |
| Redis | Redis 7 | Dramatiq broker and analyzer cache | Private |
| Object storage | MinIO, AWS S3, or Cloudflare R2 | Raw evidence, child messages, and report objects | Private; accessed server-side |

### Production topology

```text
                              Public internet
                                    |
                           HTTPS / TLS reverse proxy
                                    |
Browser ----------------------> web:3000
                                  |  \\
                                  |   \\----> S3-compatible object storage
                                  |
                                  +--------> PostgreSQL
                                  |
                                  +--------> analyzer:8000  (private only)
                                                   |
                                                   +----> PostgreSQL
                                                   +----> S3 object storage
                                                   +----> Redis broker/cache
                                                              |
                                                              v
                                                        worker process
```

The browser must only communicate with `web`. It must never receive credentials for PostgreSQL, Redis, the analyzer, or the evidence bucket.

### Trust boundaries

- **Browser → web:** HTTPS, Better Auth session cookie, authenticated oRPC requests.
- **Web → analyzer:** private HTTP request authenticated with `ANALYZER_SERVICE_TOKEN`.
- **Web/analyzer → PostgreSQL:** private database connection authenticated with `DATABASE_URL`.
- **Web/analyzer → object storage:** server-side S3 API credentials. Evidence objects are not public.
- **Analyzer → Redis:** private Redis connection. Redis carries analysis jobs; it is not a public API.
- **Web → Google:** only during the optional Gmail OAuth flow.

Do not publish port `8000`, `5432`, `6379`, or `9000` to the internet.

---

## How the services connect

### 1. User login

1. The browser opens the public Next.js application.
2. Better Auth in `web` reads/writes users, sessions, accounts, organizations, and memberships in PostgreSQL.
3. `web` signs the session using `BETTER_AUTH_SECRET`.
4. The browser receives an HTTP-only session cookie.
5. Subsequent browser requests go to `web` and are authorized using that session and organization membership.

### 2. Single `.eml` upload

1. The browser sends upload metadata to the `web` oRPC API.
2. `web` verifies the session, organization, case, file type, and configured byte limit.
3. The raw message is written to the private S3 bucket.
4. `web` computes/verifies the content digest and writes evidence metadata to PostgreSQL.
5. The evidence becomes available for analysis.

### 3. Container or multi-message upload

1. `web` stores the original container object in S3.
2. `web` calls the private analyzer segmentation endpoint.
3. `analyzer` identifies message boundaries and returns offsets, lengths, indexes, and SHA-256 digests.
4. `web` treats the analyzer response as untrusted: it verifies boundaries, ordering, counts, and digests against the original bytes.
5. `web` writes child message objects to S3 and child evidence records/batch metadata to PostgreSQL.
6. The original container remains available as parent evidence.

### 4. Analysis dispatch

1. The browser asks `web` to start an analysis.
2. `web` creates an analysis run and reserves a queue job in PostgreSQL.
3. `web` publishes the job to Redis for Dramatiq.
4. `worker` consumes the job from Redis.
5. `worker` reads the evidence object from S3 and loads the run from PostgreSQL.
6. The analyzer parses headers, MIME parts, URLs, attachments, nested messages, and indicators.
7. Optional enrichment uses offline data or the configured live provider.
8. `worker` writes findings, scores, summaries, and run status to PostgreSQL.
9. `web` reads the status/results from PostgreSQL and displays them to the authorized user.

The web application does not run the long analysis itself. If analysis remains `queued`, check that the web and worker use the same `DATABASE_URL`, `REDIS_URL`, and `ANALYZER_SERVICE_TOKEN`.

### 5. Gmail connection and synchronization

1. An organization owner requests the Gmail connection URL from `web`.
2. `web` creates encrypted OAuth state containing the organization, user, and PKCE verifier.
3. The browser is redirected to Google.
4. Google redirects to the exact `GMAIL_REDIRECT_URI` on `web`.
5. `web` verifies the state cookie, one-time state record, session, owner role, and PKCE exchange.
6. `web` encrypts the Gmail refresh token with `MAILBOX_TOKEN_ENCRYPTION_KEY` and stores it in PostgreSQL.
7. A sync request refreshes the access token, reads Gmail pages, deduplicates messages, stores evidence, and advances the mailbox cursor.
8. Gmail is read-only; MailSentinel does not need permission to send or modify mail.

If `MAILBOX_TOKEN_ENCRYPTION_KEY` is lost or changed, previously stored refresh tokens cannot be decrypted and the mailbox must be connected again.

---

## Free and low-cost hosting options

Free tiers change frequently and usually have sleep limits, quotas, or no support for background workers. Verify current pricing and acceptable-use policies before choosing a provider. A genuinely reliable, always-on, public deployment normally is not completely free.

### Option A — best free prototype: one Oracle Cloud VM

Use an Oracle Cloud Always Free VM for the application stack. Run the web server, analyzer, worker, PostgreSQL, Redis, and MinIO on one machine, or use managed services for the stateful components.

**Advantages**

- One private network for `web`, `analyzer`, `worker`, PostgreSQL, Redis, and object storage.
- No need to expose the analyzer to Vercel or another public platform.
- Suitable for Docker/Compose-style deployment.

**Caveats**

- Capacity is region-dependent and an account may require a payment card.
- You manage patching, TLS, backups, firewall rules, disks, and monitoring.
- The repository's `infra/compose.yaml` is development-only and must not be used unchanged in production.
- A free VM can run out of memory during concurrent 26 MiB uploads or analysis jobs.

Official resource information: <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>

### Option B — split free/limited services

| Part | Possible provider | Important caveat |
|---|---|---|
| Next.js `web` | Vercel Hobby | Good for the web/API process, but serverless limits and request timeouts are unsuitable for long-running work. |
| PostgreSQL | Supabase Free | Small database, inactivity pausing, connection/egress limits. Use a connection string compatible with the `postgres` driver. |
| Redis | Upstash Redis Free | Command and storage quotas; worker traffic can exceed free limits. |
| Object storage | Cloudflare R2 | Free allowance is limited; configure its S3-compatible endpoint and keep the bucket private. |
| Analyzer | Koyeb or Render free web service | Free services sleep and free background workers may not be available. |
| Worker | Oracle VM or a paid worker service | A worker must stay alive to consume Redis jobs; do not assume a free web service can run it. |

Useful provider pages:

- Vercel Hobby: <https://vercel.com/docs/plans/hobby>
- Supabase database limits: <https://supabase.com/docs/guides/platform/database-size>
- Upstash Redis pricing: <https://upstash.com/pricing/redis>
- Cloudflare R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
- Render compute plans: <https://render.com/docs/compute-plans>
- Koyeb instances: <https://www.koyeb.com/docs/reference/instances>

**Important privacy limitation:** if `web` is deployed on Vercel and `analyzer` is on a separate free platform, the analyzer usually needs a reachable URL. That weakens the private-network design. A bearer token is not a substitute for a private network. For a free demo, protect the endpoint with the token and platform firewall controls; for production, put both processes in the same private network or use a private tunnel/VPN.

### Option C — paid but simpler managed deployment

Use a platform that supports multiple long-running services, private networking, secrets, persistent disks, and worker processes, such as Render, Railway, Fly.io, or a conventional VPS. Deploy:

- one web service;
- one analyzer service;
- one worker service;
- managed PostgreSQL;
- managed Redis;
- managed S3-compatible storage.

This costs more than the free options but reduces operational risk. Confirm that the selected plan supports a persistent worker and private service-to-service networking.

### Recommended choice

- **Learning/demo:** Oracle VM or local Docker Compose.
- **Public demo with low traffic:** Vercel + Supabase + Upstash + R2, with analyzer/worker on an Oracle VM; understand that the analyzer boundary is weaker.
- **Real evidence or investigative use:** private VM/VPC or paid managed services, encrypted backups, TLS, monitoring, and a continuously running worker.

---

## Prerequisites

The repository expects:

- Git 2.40+
- Node.js `>=22 <23` (Node 22 LTS)
- pnpm 9.0.0
- Python 3.12
- `uv`
- Docker and Docker Compose for the local backing stack

The project currently enforces Node 22. Node 24 may run but produces an unsupported-engine warning and is not the acceptance runtime.

Install the JavaScript dependencies:

```bash
corepack enable
corepack prepare pnpm@9.0.0 --activate
pnpm install --frozen-lockfile
```

Install Python dependencies:

```bash
cd apps/analyzer
uv sync --locked
cd ../..
```

---

## Local development

### 1. Start the local backing services

The checked-in Compose stack starts:

- PostgreSQL on `127.0.0.1:5432`;
- Redis on `127.0.0.1:6379`;
- MinIO API on `127.0.0.1:9000`;
- MinIO console on `127.0.0.1:9001`;
- the private analyzer container;
- the Dramatiq worker.

```bash
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env
cp apps/analyzer/.env.example apps/analyzer/.env
pnpm infra:start
pnpm infra:wait
```

Create the local evidence bucket and apply the schema:

```bash
./infra/scripts/bucket.sh
pnpm db:migrate
pnpm db:seed
```

Start the web application:

```bash
pnpm --filter @mailsentinel/web dev
```

Open <http://localhost:3000>. The local seed account is:

```text
Email:    demo@mailsentinel.local
Password: MailSentinel-Demo-2026!
```

Change or remove this account before any public deployment.

### 2. Local service addresses

Inside the Compose network, services use Docker DNS names:

```text
web -> postgres:5432
web -> analyzer:8000
web -> minio:9000
analyzer -> postgres:5432
analyzer -> redis:6379
analyzer -> minio:9000
worker -> postgres:5432
worker -> redis:6379
worker -> minio:9000
```

From the host machine, use `localhost` instead of those names for services exposed by Compose. The web process started on the host should use `ANALYZER_INTERNAL_URL=http://localhost:8000` and `S3_ENDPOINT=http://localhost:9000`; the example files use Docker names where appropriate for container execution, so check the file you are using.

### 3. Stop or reset local services

```bash
pnpm infra:stop
pnpm infra:reset   # destructive: removes local database/object-storage volumes
```

---

## Environment variables

There are separate environment sets for `web`, `analyzer/worker`, backing services, and the seed command. Do not put all secrets in the browser or in a `NEXT_PUBLIC_*` variable.

Create these files in a deployment:

```text
apps/web/.env          # read by the Next.js web process and migration/seed commands when run there
apps/analyzer/.env     # read by the analyzer and worker
```

The Compose development file has inline values and does not automatically replace them with every value in the `.env` files. For production, use your platform's secret manager or a production Compose/VM configuration rather than relying on the development file.

Generate secrets with:

```bash
openssl rand -base64 48   # BETTER_AUTH_SECRET
openssl rand -hex 32       # ANALYZER_SERVICE_TOKEN
openssl rand -hex 32       # MAILBOX_TOKEN_ENCRYPTION_KEY
openssl rand -base64 32    # S3_SECRET_ACCESS_KEY and/or database password
```

Store the generated values in a password manager or secret manager. Never commit them.

### Web variables: `apps/web/.env`

| Variable | Required | Example/default | Meaning |
|---|---:|---|---|
| `DATABASE_URL` | Yes | `postgresql://user:password@host:5432/db` | PostgreSQL connection used by auth, API, migrations, and repositories. |
| `BETTER_AUTH_SECRET` | Yes | generated secret, minimum 32 characters | Signs/protects Better Auth sessions. Keep stable across restarts. |
| `BETTER_AUTH_URL` | Production | `https://mail.example.com` | Public origin used by authentication. Must be the actual HTTPS URL in production. |
| `ANALYZER_INTERNAL_URL` | Yes in deployment | `http://analyzer:8000` | URL that only the web server uses to call the analyzer. |
| `ANALYZER_SERVICE_TOKEN` | Yes | shared random token, minimum 16 characters | Bearer token shared by web and analyzer. |
| `S3_ENDPOINT` | Yes | `https://<account>.r2.cloudflarestorage.com` | S3-compatible API endpoint. MinIO uses `http://minio:9000`. |
| `S3_REGION` | Yes/default | `us-east-1` | S3 signing region. |
| `S3_BUCKET` | Yes/default | `mailsentinel-evidence` | Private bucket for evidence and reports. Create it before uploads. |
| `S3_ACCESS_KEY_ID` | Yes | provider access key | Server-only object-storage credential. |
| `S3_SECRET_ACCESS_KEY` | Yes | generated/provider secret, minimum 16 characters | Server-only object-storage credential. |
| `S3_FORCE_PATH_STYLE` | Usually `true` for MinIO | `true` or `false` | `true` for MinIO/local S3; usually `false` for AWS S3/R2. |
| `MAX_EML_BYTES` | No | `26214400` | Maximum single message size in bytes; default is 26 MiB. |
| `MAX_CONTAINER_BYTES` | No | `104857600` | Maximum container upload size in bytes; align with analyzer limits. |
| `APP_ENV` | No | `production` | One of `development`, `test`, `demo`, `production`. Use `production` publicly. |
| `WEB_DATA_MODE` | No | `live` | `live`, `fixture`, or `offline`; use `live` for a real deployment. |
| `MAILBOX_CONNECTORS_ENABLED` | No | `false` | Set `true` only after Google OAuth configuration is complete. |
| `MAILBOX_TOKEN_ENCRYPTION_KEY` | Required when connectors enabled | random 32-byte/32-character secret | AES-256-GCM key material for Gmail refresh tokens and OAuth state. Keep stable. |
| `MAILBOX_SYNC_MAX_MESSAGES` | No | `200` | Maximum messages processed by one sync request; range 1–1000. |
| `GOOGLE_OAUTH_CLIENT_ID` | Required when connectors enabled | Google OAuth client ID | Preferred Google OAuth variable. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Required when connectors enabled | Google OAuth client secret | Preferred Google OAuth variable. |
| `GMAIL_CLIENT_ID` | Legacy alternative | Google OAuth client ID | Supported legacy alias if `GOOGLE_OAUTH_CLIENT_ID` is absent. |
| `GMAIL_CLIENT_SECRET` | Legacy alternative | Google OAuth client secret | Supported legacy alias if `GOOGLE_OAUTH_CLIENT_SECRET` is absent. |
| `GMAIL_REDIRECT_URI` | Required when connectors enabled | `https://mail.example.com/api/mailbox/gmail/callback` | Must exactly match Google Cloud Console. Must be HTTPS in production. |

A minimal production web file looks like this:

```dotenv
DATABASE_URL=postgresql://mailsentinel:DB_PASSWORD@db-host:5432/mailsentinel
BETTER_AUTH_SECRET=GENERATED_32_PLUS_CHARACTER_SECRET
BETTER_AUTH_URL=https://mail.example.com
ANALYZER_INTERNAL_URL=http://127.0.0.1:8000
ANALYZER_SERVICE_TOKEN=GENERATED_SHARED_ANALYZER_TOKEN
S3_ENDPOINT=https://S3_PROVIDER_ENDPOINT
S3_REGION=us-east-1
S3_BUCKET=mailsentinel-evidence
S3_ACCESS_KEY_ID=S3_ACCESS_KEY
S3_SECRET_ACCESS_KEY=S3_SECRET_KEY
S3_FORCE_PATH_STYLE=false
MAX_EML_BYTES=26214400
MAX_CONTAINER_BYTES=104857600
APP_ENV=production
WEB_DATA_MODE=live
MAILBOX_CONNECTORS_ENABLED=false
```

When the analyzer runs in a separate private container network, replace `127.0.0.1` with its private DNS name, such as `http://analyzer:8000`.

### Analyzer and worker variables: `apps/analyzer/.env`

The analyzer and worker use the same file because they must point to the same database, Redis broker, and object storage.

| Variable | Required | Example/default | Meaning |
|---|---:|---|---|
| `APP_ENV` | No | `production` | `development`, `test`, `demo`, or `production`. |
| `DATABASE_URL` | Yes | `postgresql://user:password@host:5432/db` | Same logical PostgreSQL database used by web. |
| `REDIS_URL` | Yes for worker/queue | `redis://redis:6379/0` | Dramatiq broker and analyzer cache. Upstash commonly uses `rediss://`. |
| `S3_ENDPOINT` | Yes/default | `http://minio:9000` | S3-compatible storage endpoint. |
| `S3_REGION` | No | `us-east-1` | S3 signing region. |
| `S3_BUCKET` | Yes/default | `mailsentinel-evidence` | Must be the same bucket used by web. |
| `S3_ACCESS_KEY_ID` | Yes | provider access key | Must be able to read/write required private objects. |
| `S3_SECRET_ACCESS_KEY` | Yes | provider secret, minimum 16 characters | Must match the selected S3 access key. |
| `S3_FORCE_PATH_STYLE` | No | `true` | `true` for MinIO; usually `false` for AWS S3/R2. |
| `ANALYZER_SERVICE_TOKEN` | Yes | same value as web | Authenticates web-to-analyzer API calls. |
| `MAX_EML_BYTES` | No | `26214400` | Analyzer input limit; keep consistent with web. Maximum 50,000,000. |
| `MAX_MIME_PARTS` | No | `200` | Parser safety limit; maximum 200. |
| `MAX_MIME_DEPTH` | No | `30` | Nested MIME safety limit; maximum 100. |
| `MAX_HEADER_COUNT` | No | `1000` | Header safety limit; maximum 1000. |
| `MAX_URLS` | No | `500` | Maximum URL indicators; bounded by the analyzer contract. |
| `MAX_ATTACHMENT_BYTES` | No | `10485760` | Maximum attachment size; maximum 50,000,000. |
| `EXECUTION_TIMEOUT_SECONDS` | No | `120` | Analysis timeout; greater than 0 and at most 3600 seconds. |
| `ENRICHMENT_MODE` | No | `offline` or `fixture` | `fixture` for deterministic demos, `offline` for no network, `live` for provider calls. |
| `ENRICHMENT_MAX_REQUESTS` | No | `10` | Maximum enrichment requests per analysis. |
| `ENRICHMENT_CACHE_TTL_SECONDS` | No | `86400` | Offline/cache TTL; maximum 604800. |
| `ENRICHMENT_LIVE_CACHE_TTL_SECONDS` | No | `3600` | Live provider cache TTL; maximum 604800. |
| `ENRICHMENT_CONNECT_TIMEOUT_SECONDS` | No | `2` | Provider connection timeout; maximum 2 seconds. |
| `ENRICHMENT_READ_TIMEOUT_SECONDS` | No | `3` | Provider read timeout; maximum 3 seconds. |
| `MAXMIND_DB_PATH` | Needed for MaxMind offline enrichment | `/data/GeoLite2-ASN.mmdb` | Path to a licensed/downloaded MaxMind database mounted into the analyzer. |
| `OFFLINE_REPUTATION_PATH` | Optional | empty | Optional local reputation data file. |
| `ABUSEIPDB_API_KEY` | Required for `live` | provider key | Analyzer refuses to start in live mode without it. |
| `ANALYSIS_VERSION` | No | `prototype-1` | Version label stored with analysis results. |
| `RETENTION_DAYS` | No | `90` | Retention policy value; maximum 3650. |
| `MAX_CONTAINER_MESSAGES` | No | `500` | Maximum messages in one container; maximum 10000. |
| `MAX_CONTAINER_BYTES` | No | `104857600` | Maximum container size; maximum 512 MiB. |
| `MAX_NESTED_MESSAGE_DEPTH` | No | `3` | Nested-message extraction depth; maximum 10. |
| `MAX_NESTED_MESSAGES` | No | `10` | Nested-message count limit; maximum 100. |

A minimal production analyzer/worker file looks like this:

```dotenv
APP_ENV=production
DATABASE_URL=postgresql://mailsentinel:DB_PASSWORD@db-host:5432/mailsentinel
REDIS_URL=rediss://default:REDIS_PASSWORD@redis-host:6379
S3_ENDPOINT=https://S3_PROVIDER_ENDPOINT
S3_REGION=us-east-1
S3_BUCKET=mailsentinel-evidence
S3_ACCESS_KEY_ID=S3_ACCESS_KEY
S3_SECRET_ACCESS_KEY=S3_SECRET_KEY
S3_FORCE_PATH_STYLE=false
ANALYZER_SERVICE_TOKEN=THE_EXACT_SAME_VALUE_AS_WEB
MAX_EML_BYTES=26214400
MAX_CONTAINER_BYTES=104857600
ENRICHMENT_MODE=offline
ANALYSIS_VERSION=prototype-1
RETENTION_DAYS=90
```

### Database and object-storage variables

If you run PostgreSQL and MinIO yourself, these variables are used by the backing services:

```dotenv
POSTGRES_USER=mailsentinel
POSTGRES_PASSWORD=LONG_RANDOM_DATABASE_PASSWORD
POSTGRES_DB=mailsentinel
MINIO_ROOT_USER=S3_ACCESS_KEY_ID_VALUE
MINIO_ROOT_PASSWORD=S3_SECRET_ACCESS_KEY_VALUE
```

For managed PostgreSQL, Redis, and S3/R2, use the credentials and endpoint supplied by that provider instead. The application does not need `POSTGRES_*` or `MINIO_*` when those services are managed; it only needs `DATABASE_URL`, `REDIS_URL`, and the S3 variables.

### Seed variables

The seed command accepts:

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_USER_EMAIL` | `demo@mailsentinel.local` | Initial seeded user email. |
| `DEMO_USER_PASSWORD` | `MailSentinel-Demo-2026!` | Initial seeded password. Set a strong unique value. |
| `DATABASE_URL` | local PostgreSQL URL | Database to seed. |
| `BETTER_AUTH_SECRET` | local development fallback | Auth secret used while constructing the seed auth instance. Set it explicitly. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Public/base URL used by seed auth configuration. |

### Values that must match

| Value | Must match between | Failure symptom |
|---|---|---|
| `DATABASE_URL` | web, analyzer, worker, migrations, seed | Jobs or records appear stuck/missing because processes use different databases. |
| `ANALYZER_SERVICE_TOKEN` | web and analyzer/worker environment | Analyzer calls return unauthorized or `BAD_GATEWAY`. |
| `S3_ACCESS_KEY_ID` | web, analyzer, and storage provider | Upload/read failures. |
| `S3_SECRET_ACCESS_KEY` | web, analyzer, and storage provider | Upload/read failures. |
| `S3_ENDPOINT` | web and analyzer | One service cannot find objects written by the other. |
| `S3_BUCKET` | web, analyzer, and created bucket | Object-not-found errors. |
| `S3_FORCE_PATH_STYLE` | web and analyzer | S3 signature/addressing errors, especially with MinIO. |
| `MAX_EML_BYTES` | web and analyzer | Web accepts a message that analyzer rejects, or vice versa. |
| `MAX_CONTAINER_BYTES` | web and analyzer | Container ingestion behaves inconsistently. |
| `MAILBOX_TOKEN_ENCRYPTION_KEY` | every web instance | Gmail tokens become unreadable after a key mismatch. |

### Environment validation rules

The web process refuses invalid values such as a missing database URL, short auth/analyzer/storage secrets, invalid URLs, or incomplete Gmail configuration. The analyzer refuses invalid DSNs, short secrets, unsafe parser limits, and live enrichment without `ABUSEIPDB_API_KEY`.

Never set secrets as `NEXT_PUBLIC_*`. Next.js exposes public variables to browser code, and the application actively rejects public variable names that look like secrets.

---

## Production deployment

There is no production `web` Dockerfile in this repository, and `infra/compose.yaml` is intentionally a local development harness. You can deploy the web process directly on a Node host/platform and build the analyzer from its existing Dockerfile.

### Deployment order

Always deploy in this order:

1. Create PostgreSQL, Redis, and S3-compatible storage.
2. Create the private bucket.
3. Configure secrets and environment variables.
4. Run database migrations.
5. Build/start the analyzer.
6. Start the worker.
7. Build/start the web application.
8. Put TLS/reverse proxy in front of the web process.
9. Test login, upload, analysis, and health endpoints.

### A. One-VM deployment

This is the most practical free prototype because all services can remain on one private machine.

#### Step 1: provision the VM

Install Node 22, pnpm 9, Docker, Git, and a TLS reverse proxy such as Caddy or Nginx. Open only ports 80 and 443 in the firewall. Keep 3000 and 8000 bound to localhost/private networking.

Clone the repository:

```bash
git clone https://github.com/anshux1/mailsentinel-prototype.git
cd mailsentinel-prototype
corepack enable
corepack prepare pnpm@9.0.0 --activate
pnpm install --frozen-lockfile
```

#### Step 2: create production environment files

Create `apps/web/.env` and `apps/analyzer/.env` using the tables above. Use managed PostgreSQL/Redis/R2 values if available, or use private local containers.

Do not copy the development credentials from `infra/compose.yaml` into production.

#### Step 3: start infrastructure

For a temporary prototype using local containers, you can start the development infrastructure:

```bash
pnpm infra:start
pnpm infra:wait
./infra/scripts/bucket.sh
```

This is not a hardened production stack. For a serious deployment, create a separate production Compose/VM configuration with:

- secrets injected from the platform rather than committed inline;
- no public port bindings for PostgreSQL, Redis, MinIO, or analyzer;
- persistent encrypted disks;
- health checks and restart policies;
- resource limits;
- regular backups;
- `APP_ENV=production`.

#### Step 4: migrate the database

Run migrations from the repository root with the production `DATABASE_URL` available to the command:

```bash
pnpm db:migrate
```

Run the seed once, only if you need an initial owner account:

```bash
DEMO_USER_EMAIL=admin@example.com \
DEMO_USER_PASSWORD='USE-A-LONG-UNIQUE-PASSWORD' \
pnpm db:seed
```

After first login, disable/remove the seed account or replace its credentials.

#### Step 5: build and run the analyzer

Build the supplied analyzer image:

```bash
docker build -t mailsentinel-analyzer ./apps/analyzer
```

Run the analyzer on a private interface. The exact network/secret syntax depends on your VM setup; the important properties are that it receives `apps/analyzer/.env` and is not public:

```bash
docker run -d \
  --name mailsentinel-analyzer \
  --restart unless-stopped \
  --env-file apps/analyzer/.env \
  -p 127.0.0.1:8000:8000 \
  mailsentinel-analyzer
```

Run the worker from the same image and environment:

```bash
docker run -d \
  --name mailsentinel-worker \
  --restart unless-stopped \
  --env-file apps/analyzer/.env \
  mailsentinel-analyzer \
  uv run dramatiq app.tasks.broker
```

If PostgreSQL, Redis, or MinIO are containers, put these containers on the same Docker network and use their service DNS names in `DATABASE_URL`, `REDIS_URL`, and `S3_ENDPOINT`. If the services are on the VM host, use host-reachable addresses instead of Docker names.

#### Step 6: build and run web

```bash
pnpm --filter @mailsentinel/web build
pnpm --filter @mailsentinel/web start
```

`next start` listens on port 3000. Run it under systemd, a process manager, or a platform service so it restarts after a crash. Do not use `pnpm dev` in production.

#### Step 7: configure TLS

Configure Caddy/Nginx/your platform to proxy:

```text
https://mail.example.com  ->  http://127.0.0.1:3000
```

Then set:

```dotenv
BETTER_AUTH_URL=https://mail.example.com
GMAIL_REDIRECT_URI=https://mail.example.com/api/mailbox/gmail/callback
```

The TLS proxy should add security headers, limit request size consistently with `MAX_CONTAINER_BYTES`, and forward the original host/protocol correctly.

### B. Vercel web deployment

Vercel can host the Next.js `web` application, but it does not replace the analyzer or worker. You still need a private analyzer service, a continuously running worker, PostgreSQL, Redis, and S3 storage.

Typical Vercel settings:

```text
Framework: Next.js
Install command: pnpm install --frozen-lockfile
Build command: pnpm --filter @mailsentinel/web build
Start command: managed by Vercel
```

Depending on the Vercel monorepo configuration, use the repository root as the project root so workspace packages resolve correctly, or configure the project root/build filters explicitly.

Add the **web variables only** in Vercel Project Settings → Environment Variables. Do not add analyzer-only variables such as `REDIS_URL` or `ABUSEIPDB_API_KEY` to the web project.

Set `ANALYZER_INTERNAL_URL` to the analyzer's private/restricted URL. A normal Vercel deployment cannot resolve a Docker-only hostname such as `http://analyzer:8000`; use a private network/tunnel or a restricted service endpoint. Keep in mind that Vercel request-duration limits make request-held mailbox sync and other long operations unsuitable for high-volume production.

### C. Managed-service deployment checklist

For any platform:

- Set Node 22 and pnpm 9, not Node 24.
- Build the web with `pnpm --filter @mailsentinel/web build`.
- Build the analyzer with `docker build -t mailsentinel-analyzer ./apps/analyzer` or use the platform's Python build process.
- Run the worker command exactly as `uv run dramatiq app.tasks.broker` from the analyzer project image/environment.
- Run `pnpm db:migrate` as a release/one-shot job before serving traffic.
- Keep the analyzer and worker on a private network.
- Configure persistent PostgreSQL and object storage; Redis may be replaceable but must be reachable by the worker.
- Configure health checks:
  - analyzer liveness: `GET /health/live`;
  - analyzer readiness: `GET /health/ready`;
  - web health: the system health endpoint exposed by the web API.
- Configure logs and alerts for failed jobs, database errors, storage errors, and worker restarts.

---

## Google/Gmail setup

Gmail support is optional and disabled by default.

### 1. Create a Google OAuth client

1. Open Google Cloud Console.
2. Create/select a project.
3. Configure the OAuth consent screen.
4. Add the Gmail read-only scope requested by the application:
   `https://www.googleapis.com/auth/gmail.readonly`.
5. If the application is in testing mode, add the Gmail accounts as test users.
6. Create an OAuth client of type **Web application**.
7. Add this exact authorized redirect URI:

```text
https://YOUR_PUBLIC_DOMAIN/api/mailbox/gmail/callback
```

For local development:

```text
http://localhost:3000/api/mailbox/gmail/callback
```

The scheme, hostname, port, path, and trailing slash must match. Do not use a wildcard.

### 2. Configure the web environment

```dotenv
MAILBOX_CONNECTORS_ENABLED=true
MAILBOX_TOKEN_ENCRYPTION_KEY=GENERATED_STABLE_SECRET
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
GMAIL_REDIRECT_URI=https://YOUR_PUBLIC_DOMAIN/api/mailbox/gmail/callback
```

Restart the web service after changing these variables. The connector requires an authenticated organization owner. Only the read-only Gmail scope is accepted.

### 3. Test the flow

1. Sign in as an organization owner.
2. Start the Gmail connection from the settings/mailbox area.
3. Approve the Google consent screen.
4. Confirm the browser returns to settings with a successful connection.
5. Start a small sync.
6. Confirm evidence appears and the mailbox cursor advances.

Never log OAuth codes, access tokens, refresh tokens, cookies, or the contents of messages.

---

## Database migrations and seeding

The schema lives in `packages/db/src/schema.ts`, and generated SQL migrations live in `packages/db/migrations`.

Apply committed migrations:

```bash
pnpm db:migrate
```

Generate a migration after a schema change:

```bash
pnpm db:generate
```

Review generated SQL before committing it. Do not use `db:generate` as a production deployment step; production should apply reviewed committed migrations with `db:migrate`.

Seed a development/demo account and organization:

```bash
pnpm db:seed
```

The seed creates an owner in organization `org_demo`. Seeding is not a user-registration or production onboarding system.

---

## Verification and troubleshooting

Run the complete backend verification gate before deployment:

```bash
pnpm env:check
pnpm contracts:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Analyzer-specific checks:

```bash
cd apps/analyzer
uv run --group dev ruff check app tests
uv run --group dev ruff format --check app tests
uv run --group dev mypy app
uv run --group dev pytest
```

### Health checks

Analyzer endpoints:

```bash
curl -fsS http://127.0.0.1:8000/health/live
curl -fsS http://127.0.0.1:8000/health/ready
```

Call the analyzer checks only from the VM/private network. Do not publish them as public browser endpoints.

### Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Web exits during startup | Missing/invalid web environment | Check `DATABASE_URL`, auth/storage URLs, and secret lengths. |
| Analyzer exits during startup | Invalid analyzer environment | Check `DATABASE_URL`, `REDIS_URL`, S3 credentials, limits, and live enrichment configuration. |
| `BAD_GATEWAY` during analysis | Analyzer unreachable or token mismatch | Check `ANALYZER_INTERNAL_URL`, private firewall rules, analyzer logs, and exact `ANALYZER_SERVICE_TOKEN` match. |
| Analysis stays `queued` | Worker is stopped, Redis is wrong, or worker uses another database | Check worker logs and ensure web/worker share `REDIS_URL` and `DATABASE_URL`. |
| Upload fails at object storage | Wrong endpoint, bucket, credentials, or path-style setting | Verify the bucket exists and align `S3_*` values between web and analyzer. |
| Analyzer cannot read uploaded evidence | Web and analyzer use different bucket/endpoint/credentials | Compare `S3_ENDPOINT`, `S3_BUCKET`, access key, secret, and path-style mode. |
| Gmail callback says invalid state | Wrong public URL, cookie not returned, expired/replayed state, or proxy configuration | Use HTTPS, preserve cookies/host headers, and set the exact redirect URI. |
| Gmail callback says invalid scope | Consent screen returned more/less than Gmail read-only scope | Request and grant only the required read-only scope. |
| Existing Gmail connection breaks after redeploy | Encryption key changed | Restore the original `MAILBOX_TOKEN_ENCRYPTION_KEY`; otherwise reconnect the mailbox. |
| `relation does not exist` | Migrations were not applied to the database used by the process | Run `pnpm db:migrate` with the exact production `DATABASE_URL`. |
| OAuth works locally but not in production | Google redirect URI still points to localhost or production URI is HTTP | Register the HTTPS production callback and update `GMAIL_REDIRECT_URI`. |
| Upload gets rejected despite available storage | Application safety limit reached | Check `MAX_EML_BYTES`/`MAX_CONTAINER_BYTES` and keep web/analyzer limits consistent. |

---

## Backups and security

MailSentinel has two important data stores:

1. **PostgreSQL:** users, organizations, cases, evidence metadata, audit events, analysis state, findings, reports metadata, and mailbox connections.
2. **Object storage:** original evidence, segmented child objects, and generated report files.

Back up both. A database backup without the objects, or objects without the database metadata, cannot fully reconstruct a case.

Minimum deployment controls:

- Use HTTPS everywhere outside a private development network.
- Keep analyzer, PostgreSQL, Redis, and the evidence bucket private.
- Use unique randomly generated credentials; never use Compose development secrets.
- Store secrets in Vercel/Render/Oracle secret storage or an external secret manager.
- Keep `BETTER_AUTH_SECRET` and `MAILBOX_TOKEN_ENCRYPTION_KEY` stable across releases.
- Rotate credentials with a migration plan; do not casually rotate encryption keys.
- Enable PostgreSQL point-in-time or scheduled backups and test restoration.
- Version or snapshot object storage and test restoration of evidence objects.
- Restrict service accounts to only the required bucket/database permissions.
- Run the worker continuously and alert on restart loops or growing Redis queues.
- Set request/body limits at both the reverse proxy and application layers.
- Forward structured logs to a private log system, excluding message bodies and credentials.
- Keep dependencies and the Node/Python runtimes patched.
- Change/remove the seeded demo account before public access.

---

## Repository commands

| Command | Purpose |
|---|---|
| `pnpm install --frozen-lockfile` | Install locked JavaScript dependencies. |
| `pnpm dev` | Start development apps. |
| `pnpm build` | Build packages/apps. |
| `pnpm lint` | Run repository linting. |
| `pnpm typecheck` | Run TypeScript checks. |
| `pnpm test` | Run JavaScript tests. |
| `pnpm contracts:check` | Export/regenerate analyzer contracts and detect drift. |
| `pnpm env:check` | Verify environment documentation coverage. |
| `pnpm db:generate` | Generate a reviewed Drizzle migration. |
| `pnpm db:migrate` | Apply committed database migrations. |
| `pnpm db:seed` | Seed the demo organization/user. |
| `pnpm infra:start` | Start local PostgreSQL, Redis, MinIO, analyzer, and worker. |
| `pnpm infra:wait` | Wait for local service health. |
| `pnpm infra:stop` | Stop local infrastructure. |
| `pnpm infra:reset` | Destructively delete local volumes and restart cleanly. |

## Workspace layout

```text
apps/web/          Next.js UI and server/API routes
apps/analyzer/     FastAPI analyzer, segmentation, parser, enrichment, worker
packages/db/       Drizzle schema, migrations, repositories, database tests
packages/auth/     Better Auth setup and seed script
packages/contracts/Generated/shared analyzer contracts
packages/ui/       Shared UI package
infra/             Development Compose stack and helper scripts
docs/              Threat model, demo runbook, deployment notes
```

For additional project-specific notes, see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), [`docs/demo-runbook.md`](docs/demo-runbook.md), and [`docs/threat-model.md`](docs/threat-model.md).

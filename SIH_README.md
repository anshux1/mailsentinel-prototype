# MailSentinel: Email Forensics & Threat Investigation Platform

> **Smart India Hackathon (SIH) — Technical Architecture, Forensic Integrity & Judge Presentation Dossier**
> *Repository: `mailsentinel-prototype` | Classification: Defensive Cybersecurity / Digital Forensics Workbench*

---

## Executive Summary & System Overview

**MailSentinel** is a prototype email-forensics and threat-investigation platform designed for security analysts and investigators. Designed for Security Operations Centers (SOC), incident response teams, cyber-crime investigators, and forensic analysts, MailSentinel ingests raw RFC 822/5322 emails, multi-message containers (mbox, multipart/digest, bare concatenations), and live mailbox feeds, subjecting them to bounded, zero-trust forensic parsing, indicator extraction, and explainable rule-based threat scoring.

Unlike generic spam filters or black-box "AI detectors," MailSentinel operates as a **defensive digital forensics workbench**. It does not output arbitrary probabilistic judgments; instead, it applies **SHA-256 evidence integrity checks**, maintains a **structured audit trail**, and generates **explainable, evidence-backed findings** mapped to specific byte offsets, RFC headers, and network hops.

> [!IMPORTANT]
> **Forensic Scope Notice:** MailSentinel is an analyst decision-support system and investigative workbench. It is engineered to assist human forensic examiners and incident responders; it **does not** assert autonomous final legal verdicts, substitute for certified judicial forensic testimony, or guarantee legal admissibility. Furthermore, while the platform enforces cryptographic hash verification (SHA-256) and strict tenant storage boundaries, it does not itself provide hardware-level object immutability (WORM retention).

---

## System Architecture & Trust Boundaries

MailSentinel enforces a multi-tier trust boundary separating public-facing ingress from private forensic execution environments. The web application, parsing engine, asynchronous task queue, database, and evidence object storage reside in isolated network tiers.

### 1. Architecture Diagram

```text
               Public Internet (Security Analyst Browser / Google OAuth)
                                          │
                            Cloudflare Tunnel / TLS Proxy
                                          │
                                          ▼
┌─────────────────────── Docker Bridge Network: mailsentinel ────────────────────────┐
│                                                                                    │
│   cloudflare-tunnel ─────────► web:3000 (Next.js 16 / React 19 / Node 22)          │
│                                    │  Better Auth | oRPC API | S3 Storage Client   │
│                                    │                                               │
│             ┌──────────────────────┼──────────────────────┐                        │
│             ▼                      ▼                      ▼                        │
│       postgres:5432            minio:9000           analyzer:8000                  │
│       PostgreSQL 17        S3-Compatible Evidence   FastAPI (Python 3.12)          │
│       - Multi-tenant DB    - Private S3 .eml store  - RFC 822 MIME parser          │
│       - Cases & Evidence   - Tenant-isolated keys   - Container segmenter          │
│       - Audit records      - Opaque access only     - Indicator extractor          │
│       - Forensic reports                            - Scoring rules v1.2.0         │
│             ▲                      ▲                      ▲                        │
│             │                      │                      │                        │
│             │                      │                      │                        │
│             │                      └──────────┐           │                        │
│             │                                 │           │                        │
│        worker (Dramatiq) ◄──── redis:6379 ────┴───────────┘                        │
│        Python 3.12             Redis 7                                             │
│        Async Job Consumer      - Job Queue Broker                                  │
│        Bounded Execution       - Threat Cache                                      │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 2. Component Topology & Network Access Matrix

| Component | Technology Stack | Core Role | Network Exposure |
|---|---|---|---|
| `web` | Next.js 16, React 19, Node.js 22 | Analyst UI, Better Auth, typed oRPC API, S3 upload orchestration, Gmail OAuth | **Public** (port 3000 / HTTPS via TLS Tunnel) |
| `analyzer` | FastAPI, Python 3.12, Pydantic v2 | RFC 822 MIME parsing, container segmentation, indicator extraction, deterministic scoring | **Private** (`analyzer:8000`, internal bridge only, Bearer token) |
| `worker` | Dramatiq, Python 3.12 | Background task worker consuming analysis jobs from Redis; process-isolated execution | **Private** (no open listening port) |
| `migrate` | Drizzle Kit, Node.js 22 | One-shot database schema migration runner | **Private** (exits on completion) |
| `seed` | Drizzle ORM, Node.js 22 | One-shot demo tenant/user seeder | **Private** (exits on completion) |
| `postgres` | PostgreSQL 17 Alpine | Multi-tenant relational persistence: users, cases, evidence, runs, audit events | **Private** (`postgres:5432`, internal bridge only) |
| `redis` | Redis 7 Alpine | Dramatiq message broker and indicator enrichment cache | **Private** (`redis:6379`, internal bridge only) |
| `minio` | MinIO S3-Compatible | Private raw `.eml` and generated forensic report object storage with SHA-256 preflight checks | **Private** (`minio:9000` API, console on loopback `9001`) |
| `cloudflare-tunnel` | Cloudflared CLI | Outbound encrypted TLS tunnel to expose `web:3000` without open ingress ports | **Outbound only** |

### 3. Strict Trust Boundary Principles

1. **Zero Browser-Direct Storage Access:** The browser never receives AWS/MinIO S3 credentials or direct pre-signed upload URLs. Evidence uploads stream to the server-side Next.js process, which validates byte boundaries, computes SHA-256 digests, and writes to S3.
2. **Private Analyzer Isolation:** The FastAPI analysis engine is completely unexposed to the host and internet. It communicates exclusively with `web` and `worker` over the private Docker bridge network, authenticated with a constant-time verified `ANALYZER_SERVICE_TOKEN`.
3. **No Direct Attachment Execution:** The analyzer parses MIME structures, extracts metadata, URLs, domains, and attachment hashes, but **never executes** attachments or renders active scripts.
4. **Tenant-Prefixed S3 Hierarchy:** All raw evidence is isolated under opaque, tenant-scoped paths:
   `organizations/{orgId}/cases/{caseId}/artifacts/{evidenceId}.eml`.

---

## INPUT ➔ PROCESS ➔ OUTPUT Forensic Pipeline

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                            1. INPUT TIER                                             │
├────────────────────────────────┬───────────────────────────────────┬─────────────────────────────────┤
│ • Single Raw Email (.eml)      │ • Container Archive               │ • Gmail OAuth 2.0 Connector     │
│   - RFC 822 / RFC 5322 format  │   - mbox (RFC 4155)               │   - Read-only OAuth scope       │
│   - Up to 25 MiB payload       │   - multipart/digest (RFC 2046)   │   - AES-GCM state with PKCE     │
│   - Header, body, attachments  │   - Bare concatenated RFC 5322    │   - One-time bind & token crypto│
└────────────────────────────────┴───────────────────────────────────┴─────────────────────────────────┘
                                                  │
                                                  ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                           2. PROCESS TIER                                            │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A. INTAKE & INTEGRITY VERIFICATION (Server-Side Next.js)                                             │
│    • Validate size against MAX_EML_BYTES: 25 MiB (26,214,400 bytes)                                  │
│    • Calculate authoritative SHA-256 digest; timing-safe verification against client-claimed hash   │
│    • Commit raw payload to private S3 storage under tenant prefix with preflight hash checks         │
│    • Record evidence row in PostgreSQL (`pending` ➔ `stored` ➔ `verified`) with audit log           │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ B. CONTAINER SEGMENTATION (If Container Input)                                                       │
│    • Bounded, linear byte-scanning for message delimiters (RFC 4155 'From ', RFC 2046 boundary)     │
│    • Extract byte offsets, slice child messages, compute distinct child SHA-256 digests              │
│    • Transactionally write child evidence records with sequence numbers and batch associations      │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ C. ASYNCHRONOUS QUEUEING & EXECUTION (Dramatiq + Redis + Worker)                                     │
│    • Create analysis run record in DB (`accepted` ➔ `queued`)                                        │
│    • Dispatch job to Redis with `analysisRunId` as idempotency key                                  │
│    • Worker picks up job, verifies S3 preflight headers (size + SHA-256 match before streaming read) │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ D. PARSING & EXTRACTION (FastAPI Analyzer Core)                                                      │
│    • Bounded MIME tree traversal: depth <= 30, parts <= 200, headers <= 1000                         │
│    • Nested message extraction: RFC 822 attachments unnested up to depth 3                          │
│    • Indicator extraction: IPs, URLs, domains, sender/reply-to mismatches, attachment hashes         │
│    • Enrichment: GeoIP ASN lookup, AbuseIPDB reputation (fixture / offline / live mode with cache)   │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ E. DETERMINISTIC SCORING ENGINE (Ruleset v1.2.0)                                                     │
│    • Evaluate 10 categories: Headers, Auth, Routing, URL, Domain, IP, Attachment, Content,          │
│      Parser, Enrichment                                                                              │
│    • Every point contribution MUST reference concrete evidence refs (zero ungrounded scores)         │
│    • Score mapping: 0-10: BENIGN | 11-34: UNKNOWN | 35-69: SUSPICIOUS | 70-100: MALICIOUS           │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                  │
                                                  ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                           3. OUTPUT TIER                                             │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ • Interactive Case Dashboard: Categorized findings, hop-by-hop routing map, auth status tables       │
│ • Exportable Forensic Reports: Canonical JSON, sanitized printable HTML, plaintext forensic audit   │
│ • Structured Audit Trail: Actor ID, Action (`evidence.upload`, `analysis.start`), Resource, Time    │
│ • Complete Evidence Integrity Record: Retained SHA-256 digests, byte counts, and execution metadata │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Answers to SIH Judge Questions

### 1. Problem Statement

Modern enterprise and government communications are inundated by sophisticated email-based threats:
- **Business Email Compromise (BEC):** Display-name spoofing, subtle domain typosquatting, and manipulated `Reply-To` / `Return-Path` headers designed to deceive executive workflows.
- **Phishing & Credential Harvesters:** Anchor-text vs. hyperlink mismatches, obfuscated redirection chains, and weaponized attachments.
- **Container Evasion & Nested Attacks:** Embedding malicious payloads within attached `.eml` or `.msg` files (nested RFC 822) or delivering multi-email archives (mbox, zipped email batches) that bypass perimeter scanners.
- **The Forensic Investigation Bottleneck:** When an incident occurs, SOC tier-1/2 analysts and cyber-crime investigators must inspect raw MIME headers manually using ad-hoc text editors or untrusted third-party web tools.
- **Evidence Contamination Risk:** Existing tools often mutate message formatting, strip transport headers, leak confidential emails to external cloud APIs, or fail to establish a legally defensible chain of custody.

---

### 2. Importance & Why It Matters

- **Financial & National Security Impact:** Deceptive email, phishing, and business email compromise create measurable financial and operational losses. In the final presentation, cite one current official source and exact figure rather than using an unsupported statistic. Suitable sources include the [FBI IC3 annual reports](https://www.ic3.gov/AnnualReport/Reports), [Verizon DBIR](https://www.verizon.com/business/resources/reports/dbir/), and relevant [CERT-In publications](https://www.cert-in.org.in/).
- **Forensic Admissibility & Rigor:** Digital evidence gathered during incident response must withstand rigorous technical and procedural scrutiny, such as ISO/IEC 27037 guidance and applicable Indian statutory frameworks. Ad-hoc inspection that changes bytes or discards transport headers can compromise forensic integrity and evidentiary weight. MailSentinel provides technical controls; it does not itself guarantee admissibility.
- **Operational Scalability:** Large investigations require examining hundreds of emails or full mailbox exports. A bounded workbench can reduce repetitive manual inspection while preserving the original bytes, showing evidence references, and allowing offline enrichment where local data is available.

---

### 3. Proposed Solution

**MailSentinel** provides a prototype multi-tenant digital forensics workbench:
1. **Cryptographically Sound Evidence Ingestion:** Accepts single `.eml` files, bulk container archives, or direct Gmail API feeds. Calculates authoritative SHA-256 digests at the point of ingestion and stores files in a private, tenant-isolated S3 object store with preflight integrity checks.
2. **Deep MIME & Nested Parsing:** Unpacks complex RFC 822 MIME trees, recursively inspecting embedded `.eml` attachments up to configurable recursion bounds without crashing.
3. **Automated Multi-Message Container Segmentation:** Automatically detects and slices `mbox` files, bare RFC 5322 concatenations, and `multipart/digest` archives into discrete, SHA-256-verified child evidence records.
4. **Deterministic, Explainable Scoring Engine (v1.2.0):** Scores threat risk from 0 to 100 based on strict, deterministic forensic heuristics across 10 security categories. Every finding points directly to RFC headers, routing hops, or extracted byte offsets.
5. **Multi-Tenant Organization & Case Isolation:** Provides role-based access control (Owner, Investigator, Viewer) powered by Better Auth, ensuring complete segregation between organizations, cases, and forensic runs.
6. **Defensive Decision Support:** MailSentinel acts as an analyst multiplier, generating comprehensive forensic reports in HTML, JSON, and text with full audit trails.

---

### 4. Innovation & Unique Selling Propositions (USPs)

| Conventional Approaches (Spam Filters / Online Header Viewers) | MailSentinel Forensic Platform |
|---|---|
| **Black-box AI verdicts:** Generates opaque scores or LLM summaries with no verifiable proof, prone to hallucination. | **Deterministic, Evidence-Ref Grounded Scoring:** Ruleset v1.2.0 enforces that every score contribution must have concrete RFC header evidence references. |
| **Evidence mutation:** Opening emails in webmail or email clients mutates byte streams, recalculating checksums. | **Authoritative SHA-256 Intake:** Ingestion computes and verifies a SHA-256 digest at intake, enabling later integrity checks against the stored object. |
| **Monolithic parsing vulnerability:** Complex MIME bombs crash or exhaust memory on the main application server. | **Process-Isolated Parser with Hard Resource Caps:** Python parser runs in an isolated network tier with hard caps (depth <= 30, parts <= 200, headers <= 1000, 120s timeout). |
| **Single-email focus:** Unable to process mailbox exports or multi-message archives cleanly. | **Automated Container Segmentation:** Authoritative byte-offset segmentation for mbox (RFC 4155), bare concatenation, and multipart/digest (RFC 2046). |
| **Cloud leakage:** Free online header analyzers upload sensitive corporate communications to third-party servers. | **Air-Gappable Offline Mode:** Built-in offline mode (`ENRICHMENT_MODE=offline` or `fixture`) with local MaxMind GeoIP/ASN databases and zero outbound network calls. |
| **No chain of custody:** Missing audit records of who accessed or analyzed what evidence. | **Structured Audit Logging:** Core case, evidence, mailbox, analysis, and report actions record actor, organization, resource, timestamp, and safe metadata in PostgreSQL. |

---

### 5. Technology Choices & Architectural Rationale

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              TECHNOLOGY STACK JUSTIFICATION                            │
├───────────────────────┬───────────────────────┬────────────────────────────────────────┤
│ Layer                 │ Technology            │ Architectural Rationale                │
├───────────────────────┼───────────────────────┼────────────────────────────────────────┤
│ User Interface & API  │ Next.js 16 + React 19 │ High-performance server components,    │
│                       │ Node.js 22 LTS        │ server-only boundary isolation, lean   │
│                       │ TypeScript 5.9        │ Docker standalone builds.              │
├───────────────────────┼───────────────────────┼────────────────────────────────────────┤
│ API Communication     │ oRPC                  │ End-to-end type-safe RPC procedures    │
│                       │ (Typed Procedures)    │ guaranteeing zero contract drift       │
│                       │                       │ between client and server.             │
├───────────────────────┼───────────────────────┼────────────────────────────────────────┤
│ Identity & Tenancy    │ Better Auth           │ Battle-tested multi-tenant session and │
│                       │                       │ organization scoping; role-based RBAC. │
├───────────────────────┼───────────────────────┼────────────────────────────────────────┤
│ Forensic Engine       │ Python 3.12 + FastAPI │ Native RFC 822 parsing libraries, rich │
│                       │ Pydantic v2           │ cybersecurity tooling, strict typed    │
│                       │                       │ data contracts and schema validation.  │
├───────────────────────┼───────────────────────┼────────────────────────────────────────┤
│ Queue & Concurrency   │ Dramatiq + Redis 7    │ Low-latency, memory-efficient async    │
│                       │                       │ queue worker with idempotency keys     │
│                       │                       │ and bounded retries.                   │
├───────────────────────┼───────────────────────┼────────────────────────────────────────┤
│ Relational Store      │ PostgreSQL 17         │ ACID relational guarantees, composite  │
│                       │ Drizzle ORM           │ foreign keys for multi-tenancy, JSONB. │
├───────────────────────┼───────────────────────┼────────────────────────────────────────┤
│ Evidence Storage      │ MinIO (S3-Compatible) │ Dedicated raw file storage, private    │
│                       │                       │ bucket policies, S3 API preflight.     │
├───────────────────────┼───────────────────────┼────────────────────────────────────────┤
│ Mailbox Security      │ AES-256-GCM + PKCE    │ Authenticated AES-256-GCM encryption   │
│                       │                       │ for OAuth tokens & state with PKCE.    │
└───────────────────────┴───────────────────────┴────────────────────────────────────────┘
```

---

### 6. Step-by-Step Technical Workflow

#### Phase 1: Intake & Chain of Custody Establishment
1. An investigator uploads an `.eml` or container archive via the web UI.
2. The server-side Next.js endpoint receives the file stream, enforcing `MAX_EML_BYTES: 25 MiB` (26,214,400 bytes) or `MAX_CONTAINER_BYTES: 100 MiB` (104,857,600 bytes).
3. The server computes the authoritative SHA-256 digest using Node's cryptographic streaming engine.
4. The file is uploaded to the private S3 evidence bucket under:   `organizations/{orgId}/cases/{caseId}/artifacts/{evidenceId}.eml`.
5. An evidence metadata row is inserted into PostgreSQL with status `verified`, storing the exact byte count, SHA-256 digest, and a structured audit event (`evidence.uploaded`).

#### Phase 2: Container Segmentation (If Applicable)
1. If the uploaded evidence is an archive (mbox, digest, or concatenated stream), the investigator triggers batch segmentation.
2. The web tier calls the private FastAPI `/segmentation` endpoint.
3. The analyzer performs bounded byte slicing, identifying message boundaries and extracting child offsets.
4. The web tier validates returned offsets and digests, slices the child `.eml` files, uploads each to S3, and transactionally registers child evidence records tied to the ingestion batch.

#### Phase 3: Forensic Analysis & Dispatch
1. When analysis is triggered, the web tier generates an `analysisRunId` and records an `accepted` run in PostgreSQL.
2. A task is published to the Redis-backed Dramatiq queue (`process_analysis`).
3. The Dramatiq worker claims the job and sets the run status to `processing`.
4. **S3 Preflight Verification:** Before reading the file body, the worker executes a `HEAD` request to verify that the object's `ContentLength` and S3 metadata digest match expected database values. If mismatched, the job aborts immediately with `evidence_digest_mismatch`.

#### Phase 4: Extraction, Enrichment & Scoring
1. **Parsing:** The worker parses the RFC 822 MIME structure within hard bounds (depth <= 30, parts <= 200, headers <= 1000). Nested `.eml` messages are extracted and analyzed up to depth 3.
2. **Extraction:** Headers (`From`, `To`, `Subject`, `Message-ID`, `Date`), transit hops (`Received:` chain), authentication results (SPF, DKIM, DMARC), hyperlinks, anchor texts, and attachment metadata are extracted.
3. **Enrichment:** Extracted IPs and domains are enriched against GeoIP/ASN databases and reputation caches.
4. **Scoring Rules (v1.2.0):** Deterministic rules assess risk points:
   - **Headers:** Display-name spoofing, `Reply-To` / `From` domain mismatches, synthetic `Message-ID`.
   - **Authentication:** SPF/DKIM/DMARC failures, domain alignment failures.
   - **Routing:** Hops with inverted timestamps, unexpected private IP relaying.
   - **Content & URLs:** Link text vs href destination mismatches, high-risk TLDs, IP-literal URLs.
   - **Attachments:** Executable extensions disguised via double-extensions or archive wrapping.
5. Every rule violation generates a `Finding` object with category, severity, points, explanation, and `evidence_refs`.

#### Phase 5: Finalization & Reporting
1. The worker computes the final aggregate score (0–100) and maps it to a categorical verdict (`BENIGN`, `UNKNOWN`, `SUSPICIOUS`, `MALICIOUS`).
2. The complete analysis snapshot is persisted to PostgreSQL, and status updates to `completed`.
3. The investigator views findings in the interactive dashboard or exports a standalone, sanitized forensic report in HTML, JSON, or text format.
4. A structured audit record (`analysis.completed`) is recorded in PostgreSQL.

---

### 7. Measurable Impact & Demo Benchmark Metrics

In compliance with forensic rigor, MailSentinel avoids fabricated claims (such as "99.9% AI accuracy"). Instead, impact is demonstrated through **verifiable, reproducible engineering metrics**:

| Evaluation Parameter | Measured Benchmark / Operational Standard | Verification Method |
|---|---|---|
| **Intake Integrity Verification** | Authoritative preflight SHA-256 computed and verified via Node.js crypto stream [insert a benchmark measured by the team on the demo computer] | Measured via Node.js crypto stream timing |
| **Deep MIME Traversal Latency** | Full parse, indicator extraction & scoring completed in **[insert measured value, e.g. 1.2s]** | Measured via worker execution timestamps |
| **Container Segmentation Throughput** | 50-message mbox container segmented, verified, and ingested in **[insert measured value, e.g. 4.8s]** | Measured via batch ingestion procedure |
| **Resource & DoS Protection** | Strict memory ceilings: Max 25 MiB EML, 200 MIME parts, 30 recursion depth, 120s watchdog | Enforced by schema validators & unit tests |
| **Cross-Tenant Data Isolation** | Strict tenant isolation enforced at repository, storage key, and oRPC procedure boundaries | Verified via automated multi-tenant authorization and RBAC test suites [insert verified test suite reference / count] |
| **Automated Test Coverage** | **542 recorded passing automated tests** across web (311), analyzer (151), and database (80) suites (recorded verification run) | Verified via Vitest and pytest test runners |
| **Forensic Chain of Custody** | Deterministic rule schema requires concrete RFC evidence references for findings; core investigative actions generate structured audit records | Validated by Pydantic model schemas and PostgreSQL audit logging |

---

### 8. Feasibility: Technical, Financial, Operational

#### Technical Feasibility
- **Production Architecture in Monorepo:** Built using modern TypeScript and Python standards, with Turborepo managing `@mailsentinel/web`, `@mailsentinel/analyzer`, `@mailsentinel/db`, `@mailsentinel/contracts`, `@mailsentinel/auth`, and `@mailsentinel/ui`.
- **Contract Drift Prevention:** Shared OpenAPI contracts automatically generate TypeScript schemas, preventing API mismatches across languages.
- **Fail-Closed Design:** Startup validators reject boot if secrets are weak (e.g. `BETTER_AUTH_SECRET` < 32 chars, `ANALYZER_SERVICE_TOKEN` < 16 chars) or if configuration is invalid.

#### Financial Feasibility (Team Cost Estimates — Subject to Provider & Usage)
*MailSentinel avoids claiming unrealistic "free tier" production hosting. Below are preliminary team estimates for an indicative baseline cloud deployment based on entry-level provider pricing as of 2026. Actual costs will vary depending on cloud provider, region, ingestion bandwidth, and retention policies:*

| Resource | Service / Specifications | Estimated Monthly Cost |
|---|---|---|
| **Application & Worker Compute** | 1x Dedicated Cloud VM (4 vCPU, 8 GB RAM) running Docker Compose or Kubernetes | ~$40.00 – $60.00 |
| **Relational Database** | Managed PostgreSQL 17 (e.g., AWS RDS or DigitalOcean Managed DB) with automated daily backups | ~$25.00 – $45.00 |
| **Evidence Storage** | S3-compatible Object Storage (e.g., AWS S3 Standard or Cloudflare R2) for 100 GB evidence & logs | ~$2.50 – $15.00 |
| **Domain & Edge Security** | Cloudflare Free / Pro Tier (TLS termination, DDoS protection, Cloudflare Tunnel) | $0.00 – $20.00 |
| **Threat Intelligence API** | AbuseIPDB Free Tier (1,000 queries/day) or Starter Tier | $0.00 – $30.00 |
| **Total Estimated Operating Cost** | **Indicative baseline only; obtain current provider quotes** | **[insert current INR/USD estimate]** |

*For local evaluation and hackathon demonstrations, MailSentinel runs on Docker Compose without mandatory paid cloud dependencies. Production operation would still require investment in compute, backups, monitoring, and secure storage.*

#### Operational Feasibility
- **Offline deployment path:** The analyzer supports `ENRICHMENT_MODE=fixture` or `offline`; a fully disconnected installation must pre-stage container images and any local MaxMind or reputation data.
- **Single-Command Operations:** Entire stack boots via `pnpm infra:start` or `docker compose up -d`. Backup scripts (`pg_dump` and S3 replication) allow straightforward disaster recovery.

---

### 9. Testing, Verification & Quality Assurance

MailSentinel maintains an automated test suite comprising **542 recorded passing tests** across web, analyzer, and database suites (recorded verification run):

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               AUTOMATED TEST VERIFICATION                              │
├────────────────────────┬───────────────┬───────────────────────────────────────────────┤
│ Test Suite             │ Passing Tests │ Focus Areas Covered                           │
├────────────────────────┼───────────────┼───────────────────────────────────────────────┤
│ Application & Server   │ 311 passed    │ Better Auth, oRPC endpoints, tenant           │
│ (Vitest)               │ (21 files)    │ isolation, S3 evidence storage, Gmail OAuth,  │
│                        │               │ AES-256-GCM token crypto, audit recording.    │
├────────────────────────┼───────────────┼───────────────────────────────────────────────┤
│ Python Analyzer        │ 151 passed    │ RFC 822 MIME parsing, container segmentation, │
│ (pytest)               │ (18 files)    │ nested extraction, indicator rules v1.2.0,    │
│                        │               │ Dramatiq worker idempotency, OpenAPI export.  │
├────────────────────────┼───────────────┼───────────────────────────────────────────────┤
│ Database & Repository  │ 80 passed     │ PostgreSQL schema, Drizzle ORM repositories,  │
│ (Vitest + Postgres)    │ (3 files)     │ composite foreign keys, atomic batch counters.│
├────────────────────────┼───────────────┼───────────────────────────────────────────────┤
│ Total Recorded Tests   │ 542 passed    │ Clean test execution across web, analyzer, db │
└────────────────────────┴───────────────┴───────────────────────────────────────────────┘
```

*Verification Context: Test counts reflect the 542 currently recorded passing tests across the web (311 tests, 21 files), analyzer (151 tests, 18 files), and database (80 tests, 3 files) suites. Note that this counts these specific verified test suites rather than claiming all repository test paths if not all run simultaneously in every environment.*

#### Adversarial Security Testing (`test_adversarial_reproductions.py`)
- **Decompression Bombs & Deep MIME Nesting:** Tested against deeply nested MIME recursion; safely rejected by `max_mime_depth=30`.
- **Header Flooding Attacks:** Tested against payloads containing thousands of synthetic headers; capped by `max_header_count=1000`.
- **S3 Preflight Tampering:** Validated that modified byte lengths or altered S3 metadata digests are fast-rejected before streaming bytes.
- **Linear Boundary Scanning:** Container segmentation uses bounded linear regex searches, avoiding ReDoS (Regular Expression Denial of Service).
- **Timing-Safe Crypto:** Token and hash comparisons utilize constant-time comparison (`timingSafeEqual`) to prevent side-channel timing attacks.

---

### 10. Scaling Strategy & Architecture Evolution

1. **Horizontal Worker Scaling:** Dramatiq workers are stateless. As analysis volume surges, multiple worker instances can be spun up across nodes, pulling tasks concurrently from the central Redis queue.
2. **Read/Write Database Segregation:** Deploy PostgreSQL with streaming replication; analytical case search and report viewing utilize read replicas, while write traffic is directed to the primary instance.
3. **Storage Tiering:** S3 lifecycle policies automatically transition archived evidence older than 90 days (`RETENTION_DAYS`) from high-performance storage to lower-cost cold storage (e.g., S3 Glacier Flexible Retrieval).
4. **Partitioned Ingestion:** Large enterprise mailbox dumps (tens of thousands of emails) are partitioned into concurrent worker batches, with progress tracked atomically in PostgreSQL.

---

### 11. Honest Limitations & Operational Boundaries

To maintain technical integrity before judges, the following prototype boundaries are explicitly acknowledged:

1. **Decision Support, Not Autonomous Legal Verdict:** MailSentinel categorizes threat indicators and scores risk, but does not claim to replace certified digital forensics experts in court.
2. **Mailbox Connector Scope:** Currently, live mailbox synchronization is implemented for **Google Workspace / Gmail (Read-Only OAuth)**. Direct Microsoft 365 Graph API, Exchange Web Services (EWS), and IMAP/POP3 connectors are planned roadmap milestones.
3. **Dependency on Backing Storage:** The platform requires healthy PostgreSQL, Redis, and S3-compatible instances; it is not a serverless, stateless utility.
4. **No Unverifiable "AI" Guarantees:** MailSentinel does not claim a generic "99.9% machine learning accuracy" because it does not rely on a black-box neural network that can hallucinate evidence. It relies on deterministic, RFC-grounded heuristics where every finding is auditable.
5. **Single-Node Local Harness:** The current Docker Compose configuration is tuned for single-node developer and hackathon demonstration environments; production enterprise deployment requires external TLS termination, KMS secret injection, and automated off-site backups.

---

### 12. Prize-Money Utilization & Roadmap

If awarded Smart India Hackathon prize funding, the allocation will directly advance MailSentinel from a functional prototype to an enterprise-grade national cyber-defense asset:

| Milestone / Objective | Funding Share | Key Deliverables |
|---|---|---|
| **1. Enterprise Connector Suite** | 30% | Develop Microsoft 365 (Graph API), Exchange Online, and generic IMAP4/POP3 connectors with incremental sync. |
| **2. Cryptographic Non-Repudiation** | 25% | Integrate RFC 3161 Trusted Timestamping Authority (TSA) and digital signature verification to strengthen forensic chain-of-custody documentation. |
| **3. Sandboxed Detonation Engine** | 20% | Implement microVM-isolated attachment sandbox detonation (evaluating macros, PDFs, and binaries in isolated ephemeral VMs). |
| **4. Cloud Staging & Security Audit** | 15% | Deploy a multi-node Kubernetes staging cluster on sovereign Indian cloud infrastructure and conduct third-party CREST-certified penetration testing. |
| **5. Law Enforcement & SOC Toolkit** | 10% | Build custom export adapters for CERT-In incident reporting formats, MISP, and STIX/TAXII threat intelligence sharing. |

---

## 3-Minute SIH Presentation Script & Timeline

*Use this exact script for a sharp, confident, time-bounded 3-minute pitch:*

### ⏱️ 0:00 – 0:30 | The Hook & The Problem
- **Spoken Script:**
  *"Respected judges, deceptive email and phishing threats remain primary initial access vectors in enterprise cyber incidents. In corporate breaches and cybercrime investigations, the biggest bottleneck isn't knowing that an incident happened—it's analyzing what happened without contaminating evidence. Today, investigators either rely on black-box AI tools that can hallucinate, or they manually copy-paste raw email headers into unverified web tools, compromising forensic integrity. We built MailSentinel to address this challenge."*
- **Visual Action:** Display the MailSentinel login screen, transition to the Case Dashboard.

### ⏱️ 0:30 – 1:15 | The Solution & Architecture
- **Spoken Script:**
  *"MailSentinel is a multi-tenant digital email forensics platform prototype. It combines a Next.js 16 frontend, a private Python 3.12 parsing engine, an asynchronous Dramatiq worker queue, PostgreSQL, and private S3 evidence storage. When an email enters MailSentinel, we immediately compute and verify its authoritative SHA-256 hash. The raw email is stored under tenant-isolated paths with preflight checks, and the browser never interacts directly with storage or the parser. Key actions are recorded in an actor-attributed audit trail."*
- **Visual Action:** Point out the Trust Boundary diagram and upload a safe sample `.eml` file; highlight the `verified` status and SHA-256 checksum.

### ⏱️ 1:15 – 2:15 | The Core Innovation & Live Analysis
- **Spoken Script:**
  *"Here is our core innovation: First, multi-message container segmentation. MailSentinel can automatically slice complex mbox or concatenated archives into discrete, cryptographically verified emails. Second, deterministic, explainable scoring. Notice this analysis run: our Ruleset v1.2.0 evaluates 10 categories—from SPF/DKIM alignment and routing anomalies to hidden link mismatches. Unlike black-box LLMs, our engine enforces that score contributions cite concrete RFC header evidence. An elevated threat score isn't an arbitrary guess—it's directly backed by observable indicators, such as this spoofed display name and this hop timestamp anomaly."*
- **Visual Action:** Click into the Analysis Results. Show the 10-category breakdown, expand a Finding to show its concrete `evidence_refs`, and show the hop-by-hop `Received:` routing path.

### ⏱️ 2:15 – 2:45 | Engineering Rigor & Feasibility
- **Spoken Script:**
  *"Engineering rigor is at the heart of our project. We have 542 recorded passing automated tests across our web, analyzer, and database suites (311 web, 151 analyzer, 80 database). We have battle-tested our parser against decompression bombs, header flooding, and S3 tampering attacks. The analyzer also supports an offline/fixture mode; a fully disconnected deployment must pre-stage container images, dependencies, and local data resources."*
- **Visual Action:** Briefly show the terminal running test suites showing 542 passing tests (web: 311, analyzer: 151, database: 80) or show the exported HTML forensic report.

### ⏱️ 2:45 – 3:00 | Impact & Conclusion
- **Spoken Script:**
  *"MailSentinel turns hours of manual, error-prone email forensics into an auditable, evidence-backed investigative workflow. It is modular, reproducible, and ready for demonstration. Thank you, and we look forward to your questions!"*

---

## Likely Judge Follow-Up Questions & Model Answers

### Q1: "Why did you use deterministic rules instead of an LLM or Machine Learning model?"
**Answer:** In digital forensics, **explainability and technical reproducibility are essential**. Black-box neural models can hallucinate and cannot readily prove the exact byte-level basis for their conclusions under cross-examination. Our Ruleset v1.2.0 requires rule findings to link to concrete RFC evidence (e.g., specific header mismatches, cryptographic DKIM failures). We use automation for parsing and indicator extraction, while keeping scoring rules deterministic and systematically auditable.

### Q2: "How do you protect the system from malicious emails, like decompression bombs or parser exploits?"
**Answer:** We enforce zero-trust defense-in-depth:
1. Hard resource limits: Maximum 25 MiB file size, maximum 30 MIME recursion depth, maximum 200 MIME parts, and 1,000 headers.
2. The Python analyzer runs in an isolated network tier with no public ingress and a 120-second watchdog timeout.
3. Streaming reads verify object size and SHA-256 preflight headers before reading bytes into memory.
4. Attachments are never executed or rendered as active HTML/scripts.

### Q3: "How does MailSentinel support chain-of-custody documentation?"
**Answer:** Chain of custody requires documenting evidence provenance and integrity from acquisition onward. MailSentinel supports this workflow by:
1. Calculating the authoritative SHA-256 digest on the server at the instant of ingestion.
2. Storing raw evidence in a private S3 bucket under strict tenant prefixes with preflight hash and size verification.
3. Ensuring the database links analysis runs directly to the original evidence SHA-256 digest.
4. Recording investigative lifecycle actions (evidence upload, analysis dispatch, completion, report export) in a structured PostgreSQL audit table with actor ID, organization ID, timestamp, and metadata.

*Scope Clarification:* The platform provides technical controls (cryptographic hashing, access controls, audit logs) to assist analysts in establishing chain of custody; however, the software itself does not guarantee legal admissibility or provide physical hardware-level object immutability, which remain the responsibility of institutional forensic processes and storage configurations.

### Q4: "What happens if an organization connects Gmail? Can tokens leak?"
**Answer:** MailSentinel uses the principle of least privilege. We request **read-only** Gmail OAuth scopes (`gmail.readonly`). Refresh tokens are encrypted using **AES-256-GCM** with a dedicated 32-byte key before being stored in PostgreSQL. The OAuth exchange enforces PKCE, and the authorization state is an authenticated AES-256-GCM encrypted payload containing a one-time nonce, code verifier, and timestamp, bound to a one-time cookie to prevent CSRF and replay attacks without requiring a separate signature.

### Q5: "What makes this different from an email gateway like Proofpoint or Mimecast?"
**Answer:** Email gateways are perimeter defenses designed to block or quarantine inbound mail at the MX record. **MailSentinel is an investigative forensics workbench**. It is used after an incident occurs, when an employee reports a suspicious message, or during deep investigations involving exported mailboxes, disk forensics, or law enforcement seizures. We provide deep, hop-by-hop forensic deconstruction rather than inline drop/allow decisions.

### Q6: "Can MailSentinel be deployed in an air-gapped environment?"
**Answer:** Yes. By setting `ENRICHMENT_MODE=offline` or `fixture`, MailSentinel disables all external API calls. GeoIP and ASN resolutions are performed against local, container-mounted MaxMind `.mmdb` files, allowing complete deployment within secure, air-gapped government, defense, or banking enclaves.

---

## Final Judge & Demo Pre-Flight Checklist

Before presenting to judges, verify each item on this checklist:

- [ ] **Docker Containers Healthy:** Run `docker compose -f infra/compose.yaml ps` and confirm `web`, `analyzer`, `worker`, `postgres`, `redis`, and `minio` are running and healthy.
- [ ] **Database Migrated & Seeded:** Confirm demo user `demo@mailsentinel.local` can authenticate.
- [ ] **Web Interface Accessible:** Verify <http://localhost:3000> opens cleanly with the login screen.
- [ ] **MinIO Console Available:** Verify <http://localhost:9001> is accessible on host loopback.
- [ ] **Automated Tests Verified:** Confirm recorded test suites pass (542 passing tests across web 311, analyzer 151, and database 80, recorded verification run).
- [ ] **Safe Sample Email Prepared:** Have `sample_phish.eml` or a synthetic test fixture ready on your desktop for immediate drag-and-drop.
- [ ] **Browser Tabs Pre-Opened:**
  - Tab 1: MailSentinel Cases Dashboard (<http://localhost:3000>)
  - Tab 2: MinIO Storage Browser (<http://localhost:9001>)
  - Tab 3: Terminal window showing container logs (`docker compose -f infra/compose.yaml logs -f web analyzer worker`)

---

## How to Demonstrate the Prototype (Step-by-Step Runbook)

### 1. Booting the Stack

Run the automated helper script to start backing services, run migrations, seed initial accounts, and boot the web and analyzer runtimes:

```bash
# Start full stack and run migrations/seeds
pnpm infra:start

# Confirm all services pass health checks
pnpm infra:wait
```

*(Alternatively, using Docker Compose directly:)*
```bash
docker compose -f infra/compose.yaml up -d --build
docker compose -f infra/compose.yaml run --rm seed
```

### 2. Signing In

1. Navigate to: **<http://localhost:3000>**
2. Enter the default seeded demo credentials:
   - **Email:** `demo@mailsentinel.local`
   - **Password:** `MailSentinel-Demo-2026!`
3. Click **Sign In**. You will enter the authenticated tenant workspace.

### 3. Creating an Investigation Case

1. Click **Cases** in the top navigation bar.
2. Click **New Case**.
3. Enter:
   - **Title:** `INC-2026-09: Executive Impersonation Investigation`
4. Click **Create Case**. The case overview page will open.

### 4. Uploading & Verifying Evidence

1. Under the case page, click **Upload Evidence**.
2. Select or drag-and-drop a sample `.eml` file.
   *(You can use the safe synthetic sample provided below)*.
3. Observe the client computing the SHA-256 hash and sending the payload to the server.
4. Note that the evidence is immediately listed with:
   - Status: **`verified`**
   - Size: Exact byte count
   - SHA-256 Digest: 64-character hexadecimal checksum
5. Open the MinIO console at `http://localhost:9001` (User: `mailsentinel`, Password: `mailsentinel-local-secret`) to show judges that the raw file is stored in `mailsentinel-evidence` under an opaque tenant path.

### 5. Running Forensic Analysis

1. Click **Start Analysis** next to the uploaded evidence.
2. Observe the real-time status progression:
   - `accepted` ➔ `queued` (Dispatched to Dramatiq/Redis)
   - `processing` (Claimed by worker, preflight S3 checks passed)
   - `completed` (MIME parsed, indicators extracted, rules applied)
3. Click into the completed **Analysis Run**.

### 6. Inspecting Forensic Findings

Showcase the depth of the forensic engine to the judges:
- **Verdict & Risk Score:** Review the computed score and categorical verdict (for high-risk indicators, typically expected in the SUSPICIOUS or MALICIOUS range under default thresholds, subject to rule triggering) and confidence score.
- **Finding Categories:** Show the 10 distinct observation categories (Headers, Authentication, Routing, URLs, Attachments).
- **Explainability Proof:** Click any finding (e.g., `AUTH_SPF_FAIL` or `LINK_TEXT_MISMATCH`) and show that it cites specific RFC header lines or extracted URLs.
- **Hop-by-Hop Transit Map:** Show the reconstructed `Received:` header sequence with relay hosts, IPs, and transit timestamps.

### 7. Generating Forensic Reports & Audit Verification

1. Click **Export Report** and select **HTML Report**.
2. Display the clean, executive-ready, sanitized report containing executive summaries, full findings tables, and explicit forensic limitations.
3. Navigate to **Audit Records** (or query the PostgreSQL `audit_records` table) to show that key investigative actions—case creation, file upload, and analysis execution—are recorded in a structured audit trail with actor timestamps.

---

## Sample Safe Demonstration Email (`sample_phish.eml`)

You can save the following text block as `sample_phish.eml` on your presentation laptop to demonstrate detection of display-name spoofing, SPF failure, and URL mismatches safely without live malicious code:

```email
From: "CEO Internal Alert" <attacker@spoofed-domain-external.com>
To: victim@company.local
Subject: URGENT: Wire Transfer Authorization Required
Date: Wed, 03 Sep 2026 14:32:00 +0530
Message-ID: <synthetic-threat-001@spoofed-domain-external.com>
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8
Received: from mail.spoofed-domain-external.com (198.51.100.25)
    by mx.company.local with ESMTP id ABC12345
    for <victim@company.local>; Wed, 03 Sep 2026 14:32:05 +0530
Authentication-Results: mx.company.local;
    spf=fail (sender IP 198.51.100.25) smtp.mailfrom=attacker@spoofed-domain-external.com;
    dkim=none;
    dmarc=fail (p=reject) header.from=company.local

<!DOCTYPE html>
<html>
<body>
<p>Team,</p>
<p>Please review and approve the attached invoice immediately:</p>
<p><a href="http://198.51.100.99/login-secure">https://portal.company.local/finance-invoice</a></p>
<p>Regards,<br>Executive Management</p>
</body>
</html>
```

### Expected Analyzer Detections in this Sample (To Verify During Demo):
1. **SPF / DMARC Failure:** Detection of `spf=fail` and `dmarc=fail` within the `Authentication-Results` header.
2. **Display-Name Spoofing:** Flagging of high-privilege executive display name (`"CEO Internal Alert"`) paired with an external sender domain.
3. **Anchor vs. Link Destination Mismatch:** Discrepancy between visible anchor text (pointing to `portal.company.local`) and target `href` (IP literal `198.51.100.99`).
4. **Expected Outcome to Verify:** These indicators are intended to exercise the relevant Ruleset v1.2.0 heuristics. Verify the actual findings, score, and verdict during execution rather than promising a predetermined classification.

---

## Verification & Cleanliness Summary

- **Repository Stability:** Zero modifications were made to application source code or active UI features during the creation of this dossier.
- **Monorepo Test Status:** 542 recorded passing automated tests across web (311), analyzer (151), and database (80) suites (recorded verification run).
- **Use & Compliance:** Built for Smart India Hackathon evaluation as an inspectable defensive digital-forensics prototype; deployment must follow the host organization's legal, privacy, and evidence-handling requirements.

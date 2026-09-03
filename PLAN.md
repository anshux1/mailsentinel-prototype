# MailSentinel product implementation plan

This document defines the remaining-work plan for MailSentinel. Implementation proceeds in this strict order:

1. **Python analyzer completion and hardening** (Part 1 follow-up: P4–P8) — **complete**
2. **oRPC/application-server implementation** (Part 2: S1–S8) — **complete**
3. **UI/frontend implementation** (Part 3) — **complete**

All three parts are complete; Parts 1 and 2 passed their acceptance gates before the frontend was built. Contract changes must be completed and regenerated before dependent implementation is merged.

> **Docker exclusion:** Docker, Compose, container images, and infrastructure runtime scripts are outside this plan. Do not modify `infra/compose.yaml`, `infra/scripts/**`, or `apps/analyzer/Dockerfile` while implementing Parts 1 and 2 unless a separate task explicitly authorizes it.

---

## 0. Completed and verified checkpoints

The foundation and complete Part 1 analyzer pipeline are verified with automated test suites passing:

- **Analyzer contracts & schema sync (`P1`):** Versioned Pydantic domain models with camelCase JSON aliases and field bounds, OpenAPI export, synchronized TypeScript definitions, and contract fixtures.
- **S3 evidence retrieval & verification (`P2`):** `EvidenceStore` and `S3EvidenceStore` enforce strict tenant/case key validation, metadata preflight checks, bounded streaming reads, and constant-time SHA-256 verification.
- **Safe RFC 5322 & MIME parser (`P3`):** Bounded iterative parsing enforces byte, header, MIME part, nesting, and attachment limits, with safe filename sanitization, non-rendering HTML text extraction, and parser warnings.
- **Richer forensic extraction (`P4`):** Identity/display-name spoofing, UTC date and Message-ID validation, expanded reported authentication headers/conflicts, routing transitions/latency anomalies, social-engineering indicators, and HTML link mismatches.
- **Offline/live enrichment and cache (`P5`):** File-backed/MaxMind offline lookup, opt-in AbuseIPDB lookup, bounded timeouts/request count/concurrency, deterministic in-memory/Redis-compatible caching, typed response sanitization, and private/reserved IP protection.
- **Explainable scoring and calibration (`P6`):** Ruleset v1.1.0 covers the richer observations and enrichment signals with typed evidence-backed findings, deterministic ordering, benign reductions, thresholded verdicts, and score clamping to 0–100.
- **Analyzer persistence, audit, and status (`P7`):** PostgreSQL/in-memory lifecycle repositories provide atomic claims, stuck-run recovery, idempotent result writes, append-only lifecycle audit events, and phase/progress reporting. Migrations `0002_great_miss_america.sql` and `0003_chunky_captain_midlands.sql` are included; relational findings remain optional for the Part 2 schema review.
- **Worker hardening and protected intake (`P8`):** Enqueue-once intake, structured PII-safe JSON logs, watchdog timeouts, retryable/terminal failure handling, and bearer-protected status/result endpoints.
- **Verification:** 132 analyzer tests pass (with 1 known upstream Starlette deprecation warning), alongside root lint, typecheck, tests, environment checks, analyzer Ruff/mypy checks, contract regeneration/drift tests, database checks, and a production build with required environment variables.

---

## Part 1 — Python analyzer follow-up — **complete**

### 1.1 Delivered objective and boundary

The analyzer under `apps/analyzer` now includes the richer forensic extraction, bounded offline/live enrichment, follow-up scoring and benign calibration, lifecycle persistence/audit/status support, and worker hardening described in P4–P8. Part 1 is complete; future relational findings beyond the JSONB snapshot are deferred to the Part 2 schema review if application queries require them.

**Security boundaries preserved:**
- No browser-facing endpoints; only private service intake.
- No raw email HTML rendering or browser execution.
- No execution of attachments, macros, or scripts.
- No fetching URLs found in emails.
- No LLM-generated verdicts or opaque ML models.
- Never claim SPF, DKIM, or DMARC was independently verified when only parsing reported headers.
- Never log raw message bodies, credentials, tokens, or attachment contents.

---

### Phase P4 — Richer forensic extraction — **complete**

Implemented and covered by extraction and adversarial regression tests.

#### Scope
- **P4.1 Canonical identity, date, and display-name extraction:**
  - Detect display-name vs address inconsistencies (e.g., display name claiming an executive or brand identity while address domain differs).
  - Parse canonical `Date` header safely into UTC; detect anomaly signals (invalid date syntax, future timestamps, or implausibly stale dates compared to `Received` hop timestamps).
  - Validate canonical `Message-ID` syntax and domain consistency against sender domains.
- **P4.2 Fuller authentication observations:**
  - Parse additional standard authentication headers (`Received-SPF`, `ARC-Authentication-Results`, and `DKIM-Signature` identity/algorithm tags).
  - Detect and flag conflicting reported outcomes across multiple authentication headers.
- **P4.3 Fuller routing observations:**
  - Detect suspicious routing anomalies: private-to-public hop transitions and implausible multi-hop latency jumps.
  - Flag missing or truncated upstream routing hops as observations.
- **P4.4 Content observations:**
  - Extract bounded, deterministic social-engineering indicators from text without LLM classification (urgent language, credential harvesting prompts).
  - Detect HTML display text vs `href` link target mismatches (e.g., link text displays `https://legitimate.example` while `href` points to a different domain).
  - Enforce hard bounds; never store unrestricted raw body content in findings or logs.

#### Tests & validation
- Unit tests for display-name spoofing, canonical date parsing, and date anomaly detection.
- Multi-header authentication conflict tests.
- Routing transition and latency jump tests.
- HTML link text vs `href` mismatch tests.
- Verify all extraction remains fully deterministic and performs zero network lookups.

---

### Phase P5 — Live and offline enrichment adapters with cache — **complete**

Implemented with offline-first defaults, explicit live opt-in, and mocked provider/cache tests.

#### Scope
- **Offline adapter:**
  - Local lookup adapter for configured offline databases (MaxMind GeoIP / ASN or file-backed reputation datasets).
  - Return ASN, country, and local reputation observations deterministically without network connections.
- **Live adapter (`ENRICHMENT_MODE=live`, e.g., AbuseIPDB):**
  - Validate API credentials and configuration at startup.
  - Enforce strict connect (<= 2s) and read (<= 3s) timeouts.
  - Bound maximum external requests per analysis and overall concurrency.
  - Gracefully handle provider rate limiting (HTTP 429).
- **Indicator cache:**
  - In-memory or Redis-backed indicator cache with deterministic cache keys and configured TTL semantics to prevent redundant provider lookups.
- **Security & degraded mode:**
  - Never submit full URLs containing credentials, query secrets, or raw email content.
  - Never query reputation providers for private, loopback, or reserved IP addresses.
  - Validate and sanitize external provider responses into typed internal schemas before use.
  - Provider timeouts, rate limits, or connectivity failures must result in partial enrichment with reduced confidence, never a failed analysis or an automatic malicious verdict.

#### Tests & validation
- Offline database lookup tests.
- Live adapter tests using mocked HTTP responses (timeouts, rate limits, malformed payloads).
- Cache hit/miss and TTL expiration tests.
- Assert private and reserved IPs are never sent to external providers.
- Verify core analysis succeeds deterministically when external enrichment is disabled or unavailable.

---

### Phase P6 — Follow-up scoring rules and benign calibration — **complete**

Implemented in deterministic ruleset v1.1.0 with threshold, clamping, determinism, and evidence-reference coverage tests.

#### Scope
- **Rules for richer P4 observations:**
  - Display-name spoofing and brand impersonation findings.
  - Date anomalies (future date, stale date, date/routing timestamp mismatch).
  - Conflicting authentication headers finding.
  - Routing private-to-public transition finding.
  - Content indicators: credential harvesting prompt and HTML display-text vs href mismatch findings.
- **Rules for P5 observations:**
  - Offline ASN / high-risk country observations.
  - Live reputation provider findings with source attribution.
- **Benign evidence calibration:**
  - Explicit benign score reduction rules (e.g., passing SPF + DKIM + DMARC alignment from trusted declaring host reduces risk score) with strict bounds preventing negative scores.
  - Missing enrichment or missing headers must never default to a malicious verdict.

#### Tests & validation
- Unit tests for each new scoring rule.
- Synthetic benign, suspicious, and malicious message fixtures cover the new rules.
- Threshold boundary and score clamping (0–100) tests.
- Determinism test: identical input yields byte-identical result snapshot.
- Every finding must contain an explanation and supporting evidence reference.

---

### Phase P7 — Relational findings, audit, and status support — **complete**

Lifecycle persistence, append-only audit events, stuck-run recovery, and phase/progress status reporting are implemented. Relational findings/indicators remain intentionally deferred to S1 unless Part 2 query requirements need them.

#### Scope
- **Relational persistence:**
  - Implement relational persistence for queryable findings or indicators if application-facing queries require them beyond the JSONB snapshot.
- **Audit recording:**
  - Add append-only audit event logging for worker lifecycle events (run claimed, completed, failed, recovered).
- **Status reporting:**
  - Expose progress phase reporting if polled directly during processing.

#### Tests & validation
- Concurrent claim tests against PostgreSQL verifying exactly one worker claims a run.
- Worker stuck-run recovery test after configured timeout.
- Idempotent result write test with identical and mismatched version snapshots.
- Safe failure recording without leaking raw exception details.

---

### Phase P8 — Worker hardening, structured logging, and enqueue-once intake — **complete**

Implemented with protected HTTP reads, PII-safe JSON logging, watchdog timeouts, and duplicate-delivery/idempotency tests.

#### Scope
- **True enqueue-once intake path:**
  - Update `POST /v1/analyses` to enforce intake idempotency: check if run is already queued/active or use an idempotency key before enqueueing to prevent duplicate broker messages.
- **Structured JSON logging:**
  - Implement structured JSON logging across the analyzer worker: include `requestId`, `analysisRunId`, `phase`, `durationMs`, and safe counts (e.g., indicator count, part count).
  - Verify that raw message bodies, credentials, tokens, or PII are never logged.
- **Worker execution watchdog:**
  - Enforce execution timeout limits on worker jobs to prevent hung processing.
- **Status / result endpoint:**
  - Add protected status/result endpoint if direct HTTP verification is needed by the application server.

#### Tests & validation
- End-to-end pipeline test with fake storage, fake repositories, and fixture enrichment.
- Duplicate broker delivery and intake idempotency tests.
- Structured log verification asserting no raw content or credentials are logged.
- Terminal vs retryable failure classification tests.

---

### Part 1 acceptance gate — **passed**

P4–P8 passed the analyzer acceptance checks before Part 2 work:

```bash
pnpm --filter @mailsentinel/analyzer lint
pnpm --filter @mailsentinel/analyzer typecheck
pnpm --filter @mailsentinel/analyzer test
pnpm contracts:generate
pnpm contracts:check
pnpm env:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build  # with the documented required environment variables
```

Verification results:
- 132 analyzer tests pass, with the known upstream Starlette deprecation warning acknowledged.
- Analyzer Ruff, formatting, and mypy checks pass with zero errors.
- OpenAPI and TypeScript contract artifacts were regenerated and are synchronized.
- Offline tests remain network-free; live provider tests use mocks.
- Root lint, typecheck, tests, environment checks, database checks, and the production build pass.

Part 2 application-server work followed this gate, and Part 3 followed Part 2's.

---

## Part 2 — oRPC and application server — **complete**

Begin this part only after the Part 1 acceptance gate passes and analyzer contracts are frozen.

### 2.1 Objective and boundary

Implement the authenticated, tenant-aware application layer under `apps/web/src/server` and shared packages. The application server owns:
- Authorization and organization context.
- Cases and evidence-upload orchestration.
- PostgreSQL schema/migrations and tenant-scoped repositories.
- Creating analysis runs and dispatching the private analyzer.
- Serving analysis status, findings, and results through oRPC.
- Report creation and retrieval.
- Audit events and safe application errors.

The browser must call oRPC only. It must never receive analyzer service tokens, S3 credentials, or direct private-service access.

---

### Phase S1 — Complete the application-facing product schema — **complete**

#### Scope
Review the analyzer persistence schema provisioned in Part 1 (`0002_great_miss_america.sql`), evolve `packages/db/src/schema.ts` for application query and reporting requirements, and create any additional reviewed Drizzle migrations:
- Verify `analysis_runs` exposes the application-required fields: `evidenceId`, version columns, lifecycle timestamps, summary verdict/score/confidence, safe failure details, retry metadata, and tenant constraints.
- Result storage model: relational summary fields for filtering/listing, immutable JSONB result snapshot, and relational findings/indicators only where application queries require them.
- Add remaining tables as needed: queryable analysis findings/indicators (if required), generated `reports` table (tenant scope, version, metadata, format, object key), and upload/idempotency tracking records.
- Unique constraints preventing duplicate active/logical runs for the same idempotency key.
- Composite foreign keys carrying `organizationId` through case, evidence, run, result, and report records.
- Indexes for tenant case lists, run status polling, finding severity, and report lookup.
- Keep evidence objects in S3; never store `.eml` bodies in PostgreSQL.
- Preserve append-only audit semantics.

#### Tests & validation
- Migration applies cleanly to an empty database.
- Existing setup data remains valid.
- Cross-tenant foreign-key violations fail.
- Duplicate run/result idempotency constraints fail safely.
- Status and case-list query indexes are represented in the schema.

---

### Phase S2 — Tenant-scoped repositories and transactions — **complete**

#### Scope
Expand `packages/db/src/repositories.ts` or focused repository modules:
- **Evidence repository:** Create pending metadata, mark upload stored/verified, get/list by organization and case, prevent unscoped lookup.
- **Analysis repository:** Create run, get/list by organization and case, get status/result, atomic lifecycle transitions, save result transactionally, retry operation with explicit policy.
- **Report repository:** Create report request/version, read/list tenant-scoped reports, update generation status.
- **Audit repository:** Append safe events, tenant-scoped retrieval for authorized roles.
- Introduce transaction helpers for operations that create evidence/run/audit records together.
- Require `organizationId` in every tenant-owned repository method.
- Return explicit domain errors (not found, conflict) instead of leaking database driver errors.

#### Tests & validation
- Unit tests using deterministic adapters.
- PostgreSQL integration tests for constraints and transactions.
- Cross-tenant tests for every get/list/update/delete method.
- Transaction rollback tests.
- Concurrent analysis creation/idempotency tests.

---

### Phase S3 — Authorization model — **complete**

#### Scope
- Preserve session-aware oRPC context.
- Add reusable authorization middleware for roles: `owner`, `investigator`, `viewer`.
- Define permissions explicitly: viewers read cases/results/reports; investigators create cases, upload evidence, and start analysis; owners perform administrative/retry/retention operations.
- Require explicit active organization validated against user membership; do not silently select the first organization.
- Map unauthorized, forbidden, not-found, conflict, payload-too-large, and dependency errors to stable oRPC errors.
- Include request ID in safe error metadata and logs.
- Add safe audit events for sensitive product actions without recording raw evidence.

#### Tests & validation
- Anonymous request rejection.
- Viewer mutation rejection.
- Investigator allowed operations.
- Active-organization membership validation.
- Cross-tenant identifier probing returns safe behavior.

---

### Phase S4 — Evidence upload orchestration — **complete**

#### Scope
Implement a server-owned upload flow; do not expose storage credentials to the client:
- Define oRPC procedures: `evidence.createUpload` (or direct bounded upload), `evidence.completeUpload`, `evidence.list`, `evidence.get`.
- Validate authenticated organization/case ownership, `.eml` content type and extension, configured byte limit, non-empty body, SHA-256 digest, and opaque server-generated artifact ID and object key.
- Never use a client filename in the storage key.
- Coordinate object and metadata creation with explicit failure cleanup/compensation.
- Keep evidence private and immutable after completion.
- Prevent completion against an object belonging to another tenant/case.
- Append upload audit records containing safe metadata only.
- Return typed evidence metadata, never storage credentials.

#### Tests & validation
- Valid upload lifecycle.
- Oversized, empty, or wrong-scope rejection.
- Filename and path traversal input rejection.
- Duplicate completion idempotency.
- Storage write failure and database failure compensation.
- Assert no secret appears in response payloads.

---

### Phase S5 — Analysis creation and private analyzer dispatch — **complete**

#### Scope
- Add `analysis.start` mutation taking a tenant-scoped `caseId` and `evidenceId`.
- In a transaction: verify membership and case/evidence scope, create analysis run in `accepted` or `queued` state, create audit record, assign idempotency key.
- Dispatch `AnalysisIntakeRequest` through the server-only analyzer client.
- Build the analyzer request only from authoritative database metadata; never accept organization ID or object key from the browser as authority.
- Propagate request ID.
- On successful `202 Accepted`, transition run to `queued` state.
- On analyzer unavailability, retain recoverable state and return typed safe error.
- Prevent duplicate user requests from producing duplicate logical runs.
- Add explicit retry mutation with permission and state checks.

#### Tests & validation
- Correct generated analyzer payload.
- Cross-tenant case/evidence rejection.
- Duplicate start idempotency.
- Analyzer `202`, `401`, validation error, timeout, and unavailable behavior.
- Assert no analyzer token is exposed in errors or logs.

---

### Phase S6 — Real oRPC queries and status polling contract — **complete**

#### Scope
Organize router into focused modules with required procedures:
```text
system.health
case.list, case.get, case.create
evidence.list, evidence.get
analysis.start, analysis.list, analysis.getStatus, analysis.getResult, analysis.retry
report.generate, report.get, report.list
```
- Define Zod input/output schemas matching generated analyzer representations.
- `analysis.getStatus` reads tenant-scoped canonical database record (timestamps, progress phase if available, safe failure details).
- `analysis.getResult` returns completed summary, findings, score breakdown, verdict, confidence, and version metadata.
- Return typed not-ready response for active runs rather than fake data.
- Add pagination/cursors to potentially unbounded lists.
- Filter by status/severity only where backed by indexed columns.
- Keep raw email bodies and unsafe HTML out of general result responses.
- Document query invalidation and polling guidance for future UI.

#### Tests & validation
- Router tests for every procedure.
- Authentication, role, and tenant boundary tests.
- Active, completed, and failed status representations.
- Pagination and stable ordering.
- Analyzer result serialization compatibility.
- Safe error mapping.

---

### Phase S7 — Report generation backend — **complete**

#### Scope
Implement reporting as a server-owned, versioned capability:
- Report data contract based strictly on persisted analysis results: case/evidence identifiers, versions, score/verdict/confidence, deterministic executive summary, categorized findings, limitations/enrichment coverage, generation timestamp, and report version.
- Do not embed active or raw email HTML.
- Deterministic JSON and safe printable HTML/text representation.
- If PDF generation is added, disable renderer network and local-file access, and test boundary separately.
- Store report metadata and immutable generated object privately.
- Tenant-scoped report generation, read, and list procedures.
- Regeneration creates a new version; never silently overwrite historical reports.
- Audit report generation and download authorization.

#### Tests & validation
- Deterministic report fixture verification.
- Completed analysis required before report generation.
- Cross-tenant generation and read rejection.
- No script or raw HTML injection in rendered output.
- Renderer network-disabled test (if PDF renderer introduced).
- Versioning and immutable report behavior.

---

### Phase S8 — Server integration, observability, and hardening — **complete**

#### Scope
- Add integration tests covering case -> evidence -> analysis -> result -> report using fake analyzer execution or seeded completed results.
- Add structured server logs with request, organization, case, and run IDs (no raw evidence).
- Add audit events for case creation, evidence upload, analysis start/retry/completion/failure, and report generation.
- Add bounded pagination and input lengths throughout oRPC.
- Review server-only imports and verify secrets cannot enter client bundles.
- Review race conditions around upload completion, duplicate analysis, and report generation.
- Document application-level retry and failure recovery.
- Update generated contracts and API documentation.
- Do not change Docker/Compose as part of this phase.

#### Tests & validation
- End-to-end integration tests proving:
  - Authenticated tenant creates a case.
  - Evidence is stored privately with verified metadata.
  - Analysis run is created idempotently.
  - Private analyzer intake receives authoritative scoped metadata.
  - Status/result reads are tenant-scoped.
  - Completed results retain score explanations and version metadata.
  - Report generation is tenant-scoped and deterministic.
  - No browser-facing response contains analyzer or storage credentials.

---

### Part 2 acceptance gate — **passed**

All of the following must pass before frontend product work begins:

```bash
pnpm env:check
pnpm contracts:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build  # with the documented required environment variables
```

Run database migration and integration tests against the supported local PostgreSQL test setup, without changing Docker/Compose.

Verification results:
- `pnpm env:check` and `pnpm contracts:check` pass; the regenerated analyzer OpenAPI and TypeScript artifacts are synchronized with no drift.
- `pnpm lint` and `pnpm typecheck` pass across every workspace, including analyzer Ruff/mypy.
- `pnpm test` passes: 253 web tests, 55 database tests, and 132 analyzer tests, with the known upstream Starlette deprecation warning acknowledged.
- Database migrations are applied to the local PostgreSQL test database and the 13 PostgreSQL repository integration tests run against it.
- `pnpm build` succeeds with the documented required environment variables; the emitted client bundle contains no analyzer token, storage credential, or database URL.
- Docker, Compose, `infra/scripts/**`, and `apps/analyzer/Dockerfile` were not modified.

Application API reference: `docs/api/README.md`. Polling contract: `apps/web/src/server/orpc/POLLING.md`. Failure recovery: `apps/web/src/server/orpc/RECOVERY.md`.

---

## Part 3 — UI/frontend — **implemented**

Built after the Part 2 acceptance gate passed. `apps/web/DESIGN.md` is the single source of truth for the visual language: a dark-only, hairline-bordered command-palette system whose depth comes from a four-step surface ladder rather than shadows.

### Delivered surfaces

- **Marketing** (`/`): hero with the one permitted red stripe band, a rendered command-palette mockup, pipeline / evidence / explainability / boundaries sections, and a live `system.health` indicator.
- **Authentication** (`/sign-in`): credential form with safe generic failures, `?next=` return-to routing, and redirect for an already-authenticated visitor.
- **Workspace shell** (`(workspace)`): session gate, sidebar and mobile drawer, organization switcher, account menu, and a ⌘K command palette that searches real cases.
- **Dashboard** (`/dashboard`): tenant activity counters plus recent runs and cases.
- **Cases** (`/cases`, `/cases/[caseId]`): list with client-side filtering, creation dialog, case detail with evidence and analysis-run tabs.
- **Evidence**: upload dialog that computes SHA-256 in the browser, registers the digest, then sends the bounded base64 body; verified, pending, and failed rows all render their real state.
- **Analysis** (`/analysis`, `/analysis/[analysisRunId]`): filterable run list, live status polling for active runs, retry for owners, and a seven-panel result view (findings, authentication, routing, content, indicators, attachments, headers) where every finding shows its rule id, severity, score contribution, explanation, and evidence references.
- **Reports** (`/reports`, `/reports/[reportId]`): generation dialog, immutable version list, and a viewer that renders HTML reports inside a fully sandboxed frame with source and download alternatives.
- **Settings** (`/settings`): session, organization switching, and the role/permission matrix the server enforces.

### Stack and conventions

- React 19 + TypeScript, Tailwind 4, and shadcn/ui primitives restyled against `DESIGN.md` tokens (`components.json`, `src/components/ui`).
- TanStack Query owns every server read and write: typed oRPC query/mutation options, status-driven polling intervals, cache invalidation by procedure key, and one global safe-error toast carrying the server's `requestId`.
- Motion supplies entrance, list-stagger, dialog, and meter animations, all bounded and disabled under `prefers-reduced-motion`.
- Separation is `components/ui` (primitives) → `components/common` and `components/layout` (composition) → `features/*` (data + screens) → `lib/*` (client utilities).

### Server additions required by the browser

- `organization.list` returns the caller's own memberships so the browser can supply `x-organization-id`; the server still never selects an organization implicitly.
- `analysisRunOutputSchema` now carries the persisted `verdict`, `score`, and `confidence` summary columns so a run list shows its outcome without a second read.

### Preserved boundaries

Object keys, storage credentials, and analyzer tokens never reach the browser; raw email is never rendered; links found in evidence are displayed as inert text and never fetched; and role-gated actions are hidden in the UI but still enforced server-side.

---

## Global implementation rules

### Required order

```text
P4 forensic extraction follow-up (complete)
→ P5 offline/live enrichment adapters & cache (complete)
→ P6 scoring rules & benign calibration (complete)
→ P7 persistence & audit APIs (complete)
→ P8 worker hardening, logging & idempotency (complete)
→ Part 1 gate (passed)
→ S1 database schema review (complete)
→ S2 repositories (complete)
→ S3 authorization (complete)
→ S4 evidence upload (complete)
→ S5 analyzer dispatch (complete)
→ S6 oRPC reads/results (complete)
→ S7 reports (complete)
→ S8 integration/hardening (complete)
→ Part 2 gate (passed)
→ Part 3 frontend (complete)
```

### Commit discipline

- Keep each phase independently reviewable.
- Do not mix Python engine work, database migrations, and frontend work in one commit.
- Regenerate and commit analyzer contract artifacts whenever Pydantic API contracts change (`pnpm contracts:generate`).
- Never edit generated contract files manually.
- Include tests in the same commit as behavior where practical.
- Record deliberate contract or migration breaks explicitly.

### Security invariants

- Every tenant-owned operation carries organization context.
- PostgreSQL remains canonical for identity, tenancy, and workflow metadata.
- S3-compatible storage remains canonical for immutable evidence and report objects.
- Browser -> oRPC -> application server -> private analyzer remains the trust path.
- Raw evidence is hostile input.
- No URL fetching, attachment execution, or raw HTML rendering.
- No verdict without explainable deterministic evidence.
- No raw message bodies, secrets, or credentials in logs or errors.
- Resource limits are enforced, not merely configured.
- Fixture and offline tests never require internet access.

### Out of scope until separately planned

- Docker/Compose changes.
- Neo4j or another graph database.
- LLM-generated verdicts or summaries.
- Machine-learning classifiers.
- Attachment sandbox execution.
- Recursive archive/decompression analysis.
- Browser-direct FastAPI or object-storage access.
- Live URL crawling or screenshotting.
- Frontend product implementation before Parts 1 and 2 are accepted.

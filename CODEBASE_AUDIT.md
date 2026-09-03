# MailSentinel codebase audit

## Scope and method

Reviewed the current working tree, including uncommitted backend changes. The audit covered:

- Python analyzer: contracts, settings/logging, parser, extraction, enrichment, scoring, orchestration, persistence, S3 adapter, worker, segmentation, OpenAPI export, and all analyzer tests.
- Application backend: authentication, tenant context and authorization, oRPC procedures, analyzer client, evidence/report storage, reports, audit/logging, Gmail OAuth/client/sync, and server tests.
- Shared backend packages: database schema, all migrations, repositories and memory adapters, auth package, generated analyzer contracts, fixtures, scripts, CI, environment schemas, and backend documentation.

Per request, UI/frontend implementation and Docker/Compose/runtime-script work were excluded. Server code under `apps/web/src/server` and mailbox API route handlers were included because they are backend implementation.

The plan comparison used `PLAN.md`, `PLAN_FINAL.md`, `SETUP_PLAN.md`, and `TODO.md` as they existed before cleanup.

## Verification results

| Check | Result |
| --- | --- |
| Analyzer Ruff/format | Pass |
| Analyzer mypy | Pass: 27 source files |
| Analyzer pytest | Pass: 149 tests; 1 upstream Starlette deprecation warning |
| Database Biome/typecheck | Pass |
| Database Vitest, including local PostgreSQL integration tests | Pass: 79 tests |
| Application/server Biome + ESLint | Pass with warnings |
| Application/server typecheck | Pass |
| Application/server Vitest | Pass: 304 tests |
| Environment documentation check | Pass |
| Production dependency audit | Fail: one moderate `esbuild@0.18.20` advisory (`GHSA-67mh-4wv8-2f99`) |
| Runtime version | Warning: audit host used Node 24.20.0; project requires Node >=22 <23 |

Contract drift is covered by the passing analyzer drift test. The clean-tree `pnpm contracts:check` gate was not used because it intentionally fails when generated contract changes are present in an uncommitted working tree. Frontend build/E2E and all Docker checks were excluded.

## Plan-to-implementation assessment

| Former phase | Status | Evidence / qualification |
| --- | --- | --- |
| Setup, excluding Docker | Complete | Workspace, auth, database, contracts, CI, environment validation, and quality tooling exist and pass their in-scope checks. |
| P1–P8 analyzer | Complete with follow-up defects | Core bounded analysis, persistence, enrichment, scoring, protected intake, status/result, and tests exist. Queue publication and watchdog design still require corrective work. |
| S1–S8 application backend | Complete with follow-up defects | Tenant repositories, authorization, evidence, analysis, reports, audit, and integration tests exist. Several large modules and compensation flows carry technical debt. |
| P9 container segmentation | Complete with hardening debt | Module, formats, limits, summaries, warning, offset/digest tests, and endpoint integration exist. Algorithmic and format edge cases remain. |
| P10 nested-message analysis | Complete with correctness debt | Additive contracts, v1.2.0 scoring, bounded count/depth, and tests exist. Parse failures can be misrepresented as benign and the second parse is not governed by one shared budget. |
| P11 segmentation endpoint | Partial | Protected endpoint, verified S3 read, safe response, and tests exist. The S3 read is outside the endpoint watchdog, the watchdog cannot cancel work, and application-side response validation is missing. |
| P12 analyzer gate | Complete for current local checks | Analyzer lint/typecheck/tests pass and generated-contract drift test passes. Clean Node 22/clean-tree verification remains an operational gate. |
| S9 batch/mailbox schema | Partial | Tables, enums, migration, indexes, and nullable legacy fields exist. Cross-tenant container evidence is not protected by a composite FK; batch-sequence/check constraints are absent. |
| S10 repositories | Partial | Drizzle/memory repositories, tenant scoping, atomic count increments, and integration tests exist. Child uniqueness is application convention rather than a DB invariant; container workflow does not use the available transaction helper. |
| S11 container ingestion | Partial | Segmentation call, deterministic child keys, storage, rows, audit, and basic tests exist. It does not validate returned offsets/digests, is not transactional, has incorrect retry counters, never produces `partial`, discards summaries, and cannot accept containers above the single-message 26 MiB limit. |
| S12 Gmail connector | Partial | Flagged routes, OAuth/PKCE, AES-GCM token storage, provider client, sync, dedupe attempt, audits, and mocked tests exist. Background execution, paging, correct incremental semantics, strict message validation, race control, durable dispatch recovery, and accurate batch membership/counts are missing. |
| S13 oRPC surface | Partial | Batch/mailbox procedures, role gates, tenant scoping, and pagination exist. Pre-analysis summaries are not persisted, batch metadata output is overly broad, and some input/cursor validation is inconsistent. |
| U1–U4 frontend | Excluded | Removed from active planning per request. |
| Docker runtime checklist | Excluded | Removed from active planning per request. |

## Key findings

### Critical / high

1. **Timed-out analyzer work can continue and mutate state.** `apps/analyzer/app/analysis.py` runs analysis in a daemon thread. On timeout, the caller records failure, but Python cannot kill the thread; it can later call `save_completed`, creating a failed/completed race. `apps/analyzer/app/main.py` uses the same non-cancellable pattern for segmentation.

2. **Analyzer intake can strand jobs.** In `apps/analyzer/app/main.py`, the database is transitioned to `queued` before broker publication. If `process_analysis.send` fails, the database state is not reverted; later intake sees `queued` and refuses to publish again. The production exception path also falls back to process-local deduplication on any database error, which is unsafe across processes and restarts.

3. **Segmentation results are trusted without runtime or integrity validation.** `apps/web/src/server/analyzer-client/index.ts` casts arbitrary response JSON to `SegmentationResult`. `apps/web/src/server/orpc/evidence.ts` then slices with supplied offsets, does not compare the reported child SHA-256, and does not reject overlap/out-of-range/count/index inconsistencies. Node's clamping `subarray` behavior can silently create the wrong child artifact.

4. **Container ingestion is not atomic.** `apps/web/src/server/orpc/evidence.ts` writes all objects and then creates rows one at a time outside a transaction. A mid-DB failure may leave verified rows pointing to objects that compensation deletes. Retrying an interrupted batch increments `readyCount` by every segment, including already existing children.

5. **Mailbox batches are not reliable records of what was synced.** `apps/web/src/server/mailbox/sync.ts` creates a new batch but counts deduplicated evidence without attaching it to that batch, leaves persisted `messageCount` at zero, and does not consistently increment persisted failure/ready counts. The single `batch_id` column cannot represent one existing message participating in later sync batches.

6. **Mailbox sync runs synchronously in the oRPC request.** Up to 1,000 sequential fetch/store/dispatch operations can occupy a request. There is no per-connection lock, so concurrent sync requests can race and duplicate batches/work.

### Medium

7. **Segmentation S3 retrieval is outside the watchdog.** `segment_evidence` reads the entire verified object before `_run_segment_with_watchdog`; boto clients also lack explicit connect/read timeout and bounded retry configuration.

8. **Schema tenant invariant is incomplete.** `ingestion_batches.container_evidence_id` references only the global evidence ID. It does not carry organization/case through the FK as the plan requires. There is no unique `(organization_id, batch_id, sequence)` constraint and no non-negative/count-consistency checks.

9. **Container size configuration is internally inconsistent.** Analyzer and web environment schemas define a 100 MiB container limit, but `evidence.createUpload`, `completeUpload`, and `S3EvidenceStorage.putEvidence` enforce the 26 MiB single-message limit. The advertised container capacity is unreachable.

10. **Mailbox provider selection can use fixtures in an enabled deployment.** `defaultGmailClient` is selected from `WEB_DATA_MODE`; a real connector enabled with fixture mode silently uses `MemoryGmailClient`. Test doubles should only be injected by tests.

11. **Enabled mailbox configuration does not fail closed at startup.** OAuth credentials and the token-encryption key remain optional in `apps/web/src/env.ts` even when `MAILBOX_CONNECTORS_ENABLED=true`; failures occur later at request time.

12. **Incremental Gmail behavior is incomplete.** Only one page of history/messages is fetched; no `nextPageToken` loop exists. Empty history falls through to a full message listing, causing repeated scans. Backoff ignores `retryAfterMs`, and cursor advancement is not a durable monotonic checkpoint.

13. **Gmail message decoding is permissive.** `Buffer.from(value, "base64url")` accepts malformed input. Empty and oversized messages are not explicitly rejected before storage, and analyzer-dispatch failures are swallowed, leaving runs requiring undocumented recovery.

14. **OAuth state exposes the PKCE verifier in signed but unencrypted browser-visible state.** The state has expiry but no one-time nonce store/replay check. Move the verifier server-side or protect state confidentiality and one-time use.

15. **Message summaries promised by S13 are not persisted.** Container ingestion keeps only `messageId`; `from`, subject, and date are discarded. `evidence.listByBatch` can derive a summary only after analysis, so a fresh batch is not browsable from the backend contract as planned.

16. **Nested parse failure appears benign.** `extract_nested_messages` converts a failed child parse to an empty `ParsedMessage` with a warning. The low parser score maps to benign, which can falsely imply successful benign analysis. It also reparses the full MIME tree separately rather than sharing the outer parser budget.

17. **Segmentation has avoidable denial-of-service surfaces.** Bare concatenation repeatedly searches sliced suffixes; multipart digest materializes all delimiter matches before applying the message cap; folded boundary parameters are not handled robustly; `bytes.lstrip` is an ambiguous BOM check.

18. **One moderate production dependency advisory is open.** `pnpm audit --prod` reports vulnerable transitive `esbuild@0.18.20` through Better Auth/drizzle-kit tooling paths.

### Low / maintainability

19. **Oversized modules concentrate risk.** `packages/db/src/repositories.ts` (~3,367 lines), `apps/web/src/server/orpc/evidence.ts` (~1,096), `analysis.ts` (~824), and `apps/analyzer/app/extraction/extract.py` (~1,352) mix many responsibilities and make review/state-transition reasoning difficult.

20. **Memory and PostgreSQL adapters duplicate business rules.** The implementations can drift; both should run against a shared repository contract suite and centralized transition policy.

21. **Broad exception suppression reduces diagnosability.** Progress updates, dispatch errors, compensation failures, provider calls, and lifecycle recovery often catch all errors. External messages should remain redacted, but typed internal state and safe error classes should be retained.

22. **Cursor and identifier validation is uneven.** Most oRPC endpoints validate opaque cursors and safe identifiers, while `evidence.listByBatch` accepts a cursor without refinement and several mailbox identifiers/labels/dates have only minimal validation.

23. **Generic batch metadata is browser-visible.** `batchOutputSchema` returns arbitrary JSON metadata. Current writers are mostly safe, but the contract can accidentally expose future storage/provider internals. A fixed safe shape is preferable.

24. **Documentation is stale.** `README.md` still says the repository contains setup foundations and no production verdict logic. It does not describe the implemented analysis, batch, or mailbox backend.

25. **Lint is not warning-free.** The application gate reports unused-parameter warnings and multiple non-null assertion advisories in new tests. These do not fail CI today.

## Code quality assessment

| Area | Assessment |
| --- | --- |
| Architecture/design | **B-**. Trust boundaries and tenant-scoped repositories are strong, but container/mailbox workflows need explicit state machines, transaction boundaries, and background execution. |
| Readability/maintainability | **C+**. Naming and types are generally clear; very large modules, duplicate adapters, and long procedural handlers raise change risk. |
| Error handling | **C**. Browser/provider errors are usually safely redacted, but fail-open intake, swallowed dispatch errors, and compensation ambiguity can leave incorrect durable state. |
| Security | **C+**. Strong tenant filters, private object keys, bearer auth, AES-GCM, server-only guards, and safe logging are present. Missing response integrity validation, OAuth state confidentiality/replay protection, and incomplete DB invariants require attention. |
| Performance | **C**. Core analyzer limits are good; synchronous mailbox work, repeated full listings, non-linear segmentation scans, full-object buffering, and uncancellable threads are material risks. |
| Testing | **B**. The suite is broad (532 passing tests across analyzer/database/server) and includes PostgreSQL/adversarial coverage. Important race, malicious-response, pagination, cancellation, and state-reconciliation paths are absent; no enforceable coverage threshold exists. |
| Technical debt | **Moderate-high** around newly added batch/mailbox code; **moderate** elsewhere. |

## Follow-up implementation completed

The post-audit hardening pass implemented and tested: fail-closed analyzer intake with queue-reservation rollback; bounded S3 client timeouts; process-isolated analyzer and segmentation execution; runtime segmentation schema, boundary, and digest validation; transactional PostgreSQL container-child finalization; batch count invariants and uniqueness constraints; persisted child summaries; strict API identifiers and safe batch metadata; encrypted, cookie-bound, one-time OAuth state; conditional mailbox environment validation; production Gmail client selection; mailbox pagination, retries, concurrency locking, strict base64url/size checks, durable cursor advancement, and non-swallowed dispatch degradation; linearized bare-boundary scanning; explicit nested parse-unknown verdicts; dependency override; and regression coverage.

## Plan cleanup performed

The obsolete planning artifacts `PLAN.md`, `PLAN_FINAL.md`, `SETUP_PLAN.md`, and `TODO.md` were removed after their completed items were consolidated. Local Docker and internet-access setup is documented in [`docs/LOCAL_DOCKER_INTERNET.md`](docs/LOCAL_DOCKER_INTERNET.md), while this file remains as the historical codebase audit.

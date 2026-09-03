# MailSentinel — consolidated remaining work plan

This is the single source of truth for remaining work identified by the codebase audit. It intentionally excludes frontend/UI and Docker/Compose work. Completed items from the former plan files are not repeated.

## Priority 0 — correctness, integrity, and availability

### 1. Make analyzer intake publication recoverable

- Remove the production fail-open, process-local deduplication fallback in `apps/analyzer/app/main.py`; database failures must return a safe dependency error.
- Prevent the current `queued`-before-publish failure mode from stranding runs when `process_analysis.send(...)` fails.
- Implement a transactional outbox or an explicit recoverable publication state with a retry/reconciliation worker.
- Ensure deduplication works across processes and restarts, not only inside one interpreter.

**Acceptance:** broker failure cannot leave a permanently queued-but-unpublished run; concurrent intake across multiple processes publishes one logical job; database outage returns a safe 503.

### 2. Replace non-cancellable watchdog threads and bound dependency I/O

- Replace daemon-thread watchdogs in analysis and segmentation with a worker/process model that can actually terminate timed-out work.
- Add explicit S3 connect/read timeouts and bounded retries.
- Include S3 retrieval in the segmentation endpoint's execution deadline; it currently occurs before the watchdog starts.
- Prevent timed-out analysis work from later committing `completed` after the caller records `failed`.
- Bound concurrent segmentation jobs and memory use.

**Acceptance:** a timed-out task cannot continue mutating state; hung S3 reads terminate within the configured deadline; timeout race tests pass.

### 3. Treat segmentation output as untrusted at the application boundary

- Runtime-validate `/v1/evidence/segment` responses instead of casting JSON to `SegmentationResult`.
- Require `messageCount === segments.length`, unique contiguous indexes, positive lengths, in-range/non-overlapping offsets, and per-child size limits.
- Slice the original bytes and constant-time compare every computed digest with the analyzer-reported digest before storing a child.
- Reject malformed or inconsistent responses safely; do not silently create truncated children via `Buffer.subarray` clamping.

**Acceptance:** malformed JSON, out-of-range/overlapping offsets, count mismatches, duplicate indexes, and digest mismatches create no child objects or rows.

### 4. Make container ingestion atomic and truly idempotent

- Add a database uniqueness constraint for `(organization_id, batch_id, sequence)` and a deterministic unique identity for a container batch.
- Create child evidence rows and final batch counts/status in one database transaction.
- Correct retry accounting so an interrupted retry increments only newly created children and cannot make `ready_count > message_count`.
- Do not delete objects still referenced by previously committed verified rows during compensation.
- Implement the planned `partial` outcome and preserve accurate `message_count`, `ready_count`, and `failed_count`.
- Reconcile orphan objects/rows after process failure between object storage and database commits.

**Acceptance:** concurrent/repeated completion yields one batch and one child per sequence; injected failure at every storage/DB step leaves a reconcilable, internally consistent state.

## Priority 1 — mailbox connector hardening

### 5. Fix connector configuration and OAuth state handling

- Add conditional environment validation: when mailbox connectors are enabled, require a valid 32-byte encryption key, Google client ID/secret, and redirect URI policy.
- Do not select the in-memory Gmail client from `WEB_DATA_MODE` in a real enabled deployment; test doubles must be dependency-injected only.
- Keep the PKCE verifier out of browser-visible signed plaintext state. Store it server-side in a short-lived, one-time record/cookie or encrypt and replay-protect the state.
- Validate the granted OAuth scope and reject missing or broader-than-approved authorization.
- Normalize account email for uniqueness and avoid logging arbitrary provider callback values.

**Acceptance:** enabled configuration fails closed at startup; state is one-time and replay-resistant; production cannot silently use a fixture Gmail client; only `gmail.readonly` is accepted.

### 6. Make mailbox sync bounded, resumable, and race-safe

- Move sync out of the request lifecycle into a bounded background job and prevent concurrent syncs for one connection.
- Implement Gmail pagination for message and history listings while enforcing the total hard cap.
- Use bounded exponential backoff and provider `Retry-After` information for all rate-limited operations.
- Distinguish first/full sync, no-change incremental sync, and expired-history fallback so an empty history page does not trigger a repeated full mailbox scan.
- Validate base64url strictly; reject empty or oversized decoded messages before storage.
- Advance the history cursor monotonically and only after durable processing.
- Stop swallowing analyzer dispatch failures; persist a retryable dispatch state and reconcile it.
- Make evidence/run creation and deduplication transactional under concurrent syncs.
- Ensure every sync batch has accurate persisted counts and actual membership. Repeated messages need an explicit batch-membership model rather than being counted without belonging to the new batch.

**Acceptance:** concurrent sync requests produce one active sync; paginated runs never exceed the cap; retries resume without duplicates or cursor regression; DB batch counts equal durable members.

## Priority 1 — schema and API consistency

### 7. Strengthen batch/evidence database invariants

- Replace the unscoped `container_evidence_id -> evidence_metadata.id` reference with a composite organization/case/evidence foreign key.
- Add check constraints for non-negative sequence/count fields and valid count relationships.
- Add the batch/sequence uniqueness constraint and any mailbox provider-message uniqueness needed by the final membership design.
- Add migration tests that explicitly attempt cross-tenant container references and concurrent duplicate child insertion.

**Acceptance:** PostgreSQL itself rejects cross-tenant container references, duplicate batch sequences, negative counts, and impossible count totals.

### 8. Persist safe message summaries and narrow browser outputs

- Persist the segmentation summary (`from`, display name if retained, subject, date, Message-ID) on child evidence or in a dedicated normalized metadata record.
- Populate summaries for mailbox-ingested evidence without waiting for analysis completion.
- Return the promised summary from `evidence.listByBatch` before analysis runs exist.
- Replace unrestricted batch `metadata` output with an explicit safe response schema; never expose storage or connector internals accidentally.
- Apply the same strict identifier/cursor validation used by other procedures to `evidence.listByBatch` and mailbox list/status inputs.

**Acceptance:** a newly segmented/synced batch is immediately renderable from its API response; unsafe metadata fields cannot cross the browser contract.

## Priority 2 — analyzer robustness

### 9. Harden segmentation algorithms

- Replace repeated sliced regex searches in bare-concatenation detection with a linear bounded scanner.
- Avoid materializing every multipart boundary match before enforcing `max_container_messages`.
- Parse folded/quoted `multipart/digest` boundaries correctly.
- Define and test mbox separator handling and `>From` unescaping semantics so stored children are valid standalone RFC 5322 artifacts while digests remain traceable to source offsets.
- Remove ambiguous BOM handling based on `bytes.lstrip`.

**Acceptance:** adversarial 100 MiB inputs remain bounded in time/memory; folded digest headers and malformed mbox cases have deterministic safe outcomes.

### 10. Make nested-message failure states explicit

- Avoid a second effectively unbounded MIME parse in `extract_nested_messages`; reuse bounded parser state or enforce shared global limits.
- Do not label an unparseable nested message benign merely because its parser-defect score is low; represent analysis failure/unknown explicitly.
- Document whether nested SHA-256 covers original embedded bytes or Python's reserialization, and preserve original bytes where evidentiary claims require it.

**Acceptance:** malformed/capped nested messages are visibly incomplete or unknown, global nested work is bounded, and provenance semantics are tested.

## Priority 2 — maintainability and operational quality

### 11. Refactor oversized modules and duplicated repository logic

- Split `packages/db/src/repositories.ts`, `apps/web/src/server/orpc/evidence.ts`, `apps/web/src/server/orpc/analysis.ts`, and `apps/analyzer/app/extraction/extract.py` by bounded responsibility.
- Centralize Drizzle/memory repository invariants and shared transition validation to reduce behavioral drift.
- Extract container and mailbox workflows into explicit services/state machines with transaction boundaries.
- Replace broad swallowed exceptions with typed errors plus safe, actionable state transitions.

**Acceptance:** modules have focused ownership, state transitions are centrally tested, and memory/PostgreSQL adapters pass the same contract suite.

### 12. Close verification gaps

Add regression and integration tests for:

- analyzer publication failure/reconciliation and multi-process deduplication;
- timeout cancellation and late-write prevention;
- malicious segmentation responses and child digest verification;
- concurrent container completion and failure at each compensation boundary;
- OAuth state replay, conditional configuration, exact scope validation, and production-client selection;
- first/incremental/empty-history/expired-history Gmail flows, pagination, malformed base64url, oversize messages, and concurrent sync;
- persisted summary availability before analysis;
- database check/composite/uniqueness constraints;
- full non-frontend flow against PostgreSQL, object storage, broker, and a mocked Gmail provider.

Also add coverage reporting with enforceable thresholds for security-critical modules.

### 13. Resolve dependency and tooling debt

- Upgrade or override the transitive vulnerable `esbuild@0.18.20` path reported by `pnpm audit` (`GHSA-67mh-4wv8-2f99`).
- Eliminate current lint warnings in mailbox/analyzer-client code and tests.
- Run verification under the pinned Node 22 runtime; the audit ran under unsupported Node 24.20.0.
- Update the root README and API documentation, which still describe the repository as setup-only and do not accurately describe the implemented analyzer, batch, and mailbox behavior.

## Final non-frontend acceptance gate

Run from a clean checkout using Node 22:

```bash
pnpm install --frozen-lockfile
uv sync --locked
pnpm db:migrate
pnpm env:check
pnpm contracts:check
pnpm --filter @mailsentinel/analyzer lint
pnpm --filter @mailsentinel/analyzer typecheck
pnpm --filter @mailsentinel/analyzer test
pnpm --filter @mailsentinel/db lint
pnpm --filter @mailsentinel/db typecheck
pnpm --filter @mailsentinel/db test
pnpm --filter @mailsentinel/web lint
pnpm --filter @mailsentinel/web typecheck
pnpm --filter @mailsentinel/web test
pnpm audit --prod
```

Acceptance additionally requires the new PostgreSQL/object-storage/broker/mock-Gmail integration suite and zero high/moderate known production dependency vulnerabilities, unless a reviewed exception is documented.

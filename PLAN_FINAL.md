# MailSentinel — remaining backend work

Frontend and Docker work are intentionally excluded. The following items remain after the backend hardening pass committed after the initial audit.

## 1. Durable analyzer publication outbox

The analyzer now fails closed on database errors and atomically releases an unclaimed queue reservation when broker publication fails. A durable transactional outbox is still needed to recover the ambiguous case where broker publication succeeds but the HTTP request loses its response before the reservation is reconciled.

- Add an outbox/job table written in the same transaction as analysis-run creation.
- Add a retrying publisher/reconciler with lease ownership and attempt limits.
- Add multi-process crash/restart tests.

## 2. Durable mailbox sync jobs and membership history

Mailbox sync is now bounded, paginated, rate-limit aware, compare-and-set protected, resumable, idempotent, and persists safe summaries. It still executes in the request process. For production-scale mailboxes:

- Persist sync jobs and run them in a worker rather than holding an oRPC request open.
- Add durable per-connection leases/heartbeats and recovery for crashed jobs.
- Replace evidence's single nullable `batch_id` relationship with a batch-membership table so one deduplicated message can belong to multiple sync batches without corrupting counts.
- Reconcile orphaned storage objects and accepted analysis runs with a periodic worker.

## 3. Structural maintainability work

- Split the oversized repository and oRPC/evidence modules into focused services.
- Share a repository contract test suite between memory and PostgreSQL adapters.
- Add enforceable coverage thresholds for security-critical code.
- Run the complete gate under the pinned Node 22 runtime; the current host uses Node 24 and reports the repository engine warning.
- Keep API/README documentation synchronized with the implemented backend.

## Verification gate

The current backend hardening passes:

- Analyzer: Ruff, mypy, and 149 pytest tests.
- Database: Biome, TypeScript, and 80 tests including PostgreSQL integration.
- Web backend: Biome/ESLint, TypeScript, and 311 tests.
- `pnpm env:check`.
- `pnpm audit --prod` reports no known vulnerabilities after the esbuild override.

Do not add frontend or Docker tasks to this file.

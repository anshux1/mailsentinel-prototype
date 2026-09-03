# Application Workflow Recovery

Part 2 application workflows use durable database state as the source of truth. Browser responses never include private object keys, storage credentials, or analyzer service tokens.

## Analysis intake

An analysis run is committed in `accepted` before analyzer dispatch. A successful analyzer `202 accepted` advances it to `queued`. If the web process exits between those operations, a retry with the same tenant, evidence, and idempotency key returns the same run and safely redispatches it. `analysis.start` also reconciles analyzer responses that report a later durable state. Owner `analysis.retry` only accepts failed, retryable runs and is bounded by the repository retry limit.

Alert on runs that remain `accepted` or `queued` beyond the expected analyzer latency. Operators may use the authenticated start/retry procedures; never call the analyzer with browser-supplied artifact metadata.

## Evidence upload

Evidence is registered as `pending`, written to private storage, then transitioned through `stored` to `verified`. Completion is idempotent when the digest and byte size match. A storage write that reports failure is reconciled with a scoped HEAD before cleanup, covering providers that accepted the write but lost the response. Failed rows retain only a safe failure reason. Alert on stale `pending`/`stored` records and investigate private-storage availability.

## Report generation

Each generation creates a new immutable `(organization_id, analysis_run_id, version, format)` row; versions are allocated per run and format. The private object is written before the row becomes `completed`. A failed write marks the row `failed`; a failed database completion triggers best-effort object deletion. Version conflicts are retried with a fresh allocation. Alert on reports left in `generating`; after verifying no committed completed row, delete any matching orphan through an operator-only storage path and regenerate.

## Audit and logs

Initiation, completion, retry, and report generation emit tenant-scoped audit records. Structured logs include request, organization, case, analysis-run, evidence, or report identifiers as applicable. Logs and audit metadata must not contain request bodies, evidence content, object keys, credentials, authorization headers, provider payloads, or exception stacks.

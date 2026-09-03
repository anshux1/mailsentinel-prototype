# MailSentinel application API

The browser talks to exactly one server surface: the typed oRPC router mounted at
`/api/rpc`. There is no browser-facing route to the Python analyzer or to object
storage, and no procedure returns storage credentials, analyzer service tokens,
private object keys, or raw evidence.

```text
browser -> /api/rpc (oRPC) -> application server -> private analyzer / private S3
```

- Router definition: `apps/web/src/server/orpc/router.ts`
- Typed browser client: `apps/web/src/lib/orpc.ts`
- Polling and cache-invalidation contract: `apps/web/src/server/orpc/POLLING.md`
- Failure and recovery procedures: `apps/web/src/server/orpc/RECOVERY.md`
- Analyzer contract artifacts (generated, never hand-edited):
  `packages/contracts/generated/analyzer.ts`,
  `packages/contracts/generated/analyzer-openapi.json`

## Request requirements

| Requirement | Detail |
| --- | --- |
| Session | Better Auth session cookie. Missing session -> `UNAUTHORIZED`. |
| Active organization | `x-organization-id` (alias `x-org-id`), matching `^[a-zA-Z0-9_-]{1,128}$`. There is no implicit first-membership fallback; a missing or non-member organization is `FORBIDDEN`. |
| Correlation | Optional `x-request-id`. The server generates one when absent and echoes it in every error payload, audit record, and structured log line. |

## Roles and permissions

Roles are hierarchical: `viewer` < `investigator` < `owner`
(`apps/web/src/server/auth/permissions.ts`).

| Permission | viewer | investigator | owner |
| --- | :-: | :-: | :-: |
| `cases:read`, `evidence:read`, `analysis:read`, `reports:read` | yes | yes | yes |
| `cases:create`, `evidence:upload`, `analysis:start`, `reports:generate` | no | yes | yes |
| `analysis:retry`, `retention:manage`, `admin:manage`, `mailbox:manage` | no | no | yes |

## Procedures

### `system.health`

Public. `GET`. Returns `{ ok, service: "web", timestamp }`. No tenant context.

### Organizations

| Procedure | Role | Input | Output |
| --- | --- | --- | --- |
| `organization.list` | authenticated | none | `{ items: { organizationId, name, role }[] }` |

Returns only the *calling user's* memberships. The browser needs it to choose
the `x-organization-id` it sends — the server never picks one implicitly.

### Cases

| Procedure | Role | Input | Output |
| --- | --- | --- | --- |
| `case.list` | viewer | `{ limit?: 1-100 = 50, cursor?: <=1024 chars }` | `{ items: Case[], nextCursor }` |
| `case.get` | viewer | `{ caseId }` | `Case \| null` |
| `case.create` | investigator | `{ title: 1-160 chars, trimmed }` | `Case` |

`Case` is `{ id, organizationId, title, createdAt, updatedAt }`.

### Evidence

| Procedure | Role | Input | Output |
| --- | --- | --- | --- |
| `evidence.createUpload` | investigator | `{ caseId, byteSize: 1..MAX_EML_BYTES, sha256: 64 hex, filename?: <=255, contentType?: "message/rfc822", idempotencyKey?: <=255 }` | `Evidence` (`pending`) |
| `evidence.completeUpload` | investigator | `{ caseId, evidenceId, body: base64, sha256? }` | `Evidence` (`verified`) |
| `evidence.list` | viewer | `{ caseId, status?, limit?: 1-100 = 50, cursor? }` | `{ items: Evidence[], nextCursor }` |
| `evidence.get` | viewer | `{ caseId, evidenceId }` | `Evidence \| null` (`NOT_FOUND` when the case is not in the tenant) |

`Evidence` exposes `{ id, organizationId, caseId, status, sha256, byteSize,
contentType, storedAt, verifiedAt, failedAt, failureReason, createdAt, updatedAt }`.
`objectKey` and `idempotencyKey` are deliberately stripped from every browser
response.

Upload rules:

- The payload is registered first (`pending`), written to private storage, then
  transitioned `stored -> verified`. Digest and byte size must match the
  registered metadata or the row is marked `failed`.
- Base64 length, decoded length, and alphabet are bounded before decoding.
  Oversized payloads return `PAYLOAD_TOO_LARGE`.
- Completion is idempotent when digest and byte size match; verified evidence is
  immutable.

### Batches and mailbox

| Procedure | Role | Input | Output |
| --- | --- | --- | --- |
| `batch.list` | viewer | `{ caseId, limit?, cursor? }` | `{ items, nextCursor }` |
| `batch.get` | viewer | `{ batchId, caseId? }` | `Batch | null` |
| `evidence.listByBatch` | viewer | `{ batchId, caseId?, limit?, cursor? }` | `{ items, nextCursor }` |
| `mailbox.list`, `mailbox.status` | viewer | tenant-scoped | connection metadata only |
| `mailbox.startSync` | investigator | `{ connectionId, caseId, maxMessages?, label?, startDate?, endDate? }` | bounded sync result |
| `mailbox.disconnect` | owner | `{ connectionId }` | `{ success }` |

All batch and mailbox procedures are tenant-scoped. Mailbox procedures and Gmail
OAuth routes are unavailable unless `MAILBOX_CONNECTORS_ENABLED=true`; refresh
tokens, nonces, authorization headers, and private object keys never enter
browser output, logs, or audit metadata.

### Analysis

| Procedure | Role | Input | Output |
| --- | --- | --- | --- |
| `analysis.start` | investigator | `{ caseId, evidenceId, idempotencyKey?: <=255 }` | `AnalysisRun` |
| `analysis.retry` | owner | `{ analysisRunId, caseId? }` | `AnalysisRun` |
| `analysis.list` | viewer | `{ caseId?, evidenceId?, status?, verdict?, limit?: 1-100 = 50, cursor? }` | `{ items: AnalysisRun[], nextCursor }` |
| `analysis.getStatus` | viewer | `{ analysisRunId, caseId? }` | `AnalysisStatus` |
| `analysis.getResult` | viewer | `{ analysisRunId, caseId? }` | `AnalysisResult` |

- Only `verified` evidence can be analyzed.
- When the browser omits `idempotencyKey`, the server derives a deterministic key
  from `(organization, case, evidence)`, so a repeated start returns the same run
  and never produces a second analyzer intake.
- The intake sent to the private analyzer is built exclusively from persisted
  metadata (`objectKey`, `sha256`, `byteSize`, `digestAlgorithm`) plus the request
  identifier. Browser-supplied artifact metadata is never forwarded.
- A run is committed as `accepted` before dispatch and advances to `queued` only
  on an exact analyzer `202 accepted`.
- `analysis.list` and the mutations return the run's summary columns
  (`verdict`, `score`, `confidence`) alongside its lifecycle state, so a run
  list shows its outcome without a second read.
- `analysis.getResult` returns a discriminated union: `{ ready: false, status, ... }`
  until the run completes, then `{ ready: true, verdict, score, findings, ... }`
  with rule identifiers, severities, explanations, evidence references,
  `analysisVersion`, `rulesetVersion`, and `schemaVersion`.

### Reports

| Procedure | Role | Input | Output |
| --- | --- | --- | --- |
| `report.generate` | investigator | `{ analysisRunId, format?: "json" \| "html" \| "text" = "html" }` | `Report & { content, contentType }` |
| `report.get` | viewer | `{ reportId, caseId? }` | `Report & { content, contentType }` |
| `report.list` | viewer | `{ caseId?, analysisRunId?, format?, status?, limit?: 1-100 = 50, cursor? }` | `{ items: Report[], nextCursor }` |

- A completed analysis result is required; otherwise `CONFLICT`.
- Reports are deterministic for a fixed generation timestamp and are built only
  from the persisted result snapshot.
- Every generation writes a new immutable row and object. Versions are allocated
  per `(analysis run, format)`; historical reports are never overwritten.
- HTML output is escaped and contains no script, no active content, and no raw
  email body.

## Identifier and pagination bounds

- Path-like identifiers (`caseId`, `evidenceId`, `analysisRunId`, `reportId`)
  match `^[A-Za-z0-9_-]{1,200}$`.
- Every list procedure bounds `limit` to `1..100` (default 50) and `cursor` to
  1024 characters; cursors are opaque, ordered by `createdAt DESC, id DESC`, and
  validated before use.
- `title` is 1-160 characters; `filename` is at most 255; `idempotencyKey` is at
  most 255; evidence payloads are bounded by `MAX_EML_BYTES`.

## Errors

Errors are mapped by `toSafeORPCError` to a stable code plus the request
identifier. Raw database, storage, or analyzer messages, SQL, and stack traces
are never returned or logged.

| Code | Status | Raised when |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | No authenticated session. |
| `FORBIDDEN` | 403 | Missing/invalid active organization, non-member, or insufficient role. |
| `NOT_FOUND` | 404 | Resource missing, or owned by another tenant. |
| `CONFLICT` | 409 | Immutability, lifecycle, or idempotency-metadata mismatch. |
| `PAYLOAD_TOO_LARGE` | 413 | Evidence payload exceeds the configured bound. |
| `BAD_GATEWAY` | 502 | Analyzer or private storage unavailable or invalid. |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected failure; details stay server-side. |

Error payloads carry `{ requestId, code }` and a fixed message.

## Audit trail

Tenant-scoped, append-only records in `audit_records`
(`apps/web/src/server/audit/index.ts`), each carrying the request identifier:

`case.create`, `evidence.upload_init`, `evidence.upload_complete`,
`analysis.start`, `analysis.intake_dispatched`, `analysis.retry`,
`analysis.failed`, `batch.created`, `batch.completed`, `batch.failed`,
`evidence.container_segmented`, `evidence.child_registered`, `mailbox.connected`,
`mailbox.sync_started`, `mailbox.sync_completed`, `mailbox.disconnected`,
`report.requested`, `report.generate`, `report.download`.

The analyzer worker appends its own lifecycle records (claimed, completed,
failed, recovered) to the same table.

Audit metadata is sanitized: no request bodies, raw evidence, filenames, object
keys, credentials, or provider payloads.

## Structured logs

`apps/web/src/server/logger.ts` emits one JSON object per line with
`timestamp`, `level`, `event`, and, when available, `requestId`,
`organizationId`, `userId`, plus resource identifiers such as `caseId`,
`evidenceId`, `analysisRunId`, and `reportId`.

Keys containing `token`, `secret`, `password`, `auth`, `cookie`, `credential`,
`body`, `content`, `attachment`, `raw`, `key`, or `stack` are replaced with
`[REDACTED]`, `Error` values are reduced to their class name, strings are
truncated, arrays are capped, and nesting is bounded.

## Regenerating contract artifacts

```bash
pnpm contracts:generate
pnpm contracts:check
```

`contracts:check` regenerates the analyzer OpenAPI document and TypeScript types
and fails if `packages/contracts/generated` drifts. Never edit generated files by
hand.

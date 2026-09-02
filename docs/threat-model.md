# Threat model baseline

MailSentinel treats email and all derived content as hostile input. Setup establishes boundaries and limits before any parser or product verdict logic is added.

## Threats

- Malformed MIME structures, decompression bombs and parser resource exhaustion.
- Path traversal, unsafe filenames and attachment execution.
- SSRF and network access from parsers or report renderers.
- Stored XSS and unsafe raw HTML rendering.
- Cross-tenant access to cases, analysis runs or evidence.
- Public object storage and provider-key leakage.
- Queue request spoofing, replay and duplicate work.
- Raw email content or secrets written to logs.
- Prompt injection if an LLM is added later.

## Setup controls

- Evidence is stored in a private S3-compatible bucket under opaque, tenant-scoped keys; browser clients never receive storage credentials.
- Database and storage access lives in server-only modules. No `NEXT_PUBLIC_` variable may contain a secret.
- Internal analyzer intake uses a per-environment Bearer token with constant-time comparison and no token logging.
- Repository APIs require an explicit organization context, and cross-tenant behavior is tested.
- FastAPI request IDs and safe, redacted error responses prevent raw content from entering error output.
- Upload and parser resource limits are represented by validated configuration constants.
- The browser calls oRPC, not FastAPI. Setup has no URL fetching, raw HTML rendering or attachment execution.
- Dramatiq uses `analysisRunId` as the idempotency key and bounded retries; setup jobs never create a verdict.
- CI runs secret scanning, dependency auditing and analyzer container scanning.

Product phases must add parser isolation, content sanitization, SSRF controls and report-renderer network policy before enabling those capabilities.

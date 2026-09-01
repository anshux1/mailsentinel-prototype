# Threat model baseline

MailSentinel treats email as hostile input. MIME/parser resource exhaustion, decompression bombs, path traversal, SSRF, stored XSS, attachment execution, cross-tenant access, public object storage, provider-key leakage, queue spoofing/replay, and unsafe report rendering are explicit threats. Future LLM features must also treat content as prompt injection.

Controls before product work: private opaque S3 keys, server-only secrets, constant-time internal tokens, explicit organization-scoped repository APIs, request IDs, redacted structured logs, bounded upload constants, no browser-to-analyzer calls, no raw HTML rendering, URL fetching or attachment execution. Run dependency and secret scans in CI.

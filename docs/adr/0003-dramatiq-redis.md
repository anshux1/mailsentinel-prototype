# ADR 0003: Dramatiq + Redis

- **Context:** Analysis intake must be asynchronous.
- **Decision:** Dramatiq workers use Redis, with `analysisRunId` as the idempotency key.
- **Alternatives:** Celery/RabbitMQ and synchronous analysis.
- **Consequences:** Simple local operations and retry-ready jobs.
- **Reversal:** Preserve actor payloads and status enums when migrating queues.

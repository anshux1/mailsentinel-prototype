# ADR 0003: Dramatiq + Redis

## Context

Analysis intake must be asynchronous, retryable and isolated from the browser request lifecycle without adding another broker runtime to local setup.

## Decision

Dramatiq workers use Redis. The initial actor carries only `analysisRunId`, which is the idempotency key; the setup actor acknowledges safe deferred work and does not produce a verdict.

## Alternatives considered

Celery/RabbitMQ, a managed queue and synchronous analysis were considered. They were deferred because Redis already supports the local stack and the setup phase needs only a small internal queue boundary.

## Consequences

The worker is simple to run in Compose and can adopt retries, dead-letter handling and status transitions later. Redis availability and queue observability become operational responsibilities.

## Migration and reversal path

A queue migration must preserve the actor payload, idempotency semantics and status enum during a dual-publish or drain period. Replacing Dramatiq/Redis is safe after the replacement consumes the same contract and queued work is drained.

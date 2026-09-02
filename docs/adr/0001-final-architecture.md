# ADR 0001: Final architecture

## Context

A secure two-runtime forensic prototype needs clear boundaries between the browser-facing application, private analysis service, durable workflow state and evidence objects.

## Decision

Next.js/React/TypeScript is the application runtime. Tailwind CSS remains the styling system. FastAPI is the private analyzer; PostgreSQL is canonical for identity, tenancy and workflow metadata; MinIO/S3 stores private evidence; and Redis backs Dramatiq.

Neo4j, machine learning, LLMs, sandboxing and live enrichment integrations are deliberately not setup blockers.

## Alternatives considered

A single Python service, a browser-direct analyzer, or a graph database as the system of record were considered and rejected for the setup phase.

## Consequences

The boundaries are independently deployable and enforceable, but local development needs several services and generated contracts.

## Migration and reversal path

A future consolidation or storage migration must preserve the oRPC and analyzer contracts, move data through adapters/backfills, and keep PostgreSQL/S3 ownership explicit until the replacement is verified.

# ADR 0004: Source of truth

## Context

Identity, tenancy, workflow metadata and original evidence need durable ownership with auditable boundaries. A filesystem-only setup would not provide the relational controls required for tenant queries.

## Decision

PostgreSQL owns identity, tenancy, case and workflow metadata. S3-compatible storage owns immutable evidence objects. Object keys are private, opaque and scoped; the database stores their metadata, digest and byte size.

## Alternatives considered

A local filesystem, S3 as the only source of truth, or a graph database as the canonical store were considered and rejected for setup. Graph storage may be added later as a derived view, not as authority.

## Consequences

Relational transactions and tenant constraints remain authoritative while large artifacts stay outside PostgreSQL. Uploads require coordinated metadata/object handling and retention operations.

## Migration and reversal path

A new storage authority must be introduced behind an adapter, backfilled with verified digests and cut over only after reads and retention are validated. Reversal means retaining PostgreSQL metadata and restoring the previous object-store adapter until the migration is complete.

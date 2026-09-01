# ADR 0004: Source of truth

- **Context:** Evidence and workflow state need durable ownership.
- **Decision:** PostgreSQL owns identity, tenancy and workflow metadata; S3 owns immutable artifacts.
- **Alternatives:** Filesystem or graph database as canonical store.
- **Consequences:** Transactions remain relational and artifacts remain private.
- **Reversal:** Add an adapter and backfill before changing ownership.

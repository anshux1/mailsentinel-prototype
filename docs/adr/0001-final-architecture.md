# ADR 0001: Final architecture

- **Context:** A secure two-runtime forensic prototype needs clear boundaries.
- **Decision:** Next.js/React/TypeScript is the application runtime; FastAPI is the private analyzer; PostgreSQL is canonical, MinIO/S3 stores evidence, and Redis backs Dramatiq.
- **Alternatives:** A single Python service or browser-direct analyzer.
- **Consequences:** Typed boundaries and independent scaling; more local services.
- **Reversal:** Consolidate only after contracts and data ownership are preserved.

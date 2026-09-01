# ADR 0002: oRPC and FastAPI boundaries

- **Context:** Browser APIs and internal analysis have different consumers.
- **Decision:** oRPC is browser-facing; FastAPI OpenAPI is internal only and never called from browsers.
- **Alternatives:** REST everywhere or exposing FastAPI.
- **Consequences:** Type-safe app calls and a deliberately protected service boundary.
- **Reversal:** Replace the generated boundary only with frontend/backend review.

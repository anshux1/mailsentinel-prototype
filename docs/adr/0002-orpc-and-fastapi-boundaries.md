# ADR 0002: oRPC and FastAPI boundaries

## Context

Browser APIs and internal analysis have different consumers, trust levels and release cycles.

## Decision

oRPC is the browser-facing contract and runs through the Next.js server. FastAPI OpenAPI is only the private analyzer contract. FastAPI is not directly exposed to the browser; the Node runtime uses a server-only, token-authenticated client for internal calls.

## Alternatives considered

REST everywhere, a shared browser-to-FastAPI API, or exposing the analyzer publicly were considered and rejected.

## Consequences

Application calls are type-safe and tenant/session-aware, while the analyzer has an explicit generated boundary. Contract generation and internal token rotation become operational responsibilities.

## Migration and reversal path

Replacing oRPC or FastAPI requires a versioned adapter and frontend/backend review. The browser must retain an application-owned boundary even if the internal transport changes.

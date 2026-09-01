# ADR 0005: Turborepo monorepo

- **Context:** Web, shared TypeScript contracts and analyzer need coordinated CI.
- **Decision:** pnpm workspaces and Turborepo orchestrate JavaScript and Python bridge scripts.
- **Alternatives:** Separate repositories or custom shell orchestration.
- **Consequences:** Shared commits and cacheable checks; Python remains uv-owned.
- **Reversal:** Extract runtime packages while retaining published contracts.

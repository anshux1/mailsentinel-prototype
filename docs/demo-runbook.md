# Local demo runbook

Requirements: Node 22, pnpm 9, Python 3.12, uv and Docker Compose.

```bash
pnpm install --frozen-lockfile
cd apps/analyzer && uv sync --locked && cd ../..
docker compose -f infra/compose.yaml up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Web is on `http://localhost:3000`; analyzer is internal in Compose. The protected intake contract uses the token from `apps/analyzer/.env.example`. Stop with `docker compose -f infra/compose.yaml down`; reset volumes with `down -v`.

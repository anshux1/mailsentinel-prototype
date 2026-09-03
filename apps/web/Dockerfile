# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# Refresh Debian security packages
RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app

# Copy root workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy all workspace package manifests
COPY apps/web/package.json ./apps/web/
COPY packages/auth/package.json ./packages/auth/
COPY packages/biome-config/package.json ./packages/biome-config/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/fixtures/package.json ./packages/fixtures/
COPY packages/typescript-config/package.json ./packages/typescript-config/
COPY packages/ui/package.json ./packages/ui/

RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app

COPY --from=deps /app ./
COPY turbo.json ./
COPY packages ./packages
COPY apps/web ./apps/web

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Dummy build-time environment values to satisfy @t3-oss/env-nextjs validation during next build
ENV DATABASE_URL="postgresql://mailsentinel:mailsentinel@postgres:5432/mailsentinel"
ENV BETTER_AUTH_SECRET="build-time-auth-secret-placeholder-minimum-32-chars"
ENV BETTER_AUTH_URL="http://localhost:3000"
ENV ANALYZER_INTERNAL_URL="http://analyzer:8000"
ENV ANALYZER_SERVICE_TOKEN="build-time-analyzer-token-placeholder"
ENV S3_ENDPOINT="http://minio:9000"
ENV S3_REGION="us-east-1"
ENV S3_BUCKET="mailsentinel-evidence"
ENV S3_ACCESS_KEY_ID="mailsentinel"
ENV S3_SECRET_ACCESS_KEY="mailsentinel-local-secret"
ENV S3_FORCE_PATH_STYLE="true"
ENV APP_ENV="development"
ENV WEB_DATA_MODE="fixture"
ENV MAILBOX_CONNECTORS_ENABLED="false"

RUN pnpm --filter @mailsentinel/web build

# Migrator target for one-shot db:migrate and db:seed execution in Docker Compose
FROM builder AS migrator
WORKDIR /app
CMD ["pnpm", "db:migrate"]

# Lean standalone production web runner
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build outputs
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/rpc/system/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/web/server.js"]

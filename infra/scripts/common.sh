#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="docker compose -f $ROOT/infra/compose.yaml"
export DATABASE_URL=${DATABASE_URL:-postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel}
export BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-local-development-auth-secret-change-me}

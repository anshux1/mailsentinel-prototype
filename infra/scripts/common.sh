#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="docker compose -f $ROOT/infra/compose.yaml"

# Passing -f makes infra/ the project directory, so a repository-root .env is
# not reliably discovered. Point at it explicitly when present, so overrides
# live in one obvious place no matter which entry point is used.
if [ -f "$ROOT/.env" ]; then
	COMPOSE="$COMPOSE --env-file $ROOT/.env"
fi

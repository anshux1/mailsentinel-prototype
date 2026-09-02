#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/common.sh"
$COMPOSE up -d --build --wait postgres redis minio analyzer worker
"$ROOT/infra/scripts/migrate.sh"
"$ROOT/infra/scripts/seed.sh"
printf '%s\n' 'MailSentinel infrastructure is healthy and seeded.'

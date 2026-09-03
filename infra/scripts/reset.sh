#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/common.sh"

# Destructive: stops containers and removes persistent volumes (database, redis, evidence storage)
printf '%s\n' 'WARNING: Resetting MailSentinel local stack and destroying all persistent volumes (postgres, redis, minio)...'
$COMPOSE down --volumes --remove-orphans
"$ROOT/infra/scripts/start.sh"

#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/common.sh"

# Starts postgres, redis, minio, minio-init, migrate, analyzer, worker, and web
$COMPOSE up -d --build --wait postgres redis minio analyzer worker web

$COMPOSE run --rm seed

printf '%s\n' 'MailSentinel stack is healthy and seeded.'
printf '%s\n' 'Web application: http://localhost:3000'
printf '%s\n' 'Demo login: demo@mailsentinel.local / MailSentinel-Demo-2026!'

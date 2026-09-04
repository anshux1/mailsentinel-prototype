#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/common.sh"

# Starts postgres, redis, minio, migrations, seed, analyzer, worker, and web.
$COMPOSE up -d --build --wait postgres redis minio analyzer worker web

printf '%s\n' 'MailSentinel stack is healthy and seeded.'
printf '%s\n' 'Web application: http://localhost:3000'
printf '%s\n' 'Demo login: demo@mailsentinel.local / MailSentinel-Demo-2026!'

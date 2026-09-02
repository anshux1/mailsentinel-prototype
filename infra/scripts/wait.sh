#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/common.sh"
$COMPOSE up -d --wait postgres redis minio analyzer worker
$COMPOSE ps

#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/common.sh"
$COMPOSE run --rm minio-init

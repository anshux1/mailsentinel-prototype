#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/common.sh"
$COMPOSE down --volumes --remove-orphans
"$ROOT/infra/scripts/start.sh"

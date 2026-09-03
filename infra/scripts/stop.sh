#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/common.sh"

$COMPOSE down --remove-orphans
printf '%s\n' 'MailSentinel stack stopped cleanly (persistent volumes preserved).'

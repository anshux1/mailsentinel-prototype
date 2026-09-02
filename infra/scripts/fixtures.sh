#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/common.sh"
# Setup fixtures are contract-only and committed under packages/fixtures.
test -f "$ROOT/packages/fixtures/contracts/analyzer.valid.json"
printf '%s\n' 'Synthetic contract fixtures are available.'

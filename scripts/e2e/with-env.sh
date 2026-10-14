#!/usr/bin/env bash
# Runs a command with the e2e env file loaded (scripts/e2e/ci-env.sh), without
# exporting it to the rest of the job or printing it.
#
#   scripts/e2e/with-env.sh npm run db:migrate
set -euo pipefail

file="${E2E_CI_ENV_FILE:-.secrets/ci.env}"
[ -f "$file" ] || { echo "with-env.sh: $file is missing (run scripts/e2e/ci-env.sh first)" >&2; exit 2; }

set -a
# shellcheck disable=SC1090
. "$file"
set +a

exec "$@"

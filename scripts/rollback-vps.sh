#!/usr/bin/env sh
# Manual rollback (M10 B5; docs/runbooks/deploy.md "Manual rollback"): the
# same code-and-image rollback deploy-vps.sh runs automatically, under the
# same deploy lock.
#
#   scripts/rollback-vps.sh            back to meetsum:previous (and its SHA)
#   scripts/rollback-vps.sh <sha>      back to <sha> (rebuilds meetsum:<sha12> if missing)
#   scripts/rollback-vps.sh --dry-run  print the plan
#
# The database is never rolled back here: restore the pre-deploy backup with
# scripts/restore-postgres.sh only after reading the runbook.
set -eu

exec "$(dirname "$0")/deploy-vps.sh" --rollback "$@"

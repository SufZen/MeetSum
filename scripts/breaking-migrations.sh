#!/usr/bin/env sh
# Lists the pending migrations marked non-backward-compatible (v0.7.1; used
# by scripts/deploy-vps.sh to switch to maintenance mode).
#
#   <applied versions, one per line> | scripts/breaking-migrations.sh [db/migrations]
#
# A migration is marked by a line starting with `-- meetsum:breaking` (put a
# reason after it): the release before it cannot run against the migrated
# schema, so app and worker must be stopped before it is applied. Prints one
# file name per pending marked migration; prints nothing when none is
# pending. Applied versions come from `select version from schema_migrations`.
set -eu

dir="${1:-db/migrations}"
applied="$(tr -d ' \r\t')"

for file in "$dir"/[0-9]*_*.sql; do
  [ -f "$file" ] || continue
  grep -q '^-- meetsum:breaking' "$file" || continue
  name="$(basename "$file")"
  version="${name%%_*}"
  if ! printf '%s\n' "$applied" | grep -qx "$version"; then
    printf '%s\n' "$name"
  fi
done

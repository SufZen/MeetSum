#!/usr/bin/env sh
# Pre-deploy / scheduled Postgres backup (custom format). Fails hard (non-zero)
# when pg_dump fails or writes nothing, so scripts/deploy-vps.sh never deploys
# without a backup. Prints the backup path on success.
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.local}"
BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/meetsum-postgres-${TIMESTAMP}.dump"
PARTIAL_FILE="${BACKUP_FILE}.partial"

mkdir -p "$BACKUP_DIR"
trap 'rm -f "$PARTIAL_FILE"' EXIT

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' > "$PARTIAL_FILE"

if [ ! -s "$PARTIAL_FILE" ]; then
  echo "backup-postgres: pg_dump produced an empty file" >&2
  exit 1
fi

mv "$PARTIAL_FILE" "$BACKUP_FILE"
echo "$BACKUP_FILE"

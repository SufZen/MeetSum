#!/usr/bin/env sh
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.local}"
BACKUP_FILE="${1:-}"
CONFIRM="${2:-}"

if [ -z "$BACKUP_FILE" ] || [ "$CONFIRM" != "--confirm-restore" ]; then
  echo "Usage: scripts/restore-postgres.sh <backup.dump> --confirm-restore" >&2
  echo "Restore is destructive. Create a fresh backup before running it." >&2
  exit 2
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U "${POSTGRES_USER:-meetings}" -d "${POSTGRES_DB:-meetings}" \
  --clean --if-exists --no-owner --no-privileges < "$BACKUP_FILE"

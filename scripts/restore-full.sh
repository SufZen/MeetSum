#!/usr/bin/env sh
# Unified restore: Postgres + MinIO from a backup directory
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
LOCAL_COMPOSE_FILE="${LOCAL_COMPOSE_FILE:-docker-compose.local.yml}"
ENV_FILE="${ENV_FILE:-.env.local}"
MINIO_BACKUP_URL="${MINIO_BACKUP_URL:-http://minio:9000}"

# Same files as scripts/deploy-vps.sh: the host-local override when present.
COMPOSE_ARGS="-f $COMPOSE_FILE"
if [ -f "$LOCAL_COMPOSE_FILE" ]; then
  COMPOSE_ARGS="$COMPOSE_ARGS -f $LOCAL_COMPOSE_FILE"
fi

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup-directory> [--confirm-restore]"
  echo ""
  echo "Example:"
  echo "  $0 ./backups/20260529T080000Z --confirm-restore"
  exit 1
fi

BACKUP_DIR="$1"
CONFIRM="${2:-}"

if [ ! -d "$BACKUP_DIR" ]; then
  echo "Error: Backup directory not found: $BACKUP_DIR"
  exit 1
fi

MANIFEST="${BACKUP_DIR}/manifest.json"
if [ ! -f "$MANIFEST" ]; then
  echo "Error: manifest.json not found in ${BACKUP_DIR}"
  exit 1
fi

# Parse manifest
BACKUP_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('${MANIFEST}','utf8')).version" 2>/dev/null || echo "unknown")
BACKUP_TIMESTAMP=$(node -p "JSON.parse(require('fs').readFileSync('${MANIFEST}','utf8')).timestamp" 2>/dev/null || echo "unknown")
CURRENT_VERSION=$(node -p 'require("./package.json").version' 2>/dev/null || echo "unknown")

echo "=== MeetSum Restore ==="
echo "Backup:    ${BACKUP_TIMESTAMP}"
echo "Version:   ${BACKUP_VERSION} (current: ${CURRENT_VERSION})"
echo "Source:    ${BACKUP_DIR}"
echo ""

# Version compatibility check
if [ "$BACKUP_VERSION" != "$CURRENT_VERSION" ] && [ "$BACKUP_VERSION" != "unknown" ]; then
  echo "⚠ WARNING: Backup version (${BACKUP_VERSION}) differs from current version (${CURRENT_VERSION})"
  echo "  Migrations may need to be re-run after restore."
  echo ""
fi

if [ "$CONFIRM" != "--confirm-restore" ]; then
  echo "This is a DESTRUCTIVE operation. It will replace:"
  echo "  - All Postgres data"
  echo "  - All MinIO objects (if backup contains minio/)"
  echo ""
  echo "To proceed, run:"
  echo "  $0 $BACKUP_DIR --confirm-restore"
  exit 0
fi

# --- Restore Postgres ---
PG_FILE="${BACKUP_DIR}/postgres.dump"
if [ -f "$PG_FILE" ]; then
  echo "[1/2] Restoring Postgres..."

  # Validate checksum if available
  EXPECTED_SHA=$(node -p "JSON.parse(require('fs').readFileSync('${MANIFEST}','utf8')).files.find(f=>f.name==='postgres.dump')?.sha256||''" 2>/dev/null || echo "")
  if [ -n "$EXPECTED_SHA" ]; then
    ACTUAL_SHA=$(sha256sum "$PG_FILE" | cut -d' ' -f1)
    if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
      echo "  ERROR: Checksum mismatch for postgres.dump!"
      echo "  Expected: ${EXPECTED_SHA}"
      echo "  Actual:   ${ACTUAL_SHA}"
      exit 1
    fi
    echo "  ✓ Checksum verified"
  fi

  # shellcheck disable=SC2086
  docker compose --env-file "$ENV_FILE" $COMPOSE_ARGS exec -T postgres \
    pg_restore -U "${POSTGRES_USER:-meetings}" -d "${POSTGRES_DB:-meetings}" \
    --clean --if-exists --no-owner --no-privileges < "$PG_FILE"

  echo "  ✓ Postgres restored"
else
  echo "[1/2] Skipping Postgres (no postgres.dump found)"
fi

# --- Restore MinIO ---
MINIO_DIR="${BACKUP_DIR}/minio"
if [ -d "$MINIO_DIR" ] && [ "$(ls -A "$MINIO_DIR" 2>/dev/null)" ]; then
  echo "[2/2] Restoring MinIO..."
  # Through a throwaway container of the minio service (its image ships
  # `mc`; no `mc` on the host), the backup bind-mounted read-only. --no-deps
  # and --pull never: nothing is started, recreated or pulled.
  MINIO_DIR_ABS="$(cd "$MINIO_DIR" && pwd)"
  # shellcheck disable=SC2016,SC2086
  if ! docker compose --env-file "$ENV_FILE" $COMPOSE_ARGS run --rm --no-deps -T --pull never --entrypoint sh -v "${MINIO_DIR_ABS}:/backup:ro" minio -c \
    'mc alias set meetsum-restore "$0" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --overwrite --quiet /backup/ meetsum-restore/' \
    "$MINIO_BACKUP_URL"; then
    echo "  ERROR: MinIO restore failed (mc mirror in a throwaway minio container)" >&2
    exit 1
  fi
  echo "  ✓ MinIO restored"
else
  echo "[2/2] Skipping MinIO (no minio/ data found)"
fi

echo ""
echo "=== Restore Complete ==="
echo "Run 'npm run db:migrate' if version differs from backup."

#!/usr/bin/env sh
# Unified backup: Postgres + MinIO + manifest (docs/backup-restore.md).
#
# MinIO is mirrored through a throwaway container of the minio service (its
# image ships `mc`; no `mc` on the host): `docker compose run --rm --no-deps`
# with the backup directory bind-mounted at /backup. --no-deps and
# --pull never: it never starts, recreates or pulls anything. Any failure,
# Postgres or MinIO, exits non-zero and leaves no manifest.
#
# Credentials stay inside the container (compose passes MINIO_ROOT_USER /
# MINIO_ROOT_PASSWORD from the env file); nothing here prints them.
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
LOCAL_COMPOSE_FILE="${LOCAL_COMPOSE_FILE:-docker-compose.local.yml}"
ENV_FILE="${ENV_FILE:-.env.local}"
BACKUP_ROOT="${BACKUP_DIR:-./backups}"
# MinIO API as seen from the throwaway container (the service name on the
# compose network).
MINIO_BACKUP_URL="${MINIO_BACKUP_URL:-http://minio:9000}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
VERSION="$(node -p 'require("./package.json").version' 2>/dev/null || echo 'unknown')"

# Same files as scripts/deploy-vps.sh: the host-local override when present.
COMPOSE_ARGS="-f $COMPOSE_FILE"
if [ -f "$LOCAL_COMPOSE_FILE" ]; then
  COMPOSE_ARGS="$COMPOSE_ARGS -f $LOCAL_COMPOSE_FILE"
fi

compose() {
  # shellcheck disable=SC2086
  docker compose --env-file "$ENV_FILE" $COMPOSE_ARGS "$@"
}

echo "=== MeetSum Full Backup ==="
echo "Timestamp: ${TIMESTAMP}"
echo "Version:   ${VERSION}"
echo "Target:    ${BACKUP_DIR}"
echo ""

mkdir -p "${BACKUP_DIR}/minio"
# Absolute path for the bind mount.
MINIO_DIR_ABS="$(cd "${BACKUP_DIR}/minio" && pwd)"

# --- Postgres Dump ---
echo "[1/3] Dumping Postgres..."
PG_FILE="${BACKUP_DIR}/postgres.dump"
compose exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-meetings}" -d "${POSTGRES_DB:-meetings}" \
  --format=custom --no-owner --no-privileges > "$PG_FILE"

if [ ! -s "$PG_FILE" ]; then
  echo "  ERROR: pg_dump produced an empty file" >&2
  exit 1
fi
PG_SIZE=$(wc -c < "$PG_FILE" | tr -d ' ')
PG_SHA=$(sha256sum "$PG_FILE" | cut -d' ' -f1)
echo "  → postgres.dump (${PG_SIZE} bytes)"

# --- MinIO Snapshot ---
echo "[2/3] Mirroring MinIO buckets (through the minio container)..."
# shellcheck disable=SC2016
if ! compose run --rm --no-deps -T --pull never --entrypoint sh -v "${MINIO_DIR_ABS}:/backup" minio -c \
  'mc alias set meetsum-backup "$0" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --overwrite --quiet meetsum-backup/ /backup/' \
  "$MINIO_BACKUP_URL"; then
  echo "  ERROR: MinIO backup failed (mc mirror in a throwaway minio container); no manifest written" >&2
  exit 1
fi
MINIO_SIZE=$(du -sb "${BACKUP_DIR}/minio/" | cut -f1)
echo "  → minio/ (${MINIO_SIZE} bytes)"

# --- Manifest ---
echo "[3/3] Writing manifest..."
cat > "${BACKUP_DIR}/manifest.json" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "version": "${VERSION}",
  "files": [
    {
      "name": "postgres.dump",
      "sizeBytes": ${PG_SIZE},
      "sha256": "${PG_SHA}"
    },
    {
      "name": "minio/",
      "sizeBytes": ${MINIO_SIZE},
      "type": "directory"
    }
  ]
}
EOF

echo ""
echo "=== Backup Complete ==="
echo "Location: ${BACKUP_DIR}"
echo "Manifest: ${BACKUP_DIR}/manifest.json"

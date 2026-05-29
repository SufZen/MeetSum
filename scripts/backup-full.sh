#!/usr/bin/env sh
# Unified backup: Postgres + MinIO + manifest
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.local}"
BACKUP_ROOT="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
VERSION="$(node -p 'require("./package.json").version' 2>/dev/null || echo 'unknown')"

echo "=== MeetSum Full Backup ==="
echo "Timestamp: ${TIMESTAMP}"
echo "Version:   ${VERSION}"
echo "Target:    ${BACKUP_DIR}"
echo ""

mkdir -p "${BACKUP_DIR}/minio"

# --- Postgres Dump ---
echo "[1/3] Dumping Postgres..."
PG_FILE="${BACKUP_DIR}/postgres.dump"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-meetings}" -d "${POSTGRES_DB:-meetings}" \
  --format=custom --no-owner --no-privileges > "$PG_FILE"

PG_SIZE=$(wc -c < "$PG_FILE" | tr -d ' ')
PG_SHA=$(sha256sum "$PG_FILE" | cut -d' ' -f1)
echo "  → postgres.dump (${PG_SIZE} bytes)"

# --- MinIO Snapshot ---
echo "[2/3] Snapshotting MinIO buckets..."
MINIO_ALIAS="${MINIO_ALIAS:-meetsum}"

# Check if mc is available and alias exists
if command -v mc >/dev/null 2>&1; then
  mc mirror --overwrite "${MINIO_ALIAS}/" "${BACKUP_DIR}/minio/" 2>/dev/null || {
    echo "  ⚠ MinIO mirror failed — skipping (is mc configured with alias '${MINIO_ALIAS}'?)"
  }
  MINIO_SIZE=$(du -sb "${BACKUP_DIR}/minio/" 2>/dev/null | cut -f1 || echo "0")
else
  echo "  ⚠ mc not found — skipping MinIO backup"
  MINIO_SIZE="0"
fi
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

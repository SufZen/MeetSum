#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/meetsum}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

cd "$APP_DIR"

./scripts/backup-postgres.sh
git pull --ff-only
docker compose -f "$COMPOSE_FILE" build app worker migrate
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans
docker compose -f "$COMPOSE_FILE" ps

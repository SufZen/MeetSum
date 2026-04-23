#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/meetsum}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.local}"

cd "$APP_DIR"

./scripts/backup-postgres.sh
git pull --ff-only
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build app migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

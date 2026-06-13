#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/meetsum}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
MIGRATE_FILE="${MIGRATE_FILE:-docker-compose.migrate.yml}"
ENV_FILE="${ENV_FILE:-.env.local}"

cd "$APP_DIR"

./scripts/backup-postgres.sh
git pull --ff-only

# Build the app/worker images (the `migrate` service lives in its own compose
# file and is not part of docker-compose.prod.yml).
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build app worker

# Run pending database migrations as a one-off (merges both files so the
# migrate service can see the postgres service it depends on). Fails the deploy
# if a migration errors.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$MIGRATE_FILE" run --rm migrate

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

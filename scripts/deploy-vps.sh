#!/usr/bin/env sh
# MeetSum production deploy (M10 B5, v0.7.1; docs/runbooks/deploy.md). The
# only deploy path: .github/workflows/deploy.yml runs this script over SSH,
# and operators run it by hand.
#
#   scripts/deploy-vps.sh [--dry-run] [--maintenance] [--allow-infra-change]
#                                   deploy origin/main (or $DEPLOY_SHA)
#   scripts/deploy-vps.sh --rollback [<sha>] [--dry-run]
#                                   manual rollback (scripts/rollback-vps.sh)
#
#   --maintenance         stop app + worker before the migrations (write
#                         freeze). Automatic when a pending migration is
#                         marked `-- meetsum:breaking` (scripts/breaking-migrations.sh).
#   --allow-infra-change  proceed although a running postgres/redis/minio
#                         container does not run the configured image
#                         (scripts/infra-drift.sh). The deploy still never
#                         recreates infra containers; switch them explicitly
#                         (docs/runbooks/deploy.md "Infra images").
#
# Steps: deploy lock (flock) -> preflight (env file, compose config, disk,
# postgres healthy, infra image drift) -> backup (hard fail) -> git pull ->
# ONE image build (meetsum:<sha>) -> breaking-migration check -> [maintenance:
# stop app + worker -> backup again] -> migrations with the new image
# (`run --rm --no-deps migrate`) BEFORE the switch -> `up -d --no-deps app
# worker` -> readiness wait (120 s) -> on failure an automatic rollback of code
# and image (never the database; not after a breaking migration).
#
# Only app and worker are ever started by `up` (always with --no-deps), and
# migrate runs with --no-deps: a deploy never creates or recreates postgres,
# redis or minio, even when their configuration changed.
#
# Compose files: docker-compose.prod.yml, plus docker-compose.local.yml (the
# host-local, git-ignored override) whenever it exists; migrate adds
# docker-compose.migrate.yml. File paths must not contain spaces.
#
# Images: app, worker and migrate share meetsum:${MEETSUM_IMAGE_TAG}.
# meetsum:current is the release that passed readiness; meetsum:previous the
# one before it. Each image carries its git SHA as the
# org.opencontainers.image.revision label.
#
# This script never prints environment values: compose reads the env file
# itself and nothing here cats or echoes it.
set -eu

APP_DIR="${APP_DIR:-/opt/meetsum}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
MIGRATE_FILE="${MIGRATE_FILE:-docker-compose.migrate.yml}"
LOCAL_COMPOSE_FILE="${LOCAL_COMPOSE_FILE:-docker-compose.local.yml}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-db/migrations}"
ENV_FILE="${ENV_FILE:-.env.local}"
LOCK_FILE="${LOCK_FILE:-$APP_DIR/.deploy.lock}"
LOCK_WAIT_SECONDS="${LOCK_WAIT_SECONDS:-600}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-120}"
MIN_FREE_KB="${MIN_FREE_KB:-5242880}" # 5 GB
DEPLOY_SHA="${DEPLOY_SHA:-}"
IMAGE_REPO="meetsum"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DRY_RUN=0
MODE=deploy
ROLLBACK_SHA=""
MAINTENANCE=0
ALLOW_INFRA_CHANGE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --maintenance) MAINTENANCE=1 ;;
    --allow-infra-change) ALLOW_INFRA_CHANGE=1 ;;
    --rollback)
      MODE=rollback
      if [ "$#" -gt 1 ] && [ "${2#-}" = "$2" ]; then
        ROLLBACK_SHA="$2"
        shift
      fi
      ;;
    -h | --help)
      sed -n '2,42p' "$0"
      exit 0
      ;;
    *)
      echo "deploy: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '%s deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

step() {
  log "STEP $*"
}

# Runs a command, or prints it in --dry-run mode.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  + %s\n' "$*"
    return 0
  fi
  "$@"
}

# -f arguments (word-split on purpose; see "File paths must not contain spaces").
# Set after `cd "$APP_DIR"` so the local override is found relative to it.
COMPOSE_ARGS=""
MIGRATE_ARGS=""

set_compose_args() {
  COMPOSE_ARGS="-f $COMPOSE_FILE"
  MIGRATE_ARGS="-f $COMPOSE_FILE -f $MIGRATE_FILE"
  if [ -f "$LOCAL_COMPOSE_FILE" ]; then
    COMPOSE_ARGS="$COMPOSE_ARGS -f $LOCAL_COMPOSE_FILE"
    MIGRATE_ARGS="$MIGRATE_ARGS -f $LOCAL_COMPOSE_FILE"
  fi
}

compose() {
  # shellcheck disable=SC2086
  run docker compose --env-file "$ENV_FILE" $COMPOSE_ARGS "$@"
}

# compose_tag <image tag> <git sha or ""> <compose args...>: compose with
# MEETSUM_IMAGE_TAG (and MEETSUM_GIT_SHA for builds) set for that command only.
compose_tag() {
  _ct_tag="$1"
  _ct_sha="$2"
  shift 2
  # shellcheck disable=SC2086
  run env MEETSUM_IMAGE_TAG="$_ct_tag" MEETSUM_GIT_SHA="$_ct_sha" docker compose --env-file "$ENV_FILE" $COMPOSE_ARGS "$@"
}

compose_migrate_tag() {
  _ct_tag="$1"
  shift
  # shellcheck disable=SC2086
  run env MEETSUM_IMAGE_TAG="$_ct_tag" docker compose --env-file "$ENV_FILE" $MIGRATE_ARGS "$@"
}

image_exists() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  docker image inspect "$1" >/dev/null 2>&1
}

image_revision() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "<sha of $1>"
    return 0
  fi
  docker image inspect "$1" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true
}

short_sha() {
  printf '%s' "$1" | cut -c1-12
}

acquire_lock() {
  step "lock $LOCK_FILE"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  + flock -w %s %s\n' "$LOCK_WAIT_SECONDS" "$LOCK_FILE"
    return 0
  fi
  if ! command -v flock >/dev/null 2>&1; then
    log "flock is required (util-linux)"
    exit 1
  fi
  exec 9>"$LOCK_FILE"
  if ! flock -w "$LOCK_WAIT_SECONDS" 9; then
    log "another deploy holds $LOCK_FILE; giving up after ${LOCK_WAIT_SECONDS}s"
    exit 1
  fi
}

# Fails unless the running postgres container is healthy (or running, when it
# has no healthcheck). Never starts it: infra is switched explicitly.
require_postgres_healthy() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  + require postgres healthy: docker inspect --format {{.State.Health.Status}} $(docker compose ps -q postgres)\n'
    return 0
  fi
  # shellcheck disable=SC2086
  pg_cid="$(docker compose --env-file "$ENV_FILE" $COMPOSE_ARGS ps -q postgres 2>/dev/null | head -n 1 || true)"
  if [ -z "$pg_cid" ]; then
    log "postgres is not running; start it explicitly before deploying (the deploy never starts or recreates infra)"
    return 1
  fi
  pg_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}-nohealthcheck{{end}}' "$pg_cid")"
  case "$pg_state" in
    healthy | running-nohealthcheck) return 0 ;;
  esac
  log "postgres is not healthy ($pg_state)"
  return 1
}

preflight() {
  step "preflight"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  + test -f %s\n' "$ENV_FILE"
    printf '  + docker compose %s config -q\n' "$MIGRATE_ARGS"
    printf '  + df: at least %s KB free\n' "$MIN_FREE_KB"
    require_postgres_healthy
    printf '  + scripts/infra-drift.sh --env-file %s %s (exit 3 = drift; refuse unless --allow-infra-change)\n' "$ENV_FILE" "$COMPOSE_ARGS"
    if [ "$ALLOW_INFRA_CHANGE" -eq 1 ]; then
      printf '  + --allow-infra-change: infra drift is reported but does not stop the deploy (infra is still never recreated)\n'
    fi
    return 0
  fi
  if [ ! -f "$ENV_FILE" ]; then
    log "env file $ENV_FILE is missing"
    exit 1
  fi
  # shellcheck disable=SC2086
  docker compose --env-file "$ENV_FILE" $MIGRATE_ARGS config -q
  free_kb="$(df -Pk "$APP_DIR" | awk 'NR == 2 { print $4 }')"
  if [ -z "$free_kb" ] || [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
    log "not enough disk space in $APP_DIR (${free_kb:-unknown} KB free, need $MIN_FREE_KB KB)"
    exit 1
  fi
  require_postgres_healthy || exit 1
  drift_status=0
  # shellcheck disable=SC2086
  sh "$SCRIPT_DIR/infra-drift.sh" --env-file "$ENV_FILE" $COMPOSE_ARGS || drift_status=$?
  if [ "$drift_status" -ne 0 ]; then
    if [ "$drift_status" -eq 3 ] && [ "$ALLOW_INFRA_CHANGE" -eq 1 ]; then
      log "infra image drift acknowledged (--allow-infra-change); continuing. The deploy does not recreate infra containers."
    else
      log "refusing to deploy: the configuration would change the image of a running infra container (above)."
      log "Switch infra explicitly (docs/runbooks/deploy.md \"Infra images\"), pin the running image in $LOCAL_COMPOSE_FILE, or pass --allow-infra-change."
      exit 1
    fi
  fi
}

# Sets MAINTENANCE=1 when a migration marked `-- meetsum:breaking` is not yet
# applied (scripts/breaking-migrations.sh against schema_migrations). Fails
# closed: when schema_migrations cannot be read, maintenance mode is used.
pending_breaking() {
  # shellcheck disable=SC2016,SC2086
  _pb_applied="$(docker compose --env-file "$ENV_FILE" $COMPOSE_ARGS exec -T postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select version from schema_migrations"' 2>/dev/null)" || return 1
  printf '%s\n' "$_pb_applied" | sh "$SCRIPT_DIR/breaking-migrations.sh" "$MIGRATIONS_DIR"
}

check_breaking() {
  step "schema check (breaking migrations)"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  + docker compose exec -T postgres psql -Atqc "select version from schema_migrations" | scripts/breaking-migrations.sh %s\n' "$MIGRATIONS_DIR"
    marked="$(sh "$SCRIPT_DIR/breaking-migrations.sh" "$MIGRATIONS_DIR" </dev/null | tr '\n' ' ')"
    log "migrations marked breaking: ${marked:-none}; maintenance mode when any of them is still pending"
    return 0
  fi
  if BREAKING="$(pending_breaking)"; then
    if [ -n "$BREAKING" ]; then
      log "pending breaking migration(s): $(printf '%s' "$BREAKING" | tr '\n' ' ')"
      MAINTENANCE=1
    fi
  else
    log "could not read schema_migrations; using maintenance mode to be safe"
    BREAKING=unknown
    MAINTENANCE=1
  fi
}

# Polls the app's /api/health/ready and the worker's /ready inside the
# containers until both answer 200 or the timeout passes.
wait_ready() {
  step "ready (timeout ${READY_TIMEOUT_SECONDS}s)"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  + docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready\n'
    printf '  + docker compose exec -T worker sh -c '\''wget -qO- http://127.0.0.1:$MEETSUM_WORKER_HEALTH_PORT/ready'\''\n'
    return 0
  fi
  deadline=$(($(date +%s) + READY_TIMEOUT_SECONDS))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # shellcheck disable=SC2086
    if docker compose --env-file "$ENV_FILE" $COMPOSE_ARGS exec -T app \
      wget -qO- http://127.0.0.1:3000/api/health/ready >/dev/null 2>&1 &&
      docker compose --env-file "$ENV_FILE" $COMPOSE_ARGS exec -T worker \
        sh -c 'wget -qO- "http://127.0.0.1:${MEETSUM_WORKER_HEALTH_PORT:-3101}/ready"' >/dev/null 2>&1; then
      log "app and worker are ready"
      return 0
    fi
    sleep 5
  done
  log "readiness timed out after ${READY_TIMEOUT_SECONDS}s"
  return 1
}

# Switches app + worker to an image tag and moves the code to a SHA. Never
# touches the database: restoring the pre-deploy backup is a manual step
# (scripts/restore-postgres.sh, docs/runbooks/deploy.md).
switch_to() {
  tag="$1"
  sha="$2"
  if [ -n "$sha" ]; then
    run git reset --keep "$sha"
  fi
  compose_tag "$tag" "" up -d --no-deps app worker
}

rollback() {
  step "rollback"
  if ! image_exists "$IMAGE_REPO:previous" && [ -z "$ROLLBACK_SHA" ]; then
    log "no $IMAGE_REPO:previous image to roll back to; leaving the failed release for manual repair"
    return 1
  fi
  target_tag=previous
  target_sha="${ROLLBACK_SHA:-${PREV_SHA:-}}"
  if [ -n "$ROLLBACK_SHA" ]; then
    target_tag="$(short_sha "$ROLLBACK_SHA")"
    if ! image_exists "$IMAGE_REPO:$target_tag"; then
      log "image $IMAGE_REPO:$target_tag is not on this host; rebuilding it from $ROLLBACK_SHA"
      run git reset --keep "$ROLLBACK_SHA"
      compose_tag "$target_tag" "$ROLLBACK_SHA" build app
    fi
  elif [ -z "$target_sha" ]; then
    target_sha="$(image_revision "$IMAGE_REPO:previous")"
  fi
  log "rolling back app and worker to $IMAGE_REPO:$target_tag (${target_sha:-unknown sha}); the database is not rolled back"
  switch_to "$target_tag" "$target_sha"
  if wait_ready; then
    run docker tag "$IMAGE_REPO:$target_tag" "$IMAGE_REPO:current"
    log "rollback complete"
    return 0
  fi
  log "rollback did not become ready; manual intervention needed (docs/runbooks/deploy.md)"
  return 1
}

# After a breaking migration the previous release cannot run on the schema:
# no automatic rollback. Prints the manual path (restore the write-freeze
# dump, then the old code and images).
manual_restore_help() {
  log "a breaking migration is (or may be) applied: the previous release cannot run on this schema, so there is no automatic rollback."
  log "app and worker stay as they are. To go back: restore ${FREEZE_BACKUP:-the write-freeze backup} with scripts/restore-postgres.sh,"
  log "then git reset --keep $PREV_SHA and start the old app/worker images (docs/runbooks/upgrade-0.6-to-0.7.md \"Rollback\")."
}

cd "$APP_DIR"
set_compose_args

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: printing the plan, executing nothing"
fi
if [ -f "$LOCAL_COMPOSE_FILE" ]; then
  log "using the host-local override $LOCAL_COMPOSE_FILE"
fi

acquire_lock

if [ "$MODE" = rollback ]; then
  PREV_SHA=""
  rollback
  exit $?
fi

preflight

step "backup"
# Hard fail: no deploy without a fresh database backup.
run ./scripts/backup-postgres.sh

step "pull"
if [ "$DRY_RUN" -eq 1 ]; then
  PREV_SHA="<current HEAD>"
  NEW_SHA="${DEPLOY_SHA:-<new-sha>}"
else
  PREV_SHA="$(git rev-parse HEAD)"
fi
if [ -n "$DEPLOY_SHA" ]; then
  # CI deploys exactly the commit it tested, fast-forward only.
  run git fetch origin main
  run git merge --ff-only "$DEPLOY_SHA"
else
  run git pull --ff-only origin main
fi
if [ "$DRY_RUN" -eq 0 ]; then
  NEW_SHA="$(git rev-parse HEAD)"
fi
NEW_TAG="$(short_sha "$NEW_SHA")"
log "deploying $NEW_SHA over $PREV_SHA"

step "build $IMAGE_REPO:$NEW_TAG"
# One `next build`: worker and migrate reuse the app image.
compose_tag "$NEW_TAG" "$NEW_SHA" build app

# Pending breaking migrations (file names), "unknown", or empty.
BREAKING=""
check_breaking

FREEZE_BACKUP=""
if [ "$MAINTENANCE" -eq 1 ]; then
  step "maintenance: stop app worker (write freeze)"
  # `stop` keeps the old containers, so a failed migration can `start` them again.
  compose stop app worker
  step "backup (write freeze; the restore point for this release)"
  if [ "$DRY_RUN" -eq 1 ]; then
    run ./scripts/backup-postgres.sh
  else
    FREEZE_BACKUP="$(./scripts/backup-postgres.sh)"
    log "write-freeze backup: $FREEZE_BACKUP"
  fi
fi

step "migrate (new image, before the switch)"
# Postgres must already be up and healthy: migrate runs with --no-deps, so
# compose never creates or recreates postgres here.
if ! require_postgres_healthy; then
  log "migrations not run; app and worker were not switched"
  run git reset --keep "$PREV_SHA"
  if [ "$MAINTENANCE" -eq 1 ]; then
    compose start app worker
  fi
  exit 1
fi
if ! compose_migrate_tag "$NEW_TAG" run --rm --no-deps migrate; then
  log "migrations failed; app and worker were not switched"
  if [ "$MAINTENANCE" -eq 1 ]; then
    # Safe to restart the old release only when every breaking migration that
    # was pending is still pending (each migration is its own transaction).
    STILL_PENDING="$(pending_breaking || echo unknown)"
    if [ "$BREAKING" != unknown ] && [ "$STILL_PENDING" = "$BREAKING" ]; then
      log "no breaking migration was applied; restarting the previous app and worker"
      run git reset --keep "$PREV_SHA"
      compose start app worker
    else
      manual_restore_help
    fi
  else
    run git reset --keep "$PREV_SHA"
  fi
  exit 1
fi

if image_exists "$IMAGE_REPO:current"; then
  run docker tag "$IMAGE_REPO:current" "$IMAGE_REPO:previous"
fi

step "up app worker"
compose_tag "$NEW_TAG" "" up -d --no-deps app worker

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$MAINTENANCE" -eq 1 ]; then
    log "maintenance mode: on a readiness failure after a breaking migration there is NO automatic rollback (the previous release cannot run on the new schema)"
  else
    log "on a readiness failure: automatic rollback of code and image (see --rollback --dry-run)"
  fi
fi

if wait_ready; then
  run docker tag "$IMAGE_REPO:$NEW_TAG" "$IMAGE_REPO:current"
  compose ps
  log "deployed $NEW_SHA"
  exit 0
fi

log "release $NEW_SHA is not ready"
if [ -n "$BREAKING" ]; then
  manual_restore_help
  exit 1
fi
log "rolling back"
rollback || true
exit 1

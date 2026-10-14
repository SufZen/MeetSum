#!/usr/bin/env sh
# MeetSum production deploy (M10 B5; docs/runbooks/deploy.md). The only
# deploy path: .github/workflows/deploy.yml runs this script over SSH, and
# operators run it by hand.
#
#   scripts/deploy-vps.sh [--dry-run]            deploy origin/main (or $DEPLOY_SHA)
#   scripts/deploy-vps.sh --rollback [<sha>] [--dry-run]
#                                                manual rollback (scripts/rollback-vps.sh)
#
# Steps: deploy lock (flock) -> preflight -> backup (hard fail) -> git pull
# -> ONE image build (meetsum:<sha>) -> migrations with the new image BEFORE
# the switch -> up app + worker -> readiness wait (120 s) -> on failure an
# automatic rollback of code and image (never the database).
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
ENV_FILE="${ENV_FILE:-.env.local}"
LOCK_FILE="${LOCK_FILE:-$APP_DIR/.deploy.lock}"
LOCK_WAIT_SECONDS="${LOCK_WAIT_SECONDS:-600}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-120}"
MIN_FREE_KB="${MIN_FREE_KB:-5242880}" # 5 GB
DEPLOY_SHA="${DEPLOY_SHA:-}"
IMAGE_REPO="meetsum"

DRY_RUN=0
MODE=deploy
ROLLBACK_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --rollback)
      MODE=rollback
      if [ "$#" -gt 1 ] && [ "${2#-}" = "$2" ]; then
        ROLLBACK_SHA="$2"
        shift
      fi
      ;;
    -h | --help)
      sed -n '2,20p' "$0"
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

compose() {
  run docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# compose_tag <image tag> <git sha or ""> <compose args...>: compose with
# MEETSUM_IMAGE_TAG (and MEETSUM_GIT_SHA for builds) set for that command only.
compose_tag() {
  _ct_tag="$1"
  _ct_sha="$2"
  shift 2
  run env MEETSUM_IMAGE_TAG="$_ct_tag" MEETSUM_GIT_SHA="$_ct_sha" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_migrate_tag() {
  _ct_tag="$1"
  shift
  run env MEETSUM_IMAGE_TAG="$_ct_tag" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$MIGRATE_FILE" "$@"
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

preflight() {
  step "preflight"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  + test -f %s\n' "$ENV_FILE"
    printf '  + docker compose config -q\n'
    printf '  + df: at least %s KB free\n' "$MIN_FREE_KB"
    return 0
  fi
  if [ ! -f "$ENV_FILE" ]; then
    log "env file $ENV_FILE is missing"
    exit 1
  fi
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$MIGRATE_FILE" config -q
  free_kb="$(df -Pk "$APP_DIR" | awk 'NR == 2 { print $4 }')"
  if [ -z "$free_kb" ] || [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
    log "not enough disk space in $APP_DIR (${free_kb:-unknown} KB free, need $MIN_FREE_KB KB)"
    exit 1
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
    if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T app \
      wget -qO- http://127.0.0.1:3000/api/health/ready >/dev/null 2>&1 &&
      docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T worker \
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

cd "$APP_DIR"

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: printing the plan, executing nothing"
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

step "migrate (new image, before the switch)"
# Forward-only and backward-compatible with the running release (expand/contract).
if ! compose_migrate_tag "$NEW_TAG" run --rm migrate; then
  log "migrations failed; app and worker were not switched"
  run git reset --keep "$PREV_SHA"
  exit 1
fi

if image_exists "$IMAGE_REPO:current"; then
  run docker tag "$IMAGE_REPO:current" "$IMAGE_REPO:previous"
fi

step "up app worker"
compose_tag "$NEW_TAG" "" up -d --no-deps app worker

if [ "$DRY_RUN" -eq 1 ]; then
  log "on a readiness failure: automatic rollback of code and image (see --rollback --dry-run)"
fi

if wait_ready; then
  run docker tag "$IMAGE_REPO:$NEW_TAG" "$IMAGE_REPO:current"
  compose ps
  log "deployed $NEW_SHA"
  exit 0
fi

log "release $NEW_SHA is not ready; rolling back"
rollback || true
exit 1

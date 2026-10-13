#!/usr/bin/env bash
# Bring up the Vexa sidecar for the MeetSum meeting bot (M7). Idempotent.
#
#   VEXA_ENV_FILE=/opt/meetsum/vexa.env deploy/vexa/bootstrap.sh
#
# Steps (docs/runbooks/vexa.md "Deploy"):
#   1. clone or fetch the upstream repo into $VEXA_HOME;
#   2. check out the pinned SHA and verify the tag points to it;
#   3. optionally build the bot from source (VEXA_BUILD_BOT=1), tagged with the SHA;
#   4. pull the pinned images;
#   5. record the resolved digests in deploy/vexa/vexa.lock;
#   6. docker compose -p vexa -f <upstream> -f compose.override.yml up -d gateway;
#   7. wait for the gateway health check.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/vexa.lock"
OVERRIDE="$HERE/compose.override.yml"
ENV_FILE="${VEXA_ENV_FILE:-/opt/meetsum/vexa.env}"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy deploy/vexa/vexa.env.example)" >&2; exit 1; }

# shellcheck disable=SC1090
set -a; . "$LOCK"; . "$ENV_FILE"; set +a

: "${VEXA_HOME:?set VEXA_HOME in $ENV_FILE}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN in $ENV_FILE}"
: "${INTERNAL_API_SECRET:?set INTERNAL_API_SECRET in $ENV_FILE}"
: "${VEXA_MINIO_SECRET_KEY:?set VEXA_MINIO_SECRET_KEY in $ENV_FILE}"

[[ "$VEXA_GIT_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "vexa.lock: VEXA_GIT_SHA is not a 40-hex SHA" >&2; exit 1; }

# 1. Clone or fetch.
if [ ! -d "$VEXA_HOME/.git" ]; then
  git clone --filter=blob:none "$VEXA_REPO" "$VEXA_HOME"
fi
git -C "$VEXA_HOME" fetch --tags --force origin

# 2. Pinned SHA, and the tag must resolve to it.
tag_sha="$(git -C "$VEXA_HOME" rev-parse "refs/tags/$VEXA_GIT_REF^{commit}")"
if [ "$tag_sha" != "$VEXA_GIT_SHA" ]; then
  echo "tag $VEXA_GIT_REF resolves to $tag_sha, vexa.lock pins $VEXA_GIT_SHA: refusing" >&2
  exit 1
fi
git -C "$VEXA_HOME" -c advice.detachedHead=false checkout --force "$VEXA_GIT_SHA"

# 3. Optional source build of the bot (upstream's install path is the published image).
if [ "${VEXA_BUILD_BOT:-0}" = "1" ]; then
  BROWSER_IMAGE="vexa/vexa-bot:${VEXA_GIT_SHA:0:12}"
  make -C "$VEXA_HOME/deploy/compose" bot BOT_IMAGE="$BROWSER_IMAGE"
  export BROWSER_IMAGE
fi

# The internal network shared with MeetSum (docker-compose.vexa.yml).
docker network inspect meetsum-vexa >/dev/null 2>&1 || docker network create --internal meetsum-vexa

compose=(docker compose -p vexa --env-file "$ENV_FILE" -f "$VEXA_HOME/$VEXA_COMPOSE_FILE" -f "$OVERRIDE")
if [ "${VEXA_SOCKET_PROXY:-0}" = "1" ]; then
  # Opt-in only. NOT a security boundary (see the file header): it narrows the
  # Docker API surface but CONTAINERS+POST still allow privileged containers.
  compose+=(-f "$HERE/compose.socket-proxy.yml" --profile socket-proxy)
fi

# 4. Pull the pinned images (the bot image is spawned by the runtime, so pull it too).
"${compose[@]}" pull gateway meeting-api admin-api runtime redis postgres storage storage-init
case "$BROWSER_IMAGE" in vexa/*) ;; *) docker pull "$BROWSER_IMAGE" ;; esac

# 5. Record resolved digests (repo digests of what is now local).
record_digest() {
  local key="$1" ref="$2" name digest
  name="${ref%@*}"
  digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" 2>/dev/null | head -1 | sed 's/.*@//')"
  [ -n "$digest" ] || return 0
  sed -i "s|^${key}=.*|${key}=${name}@${digest}|" "$LOCK"
}
record_digest GATEWAY_IMAGE "$GATEWAY_IMAGE"
record_digest MEETING_API_IMAGE "$MEETING_API_IMAGE"
record_digest ADMIN_API_IMAGE "$ADMIN_API_IMAGE"
record_digest RUNTIME_IMAGE "$RUNTIME_IMAGE"
record_digest POSTGRES_IMAGE "$POSTGRES_IMAGE"
record_digest REDIS_IMAGE "$REDIS_IMAGE"
case "$BROWSER_IMAGE" in vexa/*) ;; *) record_digest BROWSER_IMAGE "$BROWSER_IMAGE" ;; esac

# 6. Up: gateway pulls in admin-api, meeting-api, runtime and the infra via depends_on.
"${compose[@]}" up -d gateway

# 7. Wait for the gateway (loopback port from compose.override.yml).
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:18056/health >/dev/null 2>&1; then
    echo "vexa: gateway healthy (v${VEXA_VERSION}, ${VEXA_GIT_SHA:0:12})"
    echo "next: mint the MeetSum API token (runbook) and run: npm run vexa:configure"
    exit 0
  fi
  sleep 5
done
echo "vexa: gateway did not become healthy; check: ${compose[*]} logs gateway meeting-api" >&2
exit 1

#!/usr/bin/env sh
# Infra image drift check (v0.7.1; called by scripts/deploy-vps.sh preflight,
# docs/runbooks/deploy.md "Infra images").
#
#   scripts/infra-drift.sh <docker compose args...>
#   e.g. scripts/infra-drift.sh --env-file .env.local -f docker-compose.prod.yml -f docker-compose.local.yml
#
# For each running infra container (INFRA_SERVICES, default: postgres redis
# minio) it compares the resolved image ID of the configured image reference
# (`docker image inspect <ref>` .Id) with the image the container runs
# (`docker inspect <container>` .Image). It compares bytes, never reference
# strings: a digest-pinned reference to the image already running is not
# drift.
#
# Exit 0: no drift. Exit 3: at least one running container would change image
# (or its configured image is not on this host, or cannot be resolved). It
# only reads: it never pulls, runs, recreates or removes anything.
set -eu

SERVICES="${INFRA_SERVICES:-postgres redis minio}"
drift=0

say() {
  printf 'infra-drift: %s\n' "$*"
}

for svc in $SERVICES; do
  cid="$(docker compose "$@" ps -q "$svc" 2>/dev/null | head -n 1 || true)"
  if [ -z "$cid" ]; then
    say "$svc: no running container; nothing to compare"
    continue
  fi
  running="$(docker inspect --format '{{.Image}}' "$cid")"
  refs="$(docker compose "$@" config --images "$svc" 2>/dev/null || true)"
  count="$(printf '%s\n' "$refs" | awk 'NF { n++ } END { print n + 0 }')"
  if [ "$count" -ne 1 ]; then
    say "$svc: DRIFT: cannot resolve the configured image reference (got $count); refusing to guess"
    drift=1
    continue
  fi
  ref="$(printf '%s\n' "$refs" | awk 'NF { print $1; exit }')"
  configured="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
  if [ -z "$configured" ]; then
    say "$svc: DRIFT: configured image $ref is not on this host (running $running)."
    say "  'docker compose pull $svc' fetches it without recreating anything; then run this check again."
    drift=1
  elif [ "$configured" != "$running" ]; then
    say "$svc: DRIFT: the running container uses $running, the configuration resolves $ref to $configured"
    drift=1
  else
    say "$svc: running image matches $ref ($running)"
  fi
done

if [ "$drift" -ne 0 ]; then
  exit 3
fi

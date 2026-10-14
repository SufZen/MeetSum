#!/usr/bin/env bash
# Collects the e2e service logs into e2e-logs/ and scrubs them (secrets from
# the per-run env file, session cookies, bearer tokens) before the workflow
# uploads the directory as an artifact. Never fails the job.
set -uo pipefail

env_file="${E2E_CI_ENV_FILE:-.secrets/ci.env}"
mkdir -p e2e-logs

if command -v docker >/dev/null 2>&1; then
  docker logs meetsum-e2e-s3 > e2e-logs/s3.log 2>&1 || true
fi

if [ -f "$env_file" ]; then
  npx --no-install tsx scripts/e2e/scrub-logs.ts "$env_file" e2e-logs/*.log || true
else
  echo "collect-logs.sh: no env file; logs left as written by the services"
fi

ls -la e2e-logs || true

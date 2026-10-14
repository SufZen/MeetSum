# Runbook: first production upgrade, v0.6.0 → v0.7.x

Production at `/opt/meetsum` (Compose project `meetsum`) runs v0.6.0 at `6f9dd96`. This is its first upgrade, and it is **not backward-compatible**: migration 019 makes `workspace_id` NOT NULL and makes the tags unique key per-workspace, so the running v0.6.0 app and worker fail their writes as soon as it is applied. The upgrade therefore runs with a **write freeze** (maintenance mode). It is also the first run of `scripts/deploy-vps.sh` on this host, so there is no `meetsum:previous` to roll back to.

Read the whole runbook before the window. Expect about 5–10 minutes of downtime (stop → backup → migrate → start); the image build happens before the freeze, while v0.6.0 keeps serving.

Ground rules for the whole procedure:

- Never print `.env.local`. Edit it with an editor; nothing below cats or greps it.
- Never run a plain `docker compose ... up -d`. Only the commands below, which name the services and use `--no-deps`.
- Keep the repository variable `DEPLOY_ENABLED` unset until the upgrade is verified, so CI cannot start a deploy in the middle.

```bash
cd /opt/meetsum
C="docker compose --env-file .env.local -f docker-compose.prod.yml"   # v0.6.0 compose file until the upgrade pulls the new one
```

## What changes, and what does not

- **Recreated:** `app` and `worker` only (new image `meetsum:<sha12>`, built once). The deploy script runs `up -d --no-deps app worker` and `run --rm --no-deps migrate`, nothing else.
- **Not recreated:** `postgres`, `redis`, `minio`. No deploy command touches them. Step 2 pins the exact images they run in `docker-compose.local.yml`, so the deploy's drift check (`scripts/infra-drift.sh`, which compares image IDs, not names) passes without `--allow-infra-change`.
  - For the record: a *plain* `docker compose -f docker-compose.prod.yml up -d` with the v0.7 file would recreate all three. Their image references changed (v0.6.0 used `postgres:17-alpine`, `redis:7-alpine`, `minio/minio:latest`) and so did their configuration (log rotation), so the config hash differs even where the bytes are identical. Without step 2's pins it would also put postgres on `postgres:17.9-alpine@sha256:c7526c0f…`, which need not be the same build as the running image. Don't run it.
- **The app port becomes loopback only:** `127.0.0.1:3005`. Direct access over Tailscale to `http://<vps>:3005` ends; use `https://meetsum.realization.co.il` or an SSH tunnel (`deploy.md` "App port (Tailscale)").
- **Schema:** migrations 015–032 run. 019 is marked `-- meetsum:breaking`. The others are additive, or guarded (032 renames or drops the unused `integration_endpoints` table).

## 1. Inventory and save the old images (before anything else)

v0.6.0 built its images as `meetsum-app` and `meetsum-worker`. There is no `meetsum:current` or `meetsum:previous`, and once app and worker are recreated nothing references the old images: `docker image prune -a` would delete them, and with them the only way back without a rebuild. Tags don't protect against `prune -a`; a `docker save` archive does.

```bash
git rev-parse HEAD                                  # expect 6f9dd96f6bce54432be0d3dc160b4166e549d552
git status --short                                  # expect no tracked changes
$C ps
docker ps --format '{{.ID}} {{.Names}} {{.Image}} {{.CreatedAt}}' | grep meetsum- | tee backups/upgrade-inventory-containers.txt
df -h /opt/meetsum                                  # the deploy needs 5 GB free, the image archive ~1-2 GB more

mkdir -p backups/images
docker tag meetsum-app:latest    meetsum-app:v0.6.0-6f9dd96
docker tag meetsum-worker:latest meetsum-worker:v0.6.0-6f9dd96
docker save -o backups/images/meetsum-v0.6.0-6f9dd96.tar meetsum-app:v0.6.0-6f9dd96 meetsum-worker:v0.6.0-6f9dd96
ls -lh backups/images/
```

Don't run `docker image prune -a` until v0.7 has run for a while.

## 2. Pin the infra images that are running (zero infra change)

Record what runs, check the versions, and tag the running image IDs so compose can name them:

```bash
for s in postgres redis minio; do
  printf '%s: %s\n' "$s" "$($C ps -q "$s" | xargs docker inspect --format '{{.Config.Image}} {{.Image}}')"
done | tee backups/upgrade-inventory-images.txt
$C exec -T postgres postgres --version          # expect 17.9
$C exec -T redis redis-server --version         # expect v=7.4.8
$C exec -T minio minio --version                # expect RELEASE.2025-09-07T16-13-09Z

docker tag "$($C ps -q postgres | xargs docker inspect --format '{{.Image}}')" meetsum-infra/postgres:17.9-live
docker tag "$($C ps -q redis    | xargs docker inspect --format '{{.Image}}')" meetsum-infra/redis:7.4.8-live
# MinIO: give the cached image the name docker-compose.prod.yml uses. minio/minio no
# longer resolves on Docker Hub, so this host's cached copy is the only copy; it is
# also why that reference has no digest. Only tag it if the version above matched.
docker tag "$($C ps -q minio    | xargs docker inspect --format '{{.Image}}')" minio/minio:RELEASE.2025-09-07T16-13-09Z
```

Create the host-local override (git-ignored from v0.7.1 on; the deploy, rollback and backup scripts add it with `-f` whenever it exists):

```bash
cat > docker-compose.local.yml <<'YAML'
# Host-local (not in git). Pins the infra images production ran under v0.6.0;
# see docs/runbooks/upgrade-0.6-to-0.7.md step 2.
services:
  postgres:
    image: meetsum-infra/postgres:17.9-live
    pull_policy: never
  redis:
    image: meetsum-infra/redis:7.4.8-live
    pull_policy: never
YAML
$C -f docker-compose.local.yml config -q
```

Moving to the repository's pins (`postgres:17.9-alpine@sha256:c7526c0f…`, `redis:7.4.8-alpine@sha256:7aec734b…`) is a separate, explicit infra change for later: `docker compose pull postgres redis` (pull never recreates), compare image IDs (step 6), and if they differ, recreate each service on purpose (`up -d --no-deps <svc>`, after `./scripts/backup-full.sh`), then remove its entry from `docker-compose.local.yml`. The same goes for the pgvector image (`postgres-17-pgvector.md`) and for source-built MinIO (`deploy.md` "Images").

## 3. Environment changes (`.env.local`, edit by hand)

Nothing new is required to boot. Check these before the window:

- **Google Workspace subject.** v0.6.0 impersonated a built-in default address for Calendar/Drive polling when `GOOGLE_WORKSPACE_SUBJECT` was unset. v0.7 has no built-in default: without `GOOGLE_WORKSPACE_SUBJECT` (or the legacy `GOOGLE_WORKSPACE_ADMIN_EMAIL`) the default workspace has no Google subject and **Google polling stops**. Set `GOOGLE_WORKSPACE_SUBJECT` to the address v0.6.0 used, or set it after the upgrade as the owner with `PATCH /api/workspaces/current {"googleSubject": "…"}`. If you set it, that address becomes the workspace **owner** (see "First login" below).
- **ASR.** `MEETSUM_TRANSCRIPTION_PROVIDER=auto` keeps its v0.6.0 meaning in v0.7.1 (Lemonade over Tailscale first, then Gemini, because `GOOGLE_GEMINI_API_KEY` is set). The app and worker log a deprecation warning. Preferred, same behaviour: replace it with
  `MEETSUM_ASR_CHAIN=local-whisper-chunked` and `MEETSUM_ASR_ALLOW_GEMINI=true` (keep `LOCAL_TRANSCRIPTION_URL`). v0.6.0 ignores both, so a rollback is unaffected. Check `GEMINI_TIER`: on `free`, audio sent to the fallback may be used by Google (`free-tier-asr.md` section 2d).
- **Secrets.** v0.7 refuses to boot in production when `MEETSUM_SESSION_SECRET` or `WEBHOOK_SIGNING_SECRET` is a placeholder (`dev-secret`, `changeme`, `change-me`, `replace-with-…`) or when the two are equal. Real values from v0.6.0 are fine.
- Everything else new in v0.7 is optional (`docs/env-matrix.md`).

## 4. Dry run with the new scripts

The v0.6.0 checkout has an older `deploy-vps.sh` without the infra guards. Run the v0.7.1 scripts from a temporary directory; the checkout stays at `6f9dd96` until the script itself pulls.

```bash
git fetch origin main
git log --oneline -3 origin/main                    # the v0.7.1 merge at the top
rm -rf /tmp/meetsum-0.7.1 && mkdir -p /tmp/meetsum-0.7.1
for f in deploy-vps.sh infra-drift.sh breaking-migrations.sh; do
  git show "origin/main:scripts/$f" > "/tmp/meetsum-0.7.1/$f"
done
sh /tmp/meetsum-0.7.1/deploy-vps.sh --dry-run --maintenance
```

The plan must show `using the host-local override docker-compose.local.yml`, `migrations marked breaking: 019_workspace_scoping.sql`, `stop app worker` before the second backup, `run --rm --no-deps migrate`, and `up -d --no-deps app worker` as the only `up`.

Confirm the image check passes with the new configuration (this reads only; it uses the v0.7.1 compose file from `origin/main`, and `--project-directory` keeps `.env.local` and the volume names resolving against `/opt/meetsum`):

```bash
git show origin/main:docker-compose.prod.yml > /tmp/meetsum-0.7.1/docker-compose.prod.yml
sh /tmp/meetsum-0.7.1/infra-drift.sh --project-directory /opt/meetsum --env-file .env.local   -f /tmp/meetsum-0.7.1/docker-compose.prod.yml -f docker-compose.local.yml
# expect "running image matches" for postgres, redis and minio, exit 0
```

## 5. Upgrade (write freeze)

```bash
sh /tmp/meetsum-0.7.1/deploy-vps.sh --maintenance 2>&1 | tee "backups/upgrade-0.7.1-$(date -u +%Y%m%dT%H%M%SZ).log"
```

`--maintenance` is automatic here anyway (019 is pending in `schema_migrations`); passing it makes the freeze explicit. What happens:

1. lock, preflight (env file, compose config, disk, postgres healthy);
2. backup (v0.6.0 still serving), `git fetch` + fast-forward to `origin/main`;
3. infra image check on the new compose files (must pass: step 2);
4. one `next build` of `meetsum:<sha12>` (v0.6.0 still serving; a failed build resets the checkout and changes nothing else);
5. **write freeze:** `stop app worker`, then the **write-freeze backup**. Its path is logged as `write-freeze backup: backups/postgres/meetsum-postgres-<UTC>.dump`. Note it: it is the rollback point;
6. `run --rm --no-deps migrate`: migrations 015–032, then the M2 bootstrap (`Bootstrap: ws_default ready (1 allowlisted user(s))`);
7. `up -d --no-deps app worker` on the new image, readiness (app `/api/health/ready`, worker `/ready`), then `meetsum:<sha12>` is tagged `meetsum:current`.

If a migration fails before 019 is applied, the script restarts the stopped v0.6.0 containers and resets the checkout. If anything fails after 019, it does **not** roll back automatically (v0.6.0 cannot run on that schema). It prints the manual path: see "Rollback".

## 6. Verify

```bash
C="docker compose --env-file .env.local -f docker-compose.prod.yml -f docker-compose.local.yml"   # the v0.7.1 file now
$C ps
docker ps --format '{{.ID}} {{.Names}} {{.Image}} {{.CreatedAt}}' | grep meetsum-
# postgres, redis, minio: same container IDs and CreatedAt as backups/upgrade-inventory-containers.txt
# app, worker: new containers on meetsum:<sha12>

# Image IDs: running vs configured, per infra service (what infra-drift.sh does)
for s in postgres redis minio; do
  running="$($C ps -q "$s" | xargs docker inspect --format '{{.Image}}')"
  ref="$($C config --images "$s")"
  configured="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || echo missing)"
  printf '%s: running=%s configured(%s)=%s\n' "$s" "$running" "$ref" "$configured"
done

$C exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select max(version), count(*) from schema_migrations"'   # 032
$C exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select m.role, u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = '"'"'ws_default'"'"'"'
$C exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from meetings where workspace_id is null or owner_user_id is null"'   # 0
$C exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready      # 200, every check ok
$C exec -T worker sh -c 'wget -qO- "http://127.0.0.1:${MEETSUM_WORKER_HEALTH_PORT:-3101}/ready"'
$C logs app worker --since 15m | grep -E '\[asr\]|\[integrations\]|level":(50|60)'   # deprecation warning only if the legacy ASR variable stayed
docker image ls meetsum                              # meetsum:<sha12> and meetsum:current
```

From a laptop:

- `https://meetsum.realization.co.il/api/health/ready` answers 200; `http://<vps-tailscale-name>:3005` no longer answers (expected).
- Sign in with the allowlisted email: you land in the workspace as **owner** and see every v0.6.0 meeting.
- Open a meeting with a transcript and a summary; upload a short Hebrew clip and check it transcribes (Lemonade when the laptop is reachable, Gemini otherwise).
- If `GOOGLE_WORKSPACE_SUBJECT` is set: after one poll interval, calendar/drive sync shows recent activity on the ops page.

Then take a full backup with the new script (MinIO through the container, fails loudly):

```bash
./scripts/backup-full.sh
```

Keep `DEPLOY_ENABLED` unset until you're satisfied; from then on deploys are normal (`deploy.md`).

## First login with 0 users (M2 bootstrap)

The `users` table is empty under v0.6.0 (allowlist auth). With `MEETSUM_ALLOWED_EMAILS` holding one email and no `GOOGLE_WORKSPACE_SUBJECT` (nor the legacy `GOOGLE_WORKSPACE_ADMIN_EMAIL`), `lib/workspaces/bootstrap.ts` behaves like this:

- The owner is the **first allowlisted email** (`owner = subject ?? allowlisted[0]`).
- The bootstrap runs **right after the migrations** (`scripts/migrate.ts`, step 5.6), not only at login. It creates the `ws_default` owner: a `users` row for that email, an `owner` membership, `default_workspace_id`, and it assigns every existing meeting (`owner_user_id`), favorite and API key to that user. The migrate log line is `Bootstrap: ws_default ready (1 allowlisted user(s))`.
- The first Google sign-in with that email runs the same idempotent bootstrap again and signs in as owner. It never downgrades an existing membership.
- Sign-in is decided by workspace membership (or a pending invitation), not by the allowlist alone. Anyone else needs an invitation from the owner.
- `ws_default.google_subject` stays empty, so there is no Google polling until a subject is set (step 3).
- If `GOOGLE_WORKSPACE_SUBJECT` *is* set, that address becomes owner instead and the allowlisted emails become admins.

If the log says `Bootstrap: skipped`, neither variable reached the migrate container: fix `.env.local` and run `$C -f docker-compose.migrate.yml run --rm --no-deps migrate` again (idempotent).

## Rollback (to v0.6.0)

Only if v0.7 cannot be made to work. Writes made since the write freeze are lost (there should be few: the freeze started right before the migrations).

```bash
cd /opt/meetsum
C="docker compose --env-file .env.local -f docker-compose.prod.yml -f docker-compose.local.yml"
$C stop app worker
./scripts/backup-postgres.sh                          # the failed state, for later analysis

# Restore the write-freeze dump into an empty database, so no v0.7 table or index survives:
$C exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
./scripts/restore-postgres.sh backups/postgres/meetsum-postgres-<write-freeze UTC>.dump --confirm-restore
$C exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select max(version) from schema_migrations"'   # 014

# Old code and the OLD compose file:
git reset --keep 6f9dd96

# The old images (restore them from the archive if they were pruned):
docker image inspect meetsum-app:latest meetsum-worker:latest >/dev/null 2>&1 || {
  docker load -i backups/images/meetsum-v0.6.0-6f9dd96.tar
  docker tag meetsum-app:v0.6.0-6f9dd96 meetsum-app:latest
  docker tag meetsum-worker:v0.6.0-6f9dd96 meetsum-worker:latest
}

# v0.6.0's compose file, no local override, app and worker only:
docker compose --env-file .env.local -f docker-compose.prod.yml up -d --no-deps app worker
docker compose --env-file .env.local -f docker-compose.prod.yml ps
```

- `--no-deps` keeps postgres, redis and minio as they are. They never changed during the upgrade, so v0.6.0 finds the same containers.
- Without the archive, `up` would rebuild v0.6.0 from source (`build: .` in that compose file). It works, but it is slow and memory-hungry on this host.
- `docker-compose.local.yml` stays on disk (untracked under v0.6.0's `.gitignore`); v0.6.0 never reads it. Keep it for the next attempt.
- v0.6.0 ignores the v0.7-only variables in `.env.local` (`MEETSUM_ASR_CHAIN` and others), and without `MEETSUM_TRANSCRIPTION_PROVIDER` it defaults to `auto`, so ASR behaves as before.
- Check `http://127.0.0.1:3005/api/health` on the host and a meeting page. v0.6.0 publishes 3005 on all interfaces again, so Tailscale access returns.

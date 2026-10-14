# Runbook: move Postgres 17 (alpine) to pgvector/pgvector (Debian)

Production compose pins `pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adf…` (Debian bookworm, glibc). A volume first created by `postgres:17-alpine` (musl) can't simply be reused: text indexes are ordered by the C library's collation, and musl and glibc order strings differently. Hebrew search also needs a UTF-8 ctype for `pg_trgm` (M6). This runbook moves a database across safely. Spec: `docs/parity/m10.md` ("Runbooks").

Do it in a maintenance window. It needs `docker`, about twice the database size in free disk, and the MeetSum checkout at `/opt/meetsum`.

```bash
cd /opt/meetsum
COMPOSE="docker compose --env-file .env.local -f docker-compose.prod.yml"
```

## 1. Inventory

```bash
$COMPOSE exec -T postgres psql -U meetings -d meetings -c \
  "select datname, datcollate, datctype, datcollversion, pg_database_collation_actual_version(oid) from pg_database;"
$COMPOSE exec -T postgres psql -U meetings -d meetings -c "select version();"
$COMPOSE exec -T postgres sh -c 'cat /etc/os-release | head -2'
```

- `datctype` must be a UTF-8 locale (`C.UTF-8`, `en_US.utf8`, …). Hebrew trigrams don't work under `C`/`POSIX` (M6).
- If the OS line says Alpine, continue. If it already says Debian and `datcollversion` equals the actual version, you're done.

## 2. Backup

```bash
./scripts/backup-postgres.sh                                   # custom-format dump of the meetings DB
$COMPOSE exec -T postgres pg_dumpall -U meetings --globals-only > backups/postgres/globals-$(date -u +%Y%m%dT%H%M%SZ).sql
$COMPOSE stop app worker
docker run --rm -v meetsum_postgres-data:/from -v /opt/meetsum/backups:/to alpine \
  tar czf /to/postgres-volume-$(date -u +%Y%m%dT%H%M%SZ).tgz -C /from .   # volume snapshot (pinned alpine is fine for tar)
```

Record row counts so you can compare after the move:

```bash
$COMPOSE exec -T postgres psql -U meetings -d meetings -At -c \
  "select relname, n_live_tup from pg_stat_user_tables order by relname;" > backups/postgres/rowcounts-before.txt
```

(`n_live_tup` is an estimate; for an exact check run `select count(*)` on `meetings`, `transcript_segments`, `workspaces`, `users` and `schema_migrations`.)

## 3. Option A (recommended): dump and restore into a fresh volume

No collation drift, because every index is rebuilt by glibc.

```bash
$COMPOSE stop postgres
docker volume create meetsum_postgres-data-pg17deb
# Point the postgres service at the new volume for this step (compose override):
cat > /tmp/pg-new-volume.yml <<'YAML'
services:
  postgres:
    volumes: !override
      - postgres-data-pg17deb:/var/lib/postgresql/data
    environment:
      POSTGRES_INITDB_ARGS: "--locale=C.UTF-8 --encoding=UTF8"
volumes:
  postgres-data-pg17deb:
    external: true
    name: meetsum_postgres-data-pg17deb
YAML
$COMPOSE -f /tmp/pg-new-volume.yml up -d postgres
$COMPOSE -f /tmp/pg-new-volume.yml exec -T postgres sh -c 'until pg_isready -U "$POSTGRES_USER"; do sleep 1; done'
$COMPOSE -f /tmp/pg-new-volume.yml exec -T postgres psql -U meetings -d postgres -f - < backups/postgres/globals-<UTC>.sql   # roles; "already exists" errors are fine
$COMPOSE -f /tmp/pg-new-volume.yml exec -T postgres pg_restore -U meetings -d meetings --no-owner --no-privileges \
  < backups/postgres/meetsum-postgres-<UTC>.dump
```

`--locale=C.UTF-8` keeps byte-order sorting with a UTF-8 ctype (what M6 needs). `en_US.UTF-8` also works if you need locale-aware `ORDER BY` of text.

To make the new volume permanent, change the `postgres-data` volume in a local compose override (or rename volumes: `docker volume` has no rename, so either keep the override or copy the data back into a recreated `meetsum_postgres-data`). Keep the old volume until step 6 passes.

## 4. Option B (in place): new image on the old volume

Faster for large databases, but every text index must be rebuilt.

```bash
$COMPOSE pull postgres && $COMPOSE up -d postgres      # the pinned pgvector image on the alpine-created volume
for db in meetings postgres template1; do
  $COMPOSE exec -T postgres psql -U meetings -d "$db" -c "REINDEX DATABASE $db;"
  $COMPOSE exec -T postgres psql -U meetings -d "$db" -c "ALTER DATABASE $db REFRESH COLLATION VERSION;"
done
```

Then check the text indexes with `amcheck`:

```bash
$COMPOSE exec -T postgres psql -U meetings -d meetings <<'SQL'
create extension if not exists amcheck;
select c.relname, bt_index_check(c.oid)
from pg_index i
join pg_class c on c.oid = i.indexrelid
join pg_am am on am.oid = c.relam and am.amname = 'btree'
where c.relnamespace = 'public'::regnamespace;
SQL
```

Any error means an index is still ordered the old way: `REINDEX INDEX <name>;` and run the check again. A remaining warning "database … has a collation version mismatch" means a database was missed in the loop.

## 5. Search setup

```bash
$COMPOSE up -d app worker
$COMPOSE exec -T app npm run search:vector-setup
$COMPOSE exec -T app npm run search:backfill
$COMPOSE logs app | grep '"msg":"\[search\] capabilities'     # expect mode=hybrid (needs an embedding key) or mode=lexical with trgm=hebrew
```

## 6. Verify

- Row counts match `rowcounts-before.txt` (and the exact counts you took).
- `GET /api/health/ready` returns 200 with `database: ok` and `migrations: ok`.
- Hebrew search: searching `תקציב` finds a meeting that says `והתקציב` (prefix and niqqud folding, M6).
- An Ask question returns an answer with citations.
- `select datname, datcollversion, pg_database_collation_actual_version(oid) from pg_database;` shows equal versions.

## 7. Rollback

Stop the stack, put the old image (`postgres:17-alpine`) back on the **old volume** (Option A left it untouched; for Option B restore the volume snapshot from step 2 into a fresh volume first), start it, and start app and worker. Then `./scripts/rollback-vps.sh` if the code moved too.

## Rehearsal transcript

The spec asks for a rehearsal on a local volume created by `postgres:17-alpine`, both options, before the VPS window.

**Status: not yet run.** On 2026-10-14 the Docker daemon on the development machine did not respond (`docker ps` timed out), so no transcript could be captured in M10 package B. Run it on any machine with Docker:

```bash
docker volume create pg17-rehearsal
docker run -d --name pg17-alpine -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_USER=meetings -e POSTGRES_DB=meetings \
  -v pg17-rehearsal:/var/lib/postgresql/data postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
# apply MeetSum's migrations and a little Hebrew data:
DATABASE_URL=postgres://meetings:rehearsal@127.0.0.1:<port>/meetings npm run db:migrate   # publish a port with -p for this
# then follow Option B against that volume with the pgvector image, and Option A with a second volume,
# and paste the commands' output here with passwords elided.
```

Paste the output below this line, with secrets elided, when it has been run.

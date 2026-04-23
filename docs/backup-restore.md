# Backup and Restore

Postgres is the source of truth for meeting metadata, summaries, action items, language metadata, contexts, and integration state. Audio and files live in MinIO/S3-compatible storage and need their own object backup policy.

## Backup Before Deploy

```bash
./scripts/backup-postgres.sh
```

By default backups are written to:

```text
./backups/postgres/
```

Override paths when needed:

```bash
BACKUP_DIR=/opt/meetsum/backups/postgres ./scripts/backup-postgres.sh
```

## Restore

Restore requires an explicit confirmation argument:

```bash
./scripts/restore-postgres.sh ./backups/postgres/meetsum-postgres-YYYYMMDDTHHMMSSZ.dump --confirm-restore
```

Restores are destructive. Create a new backup before restoring.

## Recommended VPS Policy

- Run Postgres backup before every deploy.
- Add a daily cron backup once production data exists.
- Keep at least 7 daily and 4 weekly backups.
- Test restore into a temporary database before relying on the backup policy.
- Back up MinIO object data separately from Postgres dumps.

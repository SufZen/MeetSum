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

## Media Retention

Meeting transcripts, summaries, tasks, and Google metadata are kept in Postgres.
Media lives in MinIO. The production default is audio-first: keep extracted
audio for 180 days, and store raw video only when explicitly enabled.

Use the retention helper in dry-run mode before deleting anything:

```bash
npm run media:retention -- --target video --limit 50
```

When the dry run looks correct, execute it:

```bash
npm run media:retention -- --target video --limit 50 --execute
```

The command deletes matching video objects from MinIO and removes only their
`media_assets` rows. Meetings, transcripts, summaries, action items, tags, and
Google Drive metadata remain intact.

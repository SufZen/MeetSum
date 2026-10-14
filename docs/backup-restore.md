# Backup and Restore

MeetSum stores meeting data across two systems:
- **Postgres** — metadata, summaries, action items, language data, contexts, integration state
- **MinIO/S3** — audio files, video recordings, media assets

## Unified Backup (Recommended)

```bash
npm run backup:full
```

Creates a timestamped directory under `./backups/` containing:
- `postgres.dump` — full `pg_dump` in custom format
- `minio/` — complete mirror of all MinIO buckets
- `manifest.json` — backup metadata with checksums

The MinIO server image is built from the official source (`deploy/minio/Dockerfile`, see [runbooks/deploy.md](runbooks/deploy.md#images)) and keeps the same `/data` layout as the previous images, so these backups restore into it unchanged. The mirror needs an `mc` on the host. If object storage later moves to Garage or SeaweedFS, restore the `minio/` mirror into the new server's bucket with `mc mirror` the same way.

Override the backup location:

```bash
BACKUP_DIR=/opt/meetsum/backups npm run backup:full
```

## Unified Restore

```bash
npm run backup:restore -- ./backups/20260529T080000Z --confirm-restore
```

The restore script:
1. Validates `manifest.json` exists
2. Checks version compatibility
3. Verifies SHA-256 checksums for Postgres dump
4. Restores Postgres data (`pg_restore --clean`)
5. Mirrors MinIO data back to buckets

> **⚠ Destructive Operation:** Restore replaces all existing data. Always create a fresh backup before restoring.

## Postgres-Only Backup

For quick pre-deploy backups:

```bash
./scripts/backup-postgres.sh
```

`scripts/deploy-vps.sh` runs this before every deploy and stops when it fails. The script writes to a `.partial` file first and exits non-zero on a failed or empty dump, so a half-written file is never left behind as a "backup". The restore drill and the manual post-deploy restore are in [runbooks/deploy.md](runbooks/deploy.md).

Restore a Postgres-only backup:

```bash
./scripts/restore-postgres.sh ./backups/postgres/meetsum-postgres-YYYYMMDDTHHMMSSZ.dump --confirm-restore
```

## Media Retention

Transcripts, summaries, and tasks are kept in Postgres indefinitely. Media files in MinIO follow a retention policy:

| Media Type | Default Retention | Configurable |
|------------|-------------------|--------------|
| Audio | 180 days | `audioMaxDays` in app settings |
| Video | Opt-in only | `videoRetention` in app settings |
| Transcripts | Indefinite | No |
| Summaries | Indefinite | No |

### Dry Run

```bash
npm run media:retention -- --target video --limit 50
```

### Execute Deletion

```bash
npm run media:retention -- --target video --limit 50 --execute
```

The command deletes matching objects from MinIO and removes their `media_assets` rows. Meetings, transcripts, summaries, action items, tags, and Google metadata remain intact.

## Recommended VPS Policy

1. **Pre-deploy:** Run `npm run backup:full` before every deploy (automated in `deploy-vps.sh`)
2. **Daily:** Set up a cron for daily backups once production data exists
3. **Retention:** Keep at least 7 daily and 4 weekly backups
4. **Testing:** Test restore into a temporary database before relying on the backup policy
5. **Offsite:** Copy backups to a separate machine or cloud storage periodically

### Cron Example

```bash
# Daily full backup at 3 AM UTC
0 3 * * * cd /opt/meetsum && npm run backup:full >> /var/log/meetsum-backup.log 2>&1
```

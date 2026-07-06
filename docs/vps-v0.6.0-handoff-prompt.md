# VPS v0.6.0 Deployment Handoff Prompt

Use this prompt in the next session to update the active MeetSum VPS deployment at `https://meetsum.realization.co.il/`.

```text
You are working on the MeetSum VPS deployment. The repository release to deploy is v0.6.0.

Goal:
Update the active production MeetSum instance at https://meetsum.realization.co.il/ to v0.6.0, preserving Postgres/Redis/MinIO/n8n data, running migrations, restarting app + worker, and validating desktop-recorder ingestion.

Context:
- Production target path is /opt/meetsum.
- Production compose file is docker-compose.prod.yml.
- Always use --env-file .env.local with docker compose.
- Run a Postgres backup before changing containers.
- v0.6.0 includes migration db/migrations/014_desktop_capture_metadata.sql.
- v0.6.0 adds POST /api/desktop-capture/ingest and the MeetSum Capture desktop companion.
- Desktop uploads require object storage, worker processing, and API-key auth.
- For personal Windows use, unsigned desktop installer artifacts are acceptable. Code signing is optional and can be enabled later with WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD in GitHub Actions.

Suggested deploy flow:
1. SSH into the VPS.
2. cd /opt/meetsum.
3. Confirm current state:
   - git status --short --branch
   - docker compose --env-file .env.local -f docker-compose.prod.yml ps
   - curl -fsS https://meetsum.realization.co.il/api/health
4. Run backup:
   - ./scripts/backup-postgres.sh
5. Pull release:
   - git fetch --tags origin
   - git checkout main
   - git pull --ff-only origin main
   - git checkout v0.6.0
6. Build app and worker:
   - docker compose --env-file .env.local -f docker-compose.prod.yml build app worker
7. Run database migration:
   - docker compose --env-file .env.local -f docker-compose.prod.yml run --rm migrate
   - If production DNS/Tailscale blocks the migrate service, use the documented fallback:
     docker exec meetsum-app-1 npm run db:migrate 2>/dev/null || true
8. Restart app and worker:
   - docker compose --env-file .env.local -f docker-compose.prod.yml up -d app worker
9. Validate:
   - docker compose --env-file .env.local -f docker-compose.prod.yml ps
   - curl -fsS https://meetsum.realization.co.il/api/health
   - Check the app loads in browser.
   - Confirm /api/desktop-capture/ingest is present in build logs or route output.
   - Confirm worker logs show it is ready for media.ingest / meeting.summarize.
10. Desktop recorder readiness:
   - Ensure there is an API key for the desktop app via MEETSUM_API_KEYS, MEETSUM_API_KEY_HASHES, or admin API-key management.
   - Download the v0.6.0 Windows installer artifact from GitHub release or Actions.
   - Configure MeetSum Capture with https://meetsum.realization.co.il and the API key.
   - Smoke test a short recording upload and verify meeting creation, media asset metadata, worker processing, summary, transcript, and exports.

Report:
- Deployed git SHA/tag.
- Backup path.
- Migration result.
- Container status.
- Health endpoint output.
- Desktop recorder smoke result or blocker.
```

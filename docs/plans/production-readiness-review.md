# MeetSum production-readiness review and action plan

Review date: 2026-11-22. Reviewed revision: `main` at `ad1b365` (package version 0.7.1, migrations 001–032).
Method: an own review of every area in the order below, then an independent read-only Codex pass per area.
The Codex critique of the merged plan (round 2) did not run because Codex hit its usage limit (see
[Review loop](#review-loop-and-codex-provenance)). Every finding
was checked against the code; evidence is `path:line` at the reviewed revision.

No code was changed for this review. Nothing was merged, deployed or run against production.

## Summary

The application layer is in better shape than the operations layer. Every one of the 159 API route handlers
is wrapped in `withAuthz`, `withSession` or `withPublicRoute` (`lib/auth/authz.ts:502,527,557`), workspace
scoping is structural (handlers get a workspace-scoped repository, `lib/auth/authz.ts:456-495`), cookie
mutations are origin-checked (`lib/auth/authz.ts:284-313`), and the webhook SSRF guard is solid. No IDOR and
no SQL injection was found.

**One finding blocks the pending v0.6.0 → v0.7.1 production upgrade itself (A16):** v0.7.1 widened the
`proxy.ts` matcher to `/api/*`, and Next 16.2.6 truncates proxied request bodies at 10 MiB, so recording
uploads larger than that arrive cut off. v0.6.0 excluded `/api` and is not affected. Fix it before deploying.

Beyond that, the release risk sits in five places:

1. **Sharing.** Revoking a missing link creates one and publishes the meeting; rotating a link drops its
   password; any member can retry any job, including retention (A17–A19).
2. **Job lifecycle in the worker.** A deploy kills in-flight transcriptions (no stop grace period), stalled
   jobs leave meetings stuck forever, and a transient LLM error on first processing is saved as a final
   heuristic summary.
3. **Backups and restore.** No scheduled, off-host or encrypted backups; secrets are not backed up; the deploy
   backs up Postgres only (the docs say otherwise); restores run into a live database and accept incomplete
   backups.
4. **Rollback and deploy safety.** The manual rollback path ignores schema state; the automatic one can report
   success after failing; a dropped SSH session can leave the site stopped; a CI deploy can build a commit
   other than the one tested; the deploy gate does not include E2E.
5. **Cost and exposure controls.** Expensive AI/ASR endpoints have no rate limit, `/api/health` is public and
   verbose, no security headers are set, and sign-in requests Gmail/Drive/Directory scopes from every user.

The two known gaps are confirmed: ASR confidence escalation (`docs/architecture.md:27`) does not exist in the
pipeline, and the right-rail "Details" quality button is permanently disabled
(`components/meeting-right-rail.tsx:204-212`).

Severity scale: **Blocker** (must be fixed before the production release), **High**, **Medium**, **Low**.
Effort: **S** ≤ 1 day, **M** 2–4 days, **L** a week or more.

## Findings by area

### 1. `app/` and `components/` (UI and API routes)

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| A16 | Blocker | **Recording uploads over 10 MiB are truncated in v0.7.1.** `proxy.ts` now matches `/api/*` (v0.6.0's matcher excluded `api`), and Next 16.2.6 clones the request body for the proxy with a default `proxyClientMaxBodySize` of 10 MiB; past it, the route receives only the first 10 MiB. This is a regression between the production version and the release about to be deployed. | `proxy.ts:89-91` vs. `git show v0.6.0:proxy.ts` (`/((?!_next\|api\|.*\\..*).*)`); `node_modules/next/dist/server/body-streams.js:80-97`, `config-shared.js:260`; affected `app/api/meetings/[id]/upload/route.ts:33`, `app/api/desktop-capture/ingest/route.ts:95` | Exclude the upload and ingest routes (or all of `/api`) from the proxy matcher and set request ids in the handlers; add an e2e upload > 10 MiB against `next start`. | S |
| A17 | High | Revoking a share when no active link exists **creates** a new active link and switches the meeting to `link` visibility (a retried revoke publishes a private meeting). | `app/api/meetings/[id]/share/route.ts:185-189`; `lib/meetings/postgres-repository.ts:4144-4170` (`if (!current) return this.createMeetingShare(…)`), `:4083-4086` (`setLinkVisibility`) | Revoke is an idempotent update that never creates a share or changes visibility. | S |
| A18 | High | Regenerating a share token drops its password and, unless sections are re-sent, resets to the default sections (transcript and participants included). | `lib/meetings/postgres-repository.ts:4152-4163,4090-4105`; `components/share/share-meeting-dialog.tsx:189-192` | Rotate the token in place, keeping password hash, sections and expiry; test it. | S |
| A19 | High | `POST /api/jobs/:id/retry` re-enqueues **any** job type in the workspace for any holder of `jobs:write` (members), including workspace retention jobs that delete recordings, and regardless of status. | `app/api/jobs/[id]/retry/route.ts:8-25`; `lib/auth/authz.ts` member grants include `jobs:write` | Allowlist retryable job names, require the start permission of each, only failed jobs, one retry in flight. | S |
| A20 | Medium | Two concurrent share creations can both insert a live link (no constraint enforces one active share per meeting); revoke then disables only the newest. | `lib/meetings/postgres-repository.ts:4084-4089`; `db/schema.sql:1661-1669` (only pk and token unique) | Partial unique index on active meeting shares; serialize share mutations per meeting. | S |
| A21 | Medium | Duplicate `process`/`reprocess`/`intelligence/run` requests enqueue duplicate ASR/LLM jobs (no in-flight dedup), and an invalid or misspelled `reprocess` mode silently means `full`. | `app/api/meetings/[id]/reprocess/route.ts:14-18,28`, `lib/jobs/queue.ts:266` | Dedupe in-flight jobs per (workspace, meeting, operation); 400 on invalid mode. Pair with A1. | S |
| A22 | Low | Share expiry exists in the schema and is enforced on read, but the API never accepts or stores it, although the README advertises expiring links. | `README.md:40`; `app/api/meetings/[id]/share/route.ts` (no expiry field); `lib/meetings/postgres-repository.ts:4237` | Expose and validate expiry, or drop the claim. | S |
| A1 | High | Expensive enqueue endpoints have no rate limit. The `aiProcessing` and `share` presets exist but are never used. One member or API key can loop `reprocess` and burn ASR/LLM budget and worker capacity. | `app/api/meetings/[id]/process/route.ts:20`, `.../reprocess/route.ts:20`, `.../intelligence/run/route.ts:19`, `.../analytics/sentiment/route.ts:13`, `app/api/agents/run/route.ts:12`, `.../upload/route.ts:19`, `app/api/desktop-capture/ingest/route.ts:73`, `app/api/google/drive/import/route.ts:8`; presets `lib/rate-limit.ts:148,154` (no callers) | Apply `aiProcessing` (fail-closed, per principal) to these handlers and `share` to share create/update. | S |
| A2 | High | Sign-in asks every user for Gmail, Drive, Calendar, Meet and Directory read scopes with offline access, and stores each refresh token. | `app/api/auth/google/start/route.ts:26-32`, `lib/google/workspace.ts:1-16`, `lib/auth/session.ts:97`, `app/api/auth/google/callback/route.ts:122-127` | Sign in with `openid email profile` only; request Workspace scopes incrementally for the features and users that need them. Decision for Asaf (Q3). | M |
| A3 | Medium | Unauthenticated `/api/health` returns the version, AI provider/model and the runtime config warnings, which name missing env vars. | `app/api/health/route.ts:31-52`, `lib/ops/environment.ts:48-83`, `lib/health/status.ts:42-45` | Return the minimal `/health/ready` shape publicly; move detail behind `ops:read`. | S |
| A4 | Medium | No security response headers (no CSP, `frame-ancestors`, HSTS, `nosniff`, `Referrer-Policy`); `poweredByHeader` left on. The cookie-authenticated UI can be framed unless the edge adds headers (not verified on the VPS). | `next.config.mjs:1-27` (no `headers()`) | Add global headers in `next.config.mjs`; start CSP in report-only. Check Traefik config on the VPS. | S (headers), M (CSP) |
| A5 | Medium | 30 route files return raw `error.message` to the client, several on 500 paths (DB and Google API text can leak). | e.g. `app/api/admin/operations/route.ts:21-24`, `app/api/google/drive/import/route.ts:43-47`, `app/api/integrations/teams/subscription/route.ts:74-76`; `grep -rl "error instanceof Error ? error.message" app/api` → 30 files | Shared `unexpectedErrorResponse` helper: known error classes → fixed codes, the rest logged and returned generic (pattern already in `app/api/admin/api-keys/route.ts:30-33`). | M |
| A6 | Medium | Any `member` can list and import files from the workspace Google subject's Drive and Meet, because these routes are gated by `meeting:create` and default to the workspace subject. | `app/api/google/drive/recordings/route.ts:8`, `app/api/google/drive/import/route.ts:8`, `app/api/google/meet/sync/route.ts:9`, `lib/google/request-subject.ts:70` | Gate subject-wide access on `integrations:manage`, or restrict members to their own subject. Confirm intent first (Q4). | S |
| A7 | Medium | Sessions are stateless, valid 7 days, and cannot be revoked; logout only deletes cookies. | `lib/auth/session.ts:5,121-129`, `app/api/auth/logout/route.ts:18-19`, `lib/auth/authz.ts:363-366` | Per-user `session_version` checked in `authz`, bumped on logout and "sign out everywhere". | M |
| A8 | Low | Public share media, the share page and the Google auth entry points have no rate limit; share media streams the full recording through the app. | `app/api/share/[token]/media/route.ts:47-50`, `app/share/[token]/page.tsx:98-128`, `app/api/auth/google/start/route.ts` | `publicAccess` limiter keyed by token+IP; per-IP limit on auth routes. | S |
| A9 | Low | Zoom and Teams webhooks read the whole body before verifying the signature, and are not rate-limited; error text reveals which secrets are unconfigured. | `app/api/webhooks/zoom/route.ts:53,67-69,75`, `app/api/webhooks/teams/route.ts:50,67-69`, `.../teams/lifecycle/route.ts:29`, `lib/capture/teams.ts:79-81` | Reuse the capped body reader from the Vexa route (`app/api/integrations/vexa/webhook/route.ts:29`); generic 401/503. | S |
| A10 | Low | Sharing sets visibility to `link` before the share row exists; a failure leaves a link-visible meeting with no share and no audit entry. | `app/api/meetings/[id]/share/route.ts:112-122,140-144` | Create the share first or do both in one transaction. | S |
| A11 | Low | Logout accepts GET, so any page can sign a user out. | `app/api/auth/logout/route.ts:28-30` | POST only (GET → confirmation page). | S |
| A12 | Low | `agents/run` accepts an unvalidated `agent` string into the job payload and events. | `app/api/agents/run/route.ts:13-18` | Allowlist known agent ids; 400 otherwise. | S |
| A13 | Low | **Known gap, confirmed.** The right-rail quality "Details" button is always `disabled` ("details soon"). The AI-status control in the top bar is also an always-disabled button. | `components/meeting-right-rail.tsx:204-212`, `components/top-command-bar.tsx:246-255` | Build the detailed quality view (Phase 3) or remove the button; make the AI status a non-interactive badge. | S (remove) / M (build) |
| A14 | Low | Dead UI: `components/action-item-list.tsx` has no importer (its edit button is permanently disabled); 21 shadcn primitives in `components/ui/` are never imported. | `components/action-item-list.tsx:20,72`; `components/ui/{accordion,aspect-ratio,avatar,breadcrumb,button-group,calendar,carousel,collapsible,combobox,context-menu,drawer,field,hover-card,input-otp,item,menubar,navigation-menu,pagination,radio-group,resizable,slider}.tsx` | Delete; add an unused-file lint (e.g. knip). | S |
| A15 | Low | Very large client components mixing data, upload, polling and layout. | `components/command-center-shell.tsx` (1771 lines, fetches at `:392-910`), `components/operational-pages.tsx` (1669, four `exhaustive-deps` suppressions at `:486,494,515,522`), `components/transcript/transcript-view.tsx` (771) | Split into data hooks, an upload hook and per-panel components. | L |

### 2. `lib/`, `worker/`, `mcp/`

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| L1 | Blocker | Every deploy kills in-flight jobs. The worker drains with `worker.close()` (waits for the active job), but no compose file sets `stop_grace_period`, so Docker SIGKILLs after 10 s while a transcription takes minutes. The job lock is 30 min, so the meeting sits in "transcribing" and paid ASR is redone. | `worker/index.ts:66-78`, `lib/jobs/processor.ts:1505` (`lockDuration` 1 800 000), no `stop_grace_period` in `docker-compose*.yml` | Set `stop_grace_period` on the worker (sized to the longest job) and have the deploy wait for the drain; or a shutdown timeout plus a shorter lock with renewal. | S |
| L2 | Blocker | A job that stalls out of retries never updates the database. The `failed` handler only logs; the failure bookkeeping lives only in `processJob`'s catch. After a crash or SIGKILL the `jobs` row stays `active`, the meeting stays `transcribing`/`summarizing` forever, and no `meeting.process_failed` webhook or notification fires. Nothing reconciles it. | `worker/index.ts:50-53`, `lib/jobs/processor.ts:1444-1486,1506-1507` | Run the same failure bookkeeping from `worker.on("failed")` when attempts are exhausted or the job stalled; add a periodic reaper for `jobs.status='active'` older than the lock. | M |
| L3 | High | A transient LLM failure (429, timeout) on first processing is saved as the final heuristic summary and the job completes; the user sees a "ready" low-quality summary and nothing retries. | `lib/intelligence/pipeline.ts:662-680` (rethrows only when `hasLlmSummary`), `lib/jobs/processor.ts:496-575` | Throw `TransientSummaryError` while attempts remain; allow the heuristic only on the last attempt, and mark it visibly as a fallback. | S |
| L4 | High | ASR and summarization run in one job, so a summary failure re-downloads and re-transcribes the whole recording (double ASR cost) and replaces the transcript again, dropping edits made in between. Backoff is 3 s exponential, too short for provider rate limits. | `lib/jobs/processor.ts:852,972,991`, `lib/jobs/queue.ts:246-270` | Split into `meeting.transcribe` → enqueue `meeting.summarize`, or skip ASR on retry when the transcript for this asset/run is already stored; backoff base ≥ 30 s for AI jobs. | M |
| L5 | High | Head-of-line blocking: webhook deliveries, search indexing and Google polls share the `meetsum` queue with 30-minute transcription jobs at concurrency 1. Webhook latency becomes as long as a transcription. | `lib/jobs/processor.ts:1497-1508`, `lib/webhooks/delivery.ts:4,118` | Move `webhook.deliver`, `meeting.index` and polls to their own queue/worker, like `meetsum-bot` and `meetsum-integrations`. | M |
| L6 | High | The encryption key for OAuth refresh tokens and webhook secrets silently falls back to `MEETSUM_SESSION_SECRET` and then `WEBHOOK_SIGNING_SECRET`. Rotating the session secret then makes every stored token undecryptable. Webhook secrets are encrypted without AAD, so ciphertext is not bound to its row. | `lib/auth/secret-crypto.ts:62-75,82-103`, `lib/webhooks/secret.ts:42` | Require `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY` in production (`assertRuntimeEnvironment`); bind webhook secrets with AAD `${workspaceId}:${subscriptionId}`. Check production `.env.local` first (Q5). | M |
| L7 | Medium | Raw `fetch` with no timeout in worker paths; a stalled connection pins the single worker slot until the lock expires. | `lib/capture/zoom.ts:166,340`, `lib/capture/teams.ts:127,167`, `lib/google/auth.ts:154`, `mcp/tools.mjs:70` | `AbortSignal.timeout()` or reuse `providerFetch` (`lib/integrations/core/http.ts`). | S |
| L8 | Medium | `media.prepare` uses a fixed job id and failed jobs are retained (`removeOnFail` 500), so a re-enqueue after a prepare failure is silently deduplicated and playback/peaks are never regenerated. | `lib/jobs/queue.ts:115-121,271-272,289-295`, `lib/jobs/processor.ts:754-767` | `removeOnComplete/removeOnFail: true` for `media.prepare`, or remove the old job before adding (as `lib/webhooks/delivery.ts:121-127` does). | S |
| L9 | Medium | Terminal-state writes and event fan-out are swallowed with no log; during a DB blip the job and meeting stay `active`/`summarizing` while BullMQ says failed, and lost webhooks leave no trace. | `lib/jobs/processor.ts:286-288,296,1022,1136,1464,1468-1470,1483` | Log every swallowed error; feed the reaper from L2. | S |
| L10 | Medium | The `jobs` table grows without bound: a row per enqueue, including deduplicated ones and one `search.index.sweep` per workspace every 10 minutes; nothing ever deletes rows. | `lib/jobs/queue.ts:251,289-295`, `lib/search/index-sweep.ts:167-196` | Skip the row for housekeeping jobs; daily retention for finished rows older than N days. | S |
| L11 | Medium | Meeting-list text search runs `ILIKE '%q%'` over all transcript segments with no trigram index on `transcript_segments.text`. | `lib/meetings/postgres-repository.ts:450-462`; trigram index only on `meeting_chunks.text_norm` (`db/migrations/025_search_ask.sql:42`) | Route list search through the M6 hybrid search, or add a `gin_trgm_ops` index. | M |
| L12 | Medium | **Known gap, confirmed (code side).** `shouldEscalateTranscription` is called only from tests; the ASR router never consults confidence. | `lib/ai/policy.ts:13-28`; callers only `tests/platform-core.test.ts:9,64,74`, `tests/prompt-builder.test.ts:4,171` | Either wire it into the ASR router (Phase 3) or delete it and fix the doc (D1). | S (delete) / M (wire) |
| L13 | Medium | Dead or test-only code shipped: `summarizeInHebrewPrompt` (deprecated), `lib/ai/summary-templates.ts` shim, and in `lib/ai/providers.ts`: `createTranscriptionProvider` `:761`, `AsrRouterTranscriptionProvider` `:704`, `asrResultToTranscriptSegments` `:678`, `GeminiSummaryProvider` `:495`, `getTranscriptionRunMetadata` `:228`. | `lib/ai/policy.ts:144`; usages only in `tests/` | Delete with their tests. | S |
| L14 | Medium | Duplication: timing-safe compare hand-rolled in 9+ places; three or more outbound HTTP clients; three token-cache/refresh implementations. | e.g. `lib/bot/webhook-verify.ts:39`, `lib/capture/zoom.ts:118-123`, `lib/platform/events.ts:61-67`, `lib/sharing/share-access.ts:83`; HTTP: `lib/ai/asr/http.ts`, `lib/integrations/core/http.ts`, `lib/bot/vexa/client.ts`; tokens: `lib/capture/token-cache.ts`, `lib/integrations/core/tokens.ts`, `lib/google/oauth-tokens.ts` | Extract `lib/http/safe-equal.ts` and a shared `fetchWithTimeout`; converge token caches. | M |
| L15 | Medium | Modules that mix concerns and block parallel work: `lib/meetings/postgres-repository.ts` (4495 lines), `lib/meetings/repository.ts` (3172), `lib/google/services.ts` (1852, Gmail+Calendar+Drive+Meet), `lib/jobs/processor.ts` (1510, every job handler plus webhook fan-out and notifications), `lib/workspaces/store.ts` (1331). | file sizes at the reviewed revision | Split `processor.ts` into per-job modules with a thin dispatcher, and `google/services.ts` per service, first. | L |
| L16 | Low | Delegated Google client rebuilt per call (IAM `signJwt` + token exchange each time on the keyless strategy). | `lib/google/auth.ts:122-185`; callers e.g. `lib/google/services.ts:934,1042,1276` | Cache per (subject, scopes) until expiry − 60 s. | S |
| L17 | Low | Main worker has no `error` listener (Redis errors bypass the logger and Sentry); `void shutdown()` has no catch. | `worker/index.ts:46-53,80-81` (compare `lib/bot/worker.ts:125`) | Add `worker.on("error")` and `.catch(() => process.exit(1))`. | S |
| L18 | Low | Duplicate index `meetings(workspace_id, started_at desc)` under two names; the search sweep predicate cannot use the only partial index. | `db/migrations/019_workspace_scoping.sql:70`, `030_i18n_notifications_onboarding.sql:47`; `lib/search/index-sweep.ts:63-70`, `025_search_ask.sql:102` | Drop one; add a matching partial index. | S |
| L20 | High | A Drive import is marked `imported_at` before the transcription job is enqueued; if Redis rejects the enqueue, later polls skip the file forever. Same ordering in the manual importer. | `lib/google/services.ts:1662,1704,1721` (poll), `:1206,1223` (manual) | Mark imported only after a stable ingest job exists, or keep a pending state reconciled by the poll. | S |
| L21 | Medium | Webhook payloads are frozen at fan-out and re-sent unchanged on every retry; a meeting made private after the event still has its title/summary POSTed. | `lib/webhooks/delivery.ts:232-242` (payload stored), `:488-492,530-537` (sent as stored); visibility only applied when built, `lib/platform/event-payloads.ts:130-141` | Re-check visibility before each attempt and downgrade to the minimal payload. | S |
| L22 | Medium | With `MEETSUM_ASR_CHAIN` set, `MEETSUM_ASR_CHAIN_NON_HE` unset and a leftover `MEETSUM_TRANSCRIPTION_PROVIDER=auto`, non-Hebrew recordings go to Gemini even with `MEETSUM_ASR_ALLOW_GEMINI=false`, while the boot warning says the legacy var is ignored. | `lib/ai/asr/config.ts:86-107`, `:160-167` | Make an explicit Gemini opt-out win for both chains; test mixed settings. Check production `.env.local` (Q5). | S |
| L23 | Medium | Search `markSkipped` has no expected-version guard (unlike `writeIndex`), so a transcript written during an index run can be stamped indexed with no chunks. | `lib/search/index-store.ts:286-292` vs. `:280` | Same version guard as `writeIndex`. | S |
| L24 | Medium | The daily media-retention timer is a plain `setInterval` with no run at start, so a worker restarted more often than every 24 h never enforces retention; `media-retention.ts` prints the error count and still exits 0. | `worker/index.ts:125-135`; `scripts/media-retention.ts:105-129` | Durable schedule (BullMQ repeatable job) with start-up catch-up; non-zero exit on errors. | S |
| L25 | Medium | Google poll jobs trust the `subject` stored in the job payload at execution time, so a queued job keeps reading a mailbox after that user is removed or demoted. | `lib/jobs/processor.ts:1277-1301` | Re-resolve and re-authorize the subject when the job runs. | S |
| L19 | Low | MCP `get_transcript_segments` fetches the full transcript per page and slices client-side. | `mcp/tools.mjs:271,303-306` | Pass offset/limit to the API. | S |

### 3. `scripts/` (deploy, backup, restore, migrate)

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| S1 | Blocker | No scheduled, off-host or encrypted backups and no retention. `.env.local` and `/opt/meetsum/secrets` are not backed up, so a restored DB cannot decrypt integration tokens. Every deploy adds a dump to the same disk. | `scripts/backup-full.sh`, `scripts/backup-postgres.sh:14-18` (plain dump, default umask), `docs/backup-restore.md:85-88` ("set up a cron…"), `docker-compose.prod.yml:46`, `scripts/reencrypt-tokens.ts:8` | Daily timer for `backup-full.sh` plus encrypted env/secrets (age/gpg), off-host copy (restic/rclone), retention, `umask 077`. Destination is Asaf's call (Q1). | M |
| S2 | Blocker | The manual rollback ignores schema state. `rollback-vps.sh` → `deploy-vps.sh --rollback` calls `rollback` without `check_breaking` or reading `schema_migrations`; only the automatic path refuses. After v0.7.1, rolling back to v0.6.0 code against the 019 schema crash-loops or writes broken rows. | `scripts/rollback-vps.sh:14`, `scripts/deploy-vps.sh:367-371` (vs. `:412,471,496`) | In rollback mode compare the target revision's migrations with `schema_migrations`; refuse when an applied breaking migration is unknown to the target, unless `--force`. | M |
| S3 | High | `backup-full.sh`, `restore-full.sh` and `restore-postgres.sh` expand `POSTGRES_USER`/`POSTGRES_DB` on the host, where they are normally unset; with non-default names they dump/restore the wrong database. `backup-postgres.sh` does it right. | `scripts/backup-full.sh:50`, `scripts/restore-full.sh:86`, `scripts/restore-postgres.sh:21` vs. `scripts/backup-postgres.sh:18` | Use the in-container `sh -c '… "$POSTGRES_USER" …'` pattern. | S |
| S4 | High | Restore runs into the live database: app and worker keep running, no `--single-transaction`/`--exit-on-error`, and the MinIO restore is `mc mirror --overwrite` without `--remove`, so it is not a point-in-time restore. A missing checksum is skipped silently. | `scripts/restore-postgres.sh:20-22`, `scripts/restore-full.sh:71-82,103-104` | Stop app+worker, restore with `--single-transaction --exit-on-error` (or into a fresh DB and swap), `--remove` on mirror, missing checksum = error, run migrations after. | M |
| S5 | High | No signal trap in the deploy: it stops app and worker for the write-freeze (`compose stop`), and if the SSH session drops or the 25-minute action timeout hits, nothing restarts them (`unless-stopped` does not restart explicitly stopped containers). | `scripts/deploy-vps.sh:416-418` (no `trap` anywhere), `.github/workflows/deploy.yml:55` | `trap` on HUP/INT/TERM/EXIT that restarts the old release while in maintenance; run under `systemd-run`/`nohup`. | M |
| S6 | High | Backup integrity is never checked: `backup-postgres.sh` only checks non-empty, the MinIO mirror is never verified, and no job ever restores a dump. | `scripts/backup-postgres.sh:20-25`, `scripts/backup-full.sh` | `pg_restore --list` after dump; weekly (and CI) restore of the latest dump into a scratch Postgres + `db:schema:check`. | M |
| S7 | Medium | Migration runner has no advisory lock and no checksum, so concurrent runs (manual `compose run migrate`, dev compose where app and worker both depend on migrate) and edited applied migrations go undetected. | `lib/db/migrations.ts:44-81`, `scripts/migrate.ts` | `pg_advisory_lock` around the run; checksum column; fail on mismatch. | S |
| S8 | Medium | No `lock_timeout`/`statement_timeout` in migrations and no support for `CREATE INDEX CONCURRENTLY` (each migration runs in a transaction). Fine for 015–032 inside the maintenance window, risky for future live migrations. | `db/migrations/019_workspace_scoping.sql:46-51,70-78`, `030_…sql:47-48` | Runner sets `lock_timeout`; `-- meetsum:no-transaction` marker for concurrent index builds; document. | M |
| S9 | Medium | Migration 032 drops or renames `integration_endpoints` but is not marked `-- meetsum:breaking` (only 019 is). | `db/migrations/032_drop_integration_endpoints.sql:3-12` | Mark it, and add a rule (test) that DROP/RENAME migrations must be marked. | S |
| S11 | High | The automatic rollback is called as `rollback \|\| true`, which disables `errexit` inside the function: a failed `git reset` or compose switch is followed by health checks against whatever is still running and a false "rollback complete". | `scripts/deploy-vps.sh:476,501`, function `:308-340` | Check each rollback command explicitly; verify the running image revision of app and worker. | S |
| S12 | High | A CI deploy can build a commit other than `DEPLOY_SHA`: if the VPS checkout is already ahead, `git merge --ff-only "$DEPLOY_SHA"` is a no-op and the script builds `HEAD`. | `scripts/deploy-vps.sh:386-396` | Fail unless `git rev-parse HEAD` equals the resolved `DEPLOY_SHA` (or build a detached checkout of it). | S |
| S13 | High | `restore-full.sh` accepts incomplete backups: Postgres and MinIO are each restored only if present, so a directory with just `manifest.json` prints "Restore Complete"; a malformed manifest silently disables checksum verification. | `scripts/restore-full.sh:32-41,66-108` | Validate the manifest and every declared artifact (and checksum) before touching either store; explicit flag for partial restores. | S |
| S14 | Medium | The full backup is not point-in-time consistent: Postgres is dumped, then MinIO is mirrored, so retention or deletions in between leave media rows without objects. | `scripts/backup-full.sh:46-69`, `lib/storage/retention.ts:183-195` | Pause retention/writers during the backup or verify every referenced object after mirroring. | M |
| S15 | Medium | Host secret files inside the checkout enter the Docker build context: `.dockerignore` excludes `.env*` and `.secrets` but not `secrets/` or `vexa.env`, and the builder does `COPY . .`. The documented locations put them there. | `.dockerignore:7-13`, `Dockerfile:12`, `docs/production-deployment.md:128-134` | Keep secrets outside the checkout; add `secrets/`, `*.json` key files and `vexa.env` to `.dockerignore`; explicit COPY inputs. Confirm the VPS layout (Q6). | S |
| S16 | Low | `compose stop app worker` failing half-way exits under `set -e` before the recovery branch, leaving one service down. | `scripts/deploy-vps.sh:44,416-418` | Covered by the trap in S5. | — |
| S10 | Low | Rollback relies on `meetsum:current`/`meetsum:previous` tags; on the first v0.7 deploy `previous` does not exist (v0.6.0 used `meetsum-app`/`meetsum-worker`), and a prune forces a full `next build` on the memory-constrained host. | `scripts/deploy-vps.sh:327-331,462-464`, `docs/runbooks/upgrade-0.6-to-0.7.md:28` | Keep `meetsum:<sha12>` tags; `docker save` the v0.6.0 images before the upgrade. | S |

### 4. `db/migrations/`

Covered by S2, S7, S8, S9 and L18. The 015–032 upgrade was rehearsed on a production dump and passed; each
migration runs in its own transaction and the breaking 019 triggers the maintenance window and a write-freeze
backup. No further migration defects were found.

### 5. `tests/` and e2e

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| T1 | High | 18 vitest files skip silently when PGlite fails to load (`context.skip("PGlite did not load")`), including workspace-isolation and migration tests; CI never checks the skip count. | e.g. `tests/integration-isolation.test.ts:105`, `tests/m9-isolation.test.ts:107`, `tests/share-password-postgres.test.ts:50`; `grep -rl "PGlite did not load" tests` → 18 files | Throw instead of skip when `CI=true`, or fail the job on skipped > 0. | S |
| T2 | High | No test for the worker failure paths (L1–L3): retries, stalls and the permanent-failure bookkeeping are only tested by calling the processor with mocks. | `tests/job-processor.test.ts:34,98-133` | One integration test on real Redis that fails, stalls and exhausts a job and asserts DB state. | M |
| T3 | High | Restore paths are only string-checked; `restore-postgres.sh` is not even syntax-checked; no backup → restore roundtrip exists. | `tests/backup-full.test.ts:75-80`, `tests/deploy-script.test.ts:17-25` | Add the script to the checked list; fake-docker tests for restore; CI roundtrip (S6). | M |
| T4 | Medium | The real-Redis rate limiter test never runs in CI (`runIf(REDIS_URL)`, and the `quality` job has no Redis). | `tests/rate-limit-redis.test.ts:127`, `.github/workflows/ci.yml:18-62` | Add a Redis service + `REDIS_URL` to `quality`. | S |
| T5 | Medium | No coverage configuration or threshold although `@vitest/coverage-v8` is installed. | `vitest.config.ts:13-16`, `package.json:111` | Enable v8 coverage in CI with floors for `lib/auth`, `lib/sharing`, `lib/webhooks`, `lib/jobs`. | S |
| T6 | Low | Playwright has no `forbidOnly`; `retries: 1` in CI hides flakes; several suites skip on missing env instead of failing. | `playwright.config.ts:22`; `tests/e2e/m10-bot.spec.ts:45`, `m6-search-ask.spec.ts:142-318`, `m8-integrations.spec.ts:431`, `m9-polish.spec.ts:183` | `forbidOnly: !!process.env.CI`; fail on unexpected skips. | S |
| T8 | High | The E2E matrix is flaky at the reviewed revision, so a red run carries no signal. On `ad1b365` the push run failed `m8` (`m8-integrations.spec.ts:253`, 31 s timeout, failed again on retry; run 45035575967). This docs-only PR's run on the same code failed `core` (`m10-core-flow.spec.ts:308`, then the upload test `:58` got a 500 instead of 202 on retry) and `m6` (run 45074731623). | `.github/workflows/e2e.yml`; specs above | Before C1 makes E2E a deploy gate: fix the Redis-stop test (`:308`) leaking state into later tests, triage the m8 Slack-connect timeout, and track flake rate. | M |
| T7 | Low | Deploy tests use stubbed docker/git/flock only; nothing validates the real compose files. | `tests/deploy-flow.test.ts:83` | See C3. | — |

### 6. `.github/workflows/`

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| C1 | High | The deploy workflow triggers on `CI` only; the five E2E suites (`e2e.yml`) are not in the gate. (The workflow is inert today because `DEPLOY_ENABLED` is unset; this matters the day it is turned on.) | `.github/workflows/deploy.yml:10-18`, `docs/runbooks/deploy.md:9` | Run E2E as `workflow_call` inside CI, or check both conclusions for the SHA before deploying. | S |
| C2 | Medium | SSH deploy has no host-key pinning. | `.github/workflows/deploy.yml:47-57` (no `fingerprint`) | Add `fingerprint`; restrict the key with `command=` in `authorized_keys`. | S |
| C3 | Medium | CI never builds the production Dockerfile, never validates compose files, and runs no shellcheck, `npm audit` or SAST. A broken Dockerfile or script is first seen on the VPS mid-deploy. | `.github/workflows/ci.yml` (jobs `quality`, `schema` only) | `build-image` job: `docker build`, `docker compose -f docker-compose.prod.yml -f docker-compose.migrate.yml config -q`, shellcheck `scripts/*.sh`, `npm audit --omit=dev`. | S |
| C4 | Low | `ci.yml` and `desktop-windows.yml` have no `permissions:` block; `desktop-windows.yml` exposes the signing cert secrets on same-repo `pull_request`. | `.github/workflows/ci.yml:1-16`, `.github/workflows/desktop-windows.yml:26-28` | `permissions: contents: read`; signing only on push/tag via a protected environment. | S |
| C6 | Medium | The migration re-run check pipes through `tee`; without `shell: bash` GitHub runs `bash -e` without `pipefail`, so a failing `db:migrate` that printed "No pending migrations" still passes. `workflow_dispatch` on the deploy also deploys without checking CI for that SHA. | `.github/workflows/ci.yml:121-124`; `.github/workflows/deploy.yml:19,36-49` | `shell: bash` (adds pipefail); require green CI + E2E for the SHA on both triggers (with C1). | S |
| C5 | Low | Stale comment says `db:schema:check` "exits 0 until package D implements it"; the check is real now. | `.github/workflows/ci.yml:64-67` | Fix the comment. | S |

### 7. `docker-compose*.yml`, `Dockerfile`, `deploy/`

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| K1 | High | Production containers run as root with no resource limits on a 7.6 GB host with an OOM history; the app also mounts `/opt/meetsum/secrets`. A runaway ffmpeg/whisper/`next build` can OOM the host and take Postgres down. | `Dockerfile:18-42` (no `USER`), `docker-compose.prod.yml` (no `mem_limit`/`cpus`/`cap_drop`/`security_opt`) | `USER node`; per-service `mem_limit`, `cpus`; `cap_drop: [ALL]`, `no-new-privileges` on app/worker. | M |
| K2 | Low | `minio` pinned by tag only; prod Postgres is `17.9-alpine` while CI uses Debian images (collation differences undetected). | `docker-compose.prod.yml:171`; CI service images | Pin by digest; one CI job on the exact prod image. | S |
| K4 | Medium | The Vexa env template breaks its own bootstrap: `DEFAULT_BOT_NAME=MeetSum Notetaker` is unquoted and `bootstrap.sh` sources the file with bash. Colocated Vexa also gets the host Docker socket (a separate host is documented in `docs/runbooks/vexa-isolated-host.md`). | `deploy/vexa/vexa.env.example:44`, `deploy/vexa/bootstrap.sh:24`; `deploy/vexa/compose.override.yml:68-75` | Quote the value and test the template; make the isolated host the only production path for Vexa (Q7). | S |
| K3 | Low | Dev `docker-compose.yml` publishes Postgres, Redis, MinIO and n8n on all interfaces with default credentials. | `docker-compose.yml:21-22,77-78,90-91,111-113,125-126` | Bind to `127.0.0.1`. | S |

Checked and fine: third-party images pinned by digest (except minio); Postgres/Redis/MinIO publish no ports in
prod; the app binds to `127.0.0.1`; no secrets on command lines; the deploy backs up before migrating, is
`flock`-guarded and waits on app and worker readiness.

### 8. `docs/` against the code

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| D1 | Medium | **Known gap, confirmed.** The architecture doc claims hybrid local-first processing with paid/API escalation on weak Hebrew, diarization or audio confidence. No such escalation exists (L12). The same section says Gemini and Gemma "should be added", which is stale. | `docs/architecture.md:27-29`; `lib/ai/policy.ts:13` used only by tests | Describe the real configuration-ordered ASR chain; move escalation to the roadmap. | S |
| D2 | Medium | The backup doc says the deploy runs `backup:full`; the deploy runs `backup-postgres.sh`, so MinIO is never backed up by a deploy. | `docs/backup-restore.md:84` vs. `scripts/deploy-vps.sh:377,421-422` | Fix the doc or call `backup-full.sh` from the deploy (decide with S1). | S |
| D3 | Medium | Retention settings `audioMaxDays`/`videoRetention` do not exist; the real one is `audioRetentionDays` (default 180), and `media-retention.ts` flags `--target`/`--days` are undocumented. | `docs/backup-restore.md:63-64`; `lib/settings/app-settings.ts:27,58`; `scripts/media-retention.ts:12-16` | Correct the doc. | S |
| D4 | Medium | Slack slash commands are documented (endpoint `…/api/integrations/slack/commands`, `SLACK_COMMANDS_ENABLED`, `SLACK_SIGNING_SECRET`) but no such route exists; `SLACK_SIGNING_SECRET`, `MS_CALENDAR_PUSH` and `MEETSUM_CLIP_SHARE_URL_TTL_SECONDS` are read nowhere. | `docs/runbooks/integrations.md:62,155-161`, `SETUP.md:118`, `.env.example:312,547,559`, `docs/env-matrix.md:215,382,389`; no `app/api/integrations/slack/` | Mark "not implemented" or remove. | S |
| D5 | Low | Deploy runbook and CHANGELOG say the backup scripts honour `docker-compose.local.yml`; `backup-postgres.sh` and `restore-postgres.sh` do not. | `docs/runbooks/deploy.md:51`, `CHANGELOG.md:20`; `scripts/backup-postgres.sh:17`, `scripts/restore-postgres.sh:20` | Add the override handling (with S3). | S |
| D6 | Low | `.env.example` sets `APP_PORT=3000`; prod compose and three docs use 3005, so the documented SSH tunnel fails. | `.env.example:11`, `docker-compose.prod.yml:39`, `docs/architecture.md:7`, `docs/production-deployment.md:9` | Note the prod default or comment the line out. | S |
| D8 | High | The fresh-host install never becomes ready: the documented `docker compose … up -d --build` starts the app without running migrations (they live in `docker-compose.migrate.yml`) or creating the bucket, so `/health/ready` fails. Matters for disaster recovery onto a new host. | `docs/production-deployment.md:24-28`; `docker-compose.migrate.yml:13-18`; `lib/health/checks.ts:132-145,175-195` | One documented bootstrap: infra up → bucket → migrate → app/worker → wait ready; rehearse it as part of S6. | S |
| D7 | Low | Stale or wrong references: `scripts/asr-evaluate.ts` (real: `evaluate-hebrew-asr.ts`); observability runbook compose commands without `--env-file` fail on `${…:?}`; README says the E2E matrix is "added in M10" and M10 "in progress"; `docs/README.md` lists `parity/m0.md`, which does not exist; env-matrix marks numeric `*_TOKENS` tuning vars as secrets and shows a past model retirement date. | `docs/asr-evaluation.md:48,51`; `docs/runbooks/observability.md:45,47,96,97`; `README.md:97,109`; `docs/README.md:29`; `docs/env-matrix.md:179,210,234-256` | Fix; tighten the env-matrix secret heuristic and scanner. | S |

Checked and accurate: the API route index (`tests/api-reference-complete.test.ts`) and env documentation
(`tests/env-documented.test.ts`) are enforced in `npm test`; every e2e spec maps to a Playwright project and an
`e2e.yml` job; deploy flags and step order match `deploy.md` and `upgrade-0.6-to-0.7.md`; the MCP tool list in
`SETUP.md` matches `mcp/tools.mjs`.

## Phased plan

Phase 0 is not code: it is the v0.6.0 → v0.7.1 production upgrade that is already rehearsed. Do the items
marked ⓪ before running it, since they protect that upgrade itself.

### Phase 1: release blockers (before the next production release)

| Order | Items | Why first |
|---|---|---|
| ⓪ 1 | **A16** | v0.7.1 as merged truncates uploads over 10 MiB; deploying it as-is breaks the core upload flow. Fix and release as v0.7.2 before the production upgrade. |
| ⓪ 2 | S1 (at least one off-host, encrypted copy of DB + MinIO + `.env.local` + `secrets/`), S3, S13, S10 (`docker save` v0.6.0 images) | The upgrade's only rollback after 019 is the restore; the restore must work and the backup must survive the host. |
| ⓪ 3 | S2, S5, S11, S12 | Prevent a rollback onto an incompatible schema, a half-stopped site, a false "rollback complete" and a build of the wrong commit during the upgrade window. |
| 4 | A17, A18, A19 | Privacy and data-loss bugs a normal user can trigger from the UI or API. |
| 5 | L1, L2, L9, L17, T2 | Every deploy currently kills and strands in-flight meetings. |
| 6 | L3, L4 (at least "skip ASR on retry"), L8, L20 | Wrong "completed" summaries, double ASR cost, silently missed imports. |
| 7 | A1 + A21, A3, A4, L6 | Cost abuse, public config disclosure, missing headers, key fallback. |
| 8 | S4, S6, T3, D8 | A restore (including onto a fresh host) must be safe and proven, not assumed. |
| 9 | T8, T1, C1, C3, C6 | CI must fail when isolation tests are skipped or a pipeline step fails, and must build the image the VPS will run. |
| 10 | K1 | Memory limits so one runaway process cannot take Postgres down. |

### Phase 2: cleanup and refactors

- Worker topology and data hygiene: L5 (separate queues), L10, L7, L18, L23, L24, S7, S8, S9, S14.
- Security hardening that is not blocking: A2 (after Q3), A5, A6 (after Q4), A7, A8, A9, A10, A11, A12, A20, L21, L22, L25, S15, C2, C4, K2, K3, K4.
- Product truth: A22 (share expiry).
- Dead code and duplication: L12/L13 (delete or wire), L14, A14, A13 (remove or build), C5.
- Docs truth pass: D1–D7.
- Tests: T4, T5, T6.
- Structural splits that unblock parallel work: L15 (`lib/jobs/processor.ts`, `lib/google/services.ts` first), A15.

### Phase 3: improvements

- ASR confidence escalation actually implemented (L12/D1) with an evaluation on `tests/fixtures/asr/eval`.
- The detailed quality review panel behind the right-rail button (A13).
- Search performance (L11), Google client caching (L16), MCP pagination (L19).
- Full CSP enforcement (A4 follow-up); session revocation UI (A7 follow-up).
- The deferred infra Dependabot PRs (#29 pgvector, #47 Redis 8, #49 n8n, #50 PG18, #51 Node 26), one at a
  time after the production upgrade and after C3 exists to build-test them. Not acted on here.

### What blocks the next development stages

- `lib/jobs/processor.ts` (every job handler in one file) and the single queue (L5, L15) block any new
  pipeline stage (escalation, re-summarization policies) from being added safely.
- `lib/meetings/postgres-repository.ts` at 4495 lines is a merge-conflict hotspot for every feature.
- Without C3 and T1 the deferred infra upgrades cannot be verified before they hit the VPS.

## Review loop and Codex provenance

**How the loop ran**

| Round | What | Outcome |
|---|---|---|
| 0 | Own review in four area passes (app/components, lib/worker/mcp, scripts/migrations/CI/compose, docs/tests), each finding re-checked against the code | Findings A1–A15, L1–L19, S1–S10, T1–T7, C1–C5, K1–K3, D1–D7 |
| 1 | Independent Codex pass per area (`codex exec --sandbox read-only`), given the code and scope only, not our findings | 78 findings. Most overlapped ours; the new, verified ones were merged (below) |
| 2 | Codex asked to critique this merged plan (wrong / missing / mis-prioritized) | **Did not complete: Codex hit its usage limit** (`ERROR: You've hit your usage limit … try again at Nov 23rd, 2026 12:04 AM`). No output; nothing from this round is in the plan. Rounds 3–4 were not run. |

So the plan has had one independent Codex pass, but Codex has not yet critiqued the merged plan.

**Raised by Codex in round 1, verified in the code and merged:** A16 (proxy upload truncation, the upgrade
blocker), A17, A18, A19, A20, A21, A22, L20, L21, L22, L23, L24, L25, S11, S12, S13, S14, S15, S16, C6, K4,
D8.

**Raised by both, independently (confirmations):** L4 (one job for ASR + summary; summary retry erases
transcript edits), S1/S6 (no restore verification), S2 (rollback across an applied breaking migration), S3
(host-side `POSTGRES_USER`), S4 (in-place restore leaves a mixed schema, `mc mirror` without `--remove`), S5 (a
partial maintenance stop leaves production down), S7 (no migration lock), S8 (lock-heavy migrations), K1 (root
containers, no limits), C1 (E2E not in the deploy gate), C2 (no host-key pinning), C4 (signing secrets on PR
builds), D2 (the pre-deploy backup is Postgres-only), D4-class doc gaps, A11 (logout via GET), A5 (raw provider
errors), L7 (no fetch deadlines, Soniox included), L9 (swallowed fan-out errors), L19 (MCP full-transcript
paging).

**Codex severities we changed, and why:**

- *Fresh install never becomes ready* (D8): Codex said Blocker; **High** here. Production is an existing host
  deployed by `deploy-vps.sh`, which runs migrations. The gap matters for disaster recovery onto a new host.
- *Full restore accepts incomplete backups* (S13): Codex said Blocker; **High** here. It needs a damaged backup
  to bite, and S1/S6 add verification before any real restore.
- *Online migrations hold exclusive locks through backfills (027)*: Codex said High; **Medium** (folded into
  S8). For the 015–032 upgrade, 019 is breaking, so the whole batch runs inside the maintenance window, and the
  rehearsal on a production dump passed. The risk is for future non-breaking migrations.
- *Production credentials enter the build context* (S15): Codex said High; **Medium**. Only the builder stage
  does `COPY . .` and images are built and kept on the VPS, not pushed. It still needs fixing.
- *Colocated Vexa has host Docker access* (K4): Codex said High; **Medium**. An isolated-host runbook exists
  (`docs/runbooks/vexa-isolated-host.md`). Whether production uses it is Q7.
- *Windows signing credentials on PR builds* (C4): Codex said High; **Low**. Fork PRs get no secrets, so only
  someone with write access can reach them.

**Raised by Codex, not yet verified line by line (kept out of the tables until checked):**

- A summary can commit against a transcript edited mid-generation (`lib/jobs/processor.ts:496,560`,
  `lib/meetings/postgres-repository.ts:3019,3304`).
- The inline webhook fallback and the worker can POST the same delivery twice
  (`lib/webhooks/delivery.ts:89,254,475`).
- An empty first ASR result followed by a timed-out fallback becomes a permanent "no speech" failure
  (`lib/ai/asr/router.ts:240-305`).
- The Outlook delta cursor advances past failed events (`lib/integrations/microsoft/calendar-sync.ts:403-464`).
- An integration delivery can strand in `retrying`, and OAuth refresh leases are fenced by generation only
  (`lib/integrations/core/worker.ts:81-108`, `lib/integrations/core/tokens.ts:192-251`).
- Zoom/Graph recording downloads follow redirects without re-validating the host (`lib/capture/zoom.ts:338`,
  `lib/capture/teams.ts:255`).
- Disabling manual integration sends does not stop queued exports (`lib/integrations/core/deliver.ts:131-150`).
- Ask history keeps answer text after a meeting becomes private (`lib/ask/thread-store.ts:208,464-472`).
- Public share metadata loads the full meeting before password verification
  (`app/api/share/[token]/verify/route.ts:212`).
- Desktop ingest ignores a `targetMeetingId` sent after the file part
  (`app/api/desktop-capture/ingest/route.ts:89-145`).
- Meeting deletion reports success while recording cleanup failed (`app/api/meetings/[id]/route.ts:125-165`).
- The pgvector runbook can lose writes between dump and freeze, and archives the data dir while Postgres runs
  (`docs/runbooks/postgres-17-pgvector.md:27-71,137-139`).
- Doc gaps: the keyless Google recipe leaves user OAuth selected (`docs/production-deployment.md:59-82`,
  `.env.example:96`); `search:backfill` is documented without `--all` (`SETUP.md:54`); storage endpoint aliases
  are documented but not read (`docs/env-matrix.md:27-29`); browser uploads are described as resumable
  (`README.md:18`); the m8 fake-integration runbook uses the wrong Playwright selector
  (`docs/runbooks/integrations.md:186,197`).
- The m9-prod malformed-JSON test exercises the origin guard instead of JSON parsing
  (`tests/e2e/m9-prod.spec.ts:97-110`).
- The Vexa override drops the gateway port that bootstrap probes (`deploy/vexa/compose.override.yml:97-100`).
- A key-rotation test exercises a helper that the production rotation path does not call
  (`lib/auth/secret-crypto.ts:208`, `lib/auth/reencrypt.ts:107`).

**Disputed or dropped:** none of the round-1 findings checked so far turned out false. The six above were
re-rated, not dropped.

## Open questions for Asaf

1. **Q1 Backups:** where should off-host backups go (S3/B2/another host), and who holds the decryption key?
   This decides S1.
2. **Q2 Upgrade:** should A16 be fixed and released as v0.7.2, and the production upgrade done from v0.7.2
   instead of v0.7.1? (Recommended: yes. v0.7.1 as merged truncates uploads over 10 MiB.)
3. **Q3 Sign-in scopes:** is it intended that every user grants Gmail, Drive, Calendar and Directory read access
   at sign-in (A2)?
4. **Q4 Drive access:** should a regular member be able to browse and import from the workspace Google
   account's Drive and Meet (A6)?
5. **Q5 Production env:** is `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY` set in production `.env.local` (L6), and is a
   legacy `MEETSUM_TRANSCRIPTION_PROVIDER` still there (L22)? This review did not touch the VPS.
6. **Q6 VPS layout:** is the checkout `/opt/meetsum`, with `secrets/` and `vexa.env` inside it (S15)?
7. **Q7 Vexa:** does production run Vexa on the MeetSum VPS or on the isolated host (K4)?
8. **Q8 Deploys:** should automatic deploys (`DEPLOY_ENABLED`) be turned on after the upgrade, or stay manual?
   This sets the priority of C1, C2, C6 and S12.
9. **Q9 Product gaps:** should ASR confidence escalation be built (Phase 3) or the claim removed (D1/L12)?
   Should the detailed quality review behind the right-rail button be built or the button removed (A13)?
10. **Q10 Codex round 2:** run the Codex critique rounds again after its usage limit resets, before work starts
    on Phase 1?

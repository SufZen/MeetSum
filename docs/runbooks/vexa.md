# Runbook: MeetSum meeting bot (Vexa sidecar)

MeetSum's meeting bot ("MeetSum Notetaker") joins Google Meet, Microsoft Teams and Zoom calls, records the audio, and hands the recording to MeetSum's own ASR router for the final transcript. The bot itself is [Vexa](https://github.com/Vexa-ai/vexa), pinned to **v0.12.28**. It runs as a separate Docker Compose project on the same VPS.

- Spec: `docs/parity/m7.md`. What was checked against the tag: `deploy/vexa/VERIFIED.md`.
- Pin: `deploy/vexa/vexa.lock` (tag, commit SHA, image digests).
- Files: `deploy/vexa/` (bootstrap, override, env example), `docker-compose.vexa.yml` (the MeetSum side), `scripts/vexa-configure.ts`.

## How it fits together

```
MeetSum project (-p meetsum)                       Vexa project (-p vexa)
  app ──────────── meetsum-vexa (internal) ───────── gateway  (vexa-gateway:8000)
  worker                                    └─────── meeting-api ── admin-api ── runtime ── bot containers
  minio (meetsum-minio:9000) ◄── recordings ─────────┘          postgres (Vexa's own) · valkey (Vexa's own)
```

- MeetSum calls Vexa only through `VEXA_API_URL=http://vexa-gateway:8000`, using the `X-API-Key` header.
- Vexa sends status webhooks to `/api/integrations/vexa/webhook`. They are HMAC-signed with `VEXA_WEBHOOK_SECRET`.
- Vexa keeps its own Postgres database and Valkey. MeetSum's Postgres and Redis are not shared.
- Recordings land in a dedicated bucket in MeetSum's MinIO (`vexa-recordings`), written with bucket-scoped credentials. MeetSum copies each recording out through the Vexa API. Vexa artifacts are purged after 72 hours (`MEETSUM_VEXA_ARTIFACT_RETENTION_HOURS`). The bucket also has a 7-day expiry rule as a safety net.
- No Vexa port is public, and nothing is routed through Traefik. Only the gateway is published, on `127.0.0.1:18056`, so `vexa:configure` can run from the host.

## Deploy

Prerequisites: Docker Compose 2.24.4 or later (the override uses `!reset`), about 2.5 GB of free RAM for the base stack plus about 1 GB per concurrent bot (see Capacity), and the bot Google account (see below).

1. **Secrets.** Copy `deploy/vexa/vexa.env.example` to `/opt/meetsum/vexa.env` and run `chmod 600` on it. Fill in `ADMIN_TOKEN`, `INTERNAL_API_SECRET`, `DB_PASSWORD`, `VEXA_MINIO_SECRET_KEY` and the upstream `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`, each from `openssl rand -hex 32`. Since 0.12.27, Vexa refuses to boot on placeholder values.
2. **MeetSum side.** Add `VEXA_MINIO_ACCESS_KEY`, `VEXA_MINIO_SECRET_KEY` and `VEXA_MINIO_BUCKET` to MeetSum's compose environment. Create the shared network once with `docker network create --internal meetsum-vexa` (bootstrap does this too), then run:
   ```bash
   docker compose -f docker-compose.prod.yml -f docker-compose.vexa.yml --profile vexa up -d
   ```
   `vexa-minio-init` creates the bucket, the user, the bucket-only policy and the expiry rule, then exits. `app`, `worker` and `minio` only gain the `meetsum-vexa` network.
3. **Vexa.** Run `VEXA_ENV_FILE=/opt/meetsum/vexa.env deploy/vexa/bootstrap.sh`. It clones the upstream repo into `$VEXA_HOME` and refuses to continue unless tag `v0.12.28` resolves to the SHA in `vexa.lock`. It then pulls the pinned images, records their digests in `vexa.lock`, runs `docker compose -p vexa … up -d gateway`, and waits for `GET /health`. Only gateway, admin-api, meeting-api, runtime, postgres, valkey, storage and storage-init run. The agent, flows, MCP, terminal and dashboard services are not started.
4. **API token for MeetSum.** Mint it with admin-api. The procedure follows upstream's `deploy/compose/bin/provision-token` at the tag: resolve or create the user (`GET /admin/users/email/{email}`, else `POST /admin/users`), then `POST /admin/users/{id}/tokens?scopes=bot,tx`, using the header `X-Admin-API-Key: $ADMIN_TOKEN`. The admin port isn't published, so run the standard-library version inside the container:
   ```bash
   docker compose -p vexa exec -T -e MAX_BOTS=2 admin-api python - < deploy/vexa/mint-token.py
   # → vxa_...   (only the token is printed; tokens are additive, old ones keep working until deleted)
   ```
   Put the token in MeetSum's `.env.local` as `VEXA_API_KEY`, along with `VEXA_API_URL=http://vexa-gateway:8000`, `VEXA_WEBHOOK_SECRET` (`openssl rand -hex 32`), `MEETSUM_BOT_ACCOUNT_EMAIL` and finally `MEETSUM_BOT_ENABLED=true`. Then restart app and worker.
5. **Webhook.** Run `npm run vexa:configure` inside the app container. It checks health, sets the webhook (to `VEXA_WEBHOOK_URL`, or else `NEXT_PUBLIC_APP_URL/api/integrations/vexa/webhook`) for `meeting.status_change`, `meeting.started`, `meeting.completed` and `bot.failed`, and prints the masked result. If the gateway rejects an internal URL such as `http://meetsum-app:3000/...`, set `VEXA_WEBHOOK_URL=https://meetsum.realization.co.il/api/integrations/vexa/webhook` and run it again. `npm run vexa:configure -- --check` only reads the current state.
6. **Smoke test.** Run `npm run bot:simulate` against the app. It posts signed fixture webhooks for requested → joining → awaiting_admission → active → completed. `--fake-vexa` also serves a recording, so finalize runs through to `media.ingest`. In the UI, the strip should move Joining → Waiting (with the admit hint) → Recording (with the dock and the live pill).
7. **Real test.** Open a Meet in the Workspace, then use **Record ▾ → Send bot to a meeting** and paste the link. Admit the bot if asked, talk for a minute, then click **Stop recording**. The meeting should get a transcript from MeetSum's ASR.

## Upgrade

1. Read the upstream release notes from v0.12.28 to the target tag. Check for breaking changes to the bots API, the webhook envelope, the `MINIO_*` variables and the service names.
2. Update `vexa.lock`: set `VEXA_GIT_REF`, `VEXA_GIT_SHA` (the commit the tag points to, not the tag object) and `VEXA_VERSION`. Update every `*_IMAGE` to the new `vexaai/v012-*:<tag>@sha256:…` digests, and put the same values in `compose.override.yml`. `tests/vexa-compose.test.ts` fails if they drift.
3. Re-check every item in `VERIFIED.md` against the new tag and update it. Re-record the fixtures with `scripts/bot-simulate.ts --record` against staging.
4. **Rotate the webhook secret** when crossing 0.12.27 or later, because 0.12.27 stopped returning the secret in clear text. Set a new `VEXA_WEBHOOK_SECRET`, restart the app, and run `npm run vexa:configure`.
5. Run bootstrap again, then smoke-test as in Deploy steps 6 and 7.

## Bot Google Workspace account

Meet screens unknown participants. A signed-in bot from your own Workspace is usually admitted without knocking in same-domain meetings.

1. **Create the user.** Create `notetaker@realization.co.il` as a licensed Workspace user named **MeetSum Notetaker**, and give it an avatar. Turn on 2-Step Verification and store the backup codes in the vault. Set `MEETSUM_BOT_ACCOUNT_EMAIL` to this address. MeetSum then excludes it from calendar participants and speaker candidates.
2. **Sign in the bot's browser profile.** Follow the authenticated-bot procedure at the tag (`make login` uploads a bot session through the storage service). Keep `MEETSUM_BOT_AUTHENTICATED=true`. If the profile signs out, sessions fail with `auth_session_missing` and the UI shows **"Bot signed out"**. Sign it in again.
3. **Admin console (Apps → Google Workspace → Google Meet).** Allow the account to join meetings. Set the "join without knocking" policy to same-domain. Exclude the account from any conference-recording restriction that would block it.
4. **Optional calendar invites.** Grant the `https://www.googleapis.com/auth/calendar.events` scope to MeetSum's domain-wide-delegation client and set `MEETSUM_BOT_CALENDAR_INVITE=true`. Auto-joined events then invite the bot account, which helps admission.
5. **Invite-the-bot guidance for users.** If the bot waits in the lobby, the strip says "Ask the host to admit MeetSum Notetaker from the waiting room". After `MEETSUM_BOT_AWAITING_ADMISSION_TIMEOUT_MINUTES` (15) the session ends as *blocked / not admitted*, and the UI offers **Record from this browser** and **Import from desktop app**. For important external meetings, add `notetaker@realization.co.il` to the invite.
6. **Teams.** Each target tenant must allow anonymous or guest join.
7. **Zoom.** The meeting must allow the web client. Otherwise sessions fail with `zoom_requires_rtms` and the UI shows "This meeting blocks bots from joining".

## Recording consent (legal note)

> This is not legal advice. Under Israel's Secret Monitoring Law (1979), a recording made by a participant in the conversation is not covert monitoring. The Privacy Protection Law, Amendment 13 (in force since August 2025), expects notice and transparency.

MeetSum announces recordings in three ways:

- **The bot name signals recording.** The default is `MeetSum Notetaker`, and Settings previews it as "MeetSum Notetaker · Recording" or "· מקליט".
- **A consent message is posted in the meeting chat** in the meeting's language, with `{owner}` replaced by the requester's name or the workspace name. Chat support in 0.12 is uncertain. When the chat endpoint is unsupported, the strip tells the host: "Tell participants the meeting is being recorded".
- **Auto-join can't be turned on until a workspace admin ticks the recording-consent acknowledgment** in Settings → Live meeting. That setting is audited as `bot.consent.acknowledged`.

Hosts should still announce the recording at the start of the call. Recordings follow the workspace's retention settings.

## Capacity

- Each concurrent bot needs about **1 vCPU and 1 GB RAM**: a headless browser container spawned by the runtime.
- The Vexa base (gateway, admin-api, meeting-api, runtime, Postgres, Valkey and storage) needs about 1.5 GB. The override sets per-service `mem_limit` and `cpus`.
- The VPS has about 7.6 GB, shared with MeetSum, faster-whisper and n8n. Keep `MEETSUM_BOT_MAX_CONCURRENT=2` and `MEETSUM_BOT_MAX_CONCURRENT_PER_WORKSPACE=2`, and the token's `max_concurrent_bots=2`. A third request gets *capacity*: calendar joins are re-delayed, and Join now returns "All bot slots are busy".
- To scale, move Vexa to a separate bot host (point `VEXA_API_URL` at it over a private network) or use Vexa's Kubernetes runtime (`RUNTIME_BACKEND=k8s`).
- The bot leaves after 10 minutes with no remote audio (`left_alone`), and a session has a hard cap of 4 hours.

## Docker socket

The runtime mounts `/var/run/docker.sock` to spawn bot containers, which is **root-equivalent on the host**. Mitigations, in order of preference:

1. Run Vexa on a dedicated, isolated host.
2. Set `VEXA_SOCKET_PROXY=1` to put `tecnativa/docker-socket-proxy` (pinned) in front of the runtime, with only the containers, images and networks APIs enabled (`deploy/vexa/compose.socket-proxy.yml`). This is not verified against the 0.12.28 runtime. If bots stop spawning, turn it off and use option 1.
3. If neither is possible, accept the risk explicitly. Keep the host patched, keep Vexa off Traefik, and restrict who can reach the Docker daemon.

## Troubleshooting by status reason

| Reason (UI) | Likely cause | Fix |
|---|---|---|
| `not_admitted` (host didn't admit the bot) | Meet lobby; external meeting | Admit "MeetSum Notetaker"; invite the bot account; use the browser or desktop recorder |
| `removed_by_host` | Host removed the bot | Ask the host; record from the browser |
| `platform_blocked` | Zoom without web client (`zoom_requires_rtms`) | Enable web-client join, or record locally |
| `bot_signed_out` | `auth_session_missing` | Sign in the bot browser profile again (Bot Google account, step 2) |
| `capacity` | Concurrency limit (403 from Vexa) | Wait, or raise the limits if the host has room |
| `already_in_meeting` | A bot is already in that meeting (possibly from another workspace) | Use the existing session; nothing about the other workspace is shown |
| `invalid_meeting_link` | 422 from Vexa | Paste the plain meeting link |
| `vexa_misconfigured` | Wrong `VEXA_API_KEY`, or transcription enabled without STT (503) | Re-mint the token; keep `TRANSCRIBE_ENABLED=false` |
| `vexa_unavailable` | Gateway down; request never got a meeting id | `docker compose -p vexa ps`, check logs, restart |
| `stale` | No webhook or poll update for 10 minutes; meeting gone in Vexa | Check the webhook with `npm run vexa:configure -- --check`; reconcile recovers missed webhooks |
| `left_alone` | Everyone left | Normal |
| `no_recording` | Finalize found no audio after all retries | Check meeting-api logs and MinIO credentials (`storage-init` logs) |
| `missed_window` / `event_cancelled` / `event_moved` / `rule_disabled` / `user_opt_out` | Calendar or rule changes | Normal; "Send bot" reopens it |
| `meeting_deleted` | The MeetSum meeting was deleted while the bot was live | Normal; the bot is stopped |

Useful commands: `docker compose -p vexa ps`, `docker compose -p vexa logs -f gateway meeting-api runtime`, and `curl -fsS 127.0.0.1:18056/health`.

## Retention

- MeetSum deletes Vexa's copy of each meeting (transcript and recording objects) 72 hours after import, or 72 hours after a session ends with no recording. It does this with `DELETE /meetings/{id}`, daily, and records `vexa_purged_at`.
- The `vexa-recordings` bucket expires objects after 7 days as a backstop.
- `bot_events` payloads are pruned after 30 days.
- The imported audio then follows the workspace's normal media retention.

## Known infrastructure note

On 2026-10-13, `minio/mc` (and the production file's `minio/minio:latest`) could not be resolved from Docker Hub. `vexa-minio-init` therefore uses `bitnamilegacy/minio-client`, pinned by digest. The production MinIO image reference is outside M7 and should be pinned separately.

## Fallback plan: ScreenApp meeting-bot

If Vexa fails on bot screening, stability or licence, fork ScreenApp `meeting-bot` (MIT). Only `lib/bot/vexa/**` would be replaced, because the rest of MeetSum talks to the `BotProvider` interface (`requestBot`, `stopBot`, `getMeeting`, recordings, `sendChat`, webhooks). Keep the same webhook route, signature scheme and status mapping, and swap this runbook's Deploy section for the fork's.

# MeetSum setup

This guide takes you from a fresh checkout to a working install, starting with free-tier keys. Every external service is optional except Google sign-in. Without the other keys, MeetSum still runs: summaries fall back to a heuristic, and search stays lexical.

- [1. Prerequisites](#1-prerequisites)
- [2. Local services and the app](#2-local-services-and-the-app)
- [3. Sign-in (Google OAuth client)](#3-sign-in-google-oauth-client)
- [4. Transcription with a free Groq key](#4-transcription-with-a-free-groq-key)
- [5. Summaries, Ask and semantic search with Gemini](#5-summaries-ask-and-semantic-search-with-gemini)
- [6. Optional providers: Claude, Soniox, RunPod, Modal](#6-optional-providers-claude-soniox-runpod-modal)
- [7. Google Workspace](#7-google-workspace)
- [8. External apps checklist](#8-external-apps-checklist)
- [9. MCP server](#mcp-server)
- [10. Verify the install](#10-verify-the-install)
- [11. Troubleshooting](#11-troubleshooting)

## 1. Prerequisites

- Node.js 24 (the version CI and the Dockerfile use) and npm.
- Docker with Compose, for Postgres, Redis and MinIO.
- `ffmpeg` and `ffprobe` on `PATH`, for media preparation, waveforms and audio chunking (the Docker image installs them). Set `FFMPEG_PATH`/`FFPROBE_PATH` if they live elsewhere.
- Optional: `poppler-utils` (`pdftotext`), to inspect Hebrew PDF exports.

## 2. Local services and the app

```bash
docker compose up -d postgres redis minio
npm ci
cp .env.example .env.local
```

Edit `.env.local`. The defaults use Docker service names; for `npm run dev` on the host, point them at localhost:

```dotenv
DATABASE_URL=postgres://meetings:meetings@127.0.0.1:5432/meetings
REDIS_URL=redis://127.0.0.1:6379
S3_ENDPOINT=http://127.0.0.1:9000
MEETSUM_SESSION_SECRET=<openssl rand -base64 48>
WEBHOOK_SIGNING_SECRET=<a different random value>
GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY=<a third random value>
MEETSUM_ALLOWED_EMAILS=you@yourdomain.com   # becomes owner of the default workspace
```

The media bucket (`S3_BUCKET`, default `meeting-media`) is created on first use.

```bash
npm run db:migrate     # applies db/migrations (001–032) and bootstraps ws_default
npm run dev            # http://127.0.0.1:3000 → Hebrew UI (/he); English at /en
npm run worker         # second terminal: BullMQ jobs (ASR, summaries, indexing, sync)
```

`docker compose up --build` runs the whole stack instead: `app`, `migrate`, `worker`, Postgres, Redis, MinIO and n8n, plus local faster-whisper with `--profile local-asr`. Production uses `docker-compose.prod.yml`; see [docs/production-deployment.md](docs/production-deployment.md) and the M10 deploy runbook.

Postgres without pgvector is fine: migration 025 skips the vector objects with a NOTICE, and search runs in `lexical` mode. For hybrid search, use the `pgvector/pgvector:0.8.1-pg17` image, then run `npm run search:vector-setup` and `npm run search:backfill`.

## 3. Sign-in (Google OAuth client)

Users sign in with Google. Create an OAuth client (type "Web application") in a Google Cloud project ([docs/google-cloud-bootstrap.md](docs/google-cloud-bootstrap.md)):

- Authorized redirect URI: `http://127.0.0.1:3000/api/auth/google/callback` (and your production URL later).
- Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and `GOOGLE_OAUTH_REDIRECT_URI`.

Only the emails in `MEETSUM_ALLOWED_EMAILS` get in at first; everyone else joins by invitation. API calls can also use API keys: create them in Settings → API keys, scoped `read`, `write` or `admin`.

## 4. Transcription with a free Groq key

Groq hosts Whisper behind an OpenAI-compatible API with a free tier. Create a key at console.groq.com, then:

```dotenv
LOCAL_TRANSCRIPTION_URL=https://api.groq.com/openai
LOCAL_TRANSCRIPTION_MODEL=whisper-large-v3-turbo
LOCAL_TRANSCRIPTION_API_KEY=gsk_...
LOCAL_TRANSCRIPTION_SEND_HOTWORDS=false
MEETSUM_ASR_CHAIN=local-whisper-chunked
```

- This uses generic `whisper-large-v3-turbo`, which is weaker on Hebrew than the ivrit-ai fine-tune, and has no diarization (every word is "Speaker 1", with a warning in the UI).
- The free tier has daily limits: long backfills hit HTTP 429, and the router backs off.
- Turn on Zero Data Retention in the Groq console.
- Better Hebrew for free: run the ivrit-ai model locally ([docs/runbooks/laptop-hebrew-asr/](docs/runbooks/laptop-hebrew-asr/README.md)), or use Modal's monthly credit with our `asr-worker`, which includes diarization.
- All options and prices are in [docs/runbooks/free-tier-asr.md](docs/runbooks/free-tier-asr.md).

## 5. Summaries, Ask and semantic search with Gemini

```dotenv
GOOGLE_GEMINI_API_KEY=...      # aistudio.google.com
GEMINI_TIER=free               # or paid
```

> **Privacy: free tier vs paid tier.** Gemini's free tier is fine for evaluating MeetSum on test recordings. On the free tier, Google may use your prompts and the model's outputs (here, your transcripts and summaries) to improve its products, and humans may review them. With `GEMINI_TIER=free`, the health page and the ops status show a warning. **Use the paid tier (`GEMINI_TIER=paid`, a billing-enabled project, or Vertex AI with `GOOGLE_GENAI_USE_VERTEXAI=true`) for real meetings.**

With a key set, you get LLM summaries, titles and chapters, Ask answers, and Gemini embeddings for hybrid search (`MEETSUM_EMBEDDING_PROVIDER`, once pgvector is present). Without a key, summaries use the heuristic fallback ("סיכום אוטומטי (ללא AI)") and Ask answers with an `llm_not_configured` error.

## 6. Optional providers: Claude, Soniox, RunPod, Modal

| Provider | Unlocks | Env |
|---|---|---|
| Anthropic Claude | Claude for summaries and Ask (`MEETSUM_LLM_PROVIDER_DEFAULT`), a second judge in the summary eval | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_*` |
| Soniox | Hebrew ASR with diarization, about $0.10 per audio hour | `SONIOX_API_KEY` |
| RunPod serverless | ivrit-ai Whisper with diarization (the primary Hebrew provider) | `RUNPOD_API_KEY`, `RUNPOD_ASR_ENDPOINT_ID` |
| Modal | our `asr-worker` (ivrit-ai and pyannote) within Modal's free credit | `MODAL_ASR_URL`, `MODAL_ASR_TOKEN`; the worker needs `HF_TOKEN` for pyannote |

The ASR chain tries providers in order and skips any without credentials (`MEETSUM_ASR_CHAIN`). The default Hebrew order is `runpod-ivrit → modal-worker → soniox → local-whisper-chunked`.

## 7. Google Workspace

Calendar sync, Drive recording import, Meet artifacts and Gmail sending use the signed-in Workspace user's OAuth grant (`GOOGLE_WORKSPACE_AUTH_STRATEGY=user-oauth`, `GOOGLE_WORKSPACE_SUBJECT`), or domain-wide delegation with a service account. See [docs/google-workspace-setup.md](docs/google-workspace-setup.md) and [docs/google-cloud-bootstrap.md](docs/google-cloud-bootstrap.md) for the scopes and admin-console steps.

## 8. External apps checklist

Register only what you use. Each row links to the runbook section with the exact redirect URIs and scopes. `BASE` is `MEETSUM_OAUTH_REDIRECT_BASE`, or your app URL.

| App or account | Where | What it enables | Env vars | Runbook |
|---|---|---|---|---|
| Google Cloud project and OAuth client | console.cloud.google.com | Sign-in, Calendar, Drive, Meet, Docs export | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | [google-cloud-bootstrap.md](docs/google-cloud-bootstrap.md), [integrations → Google OAuth client](docs/runbooks/integrations.md#google-oauth-client-docs-export) |
| Workspace bot account | Google Admin console | The meeting bot signs in as this user | `MEETSUM_BOT_ACCOUNT_EMAIL`, `MEETSUM_BOT_AUTHENTICATED`, `MEETSUM_BOT_INTERNAL_DOMAINS` | [vexa.md → Bot Google Workspace account](docs/runbooks/vexa.md#bot-google-workspace-account) |
| Vexa host | your VM, or a separate Docker host | Meeting bot and live transcript | `MEETSUM_BOT_ENABLED`, `VEXA_API_URL`, `VEXA_API_KEY`, `VEXA_WEBHOOK_SECRET`, `MEETSUM_LIVE_TRANSCRIPT` | [vexa.md → Deploy](docs/runbooks/vexa.md#deploy), `docs/runbooks/vexa-isolated-host.md` |
| Slack app | api.slack.com/apps | Recaps posted to channels | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | [integrations → Slack app](docs/runbooks/integrations.md#slack-app) |
| Microsoft Entra app | entra.microsoft.com | Outlook calendar sync | `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT`, `MS_ALLOWED_TENANTS` | [integrations → Microsoft Entra app](docs/runbooks/integrations.md#microsoft-entra-app) |
| Notion public integration | notion.so/my-integrations | Meeting pages in a database | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | [integrations → Notion](docs/runbooks/integrations.md#notion-public-integration) |
| HubSpot public app | developers.hubspot.com | Meeting engagements, notes and tasks on contacts and deals | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_OPTIONAL_SCOPES` | [integrations → HubSpot](docs/runbooks/integrations.md#hubspot-public-app) |
| SMTP or Gmail send | your mail provider, or Workspace DWD | Invitations and email recaps | `SMTP_*`, `MEETSUM_EMAIL_FROM`, `MEETSUM_EMAIL_PROVIDER` | [integrations → Email sender](docs/runbooks/integrations.md#email-sender) |
| Zoom / Teams (capture webhooks) | Zoom marketplace / Entra | Automatic import of cloud recordings | `ZOOM_*`, `AZURE_*`, `TEAMS_WEBHOOK_CLIENT_STATE` | [api-reference → Webhooks](docs/api-reference.md) |
| Sentry DSN or GlitchTip (optional) | sentry.io, or self-hosted | Server and worker error reports (scrubbed) | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | `docs/runbooks/observability.md` |

Every integration can be exercised without any of these: `npm run integrations:fake` serves fake Slack, Graph, Notion, HubSpot and Google endpoints. See [integrations → Verify with fake providers](docs/runbooks/integrations.md#verify-with-fake-providers).

## MCP server

`npm run mcp` starts a stdio [MCP](https://modelcontextprotocol.io) server (`mcp/server.mjs`) that calls the MeetSum API with one API key. Every tool sees only that key's workspace and the meetings it is allowed to see.

| Tool | Needs scope |
|---|---|
| `search_meetings`, `search_transcripts` (filters, `cursor` paging) | `read` |
| `ask` (`scope: meeting \| room \| workspace`, cited answer), `ask_meeting_memory` | `read` |
| `list_meetings`, `get_meeting`, `get_meeting_summary`, `get_transcript_segments` | `read` |
| `list_action_items`, `create_followup_draft` | `read` |
| `send_context_to_realizeos` | `write` |

Recommendation: give the MCP client its own **`read`-scope key**, and use a `write` key only if you need the RealizeOS tool. Never use an `admin` key. `MEETSUM_MCP_MAX_CHARS` (default 50000) truncates large responses.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "meetsum": {
      "command": "node",
      "args": ["/path/to/MeetSum/mcp/server.mjs"],
      "env": {
        "MEETINGS_APP_URL": "http://127.0.0.1:3000",
        "MEETSUM_API_KEY": "<read-scope key>"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add meetsum -e MEETINGS_APP_URL=http://127.0.0.1:3000 -e MEETSUM_API_KEY=<read-scope key> -- node /path/to/MeetSum/mcp/server.mjs
```

## 10. Verify the install

```bash
curl http://127.0.0.1:3000/api/health          # database, redis, storage, version
npm test                                        # offline test suite
npm run search:eval                             # Hebrew search recall (synthetic)
```

Then upload a short recording in the UI and watch it move from processing to ready: transcript, then summary, then search.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Sign-in loops back to the login page | Redirect URI mismatch, or the email isn't in `MEETSUM_ALLOWED_EMAILS` and has no invitation | Register the exact callback URL; add the email or invite it |
| Boot refuses with "placeholder secret" | `replace-with-…` values with `NODE_ENV=production` | Generate real secrets |
| Meetings stay "processing" | The worker isn't running, or Redis is unreachable | Run `npm run worker`; check `REDIS_URL` |
| Transcript is all "Speaker 1" | The ASR provider has no diarization (Groq, local Whisper) | Use RunPod, Modal or Soniox for diarization |
| Groq 429s | Free-tier daily limits | Wait, or add another provider to `MEETSUM_ASR_CHAIN` |
| Summary says "סיכום אוטומטי (ללא AI)" | No LLM key | Set `GOOGLE_GEMINI_API_KEY` (or Claude) |
| Search `mode: lexical` | No pgvector, no embedding provider, or the query embedding failed (`degraded` says which) | Use the pgvector image and run `search:vector-setup` + `search:backfill` |
| Hebrew search misses prefixed words | The database ctype isn't UTF-8, so trigrams are disabled | Recreate the database with a UTF-8 locale (M6 notes, PG17 pgvector runbook) |
| Integration "isn't configured" toast | Client id or secret missing, or a bad `MEETSUM_OAUTH_REDIRECT_BASE` | See [integrations → Troubleshooting](docs/runbooks/integrations.md#troubleshooting) |

# MeetSum

Self-hosted meeting intelligence for teams that work in Hebrew and English: record or import a meeting, get a speaker-labelled transcript, a cited summary, action items and tasks, search and chat across meetings, and push the results to the tools you already use.

MeetSum is a self-hosted alternative to Fireflies.ai. It is Hebrew-first (right-to-left UI, Hebrew-tuned speech recognition routing, Hebrew-aware search, Hebrew PDF and DOCX) and runs on your own server: Next.js, Postgres, Redis and S3-compatible storage. Feature parity with Fireflies is tracked row by row, with evidence, in [docs/parity/AUDIT.md](docs/parity/AUDIT.md).

## Status

Version 0.6.0 on `main`, with the M0–M9 parity milestones merged and M10 (hardening and the final audit) in progress. Everything listed below is built and covered by automated tests that need no keys. Features that talk to outside services (speech recognition providers, Gemini/Claude, the meeting bot, Slack/Microsoft/Notion/HubSpot) are verified offline with recorded fixtures and fake providers. Their live runs wait for your keys or accounts: [AUDIT → "Needs your keys or accounts"](docs/parity/AUDIT.md#needs-your-keys-or-accounts) lists each one, with the command to run.

Nothing in this repository has been deployed by the parity programme. The deploy path and runbooks exist, but treat a first production install as yours to verify ([docs/production-deployment.md](docs/production-deployment.md)).

## Features

Each line links the guide or runbook that covers it.

**Capture**
- Upload audio or video (streamed, resumable, idempotent), record in the browser (with an offline queue), or use the Windows desktop companion for mic plus system audio ([desktop-recorder.md](docs/desktop-recorder.md)).
- Import from Google Drive and Meet artifacts, Zoom and Teams webhooks ([google-workspace-setup.md](docs/google-workspace-setup.md)).
- Meeting bot: a Vexa sidecar joins Meet, Teams or Zoom from "Join now" or calendar rules, with consent, lobby and stop handling. A live transcript view sits behind `MEETSUM_LIVE_TRANSCRIPT` ([runbooks/vexa.md](docs/runbooks/vexa.md)).

**Transcript and player**
- ASR router with fallback and a circuit breaker: RunPod (ivrit-ai), Modal with our `asr-worker` (ivrit-ai and pyannote diarization), Soniox, or any OpenAI-compatible Whisper server, including Groq's free tier ([runbooks/free-tier-asr.md](docs/runbooks/free-tier-asr.md)).
- Speaker diarization, speaker-name suggestions and a workspace glossary.
- Waveform player with speaker lanes, range streaming, click-to-seek, a virtualized transcript, an in-transcript finder, and editing with history and undo.

**Intelligence**
- Hebrew-native summaries with citations, 11 templates plus custom ones, chapters, titles and tags (Gemini by default, Claude optional, with a heuristic fallback when no key is set).
- Action items with owners and he/en relative due dates, plus a Tasks view.
- Clips with share links, comments with mentions, reactions, follow-up email drafts and pre-meeting briefs.
- Per-meeting analytics (talk time, words per minute, questions, filler words, sentiment) and a workspace dashboard.

**Search and Ask**
- Global search: Hebrew-aware full-text plus trigram search, with pgvector hybrid search when available (`GET /api/search`, ⌘K palette).
- AskMeetSum: streaming answers with strict citations, scoped to a meeting, a room or the workspace, in private threads.

**Teams and sharing**
- Workspaces, roles (viewer, member, admin, owner), invitations, and API keys scoped `read`, `write` or `admin`.
- Meeting visibility (private, workspace, link). Private meetings fail closed everywhere: search, Ask, exports, integrations and webhooks.
- Public share links with sections, an optional password and expiry.

**Integrations and automation** ([runbooks/integrations.md](docs/runbooks/integrations.md))
- Slack, Outlook calendar (Microsoft Graph), Notion, HubSpot, Google Docs export, DOCX/PDF/Markdown export and email recaps.
- Signed webhooks (catalog v2, [docs/webhooks](docs/webhooks/README.md)), n8n templates, a CLI (`bin/meetings.mjs`), a REST API ([docs/api-reference.md](docs/api-reference.md)) and an MCP server (see below).
- RealizeOS export, approval-gated, through the same privacy gate as every other push.

**Interface**
- Hebrew (default) and English UI. Fully right-to-left in Hebrew, with logical CSS, `<bdi>` around mixed-direction names, and light and dark themes. Installable as a PWA.

## Hebrew features

Where MeetSum aims to be measurably better than Fireflies. The evidence is in [AUDIT](docs/parity/AUDIT.md#hebrew-superiority-evidence).

- **ASR routing for Hebrew:** ivrit-ai fine-tuned Whisper first (RunPod or Modal, or locally on a laptop), Soniox as the paid fallback, code-switched Hebrew/English per meeting, and glossary hotwords. Harness: `npm run asr:evaluate` (WER, CER, Latin-token WER, DER).
- **Diarization:** pyannote in the `asr-worker`, or Soniox; speaker suggestions from Meet participants and voiceprints.
- **RTL UI:** Hebrew is the default locale. Direction comes from the locale; mixed-direction runs are isolated with `<bdi>`.
- **Gender-neutral UI Hebrew:** [docs/i18n/hebrew-style.md](docs/i18n/hebrew-style.md), linted by `tests/dictionary-hebrew-lint.test.ts`.
- **Hebrew search normalizer:** niqqud, final letters, geresh and gershayim, maqaf, hyphenated prefixes (`ב-Supabase`) and prefix stripping (`תקציב` finds `והתקציב`). On the synthetic Hebrew corpus, lexical recall@5 is 0.94, against 0.28 for the old ILIKE search ([search-eval.md](docs/parity/search-eval.md)). The in-transcript finder uses the same normalizer.
- **Hebrew PDF and DOCX:** embedded IBM Plex Sans Hebrew, a bidi-correct layout (`pdftotext` shows logical order) and Hebrew file names.
- **Hebrew dates and due dates:** relative due dates such as "עד יום חמישי" or "בעוד שבועיים" resolve in the workspace time zone, and Hebrew plural rules apply in the UI.

## Stack

Next.js 16 (App Router) and React 19 · Postgres 17 (pgvector optional; without it, search runs in lexical mode) · Redis with BullMQ workers · MinIO or any S3 storage · Gemini (Developer API or Vertex AI) and optionally Claude · a Python `asr-worker` (faster-whisper, pyannote) · a Vexa sidecar for the bot · Docker Compose for dev and production.

## Quick start

The full walkthrough is [SETUP.md](SETUP.md), which starts with free-tier keys.

```bash
docker compose up -d postgres redis minio   # local services
npm ci
cp .env.example .env.local                 # then edit: localhost URLs, secrets, Google OAuth client
npm run db:migrate
npm run dev                                # http://127.0.0.1:3000 (Hebrew UI by default)
npm run worker                             # second terminal: transcription, summaries, indexing
```

## Verification

These commands need no keys:

```bash
npm run typecheck
npm run lint -- --max-warnings=0
npm test                       # vitest, offline (fixtures, PGlite, fake providers)
npm run build
npm run ds:check               # design-system guardrails
npm run bundle:check           # first-load JS budget
npm run db:schema:check        # db/schema.sql vs a fresh pg_dump (needs a migrated Postgres 17)
npm run api:reference -- --check
npm run search:eval            # Hebrew search recall table (synthetic corpus)
npm run llm:evaluate           # summary eval, replay mode
npm run asr:evaluate -- --replay tests/fixtures/asr/eval
```

CI runs `quality` (typecheck, lint, design-system check, tests, build, bundle budget) and `schema` (migrations on pgvector Postgres 17, a no-op re-run, the schema diff, and an install on plain Postgres). The browser end-to-end matrix is added in M10 (package A).

## MCP server

`npm run mcp` starts a stdio MCP server, so Claude Desktop, Claude Code or any MCP client can search and query your meetings. Setup, the tool list and a config snippet are in [SETUP.md → MCP](SETUP.md#mcp-server).

## Status table

| Area | State | Evidence |
|---|---|---|
| Parity matrix (14 rows) | see AUDIT | [docs/parity/AUDIT.md](docs/parity/AUDIT.md) |
| Milestones M0–M9 | merged (#16–#27) | [docs/parity/STATUS.md](docs/parity/STATUS.md) |
| M10 hardening | in progress | [docs/parity/m10.md](docs/parity/m10.md) |
| Live runs needing your keys | listed, with a command for each | [AUDIT → Needs your keys](docs/parity/AUDIT.md#needs-your-keys-or-accounts) |

## Documentation

Start at [docs/README.md](docs/README.md), the index of current guides. Historical plans live in `docs/archive/`.

## License

MIT; see `LICENSE`. Third-party dependencies keep their own licenses. Secrets, deployment env files, Google credentials, recordings, transcripts, summaries and meeting data are not covered by the license and must never be committed.

## Built by Realization

MeetSum is designed, built and operated by [Realization](https://realization.world). Case study: [realization.world/work/meetsum](https://realization.world/work/meetsum).

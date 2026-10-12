# MeetSum → Fireflies parity (Hebrew-superior) — review findings & orchestrated build plan

## Context
User asked: pull latest, full code review, define everything needed to make all features fully wired, then run an orchestrated multi-subagent loop until MeetSum matches Fireflies.ai quality and exceeds it in Hebrew.
Decisions made with the user: **multi-user workspaces** (no billing), **self-built/open-source meeting bot**, **branch + PR per milestone** (user merges, no prod deploys), AI stack = my research-backed recommendation (below).

Repo: `H:\MeetSum\MeetSum` (git root; the parent `H:\MeetSum` is not a repo). Local `main` = `6f9dd96`, `origin/main` = `5124c83` (+1 docs commit) → fast-forward on approval.
Health today: `tsc` clean, eslint 0 errors/5 warnings, vitest 331/332 (1 timeout: `tests/meet-artifacts-identity.test.ts`). No `next build` in CI.

## Code review — key findings (verified by 3 audit agents)
**Fake/mock UI presented as real**
- `components/audio-playback-bar.tsx` is a static mock; app has no `<audio>/<video>` at all, no media streaming endpoint.
- Fabricated durations: `meeting-header.tsx:23-30`, `meeting-inbox-panel.tsx:48-55` (`Math.max(62,…)`).
- Fabricated action-item due/priority/owner (`meeting-summary-view.tsx:312-322`); "Key quotes" = first 2 segments.
- Hardcoded sidebar rooms/user (`main-sidebar.tsx:59-65,113-124`), fake bell badge, hardcoded `info@realization.co.il` in ~13 files.
**Dead / unwired**
- API routes with no UI: api-keys, audit-logs, admin/operations, webhook stats, export/docx, export/notion (button disabled), meetings/search, meetings/timeline, intelligence(+run), speakers, sync/all, logout (no logout button!).
- Never-rendered components: `meeting-detail`, `meeting-empty-state`, `meeting-intelligence-panel`, `meeting-list`, `room-suggestion-banner`. Room page unreachable.
- 9 of 13 settings saved but never read (retention, autoProcess, aiProviderPreference, languageMode…).
- Missing endpoints: delete/rename meeting, edit transcript, stream media, delete webhook, comments/clips/chapters.
**Pipeline bugs**
- Zoom/Teams webhooks enqueue jobs that always fail (`downloadRecording` never called; `processor.ts:119-125`); no Graph subscription mgmt.
- Speaker labels fake: local Whisper → new "Speaker N" per segment (`providers.ts:355`); Gemini fallback assigns participants by index (`:286`). No diarization.
- Hebrew corruption: `/גמה/g→Gemma` without word boundary (`intelligence/index.ts:35`) breaks "דוגמה/מגמה"; `/g` regex `.test()` statefulness (`:23-29,169`); dedupe drops legit repeats ("כן").
- `processMediaJob` ignores `payload.assetId`; every retry marks meeting failed + fires failure webhook; no `UnrecoverableError`; `ai_runs` only on success with wrong model names.
- Reprocess wipes user edits to action items; ~6 statements without a transaction.
- Uploads fully buffered twice, no size/MIME limit. Desktop retry creates broken duplicate meeting (`postgres-repository.ts:996-1012`).
- Search = `ILIKE '%q%'`; memory ask passes whole question to ILIKE → almost never matches. No embeddings, no Hebrew tokenization (drops ≤2-letter tokens, no prefix stripping).
- Hebrew prompts/`policy.ts` are dead code; all prompts English. Mixed meetings forced to `he`.
**Hebrew/RTL/i18n**: only ~10 components use the dictionary; ~74 physical-direction classes; no `dir="auto"`/`<bdi>` for mixed text; PDF export uses Helvetica Type1 → Hebrew doesn't render; Hebrew titles become `-.pdf`; `/share/[token]` sits outside the only layout (`app/[locale]/layout.tsx`) → unstyled, no lang/dir; default locale `en`.
**Security/ops**: webhook URL SSRF (no private-IP block), Zoom token in query string, per-subscription webhook secret ignored, rate limiter trusts spoofable XFF with port 3005 exposed, no `.dockerignore` (copies `.env*`/.secrets into build stage), API keys unscoped, deploy.yml drifted from `scripts/deploy-vps.sh` (no migrations, parallel builds), `db/schema.sql` drift, `:latest` images, CHANGELOG missing 0.3.1–0.5.0, public repo exposes VPS IP.
**Tests**: no coverage of `processor.ts`, queue, worker, postgres SQL, webhook HTTP, Gemini parsing; no e2e.

## Fireflies parity matrix (target)
| Area | Fireflies | MeetSum now | Target milestone |
|---|---|---|---|
| Auto-join bot (Meet/Teams/Zoom) | ✓ | ✗ | M7 |
| Upload / desktop / browser rec | ✓ | ✓ (bugs) | M1 |
| Speaker diarization + names | ✓ | ✗ | M3 |
| Player + click-to-seek transcript, edit | ✓ | ✗ (mock) | M4 |
| Summaries, templates, chapters/topics | ✓ | partial | M5 |
| Action items mgmt, tasks view | ✓ | partial | M5 |
| Soundbites/clips, comments | ✓ | ✗ | M5 |
| AskFred chat + citations | ✓ | weak | M6 |
| Global semantic search | ✓ | ILIKE | M6 |
| Teams/workspaces/roles/sharing | ✓ | single-user | M2 |
| Analytics (talk time, sentiment) | ✓ | ✗ | M5/M9 |
| Integrations (Slack, CRM, Notion, Zapier, Outlook) | ✓ | webhooks/RealizeOS only | M8 |
| Live transcript | ✓ | ✗ | M7 (stretch) |
| **Hebrew** (ASR, RTL, Hebrew prompts, Hebrew search, Hebrew PDF, Hebrew dates) | weak | partial | **M3, M6, M9 — must exceed** |

## Chosen AI stack (research-backed, ~$0.15–0.25/meeting-hour)
- **Primary ASR**: keep `ivrit-ai/whisper-large-v3-turbo-ct2` (near top of ivrit.ai Hebrew leaderboard: 5.3% podcast / 7.1% WhatsApp vs 12–26% for OpenAI/Deepgram/ElevenLabs v1) but move it to **RunPod serverless GPU** (ivrit `runpod-serverless` image, `language=he`, word timestamps, per-workspace hotwords glossary) ≈ $0.03/h. Retire VPS-CPU/laptop routing (keep CPU path only as chunked ≤10-min fallback).
- **Diarization**: pyannote community-1 in the same RunPod worker, word→speaker overlap assignment (WhisperX-style) ≈ $0.02/h; upgrade path pyannoteAI Precision-3.
- **Fallback ASR**: Soniox async ($0.10/h, 4.8% podcast Hebrew, diarization included). Remove Gemini from the ASR path.
- **LLM**: provider abstraction; Gemini 3.5 Flash default summaries; add Claude — `claude-sonnet-5-5` for chat/AskMeetSum (prompt-cached transcripts), `claude-haiku-5-5` for titles/tags/extraction; Hebrew A/B eval harness (20 meetings, pairwise judge) decides summary default. Prompts in meeting language.
- **Embeddings/search**: `gemini-embedding-001` (store model name per vector) + **pgvector HNSW** on speaker-turn chunks + **pg_trgm** + `simple` FTS on a Hebrew-prefix-stripped column, fused with RRF.

## Meeting bot (research-backed)
Adopt **Vexa** (Apache-2.0, active, Meet/Teams/Zoom-web, Playwright, uses Redis/Postgres/S3→our MinIO) as a **pinned sidecar** in docker-compose — not vendored. MeetSum owns: BullMQ `bot.dispatch` (calendar auto-join rules + "Join now"), `POST /api/integrations/vexa/webhook` (Bearer secret, idempotent) → `bot.finalize` copies recording to MinIO and runs **our** ivrit+pyannote pipeline for the final transcript (Vexa live transcript only for live view). Mitigate Meet bot screening: dedicated Workspace bot account invited via calendar, "admit the bot" UI state, consent chat message. Fallback: fork ScreenApp meeting-bot (MIT). (Attendee is technically better but Elastic License 2.0 — not chosen.)

## Milestones (each = one branch `parity/mN-<slug>` + PR; stacked on the previous branch if unmerged)
**M0 Baseline & honesty** — fast-forward `main`; fix flaky test timeout; add `next build` + strict lint to CI; `.dockerignore`; root layout fix for `/share/[token]`; remove all fake data (durations from media/segment metadata, mock player hidden until M4, no invented due dates/priorities, sidebar from real rooms/session user); remove hardcoded admin email (use session/`GOOGLE_WORKSPACE_SUBJECT`); logout button; env vars documented in `.env.example`; CHANGELOG backfill.
**M1 Pipeline correctness & security** — use `payload.assetId`; `UnrecoverableError` for permanent failures; mark failed only on final attempt; `ai_runs` on failure with real model; transactional intelligence upsert that preserves user-edited action items; streaming uploads (S3 multipart) with size/MIME limits; desktop ingest idempotency by captureId scoped per meeting; Hebrew regex fixes (word boundaries, no `/g` with `.test`, dedupe only adjacent identical); Zoom/Teams: call `downloadRecording` (header auth, prefer audio file), Graph subscription create/renew job; webhook SSRF guard, per-subscription secrets, BullMQ-based delivery with retries; rate-limit trusted-proxy config; processor/queue tests with mocked repo.
**M2 Multi-user workspaces** — tables `users`(reuse), `workspaces`, `memberships(role: owner/admin/member/viewer)`, `invitations`; `workspace_id` on meetings/contexts/webhooks/api_keys/settings/etc. with backfill migration; meeting visibility (private/workspace/link); `requireAppAccess` → workspace-scoped authz helper used by every route; invite flow (Gmail send or SMTP) replacing email allowlist (keep allowlist as bootstrap); API keys scoped to workspace + admin UI; audit-log UI; settings that actually take effect (wire all 9 dead settings or delete them).
**M3 Hebrew ASR + diarization** — `lib/ai/asr/` provider interface (`runpod-ivrit`, `soniox`, `local-whisper` chunked, `gemini` legacy); RunPod worker definition in repo (`asr-worker/`: faster-whisper ivrit + pyannote community-1 + word-speaker merge); schema: `transcript_words` (or `words jsonb` on segments) with ms timings + speaker; speaker turns; glossary/hotwords per workspace; speaker→participant mapping auto-suggest from calendar attendees + Meet artifacts, user confirm, remembered per workspace; extend `scripts/evaluate-hebrew-asr.ts` to compare providers on our own code-switched clips (WER + DER) and record results in `docs/parity/asr-eval.md`.
**M3.5 Design system (Cadence v2.0)** — merge `design/system-v2`; phase 1 tokens (tokens.css into globals.css, IBM Plex Sans/Hebrew/Mono via next/font, drop 14px root, codemod legacy var classes to registered utilities); phase 2 primitives (components/ui restyle incl. `ai`/`record` button variants, meeting atoms into components/ui, lib/motion.ts, Σ logo, CitedMark). Phase 3 surfaces are built inside M4–M7; phase 4 (`design-system/check.mjs --strict` CI ratchet + he/en × light/dark screenshots) in M9. Rules: README §7–10 (dir from known language, RLM/word-joiner in Hebrew strings, never mirror time axis, iris only for AI content, one primary action, no citation no claim, status pills only for exceptions).
**M4 Player & transcript UX** — `GET /api/meetings/[id]/media` (range requests / presigned MinIO URL); real audio/video player replacing mock; click-to-seek on segments/words/citations/action items; active-segment highlight + auto-scroll; search-in-transcript with highlight; transcript editing (segment text + speaker rename/merge) with `PATCH` endpoints; talk-time per speaker; `dir="auto"`/`<bdi>` bidi; virtualized list; delete/rename meeting endpoints + UI; real duration everywhere.
**M5 Intelligence parity** — summaries in meeting language with Hebrew-native prompts (revive `lib/ai/policy.ts`); chapters/topics with timestamps; summary templates/"AI apps" (sales, standup, interview, 1:1, Hebrew business); custom notes; action-item editor (owner picker, due date with Hebrew/English relative-date parsing, priority) + cross-meeting Tasks view; soundbites/clips (time-range + share); comments/reactions on transcript; per-speaker sentiment & questions stats; Claude provider + Hebrew A/B eval harness.
**M6 Search & AskMeetSum** — pgvector + pg_trgm migration (Postgres image with pgvector); chunking by speaker turns; embedding job on `meeting.index` (fix: it currently re-transcribes); Hebrew prefix-stripping normalizer shared by indexer and query; hybrid RRF search API + UI with filters (date, people, room, tags, language); chat with history, streaming, citations with click-to-seek, scopes (meeting / room / all); MCP server updated (pagination, search route, new tools) + tests.
**M7 Meeting bot** — Vexa sidecar compose profile (pinned version, MinIO bucket, own DB schema); `bot_sessions` table; dispatch from calendar rules (auto-join all / external-only / manual) and "Join now" URL paste; webhook + finalize; bot status UI (joining / awaiting admission / recording / done / blocked) ; consent message; live transcript view via SSE (stretch, behind flag).
**M8 Integrations** — Slack (OAuth app, post recap to channel, per-workspace rules); Outlook/Microsoft 365 calendar (Graph OAuth) for bot scheduling; Notion OAuth + chunked blocks (2000-char limit); HubSpot (log meeting note + tasks to contact/deal); email recap to attendees after processing; Google Docs export; DOCX export button; webhook event catalog for Zapier/n8n with retries.
**M9 i18n/RTL & polish** — full `he`/`en` dictionary coverage (move all hardcoded strings; keep pt/es/it only if complete), default locale `he` with Accept-Language; logical CSS properties everywhere; Hebrew-capable PDF (`@react-pdf/renderer` or pdfkit with embedded Noto Sans Hebrew, RTL shaping) + Unicode-safe filenames; share page localized/themed; panel URL routing (deep links/back button); shadcn Dialogs replacing hand-built modals + `window.prompt/confirm`; loading/error/empty states, `loading.tsx/error.tsx/not-found.tsx`; PWA manifest/service worker for recorder; analytics dashboard (meetings, hours, talk-time, topics trend); in-app notifications (replace fake bell); onboarding wizard.
**M10 Hardening** — Playwright e2e (upload→transcript→summary→ask→share, bot webhook simulation) run via `agent-browser`/preview; pino logging + Sentry; deploy.yml aligned with `scripts/deploy-vps.sh` (migrations, serialized builds); pinned image tags; `db/schema.sql` regenerated; docs (README, SETUP, API) truthful; final parity audit vs matrix.

## Orchestration loop (how I'll run it)
State file: `docs/parity/STATUS.md` (parity matrix + milestone checklist + open issues), updated every iteration.
Per milestone:
1. **Spec** — one Plan agent turns the milestone into a task list with disjoint file ownership → `docs/parity/mN.md`.
2. **Build** — 2–4 implementer subagents in parallel, each in an isolated git worktree on a sub-branch, TDD (`superpowers:test-driven-development`); I merge sub-branches into `parity/mN-*`.
3. **Review** — `feature-dev:code-reviewer` + a Hebrew/RTL-focused reviewer on the diff; fix findings.
4. **Verify** — `npm run typecheck && npm run lint && npm test && npm run build`; for UI milestones run the app (`npm run dev` via preview tools, Postgres/Redis/MinIO via `docker-compose.yml`) and drive the flow in the browser, including `he` locale; for pipeline milestones run the worker against a short Hebrew sample.
5. **Ship** — push branch, open PR (body ends with Claude Code attribution), bind via ccd_pr; update STATUS.md; continue to next milestone (stacked branch) without waiting for merge. Multi-agent runs may use the Workflow tool (≤10 agents each).
Stop condition: every parity-matrix row ✓ with verification evidence, Hebrew rows demonstrably better (ASR WER table, RTL screenshots, Hebrew PDF, Hebrew search recall), all tests/build green.

## External inputs needed from you (loop pauses on the milestone that needs them; work proceeds elsewhere)
- M3: RunPod API key + endpoint (or OK to create), Hugging Face token (pyannote gated model), Soniox API key, a few consented Hebrew/code-switched sample recordings for eval.
- M5/M6: Anthropic API key (Claude); confirm Gemini key has embedding access.
- M2: SMTP or Gmail-send scope approval for invites.
- M7: a dedicated Google Workspace bot account (e.g. `notetaker@realization.co.il`).
- M8: Slack app, Microsoft Entra app (Graph), Notion integration, HubSpot app credentials.
Secrets go only into `.env.local` (never committed); I won't enter credentials into web UIs.

## Verification (end-to-end)
- Automated: `npm run typecheck`, `npm run lint` (errors fail), `npm test`, `npm run build`, new Playwright e2e suite.
- Manual-in-browser per UI milestone (preview tools): upload a Hebrew sample → diarized transcript with names, player seek works, summary in Hebrew, ask with citations, share page RTL, Hebrew PDF opens correctly.
- Pipeline: worker processes Zoom/Teams webhook fixture end-to-end; bot webhook fixture → finalize → transcript.
- ASR quality: `npm run asr:evaluate` comparison table committed to `docs/parity/asr-eval.md`.

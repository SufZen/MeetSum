# Fireflies parity — status

Plan: [PLAN.md](PLAN.md). One branch + PR per milestone (`parity/mN-*`), stacked when the previous PR is not yet merged.

## Milestones
| # | Milestone | Branch | State | PR |
|---|---|---|---|---|
| M0 | Baseline & honesty | `parity/m0-baseline` | merged | #16 |
| M1 | Pipeline correctness & security | `parity/m1-pipeline` | merged | #17 |
| M2 | Multi-user workspaces | `parity/m2-workspaces` | merged | #18 |
| M3.5 | Design system (Cadence v2.0, tokens + primitives) | `parity/m3_5-design` | merged | #19 |
| M3 | Hebrew ASR + diarization | `parity/m3-asr` | merged (live run needs RunPod/HF/Soniox or the free-tier Groq key, #22) | #20 |
| M4 | Player & transcript UX | `parity/m4-player` | merged | #21 |
| M5 | Intelligence parity | `parity/m5-intelligence` | merged (live summary eval needs a Gemini key) | #24 |
| M6 | Search & AskMeetSum | `parity/m6-search` | merged (hybrid/vector mode needs the pgvector image and a Gemini key) | #25 |
| M7 | Meeting bot (Vexa sidecar) | `parity/m7-bot` | merged (live run needs a Vexa host and a bot Google account) | #23 |
| M8 | Integrations | `parity/m8-integrations` | Step 0 done ([m8.md](m8.md); migration 027, frozen contracts, stubs); packages A–D next; live runs need Slack/Entra/Notion/HubSpot apps, see the runbook checklist | — |
| M9 | i18n/RTL & polish | `parity/m9-polish` | todo | — |
| M10 | Hardening & final audit | `parity/m10-hardening` | todo | — |

## Parity matrix
| Area | Fireflies | MeetSum | Milestone |
|---|---|---|---|
| Auto-join bot (Meet/Teams/Zoom) | ✓ | ✓ Vexa sidecar, Join now + calendar rules, consent, lobby/stop lifecycle | M7 ✅ |
| Upload / desktop / browser recording | ✓ | ✓ (streaming, idempotent; Zoom/Teams wired) | M1 ✅ |
| Speaker diarization + names | ✓ | built (pyannote worker + Soniox fallback, speaker suggestions); needs keys for live | M3 ✅ (code) |
| Player + click-to-seek transcript, editing | ✓ | ✓ waveform, speaker lanes, range streaming, virtualized transcript, edit/undo | M4 ✅ |
| Summaries, templates, chapters/topics | ✓ | ✓ Hebrew-native, cited, 11 templates + custom, chapters | M5 ✅ |
| Action items mgmt, tasks view | ✓ | ✓ owners, he/en relative due dates, Tasks view | M5 ✅ |
| Soundbites/clips, comments | ✓ | ✓ clips + share, comments, reactions | M5 ✅ |
| Chat over meetings with citations | ✓ | ✓ streaming Ask, strict citations, private threads | M6 ✅ |
| Global semantic search | ✓ | ✓ hybrid vector+FTS+trigram, Hebrew normalizer (recall@5 0.94 lexical) | M6 ✅ |
| Teams/workspaces/roles/sharing | ✓ | workspaces, roles, invites, scoped API keys, visibility | M2 ✅ |
| Analytics | ✓ | per-meeting talk time/WPM/questions/fillers/sentiment; dashboard pending | M5 ✅ / M9 |
| Integrations (Slack, CRM, Notion, Zapier, Outlook) | ✓ | webhooks/RealizeOS | M8 |
| Live transcript | ✓ | ✗ | M7 (stretch) |
| Hebrew ASR, RTL, prompts, search, PDF, dates | weak | partial | M3/M6/M9 |

## Open external inputs
- RunPod API key, Hugging Face token (pyannote), Soniox key, consented Hebrew sample recordings (M3)
- Anthropic API key (M5/M6)
- SMTP or Gmail-send approval for invites (M2)
- Google Workspace bot account (M7)
- Slack / Microsoft Entra / Notion / HubSpot app credentials (M8)

## Log
- 2026-10-12: review complete, plan approved, `main` fast-forwarded to `5124c83`, M0 started.
- 2026-10-12: M0 PR #16 (378 tests). M1 PR #17 (718 tests, 2 security reviews, Zoom signing-oracle fix). Known: db/schema.sql stale (M10); no live Postgres/Redis/MinIO run yet.
- 2026-10-13: M2 PR #18 (1417 tests; 3 security reviews; live-verified on real Postgres 18: migrations, bootstrap, invites, scoped keys, cross-workspace 404s). User approved inserting M3.5 design system (Cadence v2.0) before M4; order M2 → M3.5 → M3 → M4. Design rules: paragraph dir from segment language, fallback meeting language; dir=auto only for unknown-language text.
- 2026-10-13: Session crash recovered (no work lost). M3.5 PR #19 (check.mjs 710→65; signed-in he/en light/dark check on real Postgres; one-primary-action fix). M3 stubs committed (65ea7df, migration 020); 3 M3 packages running. Worktree cleanup accidentally emptied shared node_modules → reinstalled via npm ci; agents now use per-worktree npm ci (no junctions).
- 2026-10-13: M3 PR #20 (1760 tests + 31 worker pytest; router RunPod-ivrit → Soniox → chunked local; words jsonb; speaker entities + suggestions; Hebrew-safe WER/DER eval; 2 security fixes: error redaction incl. breaker, Meet display-name spoofing). Migration 020 applied on real Postgres. Root cause of node_modules wipe found: Next standalone junctions inside worktree .next.
- 2026-10-13: M4 PR #21 (2186 tests; real browser e2e on Postgres 18 + local S3 + ffmpeg with a he/en code-switched recording: prepare→peaks, 206 range streaming, play/pause, he RTL with LTR time axis, per-segment dir + bdi, click-to-seek + live region). Found+fixed transcript-zero-rows layout bug and bundle overrun (lazy loading). Specs m7–m9 written; user chose he+en only UI for M9.
- 2026-10-13: M6 spec rewritten for the M5 LLM layer (Gemini default, Claude optional). Migration 025: pg_trgm required, pgvector 0.8 optional with lexical fallback and capability detection. Image `pgvector/pgvector:0.8.1-pg17`, the same major version (no downgrade). Vectors store their model and dimensions. Chunks are speaker turns of at most 800 tokens. One Hebrew normalizer is shared by indexing and queries. RRF ranking runs after the visibility filter. Ask streams over SSE with strict citations and per-user threads. Also: MCP pagination, search and ask; a synthetic Hebrew eval with replay. Packages: A index, B search+MCP, C ask, D UI. Migration numbers: M7 is 024, M6 025, M8 026, M9 027.
- 2026-10-13: M6 Step 0 done on `parity/m6-search`: migration 025 (applied on the embedded PG 18 without pgvector: lexical path, NOTICE, no vector objects), compose on `pgvector/pgvector:0.8.1-pg17`, M8/M9 specs renumbered to 026/027 with a duplicate-version test (024 reserved for M7), frozen contract types, A–D stubs, real `requestMeetingReindex` plus call sites, 501 route stubs behind `withAuthz` with authz coverage, full `.env.example` block. Typecheck, lint and tests green.
- 2026-10-13: M6 review fixes (branch `m6-review-fixes`): new migration **026_ask_usage.sql** (durable Ask daily-cap counter), so M8 is renumbered to **027** and M9 to **028** (m8.md/m9.md updated; the migrations test asserts 001-026 contiguous).
- 2026-10-13: M0–M7 merged to main (#16–#25, including the free-tier ASR PR #22). Production deploy stayed gated (`DEPLOY_ENABLED` unset). M8 started on `parity/m8-integrations`.
- 2026-10-13: M8 spec refreshed against `main` (m8.md): migration 027 adds `integration_links` (re-export updates, no duplicates) and `meeting_integration_prefs` (owner opt-in for private meetings, per-meeting email recap); Outlook calendar dedupes with Google by iCalUID so one meeting gets one M7 bot session; webhook catalog v2 (new events, timestamped signature, v1 frozen); packages A core+Slack+email, B Microsoft+HubSpot, C Notion+Docs+DOCX+catalog, D settings UI+i18n+runbook+fake-provider e2e.
- 2026-10-13: M8 Step 0 done on `parity/m8-integrations`: migration **027_integrations.sql** (applied cleanly on the embedded smoke Postgres; versions 001–027 contiguous; `db/schema.sql` mirrors it), frozen contracts (`lib/integrations/core/types.ts`, `lib/platform/event-catalog.ts`, i18n key lists, `.env.example` block), real `bidi`/`recap` helpers, row-bound AES-GCM secrets (v2 with AAD and an HKDF purpose key; a bound field refuses v1 unless it opts in for migration), the member-level `integrations:connect` permission, audit actions, rate-limit presets, no-op stubs with one-line call sites, 17 route stubs (501) behind their final guards with route coverage (the Notion export lost its token-in-body path and admin check), and UI mount points. Defaults kept: `summary.created` (no rename), Slack `chat:write.public` (override with `SLACK_SCOPES`), email recap members-only and off by default, owner-only private opt-ins, re-export updates in place, at most one automatic post per rule/meeting/event; Slack slash command and Graph push stay stretch. Typecheck, lint and tests green.
- 2026-10-13: M8 Integration step: new migration **028_integration_token_generation.sql** (`integration_connections.token_generation` replaces `config._gen`, which it carries over and strips), so M9 is renumbered to **029** (m9.md updated; the migrations test asserts 001-028 contiguous).
- 2026-10-13: M8 review fixes (branch `m8-review-fixes`): new migration **029_integration_refresh_lease.sql** (`integration_connections.refresh_lease_until`: token refresh takes a short lease instead of holding a row lock across the provider call), so M9 is renumbered to **030** (m9.md updated; the migrations test asserts 001-029 contiguous).

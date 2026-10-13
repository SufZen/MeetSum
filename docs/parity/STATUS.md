# Fireflies parity — status

Plan: [PLAN.md](PLAN.md). One branch + PR per milestone (`parity/mN-*`), stacked when the previous PR is not yet merged.

## Milestones
| # | Milestone | Branch | State | PR |
|---|---|---|---|---|
| M0 | Baseline & honesty | `parity/m0-baseline` | PR open | #16 |
| M1 | Pipeline correctness & security | `parity/m1-pipeline` | PR open (stacked on #16) | #17 |
| M2 | Multi-user workspaces | `parity/m2-workspaces` | PR open (stacked on #17) | #18 |
| M3.5 | Design system (Cadence v2.0, tokens + primitives) | `parity/m3_5-design` | PR open (stacked on #18) | #19 |
| M3 | Hebrew ASR + diarization | `parity/m3-asr` | PR open (stacked on #19; live run needs RunPod/HF/Soniox keys) | #20 |
| M4 | Player & transcript UX | `parity/m4-player` | PR open (stacked on #20) | #21 |
| M5 | Intelligence parity | `parity/m5-intelligence` | todo (Claude key) | — |
| M6 | Search & AskMeetSum | `parity/m6-search` | spec ready ([m6.md](m6.md); migration 025, pgvector optional with lexical fallback, PG17 kept) | — |
| M7 | Meeting bot (Vexa sidecar) | `parity/m7-bot` | todo (bot Google account) | — |
| M8 | Integrations | `parity/m8-integrations` | todo (Slack/Graph/Notion/HubSpot apps) | — |
| M9 | i18n/RTL & polish | `parity/m9-polish` | todo | — |
| M10 | Hardening & final audit | `parity/m10-hardening` | todo | — |

## Parity matrix
| Area | Fireflies | MeetSum | Milestone |
|---|---|---|---|
| Auto-join bot (Meet/Teams/Zoom) | ✓ | ✗ | M7 |
| Upload / desktop / browser recording | ✓ | ✓ (streaming, idempotent; Zoom/Teams wired) | M1 ✅ |
| Speaker diarization + names | ✓ | built (pyannote worker + Soniox fallback, speaker suggestions); needs keys for live | M3 ✅ (code) |
| Player + click-to-seek transcript, editing | ✓ | ✓ waveform, speaker lanes, range streaming, virtualized transcript, edit/undo | M4 ✅ |
| Summaries, templates, chapters/topics | ✓ | partial | M5 |
| Action items mgmt, tasks view | ✓ | partial | M5 |
| Soundbites/clips, comments | ✓ | ✗ | M5 |
| Chat over meetings with citations | ✓ | weak | M6 |
| Global semantic search | ✓ | ILIKE | M6 |
| Teams/workspaces/roles/sharing | ✓ | workspaces, roles, invites, scoped API keys, visibility | M2 ✅ |
| Analytics | ✓ | ✗ | M5/M9 |
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

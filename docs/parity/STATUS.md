# Fireflies parity — status

Plan: [PLAN.md](PLAN.md). One branch + PR per milestone (`parity/mN-*`), stacked when the previous PR is not yet merged.

## Milestones
| # | Milestone | Branch | State | PR |
|---|---|---|---|---|
| M0 | Baseline & honesty | `parity/m0-baseline` | PR open | #16 |
| M1 | Pipeline correctness & security | `parity/m1-pipeline` | PR open (stacked on #16) | #17 |
| M2 | Multi-user workspaces | `parity/m2-workspaces` | PR open (stacked on #17) | #18 |
| M3.5 | Design system (Cadence v2.0, tokens + primitives) | `parity/m3_5-design` | PR open (stacked on #18) | #19 |
| M3 | Hebrew ASR + diarization | `parity/m3-asr` | in progress (stacked on M3.5; builds on mocks, live run needs RunPod/HF/Soniox keys) | — |
| M4 | Player & transcript UX | `parity/m4-player` | todo | — |
| M5 | Intelligence parity | `parity/m5-intelligence` | todo (Claude key) | — |
| M6 | Search & AskMeetSum | `parity/m6-search` | todo | — |
| M7 | Meeting bot (Vexa sidecar) | `parity/m7-bot` | todo (bot Google account) | — |
| M8 | Integrations | `parity/m8-integrations` | todo (Slack/Graph/Notion/HubSpot apps) | — |
| M9 | i18n/RTL & polish | `parity/m9-polish` | todo | — |
| M10 | Hardening & final audit | `parity/m10-hardening` | todo | — |

## Parity matrix
| Area | Fireflies | MeetSum | Milestone |
|---|---|---|---|
| Auto-join bot (Meet/Teams/Zoom) | ✓ | ✗ | M7 |
| Upload / desktop / browser recording | ✓ | ✓ (streaming, idempotent; Zoom/Teams wired) | M1 ✅ |
| Speaker diarization + names | ✓ | ✗ | M3 |
| Player + click-to-seek transcript, editing | ✓ | ✗ (mock) | M4 |
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

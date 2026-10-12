# Fireflies parity — status

Plan: [PLAN.md](PLAN.md). One branch + PR per milestone (`parity/mN-*`), stacked when the previous PR is not yet merged.

## Milestones
| # | Milestone | Branch | State | PR |
|---|---|---|---|---|
| M0 | Baseline & honesty | `parity/m0-baseline` | PR open | #16 |
| M1 | Pipeline correctness & security | `parity/m1-pipeline` | PR open (stacked on #16) | #17 |
| M2 | Multi-user workspaces | `parity/m2-workspaces` | in progress (spec: m2.md) | — |
| M3 | Hebrew ASR + diarization | `parity/m3-asr` | todo (needs RunPod/HF/Soniox keys) | — |
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
| Teams/workspaces/roles/sharing | ✓ | single-user | M2 |
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

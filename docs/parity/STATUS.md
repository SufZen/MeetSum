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
| M8 | Integrations | `parity/m8-integrations` | merged (live runs need Slack/Graph/Notion/HubSpot apps) | #26 |
| M9 | i18n/RTL & polish | `parity/m9-polish` | merged (e2e in CI, `ds:check --strict` and the 300 KB budget moved to M10) | #27 |
| M10 | Hardening & final audit | `parity/m10-hardening` | spec ready ([m10.md](m10.md)) | — |

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
| Integrations (Slack, CRM, Notion, Zapier, Outlook) | ✓ | ✓ Slack, Outlook calendar, Notion, HubSpot, Google Docs, DOCX, email recap, webhook catalog v2 (fixture/fake-provider tested; live runs need the apps) | M8 ✅ (code) |
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
- 2026-10-13: M8 merged to main (#26). M9 spec refreshed against `main` `125a432` (m9.md): pt/es/it removed in Step 0 (he default, Accept-Language on every path), migration **030** (user locale/zone/preferences, notification dedupe/links, onboarding progress, `meeting_shares.password_hash`, revision `edit_group_id`), fail-closed visibility fix in Step 0 (`processor.ts:258` and read paths). Baselines: 329 hardcoded strings in 29 files (AST scan), `check.mjs` 52, `/[locale]` 408.7 KB gz (budget 300). Fonts self-hosted in M9 (shared with the PDF). Packages: A i18n core + locale + Settings shell + content sweep, B PDF/exports/fonts/share + M4 carry-overs, C notifications/analytics/onboarding + e2e, D routing/dialogs/segment states/PWA/bundle.
- 2026-10-13: M9 Step 0 done on `parity/m9-polish`: migration **030_i18n_notifications_onboarding.sql** (applied on the embedded smoke Postgres; 001–030 contiguous; `db/schema.sql` mirrors it); pt/es/it removed (he default via `MEETSUM_DEFAULT_LOCALE`, legacy prefixes 308, stored legacy locales read as he); i18n plumbing (`getRequestI18n`, `I18nProvider`/`useI18n`/`useNow`, minimal `format.ts`/`hebrew-text.ts`, nine `lib/i18n/m9/*` modules with key/plural parity tests); frozen contracts (notification kinds and DTO, notify stubs at their call sites, analytics/onboarding types, `shell-url`, user preferences); real `ConfirmDialog`/`PromptDialog`; share dialog moved verbatim to `components/share/`; mount-point and 501 route stubs behind their final guards; fail-closed visibility on platform events and read paths. Ratchets: `check.mjs --baseline` (97 incl. 4 new rules), hardcoded strings 331/32 files, static a11y 8/7 files, bundle `/[locale]` 413.9 KB gz (the method reproduces M8's 408.7 with polyfills; budget 300 is a `--strict` target). Plex npm packages skipped (no TTF, telemetry postinstall): B vendors the fonts. Screenshots are never committed (gitignored `test-results/m9-screenshots/`). Typecheck, lint and 4933 tests green.
- 2026-10-13: M9 Integration on `parity/m9-polish` (A → B → C → D merged): scanners strict at 0 (baselines deleted), `check.mjs` 97 → 17 (shadcn side classes and recharts selectors left), shell section/adminTab/tab through `useShellUrl`, settings PATCH keeps the user locale cookie, mutes round-trip on Postgres, A's zone in PDF and share, `/[locale]/invite/accept?id=` (404 like the API), server modules return codes (gendered Hebrew stage titles gone), offline recordings attach to their meeting via `targetMeetingId`, `.gitattributes` LF for `*.mjs`/`*.sh`. Build without Google Fonts; standalone has `assets/fonts/ttf`. Bundle `/[locale]` 393.9 KB gz (budget 300, gap 93.9), share 236.9 (220). Typecheck, lint, 5294 tests, build, `ds:check`, `bundle:check` green. Open: e2e + screenshots on local Postgres, Hebrew PDF check, notify spies, `m9-isolation` and `sw-private-data` tests.
- 2026-10-14: M9 merged to main (#27; 5381 tests, migrations 030–031, `/[locale]` 396.1 KB gz). M10 spec written (m10.md) on `parity/m10-hardening` from `53353d8`: migration **032** drops the legacy `integration_endpoints`; packages A e2e in CI (matrix core/m6/m8/m9/m9-prod on pgvector + Redis + MinIO, fake ASR, structured LLM replay, no secrets, artifacts only), B observability/health/Redis rate limiter/deploy (pino + optional server-only Sentry, live/ready for app and worker, one-build deploy with migrate-before-switch and rollback, digest pins, PG17 pgvector and Vexa isolated-host runbooks, env matrix), C bundle diet (≤ 300 KB, fallback ≤ 320 with analysis) and `ds:check --strict`, D docs, generated `db/schema.sql` with a CI diff, remaining-risk fixes and `AUDIT.md`. Merge order B → A → C → D.

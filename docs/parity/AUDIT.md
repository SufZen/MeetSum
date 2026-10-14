# Final parity audit: MeetSum vs Fireflies.ai (M10)

**Date:** 2026-10-14 · **Tree:** `parity/m10-hardening` plus package D (`m10-d-docs-audit`) · **Spec:** [m10.md](m10.md), "Final parity audit (D)"

This audit scores every row of the [STATUS](STATUS.md) parity matrix. The rule: **no row is ✓ without evidence a reviewer can rerun without keys.** Where behaviour depends on an outside service, the evidence is offline (recorded fixtures, fake providers, PGlite, replay), and the live run is listed under [Needs your keys or accounts](#needs-your-keys-or-accounts) with its exact command.

> **Pending the Integration CI run.** The browser e2e matrix (`core`, `m6`, `m8`, `m9`, `m9-prod`; package A) and its artifacts (`test-results/**` screenshots and `a11y-report.json`, `playwright-report/**`, `e2e-logs/**`, the Hebrew PDF sample) do not exist on this branch yet. Every reference to "CI artifact" below names the e2e spec and step that produces it. The orchestrator adds the run link at Integration (m10.md, Integration step 6). Until then, the e2e specs are evidence of *coverage*, not of a green run. The last recorded local runs were before the M9 fixes ("Playwright polish 5/8, screenshots 53/64").

> **Pipeline wiring vs quality.** Fake ASR, structured LLM replay and fake providers prove that the pipeline is wired. They say nothing about transcription or summary quality. Quality evidence comes only from the eval tables, and the live ones are deferred.

## Legend

**Status**
- **✓**: built and verified by rerunnable offline evidence. Nothing material is missing compared with Fireflies.
- **✓ offline**: built and verified offline. The live run needs your keys or accounts (listed at the end).
- **partial**: built, but a capability Fireflies documents is missing, or the evidence is thin.
- **✗**: not built.

**Rubric scores (0–3)**, for completeness, quality, Hebrew and verifiability:
- 0: missing
- 1: partial
- 2: parity
- 3: better, with the reason given

A "3" for Hebrew means MeetSum ships a Hebrew-specific capability that Fireflies does not document. It is backed by a MeetSum measurement or test where one exists. **No head-to-head with Fireflies has been run.** That needs your Fireflies account (see [Needs your keys](#needs-your-keys-or-accounts)).

**Fireflies capability column:** taken from Fireflies' public pages, checked 2026-10-14:
- [guide.fireflies.ai supported languages](https://guide.fireflies.ai/articles/2973706448-learn-about-fireflies-supported-languages): 100+ languages, including Hebrew (`he`).
- [Multi-Language Mode (beta)](https://guide.fireflies.ai/articles/2585231364-transcribe-fireflies-meetings-in-multiple-languages-with-multi-language-mode-beta?lang=en).
- [Real-time notes launch post](https://fireflies.ai/blog/fireflies-ai-launches-real-time-meeting-notes/).
- Fireflies' product pages for AskFred, Soundbites and integrations.

Third-party reviews were used only where Fireflies' own pages are silent, and are marked as such.

**PRs:** M0 [#16](https://github.com/SufZen/MeetSum/pull/16), M1 [#17](https://github.com/SufZen/MeetSum/pull/17), M2 [#18](https://github.com/SufZen/MeetSum/pull/18), M3.5 [#19](https://github.com/SufZen/MeetSum/pull/19), M3 [#20](https://github.com/SufZen/MeetSum/pull/20), free-tier ASR [#22](https://github.com/SufZen/MeetSum/pull/22), M4 [#21](https://github.com/SufZen/MeetSum/pull/21), M7 [#23](https://github.com/SufZen/MeetSum/pull/23), M5 [#24](https://github.com/SufZen/MeetSum/pull/24), M6 [#25](https://github.com/SufZen/MeetSum/pull/25), M8 [#26](https://github.com/SufZen/MeetSum/pull/26), M9 [#27](https://github.com/SufZen/MeetSum/pull/27).

## Summary

| Row | Status | C | Q | He | V | Live verification |
|---|---|---|---|---|---|---|
| Auto-join bot (Meet/Teams/Zoom) | ✓ offline | 2 | 2 | 2 | 2 | deferred: Vexa host + bot account |
| Upload / desktop / browser recording | ✓ | 2 | 2 | 2 | 3 | done offline (no outside service) |
| Speaker diarization + names | ✓ offline | 2 | 1 | 2 | 2 | deferred: RunPod/HF/Soniox keys + clips |
| Player + click-to-seek transcript, editing | ✓ | 3 | 2 | 3 | 3 | done offline |
| Summaries, templates, chapters/topics | ✓ offline | 2 | 1 | 2 | 2 | deferred: Gemini key (Claude optional) |
| Action items mgmt, tasks view | ✓ | 2 | 2 | 3 | 3 | done offline (extraction quality rides on the summary eval) |
| Soundbites/clips, comments | partial | 1 | 2 | 2 | 3 | done offline |
| Chat over meetings with citations | ✓ offline | 2 | 2 | 2 | 2 | deferred: Gemini key |
| Global semantic search | ✓ offline | 2 | 2 | 3 | 3 | lexical done offline; hybrid deferred: Gemini key + pgvector |
| Teams/workspaces/roles/sharing | partial | 1 | 2 | 2 | 3 | done offline |
| Analytics | partial | 1 | 2 | 2 | 3 | done offline |
| Integrations (Slack, CRM, Notion, Zapier, Outlook) | ✓ offline | 1 | 2 | 2 | 2 | deferred: Slack/Entra/Notion/HubSpot apps |
| Live transcript | partial | 1 | 1 | 2 | 2 | deferred: Vexa host |
| Hebrew ASR, RTL, prompts, search, PDF, dates | ✓ offline | 3 | 2 | 3 | 2 | ASR WER and live summaries deferred (keys) |

C = completeness, Q = quality, He = Hebrew, V = verifiability. Totals: **4 ✓, 6 ✓ offline, 4 partial, 0 ✗.**

**Proposed STATUS corrections** (the orchestrator applies them):
- **Live transcript:** "✓ behind `MEETSUM_LIVE_TRANSCRIPT` (M7 B8); live run needs Vexa". This audit scores it *partial*, because Fireflies also has live notes and in-meeting AskFred.
- **Hebrew:** "✓ better where measured (search recall, normalizer, RTL, PDF, dates); ASR WER pending keys".
- **Analytics:** the M9 dashboard has landed. Drop "dashboard pending".

---

## Rows

### Auto-join bot (Meet/Teams/Zoom)
- **Fireflies:** "Fred" joins Zoom, Google Meet, Teams and Webex from calendar auto-join or an invite. Recording settings live per user and per team.
- **MeetSum on main:** a Vexa sidecar handles "Join now" and calendar rules (Google and Outlook), the consent message, the lobby and admission timeout, stop, finalize and retention. It reports status from requested through recording to done, with signed webhooks verified and deduplicated. Meet, Teams and Zoom are supported; Webex is not.
- **Evidence:**
  - Tests: `tests/bot-lifecycle.test.ts`, `tests/bot-dispatch.test.ts`, `tests/bot-join-now-dispatch.test.ts`, `tests/bot-finalize.test.ts`, `tests/bot-consent.test.ts`, `tests/bot-reconcile.test.ts`, `tests/bot-rules.test.ts`, `tests/vexa-webhook-verify.test.ts`, `tests/vexa-webhook-route.test.ts`, `tests/vexa-client.test.ts`, `tests/calendar-bot-sync.test.ts`, `tests/ms-outlook-bot-rules.test.ts`.
  - Simulator: `npm run bot:simulate -- --fake-vexa`.
  - E2E (package A): `m10-bot` spec in the `core` job (status walk, replayed webhook, bad signature returns 401). CI artifact pending.
- **Scores:**
  - C 2 (no Webex).
  - Q 2 (lifecycle fully tested; never run against real Vexa 0.12.28).
  - He 2 (Hebrew consent text and RTL status UI).
  - V 2 (offline only).
- **Live:** deferred. Needs a Vexa host or VM and a Google Workspace bot account (R3 socket-proxy validation is in B's `vexa-isolated-host` runbook).

### Upload / desktop / browser recording
- **Fireflies:** upload audio or video, a Chrome extension recorder and mobile apps.
- **MeetSum on main:** streaming, resumable, idempotent multipart upload; a browser recorder with an IndexedDB offline queue; the Windows desktop companion (mic plus system audio, offline spool); Drive import; Zoom and Teams capture webhooks. The app installs as a PWA, but there is no native mobile app.
- **Evidence:** `tests/multipart-upload.test.ts`, `tests/upload-queue.test.ts`, `tests/recorder-offline.test.ts`, `tests/recorder-dock.test.ts`, `tests/desktop-capture-ingestion.test.ts`, `tests/desktop-capture-route.test.ts`, `tests/desktop-recorder-companion.test.ts`, `tests/recording-import.test.ts`, `tests/zoom-capture.test.ts`, `tests/teams-capture.test.ts`, `tests/media-validation.test.ts`. E2E (package A): `m10-core-flow` step 1 (upload through the drawer). CI artifact pending.
- **Scores:**
  - C 2 (no native mobile app or Chrome extension; the PWA and desktop companion cover the use).
  - Q 2.
  - He 2.
  - V 3 (no outside service needed).
- **Live:** nothing external. The core e2e covers the real UI path.

### Speaker diarization + names
- **Fireflies:** speaker labels, with speaker names from the meeting platform.
- **MeetSum on main:** the ASR router (RunPod ivrit-ai, Modal `asr-worker` with pyannote, Soniox) with diarization; speaker suggestions from Meet participants, voiceprints and glossary; speaker rename and merge. Free options (Groq, local Whisper) give no diarization, and a warning says so.
- **Evidence:** `tests/asr-router.test.ts`, `tests/asr-runpod.test.ts`, `tests/asr-modal-worker.test.ts`, `tests/asr-soniox.test.ts`, `tests/asr-der.test.ts`, `tests/speaker-suggest.test.ts`, `tests/speaker-assignment.test.ts`, `tests/speakers-routes.test.ts`, `tests/asr-no-network.test.ts`. Harness: `npm run asr:evaluate -- --replay tests/fixtures/asr/eval` (synthetic, shown below).
- **Scores:**
  - C 2.
  - Q 1 (no real DER measured yet).
  - He 2.
  - V 2.
- **Live:** deferred. Needs RunPod, Hugging Face (pyannote) or Soniox keys, plus consented clips.

### Player + click-to-seek transcript, editing
- **Fireflies:** playback with a synced transcript, speed control and transcript editing.
- **MeetSum on main:**
  - Waveform peaks, speaker lanes, range streaming (206), playback rate and keyboard shortcuts.
  - A virtualized transcript with click-to-seek, follow mode and word highlighting.
  - Editing with revision history and turn-level undo.
  - The in-transcript finder, which folds niqqud and Hebrew prefixes using the same normalizer as search (M10 R12).
- **Evidence:**
  - Tests: `tests/player-store.test.ts`, `tests/player-follow.test.ts`, `tests/player-keyboard.test.ts`, `tests/player-word-index.test.ts`, `tests/media-range.test.ts`, `tests/media-peaks.test.ts`, `tests/transcript-edit.test.ts`, `tests/turn-undo.test.ts`, `tests/edit-history.test.ts`, `tests/transcript-search.test.ts`, `tests/transcript-search-fold.test.ts`, `tests/segment-tokens.test.ts`.
  - E2E: `m10-core-flow` step 3 (per-segment `dir`, `<bdi>`, seek). CI artifact pending.
- **Scores:**
  - C 3 (an edit history with undo goes beyond Fireflies' documented editing).
  - Q 2.
  - He 3 (per-segment direction, and a niqqud- and prefix-aware finder that highlights pointed text).
  - V 3.
- **Live:** none needed.

### Summaries, templates, chapters/topics
- **Fireflies:** AI summaries (overview, outline, keywords), templates ("Super Summaries"), topics, and AskFred recaps.
- **MeetSum on main:** Hebrew-native prompts. Summaries are cited, every citation is validated, and the output has Hebrew sections. There are 11 templates plus custom ones, chapters, titles and tags. Gemini is the default, Claude is optional, and a heuristic fallback runs when no key is set. UI Hebrew is gender-neutral.
- **Evidence:**
  - Tests: `tests/intelligence-pipeline.test.ts`, `tests/summary-templates.test.ts`, `tests/templates-registry.test.ts`, `tests/chapters.test.ts`, `tests/citations.test.ts`, `tests/summary-provenance.test.ts`, `tests/m5-hebrew-neutral.test.ts`, `tests/llm-schema.test.ts`, `tests/llm-eval-replay.test.ts`.
  - Eval: [llm-eval.md](llm-eval.md). `npm run llm:evaluate` replay on **synthetic** recordings, 2026-10-14: gemini-3.8-flash recall 1.00, precision 1.00, citation validity 1.00; flash-lite recall 0.867, precision 1.00, citation validity 0.962. The decision is "insufficient_data" (no cost data in replay).
  - E2E (package A): `m10-core-flow` step 4 (LLM summary through structured replay; pipeline wiring only). CI artifact pending.
- **Scores:**
  - C 2.
  - Q 1 (no live quality numbers; the replay table only proves the harness).
  - He 2 (Hebrew-native prompts and style lint; quality versus Fireflies is unmeasured).
  - V 2.
- **Live:** deferred. Needs a Gemini key (paid tier for real data; Claude optional).

### Action items mgmt, tasks view
- **Fireflies:** action items in summaries, assignable tasks, and sync to project tools.
- **MeetSum on main:** extraction with owners, he/en relative due dates resolved in the workspace time zone, priorities, a Tasks view (filters, row direction per language), manual edits and merge, and HubSpot tasks.
- **Evidence:** `tests/task-extraction.test.ts`, `tests/due-date-he.test.ts`, `tests/due-date-en.test.ts`, `tests/due-date-strict.test.ts`, `tests/tasks-routes.test.ts`, `tests/tasks-store-pg.test.ts`, `tests/task-item-row-dir.test.ts`, `tests/action-item-merge.test.ts`, `tests/action-items-routes.test.ts`, `tests/integration-due-dates.test.ts`.
- **Scores:**
  - C 2.
  - Q 2.
  - He 3 (Hebrew relative dates such as "עד יום ראשון" and "בעוד שבועיים" resolve correctly in tests; Fireflies documents no Hebrew date handling).
  - V 3.
- **Live:** extraction quality rides on the summary eval (deferred).

### Soundbites/clips, comments
- **Fireflies:** Soundbites, with playlists, sharing, comments and reactions.
- **MeetSum on main:** clips (render and share links), threaded comments with mentions and re-anchoring after transcript edits, and reactions. **No playlists.**
- **Evidence:** `tests/clips-routes.test.ts`, `tests/clips-store.test.ts`, `tests/clip-render.test.ts`, `tests/clip-share.test.ts`, `tests/share-clip-page.test.ts`, `tests/comments-routes.test.ts`, `tests/comments-store.test.ts`, `tests/comment-reanchor.test.ts`, `tests/mentions.test.ts`, `tests/reactions-routes.test.ts`.
- **Scores:**
  - C 1 (no soundbite playlists).
  - Q 2.
  - He 2.
  - V 3.
- **Live:** none needed. Playlists are a follow-up.

### Chat over meetings with citations
- **Fireflies:** AskFred, both during and after meetings, across meetings.
- **MeetSum on main:** streaming AskMeetSum scoped to a meeting, a room or the workspace, with strict citations and a refusal gate, private threads, feedback, a durable daily cap and visibility-scoped retrieval. It does not answer questions during a live meeting.
- **Evidence:**
  - Tests: `tests/ask-service.test.ts`, `tests/ask-citations.test.ts`, `tests/ask-refusal.test.ts`, `tests/ask-sse.test.ts`, `tests/ask-real-retrieval.test.ts`, `tests/ask-usage.test.ts`, `tests/search-ask-isolation.test.ts`, `tests/llm-stream-replay.test.ts`.
  - E2E: `tests/e2e/m6-search-ask.spec.ts` tests 4–8 (replayed streams, chips seek, refusal, threads, visibility). CI artifact pending.
- **Scores:**
  - C 2 (no in-meeting Ask).
  - Q 2.
  - He 2.
  - V 2.
- **Live:** deferred. Needs a Gemini key for live answer quality.

### Global semantic search
- **Fireflies:** Smart Search across meetings, filtering by topics, speakers and keywords.
- **MeetSum on main:** hybrid search (pgvector, full-text and trigram, merged with RRF) with a lexical fallback, plus the Hebrew normalizer, facets and filters, the ⌘K palette and click-to-seek hits.
- **Evidence:**
  - Tests: `tests/search-hebrew-normalize.test.ts`, `tests/search-hebrew-sanity.test.ts`, `tests/search-pglite.test.ts`, `tests/search-retrieve.test.ts`, `tests/search-rrf.test.ts`, `tests/search-routes.test.ts`, `tests/search-palette.test.ts`, `tests/search-eval-harness.test.ts`.
  - Eval: [search-eval.md](search-eval.md), rerun 2026-10-14 on this branch (identical numbers).
  - E2E: `tests/e2e/m6-search-ask.spec.ts` tests 1–3 and the palette test. CI artifact pending.
- **Scores:**
  - C 2.
  - Q 2 (lexical measured; paraphrase recall@5 is 0.40 without vectors).
  - He 3 (Hebrew prefix, niqqud, gershayim and final-letter handling; measured recall@5 0.94 against 0.28 for the legacy search).
  - V 3.
- **Live:** hybrid mode deferred. Needs a Gemini key and the pgvector image (`npm run search:eval -- --live --record`).

### Teams/workspaces/roles/sharing
- **Fireflies:** teams and channels, admin roles, privacy settings, share links, and SSO and SCIM on enterprise plans.
- **MeetSum on main:**
  - Workspaces, four roles, invitations, scoped API keys, and meeting visibility that fails closed.
  - Share links with sections, password and expiry.
  - Per-workspace isolation is tested.
  - **No SAML SSO and no SCIM** (Google sign-in only).
- **Evidence:** `tests/authz.test.ts`, `tests/authz-route-coverage.test.ts`, `tests/authz-unauthenticated.test.ts`, `tests/workspace-store.test.ts`, `tests/meeting-visibility.test.ts`, `tests/visibility-fail-closed.test.ts`, `tests/visibility-defaults-allowlist.test.ts`, `tests/m9-isolation.test.ts`, `tests/share-password.test.ts`, `tests/share-scope-isolation.test.ts`, `tests/api-keys-management.test.ts`.
- **Scores:**
  - C 1 (no SSO or SCIM; no channels or folders).
  - Q 2.
  - He 2.
  - V 3.
- **Live:** none needed. SSO is a follow-up.

### Analytics
- **Fireflies:** Conversation Intelligence (talk time, sentiment, questions, filler words), topic trackers and team analytics.
- **MeetSum on main:** per-meeting talk time, words per minute, questions, filler words and sentiment, plus a workspace dashboard (KPIs, coverage, a table view). **No topic trackers.**
- **Evidence:** `tests/analytics-compute.test.ts`, `tests/analytics-dashboard-compute.test.ts`, `tests/analytics-dashboard-routes.test.ts`, `tests/analytics-dashboard-sql.test.ts`, `tests/analytics-dashboard-view.test.ts`, `tests/filler-words.test.ts`, `tests/questions-detect.test.ts`, `tests/sentiment.test.ts`. E2E: `tests/e2e/m9-polish.spec.ts` test 17.9. CI artifact pending.
- **Scores:**
  - C 1 (no topic trackers).
  - Q 2.
  - He 2 (Hebrew filler words and question detection).
  - V 3.
- **Live:** none needed. Topic trackers are a follow-up.

### Integrations (Slack, CRM, Notion, Zapier, Outlook)
- **Fireflies:** dozens of native integrations (Slack, HubSpot, Salesforce, Notion, Asana, Zapier and more), plus an API and webhooks. The count varies by source (third-party reviews say 60–200).
- **MeetSum on main:**
  - Native: Slack, Outlook calendar, Notion, HubSpot, Google Docs, DOCX, PDF, Markdown and email recap.
  - Generic: webhook catalog v2 (signed), n8n templates, Zapier through Catch Hook, REST API, CLI and MCP.
  - One privacy gate covers every push (RealizeOS included since M10 R11).
  - HubSpot and Graph behaviour was re-verified against the vendor docs on 2026-10-14 (M10 R2).
- **Evidence:**
  - Tests: `tests/slack-provider.test.ts`, `tests/notion-provider.test.ts`, `tests/hubspot-provider.test.ts`, `tests/hubspot-docs-verified.test.ts`, `tests/ms-calendar-sync.test.ts`, `tests/ms-graph-docs-verified.test.ts`, `tests/integration-privacy-gate.test.ts`, `tests/realizeos-privacy.test.ts`, `tests/integration-e2e-fake-providers.test.ts`, `tests/webhook-signature-v2.test.ts`, `tests/token-keyring.test.ts`.
  - E2E: `tests/e2e/m8-integrations.spec.ts` tests 1–13 against fake providers. CI artifact pending.
  - Runbook: [integrations.md](../runbooks/integrations.md), "Verified against vendor docs".
- **Scores:**
  - C 1 (no Salesforce, Asana or other project-tool natives; webhooks, n8n and Zapier cover them generically).
  - Q 2.
  - He 2 (bidi-safe Slack, Notion and HubSpot payloads and RTL email).
  - V 2.
- **Live:** deferred. Needs Slack, Entra, Notion and HubSpot apps.

### Live transcript
- **Fireflies:** real-time transcript with speaker labels, real-time notes and in-meeting AskFred (per Fireflies' launch post).
- **MeetSum on main:** a live transcript panel behind `MEETSUM_LIVE_TRANSCRIPT`: a server-sent-event hub fed by the Vexa stream (M7 B8). **No live notes and no in-meeting Ask.**
- **Evidence:** `tests/bot-live-sse.test.ts`, `lib/bot/live/hub.ts`, `lib/bot/live/stream.ts`, `tests/client-sse-parser.test.ts`.
- **Scores:**
  - C 1.
  - Q 1 (never run on a real meeting).
  - He 2.
  - V 2.
- **Live:** deferred. Needs a Vexa host. The user confirmed "✓ behind the flag" satisfies the stretch row; this audit still scores the capability gap honestly.

### Hebrew ASR, RTL, prompts, search, PDF, dates
- **Fireflies:** Hebrew is one of 100+ languages, using a general multilingual model. Fireflies documents no RTL interface, Hebrew-specific search normalization, Hebrew PDF typesetting or Hebrew date parsing.
- **MeetSum on main:** see [Hebrew superiority evidence](#hebrew-superiority-evidence).
- **Evidence:** `tests/search-hebrew-normalize.test.ts`, `tests/pdf-bidi-layout.test.ts`, `tests/meeting-pdf.test.ts`, `tests/meeting-docx-rtl.test.ts`, `tests/fonts-local.test.ts`, `tests/dictionary-hebrew-lint.test.ts`, `tests/format-he.test.ts`, `tests/due-date-he.test.ts`, `tests/hebrew-text.test.ts`, `tests/a11y-static.test.ts`, `tests/asr-evaluation.test.ts`, `docs/i18n/hebrew-style.md`.
- **Scores:**
  - C 3.
  - Q 2 (ASR WER not yet measured live).
  - He 3.
  - V 2.
- **Live:** the ASR WER table and the live summary eval are deferred (keys and clips).

---

## Hebrew superiority evidence

| Claim | Evidence | Rerun (no keys) | State |
|---|---|---|---|
| Hebrew search recall | Synthetic Hebrew corpus (`tests/fixtures/search/corpus.he.json`, 50 queries). Recall@5: **lexical 0.94, PGlite 0.94, legacy ILIKE 0.28**. Per category: prefixes 1.00 vs 0.13, gershayim 1.00 vs 0.25, niqqud 1.00 vs 0.00, plural and final letters 1.00 vs 0.40. Paraphrase is 0.40 without vectors. [search-eval.md](search-eval.md) | `npm run search:eval` | measured offline (2026-10-14, numbers unchanged) |
| Hebrew normalizer | Niqqud, cantillation, final letters, geresh and gershayim, maqaf, hyphenated prefixes, thousands separators and prefix variants: `tests/search-hebrew-normalize.test.ts`, `tests/search-hebrew-sanity.test.ts`. The transcript finder uses the same rules: `tests/transcript-search-fold.test.ts` | `npx vitest run tests/search-hebrew-normalize.test.ts tests/transcript-search-fold.test.ts` | ✓ |
| Hebrew plurals and dates | Relative due dates: `tests/due-date-he.test.ts`. Plural rules and number and date formatting: `tests/format-he.test.ts`, `tests/i18n-keys.test.ts` | `npx vitest run tests/due-date-he.test.ts tests/format-he.test.ts` | ✓ |
| Hebrew PDF | Embedded Plex Sans Hebrew and a bidi layout in logical order: `tests/pdf-bidi-layout.test.ts`, `tests/meeting-pdf.test.ts`, `tests/fonts-local.test.ts`. The sample PDF plus `pdftotext` check comes from `tests/e2e/m9-polish.spec.ts` "17.5 Hebrew PDF" in the CI `m9` job (artifact pending) | `npx vitest run tests/pdf-bidi-layout.test.ts tests/meeting-pdf.test.ts` | unit ✓; CI sample pending |
| RTL UI | Static a11y and direction checks: `tests/a11y-static.test.ts`, `tests/i18n-hardcoded-strings.test.ts`, `tests/ui-strings-localized.test.ts`. The screenshot matrix (he/en × light/dark, desktop and mobile; 0 serious or critical axe findings) comes from `tests/e2e/m9-screenshots.spec.ts` in CI (artifact pending) | `npx vitest run tests/a11y-static.test.ts` | unit ✓; CI screenshots pending |
| Gender-neutral UI Hebrew | `docs/i18n/hebrew-style.md`, linted by `tests/dictionary-hebrew-lint.test.ts` and `tests/m5-hebrew-neutral.test.ts` | `npx vitest run tests/dictionary-hebrew-lint.test.ts` | ✓ |
| ASR WER/DER | The harness is proven offline on **synthetic** recorded results (`tests/fixtures/asr/eval`). Replay on 2026-10-14: runpod-ivrit WER 0.071 / 0.111 / 0.000; soniox 0.071 / 0.444, plus one recorded timeout (fixture behaviour). These say nothing about real accuracy | `npm run asr:evaluate -- --replay tests/fixtures/asr/eval` | **harness ✓; live table NOT run (deferred until keys and clips)** |
| Hebrew summaries | Replay table above (synthetic) | `npm run llm:evaluate` | **live pairwise eval NOT run (deferred until a Gemini key)** |

External reference for Hebrew ASR: the ivrit.ai Hebrew ASR leaderboard (Hugging Face, `ivrit-ai`) ranks the ivrit-ai fine-tuned Whisper models that MeetSum routes to first. Read their published WER as the vendor's claim, not as our measurement.

### Deferred live evaluation commands

Each one writes the committed report file. Run from the repo root, with the env in `.env.local` or exported.

```bash
# 1. ASR WER/DER, Groq free tier (generic whisper-large-v3-turbo through the local-whisper-chunked slot)
LOCAL_TRANSCRIPTION_URL=https://api.groq.com/openai LOCAL_TRANSCRIPTION_MODEL=whisper-large-v3-turbo \
LOCAL_TRANSCRIPTION_API_KEY=… LOCAL_TRANSCRIPTION_SEND_HOTWORDS=false \
npm run asr:evaluate -- --manifest .secrets/asr-eval/manifest.json --providers local-whisper-chunked --output-md docs/parity/asr-eval.md

# 2. ASR WER/DER, RunPod ivrit-ai and Soniox (diarization, so DER too)
RUNPOD_API_KEY=… RUNPOD_ASR_ENDPOINT_ID=… SONIOX_API_KEY=… \
npm run asr:evaluate -- --manifest .secrets/asr-eval/manifest.json --providers runpod-ivrit,soniox --output-md docs/parity/asr-eval.md

# 3. Hebrew summaries: live pairwise eval (Gemini; Claude candidates are added when ANTHROPIC_API_KEY is set)
GOOGLE_GEMINI_API_KEY=… GEMINI_TIER=paid npm run llm:evaluate -- --live --batch --output-md docs/parity/llm-eval.md

# 4. Hybrid search: embed the synthetic corpus and record the vector fixture
GOOGLE_GEMINI_API_KEY=… MEETSUM_EMBEDDING_PROVIDER=gemini npm run search:eval -- --live --record
```

The manifest format is `docs/parity/asr-eval-manifest.example.json`. Keep the clips and reference transcripts outside git (`.secrets/asr-eval/`).

---

## Needs your keys or accounts

| Item | What it verifies | Env vars | Command | Estimated cost |
|---|---|---|---|---|
| Groq API key (free tier) | First live Hebrew WER table; ASR on real uploads | `LOCAL_TRANSCRIPTION_URL`, `LOCAL_TRANSCRIPTION_MODEL`, `LOCAL_TRANSCRIPTION_API_KEY` | live eval command 1 | $0 within free limits |
| 5–10 consented Hebrew/code-switched clips (1–5 min) with reference transcripts | WER/DER on our own domain (open since M3) | `MEETSUM_ASR_EVAL_MANIFEST` or `--manifest` | commands 1–2 | your time |
| RunPod key + endpoint; Hugging Face token (pyannote); Soniox key | Primary ASR and diarization live; DER table | `RUNPOD_API_KEY`, `RUNPOD_ASR_ENDPOINT_ID`, `HF_TOKEN` (worker), `SONIOX_API_KEY` | command 2 | about $0.35 (RunPod, 30 audio-min at $0.00019/s) + $0.05 (Soniox at $0.10/h) |
| Gemini API key (paid tier for real meetings) | Live summary eval, live Ask quality, hybrid search | `GOOGLE_GEMINI_API_KEY`, `GEMINI_TIER` | commands 3–4; Ask: run `tests/e2e/m6-search-ask.spec.ts` without `MEETSUM_LLM_REPLAY_DIR` | free tier $0 (eval only); paid, under $1 for the eval set |
| Anthropic key (optional) | Claude A/B in the summary eval and in Ask | `ANTHROPIC_API_KEY` | command 3 | a few dollars |
| Fireflies account (optional) | Head-to-head WER and summary comparison on the same consented clips | — | Upload the clips to Fireflies manually and paste its transcripts as a provider result into `asr-eval.md` | your Fireflies plan |
| Vexa host/VM + Google Workspace bot account | Live bot, socket-proxy validation (R3), live transcript | `VEXA_API_URL`, `VEXA_API_KEY`, `VEXA_WEBHOOK_SECRET`, `MEETSUM_BOT_ENABLED`, `MEETSUM_BOT_ACCOUNT_EMAIL`, `MEETSUM_LIVE_TRANSCRIPT` | `npm run bot:simulate` against the live host (B's `vexa-isolated-host` runbook), then a real "Join now" | VM cost |
| Slack / Entra / Notion / HubSpot apps | Live integration runs, including the R2 live checks (HubSpot revoke status, `hs_timestamp` marker search, batch trace-id echo, AADSTS50020/700016) | M8 env block | [integrations.md → First live run](../runbooks/integrations.md#first-live-run) | $0 (developer tiers) |
| SMTP credentials or Gmail-send approval | Real invitation and recap emails | `SMTP_*`, `MEETSUM_EMAIL_FROM` | send an invitation; enable an email recap rule | provider-dependent |
| Sentry DSN or GlitchTip (optional) | Scrubbed error reports in a real environment | `SENTRY_DSN` | trigger a server error (B's observability runbook) | free tier |
| Repo settings | Mark `quality`, `schema` and the e2e jobs as required; create the `production` environment | GitHub settings | — | $0 |

---

## Remaining risks (R1–R16) after M10

| # | Decision | State on this branch |
|---|---|---|
| R1 | Redis rate limiter | package B |
| R2 | HubSpot/Graph/Entra docs verification | **done (D):** 3 mismatches fixed (HubSpot token endpoint, task priority, Graph `@removed`), 2 gaps hardened (`innererror`, batch mapping), ambiguous items on the live-run checklist ([integrations.md](../runbooks/integrations.md)) |
| R3 | Socket proxy `IMAGES=0`/`NETWORKS=0` | B runbook; live deferred |
| R4 | Calendar dedupe limitation | **documented (D):** user manual, he/en, "Known limitations" |
| R5 | Slack duplicate window | **documented (D):** user manual, he/en |
| R6 | Visibility leftovers | **guarded (D):** `tests/visibility-defaults-allowlist.test.ts` (5 allowlisted creation and display defaults, each with a reason) |
| R7 | Live evals need keys | **harness ready (D):** offline self-tests run in `npm test` (`tests/asr-eval-report.test.ts`, `tests/llm-eval-replay.test.ts`, `tests/search-eval-harness.test.ts`); live commands above |
| R8 | Playwright in CI | package A |
| R9 | `integration_endpoints` | migration 032 (Step 0) |
| R10 | Token-key rotation | **done (D):** keyring plus `scripts/reencrypt-tokens.ts` (`tests/token-keyring.test.ts`); runbook steps |
| R11 | RealizeOS private-meeting policy | **done (D):** privacy gate at send time (`tests/realizeos-privacy.test.ts`) |
| R12 | Finder vs normalizer | **done (D):** `tests/transcript-search-fold.test.ts` |
| R13–R14 | Bundle, design system | package C |
| R15–R16 | Vexa staleness note, MinIO pin | package B; **MinIO (integration):** built from the official minio/minio and minio/mc source at the last release tags (`deploy/minio/Dockerfile`, tags + commits + base digests pinned, `tests/image-pins.test.ts`); not built locally (no Docker daemon) |

## Follow-ups

| Item | Severity | Owner suggestion | Source |
|---|---|---|---|
| Commit the first generated `db/schema.sql` (no local pg_dump 17 or Docker engine was available to D; the CI `schema` job prints the full fresh dump on drift) | high (CI `schema` job fails until done) | orchestrator | D1 |
| HubSpot: move v4 associations (unsupported 2027-03-30) and `/crm/v3/objects` (September 2027) to the 2026-09 date paths | medium (dated) | integrations | R2 |
| Entra: distinct authorize-redirect error codes (`unauthorized_client`/`consent_required` → admin consent needed) instead of the generic "denied" | low | integrations | R2 |
| Graph `@removed` now costs one `GET /me/events/{id}` per removal; batch it if delta pages carry many removals | low | integrations | R2 |
| Soundbite playlists | medium (parity) | product | AUDIT row |
| Topic trackers in analytics | medium (parity) | product | AUDIT row |
| SAML SSO / SCIM | medium (enterprise parity) | product | AUDIT row |
| Live notes and in-meeting Ask | medium (parity, stretch) | product | AUDIT row |
| Webex bot support | low | bot | AUDIT row |
| Native mobile app or browser extension | low (PWA covers it) | product | AUDIT row |
| Plain-Postgres dump diff (assert that the no-pgvector dump differs only by vector objects) | low | D or orchestrator | m10.md Schema |
| ~~`/api/admin/webhooks/stats` counts `pending`~~ **done (integration):** `pending` = `queued`/`active`/`retrying` (`tests/m10-webhook-admin-routes.test.ts`); `GET /api/webhooks/deliveries` gained the `admin` rate limit | — | orchestrator | API reference audit |
| ~~Guards weaker in the wrapper than in the handler~~ **done (integration):** the generated route index marks DELETE meeting, visibility, share (POST/PATCH) and clip share with "+ `canManageMeeting` in the handler", checked against the handlers by `tests/api-reference-complete.test.ts` | — | orchestrator | API reference audit |
| OpenTelemetry export; client-side error capture | low | ops | m10.md non-goals |
| Build `meetsum-minio` once on a Docker host (`docker compose build minio`) and switch production from `coollabsio/minio` ([deploy.md → Images](../runbooks/deploy.md#images)); watch upstream MinIO source releases manually (Dependabot cannot) | medium (before the next MinIO restart) | ops | R16 |
| MinIO replacement (Garage or SeaweedFS; e2e already runs SeaweedFS): a future option, a data migration plus `S3_ENDPOINT` change | low | ops | R16 |
| Calendar dedupe edge cases (R4) and the Slack duplicate window (R5) | low (documented) | integrations | R4, R5 |

# Language Intelligence

Last updated: May 18, 2026.

MeetSum treats Hebrew and mixed-language meetings as first-class inputs. The product combines deterministic cleanup, local ASR where useful, Gemini fallback, structured summary generation, and quality warnings that tell the user when output needs review.

## Detection

- Hebrew is detected by Unicode script.
- English, Portuguese, Spanish, and Italian are detected with lightweight stopword heuristics.
- Meetings are marked mixed-language when more than one content language is materially present.
- Meeting content language is separate from UI locale.

Stored metadata includes primary language, secondary languages, per-segment language, confidence, and mixed-language flag.

## Hebrew-First Cleanup

Cleanup removes repeated transcript lines and obvious audio/connectivity filler while preserving:

- names
- numbers
- dates
- currencies
- percentages
- technical terms such as `VSCode`, `Claude Code`, `Supabase`, `MCP`, `RealizeOS`, `Gemini`, and `Gemma`

Raw Fireflies, Timeless, and private transcript samples are reference material only. They must not be committed to the repository.

## Structured Output

The intelligence output should produce:

- gist and overview
- decisions with evidence
- action items with owner, due date, priority, confidence, and source quote when available
- risks and blockers
- open questions
- commitments
- follow-up draft
- timestamped quotes
- tags and topics
- language metadata
- quality warnings

Action items should be real commitments, assignments, next steps, or explicit follow-ups. Transcript fragments should not become tasks.

## Local Hebrew ASR

Local Hebrew ASR is now an active v0.1.0 capability, not only a future idea.

Recommended production default:

```env
MEETSUM_TRANSCRIPTION_PROVIDER=auto
LOCAL_TRANSCRIPTION_URL=http://faster-whisper:8000
LOCAL_TRANSCRIPTION_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2
LOCAL_TRANSCRIPTION_LANGUAGE=he
LOCAL_TRANSCRIPTION_TIMEOUT_MS=900000
```

In `auto` mode:

- Hebrew and mixed-language meetings try local Whisper first.
- Clearly non-Hebrew meetings use Gemini directly.
- Gemini remains the fallback if local Whisper fails.
- The actual provider, attempted provider, model, latency, confidence, and fallback metadata are recorded in `ai_runs`.

Use `MEETSUM_TRANSCRIPTION_PROVIDER=local-whisper` only for deliberate local-only tests. Do not remove Gemini while local ASR is still being evaluated.

## Current Real-Smoke Finding

The latest production smoke with a selected Google Meet recording verified that the provider selection path works, but local ASR is not trusted yet:

- The meeting was Hebrew/mixed.
- MeetSum attempted `local-whisper`.
- The job fell back to Gemini.
- Processing still completed successfully.
- Provider metadata and quality warnings made the fallback visible.

The next engineering priority is to debug the local Whisper fallback on the real long recording and decide whether the issue is timeout, service restart, memory pressure, response-shape mismatch, or client/worker handling.

## Private Evaluation Loop

Evaluation samples must live outside Git:

```text
.secrets/asr-eval/
```

Run:

```bash
npm run asr:evaluate -- --manifest .secrets/asr-eval/manifest.json
```

The manifest should reference private audio files and reference transcripts. Do not commit audio, transcripts, generated outputs, or benchmark reports.

Compare:

- local Whisper transcript
- Gemini transcript
- Google smart notes/transcript artifacts when available

Score both strict and practical quality:

- Hebrew word accuracy
- names preserved
- English technical terms preserved
- dates, money, numbers, and percentages preserved
- decisions and tasks usable
- uncertainty marked instead of invented

## Quality Warnings

MeetSum should show these warning types when applicable:

- `transcription_fallback`: local ASR or another primary provider failed and Gemini was used.
- `weak_transcript_confidence`: transcript confidence is low enough to require review.
- `no_speaker_diarization`: speakers are generic or not mapped to participants.
- `smart_notes_only`: summary was generated from smart notes without a full transcript.
- `task_missing_owner_or_due_date`: action items need human enrichment.

Warnings are guidance, not failure states. They should appear in the meeting right rail, public-safe exports when relevant, and RealizeOS payloads.

## Later AI Work

After local ASR is stable:

- Add diarization evaluation.
- Evaluate ivrit-ai/pyannote-style speaker diarization.
- Add summary templates by meeting type.
- Add stricter Hebrew task extraction regression tests.
- Consider Vertex AI only after service-account auth passes a production container smoke test.

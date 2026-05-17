# Language Intelligence

MeetSum includes a deterministic first-pass intelligence layer before API or local LLM providers run. This keeps tests stable and gives the AI pipeline structured inputs.

## Detection

- Hebrew is detected by Unicode script.
- English, Portuguese, Spanish, and Italian are detected with lightweight stopword heuristics.
- Meetings are marked mixed-language when more than one content language is materially present.

Stored metadata:

- primary language
- secondary languages
- per-segment language
- confidence
- mixed-language flag

## Hebrew-First Cleanup

Cleanup removes repeated transcript lines and obvious audio/connectivity filler while preserving:

- names
- numbers
- dates
- currencies
- percentages
- technical terms such as `VSCode`, `Claude Code`, `Supabase`, `MCP`, `RealizeOS`, `Gemini`, and `Gemma`

Raw Fireflies transcripts are private reference material. They must not be committed to the repository.

## Structured Output

The intelligence output shape includes:

- overview
- decisions
- action items
- risks/blockers
- open questions
- commitments
- follow-up draft
- timestamped quotes
- auto-tags
- language metadata

This deterministic layer is intentionally simple. Gemini, local Gemma, transcription, diarization, and Hebrew quality escalation should plug in as provider adapters in the next AI stage.

## Local Hebrew ASR

MeetSum can use a local OpenAI-compatible faster-whisper server for Hebrew
transcription. This path is optional while we benchmark it against Gemini on
private samples.

Recommended first local model:

```text
ivrit-ai/whisper-large-v3-turbo-ct2
```

Set:

```env
MEETSUM_TRANSCRIPTION_PROVIDER=local-whisper
LOCAL_TRANSCRIPTION_URL=http://faster-whisper:8000
LOCAL_TRANSCRIPTION_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2
LOCAL_TRANSCRIPTION_LANGUAGE=he
```

Use `MEETSUM_TRANSCRIPTION_PROVIDER=auto` to try local Whisper first for Hebrew
and mixed-language meetings, while sending clearly non-Hebrew meetings directly
to Gemini. If the local server is unavailable or errors, MeetSum falls back to
Gemini and records which provider actually ran.

Private evaluation samples should live under `.secrets/asr-eval`, which is
gitignored. Use `npm run asr:evaluate -- --manifest .secrets/asr-eval/manifest.json`
to compare configured providers. Do not commit audio, reference transcripts, or
evaluation output.

Diarization is a later phase. The intended first candidate is ivrit-ai's
pyannote speaker diarization model, but it should be integrated only after the
local ASR path is stable and measurable.

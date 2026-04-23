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

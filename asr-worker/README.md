# MeetSum ASR worker (RunPod serverless)

GPU worker for diarized Hebrew transcription, used by the `runpod-ivrit`
provider (`lib/ai/asr/providers/runpod-ivrit.ts`) when
`RUNPOD_ASR_WORKER=meetsum`.

Pipeline (`pipeline.py`): fetch audio (presigned URL or base64 blob, capped by
`MAX_AUDIO_BYTES`) → ffmpeg 16 kHz mono WAV → **faster-whisper**
(`ivrit-ai/whisper-large-v3-turbo-ct2`, word timestamps, VAD,
`condition_on_previous_text=False`, confidence thresholds, glossary `hotwords`
/ optional `initial_prompt`) → **pyannote** `speaker-diarization-community-1`
on CUDA (exclusive diarization + per-speaker embeddings) → `merge.py` assigns
each word to a speaker (max overlap → nearest turn within 500 ms → previous
speaker) → `meetsum-asr/v1` JSON (`schema.py`).

If diarization fails the transcript is still returned (`diarization: "none"`
plus a `diarization_failed` warning). Decode/download failures return
`{"error": ...}` (RunPod marks the job FAILED; MeetSum treats decode errors
as permanent `bad_input`, everything else as retryable).

The default `RUNPOD_ASR_WORKER=ivrit` instead targets the public ivrit-ai
RunPod image (see "Alternative" below); this worker exists for full control
over diarization, embeddings (voiceprints) and the output schema.

## Files

| File | Purpose |
| --- | --- |
| `handler.py` | RunPod entry point; validates input, runs the pipeline |
| `pipeline.py` | download, ffmpeg, faster-whisper, pyannote (lazy GPU imports) |
| `merge.py` | pure word→speaker assignment |
| `schema.py` | `meetsum-asr/v1` input parsing and output building |
| `tests/test_merge.py` | pytest, no GPU needed |
| `test_input.json` | sample job for `runpod` local testing |

## Tests (no GPU)

```bash
python -m pytest asr-worker/tests
```

Only the standard library and pytest are needed: GPU dependencies are
imported lazily inside `pipeline.py`.

## Build and push

```bash
cd asr-worker
docker build --platform linux/amd64 -t <registry>/meetsum-asr-worker:2026.10 .
docker push <registry>/meetsum-asr-worker:2026.10
```

The image bakes the Whisper model (~1.6 GB) to keep cold starts short. Use an
immutable tag per release and update the RunPod template to it.

Local smoke test on a CUDA machine (RunPod SDK local mode):

```bash
docker run --gpus all --rm -e HF_TOKEN=... -v "$PWD/test_input.json:/app/test_input.json" \
  <registry>/meetsum-asr-worker:2026.10 python -u handler.py --test_input "$(cat test_input.json)"
```

Replace the placeholder URL in `test_input.json` with a presigned URL to a
short clip first.

## Hugging Face token

`pyannote/speaker-diarization-community-1` is gated:

1. Accept the model conditions on Hugging Face with the account that owns the
   token.
2. Create a **read-only, fine-grained** token limited to that repository.
3. Store it as a RunPod **secret** (`HF_TOKEN` → `{{ RUNPOD_SECRET_hf_token }}`
   in the endpoint env). Never bake it into the image, never commit it, never
   pass it in job input.

The token is only used to download the model on first use; with a network
volume mounted at `/models` (`HF_HOME=/models/hf`) later cold starts reuse the
cached weights.

## RunPod endpoint settings

| Setting | Value |
| --- | --- |
| GPU | 24 GB class (L4 / A5000 / RTX 4090); 16 GB works for short meetings only |
| Min workers | 0 |
| Max workers | 2 |
| Idle timeout | 5 s |
| FlashBoot | on |
| Execution timeout | 3600 s |
| Container disk | 20 GB |
| Network volume (optional) | mounted at `/models` for the pyannote cache |
| Env | `HF_TOKEN` (secret), optional `MAX_AUDIO_BYTES`, `ASR_COMPUTE_TYPE=float16` |

MeetSum side (`.env`):

```
RUNPOD_API_KEY=...                 # RunPod API key with endpoint access only
RUNPOD_ASR_ENDPOINT_ID=<endpoint id>
RUNPOD_ASR_WORKER=meetsum
S3_PUBLIC_ENDPOINT=https://media.example.com   # presigned handoff (else ≤ 9 MB base64 blobs)
```

`RUNPOD_ASR_TIMEOUT_MS` defaults to max(10 min, 0.5 × duration + 5 min);
MeetSum cancels the job on timeout or abort.

## Alternative: ivrit-ai RunPod image (default)

`RUNPOD_ASR_WORKER=ivrit` (default) speaks the ivrit-ai serverless worker
format (`{type: "url"|"blob", model, engine: "stable-whisper",
transcribe_args: {language, diarize, word_timestamps, hotwords}}`). Deploy the
ivrit-ai image from their RunPod template, point `RUNPOD_ASR_ENDPOINT_ID` at
it, and MeetSum normalizes its generator output. It provides diarized words
but no speaker embeddings (voiceprint suggestions stay unavailable).

## Cost (estimates, verify against your RunPod invoice)

MeetSum records `executionTime × RUNPOD_PRICE_PER_SECOND` (default
`0.00019` $/s ≈ $0.68/h of GPU) on every ASR `ai_run`.

| Audio | GPU time (turbo + diarization, RTF ≈ 0.05–0.1) | RunPod cost | Soniox (`0.10` $/h) |
| --- | --- | --- | --- |
| 15 min | 45–90 s | $0.009–0.017 | $0.025 |
| 1 h | 3–6 min | $0.034–0.068 | $0.10 |
| 3 h | 9–18 min | $0.10–0.21 | $0.30 |

Cold starts add queue time (`delayTime`, not billed as execution) but FlashBoot
plus the baked model keeps them to seconds.

## Re-recording fixtures

The MeetSum unit tests use hand-written, synthetic fixtures
(`tests/fixtures/asr/providers/*.json`, all marked `"_synthetic": true`). Once
an endpoint is live:

1. Transcribe a short **consented, non-sensitive** clip with each worker mode.
2. Save the final `/status/{id}` JSON; replace names, emails and any
   identifying words in the transcript with neutral text; drop the presigned
   URL.
3. Replace the fixture, remove `"_synthetic": true`, add `"_recorded": "<date>"`,
   and update test expectations where the real shape differs.
